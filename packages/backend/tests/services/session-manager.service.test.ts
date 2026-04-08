import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ServerConfig } from "../../src/types/index.js";

// Mock node-pty
const mockWrite = mock(() => {});
const mockKill = mock(() => {});

mock.module("node-pty", () => ({
    spawn: mock(() => ({
        write: mockWrite,
        resize: mock(() => {}),
        kill: mockKill,
        onData: () => {},
        onExit: () => {},
    })),
}));

const { SessionManager } = await import(
    "../../src/services/session-manager.service.js"
);

const serverConfig: ServerConfig = {
    port: 3000,
    host: "0.0.0.0",
    dataDir: "./data",
    workDir: "/tmp",
    pty: { cols: 120, rows: 40 },
    ringBufferSize: 100,
};

describe("SessionManager", () => {
    afterEach(() => {
        mockWrite.mockClear();
        mockKill.mockClear();
    });

    it("starts with no sessions", () => {
        const mgr = new SessionManager(serverConfig);
        expect(mgr.list()).toEqual([]);
    });

    it("creates a session", () => {
        const mgr = new SessionManager(serverConfig);
        const session = mgr.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
        });
        expect(session.id).toBeTruthy();
        expect(mgr.list()).toHaveLength(1);
        expect(mgr.list()[0].id).toBe(session.id);
    });

    it("creates multiple sessions", () => {
        const mgr = new SessionManager(serverConfig);
        mgr.create({ cwd: "/a", model: "sonnet", permissionMode: "default" });
        mgr.create({ cwd: "/b", model: "opus", permissionMode: "plan" });
        expect(mgr.list()).toHaveLength(2);
    });

    it("gets a session by id", () => {
        const mgr = new SessionManager(serverConfig);
        const session = mgr.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
        });
        expect(mgr.get(session.id)).toBe(session);
    });

    it("returns undefined for unknown id", () => {
        const mgr = new SessionManager(serverConfig);
        expect(mgr.get("nonexistent")).toBeUndefined();
    });

    it("stops a session", () => {
        const mgr = new SessionManager(serverConfig);
        const session = mgr.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
        });
        const result = mgr.stop(session.id);
        expect(result).toBe(true);
        expect(session.getInfo().status).toBe("stopped");
    });

    it("returns false when stopping unknown session", () => {
        const mgr = new SessionManager(serverConfig);
        expect(mgr.stop("nonexistent")).toBe(false);
    });

    it("removes a session", () => {
        const mgr = new SessionManager(serverConfig);
        const session = mgr.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
        });
        const result = mgr.remove(session.id);
        expect(result).toBe(true);
        expect(mgr.list()).toHaveLength(0);
        expect(mgr.get(session.id)).toBeUndefined();
    });

    it("returns false when removing unknown session", () => {
        const mgr = new SessionManager(serverConfig);
        expect(mgr.remove("nonexistent")).toBe(false);
    });

    it("stops all sessions", () => {
        const mgr = new SessionManager(serverConfig);
        const s1 = mgr.create({
            cwd: "/a",
            model: "sonnet",
            permissionMode: "default",
        });
        const s2 = mgr.create({
            cwd: "/b",
            model: "opus",
            permissionMode: "plan",
        });
        mgr.stopAll();
        expect(s1.getInfo().status).toBe("stopped");
        expect(s2.getInfo().status).toBe("stopped");
    });

    it("list returns SessionInfo objects", () => {
        const mgr = new SessionManager(serverConfig);
        mgr.create({
            cwd: "/tmp",
            model: "sonnet",
            permissionMode: "default",
            name: "My Session",
            tags: ["test"],
        });
        const list = mgr.list();
        expect(list[0].name).toBe("My Session");
        expect(list[0].model).toBe("sonnet");
        expect(list[0].tags).toEqual(["test"]);
    });
});
