import { wsService } from "@/services/ws.service";
import type { ClaudeModel, PermissionMode, SessionInfo } from "common/types";
import { useCallback, useState } from "react";
import { useWsMessage } from "./use-ws";

export function useSessions() {
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

    useWsMessage("connected", (msg) => {
        const data = msg.data as { sessions: SessionInfo[] };
        setSessions(data.sessions);
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
        createSession,
        stopSession,
        subscribe,
        unsubscribe,
    };
}
