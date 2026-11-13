import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ChangeArea, DiffLine, WorkspaceChange, WorkspaceResult } from "common/types";
import {
  contained,
  decodeSnapshot,
  FILE_BYTES,
  readWorkspaceFile,
  resolveWorkspacePath,
  type TextSnapshot,
  workspacePath,
} from "./workspace-files.service.js";
import { workspaceGitExecutable } from "./workspace-git-executable.js";

const GIT_OUTPUT = 2 * 1024 * 1024;
const EMPTY: TextSnapshot = { text: "", binary: false, totalBytes: 0, truncated: false };

/** No shell, pager, hooks, fsmonitor, external diff or textconv. Never refresh the index. */
async function git(cwd: string, args: string[], overrides: string[] = []): Promise<Buffer> {
  const executable = await workspaceGitExecutable();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
  });
  const safeArgs = [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.hooksPath=",
    "-c",
    "diff.external=",
    ...overrides,
    ...args,
  ];
  return new Promise((accept, reject) => {
    execFile(
      executable,
      safeArgs,
      { cwd, env, encoding: "buffer", timeout: 8000, maxBuffer: GIT_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr: stderr.toString("utf8") }));
        else accept(stdout);
      },
    );
  });
}

interface Repo {
  cwd: string;
  root: string;
  prefix: string;
  overrides: string[];
}
async function repository(cwd: string): Promise<Repo | null> {
  const canonical = await realpath(cwd);
  let top: Buffer;
  try {
    top = await git(canonical, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (String((error as { stderr?: unknown }).stderr).includes("not a git repository")) {
      return null;
    }
    throw error;
  }
  const root = await realpath(top.toString("utf8").replace(/\r?\n$/, ""));
  if (!contained(root, canonical)) throw new Error("Workspace is outside the Git worktree.");
  // Status may invoke clean/process filters merely to compare worktree bytes.
  // Disable every configured driver, including global ones.
  let keys = "";
  try {
    keys = (
      await git(canonical, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."])
    ).toString("utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  const drivers = new Set(
    keys
      .split("\0")
      .map((key) => /^(filter\..+)\.[^.]+$/.exec(key)?.[1])
      .filter((key): key is string => !!key),
  );
  const overrides = [...drivers].flatMap((driver) => [
    "-c",
    `${driver}.clean=`,
    "-c",
    `${driver}.smudge=`,
    "-c",
    `${driver}.process=`,
    "-c",
    `${driver}.required=false`,
  ]);
  return {
    cwd: canonical,
    root,
    prefix: relative(root, canonical).split(sep).join("/"),
    overrides,
  };
}

function localPath(repo: Repo, repoPath: string): string | null {
  const full = resolve(repo.root, repoPath);
  if (!contained(repo.cwd, full)) return null;
  const local = relative(repo.cwd, full).split(sep).join("/");
  try {
    return workspacePath(local);
  } catch {
    return null;
  }
}

async function status(repo: Repo): Promise<WorkspaceChange[]> {
  const output = await git(
    repo.root,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--find-renames",
      "--",
      repo.prefix || ".",
    ],
    repo.overrides,
  );
  const fields = new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0");
  const entries: WorkspaceChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const x = field[0];
    const y = field[1];
    const path = localPath(repo, field.slice(3));
    const original = x === "R" || x === "C" || y === "R" || y === "C" ? fields[++i] : undefined;
    const oldPath = original ? localPath(repo, original) : undefined;
    if (!path) continue;
    // Cross-boundary rename: never disclose/read the old sibling path.
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${x}${y}`)) {
      entries.push({ path, area: "staged", status: "U" });
      entries.push({ path, area: "unstaged", status: "U" });
    } else if (x === "?") entries.push({ path, area: "untracked", status: "?" });
    else {
      if (x !== " ") {
        entries.push({ path, oldPath: oldPath ?? undefined, area: "staged", status: x });
      }
      if (y !== " ") entries.push({ path, area: "unstaged", status: y });
    }
  }
  return entries;
}

export async function workspaceChanges(cwd: string, offset: number): Promise<WorkspaceResult> {
  const repo = await repository(cwd);
  if (!repo) return { kind: "changes", isGit: false, entries: [], limited: false };
  const entries = await status(repo);
  // Git on Windows can enumerate junction descendants. Never return those
  // outside-root filenames, even though the content endpoint would reject them.
  const page = await Promise.all(
    entries.slice(offset, offset + 200).map(async (entry) => {
      try {
        await resolveWorkspacePath(cwd, entry.path, true);
        if (entry.oldPath) await resolveWorkspacePath(cwd, entry.oldPath, true);
        return entry;
      } catch {
        return null;
      }
    }),
  );
  return {
    kind: "changes",
    isGit: true,
    entries: page.filter((entry): entry is WorkspaceChange => entry !== null),
    nextOffset: entries.length > offset + 200 ? offset + 200 : undefined,
    limited: false,
  };
}

async function blob(repo: Repo, path: string, source: "head" | "index"): Promise<TextSnapshot> {
  await resolveWorkspacePath(repo.cwd, path, true);
  const repoPath = repo.prefix ? `${repo.prefix}/${path}` : path;
  const args =
    source === "head"
      ? ["ls-tree", "-z", "HEAD", "--", repoPath]
      : ["ls-files", "--stage", "-z", "--", repoPath];
  let listing: Buffer;
  try {
    listing = await git(repo.root, args, repo.overrides);
  } catch (error) {
    // An unborn branch has no HEAD; its index additions compare to empty.
    if (
      source === "head" &&
      String((error as { stderr?: unknown }).stderr).includes("Not a valid object name HEAD")
    ) {
      return EMPTY;
    }
    throw error;
  }
  const record = listing
    .toString("utf8")
    .split("\0")
    .find((item) => item.slice(item.indexOf("\t") + 1) === repoPath);
  if (!record) return EMPTY;
  const [mode, second, third] = record.slice(0, record.indexOf("\t")).split(" ");
  if (mode !== "100644" && mode !== "100755") {
    throw new Error("Symlink and submodule diffs are unavailable.");
  }
  if (source === "index" && third !== "0") {
    throw new Error("Unmerged file: resolve the conflict outside this read-only view.");
  }
  const oid = source === "head" ? third : second;
  if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Invalid Git object.");
  const size = Number(
    (await git(repo.root, ["cat-file", "-s", oid], repo.overrides)).toString("ascii"),
  );
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Git object size.");
  if (size > FILE_BYTES) return { ...EMPTY, totalBytes: size, truncated: true };
  return decodeSnapshot(await git(repo.root, ["cat-file", "blob", oid], repo.overrides), size);
}

/** Bounded LCS. Large unrelated regions become an explicit delete/add block. */
export function diffLines(before: string, after: string): { lines: DiffLine[]; coarse: boolean } {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const lines: DiffLine[] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    lines.push({ kind: "context", text: a[start], oldLine: start + 1, newLine: start + 1 });
    start++;
  }
  let ae = a.length;
  let be = b.length;
  while (ae > start && be > start && a[ae - 1] === b[be - 1]) {
    ae--;
    be--;
  }
  const n = ae - start;
  const m = be - start;
  const coarse = n * m > 1_000_000;
  let i = start;
  let j = start;
  if (coarse) {
    for (; i < ae; i++) lines.push({ kind: "remove", text: a[i], oldLine: i + 1 });
    for (; j < be; j++) lines.push({ kind: "add", text: b[j], newLine: j + 1 });
  } else {
    const width = m + 1;
    const lengths = new Uint16Array((n + 1) * width);
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        lengths[x * width + y] =
          a[start + x] === b[start + y]
            ? 1 + lengths[(x + 1) * width + y + 1]
            : Math.max(lengths[(x + 1) * width + y], lengths[x * width + y + 1]);
      }
    }
    while (i < ae || j < be) {
      if (i < ae && j < be && a[i] === b[j]) {
        lines.push({ kind: "context", text: a[i], oldLine: ++i, newLine: ++j });
      } else if (
        i < ae &&
        (j === be ||
          lengths[(i - start + 1) * width + j - start] >=
            lengths[(i - start) * width + j - start + 1])
      ) {
        lines.push({ kind: "remove", text: a[i], oldLine: ++i });
      } else {
        lines.push({ kind: "add", text: b[j], newLine: ++j });
      }
    }
  }
  while (i < a.length) lines.push({ kind: "context", text: a[i], oldLine: ++i, newLine: ++j });
  return { lines, coarse };
}

export async function workspaceDiff(
  cwd: string,
  path: string,
  area: ChangeArea,
): Promise<WorkspaceResult> {
  const repo = await repository(cwd);
  if (!repo) throw new Error("This workspace is not a Git worktree.");
  const change = (await status(repo)).find((entry) => entry.path === path && entry.area === area);
  if (!change) throw new Error("This change no longer exists. Refresh Changes.");
  await resolveWorkspacePath(cwd, path, true);
  const base = {
    kind: "diff" as const,
    path,
    area,
    oldLabel: area === "staged" ? "HEAD" : area === "untracked" ? "Empty" : "Index",
    newLabel: area === "staged" ? "Index" : "Working file",
  };
  if (change.status === "U" || (change.status === "R" && !change.oldPath)) {
    return {
      ...base,
      lines: [],
      binary: false,
      truncated: false,
      notice: "Conflict or rename across the workspace boundary: diff unavailable.",
    };
  }
  const before =
    area === "untracked"
      ? EMPTY
      : await blob(repo, change.oldPath ?? path, area === "staged" ? "head" : "index");
  const after =
    change.status === "D"
      ? EMPTY
      : area === "staged"
        ? await blob(repo, path, "index")
        : await readWorkspaceFile(cwd, path);
  const binary = before.binary || after.binary;
  const truncated = before.truncated || after.truncated;
  if (binary || truncated) {
    return {
      ...base,
      lines: [],
      binary,
      truncated,
      notice: binary
        ? "Binary or non-UTF-8 content; diff unavailable."
        : "Large file: diff unavailable (256 KiB / 4,000 lines per side limit).",
    };
  }
  const { lines, coarse } = diffLines(before.text, after.text);
  return {
    ...base,
    lines,
    binary,
    truncated,
    notice: coarse
      ? "Large changed region shown as a replacement block."
      : lines.every((line) => line.kind === "context")
        ? "No text changes (mode-only change, line-ending normalization, or file changed since refresh)."
        : undefined,
  };
}
