import { EventEmitter } from "node:events";
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
      kind: "compact_start";
      sessionId: string;
      timestamp: string;
      trigger: "manual" | "auto";
    }
  | {
      kind: "compact_end";
      sessionId: string;
      timestamp: string;
      trigger: "manual" | "auto";
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

export class SessionBus extends EventEmitter<BusEvents> {
  private events: SessionBusEvent[] = [];
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
    this.events.push(event);
    log.debug("Event", {
      sessionId: this.sessionId,
      kind: event.kind,
      logSize: this.events.length,
    });
    return true;
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

  /** Replay all prior events to a new subscriber. */
  getEventLog(): readonly SessionBusEvent[] {
    return this.events;
  }

  getEventLogSize(): number {
    return this.events.length;
  }

  getEventLogSlice(start: number, end: number): readonly SessionBusEvent[] {
    return this.events.slice(start, end);
  }

  /** Clear all state, remove all listeners. */
  dispose(): void {
    this.events = [];
    this.seenToolUseIds.clear();
    this.removeAllListeners();
  }
}
