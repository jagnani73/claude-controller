/**
 * Hook event payload types.
 * Mirrors `claude-code-source/src/entrypoints/sdk/coreSchemas.ts`.
 * Only the events we actually register hooks for are typed here.
 */

import type { CompactTrigger } from "common/types";

interface BaseHookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  /**
   * Present when the hook fires from inside a subagent (a tool it called, a
   * permission it needs); absent for the lead. Observed on 2.1.322 for
   * PreToolUse and PostToolUse. The source snapshot documents it for every event,
   * which `PermissionRequest` attribution relies on but has not been observed:
   * the live probes ran with permissions bypassed. Always present on
   * SubagentStart/Stop, where it names the agent itself.
   */
  agent_id?: string;
  agent_type?: string;
}

export interface PermissionRequestPayload extends BaseHookPayload {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
}

export interface PreCompactPayload extends BaseHookPayload {
  hook_event_name: "PreCompact";
  trigger: CompactTrigger;
  custom_instructions: string | null;
}

export interface PostCompactPayload extends BaseHookPayload {
  hook_event_name: "PostCompact";
  trigger: CompactTrigger;
  compact_summary: string;
}

/**
 * Fires BEFORE a tool's permission check / interactive picker. We register it
 * scoped to `ExitPlanMode` — the one signal that reaches us before the plan
 * picker opens (the `ExitPlanMode` `tool_use` is written to the JSONL only after
 * the picker resolves) — and to `SendMessage`, whose input is the agent-to-agent
 * conversation. Carries the real `tool_use_id`.
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

/**
 * A subagent (or teammate) started, including a teammate waking to handle a
 * message. Shape observed on 2.1.322: it carries no name and no agent transcript
 * path (`transcript_path` is the session's); both come from the agent's
 * `.meta.json` and the paired SubagentStop.
 */
export interface SubagentStartPayload extends BaseHookPayload {
  hook_event_name: "SubagentStart";
  agent_id: string;
  agent_type: string;
}

/**
 * A subagent stopped. For a plain subagent that is the end; a teammate stops
 * between messages and starts again, so a stop alone does not mean "finished".
 * That is decided by the agent's `.meta.json` `finished` flag, or, for a
 * teammate, by it having agreed to a shutdown request.
 */
export interface SubagentStopPayload extends BaseHookPayload {
  hook_event_name: "SubagentStop";
  agent_id: string;
  agent_type: string;
  /** Absent on the internal forked agents that stop without ever having started. */
  agent_transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

export type HookPayload =
  | PermissionRequestPayload
  | PreCompactPayload
  | PostCompactPayload
  | PreToolUsePayload
  | ModelSwitchPayload
  | SubagentStartPayload
  | SubagentStopPayload;

export type HookEventName = HookPayload["hook_event_name"];

/**
 * Subset of the hook response contract we actually return.
 *
 * NB the shape: `claude-code-source` (v2.1.87) defines PermissionRequest's
 * output as `{ hookEventName, decision: { behavior, updatedInput } }`, which is
 * *not* what we send — we send the flatter `permissionDecision` form, and it is
 * verified working against 2.1.251 for both allow and deny. The snapshot
 * predates the build we drive, so live behaviour wins over the schema; don't
 * "fix" this to match the snapshot without re-testing an actual approval.
 */
export type HookResponse =
  | Record<string, never>
  | {
      /** Flat form — verified working on 2.1.251 for plain allow/deny. */
      hookSpecificOutput: {
        permissionDecision: "allow" | "deny";
        permissionDecisionReason?: string;
      };
    }
  | {
      /**
       * Schema form, required to carry `updatedInput`.
       *
       * Adding `updatedInput` to the flat form does NOT work: the CLI ignores
       * the whole response and falls through to its own terminal picker, which
       * the phone cannot see — the session then hangs with no error anywhere.
       * Verified against 2.1.251 by observing the picker in a PTY capture.
       */
      hookSpecificOutput: {
        hookEventName: "PermissionRequest";
        decision:
          | { behavior: "allow"; updatedInput?: unknown }
          | { behavior: "deny"; message?: string };
      };
    };
