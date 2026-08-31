/**
 * Hook event payload types.
 * Mirrors `claude-code-source/src/entrypoints/sdk/coreSchemas.ts`.
 * Only the events we actually register hooks for are typed here.
 */

interface BaseHookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
}

export interface PermissionRequestPayload extends BaseHookPayload {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
}

export interface PreCompactPayload extends BaseHookPayload {
  hook_event_name: "PreCompact";
  trigger: "manual" | "auto";
  custom_instructions: string | null;
}

export interface PostCompactPayload extends BaseHookPayload {
  hook_event_name: "PostCompact";
  trigger: "manual" | "auto";
  compact_summary: string;
}

/**
 * Fires BEFORE a tool's permission check / interactive picker. We register it
 * scoped to `ExitPlanMode` only — it's the one signal that reaches us before
 * the plan picker opens (the `ExitPlanMode` `tool_use` is written to the JSONL
 * only after the picker resolves). Carries the real `tool_use_id`.
 */
export interface PreToolUsePayload extends BaseHookPayload {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

/**
 * Fires when the session's model changes (added upstream in 2.1.251). We
 * register only `PostModelSwitch` — `PreModelSwitch` exists to block or confirm
 * a switch, which we never want to do.
 *
 * `requested_model` is the reason this is worth having: it is the *alias* the
 * user asked for ("opus", "opus[1m]"), where the transcript only ever exposes
 * the resolved id ("claude-opus-5"). The id cannot distinguish the 1M variant,
 * so transcript-based reconciliation can only correct whole-family mismatches;
 * this can correct the alias exactly.
 *
 * Shape captured from a live 2.1.251 run rather than the frozen source snapshot,
 * which predates the event. `source` was "command" for a `/model opus` switch;
 * other values are not yet observed, so it is typed as a plain string.
 */
export interface ModelSwitchPayload extends BaseHookPayload {
  hook_event_name: "PostModelSwitch";
  /** Resolved model id before the switch, e.g. "claude-sonnet-5". */
  from_model: string;
  /** Resolved model id after the switch, e.g. "claude-opus-5". */
  to_model: string;
  /** The alias as requested, e.g. "opus". Absent if the switch had no alias. */
  requested_model?: string;
  /** What triggered the switch; "command" for `/model`. */
  source?: string;
  prompt_id?: string;
}

export type HookPayload =
  | PermissionRequestPayload
  | PreCompactPayload
  | PostCompactPayload
  | PreToolUsePayload
  | ModelSwitchPayload;

export type HookEventName = HookPayload["hook_event_name"];

/** Subset of the hook response contract we actually return. */
export interface HookResponse {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}
