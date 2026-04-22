import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfig, SessionInfo, SessionStatus } from "common/types";
import { LoggerService } from "../services/logger.service.js";
import { PtyService } from "../services/pty.service.js";
import { SessionBus } from "../services/session-bus.service.js";
import type { ServerConfig, SessionEvents } from "../types/index.js";
import { buildHooksConfig } from "../utils/hooks-config.js";

const log = LoggerService.scoped("session");

export interface SessionDeps {
  serverConfig: ServerConfig;
  hooksBaseUrl: string;
}

export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  readonly config: SessionConfig;
  readonly createdAt: number;
  readonly bus: SessionBus;
  private status: SessionStatus = "running";
  private pty: PtyService;
  private capturePath: string | null = null;

  constructor(config: SessionConfig, deps: SessionDeps) {
    super();
    this.id = randomUUID();
    this.config = config;
    this.createdAt = Date.now();
    this.bus = new SessionBus(this.id);
    this.pty = new PtyService();

    this.initCapture(deps.serverConfig.dataDir);

    this.pty.on("data", (data) => {
      // Raw PTY stdout is still captured to disk for debugging, but
      // nothing parses it — content comes from hooks + transcript tail.
      this.captureRaw(data);
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
      cols: deps.serverConfig.pty.cols,
      rows: deps.serverConfig.pty.rows,
      settingsJson: buildHooksConfig(deps.hooksBaseUrl, this.id),
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

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  stop(): void {
    log.info("Stopping", { id: this.id });
    this.pty.kill();
    this.setStatus("stopped");
    this.bus.dispose();
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
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    const base = `${ts}_${this.id.slice(0, 8)}`;
    this.capturePath = join(dir, `${base}.raw`);
    log.info("Capture file", { raw: this.capturePath });
  }

  private captureRaw(data: string): void {
    if (!this.capturePath) return;
    appendFile(this.capturePath, data).catch(() => {});
  }

  private setStatus(status: SessionStatus): void {
    log.debug("Status change", {
      id: this.id,
      from: this.status,
      to: status,
    });
    this.status = status;
  }
}
