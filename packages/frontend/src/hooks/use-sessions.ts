import type { DirEntry, SessionConfig, SessionInfo } from "common/types";
import { useCallback, useState } from "react";
import { wsService } from "@/services/ws.service";
import { useWsMessage } from "./use-ws";

export function useSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [workDir, setWorkDir] = useState<string>("");

  useWsMessage("connected", (msg) => {
    setSessions(msg.sessions);
    if (msg.workDir) setWorkDir(msg.workDir);
  });

  useWsMessage("session_created", (msg) => {
    setSessions((prev) => {
      if (prev.some((s) => s.id === msg.session.id)) return prev;
      return [...prev, msg.session];
    });
  });

  useWsMessage("session_stopped", (msg) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === msg.sessionId ? { ...s, status: "stopped" } : s)),
    );
  });

  useWsMessage("session_metadata", (msg) => {
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

  const createSession = useCallback((config: SessionConfig) => {
    wsService.send({ type: "create_session", config });
  }, []);

  const stopSession = useCallback((sessionId: string) => {
    wsService.send({ type: "stop_session", sessionId });
  }, []);

  const subscribe = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    wsService.send({ type: "subscribe", sessionId });
  }, []);

  const unsubscribe = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  return {
    sessions,
    activeSession,
    activeSessionId,
    workDir,
    createSession,
    stopSession,
    subscribe,
    unsubscribe,
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
