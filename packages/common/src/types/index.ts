import type { CliVersionStatus } from "../version.js";

// Re-exported so consumers of `common/types` can name the type of
// `SessionInfo.cliVersionStatus` without reaching into `common/version`.
export type { CliVersionStatus };

// ─── Session metadata ─────────────────────────────────────────────

/** Session permission modes matching Claude Code CLI */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";

/** Runtime-checkable list of {@link PermissionMode} for validating untrusted input. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];

/**
 * Narrow an arbitrary string to a {@link PermissionMode}.
 *
 * Claude Code has modes we don't model (`dontAsk`, `bypassPermissions`), and
 * the transcript records whichever one is active, so anything unrecognized must
 * be ignored rather than coerced into the union: `cycleDistance` from an unknown
 * mode is 0, so a later phone-side mode change would silently do nothing.
 */
export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * What started a compaction (`PreCompact`/`PostCompact` `trigger`). `manual` and
 * `auto` are the values we have seen; idle compaction (2.1.299+) may report
 * something else, so any string is accepted. The `Record<never, never>`
 * intersection keeps the known values in autocomplete.
 */
export type CompactTrigger = "manual" | "auto" | (string & Record<never, never>);

/** Session state */
export type SessionStatus =
  | "running"
  | "idle"
  | "waiting_for_input"
  | "paused"
  | "stopped"
  | "error";

/**
 * The documented model aliases: the seed list for the picker, and the only ones
 * whose capabilities (effort tiers, the Shift+Tab cycle) have been verified.
 * Values mirror Claude Code's `MODEL_ALIASES` list (see
 * `claude-code-source/src/utils/model/aliases.ts`). `[1m]` variants opt into the
 * 1M-token context window.
 */
export type KnownClaudeModel = "opus" | "opus[1m]" | "opusplan" | "sonnet" | "sonnet[1m]" | "haiku";

/**
 * Any other value of valid shape — an alias learned at runtime (`fable`) or a
 * full model id (`claude-fable-5-2`), both of which `--model` accepts. Branded so
 * an untrusted string has to pass {@link isClaudeModel} before it becomes one.
 */
export type LearnedClaudeModel = string & { readonly __brand: "ClaudeModel" };

/**
 * A value for `--model` / `/model`. Open on purpose: Claude Code adds model
 * families over time, and a closed set turns each one into a stale alias that the
 * next respawn passes back as `--model`, silently switching the session.
 */
export type ClaudeModel = KnownClaudeModel | LearnedClaudeModel;

/** The {@link KnownClaudeModel} seed list, in picker order. */
export const CLAUDE_MODELS: readonly KnownClaudeModel[] = [
  "opus",
  "opus[1m]",
  "opusplan",
  "sonnet",
  "sonnet[1m]",
  "haiku",
];

/** True for one of the documented, capability-verified aliases. */
export function isKnownClaudeModel(value: string): value is KnownClaudeModel {
  return (CLAUDE_MODELS as readonly string[]).includes(value);
}

// Lowercase alphanumeric words joined by `-` or `.`, with an optional `[1m]`.
// Covers aliases (`fable`, `opus[1m]`) and full ids (`claude-fable-5-2`,
// `claude-haiku-4-5-20251001`); rejects whitespace, case and shell syntax.
const MODEL_SHAPE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\[1m\])?$/;

/**
 * Narrow an arbitrary string to a {@link ClaudeModel} by **shape**, not by
 * membership: anything that looks like a CLI alias or a model id is accepted, so
 * a family released after this code was written is not dropped. Junk (empty,
 * uppercase, whitespace, punctuation, overlong) is rejected.
 */
export function isClaudeModel(value: string): value is ClaudeModel {
  return value.length <= 64 && MODEL_SHAPE.test(value);
}

/**
 * What the backend has learned about models at runtime (in memory only).
 * `aliases` are values observed working — a `PostModelSwitch` `requested_model`,
 * a controller pick, or the user's `settings.json` `model` — beyond the
 * {@link CLAUDE_MODELS} seed. `modelIds` holds the newest transcript model id
 * seen per family, for picker hints.
 */
export interface ModelCatalog {
  aliases: ClaudeModel[];
  modelIds: string[];
}

/**
 * Effort levels accepted by `/effort`. Gating notes:
 *  - `low | medium | high`: any model that supports effort (i.e. not Haiku)
 *  - `xhigh`: Opus 4.7+ only (per Claude Code's runtime hint)
 *  - `max`: Opus family only
 *  - `auto`: clears the override — Claude Code falls back to the model default
 */
export type EffortLevel = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

/** Runtime-checkable list of {@link EffortLevel} for validating untrusted input. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Narrow an arbitrary string to an {@link EffortLevel}.
 *
 * Claude Code accepts levels we deliberately don't model (`ultracode`), and the
 * set grows over releases, so anything unrecognized must be ignored rather than
 * coerced into the union.
 */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Session configuration when spawning */
export interface SessionConfig {
  name?: string;
  cwd: string;
  model: ClaudeModel;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  tags?: string[];
  /** When set, pass `--resume <id>` to pick up an existing session's transcript. */
  resumeSessionId?: string;
}

/** Summary of an existing session on disk that can be resumed. */
export interface ProjectSessionSummary {
  id: string;
  cwd: string;
  lastModified: number;
  firstPrompt: string | null;
  turnCount: number;
}

/** Optional rate-limit window pulled from Claude Code's dumped status payload. */
export interface RateLimitWindow {
  /** 0..100. Percentage of the budget already consumed in this window. */
  usedPercentage: number;
  /** Unix epoch (seconds) when the budget resets. */
  resetsAt: number;
}

/** Latest snapshot of Claude Code's status payload — surfaced to the top bar. */
export interface SessionStatusSnapshot {
  /** Friendly model label from Claude Code, e.g. "<Family> <version> (1M context)". */
  modelDisplayName?: string;
  contextUsedPercentage?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  costUsd?: number;
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
}

/** Session metadata displayed on dashboard */
export interface SessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  cwd: string;
  /** Alias passed to `--model` at create time. */
  model: ClaudeModel;
  /**
   * Latest Anthropic model id observed in the transcript (`claude-<family>-<version>`).
   * Format it for display with `formatModelName` (`common/model`).
   */
  currentModelId?: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  /**
   * True when `model`/`effort` reflect a *pending* user pick (set in the
   * controller, not yet applied to the running PTY — applied on the next
   * message via respawn). The UI surfaces this so the badge reads as
   * "will switch to X" rather than implying the model already changed.
   */
  modelPending?: boolean;
  /**
   * The alias the PTY is running right now. Equals `model` unless a pick is
   * pending. Use it for anything that acts on the running process (walking the
   * Shift+Tab cycle, labelling the plan picker); `model` is what the next
   * respawn will run.
   */
  runningModel?: ClaudeModel;
  tags: string[];
  createdAt: number;
  /** Live snapshot from Claude Code's statusline payload, when available. */
  statusSnapshot?: SessionStatusSnapshot;
  /**
   * Claude Code version actually driving this session, read from the transcript
   * (the CLI stamps it on every user/assistant/system entry). Undefined until
   * the first versioned entry lands. Sourced from the transcript rather than the
   * statusline payload because the latter only flows when the user has a
   * statusline command configured.
   */
  cliVersion?: string;
  /**
   * How `cliVersion` compares to the installed Claude Code binary, whose version
   * the backend resolves once at startup (falling back to the static
   * `CLAUDE_CODE_TARGET_VERSION` if that probe fails). Anything but "match" means
   * this session runs a different build than the one installed now.
   */
  cliVersionStatus?: CliVersionStatus;
}

/** Directory listing entry */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

// ─── Agents (subagents / teammates) ───────────────────────────────
//
// Every subagent a session spawns writes its own sidechain transcript. The
// controller treats each one as a *virtual session*: same transcript pipeline,
// same event shapes, addressed by a composite stream id instead of a PTY-backed
// session id. Anything that needs a real PTY (input, interrupt, respawn) must
// reject these ids — see `parseAgentStreamId`.

const AGENT_STREAM_SEP = "::agent::";

/**
 * A composite id under which one agent's events travel. Branded so the compiler
 * can tell it from a PTY-backed session id: handing one to `SessionManager` is a
 * bug the type system should catch, not something found at runtime.
 */
export type AgentStreamId = string & { readonly __brand: "AgentStreamId" };

/** Build the stream id for one agent (`<sessionId>::agent::<agentId>`). */
export function agentStreamId(sessionId: string, agentId: string): AgentStreamId {
  return `${sessionId}${AGENT_STREAM_SEP}${agentId}` as AgentStreamId;
}

/** Inverse of {@link agentStreamId}; null for an ordinary (PTY-backed) session id. */
export function parseAgentStreamId(id: string): { sessionId: string; agentId: string } | null {
  const at = id.indexOf(AGENT_STREAM_SEP);
  if (at <= 0) return null;
  const agentId = id.slice(at + AGENT_STREAM_SEP.length);
  if (!agentId) return null;
  return { sessionId: id.slice(0, at), agentId };
}

/**
 * Lifecycle of one agent.
 *  - `running` - a SubagentStart has fired and no stop has followed. Reset to `idle`
 *    when the session's process exits or respawns (nothing is running then).
 *  - `idle`    - stopped but may wake again (a teammate waiting on its inbox).
 *  - `done`    - will not run again: its `meta.json` says `finished`, or it stopped
 *    after agreeing to a shutdown request. A start (a wake) takes it back to
 *    `running`; teammates ended any other way (a torn-down team, a kill) are not
 *    detectable and stay `idle`.
 */
export type AgentStatus = "running" | "idle" | "done";

/** One node of the agent tree. */
export interface AgentNode {
  agentId: string;
  /** Id under which this agent's transcript events and history are addressed. */
  streamId: AgentStreamId;
  /** Teammate name (`alpha`); absent for an unnamed subagent. */
  name?: string;
  /** Agent type (`general-purpose`, `code-reviewer`, …). */
  agentType: string;
  /** The `description` the parent gave the Agent tool call. */
  description?: string;
  /** Agent that spawned this one; null for the lead (the main session). */
  parentAgentId: string | null;
  /** The parent's `Agent` tool_use id this agent was spawned from. */
  toolUseId?: string;
  spawnDepth?: number;
  status: AgentStatus;
  /** Launched with `run_in_background` (or as a teammate). */
  background?: boolean;
  startedAt: number;
  lastActivityAt: number;
  /** Most recent tool the agent called — a cheap "what is it doing" hint. */
  activity?: string;
  /** The agent's last assistant message, from its SubagentStop. */
  lastMessage?: string;
}

/** One agent-to-agent (or lead-to-agent) `SendMessage`. */
export interface AgentMessage {
  id: string;
  /** Sending agent; null when the lead sent it. */
  fromAgentId: string | null;
  /** Recipient exactly as addressed: a teammate name, an agent id, or `*`. */
  to: string;
  /**
   * Resolved recipient. Three states on purpose: a string is a known agent, `null`
   * is the lead, and absent means unresolved or a broadcast (`to` is then the only
   * truth). `fromAgentId` uses `null` for the lead the same way.
   */
  toAgentId?: string | null;
  /**
   * `message` for ordinary text, otherwise the structured protocol type. The known
   * ones are listed for autocomplete; the CLI may add more, so any string is valid.
   */
  kind:
    | "message"
    | "shutdown_request"
    | "shutdown_response"
    | "shutdown_approved"
    | "shutdown_rejected"
    | (string & Record<never, never>);
  summary?: string;
  text: string;
  timestamp: string;
}

// ─── WebSocket message protocol ───────────────────────────────────

/** Server → Client messages */
export type ServerMessage =
  | { type: "connected"; sessions: SessionInfo[]; workDir: string }
  | { type: "session_created"; session: SessionInfo }
  | { type: "session_stopped"; sessionId: string; exitCode: number | null }
  | { type: "session_metadata"; session: SessionInfo }
  | { type: "user_prompt"; sessionId: string; text: string; timestamp: string }
  | {
      type: "assistant_text";
      sessionId: string;
      text: string;
      turnId: string;
      timestamp: string;
    }
  | {
      type: "tool_call";
      sessionId: string;
      toolUseId: string;
      name: string;
      input: unknown;
      timestamp: string;
    }
  | {
      type: "tool_result";
      sessionId: string;
      toolUseId: string;
      result: unknown;
      isError: boolean;
      timestamp: string;
    }
  | {
      type: "approval_request";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      /** Set when a subagent (not the lead) is the one asking; `label` is its name, else its type. */
      agent?: { id: string; label: string };
    }
  | {
      /**
       * Claude Code stopped waiting for this approval before it was answered:
       * its `PermissionRequest` HTTP request closed (Esc, a respawn, an answer
       * typed in the terminal, the hook timeout). The card must lock; an answer
       * sent now would reach nothing.
       */
      type: "approval_expired";
      sessionId: string;
      toolUseId: string;
      reason: string;
    }
  /** Reply to a client `ping`; lets the PWA tell a live socket from a half-open one. */
  | { type: "pong" }
  | { type: "agents_snapshot"; sessionId: string; agents: AgentNode[]; messages: AgentMessage[] }
  | { type: "agent_update"; sessionId: string; agent: AgentNode }
  | { type: "agent_message"; sessionId: string; message: AgentMessage }
  | {
      /**
       * A `subscribe_agent` that cannot be served. Without this the viewer cannot
       * tell a missing transcript from an agent that simply has not written yet.
       * `sessionId` is the agent's stream id, as on its other events.
       */
      type: "agent_unavailable";
      sessionId: string;
      reason: "unknown_agent" | "transcript_missing" | "failed";
      message: string;
    }
  | { type: "permission_mode"; sessionId: string; mode: PermissionMode }
  /** Sent on connect and whenever the backend learns a model alias or family. */
  | { type: "model_catalog"; catalog: ModelCatalog }
  | { type: "session_taken_over"; sessionId: string }
  | {
      type: "history_available";
      sessionId: string;
      earliestIndex: number;
      hasMore: boolean;
    }
  | {
      type: "history_page";
      sessionId: string;
      events: ServerMessage[];
      fromIndex: number;
      hasMore: boolean;
    }
  | { type: "status_line"; sessionId: string; text: string }
  | {
      type: "compact_start";
      sessionId: string;
      trigger: CompactTrigger;
      /** Backend receive time of the `PreCompact` hook (ISO). Lets the client
       * tell activity written after the compaction began from activity that
       * merely arrived late through the transcript tail. */
      timestamp: string;
    }
  | { type: "compact_end"; sessionId: string; trigger: CompactTrigger }
  | { type: "compact_summary"; sessionId: string; text: string; timestamp: string }
  | { type: "interrupt"; sessionId: string; timestamp: string }
  | {
      type: "slash_command";
      sessionId: string;
      name: string;
      args?: string;
      /** Stdout from the local command (e.g. `/effort`'s feedback). */
      output?: string;
      timestamp: string;
    }
  | {
      type: "error";
      message: string;
      sessionId?: string;
      /** Optional machine-readable code so callers can branch on intent. */
      code?:
        | "session_not_found"
        | "permission_mode_unverified"
        /** Input or a slash command reached a session with no live PTY. */
        | "session_stopped"
        /** An `approval_response` arrived after the approval stopped pending. */
        | "approval_expired"
        /** Opening (or resuming) the session for a `subscribe` failed. */
        | "subscribe_failed";
      /** The approval an `approval_expired` error refers to. */
      toolUseId?: string;
    }
  | { type: "dir_list"; path: string; entries: DirEntry[] }
  | {
      type: "project_sessions";
      cwd: string;
      sessions: ProjectSessionSummary[];
      total: number;
      offset: number;
      query: string;
    };

/**
 * Settings the client attaches to every `input` / `slash_command` so the
 * backend can respawn the PTY with the user's latest intent before forwarding.
 * All three are sent on every message; the backend respawns only when one or
 * more values actually differ from the running PTY's args/env.
 */
export interface RespawnSettings {
  model: ClaudeModel;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
}

// ─── AskUserQuestion relay ────────────────────────────────────────
// Shared shapes for relaying an AskUserQuestion answer from the client to the
// backend keystroke driver. Single source of truth — the backend imports these
// rather than re-declaring them (avoids the wire/driver shapes silently
// drifting).

/** Schema of one original tool-call question, in order. Passed through by the
 *  client so the backend can compute keystroke navigation without caching
 *  state. `optionLabels` must match `options[].label` from the tool input. */
export interface QuestionSchema {
  multiSelect: boolean;
  optionLabels: string[];
  /** True when the question renders the preview view (a single-select whose
   *  options carry preview content). Gates the notes (`n`) keystroke path —
   *  notes only exist on that view. */
  hasPreview?: boolean;
}

/** One answer, positional with `QuestionSchema[]`. */
export interface AnswerEntry {
  /** Labels matching `options[].label`. One entry for single-select;
   *  zero-or-more for multi-select; empty if only `customText` is used. */
  selectedLabels?: string[];
  /** Free-text typed into the "Type something" slot. */
  customText?: string;
  /** Note attached to the selected option (`n` key) — only honored for a
   *  single-select question whose options carry previews. */
  notes?: string;
}

/** A tool result projected for rendering: the raw value plus the error flag. */
export interface ToolResult {
  value: unknown;
  isError: boolean;
}

// ─── Plan-mode relay ──────────────────────────────────────────────
// `ExitPlanMode` is handled inside the CLI's ink picker (behavior:'ask') and
// fires NO HTTP hook — the plan only reaches us as a `tool_call` (input.plan).
// So, like AskUserQuestion, the answer is driven by synthesizing keystrokes
// into the PTY (the ink picker commits on a number key: 1=auto-accept edits,
// 2=manually approve, 3=keep planning + feedback). Confirmation rides the
// existing `tool_result` for the ExitPlanMode toolUseId.

/**
 * A user's response to an `ExitPlanMode` plan picker.
 * - `approve-primary` → the elevated keep-context approve (picker position 1):
 *   "use auto mode" when the model supports it, else "auto-accept edits".
 * - `approve-manual` → "manually approve edits" (position 2) → default mode.
 * The Stop/keep-planning action uses the `cancel` flag (Esc), not a decision.
 *
 * For a planless call (see {@link planTextOf}) the CLI may show a two-option
 * "Exit plan mode? 1. Yes / 2. No" picker instead, so both decisions mean
 * "Yes" (`1`) there and `2` is never sent.
 */
export type PlanDecision = "approve-primary" | "approve-manual";

/**
 * The plan text of an `ExitPlanMode` input, or null when it has none.
 *
 * Load-bearing, not cosmetic: a call with no plan text is the case where the
 * CLI (2.1.322) can show the two-option "Exit plan mode?" picker, in which `2`
 * means *No*. Frontend (which card to draw) and backend (which keys to send)
 * must agree on it, so it lives here.
 */
export function planTextOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const plan = (input as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

/** Client → Server messages */
export type ClientMessage =
  | { type: "input"; sessionId: string; text: string; settings?: RespawnSettings }
  | { type: "slash_command"; sessionId: string; command: string; settings?: RespawnSettings }
  | { type: "interrupt"; sessionId: string }
  | {
      /**
       * Mirror Claude Code's `/effort` / `/model` slash commands on the
       * controller side: write the new value to `~/.claude/settings.json` so
       * future sessions and external `claude` invocations inherit it, and
       * push a notification bubble onto every active session's bus so
       * sessions other than the originating one see why their settings
       * changed. Per-session env-var update is handled by the frontend via
       * `updateSettings` and applied on each session's next respawn.
       */
      type: "update_global_setting";
      key: "effortLevel" | "model";
      value: string;
      originSessionId: string;
    }
  | {
      type: "approval_response";
      sessionId: string;
      toolUseId: string;
      decision: "allow" | "deny";
      reason?: string;
      /**
       * Replacement tool input, sent with an `allow` to approve a *corrected*
       * call rather than the one Claude proposed — fixing a wrong path is
       * usually better than denying and re-prompting from a phone.
       *
       * Must be the complete input object, not a patch: Claude Code substitutes
       * it wholesale. Omit to approve the call unchanged. Ignored on `deny`.
       */
      updatedInput?: unknown;
    }
  | {
      /**
       * Reply to an `AskUserQuestion` tool call. The CLI's interactive
       * permission UI doesn't go through HTTP hooks — answers are driven by
       * synthesizing keystrokes into the PTY stdin. The backend translates
       * this message into a sequence of bytes that navigates the ink UI and
       * submits. `questions` and `answers` are positional and must line up.
       */
      type: "question_response";
      sessionId: string;
      toolUseId: string;
      /** When true, send Esc to the CLI and ignore `answers`. */
      cancel?: boolean;
      /** Question schema in order (see QuestionSchema). */
      questions?: QuestionSchema[];
      /** Answers, positional with `questions`. */
      answers?: AnswerEntry[];
    }
  | {
      /**
       * Reply to an `ExitPlanMode` plan picker. Like `question_response`, the
       * CLI's picker isn't HTTP-hookable — the backend translates this into
       * keystrokes written to the PTY: `1` (approve-primary) / `2`
       * (approve-manual), or Esc (`cancel`, keep planning). Confirmation rides
       * the `tool_result` for `toolUseId`.
       */
      type: "plan_response";
      sessionId: string;
      toolUseId: string;
      decision: PlanDecision;
      /** When true, send Esc (keep planning / dismiss); `decision` is ignored. */
      cancel?: boolean;
    }
  | {
      /**
       * Record a *pending* model/effort pick made in the controller. The pick
       * isn't applied to the PTY until the next message (respawn), so the
       * backend holds it as pending and echoes it via `session_metadata`
       * (`modelPending: true`) so the UI can show "will switch to X". Permission
       * mode is NOT here — it applies immediately via `set_permission_mode`.
       */
      type: "set_pending_model";
      sessionId: string;
      model: ClaudeModel;
      effort?: EffortLevel;
    }
  | {
      type: "subscribe";
      sessionId: string;
      /**
       * If set and the backend doesn't have this session in memory, it will
       * auto-resume by spawning Claude Code with `--resume <sessionId>` using
       * these settings. Used for page-refresh / backend-restart recovery —
       * the frontend persists last-known config in localStorage keyed by
       * session id.
       */
      resumeConfig?: Omit<SessionConfig, "resumeSessionId">;
    }
  | {
      /**
       * Detach this WS from a session's event stream without stopping the
       * session itself. Sent by the frontend when SessionView unmounts (e.g.
       * navigating back to `/`). Without it, the backend keeps streaming
       * bus events over the WS to a viewer that has nothing rendered.
       */
      type: "unsubscribe";
      sessionId: string;
    }
  | {
      /**
       * Start receiving one agent's transcript events (read-only). Replays the
       * tail of its history under `agentStreamId(sessionId, agentId)`, the same
       * way `subscribe` does for a session. Several agents can be watched at once,
       * but all of them end when the session subscription does.
       */
      type: "subscribe_agent";
      sessionId: string;
      agentId: string;
    }
  | { type: "unsubscribe_agent"; sessionId: string; agentId: string }
  | { type: "create_session"; config: SessionConfig }
  | { type: "stop_session"; sessionId: string }
  | { type: "list_dirs"; path: string }
  | {
      type: "list_project_sessions";
      cwd: string;
      offset?: number;
      limit?: number;
      query?: string;
    }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "set_permission_mode"; sessionId: string; mode: PermissionMode }
  | {
      type: "fetch_history";
      sessionId: string;
      beforeIndex: number;
      limit: number;
    }
  /** Liveness probe; the server answers `pong`. See the heartbeat in ws.service (frontend). */
  | { type: "ping" };
