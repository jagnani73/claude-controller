import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ClientMessage, ServerMessage } from "common/types";
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
const { SessionManager } = await import("../../src/services/session-manager.service.js");

const serverConfig: ServerConfig = {
  port: 3000,
  host: "0.0.0.0",
  dataDir: "./data",
  workDir: "/tmp",
  pty: { cols: 120, rows: 40 },
};

const HOOKS_URL = "http://127.0.0.1:9999";

/** Stub that matches the HooksService surface used by ws.service. */
function createStubHooksService() {
  return {
    resolveApproval: mock(() => true),
    baseUrl: () => HOOKS_URL,
    start: mock(async () => 9999),
    stop: mock(() => {}),
  } as unknown as import("../../src/services/hooks.service.js").HooksService;
}

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
    simulateMessage: (msg: ClientMessage) => {
      const cbs = listeners.get("message") ?? [];
      for (const cb of cbs) cb(JSON.stringify(msg));
    },
    simulateRaw: (raw: string) => {
      const cbs = listeners.get("message") ?? [];
      for (const cb of cbs) cb(raw);
    },
    simulateClose: () => {
      const cbs = listeners.get("close") ?? [];
      for (const cb of cbs) cb();
    },
    parseSent: () => sent.map((s) => JSON.parse(s) as ServerMessage),
  };
}

describe("ws.service", () => {
  let sessionManager: InstanceType<typeof SessionManager>;
  let hooksService: ReturnType<typeof createStubHooksService>;

  beforeEach(() => {
    sessionManager = new SessionManager(serverConfig);
    sessionManager.setHooksBaseUrl(HOOKS_URL);
    hooksService = createStubHooksService();
  });

  it("sends connected message with empty session list on connection", () => {
    const { ws, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    const messages = parseSent();
    expect(messages).toHaveLength(1);
    const first = messages[0];
    expect(first.type).toBe("connected");
    if (first.type !== "connected") throw new Error("unreachable");
    expect(first.sessions).toEqual([]);
    expect(first.workDir).toBe("/tmp");
  });

  it("sends session list with existing sessions on connection", () => {
    sessionManager.create({
      cwd: "/tmp",
      model: "sonnet",
      permissionMode: "default",
      name: "Existing",
    });

    const { ws, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    const first = parseSent()[0];
    if (first.type !== "connected") throw new Error("expected connected");
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0].name).toBe("Existing");
  });

  it("handles create_session message", () => {
    const { ws, simulateMessage, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateMessage({
      type: "create_session",
      config: {
        cwd: "/tmp/new",
        model: "opus",
        permissionMode: "plan",
        name: "New Session",
      },
    });

    expect(sessionManager.list()).toHaveLength(1);
    const messages = parseSent();
    const metaMsg = messages.find((m) => m.type === "session_metadata");
    expect(metaMsg).toBeTruthy();
    const createdMsg = messages.find((m) => m.type === "session_created");
    expect(createdMsg).toBeTruthy();
  });

  it("handles stop_session message", () => {
    const session = sessionManager.create({
      cwd: "/tmp",
      model: "sonnet",
      permissionMode: "default",
    });

    const { ws, simulateMessage } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateMessage({
      type: "stop_session",
      sessionId: session.id,
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
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateMessage({
      type: "input",
      sessionId: session.id,
      text: "hello claude",
    });

    // No assertion on PTY output — node-pty is mocked. The fact that this
    // does not throw (session found, routed correctly) is the contract.
    expect(session.getInfo().status).toBe("running");
  });

  it("sends error for input to unknown session", () => {
    const { ws, simulateMessage, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateMessage({
      type: "input",
      sessionId: "nonexistent",
      text: "hello",
    });

    const messages = parseSent();
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
    if (errorMsg?.type !== "error") throw new Error("unreachable");
    expect(errorMsg.message).toBe("Session not found");
  });

  it("sends error for subscribe to unknown session", () => {
    const { ws, simulateMessage, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateMessage({
      type: "subscribe",
      sessionId: "nonexistent",
    });

    const messages = parseSent();
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
  });

  it("routes approval_response through HooksService.resolveApproval", () => {
    const session = sessionManager.create({
      cwd: "/tmp",
      model: "sonnet",
      permissionMode: "default",
    });

    const { ws, simulateMessage } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateMessage({
      type: "approval_response",
      sessionId: session.id,
      toolUseId: "pr:Bash:abc123",
      decision: "allow",
      reason: "ok",
    });

    expect(hooksService.resolveApproval).toHaveBeenCalledWith(
      session.id,
      "pr:Bash:abc123",
      "allow",
      "ok",
    );
  });

  it("handles invalid JSON gracefully", () => {
    const { ws, simulateRaw, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateRaw("not valid json{{{");

    const messages = parseSent();
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
    if (errorMsg?.type !== "error") throw new Error("unreachable");
    expect(errorMsg.message).toBe("Invalid message format");
  });

  it("does not send to closed WebSocket", () => {
    const { ws, sent } = createMockWs();
    (ws as unknown as { readyState: number }).readyState = 3;

    handleConnection(ws, sessionManager, hooksService, serverConfig);

    expect(sent).toHaveLength(0);
  });

  it("cleans up on close", () => {
    const { ws, simulateClose } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);
    simulateClose();
  });

  it("replays prior bus events to a new subscriber", () => {
    const session = sessionManager.create({
      cwd: "/tmp",
      model: "sonnet",
      permissionMode: "default",
    });

    // Push some events before the client subscribes
    session.bus.push({
      kind: "user_prompt",
      sessionId: session.id,
      timestamp: "2026-04-22T00:00:00Z",
      text: "hello",
    });
    session.bus.push({
      kind: "assistant_text",
      sessionId: session.id,
      timestamp: "2026-04-22T00:00:01Z",
      turnId: "t1",
      text: "hi back",
    });

    const { ws, simulateMessage, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    simulateMessage({ type: "subscribe", sessionId: session.id });

    const messages = parseSent();
    const userPrompt = messages.find((m) => m.type === "user_prompt");
    const assistant = messages.find((m) => m.type === "assistant_text");
    expect(userPrompt).toBeTruthy();
    expect(assistant).toBeTruthy();
    if (userPrompt?.type !== "user_prompt") throw new Error("unreachable");
    expect(userPrompt.text).toBe("hello");
  });

  it("forwards new bus events after subscription", () => {
    const session = sessionManager.create({
      cwd: "/tmp",
      model: "sonnet",
      permissionMode: "default",
    });

    const { ws, simulateMessage, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);
    simulateMessage({ type: "subscribe", sessionId: session.id });

    session.bus.push({
      kind: "assistant_text",
      sessionId: session.id,
      timestamp: "2026-04-22T00:00:00Z",
      turnId: "t-new",
      text: "fresh reply",
    });

    const messages = parseSent();
    const assistant = messages.find((m) => m.type === "assistant_text" && m.turnId === "t-new");
    expect(assistant).toBeTruthy();
    if (assistant?.type !== "assistant_text") throw new Error("unreachable");
    expect(assistant.text).toBe("fresh reply");
  });

  it("responds to list_dirs with a dir_list envelope using `entries`", () => {
    const { ws, simulateMessage, parseSent } = createMockWs();
    handleConnection(ws, sessionManager, hooksService, serverConfig);

    // Path outside workDir returns empty entries but still a dir_list reply.
    simulateMessage({ type: "list_dirs", path: "/tmp" });

    const messages = parseSent();
    const listMsg = messages.find((m) => m.type === "dir_list");
    expect(listMsg).toBeTruthy();
    if (listMsg?.type !== "dir_list") throw new Error("unreachable");
    expect(Array.isArray(listMsg.entries)).toBe(true);
  });
});
