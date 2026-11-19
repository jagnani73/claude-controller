import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { BUILTIN_COMMANDS, type CommandEntry } from "common/commands";
import { discoverPluginCommands } from "./plugin-command-catalog.js";

const MAX_ENTRIES = 150;
const MAX_BYTES = 16384;
const SCAN_BUDGET_MS = 2000;
function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Simple scalar frontmatter only: a blank field never consumes the next line. */
function field(front: string, key: string): string {
  const raw = new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)$`, "m").exec(front)?.[1]?.trim() ?? "";
  if (/^[|>]/.test(raw)) return ""; // Multiline YAML isn't a scalar in this bounded reader.
  const quoted = /^(['"])(.*?)\1(?:[ \t]+#.*)?$/.exec(raw);
  return (quoted ? quoted[2] : raw.replace(/[ \t]+#.*$/, "")).trim().slice(0, 200);
}

/** Read only bounded metadata within the trusted scope; never return skill bodies. */
export async function commandCatalog(cwd: string) {
  const entries = [...BUILTIN_COMMANDS];
  const warnings = new Set([
    "Docs suggestions are not installed-availability checks. Discovered files may not be loaded.",
  ]);
  let truncated = false;
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  for (const [scope, base] of [
    ["user", config],
    ["project", join(cwd, ".claude")],
  ] as const) {
    let root: string;
    try {
      root = await realpath(base);
      if (scope === "project" && !inside(await realpath(cwd), root)) {
        warnings.add("Project configuration resolves outside this workspace; discovery skipped.");
        continue;
      }
    } catch (error) {
      if (!absent(error))
        warnings.add(`Could not read ${scope} configuration; check its permissions.`);
      continue;
    }
    for (const kind of ["skills", "commands"] as const) {
      const dir = join(root, kind);
      try {
        const realDir = await realpath(dir);
        if (!inside(root, realDir)) {
          warnings.add(`Some ${scope} ${kind} resolve outside their scope and were skipped.`);
          continue;
        }
        let examined = 0;
        // Stream discovery rather than materializing an unbounded directory.
        for await (const child of await opendir(realDir)) {
          if (++examined > MAX_ENTRIES || entries.length >= MAX_ENTRIES || Date.now() > deadline) {
            truncated = true;
            break;
          }
          if (kind === "commands" && !child.name.endsWith(".md")) continue;
          const path =
            kind === "skills" ? join(realDir, child.name, "SKILL.md") : join(realDir, child.name);
          try {
            const resolved = await realpath(path);
            if (!inside(realDir, resolved)) {
              warnings.add(`Some ${scope} ${kind} resolve outside their scope and were skipped.`);
              continue;
            }
            const info = await stat(resolved);
            if (!info.isFile() || info.nlink > 1 || info.size > MAX_BYTES) {
              warnings.add(
                `Some ${scope} ${kind} are oversized or unsupported files and were skipped.`,
              );
              truncated = true;
              continue;
            }
            const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let body: string;
            try {
              const opened = await handle.stat();
              if (
                !opened.isFile() ||
                opened.nlink > 1 ||
                opened.size > MAX_BYTES ||
                opened.dev !== info.dev ||
                opened.ino !== info.ino ||
                (await realpath(path)) !== resolved ||
                (await realpath(dir)) !== realDir
              ) {
                warnings.add(`Some ${scope} ${kind} changed during discovery; retry to refresh.`);
                continue;
              }
              const buffer = Buffer.alloc(MAX_BYTES + 1);
              const result = await handle.read(buffer, 0, buffer.length, 0);
              if (result.bytesRead > MAX_BYTES) {
                truncated = true;
                continue;
              }
              body = buffer.subarray(0, result.bytesRead).toString("utf8");
            } finally {
              await handle.close();
            }
            const front =
              /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body)?.[1] ?? "";
            if (field(front, "user-invocable").toLowerCase() === "false") continue;
            const name =
              field(front, "name") ||
              (kind === "skills" ? child.name : basename(child.name, ".md"));
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(name)) continue;
            entries.push({
              id: `${scope}:${kind}:${child.name}`,
              name,
              description:
                field(front, "description") || "Discovered metadata (loading unverified)",
              argumentHint: field(front, "argument-hint") || undefined,
              support: "unverified",
              source: kind === "skills" ? "skill" : "legacy-command",
              scope,
            } satisfies CommandEntry);
          } catch (error) {
            if (!absent(error))
              warnings.add(`Could not read some ${scope} ${kind}; check permissions or retry.`);
          }
        }
      } catch (error) {
        if (!absent(error))
          warnings.add(`Could not list ${scope} ${kind}; check permissions or retry.`);
      }
    }
  }
  truncated = (await discoverPluginCommands(cwd, config, entries, warnings, deadline)) || truncated;
  return { entries, warnings: [...warnings], truncated };
}
