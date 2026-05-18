import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cycleCanIncludeAuto, cycleDistance } from "common/permission-cycle";
import type {
  ClaudeModel,
  EffortLevel,
  PermissionMode,
  RateLimitWindow,
  RespawnSettings,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  SessionStatusSnapshot,
} from "common/types";
import { LoggerService } from "../services/logger.service.js";
import { PtyService } from "../services/pty.service.js";
import { SessionBus } from "../services/session-bus.service.js";
import { SessionLocator } from "../services/session-locator.service.js";
import {
  ensureDumpScript,
  readDumpedPayload,
  resolveStatusLineCommand,
  runStatusLine,
  statusLinePayloadPath,
} from "../services/statusline.service.js";
import { TranscriptWatcher } from "../services/transcript.service.js";
import type { SessionDeps, SessionEvents } from "../types/index.js";
import { encodedProjectDir } from "../utils/claude-paths.js";
import { buildHooksConfig } from "../utils/hooks-config.js";

const log = LoggerService.scoped("session");

/** Delay between Shift+Tab keystrokes so Ink can process each before the next. */
const PERMISSION_CYCLE_STEP_MS = 80;

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
  private locator: SessionLocator | null = null;
  private transcript: TranscriptWatcher | null = null;
  private currentModel: ClaudeModel;
  private currentEffort: EffortLevel | undefined;
  private currentPermissionMode: PermissionMode;
  private statusLineTimer: NodeJS.Timeout | null = null;
  private statusLineWatcher: FSWatcher | null = null;
  private statusLineInFlight = false;
  private statusLinePending = false;
  private lastStatusLine = "";
  private statusLinePayloadFile: string;
  /** Latest model id observed in the transcript (e.g. "claude-opus-4-7"). */
  private currentModelId: string | null = null;
  private statusSnapshot: SessionStatusSnapshot | null = null;
  /** Set during respawn() so the PTY exit handler doesn't propagate "stopped". */
  private respawning = false;
  private readonly deps: SessionDeps;

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
    this.deps = deps;
    this.currentModel = config.model;
    // Fall back to user's global default when config omits effort.
    this.currentEffort = config.effort ?? readGlobalDefaultEffort();
    this.currentPermissionMode = config.permissionMode;
    this.createdAt = Date.now();
    this.pty = new PtyService();

    this.initCapture(deps.serverConfig.dumpDir);

    this.pty.on("data", (data) => {
      this.captureRaw(data);
    });

    this.pty.on("exit", (info) => {
      if (this.respawning) return;
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

    log.info("Created", {
      token: this.spawnToken,
      cwd: config.cwd,
      model: config.model,
      permissionMode: config.permissionMode,
      resume: config.resumeSessionId,
    });

    const dumpScriptPath = ensureDumpScript(deps.serverConfig.dumpDir);
    this.statusLinePayloadFile = statusLinePayloadPath(deps.serverConfig.dumpDir, this.spawnToken);

    const spawnedAt = Date.now();
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
      effort: this.currentEffort,
    });

    // Resume already knows the session id, so skip the locator. For fresh
    // spawns, watch ~/.claude/sessions/ — Claude Code v2.1.126+ writes
    // <pid>.json there on startup; we match by cwd + spawnedAt because the
    // pid in the file is claude.exe's, not the cmd.exe wrapper's pid.
    if (!config.resumeSessionId) this.startSessionLocator(spawnedAt);

    this.startStatusLinePolling();
  }

  private startSessionLocator(spawnedAt: number): void {
    this.locator = new SessionLocator(this.config.cwd, spawnedAt, (sessionId) => {
      if (this._id) return;
      this.resolveId(sessionId);
      const path = join(encodedProjectDir(this.config.cwd), `${sessionId}.jsonl`);
      this.transcript = new TranscriptWatcher(path, this.bus, this.handleModelChange);
      void this.transcript.start().catch((err) =>
        log.warn("Transcript watcher start failed", {
          token: this.spawnToken,
          error: (err as Error).message,
        }),
      );
    });
    this.locator.start();
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

    // Don't sync currentModel from runtime display_name — opusplan/haiku-in-plan
    // swap sub-models per render and would clobber the user's chosen alias.
    // Live sub-model is tracked separately on currentModelId / snapshot.

    if (statusSnapshotsEqual(this.statusSnapshot, snapshot)) return;
    this.statusSnapshot = snapshot;
    this.emit("metadataChanged");
  }

  private resolveId(id: string): void {
    if (this._id) return;
    this._id = id;
    this._bus = new SessionBus(id);
    // Mirror JSONL permission-mode entries onto our state so unrelated
    // metadataChanged broadcasts don't ship a stale config value.
    this._bus.on("event", (event) => {
      if (event.kind !== "permission_mode") return;
      const mode = event.mode as PermissionMode;
      if (this.currentPermissionMode === mode) return;
      this.currentPermissionMode = mode;
      this.emit("metadataChanged");
    });
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

  async sendInput(text: string): Promise<void> {
    log.debug("Input", { token: this.spawnToken, text: text.slice(0, 500) });
    // Post-interrupt redirect: when the prior turn was Esc'd before completion,
    // Claude Code's textarea retains the interrupted text and any new input gets
    // *appended* to it — the model then sees `<interrupted><redirect>` instead
    // of just the redirect. Ink ignores backspace bursts and readline shortcuts
    // here, so the only reliable way to get a clean textarea is to kill+respawn
    // the PTY (still --resumes the same session id, A stays in JSONL history).
    if (this.shouldSynthRedirect()) {
      log.debug("Force respawn for redirect", { token: this.spawnToken });
      await this._doRespawn();
    }
    // Wrap in bracketed-paste markers so multi-line text isn't split into
    // multiple submits. Claude Code's Ink UI enables bracketed paste mode
    // (\x1b[?2004h) on startup and accepts \x1b[200~…\x1b[201~ as a single
    // paste event — newlines stay intact inside the input textarea instead
    // of each one acting as Enter.
    this.pty.write(`\x1b[200~${text}\x1b[201~`);
    // Claude Code's input parser strips trailing `\r` from multi-char chunks
    // (treats it as SSH-coalesced Enter inserted into the textarea). Submission
    // only fires when `\r` arrives as its own keystroke — split into two writes.
    setTimeout(() => this.pty.write("\r"), 30);
  }

  /** True when the most recent user_prompt was interrupted with no assistant since. */
  private shouldSynthRedirect(): boolean {
    if (!this._bus) return false;
    const events = this._bus.getEventLog();
    let lastUserIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === "user_prompt") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return false;
    const after = events.slice(lastUserIdx + 1);
    const hadInterrupt = after.some((e) => e.kind === "interrupt");
    const hadAssistant = after.some((e) => e.kind === "assistant_text");
    return hadInterrupt && !hadAssistant;
  }

  async sendSlashCommand(command: string): Promise<void> {
    const cmd = command.startsWith("/") ? command : `/${command}`;
    log.debug("Slash command", { token: this.spawnToken, command: cmd });
    // Same post-interrupt textarea problem as sendInput — without a respawn,
    // the slash command appends to leftover interrupted text and Claude Code
    // submits the whole concat as a regular user_prompt instead of parsing
    // the slash. (Verified in 99369e68: "<spam>/effort high" landed as one
    // entry, model treated it as a paste-buffer issue.)
    if (this.shouldSynthRedirect()) {
      log.debug("Force respawn for slash redirect", { token: this.spawnToken });
      await this._doRespawn();
    }
    this.pty.write(cmd);
    setTimeout(() => this.pty.write("\r"), 30);
  }

  /**
   * Apply a new (model, effort, permissionMode) tuple by killing the PTY and
   * re-spawning it with `--resume <id>` plus the new args/env. Skips work when
   * nothing actually differs from the running PTY's spawn args.
   *
   * Permission mode preservation: passed explicitly via `--permission-mode`
   * so the resumed PTY starts in the same mode the user last selected.
   */
  async respawn(settings: RespawnSettings): Promise<void> {
    if (!this._id) {
      log.warn("Respawn requested before id resolved", { token: this.spawnToken });
      return;
    }
    const modelChanged = settings.model !== this.currentModel;
    const effortChanged = settings.effort !== this.currentEffort;
    const modeChanged = settings.permissionMode !== this.currentPermissionMode;
    if (!modelChanged && !effortChanged && !modeChanged) return;

    this.currentModel = settings.model;
    this.currentEffort = settings.effort;
    this.currentPermissionMode = settings.permissionMode;

    log.info("Respawn", {
      token: this.spawnToken,
      id: this._id,
      model: this.currentModel,
      effort: this.currentEffort,
      permissionMode: this.currentPermissionMode,
    });
    await this._doRespawn();
  }

  /**
   * Kill+respawn the PTY with `--resume <id>` and the current settings. Used
   * by the public respawn() (after the diff check) and by sendInput's
   * post-interrupt redirect path (forced — Claude Code's textarea would
   * otherwise prepend the interrupted text to the new input).
   */
  private async _doRespawn(): Promise<void> {
    if (!this._id) return;
    this.respawning = true;
    const exited = new Promise<void>((resolve) => {
      this.pty.once("exit", () => resolve());
    });
    // Immediate SIGKILL — Claude doesn't exit on one Ctrl+C and the 2s grace
    // is dead time the user sees as respawn latency. We're about to --resume
    // anyway; nothing graceful to preserve.
    this.pty.kill({ immediate: true });
    await exited;

    const dumpScriptPath = ensureDumpScript(this.deps.serverConfig.dumpDir);
    const spawnedAt = Date.now();
    this.pty.spawn({
      cwd: this.config.cwd,
      model: this.currentModel,
      permissionMode: this.currentPermissionMode,
      cols: this.deps.serverConfig.pty.cols,
      rows: this.deps.serverConfig.pty.rows,
      settingsJson: buildHooksConfig(this.deps.hooksBaseUrl, this.spawnToken, {
        statusLine: { dumpScriptPath, payloadFilePath: this.statusLinePayloadFile },
      }),
      resumeSessionId: this._id,
      forceModel: true,
      effort: this.currentEffort,
    });
    // Claude Code takes a few seconds to boot before it reads stdin: it writes
    // a `--resume` synthetic block to the JSONL (continue-from-here marker,
    // attachments, /remote-control system message, ...) and only attaches its
    // stdin reader once that's settled. Writing input earlier is silently
    // dropped — the user sees "I changed settings, sent a message, nothing
    // happened." Wait for the bus to receive a new transcript event after our
    // spawnedAt, then for an 800ms quiet period (= Claude stopped writing).
    await this.waitForReady(spawnedAt);
    this.respawning = false;
    this.emit("metadataChanged");
  }

  private waitForReady(spawnedAt: number): Promise<void> {
    const READY_TIMEOUT_MS = 8_000;
    const QUIET_MS = 400;
    const bus = this._bus;
    if (!bus) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        bus.off("event", onEvent);
        if (quietTimer) clearTimeout(quietTimer);
        clearTimeout(timer);
        resolve();
      };
      const onEvent = (event: { timestamp: string }) => {
        const ts = Date.parse(event.timestamp);
        if (!Number.isFinite(ts) || ts < spawnedAt) return;
        // Reset the quiet timer — Claude is still actively writing the resume block.
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, QUIET_MS);
      };
      bus.on("event", onEvent);
      const timer = setTimeout(() => {
        log.warn("Respawn ready-wait timed out — forwarding anyway", {
          token: this.spawnToken,
        });
        finish();
      }, READY_TIMEOUT_MS);
    });
  }

  /**
   * Walk Claude Code's permission-mode cycle to `target` by writing the
   * right number of Shift+Tab keystrokes (`\x1b[Z`) into the PTY, paced
   * so Ink can process each before the next arrives. Sets
   * `currentPermissionMode` optimistically and emits `metadataChanged`
   * so concurrent `session_metadata` broadcasts (e.g. statusline
   * re-renders triggered by the same keystrokes) carry the intended
   * value rather than the pre-cycle one. JSONL's `permission-mode`
   * entry still arrives via the transcript watcher and is the
   * canonical correction if reality diverges.
   */
  setPermissionMode(target: PermissionMode): void {
    const from = this.currentPermissionMode;
    if (from === target) return;
    const autoAvailable = cycleCanIncludeAuto(this.currentModel);
    const steps = cycleDistance(from, target, { autoAvailable });
    if (steps === 0) {
      log.warn("Permission mode target unreachable from current", {
        token: this.spawnToken,
        from,
        target,
        model: this.currentModel,
      });
      return;
    }
    log.debug("Set permission mode", { token: this.spawnToken, from, target, steps });
    this.currentPermissionMode = target;
    this.emit("metadataChanged");
    for (let i = 0; i < steps; i++) {
      setTimeout(() => this.pty.write("\x1b[Z"), i * PERMISSION_CYCLE_STEP_MS);
    }
  }

  /**
   * Single Esc — interrupts Claude's current turn at the PTY (writes `\x1b`)
   * and pushes a synthesized `interrupt` event onto the bus so subscribers
   * (and reload/replay) see the terminal marker. Claude Code itself doesn't
   * write anything we can parse into the JSONL on Esc, so without this the
   * thinking spinner would keep spinning forever after an interrupt and a
   * page refresh would lose the visual entirely.
   *
   * Idle gate: only push the bubble if there's actually an in-flight turn
   * (most recent user_prompt has no terminal event after it). Otherwise an
   * idle Esc — e.g. on the home screen, or right after switching to a
   * settled session — would strand an "Interrupted" marker. The PTY write
   * still fires either way; it's a no-op for Claude when nothing's running.
   */
  interrupt(): void {
    log.debug("Interrupt", { token: this.spawnToken });
    this.pty.write("\x1b");
    if (!this._bus) return;
    if (!this.hasInFlightTurn()) return;
    this._bus.push({
      kind: "interrupt",
      sessionId: this._bus.sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  /** True iff the most recent user_prompt has no terminal event after it. */
  private hasInFlightTurn(): boolean {
    if (!this._bus) return false;
    const events = this._bus.getEventLog();
    let lastUserIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === "user_prompt") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return false;
    const TERMINAL: ReadonlySet<string> = new Set([
      "assistant_text",
      "compact_summary",
      "slash_command",
      "interrupt",
    ]);
    for (let i = lastUserIdx + 1; i < events.length; i++) {
      if (TERMINAL.has(events[i].kind)) return false;
    }
    return true;
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
    this.locator?.stop();
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
      permissionMode: this.currentPermissionMode,
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

// "auto" intentionally excluded — it means "no override," matching pty.service's
// "skip env var" branch.
const VALID_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

// Read fresh on every call — settings.json *can* change mid-process now that
// the controller mirrors `/effort` writes back to disk. settings.json is small,
// the read is sync and cheap, and stale cached values would silently ignore
// the user's slash-command updates for new sessions.
function readGlobalDefaultEffort(): EffortLevel | undefined {
  try {
    const raw = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { effortLevel?: unknown };
    const v = parsed.effortLevel;
    if (typeof v === "string" && VALID_EFFORTS.has(v)) return v as EffortLevel;
  } catch {}
  return undefined;
}
