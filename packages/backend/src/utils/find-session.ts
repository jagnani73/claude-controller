import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Walks `~/.claude/projects/*` looking for `<sessionId>.jsonl`. When found,
 * peeks the first few entries to recover the original `cwd` (which Claude
 * Code records on most entries — folder name encoding is lossy). Returns
 * null when the transcript can't be located.
 *
 * Used to support "open this session id directly" flows where the frontend
 * has no localStorage hint about which workdir the session belongs to.
 */
export async function findSessionByTranscript(
  sessionId: string,
): Promise<{ cwd: string; transcriptPath: string } | null> {
  const projectsDir = join(homedir(), ".claude", "projects");
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }

  const target = `${sessionId}.jsonl`;
  for (const project of projectDirs) {
    const transcriptPath = join(projectsDir, project, target);
    try {
      const cwd = await peekCwdFromTranscript(transcriptPath);
      if (cwd) return { cwd, transcriptPath };
    } catch {
      // not in this project — keep scanning
    }
  }
  return null;
}

/** Reads up to ~50 lines, returns the first `cwd` it finds in any entry. */
async function peekCwdFromTranscript(path: string): Promise<string | null> {
  return await new Promise<string | null>((resolve, reject) => {
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(path, { encoding: "utf8" });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const settle = (value: string | null, err?: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    stream.once("error", (err) => settle(null, err));

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    rl.on("line", (line) => {
      if (++count > 50) {
        settle(null);
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const cwd = parsed.cwd;
        if (typeof cwd === "string" && cwd.length > 0) settle(cwd);
      } catch {
        // malformed line — skip
      }
    });
    rl.on("close", () => settle(null));
  });
}
