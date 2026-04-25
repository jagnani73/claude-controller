import { createReadStream, type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  AssistantEntry,
  ContentBlock,
  TranscriptEntry,
  UserEntry,
} from "../types/transcript.types.js";
import { LoggerService } from "./logger.service.js";
import type { SessionBus } from "./session-bus.service.js";

const log = LoggerService.scoped("transcript");

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
  private offset = 0;
  private pendingBuffer = "";
  private stopped = false;
  private readInFlight: Promise<void> | null = null;
  private pendingRead = false;
  private initialScan = true;
  private lastAssistantModel: string | null = null;

  constructor(
    readonly path: string,
    readonly bus: SessionBus,
    /** Fires whenever a fresh assistant turn changes the active model. */
    private readonly onModelChange?: (model: string) => void,
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
    this.watch();
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
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

  private handleEntry(entry: TranscriptEntry): void {
    if (entry.type === "assistant") {
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
    }
    // other types (system, attachment, file-history-snapshot) aren't surfaced.
  }

  private handleAssistant(entry: AssistantEntry): void {
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
      // Skip command caveats and other meta-text wrappers
      if (content.startsWith("<local-command-caveat>")) return;
      if (content.startsWith("<local-command-stdout>")) return;
      if (content.startsWith("<command-")) return;
      this.emitEvent({
        kind: "user_prompt",
        sessionId,
        timestamp,
        text: content,
      });
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
        this.emitEvent({
          kind: "user_prompt",
          sessionId,
          timestamp,
          text: block.text,
        });
      }
    }
  }
}
