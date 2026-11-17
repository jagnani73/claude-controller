import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  WorkflowAgent,
  WorkflowAgentStatus,
  WorkflowPhase,
  WorkflowRun,
} from "common/workflow-types";
import type {
  AssistantEntry,
  AssistantUsage,
  ContentBlock,
  TranscriptEntry,
  UserEntry,
} from "../types/transcript.types.js";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("workflows");

/** Runs listed per session; a session with more is a runaway, and is truncated. */
const MAX_RUNS = 20;
/** Agents listed per run. */
const MAX_AGENTS = 300;
const MAX_PHASES = 40;
/** Journal bytes one snapshot may append per run (the rest follow next poll). */
const JOURNAL_CHUNK_BYTES = 4 * 1024 * 1024;
/** Past this a journal is read from its tail only, once, and flagged truncated. */
const JOURNAL_TOTAL_BYTES = 64 * 1024 * 1024;
const JOURNAL_TAIL_BYTES = 8 * 1024 * 1024;
/** A single journal line longer than this is treated as corrupt, not buffered. */
const MAX_JOURNAL_LINE_BYTES = 256 * 1024;
const MAX_JOURNAL_ENTRIES = 20_000;
/** How much of an agent transcript is read back for its latest usage. */
const AGENT_TAIL_BYTES = 32 * 1024;
/**
 * Wall-clock budget for reading agent usage in one snapshot. The first poll
 * fills in as many as it can, the cache keeps them, and later polls continue —
 * so a large run never blocks a 2s poll.
 */
const USAGE_READ_BUDGET_MS = 400;
const MAX_META_BYTES = 64 * 1024;
/** Only the head of a launch script is scanned for the literal `meta` object. */
const MAX_SCRIPT_SCAN = 64 * 1024;
/**
 * Age beyond which a recorded hook observation is no longer *offered* as
 * evidence of the current process. This bounds a stale entry; it never creates
 * liveness on its own. An agent is `running` only because a SubagentStart named
 * it and no stop followed, and it stays running however long that was — a
 * teammate idles between messages far longer than this. File timestamps are
 * never consulted: a resume rewrites nothing, so an mtime says nothing about
 * whether a process exists.
 */
const LIVE_EVIDENCE_TTL_MS = 6 * 60 * 60 * 1000;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A path segment we are willing to join: no separators, no dot segments, no device names. */
export function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !WINDOWS_DEVICE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;

// ─── Literal metadata extraction (never eval, never import) ──────────

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

export interface WorkflowMetaLiteral {
  name?: string;
  description?: string;
  phases: { title: string; detail?: string }[];
}

class NotLiteral extends Error {}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function skipTrivia(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function readStringLiteral(src: string, start: number): [string, number] {
  const quote = src[start];
  let out = "";
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1];
      if (next === undefined) throw new NotLiteral("truncated escape");
      if (next === "u") {
        const hex = src.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new NotLiteral("bad \\u escape");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      if (next === "x") {
        const hex = src.slice(i + 2, i + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new NotLiteral("bad \\x escape");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        continue;
      }
      out += ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    if (c === quote) return [out, i + 1];
    // A template literal with interpolation is not a literal we can read.
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      throw new NotLiteral("template interpolation");
    }
    if (c === "\n" && quote !== "`") throw new NotLiteral("newline in string");
    out += c;
    i++;
  }
  throw new NotLiteral("unterminated string");
}

function parseLiteral(src: string, start: number, depth: number): [Literal, number] {
  if (depth > 8) throw new NotLiteral("too deep");
  let i = skipTrivia(src, start);
  const c = src[i];
  if (c === undefined) throw new NotLiteral("unexpected end");
  if (c === '"' || c === "'" || c === "`") return readStringLiteral(src, i);
  if (c === "[") {
    const out: Literal[] = [];
    i = skipTrivia(src, i + 1);
    if (src[i] === "]") return [out, i + 1];
    while (i < src.length) {
      const [value, next] = parseLiteral(src, i, depth + 1);
      out.push(value);
      i = skipTrivia(src, next);
      if (src[i] === ",") {
        i = skipTrivia(src, i + 1);
        if (src[i] === "]") return [out, i + 1];
        continue;
      }
      if (src[i] === "]") return [out, i + 1];
      throw new NotLiteral("bad array");
    }
    throw new NotLiteral("unterminated array");
  }
  if (c === "{") {
    const out: Record<string, Literal> = {};
    i = skipTrivia(src, i + 1);
    if (src[i] === "}") return [out, i + 1];
    while (i < src.length) {
      let key: string;
      const kc = skipTrivia(src, i);
      if (src[kc] === '"' || src[kc] === "'" || src[kc] === "`") {
        const [text, next] = readStringLiteral(src, kc);
        key = text;
        i = next;
      } else {
        const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(kc, kc + 128));
        if (!match) throw new NotLiteral("bad object key");
        key = match[0];
        i = kc + key.length;
      }
      i = skipTrivia(src, i);
      if (src[i] !== ":") throw new NotLiteral("missing colon");
      const [value, next] = parseLiteral(src, i + 1, depth + 1);
      out[key] = value;
      i = skipTrivia(src, next);
      if (src[i] === ",") {
        i = skipTrivia(src, i + 1);
        if (src[i] === "}") return [out, i + 1];
        continue;
      }
      if (src[i] === "}") return [out, i + 1];
      throw new NotLiteral("bad object");
    }
    throw new NotLiteral("unterminated object");
  }
  const rest = src.slice(i, i + 32);
  for (const [word, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    if (rest.startsWith(word) && !/[A-Za-z0-9_$]/.test(src[i + word.length] ?? "")) {
      return [value, i + word.length];
    }
  }
  const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
  if (number) return [Number(number[0]), i + number[0].length];
  // A call, identifier, spread or computed key: not a literal. Unknown.
  throw new NotLiteral("not a literal");
}

/**
 * Read `export const meta = { name, description, phases }` out of a Workflow
 * launch script.
 *
 * The script is arbitrary JavaScript that we must never execute, and the rest of
 * it is irrelevant to the panel — so only the head is scanned, only the `meta`
 * value is parsed, and only a pure literal is accepted. A computed `phases`
 * (a function call, a spread, an interpolation) yields undefined rather than a
 * guess, which the UI shows as an untitled run.
 */
export function parseWorkflowMeta(script: unknown): WorkflowMetaLiteral | null {
  if (typeof script !== "string" || script.length === 0) return null;
  const head = script.slice(0, MAX_SCRIPT_SCAN);
  const match = /(?:export\s+)?const\s+meta\s*=/.exec(head);
  if (!match) return null;
  const start = head.indexOf("{", match.index + match[0].length);
  if (start < 0) return null;
  let value: Literal;
  try {
    [value] = parseLiteral(head, start, 0);
  } catch (err) {
    if (err instanceof NotLiteral) return null;
    throw err;
  }
  if (!isRecord(value)) return null;
  const phases: { title: string; detail?: string }[] = [];
  if (Array.isArray(value.phases)) {
    for (const entry of value.phases.slice(0, MAX_PHASES)) {
      if (!isRecord(entry)) continue;
      const title = clip(entry.title, 80);
      if (!title) continue;
      phases.push({ title, detail: clip(entry.detail, 400) });
    }
  }
  return {
    name: clip(value.name, 120),
    description: clip(value.description, 400),
    phases,
  };
}

// ─── Journal ────────────────────────────────────────────────────────

export interface JournalAgent {
  agentId: string;
  label?: string;
  phase?: string;
  /** True once a `result` line for this agent arrived. */
  settled: boolean;
  /** Whether that result was a success. `null` is a failure, never a success. */
  ok: boolean;
}

/**
 * The incremental, bounded reader of one run's `journal.jsonl`.
 *
 * The journal is append-only JSONL with three line kinds (observed on 2.1.326):
 *   `{type:"launched"}`
 *   `{type:"started", key, agentId, label, phase}`
 *   `{type:"result",  key, agentId, result, toolsUsed}`
 * Results carry no `label`/`phase`, so a result is joined to its agent by
 * `agentId` — `key` identifies the same pairing and is kept for the duplicate
 * count. Only the fields above are retained: a `result` body is never stored, so
 * no agent output can reach a client through this path.
 */
export class WorkflowJournal {
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  /** By agent id; a repeat start/result for one agent overwrites the earlier one. */
  private readonly agents = new Map<string, JournalAgent>();
  private readonly startKeys = new Set<string>();
  private readonly resultKeys = new Set<string>();
  truncatedBySize: boolean;
  private skipTailLine = false;
  duplicateStarts = 0;
  duplicateResults = 0;
  badLines = 0;
  totalLines = 0;
  launched = 0;

  constructor(initialTruncated = false, initialOffset = 0) {
    this.truncatedBySize = initialTruncated;
    this.offset = initialOffset;
  }

  get readOffset(): number {
    return this.offset;
  }

  /** Drop a trailing partial line that can never complete (a corrupt journal). */
  dropPartial(): void {
    this.partial = Buffer.alloc(0);
  }

  /** Feed one chunk of bytes read at `this.offset`. */
  push(chunk: Buffer, alignTail = false): void {
    if (chunk.length === 0) return;
    this.offset += chunk.length;
    if (alignTail) this.skipTailLine = true;
    if (this.skipTailLine) {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) return;
      chunk = chunk.subarray(newline + 1);
      this.skipTailLine = false;
    }
    const buffer = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    let from = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, from);
      if (newline < 0) break;
      const line = buffer.subarray(from, newline);
      from = newline + 1;
      if (line.length > 0 && line.length <= MAX_JOURNAL_LINE_BYTES)
        this.ingest(line.toString("utf8"));
      else if (line.length > MAX_JOURNAL_LINE_BYTES) this.badLines++;
    }
    this.partial = buffer.subarray(from);
    if (this.partial.length > MAX_JOURNAL_LINE_BYTES) {
      this.badLines++;
      this.partial = Buffer.alloc(0);
    }
  }

  /** Parse one complete line. Exposed for tests. */
  ingest(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.badLines++;
      return;
    }
    if (!isRecord(parsed)) {
      this.badLines++;
      return;
    }
    this.totalLines++;
    if (this.totalLines > MAX_JOURNAL_ENTRIES) {
      this.truncatedBySize = true;
      return;
    }
    if (parsed.type === "launched") {
      this.launched++;
      return;
    }
    const agentId = parsed.agentId;
    if (!isSafePathSegment(agentId)) {
      this.badLines++;
      return;
    }
    if (parsed.type === "started") {
      const key = typeof parsed.key === "string" ? parsed.key : undefined;
      if (key) {
        if (this.startKeys.has(key)) this.duplicateStarts++;
        this.startKeys.add(key);
      }
      const previous = this.agents.get(agentId);
      this.agents.set(agentId, {
        agentId,
        label: clip(parsed.label, 160) ?? previous?.label,
        phase: clip(parsed.phase, 80) ?? previous?.phase,
        settled: previous?.settled ?? false,
        ok: previous?.ok ?? false,
      });
      return;
    }
    if (parsed.type === "result") {
      const key = typeof parsed.key === "string" ? parsed.key : undefined;
      if (key) {
        if (this.resultKeys.has(key)) this.duplicateResults++;
        this.resultKeys.add(key);
      }
      const previous = this.agents.get(agentId);
      this.agents.set(agentId, {
        agentId,
        label: previous?.label,
        phase: previous?.phase,
        settled: true,
        // Observed on 2.1.326: a failed agent records `result: null`. Anything
        // else is a produced value. A null is never a success.
        ok: parsed.result !== null && parsed.result !== undefined,
      });
    }
  }

  /** Every agent the journal mentions, in start order. */
  list(): JournalAgent[] {
    return [...this.agents.values()];
  }

  get(agentId: string): JournalAgent | undefined {
    return this.agents.get(agentId);
  }

  get size(): number {
    return this.agents.size;
  }
}

// ─── Launch records ────────────────────────────────────────────────

export interface WorkflowLaunch {
  runId: string;
  taskId?: string;
  /** From the script's literal `meta`, else the launch result's `workflowName`. */
  name?: string;
  description?: string;
  metaPhases: { title: string; detail?: string }[];
  toolUseId: string;
  registeredAt: number;
}

interface PendingLaunch {
  meta: WorkflowMetaLiteral | null;
  toolUseId: string;
  seenAt: number;
}

/**
 * Read the structured `toolUseResult` of a `Workflow` call.
 *
 * Only scalars are taken; `transcriptDir` and `scriptPath` are deliberately
 * ignored — the run's directory is derived from the session's own transcript
 * location, so a payload can never point us at an arbitrary path.
 */
export function parseWorkflowLaunch(
  toolUseId: string,
  result: unknown,
  now = Date.now(),
): Omit<WorkflowLaunch, "name" | "description" | "metaPhases"> | null {
  if (!isRecord(result)) return null;
  if (result.taskType !== "local_workflow") return null;
  const runId = result.runId;
  if (!isSafePathSegment(runId)) return null;
  return {
    runId,
    taskId: clip(result.taskId, 64),
    toolUseId,
    registeredAt: now,
  };
}

// ─── Usage (request context, not spend) ────────────────────────────

/**
 * The context a single request carried: fresh input plus both cache buckets.
 * This is what the statusline calls "context", not a spend total — `output_tokens`
 * is per message and summing it would answer a different question.
 */
export function contextTokensOf(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const u = usage as AssistantUsage;
  const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens];
  let total = 0;
  let seen = false;
  for (const part of parts) {
    if (typeof part !== "number" || !Number.isFinite(part) || part < 0) continue;
    total += part;
    seen = true;
  }
  return seen ? total : undefined;
}

export interface AgentTailUsage {
  contextTokens?: number;
  modelId?: string;
}

/**
 * Scan a tail of an agent transcript for its **latest** assistant message and
 * return that message's context size and model.
 *
 * Transcript entries repeat a message id across blocks, so the last assistant
 * entry seen wins rather than the sum. The window starts mid-line, so its first
 * partial line is dropped. Nothing else from the transcript is retained.
 */
export function latestUsageFromTail(text: string): AgentTailUsage {
  const lines = text.split("\n");
  const out: AgentTailUsage = {};
  // Walk backwards: the newest assistant entry in the window is the latest one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.includes('"assistant"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "assistant") continue;
    const message = parsed.message;
    if (!isRecord(message)) continue;
    const tokens = contextTokensOf(message.usage);
    if (tokens !== undefined) out.contextTokens = tokens;
    const model = clip(message.model, 120);
    if (model) out.modelId = model;
    return out;
  }
  return out;
}

// ─── Safe filesystem access ────────────────────────────────────────

interface SafeFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * A cheap identity for a directory listing: every relevant file's name, size and
 * mtime. A workflow directory's own mtime does *not* change when an existing
 * agent's transcript or meta grows, so a cache keyed on it alone froze per-agent
 * stats at the first poll. Names are sorted so readdir order cannot matter.
 */
async function listingSignature(dir: string, entries: import("node:fs").Dirent[]): Promise<string> {
  const parts: string[] = [];
  for (const entry of entries) {
    if (!/^agent-[^/\\]+\.(meta\.json|jsonl)$/.test(entry.name)) continue;
    const info = await stat(join(dir, entry.name)).catch(() => null);
    parts.push(`${entry.name}:${info?.size ?? -1}:${Math.floor(info?.mtimeMs ?? -1)}`);
  }
  parts.sort();
  return parts.join("|");
}

/**
 * Join `segments` onto a canonical root, refusing any component that is a link.
 *
 * Windows junctions, symlinks and hard links are all rejected, because a path
 * we follow could leave the session's own directory — and the client never
 * supplies any part of one. Every check is a `lstat` (which sees a junction as a
 * link) plus a `realpath` equality test per component.
 */
async function safeDirectory(root: string, segments: string[]): Promise<string | null> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
      if (resolve(await realpath(current)) !== resolve(current)) return null;
    } catch (err) {
      if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") return null;
      throw err;
    }
  }
  return current;
}

/** `safeDirectory` for a file: regular, single-link, unlinked-canonical. */
async function safeRegularFile(root: string, segments: string[]): Promise<SafeFile | null> {
  const dir = await safeDirectory(root, segments.slice(0, -1));
  if (!dir) return null;
  const path = join(dir, segments[segments.length - 1]);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (info.nlink > 1) {
      log.info("refusing a hard-linked workflow file", { path });
      return null;
    }
    if (resolve(await realpath(path)) !== resolve(path)) return null;
    return { path, size: info.size, mtimeMs: info.mtimeMs };
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") return null;
    throw err;
  }
}

/** Open a validated file without following a link that appeared after validation. */
async function openSafe(file: SafeFile, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1) return null;
    if (info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// ─── Registry ──────────────────────────────────────────────────────

interface RunState {
  launch: WorkflowLaunch;
  journal: WorkflowJournal | null;
  journalSize: number;
  journalPresent: boolean;
  /**
   * Where the last snapshot's usage budget ran out, in this run's stable agent
   * order. The next snapshot resumes there, so a long run fills in across polls
   * instead of the first agents being re-walked forever.
   */
  usageCursor: number;
  /** The agent order the cursor indexes into; rebuilt whenever the set changes. */
  agentOrder: string[];
  /** Structured terminal status, only ever set by the CLI's own notification. */
  outcome: WorkflowRun["status"] | null;
  notice: string | null;
}

interface AgentFiles {
  agentId: string;
  meta?: { workflowPhase?: string; pickedEffortModel?: string; description?: string };
  jsonl?: SafeFile;
}

interface UsageCacheEntry {
  size: number;
  mtimeMs: number;
  usage: AgentTailUsage;
}

export interface WorkflowRegistryDeps {
  sessionId: string;
  /** `dirname` of the session's transcript: the project directory. */
  projectDir: () => string | null;
  /**
   * The existing agent stream id, for an agent the agent registry knows. Null
   * unless the transcript is one the registry itself discovered, so a client
   * can never name a path.
   */
  agentStreamId: (agentId: string) => string | undefined;
}

/**
 * What a session's workflow runs look like, read from disk.
 *
 * Two sources, both written by the CLI:
 *  - the session transcript, which records the `Workflow` tool call (with the
 *    script that names the run and its phases) and the launch result (which
 *    names the run id);
 *  - the run's own directory under `subagents/workflows/<runId>/`, which holds
 *    `journal.jsonl` (start/result lines) and one `agent-<id>.meta.json` plus
 *    `agent-<id>.jsonl` per agent it spawned.
 *
 * Everything is derived, never trusted from a payload: the run directory is
 * built from the session's transcript location plus ids that pass a strict
 * shape check, and each component is verified not to be a link. Reading happens
 * only when a client asks (`snapshot`), so an unopened panel costs nothing and
 * nothing survives a teardown but a small cache.
 *
 * Read-only by construction: no file is executed, no script is imported, and no
 * agent output is ever retained — only labels, phases, counts and a context size.
 */
export class WorkflowRegistry {
  private readonly launches = new Map<string, WorkflowLaunch>();
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly runs = new Map<string, RunState>();
  private readonly usage = new Map<string, UsageCacheEntry>();
  /** One parsed listing per run, replaced when the listing's signature changes. */
  private readonly agentFiles = new Map<
    string,
    { signature: string; files: Map<string, AgentFiles> }
  >();
  /**
   * Agents the CLI itself reported as started and not yet stopped, from the
   * SubagentStart/SubagentStop hooks. This — not a file timestamp — is the only
   * evidence of a process that exists *now*.
   */
  private readonly liveEvidence = new Map<string, number>();
  /**
   * One snapshot at a time. Two sockets polling at once used to interleave the
   * journal's `readRange`/`push`/offset update across an await, which could skip
   * bytes or parse a chunk twice; awaiting the same promise coalesces readers
   * without changing what the journal ends up holding.
   */
  private inflight: Promise<{ runs: WorkflowRun[]; truncated: boolean }> | null = null;
  private disposed = false;
  private overflow = false;
  private snapshotCursor = 0;

  constructor(private readonly deps: WorkflowRegistryDeps) {}

  // ── transcript observation ──

  /**
   * Observe one transcript entry, live or replayed. Composed into the session's
   * existing shell-entry hook, so the shell jobs still see every entry.
   */
  transcript(entry: TranscriptEntry, replay: boolean): void {
    if (this.disposed) return;
    try {
      if (entry.type === "assistant") this.observeAssistant(entry as AssistantEntry, replay);
      else if (entry.type === "user") this.observeUser(entry as UserEntry, replay);
    } catch (err) {
      // A malformed entry must never take the transcript watcher down.
      log.error("failed to observe a transcript entry", {
        sessionId: this.deps.sessionId,
        error: (err as Error).message,
      });
    }
  }

  private observeAssistant(entry: AssistantEntry, replay: boolean): void {
    if (isRecord(entry) && (entry as { isSidechain?: boolean }).isSidechain) return;
    for (const block of entry.message?.content ?? []) {
      if (block.type !== "tool_use" || block.name !== "Workflow") continue;
      const input = isRecord(block.input) ? block.input : {};
      const meta = parseWorkflowMeta(input.script);
      this.pending.set(block.id, { meta, toolUseId: block.id, seenAt: Date.now() });
      if (this.pending.size > MAX_RUNS * 4) {
        const oldest = this.pending.keys().next().value as string;
        this.pending.delete(oldest);
      }
      if (!replay) log.debug("observed a workflow launch", { toolUseId: block.id });
    }
  }

  private observeUser(entry: UserEntry, replay: boolean): void {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (block.type !== "tool_result" || !this.pending.has(block.tool_use_id)) continue;
        const launch = parseWorkflowLaunch(block.tool_use_id, entry.toolUseResult);
        if (!launch) continue;
        this.register(launch, replay);
      }
    }
    // The CLI's own terminal outcome for a background task. This is the *only*
    // signal allowed to settle a run: whether every observed agent finished says
    // nothing about a run that may still schedule more.
    this.observeNotification(entry);
  }

  private register(
    launch: Omit<WorkflowLaunch, "name" | "description" | "metaPhases">,
    replay: boolean,
  ): void {
    if (this.runs.has(launch.runId)) return;
    if (this.runs.size >= MAX_RUNS) {
      this.overflow = true;
      return;
    }
    const pending = this.pending.get(launch.toolUseId);
    this.launches.set(launch.runId, {
      ...launch,
      name: pending?.meta?.name,
      description: pending?.meta?.description,
      metaPhases: pending?.meta?.phases ?? [],
    });
    this.runs.set(launch.runId, {
      launch: this.launches.get(launch.runId) as WorkflowLaunch,
      journal: null,
      journalSize: 0,
      journalPresent: false,
      usageCursor: 0,
      agentOrder: [],
      outcome: null,
      notice: null,
    });
    log.info("workflow run registered", {
      sessionId: this.deps.sessionId,
      runId: launch.runId,
      replayed: replay,
    });
  }

  private observeNotification(entry: UserEntry): void {
    if (entry.origin?.kind !== "task-notification") return;
    const content =
      typeof entry.message.content === "string"
        ? entry.message.content
        : entry.message.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n");
    if (!content.includes("<task-notification>")) return;
    for (const match of content
      .slice(0, 65536)
      .matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const field = (key: string) =>
        match[1].match(new RegExp(`<${key}>([^<]*)</${key}>`))?.[1]?.trim();
      const taskId = field("task-id");
      const status = field("status");
      if (!taskId || !status) continue;
      if (status !== "completed" && status !== "failed" && status !== "stopped") continue;
      for (const run of this.runs.values()) {
        if (run.launch.taskId !== taskId) continue;
        run.outcome = status;
        log.info("workflow run settled by notification", {
          runId: run.launch.runId,
          status,
        });
      }
    }
  }

  // ── teardown ──

  /** The PTY is gone: nothing is running, but the history stays readable. */
  settle(): void {
    this.usage.clear();
    this.clearLiveEvidence("pty stopped");
  }

  /** Release every cache and timer. Called from `Session.stop`. */
  dispose(): void {
    this.disposed = true;
    this.inflight = null;
    this.launches.clear();
    this.pending.clear();
    this.runs.clear();
    this.usage.clear();
    this.agentFiles.clear();
    this.liveEvidence.clear();
  }

  /** Whether a run is in progress right now (never true from history alone). */
  get runCount(): number {
    return this.runs.size;
  }

  // ── hook evidence (the only liveness source) ──

  /**
   * A `SubagentStart` named this agent, so it exists in the *current* process.
   * Not gated on `replay`: a hook only ever comes from a live CLI, while a
   * transcript replay carries no hooks and therefore cannot manufacture
   * liveness. Resuming a session re-reads the transcript, never this map.
   */
  agentStarted(agentId: string): void {
    if (this.disposed || !isSafePathSegment(agentId)) return;
    this.liveEvidence.set(agentId, Date.now());
  }

  /** A `SubagentStop` for this agent: it is not running now. */
  agentStopped(agentId: string): void {
    this.liveEvidence.delete(agentId);
  }

  /**
   * The PTY that ran these agents is gone (respawn or exit). Everything on disk
   * becomes history: a resumed process never re-reports an agent it already ran,
   * so a surviving `started` would label an old process's work as live.
   */
  private clearLiveEvidence(reason: string): void {
    if (this.liveEvidence.size === 0) return;
    log.info("dropping workflow liveness evidence", {
      sessionId: this.deps.sessionId,
      agents: this.liveEvidence.size,
      reason,
    });
    this.liveEvidence.clear();
  }

  // ── snapshot ──

  /**
   * Read the session's runs. Concurrent callers share one pass: a second socket
   * polling while the first is still walking a large run awaits the same work,
   * instead of interleaving the journal cursor with it (two passes used to read
   * the same range and push it twice, or advance the offset past unread bytes).
   */
  snapshot(): Promise<{ runs: WorkflowRun[]; truncated: boolean }> {
    if (this.disposed) return Promise.resolve({ runs: [], truncated: false });
    if (!this.inflight) {
      const run = this.buildSnapshot();
      this.inflight = run;
      const clear = () => {
        if (this.inflight === run) this.inflight = null;
      };
      void run.then(clear, clear);
    }
    return this.inflight;
  }

  private async buildSnapshot(): Promise<{ runs: WorkflowRun[]; truncated: boolean }> {
    const projectDir = this.deps.projectDir();
    const deadline = { at: 0 };
    const hasBudget = () => {
      // Started lazily: the journal and meta reads come first, and the budget
      // is meant to bound the usage tails, not the walk that precedes them.
      if (deadline.at === 0) deadline.at = Date.now() + USAGE_READ_BUDGET_MS;
      return Date.now() < deadline.at;
    };
    const states = Array.from(this.runs.values());
    const runs: (WorkflowRun | null)[] = new Array(states.length).fill(null);
    const start = states.length ? this.snapshotCursor % states.length : 0;
    if (states.length) this.snapshotCursor = (start + 1) % states.length;
    for (let i = 0; i < states.length; i++) {
      const at = (start + i) % states.length;
      runs[at] = await this.buildRun(states[at], projectDir ?? null, hasBudget);
      if (this.disposed) return { runs: [], truncated: false };
    }
    return {
      runs: runs.filter((run): run is WorkflowRun => run !== null),
      truncated: this.overflow,
    };
  }

  private runSegments(runId: string): string[] | null {
    if (!isSafePathSegment(this.deps.sessionId) || !isSafePathSegment(runId)) return null;
    return [this.deps.sessionId, "subagents", "workflows", runId];
  }

  private async buildRun(
    run: RunState,
    projectDir: string | null,
    hasBudget: () => boolean,
  ): Promise<WorkflowRun | null> {
    const launch = run.launch;
    const base: WorkflowRun = {
      id: launch.runId,
      taskId: launch.taskId,
      name: launch.name ?? launch.runId,
      description: launch.description,
      status: "observed",
      phases: [],
      truncated: false,
      notice: undefined,
    };
    const segments = projectDir ? this.runSegments(launch.runId) : null;
    if (!projectDir || !segments) {
      return {
        ...base,
        notice: "This run's directory could not be derived safely.",
      };
    }
    const runDir = await safeDirectory(projectDir, segments);
    if (!runDir) {
      return {
        ...base,
        notice: outcomeNotice(run) ?? "This run's directory is not readable.",
      };
    }
    await this.readJournal(run, projectDir, segments);
    const files = await this.listAgents(run, projectDir, segments);

    // Every agent this run knows about: journal order first, then any that only
    // has files (a truncated journal, or one still starting).
    const entries: { agentId: string; journal?: JournalAgent; file?: AgentFiles }[] = [];
    const seen = new Set<string>();
    for (const journalAgent of run.journal?.list() ?? []) {
      if (seen.has(journalAgent.agentId)) continue;
      seen.add(journalAgent.agentId);
      entries.push({
        agentId: journalAgent.agentId,
        journal: journalAgent,
        file: files?.get(journalAgent.agentId),
      });
    }
    for (const [agentId, file] of files ?? []) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      entries.push({ agentId, journal: run.journal?.get(agentId), file });
    }
    if (entries.length > MAX_AGENTS) {
      run.notice = "Some agents are not listed: this run has more than the panel shows.";
      entries.length = MAX_AGENTS;
    }

    // Read usage from where the last pass ran out, wrapping around. The budget
    // bounds one poll, so a big run fills in across polls instead of re-reading
    // its first agents every time and never reaching the rest.
    const usages = new Map<string, AgentTailUsage>();
    // The budget limits refresh work, not the last-known values displayed.
    // Seed every entry before the rotating scan so unvisited agents do not
    // flicker to unknown when an earlier read consumes this poll's budget.
    for (const entry of entries) {
      // A missing or rejected file invalidates its cache even when the refresh
      // budget never reaches this entry. Do not resurrect old usage later.
      if (!entry.file?.jsonl) {
        this.usage.delete(entry.agentId);
        continue;
      }
      const cached = this.usage.get(entry.agentId);
      if (cached) usages.set(entry.agentId, cached.usage);
    }
    const total = entries.length;
    const start = total > 0 ? run.usageCursor % total : 0;
    let completed = total === 0;
    for (let i = 0; i < total; i++) {
      const at = (start + i) % total;
      const entry = entries[at];
      if (!this.usageIsFresh(entry.agentId, entry.file?.jsonl) && !hasBudget()) {
        run.usageCursor = at;
        break;
      }
      usages.set(entry.agentId, await this.usageFor(entry.agentId, entry.file, hasBudget));
      if (i === total - 1) completed = true;
    }
    if (completed) run.usageCursor = 0;

    const phases = new Map<string, WorkflowAgent[]>();
    for (const meta of launch.metaPhases) {
      if (!phases.has(meta.title)) phases.set(meta.title, []);
    }
    for (const entry of entries) {
      const usage = usages.get(entry.agentId) ?? {};
      const meta = entry.file?.meta;
      const agent = this.buildAgent(run, entry.agentId, {
        label: entry.journal?.label ?? meta?.description,
        phase: entry.journal?.phase ?? meta?.workflowPhase,
        settled: entry.journal?.settled ?? false,
        ok: entry.journal?.ok ?? false,
        modelId: usage.modelId ?? meta?.pickedEffortModel,
        contextTokens: usage.contextTokens,
      });
      const list = phases.get(agent.phase);
      if (list) list.push(agent);
      else phases.set(agent.phase, [agent]);
    }

    const orderedPhases: WorkflowPhase[] = [];
    for (const [title, agents] of phases) {
      const completed = agents.filter((a) => a.status === "completed").length;
      const failed = agents.filter((a) => a.status === "failed").length;
      const running = agents.filter((a) => a.status === "running").length;
      const detail = launch.metaPhases.find((p) => p.title === title)?.detail;
      orderedPhases.push({
        title: title === "" ? "Untagged" : title,
        detail,
        total: agents.length,
        completed,
        failed,
        running,
        agents: agents.slice(0, MAX_AGENTS),
      });
    }

    const anyRunning = orderedPhases.some((p) => p.running > 0);
    const notices = [
      run.notice,
      run.journal && run.journal.totalLines > MAX_JOURNAL_ENTRIES
        ? "This run's journal has too many entries; later entries were omitted."
        : null,
      outcomeNotice(run),
      run.journal ? null : "This run's journal has not been written yet.",
    ].filter((n): n is string => typeof n === "string");
    return {
      ...base,
      // A structured outcome is the only terminal status; otherwise a run with
      // an agent the current process is running reads `running`, and anything
      // else stays the neutral `observed`.
      status: run.outcome ?? (anyRunning ? "running" : "observed"),
      phases: orderedPhases.slice(0, MAX_PHASES),
      truncated: run.journal?.truncatedBySize ?? false,
      notice: notices.length > 0 ? notices.join(" ") : undefined,
    };
  }

  private buildAgent(
    run: RunState,
    agentId: string,
    fields: {
      label?: string;
      phase?: string;
      settled: boolean;
      ok: boolean;
      modelId?: string;
      contextTokens?: number;
    },
  ): WorkflowAgent {
    const status: WorkflowAgentStatus = fields.settled
      ? fields.ok
        ? "completed"
        : "failed"
      : this.agentIsRunning(run, agentId)
        ? "running"
        : "recorded";
    return {
      id: agentId,
      label: fields.label ?? agentId,
      phase: fields.phase ?? "",
      status,
      // Only an agent the agent registry knows gets a stream: the client must
      // not be able to name an arbitrary transcript.
      streamId: this.deps.agentStreamId(agentId),
      modelId: fields.modelId,
      contextTokens: fields.contextTokens,
    };
  }

  /**
   * Whether an agent is working right now. The only evidence accepted is a hook
   * the *current* process fired: a `SubagentStart` with no `SubagentStop` since.
   * A file timestamp is not evidence of a process — a resume leaves old agents'
   * files fresh-looking, and this used to label them live 45s after a resume. An
   * agent the hooks never named is `recorded`, which is the honest answer for a
   * run read back from disk.
   */
  private agentIsRunning(run: RunState, agentId: string): boolean {
    if (run.outcome) return false;
    const at = this.liveEvidence.get(agentId);
    if (at === undefined) return false;
    if (Date.now() - at > LIVE_EVIDENCE_TTL_MS) {
      // Stale beyond any plausible single agent turn: drop it rather than let a
      // long-lived map accumulate, and stop claiming it.
      this.liveEvidence.delete(agentId);
      return false;
    }
    return true;
  }

  // ── journal reading ──

  private async readJournal(run: RunState, projectDir: string, segments: string[]) {
    const file = await safeRegularFile(projectDir, [...segments, "journal.jsonl"]);
    if (!file) {
      run.journalPresent = false;
      return;
    }
    run.journalPresent = true;
    if (!run.journal) {
      // A journal beyond the cap is read from its tail once, so an enormous file
      // still yields current counts without scanning all of it.
      const oversized = file.size > JOURNAL_TOTAL_BYTES;
      if (oversized) {
        run.notice = "This run's journal is very large; only its most recent part was read.";
        const tailStart = Math.max(0, file.size - JOURNAL_TAIL_BYTES);
        const buffer = await this.readRange(file, tailStart, JOURNAL_TAIL_BYTES);
        if (!buffer) return;
        run.journal = new WorkflowJournal(true, tailStart);
        run.journal.push(buffer, true);
        run.journalSize = file.size;
        return;
      }
      run.journal = new WorkflowJournal();
    }
    const journal = run.journal;
    // Only new bytes: the journal is append-only, so the offset is a cursor.
    if (file.size <= journal.readOffset) return;
    const remaining = file.size - journal.readOffset;
    const length = Math.min(remaining, JOURNAL_CHUNK_BYTES);
    const buffer = await this.readRange(file, journal.readOffset, length);
    if (!buffer) return;
    journal.push(buffer);
    run.journalSize = file.size;
  }

  /** Read exact bytes; only an initial oversized journal tail needs alignment. */
  private async readRange(file: SafeFile, start: number, length: number): Promise<Buffer | null> {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1) return null;
      const size = Math.min(length, Math.max(0, info.size - start));
      if (size <= 0) return null;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  // ── agent files ──

  private async listAgents(
    run: RunState,
    projectDir: string,
    segments: string[],
  ): Promise<Map<string, AgentFiles> | null> {
    const dir = await safeDirectory(projectDir, segments);
    if (!dir) return null;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") {
        log.error("could not list a workflow directory", {
          dir,
          error: (err as Error).message,
        });
      }
      return null;
    }
    // A listing is cached on the directory's mtime, its entry count AND every
    // file's own (size, mtime): an agent's transcript and meta keep growing
    // while the directory's mtime stays put, so keying on the directory alone
    // froze the newest per-agent stats at the first poll.
    const signature = await listingSignature(dir, entries);
    const cached = this.agentFiles.get(run.launch.runId);
    if (cached && cached.signature === signature) return cached.files;

    const files = new Map<string, AgentFiles>();
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const metaMatch = /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/.exec(entry.name);
      const jsonlMatch = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/.exec(entry.name);
      if (!metaMatch && !jsonlMatch) continue;
      const agentId = (metaMatch ?? jsonlMatch)?.[1] as string;
      if (!isSafePathSegment(agentId)) continue;
      let slot = files.get(agentId);
      if (!slot) {
        if (files.size >= MAX_AGENTS) {
          run.notice = "Some agents are not listed: this run has more than the panel shows.";
          continue;
        }
        slot = { agentId };
        files.set(agentId, slot);
      }
      if (metaMatch) {
        const metaFile = await safeRegularFile(projectDir, [...segments, entry.name]);
        if (metaFile) slot.meta = await this.readMeta(metaFile);
      } else {
        slot.jsonl = (await safeRegularFile(projectDir, [...segments, entry.name])) ?? undefined;
      }
    }
    this.agentFiles.set(run.launch.runId, { signature, files });
    return files;
  }

  private async readMeta(file: SafeFile): Promise<AgentFiles["meta"]> {
    const buffer = await openSafe(file, MAX_META_BYTES);
    if (!buffer) return undefined;
    try {
      const parsed: unknown = JSON.parse(buffer.toString("utf8"));
      if (!isRecord(parsed)) return undefined;
      return {
        workflowPhase: clip(parsed.workflowPhase, 80),
        pickedEffortModel: clip(parsed.pickedEffortModel, 120),
        description: clip(parsed.description, 160),
      };
    } catch {
      // Mid-write or corrupt: the next listing retries. Not worth a log line.
      return undefined;
    }
  }

  /**
   * Whether the cached usage for an agent still describes its file, i.e. reading
   * it would not need the budget at all. Used to decide whether a starving pass
   * may skip ahead.
   */
  private usageIsFresh(agentId: string, jsonl: SafeFile | undefined): boolean {
    if (!jsonl) return true;
    const cached = this.usage.get(agentId);
    return cached !== undefined && cached.size === jsonl.size && cached.mtimeMs === jsonl.mtimeMs;
  }

  /**
   * The agent's latest request context and model, from a bounded tail of its own
   * transcript, cached on (size, mtime). An agent whose tail holds no assistant
   * entry reports no context size at all rather than a zero.
   */
  private async usageFor(
    agentId: string,
    file: AgentFiles | undefined,
    hasBudget: () => boolean,
  ): Promise<AgentTailUsage> {
    if (!file?.jsonl) return {};
    const jsonl = file.jsonl;
    const cached = this.usage.get(agentId);
    if (cached && cached.size === jsonl.size && cached.mtimeMs === jsonl.mtimeMs) {
      return cached.usage;
    }
    if (!hasBudget()) return cached?.usage ?? {};
    const start = Math.max(0, jsonl.size - AGENT_TAIL_BYTES);
    let text: string;
    try {
      const buffer = await this.readRange(jsonl, start, AGENT_TAIL_BYTES);
      if (!buffer) return cached?.usage ?? {};
      text = buffer.toString("utf8");
    } catch (err) {
      log.info("could not read an agent transcript tail", {
        agentId,
        error: errnoCode(err) ?? (err as Error).message,
      });
      return cached?.usage ?? {};
    }
    const usage = latestUsageFromTail(text);
    this.usage.set(agentId, { size: jsonl.size, mtimeMs: jsonl.mtimeMs, usage });
    return usage;
  }
}

/**
 * The notice shown for a run the CLI settled, so a finished run is not mistaken
 * for a live one. The status itself carries the outcome.
 */
function outcomeNotice(run: RunState): string | null {
  if (run.outcome === "failed") return "This run's task reported a failure.";
  if (run.outcome === "stopped") return "This run was stopped.";
  return null;
}
