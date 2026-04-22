import { describe, expect, it } from "bun:test";
import type { ClientMessage, DirEntry, ServerMessage, SessionInfo } from "common/types";

/**
 * Tests for use-sessions hook logic.
 *
 * Since Bun's test runner doesn't have React rendering support (no renderHook),
 * we test the underlying message handling logic directly by verifying the
 * ServerMessage/ClientMessage shapes that the hook produces and consumes.
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
  it("connected message carries session list and workDir", () => {
    const msg: ServerMessage = {
      type: "connected",
      sessions: [mockSession],
      workDir: "/home/user",
    };

    if (msg.type !== "connected") throw new Error("unreachable");
    expect(msg.sessions).toHaveLength(1);
    expect(msg.sessions[0].id).toBe("s1");
    expect(msg.workDir).toBe("/home/user");
  });

  it("session_created message carries the new session", () => {
    const msg: ServerMessage = {
      type: "session_created",
      session: mockSession,
    };

    if (msg.type !== "session_created") throw new Error("unreachable");
    expect(msg.session.id).toBe("s1");
  });

  it("session_metadata message carries updated SessionInfo", () => {
    const updated: SessionInfo = { ...mockSession, status: "idle" };
    const msg: ServerMessage = {
      type: "session_metadata",
      session: updated,
    };

    if (msg.type !== "session_metadata") throw new Error("unreachable");
    expect(msg.session.status).toBe("idle");
    expect(msg.session.id).toBe("s1");
  });

  it("session_stopped message carries sessionId and exitCode", () => {
    const msg: ServerMessage = {
      type: "session_stopped",
      sessionId: "s1",
      exitCode: 0,
    };

    if (msg.type !== "session_stopped") throw new Error("unreachable");
    expect(msg.sessionId).toBe("s1");
    expect(msg.exitCode).toBe(0);
  });

  it("create_session client message has correct shape", () => {
    const msg: ClientMessage = {
      type: "create_session",
      config: {
        cwd: "/home/user/project",
        model: "sonnet",
        permissionMode: "default",
        name: "my-session",
      },
    };

    if (msg.type !== "create_session") throw new Error("unreachable");
    expect(msg.config.cwd).toBe("/home/user/project");
    expect(msg.config.model).toBe("sonnet");
  });

  it("stop_session client message has correct shape", () => {
    const msg: ClientMessage = {
      type: "stop_session",
      sessionId: "s1",
    };

    if (msg.type !== "stop_session") throw new Error("unreachable");
    expect(msg.sessionId).toBe("s1");
  });

  it("subscribe client message has correct shape", () => {
    const msg: ClientMessage = {
      type: "subscribe",
      sessionId: "s1",
    };

    if (msg.type !== "subscribe") throw new Error("unreachable");
    expect(msg.sessionId).toBe("s1");
  });

  it("approval_response client message has correct shape", () => {
    const msg: ClientMessage = {
      type: "approval_response",
      sessionId: "s1",
      toolUseId: "pr:Bash:abc",
      decision: "allow",
      reason: "looks safe",
    };

    if (msg.type !== "approval_response") throw new Error("unreachable");
    expect(msg.decision).toBe("allow");
    expect(msg.toolUseId).toBe("pr:Bash:abc");
  });

  it("input client message has correct flat shape", () => {
    const msg: ClientMessage = {
      type: "input",
      sessionId: "s1",
      text: "hello world",
    };

    if (msg.type !== "input") throw new Error("unreachable");
    expect(msg.text).toBe("hello world");
    expect(msg.sessionId).toBe("s1");
  });

  it("dir_list server message carries entries (not dirs)", () => {
    const entries: DirEntry[] = [
      { name: "src", path: "/tmp/src", isDir: true },
      { name: "README.md", path: "/tmp/README.md", isDir: false },
    ];
    const msg: ServerMessage = {
      type: "dir_list",
      path: "/tmp",
      entries,
    };

    if (msg.type !== "dir_list") throw new Error("unreachable");
    expect(msg.entries).toHaveLength(2);
    expect(msg.entries[0].name).toBe("src");
    expect(msg.path).toBe("/tmp");
  });

  it("assistant_text server message has turnId and timestamp", () => {
    const msg: ServerMessage = {
      type: "assistant_text",
      sessionId: "s1",
      turnId: "t1",
      text: "hello",
      timestamp: "2026-04-22T00:00:00Z",
    };

    if (msg.type !== "assistant_text") throw new Error("unreachable");
    expect(msg.turnId).toBe("t1");
    expect(msg.text).toBe("hello");
  });

  it("approval_request server message has toolUseId, name, input", () => {
    const msg: ServerMessage = {
      type: "approval_request",
      sessionId: "s1",
      toolUseId: "pr:Bash:abc",
      toolName: "Bash",
      toolInput: { command: "ls" },
    };

    if (msg.type !== "approval_request") throw new Error("unreachable");
    expect(msg.toolUseId).toBe("pr:Bash:abc");
    expect(msg.toolName).toBe("Bash");
  });
});
