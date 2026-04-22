import { afterEach, describe, expect, it, mock } from "bun:test";

const mockWrite = mock(() => {});
const mockResize = mock(() => {});
const mockKill = mock(() => {});
let onDataCb: ((data: string) => void) | null = null;
let onExitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;

const mockSpawn = mock(() => ({
  write: mockWrite,
  resize: mockResize,
  kill: mockKill,
  onData: (cb: (data: string) => void) => {
    onDataCb = cb;
  },
  onExit: (cb: (info: { exitCode: number; signal?: number }) => void) => {
    onExitCb = cb;
  },
}));

mock.module("node-pty", () => ({
  spawn: mockSpawn,
}));

const { PtyService } = await import("../../src/services/pty.service.js");

describe("PtyService", () => {
  const defaultOptions = {
    cwd: "/tmp",
    model: "sonnet" as const,
    permissionMode: "default" as const,
    cols: 120,
    rows: 40,
  };

  afterEach(() => {
    mockWrite.mockClear();
    mockResize.mockClear();
    mockKill.mockClear();
    mockSpawn.mockClear();
    onDataCb = null;
    onExitCb = null;
  });

  it("starts as not running", () => {
    const svc = new PtyService();
    expect(svc.running).toBe(false);
  });

  it("spawns a PTY process", () => {
    const svc = new PtyService();
    svc.spawn(defaultOptions);
    expect(svc.running).toBe(true);
  });

  it("throws if spawning while already running", () => {
    const svc = new PtyService();
    svc.spawn(defaultOptions);
    expect(() => svc.spawn(defaultOptions)).toThrow("PTY process already running");
  });

  it("writes data to the PTY process", () => {
    const svc = new PtyService();
    svc.spawn(defaultOptions);
    svc.write("hello\n");
    expect(mockWrite).toHaveBeenCalledWith("hello\n");
  });

  it("returns false when writing without a running process", () => {
    const svc = new PtyService();
    // New contract: write returns false rather than throwing
    expect(svc.write("test")).toBe(false);
  });

  it("resizes the PTY", () => {
    const svc = new PtyService();
    svc.spawn(defaultOptions);
    svc.resize(200, 60);
    expect(mockResize).toHaveBeenCalledWith(200, 60);
  });

  it("does not throw when resizing without a process", () => {
    const svc = new PtyService();
    expect(() => svc.resize(200, 60)).not.toThrow();
  });

  it("emits data events from the PTY", () => {
    const svc = new PtyService();
    const received: string[] = [];
    svc.on("data", (data) => received.push(data));

    svc.spawn(defaultOptions);
    onDataCb?.("output line 1");
    onDataCb?.("output line 2");

    expect(received).toEqual(["output line 1", "output line 2"]);
  });

  it("emits exit events and clears the process", () => {
    const svc = new PtyService();
    const captured: Array<{ exitCode: number; signal?: number }> = [];
    svc.on("exit", (info) => {
      captured.push(info);
    });

    svc.spawn(defaultOptions);
    expect(svc.running).toBe(true);

    onExitCb?.({ exitCode: 0 });
    expect(svc.running).toBe(false);
    expect(captured).toEqual([{ exitCode: 0 }]);
  });

  it("sends Ctrl+C on kill", () => {
    const svc = new PtyService();
    svc.spawn(defaultOptions);
    svc.kill();
    expect(mockWrite).toHaveBeenCalledWith("\x03");
  });

  it("injects --settings and --setting-sources when settingsJson is provided", () => {
    const svc = new PtyService();
    const settingsJson = JSON.stringify({ hooks: { X: [] } });
    svc.spawn({ ...defaultOptions, settingsJson });

    expect(mockSpawn).toHaveBeenCalled();
    const call = mockSpawn.mock.calls[0] as unknown as [string, string[], unknown];
    const shellArgs = call[1];
    const joined = shellArgs.join(" ");

    expect(joined).toContain("--settings");
    expect(joined).toContain("--setting-sources");
    // On win32 args are passed element-wise, on Unix they're shell-escaped
    // into the -c string; either way the JSON body appears somewhere.
    expect(joined).toContain("hooks");
  });

  it("omits --settings when settingsJson is not provided", () => {
    const svc = new PtyService();
    svc.spawn(defaultOptions);

    const call = mockSpawn.mock.calls[0] as unknown as [string, string[], unknown];
    const shellArgs = call[1];
    const joined = shellArgs.join(" ");
    expect(joined).not.toContain("--settings");
  });
});
