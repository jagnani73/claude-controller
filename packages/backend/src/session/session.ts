import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ClaudeModel,
  EffortLevel,
  SessionConfig,
  SessionInfo,
  SessionStatus,
} from "common/types";
import { LoggerService } from "../services/logger.service.js";
import { PtyService } from "../services/pty.service.js";
import { SessionBus } from "../services/session-bus.service.js";
import {
  ensureDumpScript,
  readDumpedPayload,
  resolveStatusLineCommand,
  runStatusLine,
  type StatusLinePayload,
  statusLinePayloadPath,
} from "../services/statusline.service.js";
import { TranscriptWatcher } from "../services/transcript.service.js";
import { TranscriptLocator } from "../services/transcript-locator.service.js";
import type { SessionDeps, SessionEvents } from "../types/index.js";
import { buildHooksConfig } from "../utils/hooks-config.js";
import { encodedProjectDir } from "../utils/project-sessions.js";

const log = LoggerService.scoped("session");

export class Session extends EventEmitter<SessionEvents> {
  /**
   * Internal token used for routing hooks/statusline/capture before we know
   * Claude Code's session id. Stable for the life of the Session instance.
   */
  readonly spawnToken: string;
  readonly config: SessionConfig;
  readonly createdAt: number;
  /** Resolves once Claude Code's session id is known AND (for resumes) the
   * initial transcript drain completed. */
  readonly ready: Promise<void>;
  private _id: string | null = null;
  private _bus: SessionBus | null = null;
  private status: SessionStatus = "running";
  private pty: PtyService;
  private capturePath: string | null = null;
  private locator: TranscriptLocator;
  private transcript: TranscriptWatcher | null = null;
  private currentModel: ClaudeModel;
  private currentEffort: EffortLevel | undefined;
  private statusLineTimer: NodeJS.Timeout | null = null;
  private lastStatusLine = "";
  private statusLinePayloadFile: string;

  get id(): string {
    if (!this._id) throw new Error("Session id not yet resolved");
    return this._id;
  }
  get bus(): SessionBus {
    if (!this._bus) throw new Error("Session bus not yet ready");
    return this._bus;
  }
  get resolved(): boolean {
    return this._id !== null;
  }

  constructor(config: SessionConfig, deps: SessionDeps) {
    super();
    this.spawnToken = randomUUID();
    this.config = config;
    this.currentModel = config.model;
    this.currentEffort = config.effort;
    this.createdAt = Date.now();
    this.pty = new PtyService();

    this.initCapture(deps.serverConfig.dumpDir);

    this.pty.on("data", (data) => {
      this.captureRaw(data);
    });

    this.pty.on("exit", (info) => {
      this.setStatus("stopped");
      this.transcript?.stop();
      this.emit("exit", info);
    });

    const idResolved = new Promise<void>((resolve) => {
      if (config.resumeSessionId) {
        this.resolveId(config.resumeSessionId);
        resolve();
        return;
      }
      this.once("idResolved", () => resolve());
    });

    let drainDone: Promise<void> = Promise.resolve();
    if (config.resumeSessionId) {
      const knownPath = join(encodedProjectDir(config.cwd), `${config.resumeSessionId}.jsonl`);
      this.transcript = new TranscriptWatcher(knownPath, this.bus);
      drainDone = this.transcript.start().catch((err) => {
        log.warn("Initial transcript drain failed", { token: this.spawnToken, error: err });
      });
    }
    this.ready = Promise.all([idResolved, drainDone]).then(() => undefined);

    this.locator = new TranscriptLocator(config.cwd, (path) => {
      const filename = basename(path);
      const discoveredId = filename.replace(/\.jsonl$/i, "");
      if (this._id) {
        if (this.transcript && path.endsWith(`${this._id}.jsonl`)) return;
        this.transcript?.stop();
        this.transcript = new TranscriptWatcher(path, this.bus);
        void this.transcript.start();
        return;
      }
      this.resolveId(discoveredId);
      this.transcript = new TranscriptWatcher(path, this.bus);
      void this.transcript.start();
    });
    this.locator.start();

    log.info("Created", {
      token: this.spawnToken,
      cwd: config.cwd,
      model: config.model,
      permissionMode: config.permissionMode,
      resume: config.resumeSessionId,
    });

    const dumpScriptPath = ensureDumpScript(deps.serverConfig.dumpDir);
    this.statusLinePayloadFile = statusLinePayloadPath(deps.serverConfig.dumpDir, this.spawnToken);

    this.pty.spawn({
      cwd: config.cwd,
      model: config.model,
      permissionMode: config.permissionMode,
      cols: deps.serverConfig.pty.cols,
      rows: deps.serverConfig.pty.rows,
      settingsJson: buildHooksConfig(deps.hooksBaseUrl, this.spawnToken, {
        statusLine: { dumpScriptPath, payloadFilePath: this.statusLinePayloadFile },
      }),
      resumeSessionId: config.resumeSessionId,
    });

    this.startStatusLinePolling();
  }

  private resolveId(id: string): void {
    if (this._id) return;
    this._id = id;
    this._bus = new SessionBus(id);
    log.info("Session id resolved", { token: this.spawnToken, id });
    this.emit("idResolved", id);
  }

  /** Latest rendered status-line output (raw, may contain ANSI). */
  getStatusLine(): string {
    return this.lastStatusLine;
  }

  private startStatusLinePolling(): void {
    const POLL_MS = 5000;
    let warnedMissing = false;
    const tick = async () => {
      const command = await resolveStatusLineCommand(this.config.cwd);
      if (!command) {
        if (!warnedMissing) {
          log.info("No statusLine configured", { token: this.spawnToken });
          warnedMissing = true;
        }
        return;
      }
      const dumped = await readDumpedPayload(this.statusLinePayloadFile);
      const payload: StatusLinePayload | string = dumped ?? this.buildStatusLinePayload();
      const output = await runStatusLine(command, payload);
      if (output == null) return;
      const trimmed = output.replace(/\r?\n$/, "");
      if (trimmed === this.lastStatusLine) return;
      this.lastStatusLine = trimmed;
      log.debug("Status line", { token: this.spawnToken, length: trimmed.length });
      this.emit("statusLine", trimmed);
    };
    void tick();
    this.statusLineTimer = setInterval(() => void tick(), POLL_MS);
  }

  private buildStatusLinePayload(): StatusLinePayload {
    const transcriptPath = this.transcript?.path ?? "";
    const modelId = this.transcript?.lastAssistantModel ?? this.currentModel;
    const windowSize = contextWindowSize(this.currentModel);
    const usage = this.transcript?.lastAssistantUsage ?? null;
    const currentUsage = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      : 0;
    const usedPct = windowSize > 0 ? (currentUsage / windowSize) * 100 : 0;
    return {
      session_id: this.config.resumeSessionId ?? this.id,
      transcript_path: transcriptPath,
      cwd: this.config.cwd,
      permission_mode: this.config.permissionMode,
      model: { id: modelId, display_name: modelDisplayName(this.currentModel) },
      workspace: {
        current_dir: this.config.cwd,
        project_dir: this.config.cwd,
        added_dirs: [],
      },
      output_style: { name: "default" },
      version: "",
      cost: {
        total_cost_usd: 0,
        total_duration_ms: 0,
        total_api_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      context_window: {
        total_input_tokens: this.transcript?.totalInputTokens ?? 0,
        total_output_tokens: this.transcript?.totalOutputTokens ?? 0,
        context_window_size: windowSize,
        current_usage: currentUsage,
        used_percentage: usedPct,
        remaining_percentage: Math.max(0, 100 - usedPct),
      },
      exceeds_200k_tokens: currentUsage > 200_000,
    };
  }

  sendInput(text: string): void {
    log.debug("Input", { token: this.spawnToken, text: text.slice(0, 500) });
    this.pty.write(`${text}\r`);
  }

  sendSlashCommand(command: string): void {
    const cmd = command.startsWith("/") ? command : `/${command}`;
    log.debug("Slash command", { token: this.spawnToken, command: cmd });
    this.pty.write(`${cmd}\r`);
  }

  setModel(model: ClaudeModel): void {
    if (model === this.currentModel) return;
    log.info("Set model", { token: this.spawnToken, model });
    this.currentModel = model;
    this.sendSlashCommand(`/model ${model}`);
    this.emit("metadataChanged");
  }

  setEffort(effort: EffortLevel): void {
    if (effort === this.currentEffort) return;
    log.info("Set effort", { token: this.spawnToken, effort });
    this.currentEffort = effort;
    this.sendSlashCommand(`/effort ${effort}`);
    this.emit("metadataChanged");
  }

  /** Shift+Tab — cycles Claude Code's permission mode (default → acceptEdits → plan). */
  cyclePermissionMode(): void {
    log.debug("Cycle permission mode", { token: this.spawnToken });
    this.pty.write("\x1b[Z");
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  stop(): void {
    log.info("Stopping", { token: this.spawnToken });
    if (this.statusLineTimer) {
      clearInterval(this.statusLineTimer);
      this.statusLineTimer = null;
    }
    this.locator.stop();
    this.transcript?.stop();
    this.pty.kill();
    this.setStatus("stopped");
    this._bus?.dispose();
  }

  /** Returns null until the Claude Code session id is resolved. */
  getInfo(): SessionInfo | null {
    if (!this._id) return null;
    return {
      id: this._id,
      name: this.config.name ?? (basename(this.config.cwd) || this.config.cwd),
      status: this.status,
      cwd: this.config.cwd,
      model: this.currentModel,
      permissionMode: this.config.permissionMode,
      effort: this.currentEffort,
      tags: this.config.tags ?? [],
      createdAt: this.createdAt,
    };
  }

  private initCapture(dumpDir: string): void {
    const dir = join(dumpDir, "captures");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      log.warn("Could not create captures dir", { dir });
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    const base = `${ts}_${this.spawnToken.slice(0, 8)}`;
    this.capturePath = join(dir, `${base}.raw`);
    log.info("Capture file", { raw: this.capturePath });
  }

  private captureRaw(data: string): void {
    if (!this.capturePath) return;
    appendFile(this.capturePath, data).catch(() => {});
  }

  private setStatus(status: SessionStatus): void {
    log.debug("Status change", {
      token: this.spawnToken,
      from: this.status,
      to: status,
    });
    this.status = status;
  }
}

function contextWindowSize(alias: ClaudeModel): number {
  return alias === "opus[1m]" || alias === "sonnet[1m]" ? 1_000_000 : 200_000;
}

function modelDisplayName(alias: ClaudeModel): string {
  switch (alias) {
    case "opus":
      return "Opus 4.7";
    case "opus[1m]":
      return "Opus 4.7 (1M context)";
    case "opusplan":
      return "Opus Plan";
    case "sonnet":
      return "Sonnet 4.6";
    case "sonnet[1m]":
      return "Sonnet 4.6 (1M context)";
    case "haiku":
      return "Haiku 4.5";
  }
}
