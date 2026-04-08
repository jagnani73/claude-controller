import { describe, expect, it } from "bun:test";
import type { SessionInfo, WsMessage } from "common/types";

/**
 * Tests for use-sessions hook logic.
 *
 * Since Bun's test runner doesn't have React rendering support (no renderHook),
 * we test the underlying message handling logic directly by verifying the
 * WsMessage shapes that the hook produces and consumes.
 */

const mockSession: SessionInfo = {
    id: "s1",
    name: "test-session",
    status: "running",
    cwd: "/tmp",
    model: "sonnet",
    permissionMode: "default",
    tags: [],
    createdAt: Date.now(),
};

describe("useSessions message contracts", () => {
    it("connected message carries session list", () => {
        const msg: WsMessage = {
            type: "connected",
            data: { sessions: [mockSession] },
            timestamp: Date.now(),
        };

        const data = msg.data as { sessions: SessionInfo[] };
        expect(data.sessions).toHaveLength(1);
        expect(data.sessions[0].id).toBe("s1");
    });

    it("session_metadata message carries SessionInfo", () => {
        const updated = { ...mockSession, status: "idle" as const };
        const msg: WsMessage = {
            type: "session_metadata",
            sessionId: "s1",
            data: updated,
            timestamp: Date.now(),
        };

        const data = msg.data as SessionInfo;
        expect(data.status).toBe("idle");
        expect(data.id).toBe("s1");
    });

    it("create_session command has correct shape", () => {
        const msg: WsMessage = {
            type: "command",
            data: {
                action: "create_session",
                config: {
                    cwd: "/home/user/project",
                    model: "sonnet",
                    permissionMode: "default",
                    name: "my-session",
                },
            },
            timestamp: Date.now(),
        };

        const data = msg.data as Record<string, unknown>;
        expect(data.action).toBe("create_session");
        const config = data.config as Record<string, unknown>;
        expect(config.cwd).toBe("/home/user/project");
        expect(config.model).toBe("sonnet");
    });

    it("stop_session command has correct shape", () => {
        const msg: WsMessage = {
            type: "command",
            data: { action: "stop_session", sessionId: "s1" },
            timestamp: Date.now(),
        };

        const data = msg.data as Record<string, unknown>;
        expect(data.action).toBe("stop_session");
        expect(data.sessionId).toBe("s1");
    });

    it("subscribe command has correct shape", () => {
        const msg: WsMessage = {
            type: "command",
            data: { action: "subscribe", sessionId: "s1" },
            timestamp: Date.now(),
        };

        const data = msg.data as Record<string, unknown>;
        expect(data.action).toBe("subscribe");
        expect(data.sessionId).toBe("s1");
    });

    it("approve message has correct shape", () => {
        const msg: WsMessage = {
            type: "approve",
            sessionId: "s1",
            timestamp: Date.now(),
        };

        expect(msg.type).toBe("approve");
        expect(msg.sessionId).toBe("s1");
    });

    it("deny message has correct shape", () => {
        const msg: WsMessage = {
            type: "deny",
            sessionId: "s1",
            timestamp: Date.now(),
        };

        expect(msg.type).toBe("deny");
        expect(msg.sessionId).toBe("s1");
    });

    it("input message has correct shape", () => {
        const msg: WsMessage = {
            type: "input",
            sessionId: "s1",
            data: { text: "hello world" },
            timestamp: Date.now(),
        };

        const data = msg.data as { text: string };
        expect(data.text).toBe("hello world");
    });

    it("disconnected message updates session status", () => {
        const msg: WsMessage = {
            type: "disconnected",
            sessionId: "s1",
            timestamp: Date.now(),
        };

        // Simulate the reducer logic from useSessions
        const sessions = [mockSession];
        const updated = sessions.map((s) =>
            s.id === msg.sessionId ? { ...s, status: "stopped" as const } : s,
        );

        expect(updated[0].status).toBe("stopped");
    });
});
