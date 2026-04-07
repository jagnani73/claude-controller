import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
    "PORT",
    "HOST",
    "DATA_DIR",
    "PTY_COLS",
    "PTY_ROWS",
    "RING_BUFFER_SIZE",
] as const;

describe("loadConfig", () => {
    const saved = new Map<string, string>();

    beforeEach(() => {
        saved.clear();
        for (const key of ENV_KEYS) {
            if (key in process.env) {
                saved.set(key, process.env[key] as string);
            }
            Reflect.deleteProperty(process.env, key);
        }
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            Reflect.deleteProperty(process.env, key);
        }
        for (const [key, val] of saved) {
            process.env[key] = val;
        }
    });

    it("returns defaults when no env vars set", () => {
        const config = loadConfig();
        expect(config.port).toBe(3000);
        expect(config.host).toBe("0.0.0.0");
        expect(config.dataDir).toBe("./data");
        expect(config.pty.cols).toBe(120);
        expect(config.pty.rows).toBe(40);
        expect(config.ringBufferSize).toBe(500);
    });

    it("reads PORT from env", () => {
        process.env.PORT = "8080";
        const config = loadConfig();
        expect(config.port).toBe(8080);
    });

    it("reads HOST from env", () => {
        process.env.HOST = "127.0.0.1";
        const config = loadConfig();
        expect(config.host).toBe("127.0.0.1");
    });

    it("reads DATA_DIR from env", () => {
        process.env.DATA_DIR = "/tmp/data";
        const config = loadConfig();
        expect(config.dataDir).toBe("/tmp/data");
    });

    it("reads PTY dimensions from env", () => {
        process.env.PTY_COLS = "200";
        process.env.PTY_ROWS = "60";
        const config = loadConfig();
        expect(config.pty.cols).toBe(200);
        expect(config.pty.rows).toBe(60);
    });

    it("reads RING_BUFFER_SIZE from env", () => {
        process.env.RING_BUFFER_SIZE = "1000";
        const config = loadConfig();
        expect(config.ringBufferSize).toBe(1000);
    });
});
