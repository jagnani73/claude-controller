import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ProjectSessionSummary } from "common/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Map a cwd to Claude Code's encoded project folder. */
export function encodedProjectDir(cwd: string): string {
  const encoded = cwd.replaceAll(/[:\\/]/g, "-");
  return join(homedir(), ".claude", "projects", encoded);
}

export interface ListProjectSessionsOptions {
  offset?: number;
  limit?: number;
  query?: string;
}

/**
 * Paginated, searchable list of transcripts under a cwd, newest first.
 * Only the requested page is summarised (file read for first-prompt + turn count).
 * `total` is the count of *matching* entries — if `query` is set, filtered;
 * otherwise the full transcript count for the folder.
 */
export async function listProjectSessions(
  cwd: string,
  opts: ListProjectSessionsOptions = {},
): Promise<{
  sessions: ProjectSessionSummary[];
  total: number;
  offset: number;
  query: string;
}> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const rawQuery = (opts.query ?? "").trim();
  const query = normalizeSearch(rawQuery);

  const dir = encodedProjectDir(cwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { sessions: [], total: 0, offset, query };
  }
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  const withMtime = await Promise.all(
    jsonlFiles.map(async (name) => {
      try {
        const stats = await stat(join(dir, name));
        return { name, mtimeMs: stats.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const ranked = withMtime
    .filter((e): e is { name: string; mtimeMs: number } => e !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let filtered = ranked;
  if (query.length > 0) {
    // Fast path: id matches can skip file I/O entirely.
    const idMatches = ranked.filter((e) =>
      normalizeSearch(e.name.replace(/\.jsonl$/, "")).includes(query),
    );

    // Slower path: scan first prompt of every non-id-matching file.
    const idMatchSet = new Set(idMatches.map((e) => e.name));
    const promptMatches: typeof ranked = [];
    for (const entry of ranked) {
      if (idMatchSet.has(entry.name)) continue;
      const summary = await summarizeTranscript(join(dir, entry.name));
      if (summary.firstPrompt && normalizeSearch(summary.firstPrompt).includes(query)) {
        promptMatches.push(entry);
      }
    }

    // Preserve mtime-desc order by intersecting with the ranked list.
    const matchSet = new Set([...idMatches, ...promptMatches].map((e) => e.name));
    filtered = ranked.filter((e) => matchSet.has(e.name));
  }

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  const sessions = await Promise.all(
    page.map(async ({ name, mtimeMs }) => {
      try {
        const summary = await summarizeTranscript(join(dir, name));
        return {
          id: name.replace(/\.jsonl$/, ""),
          cwd,
          lastModified: mtimeMs,
          firstPrompt: summary.firstPrompt,
          turnCount: summary.turnCount,
        } satisfies ProjectSessionSummary;
      } catch {
        return null;
      }
    }),
  );

  return {
    sessions: sessions.filter((s): s is ProjectSessionSummary => s !== null),
    total,
    offset,
    query: rawQuery,
  };
}

/** Scan a JSONL and return first user prompt + assistant turn count. */
async function summarizeTranscript(
  path: string,
): Promise<{ firstPrompt: string | null; turnCount: number }> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  let firstPrompt: string | null = null;
  let turnCount = 0;

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.type === "user" && !entry.isMeta && !firstPrompt) {
      const content = entry.message?.content;
      if (typeof content === "string") {
        firstPrompt = sanitize(content);
      } else if (Array.isArray(content)) {
        const textBlock = content.find(
          (b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
        );
        if (textBlock?.text) firstPrompt = sanitize(textBlock.text);
      }
    }
    if (entry.type === "assistant") turnCount++;
  }

  return { firstPrompt, turnCount };
}

/** Lowercase and drop separators/whitespace — matches the frontend highlighter. */
function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]+/g, "");
}

function sanitize(text: string): string {
  if (text.startsWith("<local-command-caveat>")) return "";
  if (text.startsWith("<local-command-stdout>")) return "";
  if (text.startsWith("<command-")) return "";
  return text.slice(0, 200).replace(/\s+/g, " ").trim();
}
