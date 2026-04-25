import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  ClaudeModel,
  EffortLevel,
  RateLimitWindow,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  SessionStatusSnapshot,
} from "common/types";
import { LoggerService } from "../services/logger.service.js";
import { PtyService } from "../services/pty.service.js";
import { SessionBus } from "../services/session-bus.service.js";
import {
  ensureDumpScript,
  readDumpedPayload,
  resolveStatusLineCommand,
  runStatusLine,
  statusLinePayloadPath,
} from "../services/statusline.service.js";
import { TranscriptWatcher } from "../services/transcript.service.js";
import { TranscriptLocator } from "../services/transcript-locator.service.js";
import type { SessionDeps, SessionEvents } from "../types/index.js";
import { encodedProjectDir } from "../utils/claude-paths.js";
import { buildHooksConfig } from "../utils/hooks-config.js";

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
  private statusLineWatcher: FSWatcher | null = null;
  private statusLineInFlight = false;
  private statusLinePending = false;
  private lastStatusLine = "";
  private statusLinePayloadFile: string;
  /** Latest model id observed in the transcript (e.g. "claude-opus-4-7"). */
  private currentModelId: string | null = null;
  private statusSnapshot: SessionStatusSnapshot | null = null;

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
    // Fall back to user's global default when config omits effort.
    this.currentEffort = config.effort ?? readGlobalDefaultEffort();
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
      this.transcript = new TranscriptWatcher(knownPath, this.bus, this.handleModelChange);
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
      this.transcript = new TranscriptWatcher(path, this.bus, this.handleModelChange);
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

  private handleModelChange = (model: string): void => {
    if (this.currentModelId === model) return;
    log.info("Model changed", { token: this.spawnToken, model });
    this.currentModelId = model;
    this.emit("metadataChanged");
  };

  // Diff-then-emit because Claude Code rewrites the dump on every render,
  // and downstream metadataChanged listeners trigger session_metadata broadcasts.
  private absorbDumpedPayload(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const p = parsed as Record<string, unknown>;
    const pick = (path: string): unknown =>
      path.split(".").reduce<unknown>((acc, key) => {
        if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
        return undefined;
      }, p);

    const numOrUndef = (v: unknown): number | undefined => {
      const n = typeof v === "string" ? Number(v) : (v as number);
      return Number.isFinite(n) ? (n as number) : undefined;
    };
    const window = (path: string) => {
      const used = numOrUndef(pick(`${path}.used_percentage`));
      const resets = numOrUndef(pick(`${path}.resets_at`));
      if (used === undefined || resets === undefined) return undefined;
      return { usedPercentage: used, resetsAt: resets };
    };

    const snapshot: SessionStatusSnapshot = {
      modelDisplayName:
        typeof pick("model.display_name") === "string"
          ? (pick("model.display_name") as string)
          : undefined,
      contextUsedPercentage: numOrUndef(pick("context_window.used_percentage")),
      totalInputTokens: numOrUndef(pick("context_window.total_input_tokens")),
      totalOutputTokens: numOrUndef(pick("context_window.total_output_tokens")),
      costUsd: numOrUndef(pick("cost.total_cost_usd")),
      fiveHour: window("rate_limits.five_hour"),
      sevenDay: window("rate_limits.seven_day"),
    };

    if (statusSnapshotsEqual(this.statusSnapshot, snapshot)) return;
    this.statusSnapshot = snapshot;
    this.emit("metadataChanged");
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

  /**
   * Status line is driven by Claude Code itself: it invokes our injected
   * dump script every time it re-renders its statusline, which writes the
   * authoritative payload JSON to disk. We `fs.watch` the parent dir and
   * pick up each write reactively — no stale-data window from a poll loop.
   *
   * A 30s safety-net interval covers the case where the OS swallows a watch
   * event (rare on Windows under heavy I/O).
   */
  private startStatusLinePolling(): void {
    const SAFETY_INTERVAL_MS = 30_000;
    let warnedMissing = false;

    const tick = async () => {
      if (!this.resolved) return;
      if (this.statusLineInFlight) {
        this.statusLinePending = true;
        return;
      }
      this.statusLineInFlight = true;
      try {
        const command = await resolveStatusLineCommand(this.config.cwd);
        if (!command) {
          if (!warnedMissing) {
            log.info("No statusLine configured", { token: this.spawnToken });
            warnedMissing = true;
          }
          return;
        }
        const dumped = await readDumpedPayload(this.statusLinePayloadFile);
        // Refuse to render until Claude Code's first authoritative payload
        // lands — anything earlier would be synthesized from create-time
        // defaults (model alias, ctx 0%) and mislead the user.
        if (!dumped) return;
        this.absorbDumpedPayload(dumped);
        const output = await runStatusLine(command, dumped);
        if (output == null) return;
        const trimmed = output.replace(/\r?\n$/, "");
        if (trimmed === this.lastStatusLine) return;
        this.lastStatusLine = trimmed;
        log.debug("Status line", { token: this.spawnToken, length: trimmed.length });
        this.emit("statusLine", trimmed);
      } finally {
        this.statusLineInFlight = false;
        if (this.statusLinePending) {
          this.statusLinePending = false;
          void tick().catch((err) =>
            log.warn("status-line tick failed", {
              token: this.spawnToken,
              error: (err as Error).message,
            }),
          );
        }
      }
    };

    const safeTick = () =>
      void tick().catch((err) =>
        log.warn("status-line tick failed", {
          token: this.spawnToken,
          error: (err as Error).message,
        }),
      );

    // Ensure the parent dir exists so watch() doesn't throw before Claude
    // Code's first write creates the file.
    const watchDir = dirname(this.statusLinePayloadFile);
    const watchFile = basename(this.statusLinePayloadFile);
    try {
      mkdirSync(watchDir, { recursive: true });
      this.statusLineWatcher = watch(watchDir, (_event, filename) => {
        if (!filename) return;
        if (filename.toString() === watchFile) safeTick();
      });
      this.statusLineWatcher.on("error", (err) => {
        log.warn("status-line watcher error", {
          token: this.spawnToken,
          error: err.message,
        });
      });
    } catch (err) {
      log.warn("Could not watch dump dir", {
        dir: watchDir,
        error: (err as Error).message,
      });
    }

    safeTick();
    this.statusLineTimer = setInterval(safeTick, SAFETY_INTERVAL_MS);
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
    if (this.statusLineWatcher) {
      this.statusLineWatcher.close();
      this.statusLineWatcher = null;
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
      currentModelId: this.currentModelId ?? undefined,
      permissionMode: this.config.permissionMode,
      effort: this.currentEffort,
      tags: this.config.tags ?? [],
      createdAt: this.createdAt,
      statusSnapshot: this.statusSnapshot ?? undefined,
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

function rateWindowEqual(a: RateLimitWindow | undefined, b: RateLimitWindow | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.usedPercentage === b.usedPercentage && a.resetsAt === b.resetsAt;
}

function statusSnapshotsEqual(a: SessionStatusSnapshot | null, b: SessionStatusSnapshot): boolean {
  if (!a) return false;
  return (
    a.modelDisplayName === b.modelDisplayName &&
    a.contextUsedPercentage === b.contextUsedPercentage &&
    a.totalInputTokens === b.totalInputTokens &&
    a.totalOutputTokens === b.totalOutputTokens &&
    a.costUsd === b.costUsd &&
    rateWindowEqual(a.fiveHour, b.fiveHour) &&
    rateWindowEqual(a.sevenDay, b.sevenDay)
  );
}

const VALID_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "max"]);

// Cached: settings.json doesn't change mid-process, so a single sync read
// at first access beats a fresh read on every Session construction.
let cachedDefaultEffort: EffortLevel | undefined | null = null;

function readGlobalDefaultEffort(): EffortLevel | undefined {
  if (cachedDefaultEffort !== null) return cachedDefaultEffort;
  try {
    const raw = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { effortLevel?: unknown };
    const v = parsed.effortLevel;
    if (typeof v === "string" && VALID_EFFORTS.has(v)) {
      cachedDefaultEffort = v as EffortLevel;
      return cachedDefaultEffort;
    }
  } catch {}
  cachedDefaultEffort = undefined;
  return undefined;
}
