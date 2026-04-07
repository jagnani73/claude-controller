import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { WsMessage } from "common/types";
import type { ServerConfig } from "../../src/types/index.js";

// Mock node-pty
mock.module("node-pty", () => ({
    spawn: mock(() => ({
        write: mock(() => {}),
        resize: mock(() => {}),
        kill: mock(() => {}),
        onData: () => {},
        onExit: () => {},
    })),
}));

const { handleConnection } = await import("../../src/services/ws.service.js");
const { SessionManager } = await import(
    "../../src/services/session-manager.service.js"
);

const serverConfig: ServerConfig = {
    port: 3000,
    host: "0.0.0.0",
    dataDir: "./data",
    pty: { cols: 120, rows: 40 },
    ringBufferSize: 100,
};

/** Minimal WebSocket mock */
function createMockWs() {
    const sent: string[] = [];
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

    const ws = {
        OPEN: 1,
        readyState: 1,
        send: mock((data: string) => sent.push(data)),
        on: mock((event: string, cb: (...args: unknown[]) => void) => {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event)?.push(cb);
        }),
        off: mock(() => {}),
    };

    return {
        ws: ws as unknown as import("ws").WebSocket,
        sent,
        simulateMessage: (msg: WsMessage) => {
            const cbs = listeners.get("message") ?? [];
            for (const cb of cbs) cb(JSON.stringify(msg));
        },
        simulateClose: () => {
            const cbs = listeners.get("close") ?? [];
            for (const cb of cbs) cb();
        },
        parseSent: () => sent.map((s) => JSON.parse(s) as WsMessage),
    };
}

describe("ws.service", () => {
    let sessionManager: InstanceType<typeof SessionManager>;

    beforeEach(() => {
        sessionManager = new SessionManager(serverConfig);
    });

    it("sends connected message with session list on connection", () => {
        const { ws, parseSent } = createMockWs();
        handleConnection(ws, sessionManager);

        const messages = parseSent();
        expect(messages).toHaveLength(1);
        expect(messages[0].type).toBe("connected");
        expect((messages[0].data as { sessions: unknown[] }).sessions).toEqual(
            [],
        );
    });

    it("sends session list with existing sessions", () => {
        sessionManager.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
            name: "Existing",
        });

        const { ws, parseSent } = createMockWs();
        handleConnection(ws, sessionManager);

        const data = parseSent()[0].data as {
            sessions: { name: string }[];
        };
        expect(data.sessions).toHaveLength(1);
        expect(data.sessions[0].name).toBe("Existing");
    });

    it("handles create_session command", () => {
        const { ws, simulateMessage, parseSent } = createMockWs();
        handleConnection(ws, sessionManager);

        simulateMessage({
            type: "command",
            data: {
                action: "create_session",
                config: {
                    cwd: "/tmp/new",
                    model: "opus",
                    permissionMode: "plan",
                    name: "New Session",
                },
            },
            timestamp: Date.now(),
        });

        expect(sessionManager.list()).toHaveLength(1);
        const messages = parseSent();
        const metaMsg = messages.find((m) => m.type === "session_metadata");
        expect(metaMsg).toBeTruthy();
    });

    it("handles list_sessions command", () => {
        sessionManager.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
        });

        const { ws, simulateMessage, parseSent } = createMockWs();
        handleConnection(ws, sessionManager);

        simulateMessage({
            type: "command",
            data: { action: "list_sessions" },
            timestamp: Date.now(),
        });

        const messages = parseSent();
        const listMsg = messages.filter((m) => m.type === "connected");
        expect(listMsg.length).toBeGreaterThanOrEqual(2);
    });

    it("handles stop_session command", () => {
        const session = sessionManager.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
        });

        const { ws, simulateMessage } = createMockWs();
        handleConnection(ws, sessionManager);

        simulateMessage({
            type: "command",
            data: { action: "stop_session", sessionId: session.id },
            timestamp: Date.now(),
        });

        expect(session.getInfo().status).toBe("stopped");
    });

    it("handles input message", () => {
        const session = sessionManager.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
        });

        const { ws, simulateMessage } = createMockWs();
        handleConnection(ws, sessionManager);

        simulateMessage({
            type: "input",
            sessionId: session.id,
            data: { text: "hello claude" },
            timestamp: Date.now(),
        });
    });

    it("sends error for input to unknown session", () => {
        const { ws, simulateMessage, parseSent } = createMockWs();
        handleConnection(ws, sessionManager);

        simulateMessage({
            type: "input",
            sessionId: "nonexistent",
            data: { text: "hello" },
            timestamp: Date.now(),
        });

        const messages = parseSent();
        const errorMsg = messages.find((m) => m.type === "error");
        expect(errorMsg).toBeTruthy();
        expect((errorMsg?.data as { message: string }).message).toBe(
            "Session not found",
        );
    });

    it("sends error for subscribe to unknown session", () => {
        const { ws, simulateMessage, parseSent } = createMockWs();
        handleConnection(ws, sessionManager);

        simulateMessage({
            type: "command",
            data: { action: "subscribe", sessionId: "nonexistent" },
            timestamp: Date.now(),
        });

        const messages = parseSent();
        const errorMsg = messages.find((m) => m.type === "error");
        expect(errorMsg).toBeTruthy();
    });

    it("handles invalid JSON gracefully", () => {
        const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
        const sent: string[] = [];
        const ws = {
            OPEN: 1,
            readyState: 1,
            send: mock((data: string) => sent.push(data)),
            on: mock((event: string, cb: (...args: unknown[]) => void) => {
                if (!listeners.has(event)) listeners.set(event, []);
                listeners.get(event)?.push(cb);
            }),
            off: mock(() => {}),
        } as unknown as import("ws").WebSocket;

        handleConnection(ws, sessionManager);

        const cbs = listeners.get("message") ?? [];
        for (const cb of cbs) cb("not valid json{{{");

        const messages = sent.map((s) => JSON.parse(s) as WsMessage);
        const errorMsg = messages.find((m) => m.type === "error");
        expect(errorMsg).toBeTruthy();
        expect((errorMsg?.data as { message: string }).message).toBe(
            "Invalid message format",
        );
    });

    it("does not send to closed WebSocket", () => {
        const { ws, sent } = createMockWs();
        (ws as unknown as { readyState: number }).readyState = 3;

        handleConnection(ws, sessionManager);

        expect(sent).toHaveLength(0);
    });

    it("cleans up on close", () => {
        const { ws, simulateClose } = createMockWs();
        handleConnection(ws, sessionManager);
        simulateClose();
    });
});
