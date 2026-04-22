import type {
  ClaudeModel,
  DirEntry,
  EffortLevel,
  ProjectSessionSummary,
  SessionConfig,
  SessionInfo,
} from "common/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { wsService } from "@/services/ws.service";
import { useWsMessage } from "./use-ws";

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

export function useSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workDir, setWorkDir] = useState<string>("");
  const pendingCreate = useRef<((s: SessionInfo) => void) | null>(null);

  useWsMessage("connected", (msg) => {
    setSessions(msg.sessions);
    if (msg.workDir) setWorkDir(msg.workDir);
    for (const s of msg.sessions) persistSessionConfig(s);
  });

  useWsMessage("session_created", (msg) => {
    setSessions((prev) => {
      if (prev.some((s) => s.id === msg.session.id)) return prev;
      return [...prev, msg.session];
    });
    persistSessionConfig(msg.session);
    const resolver = pendingCreate.current;
    if (resolver) {
      pendingCreate.current = null;
      resolver(msg.session);
    }
  });

  useWsMessage("session_stopped", (msg) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === msg.sessionId ? { ...s, status: "stopped" } : s)),
    );
  });

  useWsMessage("session_metadata", (msg) => {
    persistSessionConfig(msg.session);
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === msg.session.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = msg.session;
        return next;
      }
      return [...prev, msg.session];
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

  const cyclePermissionMode = useCallback((sessionId: string) => {
    wsService.send({ type: "cycle_permission_mode", sessionId });
  }, []);

  const setModel = useCallback((sessionId: string, model: ClaudeModel) => {
    wsService.send({ type: "set_model", sessionId, model });
  }, []);

  const setEffort = useCallback((sessionId: string, effort: EffortLevel) => {
    wsService.send({ type: "set_effort", sessionId, effort });
  }, []);

  /** Send create_session and resolve with the new SessionInfo once the server broadcasts. */
  const createSession = useCallback((config: SessionConfig): Promise<SessionInfo> => {
    return new Promise<SessionInfo>((resolve) => {
      pendingCreate.current = resolve;
      wsService.send({ type: "create_session", config });
    });
  }, []);

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
    cyclePermissionMode,
    setModel,
    setEffort,
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
