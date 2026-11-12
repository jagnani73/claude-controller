import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { autoCycleSupport } from "common/permission-cycle";
import type {
  AgentMessage,
  AgentNode,
  ClientMessage,
  DirEntry,
  PermissionMode,
  ServerMessage,
  SessionInfo,
} from "common/types";
import { agentStreamId, isClaudeModel, isPermissionMode, parseAgentStreamId } from "common/types";
import ignore, { type Ignore } from "ignore";
import type { WebSocket } from "ws";
import type { Session } from "../session/session.js";
import type { ClientState, ServerConfig } from "../types/index.js";
import { findSessionByTranscript } from "../utils/find-session.js";
import { listProjectSessions } from "../utils/project-sessions.js";
import type { HooksService } from "./hooks.service.js";
import { LoggerService } from "./logger.service.js";
import { modelCatalog } from "./model-catalog.service.js";
import { buildPlanKeystrokes } from "./plan.input.js";
import { buildKeystrokes } from "./question.input.js";
import type { SessionBus, SessionBusEvent } from "./session-bus.service.js";
import type { SessionManager } from "./session-manager.service.js";

const log = LoggerService.scoped("ws");

const clients = new Map<WebSocket, ClientState>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Cached for a short TTL — `list_dirs` fires for every breadcrumb click and
// folder browse, and a fresh walk + read on each call is wasted work.
const GITIGNORE_CACHE_TTL_MS = 30_000;
type CachedMatcher = { matcher: Ignore; repoRoot: string } | null;
const gitignoreCache = new Map<string, { value: CachedMatcher; expiresAt: number }>();

// Returns null when `dirPath` is outside any git repo — we don't filter then.
function buildGitignoreMatcher(dirPath: string): CachedMatcher {
  const key = resolve(dirPath);
  const now = Date.now();
  const cached = gitignoreCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = computeGitignoreMatcher(key);
  gitignoreCache.set(key, { value, expiresAt: now + GITIGNORE_CACHE_TTL_MS });
  return value;
}

function computeGitignoreMatcher(start: string): CachedMatcher {
  let dir = start;
  const ignores: Array<{ dir: string; content: string }> = [];
  let repoRoot: string | null = null;
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      repoRoot = dir;
      const gi = join(dir, ".gitignore");
      if (existsSync(gi)) ignores.unshift({ dir, content: safeRead(gi) });
      break;
    }
    const gi = join(dir, ".gitignore");
    if (existsSync(gi)) ignores.unshift({ dir, content: safeRead(gi) });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!repoRoot) return null;
  const matcher = ignore();
  for (const { dir: gd, content } of ignores) {
    const prefix = relative(repoRoot, gd).replace(/\\/g, "/");
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const line of lines) {
      const pat = prefix && !line.startsWith("/") ? `${prefix}/${line}` : line;
      matcher.add(pat);
    }
  }
  return { matcher, repoRoot };
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function listChildEntries(dirPath: string, workDir: string): DirEntry[] {
  const resolved = resolve(dirPath);
  const normalizedWork = normalize(workDir);
  if (!resolved.startsWith(normalizedWork)) {
    return [];
  }
  const gi = buildGitignoreMatcher(resolved);
  try {
    return readdirSync(resolved, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .filter((d) => {
        if (!gi) return true;
        const full = resolve(resolved, d.name);
        const rel = relative(gi.repoRoot, full).split(sep).join("/");
        if (!rel || rel.startsWith("..")) return true;
        // `ignore` needs a trailing slash for dirs to match dir-only rules.
        return !gi.matcher.ignores(d.isDirectory() ? `${rel}/` : rel);
      })
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

/**
 * Translate a SessionBusEvent into the corresponding WsMessage envelope.
 *
 * Returns null for events that are internal to the backend and have no client
 * counterpart — `model_switch` drives `Session`'s stored alias, and the result
 * already reaches the client as `session_metadata`, so forwarding it too would
 * be redundant and would need a protocol addition the frontend doesn't use.
 */
function busEventToMessage(event: SessionBusEvent): ServerMessage | null {
  switch (event.kind) {
    case "model_switch":
      return null;
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
        ...(event.agent ? { agent: event.agent } : {}),
      };
    case "permission_mode":
      // A mode we don't model (`dontAsk`, `bypassPermissions`) is never sent:
      // the client could neither label it nor cycle away from it. `Session`
      // logs and ignores the same value on its own mirror.
      if (!isPermissionMode(event.mode)) return null;
      return {
        type: "permission_mode",
        sessionId: event.sessionId,
        mode: event.mode,
      };
    case "compact_start":
      return {
        type: "compact_start",
        sessionId: event.sessionId,
        trigger: event.trigger,
        timestamp: event.timestamp,
      };
    case "compact_end":
      return {
        type: "compact_end",
        sessionId: event.sessionId,
        trigger: event.trigger,
      };
    case "compact_summary":
      return {
        type: "compact_summary",
        sessionId: event.sessionId,
        text: event.text,
        timestamp: event.timestamp,
      };
    case "slash_command":
      return {
        type: "slash_command",
        sessionId: event.sessionId,
        name: event.name,
        args: event.args,
        output: event.output,
        timestamp: event.timestamp,
      };
    case "interrupt":
      return {
        type: "interrupt",
        sessionId: event.sessionId,
        timestamp: event.timestamp,
      };
  }
}

const INITIAL_REPLAY = 20;

function closeAgentSubs(state: ClientState): void {
  for (const cleanup of state.agentSubs.values()) cleanup();
  state.agentSubs.clear();
}

/**
 * Resolve the bus behind a history request. An agent stream id names a virtual
 * session, so its bus lives in the owning session's agent registry rather than
 * in the session manager.
 */
function busForHistory(sessionManager: SessionManager, id: string): SessionBus | null {
  const session = sessionManager.get(id);
  if (session) return session.bus;
  const agent = parseAgentStreamId(id);
  if (!agent) return null;
  const owner = sessionManager.get(agent.sessionId);
  return owner?.resolved ? owner.agents.peekAgentBus(agent.agentId) : null;
}

/** Tell the viewer an agent stream cannot be served, so it stops waiting for one. */
function sendAgentUnavailable(
  ws: WebSocket,
  streamId: string,
  reason: "unknown_agent" | "transcript_missing" | "failed",
  message: string,
): void {
  send(ws, { type: "agent_unavailable", sessionId: streamId, reason, message });
}

/**
 * Attach a client to one agent's transcript. Read-only: the stream carries the
 * same events a session does, addressed by the agent's stream id.
 */
function subscribeToAgent(ws: WebSocket, session: Session, agentId: string): void {
  const state = clients.get(ws);
  if (!state) return;
  const streamId = agentStreamId(session.id, agentId);
  state.agentSubs.get(streamId)?.();

  let cancelled = false;
  let detach = () => {};
  state.agentSubs.set(streamId, () => {
    cancelled = true;
    detach();
  });

  void session.agents
    .getAgentBus(agentId)
    .then((bus) => {
      if (cancelled) return;
      if (!bus) {
        // Say why rather than send an empty history, which the viewer cannot
        // tell apart from an agent that simply has not written anything yet.
        if (session.agents.hasAgent(agentId)) {
          log.info("Agent transcript unavailable", { sessionId: session.id, agentId });
          sendAgentUnavailable(
            ws,
            streamId,
            "transcript_missing",
            "This agent's transcript file was not found.",
          );
        } else {
          log.info("Subscribe for an unknown agent", { sessionId: session.id, agentId });
          sendAgentUnavailable(ws, streamId, "unknown_agent", "This agent is not known.");
        }
        return;
      }
      const total = bus.getEventLogSize();
      const startIdx = Math.max(0, total - INITIAL_REPLAY);
      for (const event of bus.getEventLogSlice(startIdx, total)) {
        const msg = busEventToMessage(event);
        if (msg) send(ws, msg);
      }
      send(ws, {
        type: "history_available",
        sessionId: streamId,
        earliestIndex: startIdx,
        hasMore: startIdx > 0,
      });
      const onEvent = (event: SessionBusEvent) => {
        const msg = busEventToMessage(event);
        if (msg) send(ws, msg);
      };
      bus.on("event", onEvent);
      detach = () => bus.off("event", onEvent);
    })
    .catch((err) => {
      log.error("Agent subscribe failed", {
        agentId,
        error: (err as Error).stack ?? (err as Error).message,
      });
      if (!cancelled) {
        sendAgentUnavailable(ws, streamId, "failed", "Loading this agent's transcript failed.");
      }
    });
}

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
    const msg = busEventToMessage(event);
    if (msg) send(ws, msg);
  }
  send(ws, {
    type: "history_available",
    sessionId: session.id,
    earliestIndex: startIdx,
    hasMore: startIdx > 0,
  });

  const onEvent = (event: SessionBusEvent) => {
    const msg = busEventToMessage(event);
    if (msg) send(ws, msg);
  };
  const onExit = () => {
    send(ws, {
      type: "session_stopped",
      sessionId: session.id,
      exitCode: null,
    });
  };
  const onMetadataChanged = () => {
    const info = session.getInfo();
    if (info) send(ws, { type: "session_metadata", session: info });
  };
  const onStatusLine = (text: string) => {
    send(ws, { type: "status_line", sessionId: session.id, text });
  };
  const agents = session.agents;
  const onAgentUpdate = (agent: AgentNode) => {
    send(ws, { type: "agent_update", sessionId: session.id, agent });
  };
  const onAgentMessage = (message: AgentMessage) => {
    send(ws, { type: "agent_message", sessionId: session.id, message });
  };

  bus.on("event", onEvent);
  session.on("exit", onExit);
  session.on("metadataChanged", onMetadataChanged);
  session.on("statusLine", onStatusLine);
  agents.on("update", onAgentUpdate);
  agents.on("message", onAgentMessage);

  state.subscribedSessionId = session.id;
  state.cleanup = () => {
    bus.off("event", onEvent);
    session.off("exit", onExit);
    session.off("metadataChanged", onMetadataChanged);
    session.off("statusLine", onStatusLine);
    agents.off("update", onAgentUpdate);
    agents.off("message", onAgentMessage);
    closeAgentSubs(state);
  };

  // The agent tree, rebuilt from disk so a session resumed after its agents
  // finished still shows them. Sent after the listeners are attached so an
  // update racing the snapshot is not lost (a duplicate is harmless: updates
  // carry whole nodes). Sent even when empty, so a reconnect clears agents the
  // client still remembers from before.
  send(ws, { type: "agents_snapshot", sessionId: session.id, ...agents.getSnapshot() });

  // Replay the latest status line so reconnecting clients see it immediately.
  const cachedStatus = session.getStatusLine();
  if (cachedStatus) send(ws, { type: "status_line", sessionId: session.id, text: cachedStatus });

  const info = session.getInfo();
  if (info) send(ws, { type: "session_metadata", session: info });
}

function broadcast(msg: ServerMessage): void {
  for (const ws of clients.keys()) send(ws, msg);
}

export function broadcastSessionCreated(session: SessionInfo): void {
  broadcast({ type: "session_created", session });
}

// Every client keeps the picker's learned aliases and family hints current.
modelCatalog.on("changed", () => {
  broadcast({ type: "model_catalog", catalog: modelCatalog.snapshot() });
});

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
      void (async () => {
        if (msg.settings) await session.respawn(msg.settings);
        await session.sendInput(msg.text);
      })().catch((err) => {
        log.error("Input dispatch failed", {
          sessionId: msg.sessionId,
          error: (err as Error).message,
        });
      });
      return;
    }

    case "slash_command": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      log.debug("Slash command", {
        sessionId: msg.sessionId,
        command: msg.command,
      });
      void (async () => {
        if (msg.settings) await session.respawn(msg.settings);
        await session.sendSlashCommand(msg.command);
      })().catch((err) => {
        log.error("Slash command dispatch failed", {
          sessionId: msg.sessionId,
          error: (err as Error).message,
        });
      });
      return;
    }

    case "interrupt": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      log.debug("Interrupt", { sessionId: msg.sessionId });
      session.interrupt();
      return;
    }

    case "unsubscribe": {
      const state = clients.get(ws);
      if (!state) return;
      if (state.subscribedSessionId !== msg.sessionId) return;
      log.info("Client unsubscribing from session", { sessionId: msg.sessionId });
      state.cleanup?.();
      state.subscribedSessionId = null;
      state.cleanup = null;
      return;
    }

    case "update_global_setting": {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      // Fan a `slash_command` bubble onto every active session's bus so the
      // change is visible in each stream (and survives reload). The origin
      // gets the primary "applied to N sessions" message; siblings get the
      // "applied from another session" hint so the user understands why
      // their model/effort changed without them touching the popover.
      const active = sessionManager.list().filter((s: SessionInfo) => s.status !== "stopped");
      const word = active.length === 1 ? "session" : "sessions";
      const slashName = msg.key === "effortLevel" ? "/effort" : "/model";
      const ts = new Date().toISOString();
      for (const info of active) {
        const session = sessionManager.get(info.id);
        if (!session?.resolved) continue;
        const isOrigin = info.id === msg.originSessionId;
        session.bus.push({
          kind: "slash_command",
          sessionId: info.id,
          timestamp: ts,
          name: slashName,
          args: msg.value,
          output: isOrigin
            ? `applied to ${active.length} active ${word} and saved as global default`
            : "applied from another session",
        });
      }
      void (async () => {
        const raw = await readFile(settingsPath, "utf8").catch(() => "{}");
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          log.warn("Could not parse settings.json — refusing to overwrite", {
            error: (err as Error).message,
          });
          return;
        }
        parsed[msg.key] = msg.value;
        await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        log.info("Updated global setting", { key: msg.key, value: msg.value });
      })().catch((err) => {
        log.warn("Failed to update global setting", {
          key: msg.key,
          error: (err as Error).message,
        });
      });
      return;
    }

    case "approval_response": {
      const ok = hooksService.resolveApproval(
        msg.sessionId,
        msg.toolUseId,
        msg.decision,
        msg.reason,
        msg.updatedInput,
      );
      if (!ok) {
        log.warn("No pending approval to resolve", {
          sessionId: msg.sessionId,
          toolUseId: msg.toolUseId,
        });
      }
      return;
    }

    case "question_response": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) {
        send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: "Session not found",
        });
        return;
      }
      const { chunks } = buildKeystrokes({
        questions: msg.questions ?? [],
        answers: msg.answers ?? [],
        cancel: msg.cancel,
      });
      if (chunks.length === 0) {
        // A non-cancel answer that resolved to no keystrokes (e.g. labels that
        // matched no option) would otherwise leave the card locked forever.
        // Surface it so the card unlocks and the input bar returns.
        log.warn("Empty keystroke script — nothing to send", {
          sessionId: msg.sessionId,
          toolUseId: msg.toolUseId,
        });
        if (!msg.cancel)
          session.failQuestion(msg.toolUseId, "Couldn't build keystrokes for this answer.");
        return;
      }
      // Drive the picker with the paced keystroke script. For a normal submit
      // the session confirms the answer registered in the transcript and
      // resends Enter if the multi-select submit raced ink's focus flush. Cancel
      // is a terminal footer action — don't resend Enter into it.
      void session.answerQuestion(chunks, !msg.cancel, msg.toolUseId).catch((err) => {
        log.error("Question answer dispatch failed", {
          sessionId: msg.sessionId,
          error: (err as Error).message,
        });
        // Don't leave the card locked on a dispatch error.
        if (!msg.cancel)
          session.failQuestion(msg.toolUseId, "Failed to deliver answer to the CLI.");
      });
      return;
    }

    case "plan_response": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) {
        send(ws, { type: "error", sessionId: msg.sessionId, message: "Session not found" });
        return;
      }
      const { chunks } = buildPlanKeystrokes({
        decision: msg.decision,
        cancel: msg.cancel,
      });
      if (chunks.length === 0) {
        if (!msg.cancel)
          session.failPlan(msg.toolUseId, "Couldn't build keystrokes for this plan response.");
        return;
      }
      // The mode the picker exits into on approval — set optimistically once the
      // approval confirms so the top bar updates immediately. `approve-primary`
      // is the elevated keep-context approve at picker position 1: "use auto
      // mode" when the running model supports it (→ auto), else "auto-accept
      // edits" (→ acceptEdits). `approve-manual` → default. Cancel stays in plan.
      // `cycleCanIncludeAuto` decides which of the two this is, so it has to be
      // right about the *running* model — see its docblock. The JSONL
      // permission-mode entry eventually agrees, but only at the next
      // session-metadata block, so it is not a prompt correction. For a model
      // whose cycle is unverified we do not guess: no optimistic mode is noted
      // and the JSONL entry is left to report it.
      const autoSupport = autoCycleSupport(session.model);
      const resultingMode: PermissionMode | undefined = msg.cancel
        ? undefined
        : msg.decision === "approve-primary"
          ? autoSupport === null
            ? undefined
            : autoSupport
              ? "auto"
              : "acceptEdits"
          : "default";
      // Drive the ink plan picker with the keystroke script and confirm via the
      // tool_result for this toolUseId. Cancel (Esc) is terminal — no confirm.
      void session.answerPlan(chunks, !msg.cancel, msg.toolUseId, resultingMode).catch((err) => {
        log.error("Plan response dispatch failed", {
          sessionId: msg.sessionId,
          error: (err as Error).message,
        });
        if (!msg.cancel)
          session.failPlan(msg.toolUseId, "Failed to deliver plan response to the CLI.");
      });
      return;
    }

    case "set_pending_model": {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      // The type is open, so the wire value is checked by shape before it can
      // reach `--model` (or be learned as an alias).
      if (typeof msg.model !== "string" || !isClaudeModel(msg.model)) {
        send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: `Not a model alias or id: ${String(msg.model)}`,
        });
        return;
      }
      session.setPendingModel(msg.model, msg.effort);
      return;
    }

    case "create_session": {
      log.info("Creating session", { config: msg.config });
      let session: Session;
      try {
        session = sessionManager.create(msg.config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Session creation failed", { error: message });
        send(ws, { type: "error", message: `Couldn't create session: ${message}` });
        return;
      }
      // Wait for Claude Code's session id to resolve (and initial transcript
      // drain on resume) before broadcasting — clients need the real id.
      void session.ready.then(
        () => {
          const info = session.getInfo();
          if (info) broadcastSessionCreated(info);
          subscribeToSession(ws, session);
        },
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Session never became ready", { error: message });
          send(ws, { type: "error", message: `Session crashed during startup: ${message}` });
        },
      );
      // Effort is set via CLAUDE_CODE_EFFORT_LEVEL env on spawn (see
      // pty.service.ts) — no need for a post-spawn /effort slash command.
      return;
    }

    case "stop_session": {
      log.info("Stopping session", { sessionId: msg.sessionId });
      sessionManager.stop(msg.sessionId);
      return;
    }

    case "subscribe": {
      const session = sessionManager.get(msg.sessionId);
      if (session) {
        void session.ready.then(() => subscribeToSession(ws, session));
        return;
      }
      // Unknown session — three fallback paths, in order of fidelity:
      //   1. Client passed `resumeConfig` from localStorage → use it.
      //   2. Scan `~/.claude/projects/*` for a transcript with this id and
      //      auto-resume using the recovered cwd + sane defaults. This is the
      //      "open /session/<id> directly" path.
      //   3. Genuinely unknown id → 404 the client.
      void (async () => {
        if (msg.resumeConfig) {
          log.info("Auto-resuming session (client config)", {
            id: msg.sessionId,
            cwd: msg.resumeConfig.cwd,
          });
          const created = sessionManager.create({
            ...msg.resumeConfig,
            resumeSessionId: msg.sessionId,
          });
          await created.ready;
          const info = created.getInfo();
          if (info) broadcastSessionCreated(info);
          subscribeToSession(ws, created);
          return;
        }
        const found = await findSessionByTranscript(msg.sessionId);
        if (found) {
          log.info("Auto-resuming session (disk discovery)", {
            id: msg.sessionId,
            cwd: found.cwd,
          });
          const created = sessionManager.create({
            // Placeholder alias only — on resume the PTY omits `--model`, so the
            // session keeps its real model from the JSONL, and the backend
            // reconciles `currentModel` from the runtime within a turn. (The
            // "open /session/<id> directly" path has no localStorage config.)
            cwd: found.cwd,
            model: "sonnet",
            permissionMode: "default",
            resumeSessionId: msg.sessionId,
          });
          await created.ready;
          const info = created.getInfo();
          if (info) broadcastSessionCreated(info);
          subscribeToSession(ws, created);
          return;
        }
        send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: "Session not found",
          code: "session_not_found",
        });
      })().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Subscribe fallback failed", { id: msg.sessionId, error: message });
        send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: `Subscribe failed: ${message}`,
        });
      });
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

    case "set_permission_mode": {
      const session = sessionManager.get(msg.sessionId);
      if (session?.setPermissionMode(msg.mode) === "unverified") {
        send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          code: "permission_mode_unverified",
          message: "Mode switching isn't verified for this model yet.",
        });
      }
      return;
    }

    case "subscribe_agent": {
      const session = sessionManager.get(msg.sessionId);
      if (!session?.resolved) {
        log.info("subscribe_agent for a session that is not available", {
          sessionId: msg.sessionId,
        });
        sendAgentUnavailable(
          ws,
          agentStreamId(msg.sessionId, msg.agentId),
          "unknown_agent",
          "This session is not running.",
        );
        return;
      }
      subscribeToAgent(ws, session, msg.agentId);
      return;
    }

    case "unsubscribe_agent": {
      const state = clients.get(ws);
      const streamId = agentStreamId(msg.sessionId, msg.agentId);
      state?.agentSubs.get(streamId)?.();
      state?.agentSubs.delete(streamId);
      return;
    }

    case "fetch_history": {
      const bus = busForHistory(sessionManager, msg.sessionId);
      if (!bus) {
        // An agent whose transcript is not being tailed has no history to page
        // through. Answer with an empty page so the viewer stops showing
        // "loading earlier messages" and does not ask again.
        if (parseAgentStreamId(msg.sessionId)) {
          send(ws, {
            type: "history_page",
            sessionId: msg.sessionId,
            events: [],
            fromIndex: 0,
            hasMore: false,
          });
        }
        return;
      }
      const total = bus.getEventLogSize();
      const end = Math.min(total, Math.max(0, msg.beforeIndex));
      const limit = Math.max(1, Math.min(100, msg.limit));
      const start = Math.max(0, end - limit);
      const events = bus
        .getEventLogSlice(start, end)
        .map(busEventToMessage)
        .filter((m): m is ServerMessage => m !== null);
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
  clients.set(ws, { subscribedSessionId: null, cleanup: null, agentSubs: new Map() });

  log.info("Client connected");

  send(ws, {
    type: "connected",
    sessions: sessionManager.list(),
    workDir: config.workDir,
  });
  send(ws, { type: "model_catalog", catalog: modelCatalog.snapshot() });

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
    if (state) closeAgentSubs(state);
    clients.delete(ws);
  });
}
