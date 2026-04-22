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
    this.events.push(event);
    log.debug("Event", {
      sessionId: this.sessionId,
      kind: event.kind,
      logSize: this.events.length,
    });
    return true;
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
