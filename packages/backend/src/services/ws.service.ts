import { readdirSync } from "node:fs";
import { normalize, resolve } from "node:path";
import type {
  ClientMessage,
  DirEntry,
  PermissionMode,
  ServerMessage,
  SessionInfo,
} from "common/types";
import type { WebSocket } from "ws";
import type { Session } from "../session/session.js";
import type { ClientState, ServerConfig } from "../types/index.js";
import { listProjectSessions } from "../utils/project-sessions.js";
import type { HooksService } from "./hooks.service.js";
import { LoggerService } from "./logger.service.js";
import type { SessionBus, SessionBusEvent } from "./session-bus.service.js";
import type { SessionManager } from "./session-manager.service.js";

const log = LoggerService.scoped("ws");

const clients = new Map<WebSocket, ClientState>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function listChildEntries(dirPath: string, workDir: string): DirEntry[] {
  const resolved = resolve(dirPath);
  const normalizedWork = normalize(workDir);
  if (!resolved.startsWith(normalizedWork)) {
    return [];
  }
  try {
    return readdirSync(resolved, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({
        name: d.name,
        path: resolve(resolved, d.name),
        isDir: d.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

/** Translate a SessionBusEvent into the corresponding WsMessage envelope. */
function busEventToMessage(event: SessionBusEvent): ServerMessage {
  switch (event.kind) {
    case "user_prompt":
      return {
        type: "user_prompt",
        sessionId: event.sessionId,
        text: event.text,
        timestamp: event.timestamp,
      };
    case "assistant_text":
      return {
        type: "assistant_text",
        sessionId: event.sessionId,
        text: event.text,
        turnId: event.turnId,
        timestamp: event.timestamp,
      };
    case "tool_call":
      return {
        type: "tool_call",
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        timestamp: event.timestamp,
      };
    case "tool_result":
      return {
        type: "tool_result",
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        result: event.result,
        isError: event.isError,
        timestamp: event.timestamp,
      };
    case "approval_request":
      return {
        type: "approval_request",
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        toolInput: event.toolInput,
      };
    case "permission_mode":
      return {
        type: "permission_mode",
        sessionId: event.sessionId,
        mode: event.mode as PermissionMode,
      };
  }
}

const INITIAL_REPLAY = 20;

function subscribeToSession(ws: WebSocket, session: Session): void {
  const state = clients.get(ws);
  if (!state) return;

  // Single-viewer-per-session: evict any other client already watching this session.
  for (const [otherWs, otherState] of clients) {
    if (otherWs === ws) continue;
    if (otherState.subscribedSessionId === session.id) {
      log.info("Evicting prior subscriber", { sessionId: session.id });
      otherState.cleanup?.();
      otherState.subscribedSessionId = null;
      otherState.cleanup = null;
      send(otherWs, { type: "session_taken_over", sessionId: session.id });
    }
  }

  if (state.cleanup) state.cleanup();

  log.info("Client subscribing to session", { sessionId: session.id });

  // Replay only the tail of the event log — chat-style. Older history is
  // pulled on demand via `fetch_history`.
  const bus: SessionBus = session.bus;
  const total = bus.getEventLogSize();
  const startIdx = Math.max(0, total - INITIAL_REPLAY);
  for (const event of bus.getEventLogSlice(startIdx, total)) {
    send(ws, busEventToMessage(event));
  }
  send(ws, {
    type: "history_available",
    sessionId: session.id,
    earliestIndex: startIdx,
    hasMore: startIdx > 0,
  });

  const onEvent = (event: SessionBusEvent) => {
    send(ws, busEventToMessage(event));
  };
  const onExit = () => {
    send(ws, {
      type: "session_stopped",
      sessionId: session.id,
      exitCode: null,
    });
  };

  bus.on("event", onEvent);
  session.on("exit", onExit);

  state.subscribedSessionId = session.id;
  state.cleanup = () => {
    bus.off("event", onEvent);
    session.off("exit", onExit);
  };

  send(ws, { type: "session_metadata", session: session.getInfo() });
}

function broadcast(msg: ServerMessage): void {
  for (const ws of clients.keys()) send(ws, msg);
}

export function broadcastSessionCreated(session: SessionInfo): void {
  broadcast({ type: "session_created", session });
}

function handleMessage(
  ws: WebSocket,
  msg: ClientMessage,
  sessionManager: SessionManager,
  hooksService: HooksService,
  config: ServerConfig,
): void {
  switch (msg.type) {
    case "input": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) {
        send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: "Session not found",
        });
        return;
      }
      log.debug("Forwarding input", {
        sessionId: msg.sessionId,
        text: msg.text.slice(0, 500),
      });
      session.sendInput(msg.text);
      return;
    }

    case "slash_command": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      log.debug("Slash command", {
        sessionId: msg.sessionId,
        command: msg.command,
      });
      session.sendSlashCommand(msg.command);
      return;
    }

    case "approval_response": {
      const ok = hooksService.resolveApproval(
        msg.sessionId,
        msg.toolUseId,
        msg.decision,
        msg.reason,
      );
      if (!ok) {
        log.warn("No pending approval to resolve", {
          sessionId: msg.sessionId,
          toolUseId: msg.toolUseId,
        });
      }
      return;
    }

    case "create_session": {
      log.info("Creating session", { config: msg.config });
      const session = sessionManager.create(msg.config);
      broadcastSessionCreated(session.getInfo());
      subscribeToSession(ws, session);

      if (msg.config.effort) {
        setTimeout(() => {
          session.sendSlashCommand(`/effort ${msg.config.effort}`);
        }, 3000);
      }
      return;
    }

    case "stop_session": {
      log.info("Stopping session", { sessionId: msg.sessionId });
      sessionManager.stop(msg.sessionId);
      return;
    }

    case "subscribe": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) {
        send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: "Session not found",
        });
        return;
      }
      subscribeToSession(ws, session);
      return;
    }

    case "list_dirs": {
      const entries = listChildEntries(msg.path, config.workDir);
      send(ws, {
        type: "dir_list",
        path: resolve(msg.path),
        entries,
      });
      return;
    }

    case "list_project_sessions": {
      void listProjectSessions(msg.cwd, {
        offset: msg.offset,
        limit: msg.limit,
        query: msg.query,
      }).then(({ sessions, total, offset, query }) => {
        send(ws, {
          type: "project_sessions",
          cwd: msg.cwd,
          sessions,
          total,
          offset,
          query,
        });
      });
      return;
    }

    case "resize": {
      const session = sessionManager.get(msg.sessionId);
      session?.resize(msg.cols, msg.rows);
      return;
    }

    case "cycle_permission_mode": {
      const session = sessionManager.get(msg.sessionId);
      session?.cyclePermissionMode();
      return;
    }

    case "fetch_history": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      const bus = session.bus;
      const total = bus.getEventLogSize();
      const end = Math.min(total, Math.max(0, msg.beforeIndex));
      const limit = Math.max(1, Math.min(100, msg.limit));
      const start = Math.max(0, end - limit);
      const events = bus.getEventLogSlice(start, end).map(busEventToMessage);
      send(ws, {
        type: "history_page",
        sessionId: msg.sessionId,
        events,
        fromIndex: start,
        hasMore: start > 0,
      });
      return;
    }
  }
}

export function handleConnection(
  ws: WebSocket,
  sessionManager: SessionManager,
  hooksService: HooksService,
  config: ServerConfig,
): void {
  clients.set(ws, { subscribedSessionId: null, cleanup: null });

  log.info("Client connected");

  send(ws, {
    type: "connected",
    sessions: sessionManager.list(),
    workDir: config.workDir,
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;
      handleMessage(ws, msg, sessionManager, hooksService, config);
    } catch (err) {
      log.error("Invalid message", { error: err });
      send(ws, { type: "error", message: "Invalid message format" });
    }
  });

  ws.on("close", () => {
    log.info("Client disconnected");
    const state = clients.get(ws);
    if (state?.cleanup) state.cleanup();
    clients.delete(ws);
  });
}
