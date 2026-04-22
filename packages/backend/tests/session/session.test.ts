import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ServerConfig } from "../../src/types/index.js";

// Mock node-pty before importing Session
const mockWrite = mock(() => {});
const mockResize = mock(() => {});
const mockKill = mock(() => {});
let _onDataCb: ((data: string) => void) | null = null;
let onExitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;

mock.module("node-pty", () => ({
  spawn: mock(() => ({
    write: mockWrite,
    resize: mockResize,
    kill: mockKill,
    onData: (cb: (data: string) => void) => {
      _onDataCb = cb;
    },
    onExit: (cb: (info: { exitCode: number; signal?: number }) => void) => {
      onExitCb = cb;
    },
  })),
}));

// Import after mock setup
const { Session } = await import("../../src/session/session.js");

const testConfig = {
  cwd: "/tmp/test",
  model: "sonnet" as const,
  permissionMode: "default" as const,
  name: "Test Session",
  tags: ["test"],
};

const serverConfig: ServerConfig = {
  port: 3000,
  host: "0.0.0.0",
  dataDir: "./data",
  workDir: "/tmp",
  pty: { cols: 120, rows: 40 },
};

const deps = {
  serverConfig,
  hooksBaseUrl: "http://127.0.0.1:9999",
};

describe("Session", () => {
  afterEach(() => {
    mockWrite.mockClear();
    mockResize.mockClear();
    mockKill.mockClear();
    _onDataCb = null;
    onExitCb = null;
  });

  it("creates with a unique ID", () => {
    const s1 = new Session(testConfig, deps);
    const s2 = new Session(testConfig, deps);
    expect(s1.id).toBeTruthy();
    expect(s2.id).toBeTruthy();
    expect(s1.id).not.toBe(s2.id);
  });

  it("returns correct session info", () => {
    const session = new Session(testConfig, deps);
    const info = session.getInfo();
    expect(info.name).toBe("Test Session");
    expect(info.cwd).toBe("/tmp/test");
    expect(info.model).toBe("sonnet");
    expect(info.permissionMode).toBe("default");
    expect(info.status).toBe("running");
    expect(info.tags).toEqual(["test"]);
    expect(info.createdAt).toBeGreaterThan(0);
  });

  it("uses cwd as name when name is not provided", () => {
    const session = new Session(
      { cwd: "/projects/foo", model: "opus", permissionMode: "plan" },
      deps,
    );
    expect(session.getInfo().name).toBe("/projects/foo");
  });

  it("defaults tags to empty array", () => {
    const session = new Session({ cwd: "/tmp", model: "sonnet", permissionMode: "default" }, deps);
    expect(session.getInfo().tags).toEqual([]);
  });

  it("sends input with carriage return appended", () => {
    const session = new Session(testConfig, deps);
    session.sendInput("hello world");
    expect(mockWrite).toHaveBeenCalledWith("hello world\r");
  });

  it("sends slash commands with leading slash", () => {
    const session = new Session(testConfig, deps);
    session.sendSlashCommand("compact");
    expect(mockWrite).toHaveBeenCalledWith("/compact\r");
  });

  it("does not double-prefix slash commands", () => {
    const session = new Session(testConfig, deps);
    session.sendSlashCommand("/model");
    expect(mockWrite).toHaveBeenCalledWith("/model\r");
  });

  it("resize forwards to PTY", () => {
    const session = new Session(testConfig, deps);
    session.resize(200, 60);
    expect(mockResize).toHaveBeenCalledWith(200, 60);
  });

  it("exposes a SessionBus", () => {
    const session = new Session(testConfig, deps);
    expect(session.bus).toBeTruthy();
    expect(session.bus.sessionId).toBe(session.id);
  });

  it("sets status to stopped on PTY exit", () => {
    const session = new Session(testConfig, deps);
    expect(session.getInfo().status).toBe("running");

    onExitCb?.({ exitCode: 0 });
    expect(session.getInfo().status).toBe("stopped");
  });

  it("emits exit event on PTY exit", () => {
    const session = new Session(testConfig, deps);
    const captured: Array<{ exitCode: number; signal?: number }> = [];
    session.on("exit", (info) => {
      captured.push(info);
    });

    onExitCb?.({ exitCode: 1, signal: 15 });
    expect(captured).toEqual([{ exitCode: 1, signal: 15 }]);
  });

  it("stop kills the PTY and updates status", () => {
    const session = new Session(testConfig, deps);
    session.stop();
    // pty.kill() sends Ctrl+C then schedules a hard kill.
    expect(mockWrite).toHaveBeenCalledWith("\x03");
    expect(session.getInfo().status).toBe("stopped");
  });

  it("passes hooks settings JSON to the PTY on spawn", async () => {
    // node-pty is module-mocked above; assert that spawn received the
    // --settings flag with JSON containing the hooks base URL.
    const pty = await import("node-pty");
    const spawnMock = pty.spawn as unknown as ReturnType<typeof mock>;
    spawnMock.mockClear();

    new Session(testConfig, deps);

    expect(spawnMock).toHaveBeenCalled();
    const call = spawnMock.mock.calls[0] as unknown as [string, string[], unknown];
    const shellArgs = call[1];
    const asString = shellArgs.join(" ");
    expect(asString).toContain("--settings");
    expect(asString).toContain("127.0.0.1:9999");
  });
});
