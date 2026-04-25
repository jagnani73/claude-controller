import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectsRoot, streamJsonlEntries } from "./claude-paths.js";

/**
 * Supports the "open /session/<id> directly" flow: when the frontend has no
 * localStorage hint about which workdir a session belongs to, scan every
 * project dir for the matching transcript and recover the cwd from its body.
 */
export async function findSessionByTranscript(
  sessionId: string,
): Promise<{ cwd: string; transcriptPath: string } | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(claudeProjectsRoot());
  } catch {
    return null;
  }

  const target = `${sessionId}.jsonl`;
  const candidates = projectDirs
    .map((p) => join(claudeProjectsRoot(), p, target))
    .filter((path) => existsSync(path));
  if (candidates.length === 0) return null;

  for (const transcriptPath of candidates) {
    const cwd = await peekCwdFromTranscript(transcriptPath);
    if (cwd) return { cwd, transcriptPath };
  }
  return null;
}

interface CwdEntry {
  cwd?: unknown;
}

async function peekCwdFromTranscript(path: string): Promise<string | null> {
  // Cap reads — `cwd` appears on virtually every transcript entry.
  for await (const entry of streamJsonlEntries<CwdEntry>(path, { maxLines: 10 })) {
    if (typeof entry.cwd === "string" && entry.cwd.length > 0) return entry.cwd;
  }
  return null;
}
