import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  IntegrationEntry,
  IntegrationSource,
  IntegrationTransport,
} from "common/integration-types";

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 150;
const BUDGET_MS = 2000;
const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// Only fixed filenames beneath a server-selected root; never open links or multiply linked files.
async function readConfig(rootPath: string, filename: string): Promise<unknown> {
  const root = await realpath(rootPath);
  const path = join(root, filename);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES)
    throw new Error("unsafe");
  const resolved = await realpath(path);
  if (!inside(root, resolved) || resolved !== path) throw new Error("unsafe");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > MAX_BYTES ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      (await realpath(path)) !== resolved ||
      (await realpath(rootPath)) !== root
    )
      throw new Error("unsafe");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("unsafe");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

/** Static metadata only; never execute config or return endpoint/credential fields. */
export async function integrationCatalog(cwd: string) {
  const entries: IntegrationEntry[] = [];
  const sources: IntegrationSource[] = [];
  let truncated = false;
  const deadline = Date.now() + BUDGET_MS;
  const add = (value: unknown, scope: IntegrationEntry["scope"]) => {
    const servers = object(value);
    if (value === undefined) return;
    if (!servers) {
      truncated = true;
      return;
    }
    for (const name in servers) {
      if (!Object.hasOwn(servers, name)) continue;
      if (entries.length >= MAX_ENTRIES || Date.now() > deadline) {
        truncated = true;
        break;
      }
      // Bound and sanitize untrusted labels; no control or bidirectional formatting characters.
      if (
        name.length < 1 ||
        name.length > 80 ||
        [...name].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return (
            code < 32 ||
            (code >= 127 && code <= 159) ||
            code === 0x200e ||
            code === 0x200f ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069)
          );
        })
      ) {
        truncated = true;
        continue;
      }
      const server = object(servers[name]);
      if (!server) {
        truncated = true;
        continue;
      }
      const type = server.type;
      const transport: IntegrationTransport =
        type === "stdio" || type === "http" || type === "sse"
          ? type
          : type === undefined && typeof server.command === "string"
            ? "stdio"
            : "unknown";
      entries.push({ name, scope, transport, enabled: "unknown" });
    }
  };
  const read = async (scope: IntegrationSource["scope"], root: string, file: string) => {
    if (Date.now() > deadline) {
      truncated = true;
      sources.push({ scope, status: "unreadable" });
      return undefined;
    }
    try {
      const result = await readConfig(root, file);
      if (!object(result)) throw new Error("invalid");
      sources.push({ scope, status: "read" });
      return object(result);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      sources.push({
        scope,
        status: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      });
      return undefined;
    }
  };
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const user = await read("user-local", configDir || homedir(), ".claude.json");
  add(user?.mcpServers, "user");
  const projects = user?.projects;
  const projectMap = object(projects);
  if (projects !== undefined && !projectMap) truncated = true;
  const local = projectMap?.[cwd];
  if (local !== undefined && !object(local)) truncated = true;
  add(object(local)?.mcpServers, "local");
  const project = await read("project", cwd, ".mcp.json");
  add(project?.mcpServers, "project");
  return { entries, sources, truncated };
}
