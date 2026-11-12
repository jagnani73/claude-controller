import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createWriteStream,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readFileSync,
  type WriteStream,
  watch,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { autoCycleSupport, cycleDistance } from "common/permission-cycle";
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
import { isClaudeModel, isEffortLevel, isPermissionMode, planTextOf } from "common/types";
import {
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_TARGET_VERSION,
  classifyCliVersion,
  isBelowMinimumVersion,
} from "common/version";
import { AgentRegistry } from "../services/agent-registry.service.js";
import { LoggerService } from "../services/logger.service.js";
import { modelCatalog } from "../services/model-catalog.service.js";
import { forgetSpawn, rememberSpawn } from "../services/orphan-reaper.service.js";
import { PtyService } from "../services/pty.service.js";
import { CHUNK_DELAY_MS, type KeystrokeChunk } from "../services/question.input.js";
import { SessionBus, type SessionBusEvent } from "../services/session-bus.service.js";

import {
  readDumpedPayload,
  resolveStatusLineCommand,
  runStatusLine,
  statusLineDumpScriptPath,
  statusLinePayloadPath,
} from "../services/statusline.service.js";
import { TranscriptWatcher } from "../services/transcript.service.js";
import type { SessionDeps, SessionEvents, SpawnIdentity } from "../types/index.js";
import { resolveTranscriptPath } from "../utils/claude-paths.js";
import { buildHooksConfig } from "../utils/hooks-config.js";
import { nextPendingPick, RuntimeReconciler } from "./runtime-reconciler.js";

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

/** How long `answerPlan` waits for the ExitPlanMode picker to open before it
 *  gives up — having written nothing. The card arrives ~2.4s before the picker. */
const PLAN_PICKER_OPEN_TIMEOUT_MS = 20_000;
/** Margin between the picker-open signal and the first key. The hook fires
 *  ~10-50ms before the render; a key 300ms after the render committed. */
const PLAN_PICKER_SETTLE_MS = 300;
/** How long after the key to wait for the ExitPlanMode tool_result. */
const PLAN_CONFIRM_TIMEOUT_MS = 8_000;
/** How long a respawn waits for the killed PTY's exit before spawning anyway.
 *  PtyService ignores a late exit from a replaced process, so this is safe. */
const RESPAWN_EXIT_TIMEOUT_MS = 5_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a freshly started CLI gets to boot before input is forwarded. */
const FRESH_BOOT_GRACE_MS = 3_000;

export class Session extends EventEmitter<SessionEvents> {
  /**
   * Internal token used for routing hooks/statusline/capture before we know
   * Claude Code's session id. Stable for the life of the Session instance.
   */
  readonly spawnToken: string;
  readonly config: SessionConfig;
  readonly createdAt: number;
  /** Resolves once the initial transcript drain completed (a resume's history
   * is on the bus). The id itself is known from the constructor on. */
  readonly ready: Promise<void>;
  /**
   * Why the initial transcript drain failed, if it did. `ready` still resolves
   * (the session runs, it just shows no history), so every subscriber is told
   * this instead of seeing an empty chat with no explanation.
   */
  startupError: string | null = null;
  private _id: string | null = null;
  private _bus: SessionBus | null = null;
  private _agents: AgentRegistry | null = null;
  /** The pending ExitPlanMode call, from its PreToolUse `tool_call` until its
   *  `tool_result`; `openedAt` is set once the picker is up. See answerPlan. */
  private planPicker: { toolUseId: string; hasPlan: boolean; openedAt: number | null } | null =
    null;
  private status: SessionStatus = "running";
  private pty: PtyService;
  private capturePath: string | null = null;
  private captureStream: WriteStream | null = null;

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
  /**
   * Runtime observations from the transcript (model id, effort level) plus the
   * rules for correcting `currentModel`/`currentEffort` against them. Holds the
   * observations rather than acting on them immediately so one seen while
   * reconciliation is suppressed can be replayed — see `RuntimeReconciler`.
   */
  private readonly reconciler = new RuntimeReconciler();
  /** CLI build driving this session, read from the transcript (see handleCliVersion). */
  private cliVersion: string | null = null;
  /**
   * Last version already reported. The change-detection above it does most of
   * the deduping; this only additionally suppresses a repeat report if a version
   * were ever observed again after changing away and back, which shouldn't
   * happen mid-session but costs nothing to hold.
   */
  private warnedCliVersion: string | null = null;
  private statusSnapshot: SessionStatusSnapshot | null = null;
  /** Set during respawn() so the PTY exit handler doesn't propagate "stopped". */
  private respawning = false;
  /** The respawn running now, and at most one queued behind it (see _doRespawn). */
  private respawnRunning: Promise<void> | null = null;
  private respawnQueued: Promise<void> | null = null;
  /** `stop()` ran: resources are released and the session is never revived. */
  private disposed = false;
  /** `exit` was emitted; a second PTY death must not report it twice. */
  private exitEmitted = false;
  /** Last time anything happened: a live bus event, or input sent to the PTY. */
  private _lastActivityAt: number;
  /** Live tool calls with no result yet: a long-running tool emits nothing. */
  private readonly openToolCalls = new Set<string>();
  /**
   * Synthesized `pr:` ids of PermissionRequests (tool approvals, AskUserQuestion)
   * this PTY raised and has not abandoned. A question card can still carry its
   * `pr:` id when answered, so `claimAnswer` accepts one of these as proof the
   * call is open in this process. Cleared with `openToolCalls`.
   */
  private readonly openApprovalIds = new Set<string>();
  /**
   * AskUserQuestion / ExitPlanMode calls a response is being (or was) delivered
   * for. The client re-sends an unacknowledged response after a reconnect, and
   * typing the same keystrokes twice would answer the *next* prompt, so a
   * second response for the same call is ignored. A failed delivery is final
   * too: `failQuestion` resolves the card with a synthetic error result, and the
   * CLI's picker may be half-driven, so the user interrupts or retypes instead.
   */
  private readonly answeredCalls = new Set<string>();
  private readonly deps: SessionDeps;

  get id(): string {
    if (!this._id) throw new Error("Session id not yet resolved");
    return this._id;
  }
  get bus(): SessionBus {
    if (!this._bus) throw new Error("Session bus not yet ready");
    return this._bus;
  }
  /** Subagents/teammates this session has spawned. Available once the id resolves. */
  get agents(): AgentRegistry {
    if (!this._agents) throw new Error("Session agents not yet ready");
    return this._agents;
  }
  get resolved(): boolean {
    return this._id !== null;
  }
  /** The model alias the PTY is currently running (not the pending pick). */
  get model(): ClaudeModel {
    return this.currentModel;
  }
  /**
   * False once the PTY is gone. A stopped session stays in `SessionManager`'s
   * `byId` until its exit evicts it, so anything reusing a registry hit has to
   * check this or it will hand back a corpse.
   */
  get alive(): boolean {
    return this.status !== "stopped" && this.status !== "error";
  }

  constructor(config: SessionConfig, deps: SessionDeps) {
    super();
    this.spawnToken = randomUUID();
    this.config = config;
    this.deps = deps;
    this.currentModel = config.model;
    // A fresh create is a controller pick. A resume's model is only a remembered
    // fallback (possibly a corrected full id), so it teaches nothing.
    if (!config.resumeSessionId) modelCatalog.learnAlias(config.model, "pick");
    // Fall back to user's global default when config omits effort.
    this.currentEffort = config.effort ?? readGlobalDefaultEffort();
    this.currentPermissionMode = config.permissionMode;
    this.createdAt = Date.now();
    this._lastActivityAt = this.createdAt;
    this.pty = new PtyService();

    if (deps.serverConfig.capturePty) {
      this.initCapture(deps.serverConfig.dumpDir);
    }

    this.pty.on("data", (data) => {
      this.captureRaw(data);
    });

    this.pty.on("exit", (info) => {
      // A respawn kills the PTY on purpose. But once `stop()` has run, an exit
      // during a respawn is the real end and has to be reported.
      if (this.respawning && !this.disposed) return;
      this.handlePtyGone(info);
    });

    // The session id is known before the CLI starts: a resume names it, and a
    // fresh spawn chooses one and passes it as `--session-id`. It used to be
    // discovered from ~/.claude/sessions/<pid>.json by cwd and start time, which
    // could not tell apart several sessions started in one folder at once: they
    // all claimed the first file and their output crossed.
    const sessionId = config.resumeSessionId ?? randomUUID();
    this.resolveId(sessionId);
    // For a fresh session the transcript does not exist yet; the watcher waits
    // for it (and for its project directory) and drains nothing until then.
    this.transcript = new TranscriptWatcher(
      resolveTranscriptPath(config.cwd, sessionId),
      this.bus,
      this.handleModelChange,
      this.handleCliVersion,
      this.handleEffortChange,
    );
    const drainDone = this.transcript.start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Initial transcript drain failed", { token: this.spawnToken, error: message });
      this.startupError = `Couldn't read this session's transcript: ${message}`;
    });
    this.ready = drainDone.then(() => {
      // Everything drained so far describes the process that wrote it, which for
      // a resume is dead. The drain is silent (the bus listener below never saw
      // it), but clear the live trackers anyway, and end the replayed turn: a
      // transcript that stops on an unanswered prompt or an interrupted turn
      // would otherwise read as a turn in flight forever, blocking the idle
      // reaper, gating Esc on a turn nobody runs, and forcing a redirect respawn
      // on the first message into a CLI whose textarea is already clean.
      this.openToolCalls.clear();
      this.openApprovalIds.clear();
      this.planPicker = null;
      this._bus?.endReplayedTurn();
      // A resume's transcript has just been replayed, so the spawn calls that
      // parent each agent are now findable, and the lead's past SendMessage
      // calls can be backfilled (a subscriber may have snapshotted before this).
      this._agents?.scan();
      this._agents?.backfill();
      this._agents?.reresolveParents();
    });

    log.info("Created", {
      token: this.spawnToken,
      cwd: config.cwd,
      model: config.model,
      permissionMode: config.permissionMode,
      resume: config.resumeSessionId,
    });

    const dumpScriptPath = statusLineDumpScriptPath();
    this.statusLinePayloadFile = statusLinePayloadPath(deps.serverConfig.dumpDir, this.spawnToken);

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
      identity: config.resumeSessionId
        ? this.spawnIdentity(sessionId)
        : { kind: "new", id: sessionId },
      effort: this.currentEffort,
    });

    this.startStatusLinePolling();
  }

  private handleModelChange = (model: string): void => {
    if (!this.reconciler.observeModel(model)) return;
    modelCatalog.observeModelId(model);
    log.info("Model changed", { token: this.spawnToken, model });
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
   * Apply an out-of-band `/model` switch reported by the `PostModelSwitch` hook.
   *
   * More precise than the transcript path this complements: the hook carries
   * `requested_model` — the alias itself — whereas the transcript only exposes
   * the resolved id, which cannot distinguish `opus` from `opus[1m]`. So this
   * corrects the alias exactly, where `reconcileModelFromRuntime` can only
   * detect a whole-family mismatch.
   *
   * Both paths stay: the hook fires only on an explicit switch and only on CLI
   * >= 2.1.251, so the transcript remains the catch-all for everything else
   * (a wrong resume default, an older build).
   */
  private handleModelSwitch(requestedModel: string | undefined, toModel: string): void {
    // Retain the id even while suppressed. The reconciler dedupes on it, as does
    // TranscriptWatcher, so an id dropped here never arrives again — and the
    // alias would stay stale for the life of the session. Recording it keeps the
    // transcript fallback replayable once suppression lifts.
    this.reconciler.observeModel(toModel);
    modelCatalog.observeModelId(toModel);
    // The alias the user typed is one seen working, so reconciliation may use it
    // from now on, in every session.
    modelCatalog.learnAlias(requestedModel, "PostModelSwitch");
    if (this.respawning || this.pendingModel !== null) return;
    if (!requestedModel || !isClaudeModel(requestedModel)) {
      // No alias, or one not shaped like an alias or id — fall back to family
      // reconciliation against the resolved id we just recorded.
      if (this.reconcileModelFromRuntime()) this.emit("metadataChanged");
      return;
    }
    if (this.currentModel === requestedModel) return;
    log.info("Applied model switch from hook", {
      token: this.spawnToken,
      from: this.currentModel,
      to: requestedModel,
      resolved: toModel,
    });
    this.currentModel = requestedModel;
    this.emit("metadataChanged");
  }

  /**
   * Take the effort level the transcript says the turn actually ran at (recorded
   * on every assistant message since v2.1.212) and reconcile the stored one
   * against it.
   *
   * Mirrors `handleModelChange`: before this, effort was write-only — we set
   * `CLAUDE_CODE_EFFORT_LEVEL` at spawn and never read it back, so an
   * out-of-band `/effort` left the badge showing a level the session wasn't
   * running, exactly the way a stale model alias used to. `RuntimeReconciler`
   * holds the rules for when the observation actually warrants a correction.
   */
  private handleEffortChange = (effort: string): void => {
    // Retain before any guard, for the same reason as the model path: this is
    // the only time the watcher reports this level.
    if (!this.reconciler.observeEffort(effort)) return;
    if (!isEffortLevel(effort)) {
      // Claude Code accepts levels we don't model (e.g. `ultracode`). The
      // reconciler ignores it rather than coercing — a wrong badge is worse than
      // a stale one — so this only surfaces that it happened.
      log.debug("Ignoring unmodelled effort level from transcript", {
        token: this.spawnToken,
        effort,
      });
    }
    if (this.reconcileEffortFromRuntime()) this.emit("metadataChanged");
  };

  /** Version the session's CLI is compared against for drift (not the hard floor). */
  private get cliReferenceVersion(): string {
    return this.deps.cliReferenceVersion ?? CLAUDE_CODE_TARGET_VERSION;
  }

  /**
   * Record which Claude Code build is actually driving this session and warn if
   * it isn't the one installed now (the drift reference resolved at startup, or
   * the static fallback when that probe failed — see `cliReferenceVersion`).
   *
   * A mismatch means this session runs a different build than the installed
   * one, e.g. it was resumed across an upgrade, or the binary on PATH changed
   * under a long-lived backend. It is not fatal and must not block the session:
   * most versions change nothing we depend on. It's logged at warn and surfaced
   * on `SessionInfo` so the drift is visible when a picker or the transcript
   * parse starts misbehaving. The hard floor below is a separate, static check.
   */
  private handleCliVersion = (version: string): void => {
    if (this.cliVersion === version) return;
    this.cliVersion = version;
    const status = classifyCliVersion(version, this.cliReferenceVersion);
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
      log.warn("Claude Code version differs from the installed build", {
        token: this.spawnToken,
        observed: version,
        reference: this.cliReferenceVersion,
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
    const corrected = this.reconciler.reconcileModel({
      model: this.currentModel,
      permissionMode: this.currentPermissionMode,
      suppressed: this.respawning || this.pendingModel !== null,
      knownAliases: modelCatalog.knownAliases(),
    });
    if (!corrected) return false;
    log.info("Reconciled model alias from transcript", {
      token: this.spawnToken,
      from: this.currentModel,
      to: corrected,
    });
    this.currentModel = corrected;
    return true;
  }

  /**
   * Correct `currentEffort` from the level the transcript says the turn actually
   * ran at. Mirrors {@link reconcileModelFromRuntime}, including reading the
   * retained observation rather than a just-arrived value, so it can be replayed
   * after a pending pick clears. Returns true if the level changed.
   */
  private reconcileEffortFromRuntime(): boolean {
    const corrected = this.reconciler.reconcileEffort({
      effort: this.currentEffort,
      suppressed: this.respawning || this.pendingEffort !== null,
    });
    if (!corrected) return false;
    log.info("Reconciled effort from transcript", {
      token: this.spawnToken,
      from: this.currentEffort,
      to: corrected,
    });
    this.currentEffort = corrected;
    return true;
  }

  /**
   * Re-run both reconcilers after a pending pick clears **without** a respawn.
   *
   * Suppression defers an observation rather than discarding it, so this is
   * where the deferred one is finally acted on. Without it the correction is
   * lost for the session's life — and not just cosmetically: `currentModel`
   * stays stale, so the next respawn passes `--model <stale alias>` and forces a
   * switch the user never asked for.
   *
   * Only correct when no respawn happened. `_doRespawn` invalidates the
   * observations instead, because there they describe the process it killed.
   */
  private flushDeferredReconciliation(): boolean {
    const modelChanged = this.reconcileModelFromRuntime();
    const effortChanged = this.reconcileEffortFromRuntime();
    return modelChanged || effortChanged;
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
    this._agents = new AgentRegistry({
      sessionId: id,
      mainBus: this._bus,
      // Without hook context (a resumed session no agent has run in yet) the
      // agents live beside the transcript: <projectDir>/<sessionId>/subagents.
      subagentsDir: () => {
        const transcriptPath = this.transcript?.path ?? resolveTranscriptPath(this.config.cwd, id);
        return join(dirname(transcriptPath), id, "subagents");
      },
    });
    // Leave a trail for the startup reaper. Only possible now: the record is
    // keyed on the session id, which is exactly what we did not have at spawn.
    rememberSpawn({
      sessionId: id,
      spawnToken: this.spawnToken,
      spawnedAt: this.createdAt,
    });
    // Mirror JSONL permission-mode entries onto our state so unrelated
    // metadataChanged broadcasts don't ship a stale config value.
    this._bus.on("event", (event) => {
      this.touch();
      if (event.kind === "tool_call") this.openToolCalls.add(event.toolUseId);
      else if (event.kind === "tool_result") this.openToolCalls.delete(event.toolUseId);
      else if (event.kind === "approval_request") this.openApprovalIds.add(event.toolUseId);
      else if (event.kind === "approval_expired") this.openApprovalIds.delete(event.toolUseId);
      if (event.kind === "model_switch") {
        this.handleModelSwitch(event.requestedModel, event.toModel);
        return;
      }
      this.trackPlanPicker(event);
      if (event.kind !== "permission_mode") return;
      const mode = event.mode;
      // Ignore modes we don't model (`dontAsk`, `bypassPermissions`; 2.1.321+
      // Space on "Auto (default)" saves Don't Ask): `cycleDistance` from an
      // unknown mode finds no path, so mirroring it would make the next phone-side mode
      // change silently do nothing. Keeping the last known mode at least walks
      // the cycle from a real stop.
      if (!isPermissionMode(mode)) {
        log.info("Ignoring unmodelled permission mode from transcript", {
          sessionId: id,
          mode,
        });
        return;
      }
      if (this.currentPermissionMode === mode) return;
      this.currentPermissionMode = mode;
      this.emit("metadataChanged");
    });
    log.info("Session id", { token: this.spawnToken, id });
  }

  /**
   * The PTY is gone for good (it exited, or a respawn could not replace it).
   * Idempotent: `exit` is emitted once, which is what tells clients and lets
   * `SessionManager` evict the session.
   */
  private handlePtyGone(info: { exitCode: number; signal?: number }): void {
    this.teardownStatusLineAndCapture();
    this.setStatus("stopped");
    this.transcript?.stop();
    this.openToolCalls.clear();
    this.openApprovalIds.clear();
    // The agents ran inside the PTY that just exited. Keep what we know of them
    // (a stopped session's tree is still worth reading) but stop tailing.
    this._agents?.settleRunning();
    this._agents?.stopWatching();
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.emit("exit", info);
  }

  /** Last live activity (bus event or input), ms since epoch. */
  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  private touch(): void {
    this._lastActivityAt = Date.now();
  }

  /**
   * Whether stopping the PTY now loses nothing: the session can be resumed
   * later from its transcript. A fresh session that never ran a turn has no
   * transcript, so `--resume` would have nothing to pick up.
   */
  get resumable(): boolean {
    const path = this.transcript?.path;
    return path !== undefined && existsSync(path);
  }

  /**
   * Why the session must not be idle-stopped right now, or null when nothing
   * in the session itself is in progress. Callers add what the session cannot
   * see (pending approvals, watching clients) and the idle duration.
   */
  idleBlocker(): string | null {
    if (!this.alive || this.disposed) return "stopped";
    if (this.respawning || this.respawnRunning || this.respawnQueued) return "respawning";
    if (this.hasInFlightTurn()) return "turn";
    if (this.openToolCalls.size > 0) return "tool_running";
    if (this.planPicker) return "plan_picker";
    if (this._agents?.hasRunning()) return "agents_running";
    return null;
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
    this.touch();
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
    if (!this.pty.write(`\x1b[200~${text}\x1b[201~`)) {
      throw new Error("The CLI is not running, so the message could not be written.");
    }
    if (!(await this.submitWithConfirmation())) {
      throw new Error("Claude Code did not register the message after several attempts.");
    }
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
  private async submitWithConfirmation(): Promise<boolean> {
    const bus = this._bus;
    for (let attempt = 0; attempt < SUBMIT_MAX_ATTEMPTS; attempt++) {
      const landed = bus
        ? this.waitForBusEvent(bus, (e) => e.kind === "user_prompt", SUBMIT_RETRY_MS)
        : delay(SUBMIT_RETRY_MS).then(() => false);
      this.pty.write("\r");
      if (await landed) return true;
    }
    log.error("Input submit not confirmed by transcript after retries", {
      token: this.spawnToken,
      attempts: SUBMIT_MAX_ATTEMPTS,
    });
    return false;
  }

  /**
   * Claim the right to answer an AskUserQuestion / ExitPlanMode call. False when
   * a response for it already went out (a re-send after a reconnect, or a double
   * tap): the second one must not type into the PTY. See `answeredCalls`.
   *
   * Also false, with a synthetic error result so the card resolves, when the
   * call was never seen open in THIS process. After a PTY death and resume the
   * old call is an orphaned `tool_use` with no result and this Session's
   * `answeredCalls` is empty, so a re-sent answer would otherwise type its
   * script plus Enter into the fresh CLI's main prompt.
   */
  claimAnswer(toolUseId: string): boolean {
    if (this.answeredCalls.has(toolUseId) || this._bus?.hasToolResult(toolUseId)) {
      log.info("Ignoring a repeat response for an answered call", {
        token: this.spawnToken,
        toolUseId,
      });
      return false;
    }
    this.answeredCalls.add(toolUseId);
    if (!this.openToolCalls.has(toolUseId) && !this.openApprovalIds.has(toolUseId)) {
      log.info("Refusing a response for a call not open in this process", {
        token: this.spawnToken,
        toolUseId,
      });
      this.failQuestion(
        toolUseId,
        "This prompt is no longer open in Claude Code; nothing was sent.",
      );
      return false;
    }
    return true;
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
    log.error("Question answer not confirmed by transcript after retries", {
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
   *
   * Final for this call: the synthetic result (and `answeredCalls`) make
   * `claimAnswer` refuse any later response for it, because the picker may have
   * been partly driven and a second script would land on an unknown screen.
   */
  failQuestion(toolUseId: string, message: string): void {
    this.answeredCalls.add(toolUseId);
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
   * Follow the ExitPlanMode picker's lifecycle off the bus: its `tool_call`
   * (pushed from PreToolUse, before the picker exists), `plan_picker_open` (the
   * notification-only PermissionRequest, as the picker renders) and its
   * `tool_result` (resolved, by us or at the terminal).
   */
  private trackPlanPicker(event: SessionBusEvent): void {
    if (event.kind === "tool_call" && event.name === "ExitPlanMode") {
      this.planPicker = {
        toolUseId: event.toolUseId,
        hasPlan: planTextOf(event.input) !== null,
        openedAt: null,
      };
    } else if (event.kind === "plan_picker_open") {
      if (this.planPicker && this.planPicker.openedAt === null) {
        this.planPicker.openedAt = Date.now();
      }
    } else if (event.kind === "tool_result" && event.toolUseId === this.planPicker?.toolUseId) {
      this.planPicker = null;
    }
  }

  /** Whether the pending ExitPlanMode call carried plan text. False when the
   *  call is unknown, which callers treat as planless (the safe reading). */
  planPickerHasPlan(toolUseId: string): boolean {
    return this.planPicker?.toolUseId === toolUseId && this.planPicker.hasPlan;
  }

  /**
   * Drive the `ExitPlanMode` ink picker with a pre-built keystroke script, then
   * (for non-cancel responses) confirm the plan registered via the bus
   * `tool_result` for `toolUseId`.
   *
   * GATED ON THE PICKER BEING OPEN. The card is drawn from PreToolUse, ~2.4s
   * before the picker renders, so a fast tap used to write its digit into the
   * void: the response was never confirmed, the picker stayed open with nothing
   * on the phone able to answer it. Worse than lost — in a bare PTY on 2.1.322
   * a `2` written at PreToolUse time went into the *main prompt box*, and
   * reappeared there (`> 2`) once the picker closed, to be prepended to the
   * user's next prompt. (An early Esc would be worse still: it interrupts the
   * turn.) So nothing is written until `plan_picker_open` — ExitPlanMode's
   * notification-only PermissionRequest, which fires as the picker renders —
   * has arrived for this call, plus a short settle. If it never arrives within
   * PLAN_PICKER_OPEN_TIMEOUT_MS we fail having written nothing, so there is
   * never junk to clean out of the prompt. No PTY output is read.
   *
   * Then one write and no resend, unlike `answerQuestion`: the digit commits
   * atomically once the picker is up, and a resend racing the tool_result's
   * trip through the transcript would land in the main prompt (above), while a
   * stray `\r` would commit the *default-focused* option. So we confirm-or-fail.
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
    const bus = this._bus;
    if (!bus) return;
    const isMine = (): boolean => this.planPicker?.toolUseId === toolUseId;
    if (isMine() && this.planPicker?.openedAt === null) {
      await this.waitForBusEvent(
        bus,
        (e) =>
          e.kind === "plan_picker_open" || (e.kind === "tool_result" && e.toolUseId === toolUseId),
        PLAN_PICKER_OPEN_TIMEOUT_MS,
      );
    }
    const openedAt = isMine() ? this.planPicker?.openedAt : null;
    if (openedAt == null) {
      // Never opened, resolved meanwhile (e.g. at the terminal), or not the call
      // the tracked picker belongs to (or none is tracked, as after `ready`).
      // A resolved call already has its result; anything else must be failed,
      // since `claimAnswer` recorded the call and will ignore every re-send.
      if (!bus.hasToolResult(toolUseId)) {
        log.error("Plan picker not open for this call — nothing was sent", {
          token: this.spawnToken,
          toolUseId,
          trackedCall: this.planPicker?.toolUseId ?? null,
        });
        this.failPlan(toolUseId, "The CLI's plan prompt was not open; nothing was sent.");
      }
      return;
    }
    const settle = openedAt + PLAN_PICKER_SETTLE_MS - Date.now();
    if (settle > 0) await delay(settle);
    if (!isMine()) {
      // Normally answered at the terminal during the settle (it has a result).
      if (!bus.hasToolResult(toolUseId)) {
        this.failPlan(
          toolUseId,
          "The CLI's plan prompt closed before the answer; nothing was sent.",
        );
      }
      return;
    }
    const matches = (e: SessionBusEvent): boolean =>
      e.kind === "tool_result" && e.toolUseId === toolUseId;
    // Listen before writing: the result can land before the write returns.
    const result = this.waitForBusEvent(bus, matches, PLAN_CONFIRM_TIMEOUT_MS);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await delay(chunks[i - 1].settleMs ?? CHUNK_DELAY_MS);
      this.sendKeystrokes(chunks[i].bytes);
    }
    if (!confirm) return;
    const confirmed = await result;
    if (confirmed) {
      if (resultingMode) this.notePermissionMode(resultingMode);
      return;
    }
    log.error("Plan response not confirmed by transcript", {
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
    this.touch();
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
    // Read from the bus's turn tracking, not its log: the log is capped and may
    // have dropped the prompt during a long turn.
    const { hasPrompt, kinds } = this._bus.sinceLastUserPrompt();
    return hasPrompt && kinds.has("interrupt") && !kinds.has("assistant_text");
  }

  async sendSlashCommand(command: string): Promise<void> {
    const cmd = command.startsWith("/") ? command : `/${command}`;
    log.debug("Slash command", { token: this.spawnToken, command: cmd });
    this.touch();
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
  async respawn(requested: RespawnSettings): Promise<void> {
    if (!this._id) {
      log.warn("Respawn requested before id resolved", { token: this.spawnToken });
      return;
    }
    // The model type is open, so a wire value must pass the shape check before
    // it can reach `--model`; anything else keeps the running model.
    const settings: RespawnSettings = isClaudeModel(requested.model)
      ? requested
      : { ...requested, model: this.currentModel };
    // The incoming settings ARE the now-applied intent — drop any pending
    // overlay. Emit even on a no-op respawn so the pending badge clears.
    const hadPending = this.pendingModel !== null || this.pendingEffort !== null;
    this.pendingModel = null;
    this.pendingEffort = null;
    const modelChanged = settings.model !== this.currentModel;
    const effortChanged = settings.effort !== this.currentEffort;
    const modeChanged = settings.permissionMode !== this.currentPermissionMode;
    if (!modelChanged && !effortChanged && !modeChanged) {
      // Nothing to respawn, but the overlay just cleared — same situation as a
      // collapsed pick in setPendingModel, so replay any deferred observation.
      if (hadPending) {
        this.flushDeferredReconciliation();
        this.emit("metadataChanged");
      }
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
  /**
   * Respawns are serialized. Two can be requested at once (a settings change
   * and a post-interrupt redirect, or two quick inputs), and running them
   * concurrently made the second `spawn` throw "already running" with
   * `respawning` left true for good. A request made while one is running waits
   * for it and then runs once more; further requests join that queued one, since
   * it reads the settings current when it spawns.
   */
  private _doRespawn(): Promise<void> {
    if (!this.respawnRunning) {
      const run = this.respawnOnce().finally(() => {
        if (this.respawnRunning === run) this.respawnRunning = null;
      });
      this.respawnRunning = run;
      return run;
    }
    if (!this.respawnQueued) {
      const queued = this.respawnRunning
        .catch(() => {})
        .then(() => {
          this.respawnQueued = null;
          return this._doRespawn();
        });
      this.respawnQueued = queued;
    }
    return this.respawnQueued;
  }

  private async respawnOnce(): Promise<void> {
    // A stopped session is never revived: `stop()` released its resources, and
    // reopening it goes through a fresh resume instead.
    if (!this._id || this.disposed || !this.alive) return;
    this.respawning = true;
    try {
      // A PTY that already exited emits no further `exit`, so waiting for one
      // would hang forever. Only wait when there is something to kill.
      if (this.pty.running) {
        const exited = new Promise<void>((resolve) => {
          this.pty.once("exit", () => resolve());
        });
        // Immediate SIGKILL — Claude doesn't exit on one Ctrl+C and the 2s grace
        // is dead time the user sees as respawn latency. We're about to --resume
        // anyway; nothing graceful to preserve.
        this.pty.kill({ immediate: true });
        const timedOut = await Promise.race([
          exited.then(() => false),
          delay(RESPAWN_EXIT_TIMEOUT_MS).then(() => true),
        ]);
        if (timedOut) {
          // info, not warn: harmless by design (PtyService ignores a replaced
          // process's late exit), but worth seeing in the default log.
          log.info("Killed PTY did not report its exit — respawning anyway", {
            token: this.spawnToken,
          });
        }
      }
      // stop() may have run while we waited for the exit.
      if (this.disposed) return;

      // The retained observations describe the process we just killed. Replaying
      // them against the new intent would revert it — reconciling `opus` against a
      // stale `claude-sonnet-5` "corrects" the alias straight back to sonnet. The
      // resumed session reports its own model and effort on its first turn.
      this.reconciler.invalidate();
      // Their host process is gone; none of the agents it was running still is,
      // and none of its tool calls will ever report a result.
      this._agents?.settleRunning();
      this.openToolCalls.clear();
      this.openApprovalIds.clear();

      const dumpScriptPath = statusLineDumpScriptPath();
      const spawnedAt = Date.now();
      const identity = this.spawnIdentity(this._id);
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
        identity,
        forceModel: true,
        effort: this.currentEffort,
      });
      // A fresh start writes no resume block to wait for, so the ready-wait would
      // only time out; give the CLI a fixed moment to boot instead.
      if (identity.kind === "new") await delay(FRESH_BOOT_GRACE_MS);
      // Claude Code takes a few seconds to boot before it reads stdin: it writes
      // a `--resume` synthetic block to the JSONL (continue-from-here marker,
      // attachments, /remote-control system message, ...) and only attaches its
      // stdin reader once that's settled. Writing input earlier is silently
      // dropped — the user sees "I changed settings, sent a message, nothing
      // happened." Wait for the bus to receive a new transcript event after our
      // spawnedAt, then for an 800ms quiet period (= Claude stopped writing).
      else await this.waitForReady(spawnedAt);
    } finally {
      this.respawning = false;
      // A spawn that threw (cwd gone) or a new PTY that died while we waited
      // left no process behind. Its exits were swallowed while `respawning`, so
      // report the death here; otherwise the session would look alive forever
      // with nothing behind it.
      if (!this.pty.running && this.alive) {
        log.error("PTY is not running after respawn — marking session stopped", {
          token: this.spawnToken,
        });
        this.handlePtyGone({ exitCode: -1 });
      }
    }
    this.touch();
    this.emit("metadataChanged");
  }

  /**
   * How to start the CLI for this session's id. `--resume` needs a
   * conversation on disk, and before the first message there is none: the CLI
   * then exits at once with "No conversation found with session ID". That hit
   * every restart of a session that had not been sent anything yet (a model or
   * effort pick before the first message, a reconnect or resume after a backend
   * restart). Start such a session fresh under the same id instead.
   */
  private spawnIdentity(id: string): SpawnIdentity {
    const path = this.transcript?.path ?? resolveTranscriptPath(this.config.cwd, id);
    return existsSync(path) ? { kind: "resume", id } : { kind: "new", id };
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
        // error: input written now may be dropped by a CLI that is not reading
        // stdin yet, and the submit confirmation is what will notice.
        log.error("Respawn ready-wait timed out — forwarding anyway", {
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
   * value rather than the pre-cycle one.
   *
   * The step count must be right, because nothing promptly corrects it.
   * Claude Code writes `permission-mode` into the JSONL only as part of a
   * periodic session-metadata block (`last-prompt`/`mode`/`permission-mode`/
   * `bridge-session`) — never on the keypress itself, and not at all in a
   * session that has yet to run a turn. So a miscount does not merely show a
   * stale badge: the next prompt *runs* under a mode the user did not pick,
   * and the transcript only catches up at the next block. That is what
   * `cycleCanIncludeAuto` guards, and why `pnpm verify:permission-cycle`
   * exists to check it against the live CLI.
   *
   * For a model whose cycle was never verified (`autoCycleSupport` is null) the
   * count would be a guess, so this declines and returns `"unverified"` rather
   * than risk it; the caller tells the client. `metadataChanged` is emitted so
   * a client that applied the change optimistically reverts to the real mode.
   */
  setPermissionMode(target: PermissionMode): "applied" | "unchanged" | "unverified" {
    const from = this.currentPermissionMode;
    if (from === target) return "unchanged";
    const autoAvailable = autoCycleSupport(this.currentModel);
    if (autoAvailable === null) {
      log.warn("Declined permission mode change: cycle not verified for this model", {
        token: this.spawnToken,
        from,
        target,
        model: this.currentModel,
      });
      this.emit("metadataChanged");
      return "unverified";
    }
    const steps = cycleDistance(from, target, { autoAvailable });
    if (steps === null) {
      // A modelled mode the cycle cannot reach is a bug in the cycle model, and
      // the user's pick silently did nothing: error, not the invisible warn.
      log.error("Permission mode target unreachable from current", {
        token: this.spawnToken,
        from,
        target,
        model: this.currentModel,
      });
      return "unchanged";
    }
    log.debug("Set permission mode", { token: this.spawnToken, from, target, steps });
    this.currentPermissionMode = target;
    this.emit("metadataChanged");
    for (let i = 0; i < steps; i++) {
      setTimeout(() => this.pty.write("\x1b[Z"), i * PERMISSION_CYCLE_STEP_MS);
    }
    return "applied";
  }

  /**
   * Record a pending model/effort pick (made in the controller, not yet applied
   * to the PTY — applied on the next message via respawn). Surfaced in the UI as
   * "will switch to X" and cleared when respawn applies it. A pick equal to the
   * current value isn't pending — see `nextPendingPick` for the exact overlay
   * rules, including why an omitted `effort` drops any pending effort.
   */
  setPendingModel(model: ClaudeModel, effort?: EffortLevel): void {
    const { next, changed, cleared } = nextPendingPick(
      { model: this.currentModel, effort: this.currentEffort },
      { model: this.pendingModel, effort: this.pendingEffort },
      { model, effort },
    );
    modelCatalog.learnAlias(model, "pick");
    if (!changed) return;
    this.pendingModel = next.model;
    this.pendingEffort = next.effort;
    // Re-picking the running value collapses the overlay with no respawn — the
    // one path that lifts suppression without replacing the PTY. Anything the
    // transcript reported while the pick was outstanding is still true of the
    // live process, so act on it now; nothing will report it again.
    if (cleared) this.flushDeferredReconciliation();
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
    this.touch();
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
    // The bus tracks this outside its capped log (see sinceLastUserPrompt).
    const { hasPrompt, kinds } = this._bus.sinceLastUserPrompt();
    if (!hasPrompt) return false;
    const TERMINAL: readonly SessionBusEvent["kind"][] = [
      "assistant_text",
      "compact_summary",
      "slash_command",
      "interrupt",
    ];
    return !TERMINAL.some((kind) => kinds.has(kind));
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

  /**
   * Kill the PTY and release everything the session holds. Idempotent:
   * `SessionManager` calls it again when it evicts a session whose PTY exited
   * on its own, which is how a natural exit gets the same cleanup.
   */
  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    log.info("Stopping", { token: this.spawnToken });
    this.teardownStatusLineAndCapture();
    this.openToolCalls.clear();

    this.transcript?.stop();
    this.pty.kill();
    this.setStatus("stopped");
    this._agents?.dispose();
    this._bus?.dispose();
    // We got to run teardown, so there is nothing for the startup reaper to
    // clean up. The record only earns its keep when this never runs.
    forgetSpawn(this.spawnToken);
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
      currentModelId: this.reconciler.observedModelId ?? undefined,
      permissionMode: this.currentPermissionMode,
      effort: this.pendingEffort ?? this.currentEffort,
      modelPending: this.pendingModel !== null,
      runningModel: this.currentModel,
      tags: this.config.tags ?? [],
      createdAt: this.createdAt,
      statusSnapshot: this.statusSnapshot ?? undefined,
      cliVersion: this.cliVersion ?? undefined,
      cliVersionStatus: this.cliVersion
        ? classifyCliVersion(this.cliVersion, this.cliReferenceVersion)
        : undefined,
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
