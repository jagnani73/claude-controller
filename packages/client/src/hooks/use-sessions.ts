import { wsService } from "@/services/ws.service";
import type {
    ClaudeModel,
    DirListData,
    EffortLevel,
    PermissionMode,
    SessionInfo,
} from "common/types";
import { useCallback, useState } from "react";
import { useWsMessage } from "./use-ws";

export function useSessions() {
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [workDir, setWorkDir] = useState<string>("");

    useWsMessage("connected", (msg) => {
        const data = msg.data as { sessions: SessionInfo[]; workDir: string };
        setSessions(data.sessions);
        if (data.workDir) setWorkDir(data.workDir);
    });

    useWsMessage("session_metadata", (msg) => {
        const info = msg.data as SessionInfo;
        setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === info.id);
            if (idx >= 0) {
                const next = [...prev];
                next[idx] = info;
                return next;
            }
            return [...prev, info];
        });
    });

    useWsMessage("disconnected", (msg) => {
        if (msg.sessionId) {
            setSessions((prev) =>
                prev.map((s) =>
                    s.id === msg.sessionId
                        ? { ...s, status: "stopped" as const }
                        : s,
                ),
            );
        }
    });

    const createSession = useCallback(
        (config: {
            cwd: string;
            model: ClaudeModel;
            permissionMode: PermissionMode;
            effort?: EffortLevel;
            name?: string;
        }) => {
            wsService.send({
                type: "command",
                data: { action: "create_session", config },
                timestamp: Date.now(),
            });
        },
        [],
    );

    const stopSession = useCallback((sessionId: string) => {
        wsService.send({
            type: "command",
            data: { action: "stop_session", sessionId },
            timestamp: Date.now(),
        });
    }, []);

    const subscribe = useCallback((sessionId: string) => {
        setActiveSessionId(sessionId);
        wsService.send({
            type: "command",
            data: { action: "subscribe", sessionId },
            timestamp: Date.now(),
        });
    }, []);

    const unsubscribe = useCallback(() => {
        setActiveSessionId(null);
    }, []);

    const activeSession =
        sessions.find((s) => s.id === activeSessionId) ?? null;

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
    const [dirs, setDirs] = useState<string[]>([]);

    useWsMessage("dir_list", (msg) => {
        const data = msg.data as DirListData;
        setCurrentPath(data.path);
        setDirs(data.dirs);
    });

    const browse = useCallback((path?: string) => {
        wsService.send({
            type: "command",
            data: { action: "list_dirs", path },
            timestamp: Date.now(),
        });
    }, []);

    return { currentPath, dirs, browse };
}
