import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ClientMessage, ServerMessage } from "common/types";

// Mock WebSocket at global level
let wsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send = mock(() => {});
  close = mock(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(public url: string) {
    wsInstances.push(this);
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateError() {
    this.onerror?.();
  }
}

// Install mock globally
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

// Fresh import for each test suite
const { wsService } = await import("../../src/services/ws.service.js");

describe("WsService", () => {
  beforeEach(() => {
    wsInstances = [];
    wsService.disconnect();
  });

  afterEach(() => {
    wsService.disconnect();
  });

  it("starts in disconnected state", () => {
    expect(wsService.state).toBe("disconnected");
  });

  it("transitions to connecting then connected on open", () => {
    const states: string[] = [];
    wsService.onStateChange((s) => states.push(s));

    wsService.connect("ws://localhost:4577/ws");
    expect(states).toContain("connecting");

    wsInstances[0].simulateOpen();
    expect(wsService.state).toBe("connected");
    expect(states).toContain("connected");
  });

  it("sends flat ClientMessage JSON when connected", () => {
    wsService.connect("ws://localhost:4577/ws");
    wsInstances[0].simulateOpen();

    const msg: ClientMessage = {
      type: "input",
      sessionId: "test",
      text: "hello",
    };
    wsService.send(msg);

    expect(wsInstances[0].send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it("does not send when disconnected", () => {
    wsService.connect("ws://localhost:4577/ws");
    // Don't open the connection
    wsInstances[0].readyState = MockWebSocket.CLOSED;

    wsService.send({
      type: "input",
      sessionId: "s1",
      text: "hello",
    });

    expect(wsInstances[0].send).not.toHaveBeenCalled();
  });

  it("dispatches incoming messages to type-specific listeners", () => {
    wsService.connect("ws://localhost:4577/ws");
    wsInstances[0].simulateOpen();

    const handler = mock(() => {});
    wsService.on("assistant_text", handler);

    const msg: ServerMessage = {
      type: "assistant_text",
      sessionId: "s1",
      turnId: "t1",
      text: "hello",
      timestamp: "2026-04-22T00:00:00Z",
    };
    wsInstances[0].simulateMessage(msg);

    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("dispatches to wildcard listeners", () => {
    wsService.connect("ws://localhost:4577/ws");
    wsInstances[0].simulateOpen();

    const handler = mock(() => {});
    wsService.on("*", handler);

    const msg: ServerMessage = {
      type: "connected",
      sessions: [],
      workDir: "/tmp",
    };
    wsInstances[0].simulateMessage(msg);

    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("unsubscribes listeners", () => {
    wsService.connect("ws://localhost:4577/ws");
    wsInstances[0].simulateOpen();

    const handler = mock(() => {});
    const unsub = wsService.on("assistant_text", handler);
    unsub();

    wsInstances[0].simulateMessage({
      type: "assistant_text",
      sessionId: "s1",
      turnId: "t1",
      text: "x",
      timestamp: "2026-04-22T00:00:00Z",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("transitions to disconnected on close", () => {
    wsService.connect("ws://localhost:4577/ws");
    wsInstances[0].simulateOpen();
    expect(wsService.state).toBe("connected");

    wsInstances[0].simulateClose();
    expect(wsService.state).toBe("disconnected");
  });

  it("schedules reconnect after close", async () => {
    wsService.connect("ws://localhost:4577/ws");
    wsInstances[0].simulateOpen();
    wsInstances[0].simulateClose();

    // Wait for reconnect timer (1s base)
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Should have created a new WebSocket instance
    expect(wsInstances.length).toBeGreaterThan(1);
  });

  it("stops reconnecting after disconnect()", async () => {
    wsService.connect("ws://localhost:4577/ws");
    wsInstances[0].simulateOpen();
    wsInstances[0].simulateClose();

    wsService.disconnect();

    const countBefore = wsInstances.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(wsInstances.length).toBe(countBefore);
  });

  it("unsubscribes state change listeners", () => {
    const handler = mock(() => {});
    const unsub = wsService.onStateChange(handler);
    unsub();

    wsService.connect("ws://localhost:4577/ws");
    expect(handler).not.toHaveBeenCalled();
  });
});
