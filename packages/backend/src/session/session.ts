import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WriteStream } from "node:fs";
import { createWriteStream, type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { reconcileModelAlias } from "common/model";
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
import {
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_TARGET_VERSION,
  classifyCliVersion,
  isBelowMinimumVersion,
} from "common/version";
import { LoggerService } from "../services/logger.service.js";
import { PtyService } from "../services/pty.service.js";
import { CHUNK_DELAY_MS, type KeystrokeChunk } from "../services/question.input.js";
import { SessionBus, type SessionBusEvent } from "../services/session-bus.service.js";
import { SessionLocator } from "../services/session-locator.service.js";
import {
  readDumpedPayload,
  resolveStatusLineCommand,
  runStatusLine,
  statusLineDumpScriptPath,
  statusLinePayloadPath,
} from "../services/statusline.service.js";
import { TranscriptWatcher } from "../services/transcript.service.js";
import type { SessionDeps, SessionEvents } from "../types/index.js";
import { resolveTranscriptPath } from "../utils/claude-paths.js";
import { buildHooksConfig } from "../utils/hooks-config.js";

const log = LoggerService.scoped("session");

/** Delay between Shift+Tab keystrokes so Ink can process each before the next. */
const PERMISSION_CYCLE_STEP_MS = 80;

/** How many times sendInput resends the submit `\r` while waiting for the
 *  prompt to register in the transcript (see submitWithConfirmation). */
const SUBMIT_MAX_ATTEMPTS = 5;
/** Pacing between submit `\r` resends — retry cadence, not a correctness knob. */
const SUBMIT_RETRY_MS = 250;

/** Resend cadence for confirming an AskUserQuestion answer landed (see
 *  answerQuestion). A bit longer than the prompt path — the submit closes the
 *  picker, then Claude writes the tool_result and the watcher tails it. */
const QUESTION_SUBMIT_ATTEMPTS = 4;
const QUESTION_SUBMIT_RETRY_MS = 500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  private captureStream: WriteStream | null = null;
  private locator: SessionLocator | null = null;
  private transcript: TranscriptWatcher | null = null;
  private currentModel: ClaudeModel;
  private currentEffort: EffortLevel | undefined;
  private currentPermissionMode: PermissionMode;
  /**
   * A model/effort pick made in the controller that hasn't been applied to the
   * running PTY yet (applied on the next message via respawn). Held here so the
   * UI can show "will switch to X"; reconciliation is suppressed while set.
   * `null` = no pending value (model/effort already reflect the applied state).
   */
  private pendingModel: ClaudeModel | null = null;
  private pendingEffort: EffortLevel | null = null;
  private statusLineTimer: NodeJS.Timeout | null = null;
  private statusLineWatcher: FSWatcher | null = null;
  private statusLineInFlight = false;
  private statusLinePending = false;
  private lastStatusLine = "";
  /** Last raw payload processed — skip redundant absorb + statusline spawn. */
  private lastDumpedPayload: string | null = null;
  /** Resolved statusline command, cached after first non-null lookup. */
  private cachedStatusLineCommand: string | null = null;
  private statusLinePayloadFile: string;
  /** Latest model id observed in the transcript (e.g. "claude-opus-4-7"). */
  private currentModelId: string | null = null;
  /** CLI build driving this session, read from the transcript (see handleCliVersion). */
  private cliVersion: string | null = null;
  /** Warn once per observed version, not once per session — a resume can span an upgrade. */
  private warnedCliVersion: string | null = null;
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
  /** The model alias the PTY is currently running (not the pending pick). */
  get model(): ClaudeModel {
    return this.currentModel;
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

    if (deps.serverConfig.capturePty) {
      this.initCapture(deps.serverConfig.dumpDir);
    }

    this.pty.on("data", (data) => {
      this.captureRaw(data);
    });

    this.pty.on("exit", (info) => {
      if (this.respawning) return;
      this.teardownStatusLineAndCapture();
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
      const knownPath = resolveTranscriptPath(config.cwd, config.resumeSessionId);
      this.transcript = new TranscriptWatcher(
        knownPath,
        this.bus,
        this.handleModelChange,
        this.handleCliVersion,
      );
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

    const dumpScriptPath = statusLineDumpScriptPath();
    this.statusLinePayloadFile = statusLinePayloadPath(deps.serverConfig.dumpDir, this.spawnToken);

    const spawnedAt = Date.now();
    this.pty.spawn({
      cwd: config.cwd,
      claudeBin: deps.serverConfig.claudeBin,
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
      const path = resolveTranscriptPath(this.config.cwd, sessionId);
      this.transcript = new TranscriptWatcher(
        path,
        this.bus,
        this.handleModelChange,
        this.handleCliVersion,
      );
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
    // Reconcile the stored alias against the real model observed in the
    // transcript — fixes a family mismatch from an out-of-band `/model` change
    // or a wrong resume default. Transcript-only on purpose: the statusline is a
    // render target, not a source of app state. The model id carries the family
    // but not the 1M variant, so a same-family alias (incl. `opus[1m]`) is
    // preserved and only a true family mismatch is corrected.
    this.reconcileModelFromRuntime();
    this.emit("metadataChanged");
  };

  /**
   * Record which Claude Code build is actually driving this session and warn if
   * it isn't the one we're verified against.
   *
   * This matters because the controller spawns `claude` off PATH (or
   * `CLAUDE_BIN`), so the binary that runs is decided by the environment, not by
   * us — a machine with two installs can silently drive a build our keystroke
   * relays were never tested on. A mismatch is not fatal and must not block the
   * session: most versions change nothing we depend on. It's logged at warn and
   * surfaced on `SessionInfo` so the drift is visible when a picker or the
   * transcript parse starts misbehaving.
   */
  private handleCliVersion = (version: string): void => {
    if (this.cliVersion === version) return;
    this.cliVersion = version;
    const status = classifyCliVersion(version);
    if (isBelowMinimumVersion(version) && this.warnedCliVersion !== version) {
      this.warnedCliVersion = version;
      // Escalated above a plain mismatch: below the floor the AskUserQuestion
      // relay produces wrong answers rather than failing, so this is a
      // correctness problem the operator has to see, not version drift.
      log.error("Claude Code predates fixes the question relay needs", {
        token: this.spawnToken,
        observed: version,
        minimum: CLAUDE_CODE_MINIMUM_VERSION,
        impact: "AskUserQuestion answers may be silently wrong",
      });
    } else if (status !== "match" && this.warnedCliVersion !== version) {
      this.warnedCliVersion = version;
      log.warn("Claude Code version differs from the verified target", {
        token: this.spawnToken,
        observed: version,
        target: CLAUDE_CODE_TARGET_VERSION,
        status,
      });
    } else if (status === "match") {
      log.info("Claude Code version", { token: this.spawnToken, version });
    }
    this.emit("metadataChanged");
  };

  /**
   * Correct `currentModel` when the model observed in the transcript is a
   * different family than the stored alias — a stale alias from an out-of-band
   * `/model` change or a wrong resume default. No-op while respawning or while a
   * pending pick is unapplied, and preserves opusplan/haiku-in-plan (their valid
   * sub-model resolutions aren't mismatches). Returns true if the alias changed.
   */
  private reconcileModelFromRuntime(): boolean {
    if (this.respawning || this.pendingModel !== null) return false;
    const corrected = reconcileModelAlias(this.currentModel, this.currentPermissionMode, {
      modelId: this.currentModelId ?? undefined,
    });
    if (!corrected || corrected === this.currentModel) return false;
    log.info("Reconciled model alias from transcript", {
      token: this.spawnToken,
      from: this.currentModel,
      to: corrected,
    });
    this.currentModel = corrected;
    return true;
  }

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

    // NB: model-alias reconciliation is intentionally NOT done here. The
    // statusline payload is a render input, not a source of app state, and it
    // only flows when the user has a statusline command configured. Alias
    // reconciliation is transcript-driven (see handleModelChange).
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
        // Settings rarely change mid-session, so resolve once and reuse for the
        // session's lifetime — a statusLine config edit needs a restart to apply.
        const command =
          this.cachedStatusLineCommand ?? (await resolveStatusLineCommand(this.config.cwd));
        if (!command) {
          if (!warnedMissing) {
            log.info("No statusLine configured", { token: this.spawnToken });
            warnedMissing = true;
          }
          return;
        }
        this.cachedStatusLineCommand = command;
        const dumped = await readDumpedPayload(this.statusLinePayloadFile);
        // Refuse to render until Claude Code's first authoritative payload
        // lands — anything earlier would be synthesized from create-time
        // defaults (model alias, ctx 0%) and mislead the user.
        if (!dumped) return;
        // Claude rewrites the payload on every render; when the content is
        // byte-identical to the last *successfully rendered* one there's nothing
        // new, so skip the parse + subprocess spawn entirely.
        if (dumped === this.lastDumpedPayload) return;
        this.absorbDumpedPayload(dumped);
        const output = await runStatusLine(command, dumped);
        // Mark the payload as seen only after a successful render — a transient
        // failure (timeout/spawn) must retry on the next identical tick, not be
        // permanently swallowed.
        if (output == null) return;
        this.lastDumpedPayload = dumped;
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
    await this.submitWithConfirmation();
  }

  /**
   * Submit the just-pasted textarea with `\r`, confirming the prompt actually
   * registered before giving up.
   *
   * Why this isn't a fixed delay: Claude Code's input parser strips a trailing
   * `\r` that arrives in the same stdin read as other bytes (treats it as
   * SSH-coalesced Enter), so the submit `\r` must land as its own keystroke.
   * A large bracketed paste is split across multiple ConPTY reads, so a single
   * fixed-delay `\r` can be coalesced into the paste's tail chunk and silently
   * fail to submit. node-pty's write is fire-and-forget (no drain signal) and
   * we don't parse PTY output, so there's no send-side ack to wait on.
   *
   * Instead we key correctness on a structured signal: the transcript watcher
   * emits a `user_prompt` bus event once Claude writes the message to the
   * JSONL. We send `\r`, wait for that echo, and resend the lone `\r` if it
   * doesn't arrive. A resent `\r` is always safe — while still inside paste
   * mode it's buffered as content (never a partial submit), and on an
   * empty/idle textarea it's a no-op. The interval only paces retries; whether
   * it works depends on the echo, not on guessing how long the paste takes to
   * drain.
   */
  private async submitWithConfirmation(): Promise<void> {
    const bus = this._bus;
    for (let attempt = 0; attempt < SUBMIT_MAX_ATTEMPTS; attempt++) {
      const landed = bus
        ? this.waitForBusEvent(bus, (e) => e.kind === "user_prompt", SUBMIT_RETRY_MS)
        : delay(SUBMIT_RETRY_MS).then(() => false);
      this.pty.write("\r");
      if (await landed) return;
    }
    log.warn("Input submit not confirmed by transcript after retries", {
      token: this.spawnToken,
    });
  }

  /**
   * Drive the AskUserQuestion picker with a pre-built keystroke script, then
   * (for submitting answers, not cancels) confirm the answer actually
   * registered and resend the trailing Enter if it didn't.
   *
   * Why the resend is needed *and* safe: for multi-select the picker submits
   * only after the cursor lands on "Submit", which flips an `isFooterFocused`
   * React state — an async re-render. The `\r` that follows ~one CHUNK_DELAY
   * later can arrive before that flush and get dropped, leaving the question
   * open with the correct boxes already checked and the cursor parked on
   * Submit (confirmed in PTY captures). A resent `\r` then submits the
   * already-correct selection — it never re-toggles (that would need Space),
   * so it can't corrupt the answer. We only resend while no matching
   * `tool_result` has landed, so a successful submit is never double-fired into
   * the next prompt.
   *
   * Confirmation is keyed to THIS question's `toolUseId` (not just any
   * tool_result), so an unrelated tool finishing nearby can't falsely confirm
   * or cut the resend loop short. If the id is still the synthesized `pr:`
   * placeholder (real tool_call not yet seen — rare by answer time), we fall
   * back to matching any tool_result since we can't filter reliably.
   *
   * If the answer is never confirmed after all retries, we surface it via
   * `failQuestion` rather than leaving the card locked and the input bar
   * hidden forever (a silent dead-end).
   */
  async answerQuestion(
    chunks: KeystrokeChunk[],
    confirm: boolean,
    toolUseId: string,
  ): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      // Honor the previous chunk's settle override (heavier ink transitions ask
      // for more than the default); plain keystrokes use CHUNK_DELAY_MS.
      // NB: the final chunk's settleMs is intentionally not awaited — the
      // confirm loop follows immediately and no script relies on a tail settle.
      if (i > 0) await delay(chunks[i - 1].settleMs ?? CHUNK_DELAY_MS);
      this.sendKeystrokes(chunks[i].bytes);
    }
    if (!confirm) return;
    const bus = this._bus;
    if (!bus) return;
    const matches = (e: SessionBusEvent): boolean =>
      e.kind === "tool_result" && (toolUseId.startsWith("pr:") || e.toolUseId === toolUseId);
    for (let attempt = 0; attempt < QUESTION_SUBMIT_ATTEMPTS; attempt++) {
      // Wait first: the initial Enter (or a prior resend) may already have
      // landed. Only resend when the window elapses with no tool_result.
      if (await this.waitForBusEvent(bus, matches, QUESTION_SUBMIT_RETRY_MS)) return;
      log.debug("Question answer unconfirmed — resending Enter", {
        token: this.spawnToken,
        attempt,
      });
      this.pty.write("\r");
    }
    log.warn("Question answer not confirmed by transcript after retries", {
      token: this.spawnToken,
      toolUseId,
    });
    this.failQuestion(toolUseId, "Answer could not be confirmed by the CLI after retries.");
  }

  /**
   * Surface an undeliverable AskUserQuestion answer to the client by pushing a
   * synthetic error `tool_result` onto the bus. Without this the question card
   * stays locked and the input bar stays hidden (it's gated on "no pending
   * question"), leaving a failed relay as a silent dead-end. The synthetic
   * result fuses onto the card, flipping it to an error state and restoring the
   * input bar so the user can interrupt/retype. Frontend-only — the CLI's
   * question may still be open; this just unblocks the UI.
   */
  failQuestion(toolUseId: string, message: string): void {
    if (!this._bus) return;
    this._bus.push({
      kind: "tool_result",
      sessionId: this._bus.sessionId,
      timestamp: new Date().toISOString(),
      toolUseId,
      result: message,
      isError: true,
    });
  }

  /**
   * Drive the `ExitPlanMode` ink picker with a pre-built keystroke script, then
   * (for non-cancel responses) confirm the plan registered via the bus
   * `tool_result` for `toolUseId`.
   *
   * Unlike `answerQuestion`, we DON'T resend Enter on a miss: the plan picker
   * commits on an atomic single keystroke (`1`/`2`, or Shift+Tab after typed
   * feedback) — there's no focus-flush race to paper over, and a stray `\r`
   * would commit the *default-focused* option (auto-accept), silently changing
   * the user's decision. So we confirm-or-fail.
   *
   * `resultingMode` (when the decision approves the plan) is the permission mode
   * the picker exits into — set optimistically on confirmation so the top bar
   * reflects it immediately instead of waiting for the lagging JSONL
   * `permission-mode` entry. The JSONL entry remains the canonical correction.
   */
  async answerPlan(
    chunks: KeystrokeChunk[],
    confirm: boolean,
    toolUseId: string,
    resultingMode?: PermissionMode,
  ): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await delay(chunks[i - 1].settleMs ?? CHUNK_DELAY_MS);
      this.sendKeystrokes(chunks[i].bytes);
    }
    if (!confirm) return;
    const bus = this._bus;
    if (!bus) return;
    const matches = (e: SessionBusEvent): boolean =>
      e.kind === "tool_result" && e.toolUseId === toolUseId;
    const confirmed = await this.waitForBusEvent(
      bus,
      matches,
      QUESTION_SUBMIT_ATTEMPTS * QUESTION_SUBMIT_RETRY_MS,
    );
    if (confirmed) {
      if (resultingMode) this.notePermissionMode(resultingMode);
      return;
    }
    log.warn("Plan response not confirmed by transcript", {
      token: this.spawnToken,
      toolUseId,
    });
    this.failPlan(toolUseId, "Plan response could not be confirmed by the CLI.");
  }

  /**
   * Record a permission-mode change the CLI is making for us as a side effect
   * (e.g. exiting plan mode via the plan picker) WITHOUT writing the Shift+Tab
   * keystrokes `setPermissionMode` would. The JSONL `permission-mode` entry
   * remains the canonical correction if reality diverges.
   */
  notePermissionMode(mode: PermissionMode): void {
    if (this.currentPermissionMode === mode) return;
    this.currentPermissionMode = mode;
    this.emit("metadataChanged");
  }

  /** Frontend-only unblock for an undeliverable plan response — mirrors
   *  `failQuestion`: push a synthetic error `tool_result` so the PlanCard
   *  flips out of its locked state instead of stranding. */
  failPlan(toolUseId: string, message: string): void {
    this.failQuestion(toolUseId, message);
  }

  /** Resolve true when a bus event matching `predicate` lands, false on timeout. */
  private waitForBusEvent(
    bus: SessionBus,
    predicate: (event: SessionBusEvent) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        bus.off("event", onEvent);
      };
      const onEvent = (event: SessionBusEvent): void => {
        if (!predicate(event)) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      bus.on("event", onEvent);
    });
  }

  /**
   * Write raw bytes straight to PTY stdin — no bracketed-paste wrap, no
   * trailing `\r`. Used for driving Claude Code's interactive sub-UIs (e.g.
   * the AskUserQuestion picker) with arrow keys, Space, Enter, Tab, Esc.
   */
  sendKeystrokes(bytes: string): void {
    log.debug("Keystrokes", {
      token: this.spawnToken,
      hex: Array.from(bytes)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(" ")
        .slice(0, 200),
    });
    this.pty.write(bytes);
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
    // The incoming settings ARE the now-applied intent — drop any pending
    // overlay. Emit even on a no-op respawn so the pending badge clears.
    const hadPending = this.pendingModel !== null || this.pendingEffort !== null;
    this.pendingModel = null;
    this.pendingEffort = null;
    const modelChanged = settings.model !== this.currentModel;
    const effortChanged = settings.effort !== this.currentEffort;
    const modeChanged = settings.permissionMode !== this.currentPermissionMode;
    if (!modelChanged && !effortChanged && !modeChanged) {
      if (hadPending) this.emit("metadataChanged");
      return;
    }

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

    const dumpScriptPath = statusLineDumpScriptPath();
    const spawnedAt = Date.now();
    this.pty.spawn({
      cwd: this.config.cwd,
      claudeBin: this.deps.serverConfig.claudeBin,
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
   * Record a pending model/effort pick (made in the controller, not yet applied
   * to the PTY — applied on the next message via respawn). Surfaced in the UI as
   * "will switch to X" and cleared when respawn applies it. A pick equal to the
   * current value isn't pending. An omitted `effort` leaves effort unchanged.
   */
  setPendingModel(model: ClaudeModel, effort?: EffortLevel): void {
    const nextModel = model === this.currentModel ? null : model;
    const nextEffort = effort === undefined || effort === this.currentEffort ? null : effort;
    if (nextModel === this.pendingModel && nextEffort === this.pendingEffort) return;
    this.pendingModel = nextModel;
    this.pendingEffort = nextEffort;
    this.emit("metadataChanged");
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

  /**
   * Release per-session resources that must not outlive the PTY: the statusline
   * poll timer + fs watcher, the capture write stream, and the transient payload
   * file. Idempotent (null-safe), so it's safe to call from both `stop()` and the
   * PTY `exit` handler — natural exits (Claude `/exit`, crash) bypass `stop()`,
   * and without this they'd leak the interval, the watcher, and the open fd.
   * Any dev-only `.raw` capture is intentionally left on disk for post-mortem.
   */
  private teardownStatusLineAndCapture(): void {
    if (this.statusLineTimer) {
      clearInterval(this.statusLineTimer);
      this.statusLineTimer = null;
    }
    if (this.statusLineWatcher) {
      this.statusLineWatcher.close();
      this.statusLineWatcher = null;
    }
    this.captureStream?.end();
    this.captureStream = null;
    unlink(this.statusLinePayloadFile).catch(() => {});
  }

  stop(): void {
    log.info("Stopping", { token: this.spawnToken });
    this.teardownStatusLineAndCapture();
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
      // Show the pending pick (if any) so the UI reads "will switch to X";
      // currentModel stays the applied value until respawn.
      model: this.pendingModel ?? this.currentModel,
      currentModelId: this.currentModelId ?? undefined,
      permissionMode: this.currentPermissionMode,
      effort: this.pendingEffort ?? this.currentEffort,
      modelPending: this.pendingModel !== null,
      tags: this.config.tags ?? [],
      createdAt: this.createdAt,
      statusSnapshot: this.statusSnapshot ?? undefined,
      cliVersion: this.cliVersion ?? undefined,
      cliVersionStatus: this.cliVersion ? classifyCliVersion(this.cliVersion) : undefined,
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
    // One long-lived append stream — far cheaper than open+write+close per PTY
    // chunk under high terminal throughput. Failures are non-fatal (dev-only
    // debug aid) but we warn once so an empty/truncated capture isn't a mystery.
    this.captureStream = createWriteStream(this.capturePath, { flags: "a" });
    this.captureStream.on("error", (err) => {
      log.warn("PTY capture write failed", { raw: this.capturePath, error: err.message });
    });
    log.info("Capture file", { raw: this.capturePath });
  }

  private captureRaw(data: string): void {
    this.captureStream?.write(data);
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
