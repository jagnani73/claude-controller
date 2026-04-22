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

export type HookPayload = PermissionRequestPayload | PreCompactPayload | PostCompactPayload;

export type HookEventName = HookPayload["hook_event_name"];

/** Subset of the hook response contract we actually return. */
export interface HookResponse {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}
