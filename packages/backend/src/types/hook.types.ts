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

export type HookPayload =
  | PermissionRequestPayload
  | PreCompactPayload
  | PostCompactPayload
  | PreToolUsePayload;

export type HookEventName = HookPayload["hook_event_name"];

/** Subset of the hook response contract we actually return. */
export interface HookResponse {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}
