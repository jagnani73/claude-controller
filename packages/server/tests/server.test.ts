import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { ServerConfig } from "../src/types/index.js";

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

const { startServer } = await import("../src/server.js");
const { SessionManager } = await import(
    "../src/services/session-manager.service.js"
);

const serverConfig: ServerConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir: "./data",
    workDir: "/tmp",
    pty: { cols: 120, rows: 40 },
    ringBufferSize: 100,
};

describe("Server", () => {
    let server: { close: () => void };
    let sessionManager: InstanceType<typeof SessionManager>;

    beforeAll(() => {
        sessionManager = new SessionManager(serverConfig);
        server = startServer({ ...serverConfig, port: 3999 }, sessionManager);
    });

    afterAll(() => {
        server.close();
    });

    it("responds to health check", async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));

        const res = await fetch("http://127.0.0.1:3999/health");
        expect(res.status).toBe(200);

        const body = (await res.json()) as { status: string; sessions: number };
        expect(body.status).toBe("ok");
        expect(body.sessions).toBe(0);
    });

    it("returns 404 for unknown routes", async () => {
        const res = await fetch("http://127.0.0.1:3999/unknown");
        expect(res.status).toBe(404);
    });
});
