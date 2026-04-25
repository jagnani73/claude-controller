import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Root of Claude Code's per-project transcript store. */
export function claudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** Map a cwd to Claude Code's encoded project folder. */
export function encodedProjectDir(cwd: string): string {
  const encoded = cwd.replaceAll(/[:\\/]/g, "-");
  return join(claudeProjectsRoot(), encoded);
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
