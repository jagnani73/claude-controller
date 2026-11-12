import { EventEmitter } from "node:events";
import type { CompactTrigger } from "common/types";
import { LoggerService } from "./logger.service.js";

/**
 * Normalized session event — the single shape consumed by ws.service.
 * Produced by hooks.service (approval events) and transcript.service (content).
 */
export type SessionBusEvent =
  | {
      kind: "user_prompt";
      sessionId: string;
      timestamp: string;
      text: string;
    }
  | {
      kind: "assistant_text";
      sessionId: string;
      timestamp: string;
      turnId: string;
      text: string;
    }
  | {
      kind: "tool_call";
      sessionId: string;
      timestamp: string;
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      sessionId: string;
      timestamp: string;
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      kind: "approval_request";
      sessionId: string;
      timestamp: string;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      /** Set when a subagent, not the lead, is the one asking. */
      agent?: { id: string; label: string };
    }
  | {
      kind: "permission_mode";
      sessionId: string;
      timestamp: string;
      mode: string;
    }
  | {
      kind: "model_switch";
      sessionId: string;
      timestamp: string;
      /** Alias the user asked for ("opus"), when the switch carried one. */
      requestedModel?: string;
      /** Resolved model id after the switch ("claude-opus-5"). */
      toModel: string;
      /** What triggered it; "command" for `/model`. */
      source?: string;
    }
  | {
      /**
       * The `ExitPlanMode` picker is open (its notification-only
       * `PermissionRequest` fired). Backend-internal: `Session.answerPlan` waits
       * for it before writing a single key — see the comment there.
       */
      kind: "plan_picker_open";
      sessionId: string;
      timestamp: string;
    }
  | {
      kind: "compact_start";
      sessionId: string;
      timestamp: string;
      trigger: CompactTrigger;
    }
  | {
      kind: "compact_end";
      sessionId: string;
      timestamp: string;
      trigger: CompactTrigger;
    }
  | {
      kind: "compact_summary";
      sessionId: string;
      timestamp: string;
      text: string;
    }
  | {
      kind: "slash_command";
      sessionId: string;
      timestamp: string;
      name: string;
      args?: string;
      output?: string;
    }
  | {
      kind: "interrupt";
      sessionId: string;
      timestamp: string;
    };

type BusEvents = {
  event: [SessionBusEvent];
};

const log = LoggerService.scoped("session-bus");

/**
 * Retention cap for the in-memory event log. A long-lived backend keeps every
 * session it has resumed, and tool results (file reads, command output) are
 * stored whole, so an uncapped log grows without limit. When either limit is
 * crossed the oldest events are dropped in one batch, down to
 * {@link TRIM_TO_FRACTION} of the limit (hysteresis, so a full log is not
 * spliced on every push), but never below {@link MIN_RETAINED_EVENTS}: the
 * lookbacks below (interrupt-concat echo, repeat compact summary) only ever
 * read the newest few events.
 *
 * Indices handed to clients are absolute (see `getFirstRetainedIndex`), so a
 * dropped prefix never shifts what an `earliestIndex` refers to. Paging below
 * the retained window returns nothing with `hasMore: false`; the transcript
 * JSONL on disk remains the full history.
 */
export const MAX_RETAINED_EVENTS = 5_000;
/** Approximate size cap, in UTF-16 code units of the serialized events. */
export const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
/** Floor for the byte cap: covers the subscribe replay (20) and every lookback. */
const MIN_RETAINED_EVENTS = 50;
const TRIM_TO_FRACTION = 0.9;

function approximateSize(event: SessionBusEvent): number {
  try {
    return JSON.stringify(event)?.length ?? 0;
  } catch {
    return 0;
  }
}

export class SessionBus extends EventEmitter<BusEvents> {
  private events: SessionBusEvent[] = [];
  /** Approximate size of each retained event, parallel to `events`. */
  private sizes: number[] = [];
  private retainedBytes = 0;
  /** Absolute index of `events[0]`: how many events have been dropped. */
  private base = 0;
  /**
   * Kinds appended since the newest `user_prompt` (or since the start, when
   * there has been none). Kept outside the log so turn-state lookbacks
   * (`Session.hasInFlightTurn`, the redirect check, the transcript's interrupt
   * dedupe) stay correct even when the log has dropped the prompt itself.
   */
  private kindsSincePrompt = new Set<SessionBusEvent["kind"]>();
  private sawUserPrompt = false;
  private seenToolUseIds = new Set<string>();

  constructor(readonly sessionId: string) {
    super();
    this.setMaxListeners(50);
  }

  /** Append an event to the log and broadcast to listeners. */
  push(event: SessionBusEvent): void {
    if (!this.append(event)) return;
    this.emit("event", event);
  }

  /**
   * Append without emitting — for bulk transcript replays at session start.
   * Lets subscribers that connect *after* the replay see history via the
   * normal event-log slice APIs, without a storm of "live" events.
   */
  pushSilent(event: SessionBusEvent): void {
    this.append(event);
  }

  private append(event: SessionBusEvent): boolean {
    if (event.kind === "tool_call") {
      if (this.seenToolUseIds.has(event.toolUseId)) return false;
      this.seenToolUseIds.add(event.toolUseId);
    }
    // Drop the concat echo Claude Code writes after an Esc + redirect.
    // After interrupt + new input, the JSONL gets a single `user_prompt` whose
    // text is `<interrupted text><redirect>` — but the original and redirect
    // are already represented as separate events (the redirect is synthesized
    // by Session.sendInput). Without this drop, the UI would show three user
    // bubbles for what was conceptually two messages.
    if (event.kind === "user_prompt" && this.isInterruptConcatEcho(event)) {
      log.debug("Dropping interrupt-concat echo", {
        sessionId: this.sessionId,
        textLength: event.text.length,
      });
      return false;
    }
    // One compaction reaches the bus twice: PostCompact carries the summary, and
    // the transcript then writes it again as an `isCompactSummary` user entry
    // (with a preamble, so the texts differ). Keep whichever arrives first.
    if (event.kind === "compact_summary" && this.isRepeatCompactSummary()) {
      log.debug("Dropping repeat compact summary", { sessionId: this.sessionId });
      return false;
    }
    this.events.push(event);
    const size = approximateSize(event);
    this.sizes.push(size);
    this.retainedBytes += size;
    if (event.kind === "user_prompt") {
      this.sawUserPrompt = true;
      this.kindsSincePrompt.clear();
    } else {
      this.kindsSincePrompt.add(event.kind);
    }
    this.trim();
    log.debug("Event", {
      sessionId: this.sessionId,
      kind: event.kind,
      logSize: this.events.length,
    });
    return true;
  }

  /** Drop the oldest events once the log is over either retention limit. */
  private trim(): void {
    const overCount = this.events.length > MAX_RETAINED_EVENTS;
    const overBytes = this.retainedBytes > MAX_RETAINED_BYTES;
    if (!overCount && !overBytes) return;
    const targetCount = Math.floor(MAX_RETAINED_EVENTS * TRIM_TO_FRACTION);
    const targetBytes = Math.floor(MAX_RETAINED_BYTES * TRIM_TO_FRACTION);
    let drop = 0;
    let bytes = this.retainedBytes;
    while (
      this.events.length - drop > MIN_RETAINED_EVENTS &&
      (this.events.length - drop > targetCount || bytes > targetBytes)
    ) {
      bytes -= this.sizes[drop];
      drop++;
    }
    if (drop === 0) return;
    this.events.splice(0, drop);
    this.sizes.splice(0, drop);
    this.retainedBytes = bytes;
    this.base += drop;
    log.debug("Trimmed event log", {
      sessionId: this.sessionId,
      dropped: drop,
      firstRetainedIndex: this.base,
      retained: this.events.length,
      retainedBytes: bytes,
    });
  }

  /**
   * True when the log already holds a compact summary with nothing but
   * compaction bookkeeping after it, i.e. this one describes the same
   * compaction. Ordering, not timestamps: either source may arrive first, and
   * separate compactions are always separated by real conversation.
   */
  private isRepeatCompactSummary(): boolean {
    const bookkeeping: ReadonlySet<SessionBusEvent["kind"]> = new Set([
      "compact_start",
      "compact_end",
      "permission_mode",
      "model_switch",
    ]);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const kind = this.events[i].kind;
      if (kind === "compact_summary") return true;
      if (!bookkeeping.has(kind)) return false;
    }
    return false;
  }

  /**
   * True when `event` is the JSONL "combined" user_prompt that Claude Code
   * writes after Esc + redirect. Pattern: the prior two user_prompts in the
   * log are separated by ONLY interrupt/permission_mode events, and the new
   * text equals priorUser.text + lastUser.text (Claude Code concatenates
   * the interrupted prompt with the redirect verbatim).
   */
  private isInterruptConcatEcho(event: SessionBusEvent & { kind: "user_prompt" }): boolean {
    let lastIdx = -1;
    let priorIdx = -1;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].kind !== "user_prompt") continue;
      if (lastIdx === -1) lastIdx = i;
      else {
        priorIdx = i;
        break;
      }
    }
    if (priorIdx < 0 || lastIdx < 0) return false;
    const between = this.events.slice(priorIdx + 1, lastIdx);
    const hadInterrupt = between.some((e) => e.kind === "interrupt");
    const hadOther = between.some((e) => e.kind !== "interrupt" && e.kind !== "permission_mode");
    if (!hadInterrupt || hadOther) return false;
    const prior = this.events[priorIdx] as Extract<SessionBusEvent, { kind: "user_prompt" }>;
    const last = this.events[lastIdx] as Extract<SessionBusEvent, { kind: "user_prompt" }>;
    return (
      event.text.startsWith(prior.text) &&
      event.text.endsWith(last.text) &&
      event.text.length > last.text.length
    );
  }

  /** The retained events, oldest first (older ones may have been dropped). */
  getEventLog(): readonly SessionBusEvent[] {
    return this.events;
  }

  /**
   * Absolute index one past the newest event: the number of events ever
   * appended, including any the retention cap has since dropped.
   */
  getEventLogSize(): number {
    return this.base + this.events.length;
  }

  /** Absolute index of the oldest retained event; 0 until something is dropped. */
  getFirstRetainedIndex(): number {
    return this.base;
  }

  /** Events in the absolute range [start, end); the dropped part reads as empty. */
  getEventLogSlice(start: number, end: number): readonly SessionBusEvent[] {
    return this.events.slice(Math.max(0, start - this.base), Math.max(0, end - this.base));
  }

  /** Whether a `tool_call` with this id was ever appended (survives trimming). */
  hasToolCall(toolUseId: string): boolean {
    return this.seenToolUseIds.has(toolUseId);
  }

  /**
   * The current turn as far as the log can tell: whether any `user_prompt` has
   * been appended, and the kinds appended since the newest one (since the
   * start when there is none). Unaffected by trimming.
   */
  sinceLastUserPrompt(): { hasPrompt: boolean; kinds: ReadonlySet<SessionBusEvent["kind"]> } {
    return { hasPrompt: this.sawUserPrompt, kinds: this.kindsSincePrompt };
  }

  /** Clear all state, remove all listeners. */
  dispose(): void {
    this.events = [];
    this.sizes = [];
    this.retainedBytes = 0;
    this.kindsSincePrompt.clear();
    this.sawUserPrompt = false;
    this.seenToolUseIds.clear();
    this.removeAllListeners();
  }
}
