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
    if (event.kind === "tool_call") {
      if (this.seenToolUseIds.has(event.toolUseId)) return;
      this.seenToolUseIds.add(event.toolUseId);
    }

    this.events.push(event);
    log.debug("Event", {
      sessionId: this.sessionId,
      kind: event.kind,
      logSize: this.events.length,
    });
    this.emit("event", event);
  }

  /** Replay all prior events to a new subscriber. */
  getEventLog(): readonly SessionBusEvent[] {
    return this.events;
  }

  /** Clear all state, remove all listeners. */
  dispose(): void {
    this.events = [];
    this.seenToolUseIds.clear();
    this.removeAllListeners();
  }
}
