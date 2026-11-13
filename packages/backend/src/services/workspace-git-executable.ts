import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const UNAVAILABLE =
  "Git is unavailable. Install Git in a trusted system location or ask the backend operator to configure an absolute GIT_BIN native executable, then restart the backend.";
let executable: Promise<string> | undefined;

function absolute(path: string): boolean {
  // Reject Windows drive-relative, root-relative and network paths too.
  return process.platform === "win32" ? /^[a-z]:[\\/]/i.test(path) : isAbsolute(path);
}

async function nativeExecutable(candidate: string, root?: string): Promise<string> {
  if (!absolute(candidate)) throw new Error(UNAVAILABLE);
  const canonical = await realpath(candidate);
  if (root) {
    const trustedRoot = await realpath(root);
    const rel = relative(trustedRoot, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(UNAVAILABLE);
    }
  }
  if (!(await stat(canonical)).isFile()) throw new Error(UNAVAILABLE);
  if (process.platform === "win32" && extname(canonical).toLowerCase() !== ".exe") {
    throw new Error(UNAVAILABLE);
  }
  await access(canonical, constants.X_OK);
  // Do not accept shell/batch wrappers, even when named git or git.exe.
  const file = await open(canonical, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const magic = header.toString("hex");
    const native =
      process.platform === "win32"
        ? header[0] === 0x4d && header[1] === 0x5a
        : [
            "7f454c46",
            "feedface",
            "cefaedfe",
            "feedfacf",
            "cffaedfe",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(magic);
    if (bytesRead !== 4 || !native) throw new Error(UNAVAILABLE);
  } finally {
    await file.close();
  }
  return canonical;
}

async function discover(): Promise<string> {
  // GIT_BIN and installation-root environment variables are operator configuration,
  // never values supplied by a session, repository, or workspace request.
  const configured = process.env.GIT_BIN;
  if (configured !== undefined) {
    try {
      return await nativeExecutable(configured);
    } catch {
      throw new Error(UNAVAILABLE); // An invalid explicit override never falls back.
    }
  }
  const candidates: { path: string; root: string }[] = [];
  if (process.platform === "win32") {
    for (const root of new Set([
      process.env.ProgramW6432,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ])) {
      if (!root || !absolute(root)) continue;
      for (const subpath of ["cmd", "bin", "mingw64/bin", "mingw32/bin"]) {
        candidates.push({ path: join(root, "Git", subpath, "git.exe"), root });
      }
    }
  } else {
    candidates.push(
      { path: "/usr/bin/git", root: "/usr" },
      { path: "/bin/git", root: "/usr" }, // merged-/usr distributions
      { path: "/bin/git", root: "/bin" },
      { path: "/usr/local/bin/git", root: "/usr/local" },
      { path: "/opt/homebrew/bin/git", root: "/opt/homebrew" },
    );
  }
  // Deliberately ignore PATH, including absolute entries: they may name a repo.
  // Discovery only inspects files; it never executes a candidate to probe it.
  for (const { path, root } of candidates) {
    try {
      return await nativeExecutable(path, root);
    } catch {
      // Missing, non-native, or escaping the trusted installation root.
    }
  }
  throw new Error(UNAVAILABLE);
}

/** Cache the canonical native file (or failure) until backend restart. No cwd input. */
export function workspaceGitExecutable(): Promise<string> {
  executable ??= discover();
  return executable;
}
