import { createReadStream, existsSync, type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  AssistantEntry,
  ContentBlock,
  SystemEntry,
  TranscriptEntry,
  UserEntry,
} from "../types/transcript.types.js";
import { LoggerService } from "./logger.service.js";
import type { SessionBus } from "./session-bus.service.js";

const log = LoggerService.scoped("transcript");

const COMMAND_NAME_RE = /<command-name>([^<]+)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([^<]*)<\/command-args>/;

/**
 * Markers Claude Code injects on `--resume` to bridge the previous session's
 * last turn to the next user input. They land in the JSONL as a paired user +
 * assistant entry but represent no real conversation, so we filter them out
 * before they hit the bus and end up rendered in the UI as fake messages.
 */
const SYNTHETIC_RESUME_USER_TEXT = "Continue from where you left off.";
const SYNTHETIC_ASSISTANT_MODEL = "<synthetic>";

// Constructed via `new RegExp` to keep raw control bytes out of source.
// Mirrors the `strip-ansi` package's CSI/SGR coverage.
const ANSI_RE = new RegExp(
  "[\\u001b\\u009b][[\\]()#;?]*" +
    "(?:(?:(?:[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function parseLocalCommand(content: string): { name: string; args?: string } | null {
  const nameMatch = content.match(COMMAND_NAME_RE);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  if (!name) return null;
  const argsMatch = content.match(COMMAND_ARGS_RE);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return { name, args: args || undefined };
}

/**
 * Watches a Claude Code transcript JSONL file and emits normalized events
 * into the target SessionBus.
 *
 * Uses fs.watch + byte-offset tracking. When the file grows, reads from the
 * last offset, splits by `\n`, JSON.parse each line, maps to bus events.
 *
 * Tolerates:
 * - Incomplete trailing lines (buffered until the next tick)
 * - Entries we don't recognize (logged + skipped)
 * - File not yet existing (retries on next watch event)
 */
export class TranscriptWatcher {
  private watcher: FSWatcher | null = null;
  private dirWatcher: FSWatcher | null = null;
  private offset = 0;
  private pendingBuffer = "";
  private stopped = false;
  private readInFlight: Promise<void> | null = null;
  private pendingRead = false;
  private initialScan = true;
  private lastAssistantModel: string | null = null;
  private lastCliVersion: string | null = null;
  // Buffered while waiting for a `<local-command-stdout>` follow-up entry
  // that completes the slash command. Flushed without output on any other
  // entry so a stuck buffer can't outlive its prompt group.
  private pendingSlashCommand: {
    name: string;
    args?: string;
    timestamp: string;
  } | null = null;

  constructor(
    readonly path: string,
    readonly bus: SessionBus,
    /** Fires whenever a fresh assistant turn changes the active model. */
    private readonly onModelChange?: (model: string) => void,
    /** Fires when the CLI version stamped on transcript entries changes. */
    private readonly onCliVersion?: (version: string) => void,
  ) {}

  private emitEvent(event: Parameters<SessionBus["push"]>[0]): void {
    if (this.initialScan) this.bus.pushSilent(event);
    else this.bus.push(event);
  }

  async start(): Promise<void> {
    // Initial pass is silent — on resume this can be thousands of entries,
    // and we don't want them streaming as "live" events to any subscriber.
    // Subscribers connecting after start() see them via the event-log tail.
    await this.drain();
    this.initialScan = false;
    if (this.lastAssistantModel) this.onModelChange?.(this.lastAssistantModel);
    // Since v2.1.126 Claude Code doesn't pre-create the transcript JSONL on
    // session start — it only appears after the first user message. Watch the
    // parent dir until our file shows up, then attach the file-level watcher.
    if (existsSync(this.path)) {
      this.watch();
      return;
    }
    this.watchForFile();
  }

  private watchForFile(): void {
    const dir = dirname(this.path);
    const targetName = basename(this.path);
    try {
      this.dirWatcher = watch(dir, (_event, filename) => {
        if (this.stopped) return;
        if (filename?.toString() !== targetName) return;
        if (!existsSync(this.path)) return;
        this.dirWatcher?.close();
        this.dirWatcher = null;
        this.watch();
        this.scheduleDrain();
      });
      this.dirWatcher.on("error", (err) => {
        log.warn("parent dir watcher error", {
          dir,
          error: err.message,
        });
      });
    } catch (err) {
      log.warn("could not watch parent dir", {
        dir,
        error: (err as Error).message,
      });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
  }

  private watch(): void {
    try {
      this.watcher = watch(this.path, () => {
        if (this.stopped) return;
        this.scheduleDrain();
      });
      this.watcher.on("error", (err) => {
        log.warn("watcher error", {
          path: this.path,
          error: err.message,
        });
      });
    } catch (err) {
      log.warn("could not watch transcript", {
        path: this.path,
        error: (err as Error).message,
      });
    }
  }

  /** Coalesce multiple watch events into a single read pass. */
  private scheduleDrain(): void {
    if (this.readInFlight) {
      this.pendingRead = true;
      return;
    }
    this.readInFlight = this.drain()
      .catch((err) =>
        log.warn("drain error", {
          path: this.path,
          error: (err as Error).message,
        }),
      )
      .finally(() => {
        this.readInFlight = null;
        if (this.pendingRead && !this.stopped) {
          this.pendingRead = false;
          this.scheduleDrain();
        }
      });
  }

  private async drain(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return; // file may not exist yet
    }
    if (size <= this.offset) return;

    const stream = createReadStream(this.path, {
      start: this.offset,
      end: size - 1,
      encoding: "utf8",
    });

    let chunk = "";
    for await (const piece of stream) {
      chunk += piece;
    }
    this.offset = size;

    const combined = this.pendingBuffer + chunk;
    const lines = combined.split("\n");
    // Last element is incomplete (no trailing \n) or empty
    this.pendingBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as TranscriptEntry;
        this.handleEntry(entry);
      } catch (err) {
        log.debug("parse error", {
          line: trimmed.slice(0, 200),
          error: (err as Error).message,
        });
      }
    }
  }

  private flushPendingSlashCommand(output?: string): void {
    if (!this.pendingSlashCommand) return;
    const cmd = this.pendingSlashCommand;
    this.pendingSlashCommand = null;
    this.emitEvent({
      kind: "slash_command",
      sessionId: this.bus.sessionId,
      timestamp: cmd.timestamp,
      name: cmd.name,
      args: cmd.args,
      output,
    });
  }

  /**
   * Track the CLI build writing this transcript. Every user/assistant/system/
   * attachment entry carries a `version`, which makes this the only source that
   * is always available — the statusline payload carries it too, but only flows
   * when the user has a statusline command configured.
   *
   * Fires on change rather than once, so a resume spanning a CLI upgrade reports
   * the newer build rather than the stale one at the head of the file. Runs
   * during the silent initial scan too: it's a plain callback, not a bus event,
   * so it can't leak replayed entries into the UI stream.
   */
  private noteCliVersion(entry: TranscriptEntry): void {
    const version = (entry as { version?: unknown }).version;
    if (typeof version !== "string" || !version) return;
    if (version === this.lastCliVersion) return;
    this.lastCliVersion = version;
    this.onCliVersion?.(version);
  }

  private handleEntry(entry: TranscriptEntry): void {
    this.noteCliVersion(entry);
    if (entry.type === "assistant") {
      this.flushPendingSlashCommand();
      this.handleAssistant(entry as AssistantEntry);
    } else if (entry.type === "user") {
      this.handleUser(entry as UserEntry);
    } else if (entry.type === "permission-mode") {
      const mode = (entry as { permissionMode?: string }).permissionMode;
      if (typeof mode === "string") {
        this.emitEvent({
          kind: "permission_mode",
          sessionId: this.bus.sessionId,
          timestamp: new Date().toISOString(),
          mode,
        });
      }
    } else if (entry.type === "system") {
      this.handleSystem(entry as SystemEntry);
    } else {
      this.flushPendingSlashCommand();
    }
    // other types (attachment, file-history-snapshot) aren't surfaced.
  }

  private handleAssistant(entry: AssistantEntry): void {
    // Synthetic assistant turn from `--resume` scaffolding — filter out.
    if (entry.message.model === SYNTHETIC_ASSISTANT_MODEL) return;
    const sessionId = this.bus.sessionId;
    const timestamp = entry.timestamp;
    const turnId = entry.message.id;

    if (entry.message.model && this.lastAssistantModel !== entry.message.model) {
      this.lastAssistantModel = entry.message.model;
      if (!this.initialScan) this.onModelChange?.(entry.message.model);
    }

    const content: ContentBlock[] = entry.message.content ?? [];
    for (const block of content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        this.emitEvent({
          kind: "assistant_text",
          sessionId,
          timestamp,
          turnId,
          text: block.text,
        });
      } else if (block.type === "tool_use") {
        this.emitEvent({
          kind: "tool_call",
          sessionId,
          timestamp,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  private handleSystem(entry: SystemEntry): void {
    if (entry.subtype !== "local_command" || !entry.content) return;
    const parsed = parseLocalCommand(entry.content);
    if (!parsed) return;
    // System local_command entries (e.g. /rename) are self-contained, no stdout.
    this.flushPendingSlashCommand();
    this.emitEvent({
      kind: "slash_command",
      sessionId: this.bus.sessionId,
      timestamp: entry.timestamp,
      name: parsed.name,
      args: parsed.args,
    });
  }

  private handleUser(entry: UserEntry): void {
    if (entry.isMeta) return;
    const sessionId = this.bus.sessionId;
    const timestamp = entry.timestamp;
    const content = entry.message.content;

    if (typeof content === "string") {
      if (entry.isCompactSummary) {
        this.emitEvent({
          kind: "compact_summary",
          sessionId,
          timestamp,
          text: content,
        });
        return;
      }
      // Synthetic --resume bridge prompt — Claude Code's internal scaffolding,
      // not a user-typed message.
      if (content === SYNTHETIC_RESUME_USER_TEXT) return;
      // Caveats are scaffolding — ignore but don't flush; they appear between
      // the command-name and stdout entries in the same prompt group.
      if (content.startsWith("<local-command-caveat>")) return;
      // Stdout closes a pending slash command — emit with output attached.
      if (content.startsWith("<local-command-stdout>")) {
        const stdout = stripAnsi(
          content.replace(/^<local-command-stdout>/, "").replace(/<\/local-command-stdout>$/, ""),
        ).trim();
        this.flushPendingSlashCommand(stdout || undefined);
        return;
      }
      // <command-name>/X</command-name> opens a slash command — buffer until
      // we either see the matching stdout or hit something else.
      if (content.startsWith("<command-")) {
        const parsed = parseLocalCommand(content);
        if (parsed) {
          // Flush any prior unmatched buffer first.
          this.flushPendingSlashCommand();
          this.pendingSlashCommand = { ...parsed, timestamp };
        }
        return;
      }
      // Real chat content — anything pending didn't get a stdout, flush plain.
      this.flushPendingSlashCommand();
      this.emitEvent({ kind: "user_prompt", sessionId, timestamp, text: content });
      return;
    }

    // Array form — tool_result blocks
    for (const block of content) {
      if (block.type === "tool_result") {
        this.emitEvent({
          kind: "tool_result",
          sessionId,
          timestamp,
          toolUseId: block.tool_use_id,
          result: block.content,
          isError: block.is_error ?? false,
        });
      } else if (block.type === "text") {
        // Synthetic --resume bridge prompt arrives as an array-form text block
        // when Claude Code uses the structured user-content shape.
        if (block.text === SYNTHETIC_RESUME_USER_TEXT) continue;
        this.emitEvent({ kind: "user_prompt", sessionId, timestamp, text: block.text });
      }
    }
  }
}
