import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionConfig, SessionInfo, SessionStatus } from "common/types";
import { LoggerService } from "../services/logger.service.js";
import { PtyService } from "../services/pty.service.js";
import { SessionBus } from "../services/session-bus.service.js";
import { TranscriptWatcher } from "../services/transcript.service.js";
import { TranscriptLocator } from "../services/transcript-locator.service.js";
import type { SessionDeps, SessionEvents } from "../types/index.js";
import { buildHooksConfig } from "../utils/hooks-config.js";
import { encodedProjectDir } from "../utils/project-sessions.js";

const log = LoggerService.scoped("session");

export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  readonly config: SessionConfig;
  readonly createdAt: number;
  readonly bus: SessionBus;
  private status: SessionStatus = "running";
  private pty: PtyService;
  private capturePath: string | null = null;
  private locator: TranscriptLocator;
  private transcript: TranscriptWatcher | null = null;

  constructor(config: SessionConfig, deps: SessionDeps) {
    super();
    this.id = randomUUID();
    this.config = config;
    this.createdAt = Date.now();
    this.bus = new SessionBus(this.id);
    this.pty = new PtyService();

    this.initCapture(deps.serverConfig.dataDir);

    this.pty.on("data", (data) => {
      this.captureRaw(data);
    });

    this.pty.on("exit", (info) => {
      this.setStatus("stopped");
      this.transcript?.stop();
      this.emit("exit", info);
    });

    if (config.resumeSessionId) {
      // Resume case: we already know the transcript file. Tail it directly and
      // replay history before the first live byte arrives. Also start the
      // locator in case Claude Code decides to write to a new file instead
      // of appending (observed behavior varies).
      const knownPath = join(encodedProjectDir(config.cwd), `${config.resumeSessionId}.jsonl`);
      this.transcript = new TranscriptWatcher(knownPath, this.bus);
      void this.transcript.start();
    }
    this.locator = new TranscriptLocator(config.cwd, (path) => {
      if (this.transcript && path.endsWith(`${config.resumeSessionId ?? ""}.jsonl`)) {
        return;
      }
      this.transcript?.stop();
      this.transcript = new TranscriptWatcher(path, this.bus);
      void this.transcript.start();
    });
    this.locator.start();

    log.info("Created", {
      id: this.id,
      cwd: config.cwd,
      model: config.model,
      permissionMode: config.permissionMode,
      resume: config.resumeSessionId,
    });

    this.pty.spawn({
      cwd: config.cwd,
      model: config.model,
      permissionMode: config.permissionMode,
      cols: deps.serverConfig.pty.cols,
      rows: deps.serverConfig.pty.rows,
      settingsJson: buildHooksConfig(deps.hooksBaseUrl, this.id),
      resumeSessionId: config.resumeSessionId,
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

  /** Shift+Tab — cycles Claude Code's permission mode (default → acceptEdits → plan). */
  cyclePermissionMode(): void {
    log.debug("Cycle permission mode", { id: this.id });
    this.pty.write("\x1b[Z");
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  stop(): void {
    log.info("Stopping", { id: this.id });
    this.locator.stop();
    this.transcript?.stop();
    this.pty.kill();
    this.setStatus("stopped");
    this.bus.dispose();
  }

  getInfo(): SessionInfo {
    return {
      id: this.id,
      name: this.config.name ?? (basename(this.config.cwd) || this.config.cwd),
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
