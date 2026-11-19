import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandEntry } from "common/commands";

const MAX_BYTES = 16384;
const MAX_SCAN = 150;
const valid = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const absent = (e: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// Open only canonical, bounded, single-link files, and recheck their identity and path.
async function readSafe(root: string, path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!inside(root, canonical)) throw new Error("outside root");
  const before = await stat(canonical);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES)
    throw new Error("unsafe file");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size > MAX_BYTES ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (await realpath(path)) !== canonical ||
      !inside(await realpath(root), canonical)
    )
      throw new Error("changed file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("oversized file");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
function field(front: string, key: string): string {
  const raw = new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)$`, "m").exec(front)?.[1]?.trim() ?? "";
  if (/^[|>]/.test(raw)) return "";
  const quoted = /^(['"])(.*?)\1(?:[ \t]+#.*)?$/.exec(raw);
  return (quoted ? quoted[2] : raw.replace(/[ \t]+#.*$/, "")).trim().slice(0, 200);
}

/** Registry and preferences are untrusted inventory hints, not the running CLI state. */
export async function discoverPluginCommands(
  cwd: string,
  config: string,
  entries: CommandEntry[],
  warnings: Set<string>,
  deadline: number,
): Promise<boolean> {
  let truncated = false;
  let examined = 0;
  const budget = () => {
    if (++examined > MAX_SCAN || entries.length >= MAX_SCAN || Date.now() > deadline) {
      truncated = true;
      return false;
    }
    return true;
  };
  let configRoot: string;
  let projectRoot: string;
  try {
    configRoot = await realpath(config);
  } catch (e) {
    if (!absent(e)) warnings.add("Plugin configuration is unreadable; discovery incomplete.");
    return false;
  }
  try {
    projectRoot = await realpath(cwd);
  } catch {
    warnings.add("Session cwd is unreadable; plugin discovery skipped.");
    return false;
  }
  const preferences: (Record<string, unknown> | null)[] = [];
  for (const [root, path] of [
    [configRoot, join(configRoot, "settings.json")],
    [projectRoot, join(projectRoot, ".claude", "settings.json")],
    [projectRoot, join(projectRoot, ".claude", "settings.local.json")],
  ] as const) {
    try {
      const data: unknown = JSON.parse(await readSafe(root, path));
      if (!object(data) || (data.enabledPlugins !== undefined && !object(data.enabledPlugins)))
        throw new Error("invalid settings");
      preferences.push(object(data.enabledPlugins) ? data.enabledPlugins : {});
    } catch (e) {
      if (absent(e)) preferences.push({});
      else {
        preferences.push(null);
        warnings.add(
          "Some plugin preferences are unreadable or unsafe; configured state may be unknown.",
        );
      }
    }
  }
  let cache: string;
  let registry: unknown;
  try {
    const plugins = await realpath(join(configRoot, "plugins"));
    if (!inside(configRoot, plugins)) throw new Error("outside root");
    cache = await realpath(join(plugins, "cache"));
    if (!inside(plugins, cache)) throw new Error("outside root");
    registry = JSON.parse(await readSafe(plugins, join(plugins, "installed_plugins.json")));
    if (!object(registry) || registry.version !== 2 || !object(registry.plugins))
      throw new Error("unsupported registry");
  } catch (e) {
    warnings.add(
      absent(e)
        ? "Plugin registry or cache is missing; installed discovery may be incomplete."
        : "Plugin registry or cache is unreadable, unsafe, or unsupported; discovery incomplete.",
    );
    return false;
  }
  warnings.add(
    "Plugin entries are installed inventory, not live availability; managed settings and runtime loading are unknown.",
  );
  for (const [id, installations] of Object.entries(registry.plugins as Record<string, unknown>)) {
    if (!budget()) break;
    const parts = id.split("@");
    if (parts.length !== 2 || !parts.every(valid) || !Array.isArray(installations)) {
      warnings.add("Some plugin registry entries are invalid and were skipped.");
      continue;
    }
    let state: "enabled" | "disabled" | "unknown" = "unknown";
    for (const prefs of preferences) {
      if (prefs === null) state = "unknown";
      else if (Object.hasOwn(prefs, id))
        state = prefs[id] === true ? "enabled" : prefs[id] === false ? "disabled" : "unknown";
    }
    if (state === "disabled") continue;
    for (const installation of installations) {
      if (!budget()) break;
      if (
        !object(installation) ||
        !["user", "project", "local"].includes(String(installation.scope)) ||
        typeof installation.installPath !== "string"
      ) {
        warnings.add("Some plugin installations have unsupported registry metadata.");
        continue;
      }
      if (installation.scope !== "user") {
        if (typeof installation.projectPath !== "string" || !isAbsolute(installation.projectPath)) {
          warnings.add("Some plugin installations lack a valid project scope.");
          continue;
        }
        try {
          if ((await realpath(installation.projectPath)) !== projectRoot) continue;
        } catch (e) {
          if (!absent(e))
            warnings.add("Some plugin project scopes are unreadable; discovery incomplete.");
          continue;
        }
      }
      const expected = join(cache, parts[1], parts[0]);
      const path = resolve(installation.installPath);
      if (!isAbsolute(installation.installPath) || (path !== expected && !inside(expected, path))) {
        warnings.add(
          "A plugin installation is outside its cache location; external/development paths were skipped.",
        );
        continue;
      }
      let root: string;
      try {
        root = await realpath(path);
        if (!inside(cache, root) || (root !== expected && !inside(expected, root)))
          throw new Error("outside cache");
      } catch (e) {
        warnings.add(
          absent(e)
            ? "Some installed plugin cache paths are missing."
            : "A plugin cache path is unsafe and was skipped.",
        );
        continue;
      }
      let manifest: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(
          await readSafe(root, join(root, ".claude-plugin", "plugin.json")),
        );
        if (!object(parsed) || (parsed.name !== undefined && parsed.name !== parts[0]))
          throw new Error("invalid manifest");
        manifest = parsed;
      } catch (e) {
        if (!absent(e)) {
          warnings.add("Some plugin manifests are unsafe or inconsistent and were skipped.");
          continue;
        }
      }
      if (manifest.commands !== undefined || manifest.skills !== undefined)
        warnings.add("Custom plugin component paths and inline commands are not catalogued.");
      for (const kind of ["skills", "commands"] as const) {
        if (kind === "commands" && manifest.commands !== undefined) continue;
        const dir = join(root, kind);
        try {
          const realDir = await realpath(dir);
          if (!inside(root, realDir)) throw new Error("outside root");
          for await (const child of await opendir(realDir)) {
            if (!budget()) break;
            if (kind === "commands" && !child.name.endsWith(".md")) continue;
            const fallback = kind === "skills" ? child.name : child.name.slice(0, -3);
            if (!valid(fallback)) continue;
            const file =
              kind === "skills" ? join(realDir, child.name, "SKILL.md") : join(realDir, child.name);
            try {
              const text = await readSafe(realDir, file);
              if ((await realpath(dir)) !== realDir || (await realpath(path)) !== root)
                throw new Error("changed directory");
              const front =
                /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? "";
              if (field(front, "user-invocable").toLowerCase() === "false") continue;
              const name = field(front, "name") || fallback;
              if (!valid(name)) continue;
              entries.push({
                id: `plugin:${id}:${installation.scope}:${examined}:${kind}:${child.name}`,
                name: `${parts[0]}:${name}`,
                description:
                  `${id} · ${installation.scope} · ${state === "enabled" ? "installed, configured enabled" : "installed, configured state unknown"} (not live). ${field(front, "description")}`.slice(
                    0,
                    250,
                  ),
                argumentHint: field(front, "argument-hint") || undefined,
                support: "unverified",
                source: kind === "skills" ? "plugin-skill" : "plugin-command",
                scope: installation.scope === "user" ? "user" : "project",
              });
            } catch (e) {
              if (!absent(e))
                warnings.add(
                  "Some plugin metadata files are unsafe, oversized, or unreadable and were skipped.",
                );
            }
          }
        } catch (e) {
          if (!absent(e))
            warnings.add(
              "Some plugin component directories are unsafe or unreadable and were skipped.",
            );
        }
      }
    }
  }
  return truncated;
}
