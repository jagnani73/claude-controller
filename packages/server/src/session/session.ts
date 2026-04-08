import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfig, SessionInfo, SessionStatus } from "common/types";
import { LoggerService } from "../services/logger.service.js";
import { ParserService } from "../services/parser.service.js";
import { PtyService } from "../services/pty.service.js";
import type { ServerConfig, SessionEvents } from "../types/index.js";
import { RingBuffer } from "../utils/ring-buffer.js";

const log = LoggerService.scoped("session");

export class Session extends EventEmitter<SessionEvents> {
    readonly id: string;
    readonly config: SessionConfig;
    readonly createdAt: number;
    private status: SessionStatus = "running";
    private pty: PtyService;
    private parser: ParserService;
    private outputBuffer: RingBuffer<string>;
    private capturePath: string | null = null;
    private parsedCapturePath: string | null = null;

    constructor(config: SessionConfig, serverConfig: ServerConfig) {
        super();
        this.id = randomUUID();
        this.config = config;
        this.createdAt = Date.now();
        this.outputBuffer = new RingBuffer<string>(serverConfig.ringBufferSize);
        this.pty = new PtyService();
        this.parser = new ParserService();

        this.initCapture(serverConfig.dataDir);

        this.parser.onParsed((text) => {
            log.debug("Parsed", { id: this.id, text: text.slice(0, 500) });
            this.captureParsed(text);
        });

        this.pty.on("data", (data) => {
            log.debug("Raw output", { id: this.id, bytes: data.length });
            this.outputBuffer.push(data);
            this.emit("output", data);
            this.captureRaw(data);
            this.parser.feed(data);
        });

        this.pty.on("exit", (info) => {
            this.setStatus("stopped");
            this.emit("exit", info);
        });

        log.info("Created", {
            id: this.id,
            cwd: config.cwd,
            model: config.model,
            permissionMode: config.permissionMode,
        });

        this.pty.spawn({
            cwd: config.cwd,
            model: config.model,
            permissionMode: config.permissionMode,
            cols: serverConfig.pty.cols,
            rows: serverConfig.pty.rows,
        });
    }

    sendInput(text: string): void {
        log.debug("Input", { id: this.id, text: text.slice(0, 500) });
        this.pty.write(`${text}\r`);
    }

    sendSlashCommand(command: string): void {
        const cmd = command.startsWith("/") ? command : `/${command}`;
        log.debug("Slash command", { id: this.id, command: cmd });
        this.pty.write(`${cmd}\r`);
    }

    approve(): void {
        log.info("Approve", { id: this.id });
        this.pty.write("y\r");
    }

    deny(): void {
        log.info("Deny", { id: this.id });
        this.pty.write("n\r");
    }

    resize(cols: number, rows: number): void {
        this.pty.resize(cols, rows);
    }

    stop(): void {
        log.info("Stopping", { id: this.id });
        this.pty.kill();
        this.setStatus("stopped");
    }

    getReplayBuffer(): string[] {
        return this.outputBuffer.toArray();
    }

    getInfo(): SessionInfo {
        return {
            id: this.id,
            name: this.config.name ?? this.config.cwd,
            status: this.status,
            cwd: this.config.cwd,
            model: this.config.model,
            permissionMode: this.config.permissionMode,
            tags: this.config.tags ?? [],
            createdAt: this.createdAt,
        };
    }

    private initCapture(dataDir: string): void {
        const dir = join(dataDir, "captures");
        try {
            mkdirSync(dir, { recursive: true });
        } catch {
            log.warn("Could not create captures dir", { dir });
            return;
        }
        const ts = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .replace("T", "_")
            .replace("Z", "");
        const base = `${ts}_${this.id.slice(0, 8)}`;
        this.capturePath = join(dir, `${base}.raw`);
        this.parsedCapturePath = join(dir, `${base}.parsed`);
        log.info("Capture files", {
            raw: this.capturePath,
            parsed: this.parsedCapturePath,
        });
    }

    private captureRaw(data: string): void {
        if (!this.capturePath) return;
        appendFile(this.capturePath, data).catch(() => {});
    }

    private captureParsed(text: string): void {
        if (!this.parsedCapturePath) return;
        appendFile(this.parsedCapturePath, `${text}\n`).catch(() => {});
    }

    private setStatus(status: SessionStatus): void {
        log.debug("Status change", {
            id: this.id,
            from: this.status,
            to: status,
        });
        this.status = status;
        this.emit("status", status);
    }
}
