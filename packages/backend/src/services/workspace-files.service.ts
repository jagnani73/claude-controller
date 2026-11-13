import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { WorkspaceResult } from "common/types";

export const FILE_BYTES = 256 * 1024;
const FILE_LINES = 4000;
const PAGE_LINES = 400;
const PAGE_ENTRIES = 200;
const SCAN_ENTRIES = 10000;

export function workspacePath(value: unknown, allowRoot = false): string {
  if (typeof value !== "string" || value.length > 4096 || (!value && !allowRoot)) {
    throw new Error("Invalid workspace path.");
  }
  // One canonical wire representation, no Windows drive/UNC/ADS injection.
  if (isAbsolute(value) || win32.isAbsolute(value) || /[\\:]/.test(value) || value.includes("\0")) {
    throw new Error("Only relative workspace paths are allowed.");
  }
  if (value === "") return value;
  if (
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.replace(/[. ]+$/, "").toLowerCase() === ".git" ||
          (process.platform === "win32" &&
            (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))),
      )
  ) {
    throw new Error("This workspace path is not allowed.");
  }
  return value;
}

export function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Canonical containment at every component, including deleted paths used by Git. */
export async function resolveWorkspacePath(
  cwd: string,
  input: unknown,
  allowMissing = false,
): Promise<string> {
  const path = workspacePath(input, true);
  const root = await realpath(cwd);
  let target = root;
  for (const part of path ? path.split("/") : []) {
    target = resolve(target, part);
    if (!contained(root, target)) throw new Error("Path is outside the workspace.");
    try {
      // Reject links before realpath: a dangling link is not a missing regular file.
      if ((await lstat(target)).isSymbolicLink()) {
        throw new Error("Symlink content is not available.");
      }
      const actual = await realpath(target);
      if (!contained(root, actual)) throw new Error("Symlink leaves the workspace.");
      // Hide aliases pointing into .git even when their link name is benign.
      workspacePath(relative(root, actual).split(sep).join("/"), true);
      target = actual;
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return target;
}

export interface TextSnapshot {
  text: string;
  binary: boolean;
  totalBytes: number;
  truncated: boolean;
}
export function decodeSnapshot(buffer: Buffer, totalBytes = buffer.length): TextSnapshot {
  let text = "";
  let binary = buffer.includes(0);
  if (!binary) {
    // Ignore an incomplete UTF-8 sequence only at a bounded read's trailing edge.
    const maxTrim = totalBytes > buffer.length ? 3 : 0;
    for (let trim = 0; trim <= maxTrim; trim++) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, buffer.length - trim),
        );
        break;
      } catch {
        if (trim === maxTrim) binary = true;
      }
    }
  }
  const lines = text.split("\n");
  return {
    text: lines.slice(0, FILE_LINES).join("\n"),
    binary,
    totalBytes,
    truncated: totalBytes > buffer.length || lines.length > FILE_LINES,
  };
}

export async function readWorkspaceFile(cwd: string, path: string): Promise<TextSnapshot> {
  const target = await resolveWorkspacePath(cwd, path);
  if (!(await stat(target)).isFile()) throw new Error("Only regular files can be viewed.");
  const handle = await open(target, "r");
  try {
    // Verify the open object still agrees with the path we validated.
    const opened = await handle.stat();
    const checked = await stat(await resolveWorkspacePath(cwd, path));
    if (!opened.isFile() || opened.ino !== checked.ino || opened.dev !== checked.dev) {
      throw new Error("File changed while opening. Retry.");
    }
    const buffer = Buffer.alloc(Math.min(opened.size, FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return decodeSnapshot(buffer.subarray(0, bytesRead), opened.size);
  } finally {
    await handle.close();
  }
}

export async function listWorkspace(
  cwd: string,
  path: string,
  offset: number,
): Promise<WorkspaceResult> {
  const target = await resolveWorkspacePath(cwd, path);
  const entries: Extract<WorkspaceResult, { kind: "list" }>["entries"] = [];
  let scanned = 0;
  let visible = 0;
  let more = false;
  const dir = await opendir(target);
  // Streaming, bounded scan: never recursively read or materialize a huge directory.
  for await (const entry of dir) {
    if (++scanned > SCAN_ENTRIES) {
      more = true;
      break;
    }
    const child = path ? `${path}/${entry.name}` : entry.name;
    try {
      workspacePath(child);
    } catch {
      continue;
    }
    if (visible++ < offset) continue;
    if (entries.length === PAGE_ENTRIES) {
      more = true;
      break;
    }
    let kind: (typeof entries)[number]["kind"] = "unavailable";
    if (entry.isSymbolicLink()) kind = "symlink";
    else if (entry.isDirectory()) kind = "directory";
    else if (entry.isFile()) kind = "file";
    entries.push({ name: entry.name, path: child, kind });
  }
  entries.sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name),
  );
  return {
    kind: "list",
    path,
    entries,
    nextOffset: more && scanned <= SCAN_ENTRIES ? offset + entries.length : undefined,
    limited: scanned > SCAN_ENTRIES,
  };
}

export async function filePage(
  cwd: string,
  path: string,
  lineOffset: number,
): Promise<WorkspaceResult> {
  const snapshot = await readWorkspaceFile(cwd, path);
  const lines = snapshot.text.split("\n");
  return {
    ...snapshot,
    kind: "file",
    path,
    text: lines.slice(lineOffset, lineOffset + PAGE_LINES).join("\n"),
    lineOffset,
    nextLine:
      !snapshot.binary && lineOffset + PAGE_LINES < lines.length
        ? lineOffset + PAGE_LINES
        : undefined,
  };
}
