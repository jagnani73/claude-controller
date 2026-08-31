import type { CliVersionStatus } from "../version.js";

// Re-exported so consumers of `common/types` can name the type of
// `SessionInfo.cliVersionStatus` without reaching into `common/version`.
export type { CliVersionStatus };

// ─── Session metadata ─────────────────────────────────────────────

/** Session permission modes matching Claude Code CLI */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";

/** Session state */
export type SessionStatus =
  | "running"
  | "idle"
  | "waiting_for_input"
  | "paused"
  | "stopped"
  | "error";

/**
 * Model aliases passed to `--model` and `/model`. Values mirror Claude Code's
 * `MODEL_ALIASES` list (see `claude-code-source/src/utils/model/aliases.ts`).
 * `[1m]` variants opt into the 1M-token context window.
 */
export type ClaudeModel = "opus" | "opus[1m]" | "opusplan" | "sonnet" | "sonnet[1m]" | "haiku";

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
  /** Friendly model label, e.g. "Opus 4.7 (1M context)". */
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
  /** Latest Anthropic model id observed in the transcript (e.g. "claude-opus-4-7"). */
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
   * How `cliVersion` compares to `CLAUDE_CODE_TARGET_VERSION` — the build our
   * keystroke relays and JSONL parsing are verified against. Anything but
   * "match" means the relays may be driving a CLI they were not tested on.
   */
  cliVersionStatus?: CliVersionStatus;
}

/** Directory listing entry */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
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
    }
  | { type: "permission_mode"; sessionId: string; mode: PermissionMode }
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
  | { type: "compact_start"; sessionId: string; trigger: "manual" | "auto" }
  | { type: "compact_end"; sessionId: string; trigger: "manual" | "auto" }
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
      code?: "session_not_found";
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
 */
export type PlanDecision = "approve-primary" | "approve-manual";

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
    };
