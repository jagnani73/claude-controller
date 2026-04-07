import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { SessionConfig, SessionInfo, SessionStatus } from "common/types";
import { LoggerService } from "../services/logger.service.js";
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
    private outputBuffer: RingBuffer<string>;

    constructor(config: SessionConfig, serverConfig: ServerConfig) {
        super();
        this.id = randomUUID();
        this.config = config;
        this.createdAt = Date.now();
        this.outputBuffer = new RingBuffer<string>(serverConfig.ringBufferSize);
        this.pty = new PtyService();

        this.pty.on("data", (data) => {
            this.outputBuffer.push(data);
            this.emit("output", data);
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
        log.debug("Input", { id: this.id, length: text.length });
        this.pty.write(`${text}\n`);
    }

    sendSlashCommand(command: string): void {
        const cmd = command.startsWith("/") ? command : `/${command}`;
        log.debug("Slash command", { id: this.id, command: cmd });
        this.pty.write(`${cmd}\n`);
    }

    approve(): void {
        log.info("Approve", { id: this.id });
        this.pty.write("y\n");
    }

    deny(): void {
        log.info("Deny", { id: this.id });
        this.pty.write("n\n");
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
