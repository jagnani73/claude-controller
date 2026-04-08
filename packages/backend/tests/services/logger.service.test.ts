import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LoggerService } from "../../src/services/logger.service.js";

describe("LoggerService", () => {
    let stdoutOutput: string[];
    let stderrOutput: string[];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrWrite = process.stderr.write.bind(process.stderr);

    beforeEach(() => {
        stdoutOutput = [];
        stderrOutput = [];
        process.stdout.write = ((data: string) => {
            stdoutOutput.push(data);
            return true;
        }) as typeof process.stdout.write;
        process.stderr.write = ((data: string) => {
            stderrOutput.push(data);
            return true;
        }) as typeof process.stderr.write;
    });

    afterEach(() => {
        process.stdout.write = originalWrite;
        process.stderr.write = originalErrWrite;
    });

    it("logs info to stdout", () => {
        LoggerService.info("test message");
        expect(stdoutOutput).toHaveLength(1);
        expect(stdoutOutput[0]).toContain("INFO");
        expect(stdoutOutput[0]).toContain("test message");
    });

    it("logs debug to stdout", () => {
        LoggerService.debug("debug msg");
        expect(stdoutOutput).toHaveLength(1);
        expect(stdoutOutput[0]).toContain("DEBUG");
    });

    it("logs warn to stderr", () => {
        LoggerService.warn("warning");
        expect(stderrOutput).toHaveLength(1);
        expect(stderrOutput[0]).toContain("WARN");
    });

    it("logs error to stderr", () => {
        LoggerService.error("failure");
        expect(stderrOutput).toHaveLength(1);
        expect(stderrOutput[0]).toContain("ERROR");
    });

    it("includes metadata as JSON", () => {
        LoggerService.info("with meta", { key: "value" });
        expect(stdoutOutput[0]).toContain('{"key":"value"}');
    });

    it("serializes Error objects in metadata", () => {
        const err = new Error("test error");
        LoggerService.error("failed", { error: err });
        expect(stderrOutput[0]).toContain("test error");
    });

    it("creates scoped loggers", () => {
        const log = LoggerService.scoped("my-scope");
        log.info("scoped message");
        expect(stdoutOutput[0]).toContain("(my-scope)");
        expect(stdoutOutput[0]).toContain("scoped message");
    });

    it("creates nested scoped loggers with :: separator", () => {
        const parent = LoggerService.scoped("parent");
        const child = parent.scoped("child");
        child.info("nested");
        expect(stdoutOutput[0]).toContain("(parent::child)");
    });

    it("merges default metadata with per-call metadata", () => {
        const log = LoggerService.scoped("test", { defaultKey: "default" });
        log.info("msg", { callKey: "call" });
        expect(stdoutOutput[0]).toContain('"defaultKey":"default"');
        expect(stdoutOutput[0]).toContain('"callKey":"call"');
    });

    it("includes ISO timestamp", () => {
        LoggerService.info("ts test");
        // ISO format: 2026-04-08T...
        expect(stdoutOutput[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it("does not log when level is filtered out", () => {
        const origLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = "error";

        LoggerService.info("should not appear");
        LoggerService.debug("should not appear");
        expect(stdoutOutput).toHaveLength(0);

        LoggerService.error("should appear");
        expect(stderrOutput).toHaveLength(1);

        if (origLevel) {
            process.env.LOG_LEVEL = origLevel;
        } else {
            Reflect.deleteProperty(process.env, "LOG_LEVEL");
        }
    });
});
