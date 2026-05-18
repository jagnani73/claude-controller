import type {
  ClaudeModel,
  DirEntry,
  EffortLevel,
  PermissionMode,
  ProjectSessionSummary,
  RespawnSettings,
  SessionConfig,
  SessionInfo,
} from "common/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { clampEffort, clampPermissionMode } from "@/components/sessions/model-config";
import {
  PERMISSION_CYCLE,
  PERMISSION_CYCLE_STEP_MS,
} from "@/components/sessions/permission-config";
import { wsService } from "@/services/ws.service";
import { useWsMessage } from "./use-ws";

/**
 * Slash commands whose Claude Code native handlers conflict with our
 * per-session env-based settings: `/effort` and `/model` write to the
 * GLOBAL `~/.claude/settings.json`, then collide with our env var
 * (CLAUDE_CODE_EFFORT_LEVEL wins → user sees the "overrides this session"
 * warning). Intercept them in submitInput and route through updateSettings
 * so the change is per-session and applied via respawn on next message.
 */
const EFFORT_SLASH_RE = /^\/effort\s+(auto|low|medium|high|xhigh|max)\s*$/i;
const MODEL_SLASH_RE =
  /^\/model\s+(opus|opus\[1m\]|opusplan|sonnet|sonnet\[1m\]|haiku)\s*$/i;

function parseSettingsSlash(text: string): SettingsPatch | null {
  const trimmed = text.trim();
  const effort = trimmed.match(EFFORT_SLASH_RE);
  if (effort) return { effort: effort[1].toLowerCase() as EffortLevel };
  const model = trimmed.match(MODEL_SLASH_RE);
  if (model) return { model: model[1].toLowerCase() as ClaudeModel };
  return null;
}

/**
 * Per-session config cache in localStorage. Keyed by the Claude Code session
 * id so a page refresh (or backend restart) can re-send the settings needed
 * to `--resume` the session on the backend.
 */
const SESSION_CFG_PREFIX = "cc-session-cfg:";

type PersistedConfig = Omit<SessionConfig, "resumeSessionId">;

function persistSessionConfig(s: SessionInfo): void {
  const cfg: PersistedConfig = {
    name: s.name,
    cwd: s.cwd,
    model: s.model,
    permissionMode: s.permissionMode,
    effort: s.effort,
    tags: s.tags,
  };
  try {
    localStorage.setItem(SESSION_CFG_PREFIX + s.id, JSON.stringify(cfg));
  } catch {}
}

function readSessionConfig(sessionId: string): PersistedConfig | null {
  try {
    const raw = localStorage.getItem(SESSION_CFG_PREFIX + sessionId);
    return raw ? (JSON.parse(raw) as PersistedConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Apply localStorage's user-set values over backend-supplied SessionInfo when
 * they differ. Backend may be momentarily stale (e.g. user changed model in
 * popover but hasn't sent a message yet, then refreshed) — local intent wins
 * and gets re-applied via the next input's `settings` field.
 */
function mergeWithLocal(s: SessionInfo): SessionInfo {
  const local = readSessionConfig(s.id);
  if (!local) return s;
  return {
    ...s,
    model: local.model,
    effort: local.effort,
    permissionMode: local.permissionMode,
  };
}

interface PendingCreate {
  resolve: (s: SessionInfo) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CREATE_TIMEOUT_MS = 30_000;

export interface SettingsPatch {
  model?: ClaudeModel;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}

export function useSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workDir, setWorkDir] = useState<string>("");
  const pendingCreate = useRef<PendingCreate | null>(null);
  /** Latest sessions reachable from non-React-state callbacks (e.g. send). */
  const sessionsRef = useRef<SessionInfo[]>(sessions);
  /** Pending Shift+Tab cycle keystroke timers, keyed by sessionId. */
  const cycleTimers = useRef<Map<string, ReturnType<typeof setTimeout>[]>>(new Map());

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const settlePending = useCallback((kind: "resolve" | "reject", value: SessionInfo | Error) => {
    const p = pendingCreate.current;
    if (!p) return;
    pendingCreate.current = null;
    clearTimeout(p.timer);
    if (kind === "resolve") p.resolve(value as SessionInfo);
    else p.reject(value as Error);
  }, []);

  const cancelCycle = useCallback((sessionId: string) => {
    const timers = cycleTimers.current.get(sessionId);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    cycleTimers.current.delete(sessionId);
  }, []);

  useWsMessage("connected", (msg) => {
    const merged = msg.sessions.map(mergeWithLocal);
    setSessions(merged);
    if (msg.workDir) setWorkDir(msg.workDir);
    for (const s of merged) persistSessionConfig(s);
  });

  useWsMessage("session_created", (msg) => {
    setSessions((prev) => {
      if (prev.some((s) => s.id === msg.session.id)) return prev;
      return [...prev, msg.session];
    });
    persistSessionConfig(msg.session);
    settlePending("resolve", msg.session);
  });

  useWsMessage("error", (msg) => {
    // Reject any in-flight create_session — error toast is shown at AppShell.
    settlePending("reject", new Error(msg.message));
  });

  useWsMessage("session_stopped", (msg) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === msg.sessionId ? { ...s, status: "stopped" } : s)),
    );
  });

  useWsMessage("session_metadata", (msg) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === msg.session.id);
      if (idx < 0) {
        const merged = mergeWithLocal(msg.session);
        persistSessionConfig(merged);
        return [...prev, merged];
      }
      // Preserve local model/effort — they're user-set values applied via
      // respawn-on-input. Backend echoes its `currentX` here, but in the gap
      // between user click and next message-send the local value is the
      // intent. Permission mode is backend-authoritative (JSONL is source of
      // truth; cycle keystrokes confirm via the `permission_mode` ws message).
      const next = [...prev];
      next[idx] = {
        ...msg.session,
        model: prev[idx].model,
        effort: prev[idx].effort,
      };
      persistSessionConfig(next[idx]);
      return next;
    });
  });

  useWsMessage("permission_mode", (msg) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== msg.sessionId) return s;
        const next = { ...s, permissionMode: msg.mode };
        persistSessionConfig(next);
        return next;
      }),
    );
  });

  /**
   * Atomically apply a partial settings update — model change clamps effort
   * and permission mode if the new model doesn't support the current values
   * (handled upstream in SessionSettingsPanel). Permission-mode changes also
   * walk Claude Code's Shift+Tab cycle so mid-task mode flips take effect on
   * the running PTY without a respawn.
   */
  const updateSettings = useCallback(
    (sessionId: string, patch: SettingsPatch) => {
      let cycleFromTo: { from: PermissionMode; to: PermissionMode } | null = null;
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === sessionId);
        if (idx < 0) return prev;
        const cur = prev[idx];
        const nextModel = patch.model ?? cur.model;
        const nextEffort = patch.effort ?? cur.effort;
        const nextMode = patch.permissionMode ?? cur.permissionMode;
        if (
          nextModel === cur.model &&
          nextEffort === cur.effort &&
          nextMode === cur.permissionMode
        ) {
          return prev;
        }
        if (nextMode !== cur.permissionMode) {
          cycleFromTo = { from: cur.permissionMode, to: nextMode };
        }
        const updated: SessionInfo = {
          ...cur,
          model: nextModel,
          effort: nextEffort,
          permissionMode: nextMode,
        };
        persistSessionConfig(updated);
        const next = [...prev];
        next[idx] = updated;
        return next;
      });

      if (!cycleFromTo) return;
      cancelCycle(sessionId);
      const { from, to } = cycleFromTo;
      const fromIdx = PERMISSION_CYCLE.indexOf(from);
      const toIdx = PERMISSION_CYCLE.indexOf(to);
      if (fromIdx < 0 || toIdx < 0) {
        // Out-of-cycle target (shouldn't happen with current modes) — single nudge.
        wsService.send({ type: "cycle_permission_mode", sessionId });
        return;
      }
      const dist = (toIdx - fromIdx + PERMISSION_CYCLE.length) % PERMISSION_CYCLE.length;
      const timers: ReturnType<typeof setTimeout>[] = [];
      for (let i = 0; i < dist; i++) {
        timers.push(
          setTimeout(() => {
            wsService.send({ type: "cycle_permission_mode", sessionId });
          }, i * PERMISSION_CYCLE_STEP_MS),
        );
      }
      cycleTimers.current.set(sessionId, timers);
    },
    [cancelCycle],
  );

  /**
   * Submit user input to the session, attaching the current settings tuple so
   * the backend can respawn the PTY with the user's latest intent before
   * forwarding. Cancels any in-flight cycle keystrokes — the respawn applies
   * the final permission mode via `--permission-mode`, so stale cycle
   * keystrokes hitting the new PTY would just push it off the intended mode.
   *
   * Optimistically dispatches a local `user_prompt` so the user's message
   * appears instantly. The real event arrives later (after respawn + Claude
   * processing) and the MessageStream reducer dedups by text + sessionId.
   */
  const submitInput = useCallback(
    (sessionId: string, text: string) => {
      const target = sessionsRef.current.find((s) => s.id === sessionId);
      if (!target) return;
      cancelCycle(sessionId);

      // Intercept `/effort` and `/model`. Claude Code's native handlers write
      // to ~/.claude/settings.json AND collide with our per-session env var
      // (CLAUDE_CODE_EFFORT_LEVEL wins → "overrides this session" warning).
      // Mirror the *intent* (global write + cross-session propagation) without
      // the conflict: update every active session's local settings (popover +
      // top bar reflect it via SessionInfo state), and send a single WS message
      // so the backend persists settings.json and pushes a notification bubble
      // onto each session's bus.
      const settingsPatch = parseSettingsSlash(text);
      if (settingsPatch) {
        const alive = sessionsRef.current.filter((s) => s.status !== "stopped");
        for (const s of alive) {
          const clamped: SettingsPatch = { ...settingsPatch };
          if (settingsPatch.model) {
            clamped.effort = clampEffort(settingsPatch.model, s.effort);
            clamped.permissionMode = clampPermissionMode(
              settingsPatch.model,
              s.permissionMode,
            );
          } else if (settingsPatch.effort) {
            clamped.effort = clampEffort(s.model, settingsPatch.effort);
          }
          updateSettings(s.id, clamped);
        }
        if (settingsPatch.effort) {
          wsService.send({
            type: "update_global_setting",
            key: "effortLevel",
            value: settingsPatch.effort,
            originSessionId: sessionId,
          });
        } else if (settingsPatch.model) {
          wsService.send({
            type: "update_global_setting",
            key: "model",
            value: settingsPatch.model,
            originSessionId: sessionId,
          });
        }
        return;
      }

      const settings: RespawnSettings = {
        model: target.model,
        effort: target.effort,
        permissionMode: target.permissionMode,
      };
      if (text.startsWith("/")) {
        wsService.send({ type: "slash_command", sessionId, command: text, settings });
        return;
      }
      // No optimistic dispatch — the frontend queue (in SessionView) draws
      // the in-flight bubble itself until the bus echo arrives.
      wsService.send({ type: "input", sessionId, text, settings });
    },
    [cancelCycle, updateSettings],
  );

  /** Send create_session and resolve with the new SessionInfo once the server broadcasts. */
  const createSession = useCallback(
    (config: SessionConfig): Promise<SessionInfo> => {
      return new Promise<SessionInfo>((resolve, reject) => {
        // Reject any prior in-flight create — only one can be pending at a time.
        if (pendingCreate.current) {
          settlePending("reject", new Error("Replaced by a newer create_session"));
        }
        const timer = setTimeout(() => {
          settlePending("reject", new Error("Session creation timed out"));
        }, CREATE_TIMEOUT_MS);
        pendingCreate.current = { resolve, reject, timer };
        wsService.send({ type: "create_session", config });
      });
    },
    [settlePending],
  );

  const stopSession = useCallback((sessionId: string) => {
    wsService.send({ type: "stop_session", sessionId });
  }, []);

  const subscribe = useCallback((sessionId: string) => {
    const resumeConfig = readSessionConfig(sessionId) ?? undefined;
    wsService.send({ type: "subscribe", sessionId, resumeConfig });
  }, []);

  return {
    sessions,
    workDir,
    createSession,
    stopSession,
    subscribe,
    updateSettings,
    submitInput,
  };
}

export function useDirBrowser() {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[]>([]);

  useWsMessage("dir_list", (msg) => {
    setCurrentPath(msg.path);
    setEntries(msg.entries);
  });

  const browse = useCallback((path: string) => {
    wsService.send({ type: "list_dirs", path });
  }, []);

  return { currentPath, entries, browse };
}

const PROJECT_PAGE_SIZE = 20;

const projectSessionsKey = (cwd: string | null, query: string) => `${cwd ?? ""}::${query}`;

/**
 * Paginated, searchable list of past transcripts for a cwd.
 * - Resets whenever `cwd` or `query` changes
 * - `loadMore()` appends the next page
 */
export function useProjectSessions(cwd: string | null, query: string) {
  const [sessions, setSessions] = useState<ProjectSessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const currentKey = useRef<string>("");

  useWsMessage("project_sessions", (msg) => {
    if (projectSessionsKey(msg.cwd, msg.query) !== currentKey.current) return;
    setSessions((prev) => {
      if (msg.offset === 0) return msg.sessions;
      // append — dedup by id in case of reorderings
      const seen = new Set(prev.map((s) => s.id));
      return [...prev, ...msg.sessions.filter((s) => !seen.has(s.id))];
    });
    setTotal(msg.total);
    setLoading(false);
    setExhausted(msg.offset + msg.sessions.length >= msg.total);
  });

  useEffect(() => {
    const key = projectSessionsKey(cwd, query);
    currentKey.current = key;
    if (!cwd) {
      setSessions([]);
      setTotal(0);
      setExhausted(false);
      setLoading(false);
      return;
    }
    setSessions([]);
    setTotal(0);
    setExhausted(false);
    setLoading(true);
    wsService.send({
      type: "list_project_sessions",
      cwd,
      offset: 0,
      limit: PROJECT_PAGE_SIZE,
      query: query || undefined,
    });
  }, [cwd, query]);

  const loadMore = useCallback(() => {
    if (!cwd || loading || exhausted) return;
    setLoading(true);
    wsService.send({
      type: "list_project_sessions",
      cwd,
      offset: sessions.length,
      limit: PROJECT_PAGE_SIZE,
      query: query || undefined,
    });
  }, [cwd, query, sessions.length, loading, exhausted]);

  return { sessions, total, loading, exhausted, loadMore };
}
