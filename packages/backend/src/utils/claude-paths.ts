import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Root of Claude Code's per-project transcript store. */
export function claudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Map a cwd to Claude Code's encoded project folder.
 *
 * Claude Code replaces **every non-alphanumeric character** with `-`, not just
 * the path separators. Verified against live `~/.claude/sessions/<pid>.json`
 * entries and the project dirs they resolve to, e.g.
 *
 *   D:\Education\NTU\Courses\Trimester 1\[SC6103] DISTRIBUTED SYSTEMS\proj
 *   -> D--Education-NTU-Courses-Trimester-1--SC6103--DISTRIBUTED-SYSTEMS-proj
 *
 * An earlier version replaced only `[:\\/]`, which silently derived a
 * non-existent directory for any path containing a space, bracket, dot or
 * underscore — the watcher then tailed nothing and the session produced no
 * transcript events at all.
 *
 * Known limit: since v2.1.224 the CLI disambiguates paths over ~200 chars under
 * a scheme we have not verified, so this can still derive the wrong directory
 * for very deep paths.
 */
export function encodedProjectDir(cwd: string): string {
  const override = process.env.CLAUDE_CODE_PROJECT_DIR_NAME?.trim();
  const encoded = override || cwd.replaceAll(/[^a-zA-Z0-9]/g, "-");
  return join(claudeProjectsRoot(), encoded);
}

/**
 * Locate a session's transcript, preferring the derived project directory and
 * falling back to a scan keyed on the session id.
 *
 * The derived path is right in the common case and costs no I/O, but the
 * encoding is the CLI's private business and we have two known blind spots:
 * paths over ~200 chars (disambiguated upstream since v2.1.224 under an
 * unverified scheme) and non-ASCII path segments. Both would otherwise leave
 * the watcher tailing a directory that never appears, which presents as a
 * session that streams nothing at all — the least debuggable failure we have.
 *
 * The scan only finds sessions whose transcript already exists. Since v2.1.126
 * the JSONL isn't created until the first user message, so a *fresh* session in
 * a mis-derived directory still falls back to the derived path and relies on
 * TranscriptWatcher's parent-dir watch to pick the file up.
 */
export function resolveTranscriptPath(cwd: string, sessionId: string): string {
  const derived = join(encodedProjectDir(cwd), `${sessionId}.jsonl`);
  if (existsSync(derived)) return derived;

  const root = claudeProjectsRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return derived;
  }
  for (const entry of entries) {
    const candidate = join(root, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return derived;
}

interface StreamJsonlOptions {
  /** Stop after this many lines have been examined. Default: unbounded. */
  maxLines?: number;
}

/**
 * Stream a JSONL file line-by-line, yielding each successfully-parsed entry.
 * Malformed lines are silently skipped. Errors opening the file (ENOENT etc)
 * resolve with no entries — callers expecting a missing-file error should
 * stat first.
 */
export async function* streamJsonlEntries<T = Record<string, unknown>>(
  path: string,
  opts: StreamJsonlOptions = {},
): AsyncGenerator<T, void, void> {
  const max = opts.maxLines ?? Number.POSITIVE_INFINITY;
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(path, { encoding: "utf8" });
  } catch {
    return;
  }
  // Swallow stream errors; downstream gets an empty iterator.
  stream.on("error", () => {});

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) {
      if (++count > max) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as T;
      } catch {
        // skip malformed line
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
