import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ServerConfig } from "../../src/types/index.js";

// Mock node-pty before importing Session
const mockWrite = mock(() => {});
const mockResize = mock(() => {});
const mockKill = mock(() => {});
let onDataCb: ((data: string) => void) | null = null;
let onExitCb: ((info: { exitCode: number; signal?: number }) => void) | null =
    null;

mock.module("node-pty", () => ({
    spawn: mock(() => ({
        write: mockWrite,
        resize: mockResize,
        kill: mockKill,
        onData: (cb: (data: string) => void) => {
            onDataCb = cb;
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
    ringBufferSize: 100,
};

describe("Session", () => {
    afterEach(() => {
        mockWrite.mockClear();
        mockResize.mockClear();
        mockKill.mockClear();
        onDataCb = null;
        onExitCb = null;
    });

    it("creates with a unique ID", () => {
        const s1 = new Session(testConfig, serverConfig);
        const s2 = new Session(testConfig, serverConfig);
        expect(s1.id).toBeTruthy();
        expect(s2.id).toBeTruthy();
        expect(s1.id).not.toBe(s2.id);
    });

    it("returns correct session info", () => {
        const session = new Session(testConfig, serverConfig);
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
            serverConfig,
        );
        expect(session.getInfo().name).toBe("/projects/foo");
    });

    it("defaults tags to empty array", () => {
        const session = new Session(
            { cwd: "/tmp", model: "sonnet", permissionMode: "default" },
            serverConfig,
        );
        expect(session.getInfo().tags).toEqual([]);
    });

    it("sends input with newline appended", () => {
        const session = new Session(testConfig, serverConfig);
        session.sendInput("hello world");
        expect(mockWrite).toHaveBeenCalledWith("hello world\n");
    });

    it("sends slash commands with leading slash", () => {
        const session = new Session(testConfig, serverConfig);
        session.sendSlashCommand("compact");
        expect(mockWrite).toHaveBeenCalledWith("/compact\n");
    });

    it("does not double-prefix slash commands", () => {
        const session = new Session(testConfig, serverConfig);
        session.sendSlashCommand("/model");
        expect(mockWrite).toHaveBeenCalledWith("/model\n");
    });

    it("approve writes y", () => {
        const session = new Session(testConfig, serverConfig);
        session.approve();
        expect(mockWrite).toHaveBeenCalledWith("y\n");
    });

    it("deny writes n", () => {
        const session = new Session(testConfig, serverConfig);
        session.deny();
        expect(mockWrite).toHaveBeenCalledWith("n\n");
    });

    it("resize forwards to PTY", () => {
        const session = new Session(testConfig, serverConfig);
        session.resize(200, 60);
        expect(mockResize).toHaveBeenCalledWith(200, 60);
    });

    it("emits output events from PTY data", () => {
        const session = new Session(testConfig, serverConfig);
        const received: string[] = [];
        session.on("output", (data) => received.push(data));

        onDataCb?.("line 1");
        onDataCb?.("line 2");

        expect(received).toEqual(["line 1", "line 2"]);
    });

    it("stores output in replay buffer", () => {
        const session = new Session(testConfig, serverConfig);
        onDataCb?.("chunk 1");
        onDataCb?.("chunk 2");
        onDataCb?.("chunk 3");

        expect(session.getReplayBuffer()).toEqual([
            "chunk 1",
            "chunk 2",
            "chunk 3",
        ]);
    });

    it("sets status to stopped on PTY exit", () => {
        const session = new Session(testConfig, serverConfig);
        expect(session.getInfo().status).toBe("running");

        onExitCb?.({ exitCode: 0 });
        expect(session.getInfo().status).toBe("stopped");
    });

    it("emits exit event on PTY exit", () => {
        const session = new Session(testConfig, serverConfig);
        let exitInfo: { exitCode: number; signal?: number } | null = null;
        session.on("exit", (info) => {
            exitInfo = info;
        });

        onExitCb?.({ exitCode: 1, signal: 15 });
        expect(exitInfo).toEqual({ exitCode: 1, signal: 15 });
    });

    it("stop kills the PTY and updates status", () => {
        const session = new Session(testConfig, serverConfig);
        session.stop();
        expect(mockWrite).toHaveBeenCalledWith("\x03");
        expect(session.getInfo().status).toBe("stopped");
    });
});
