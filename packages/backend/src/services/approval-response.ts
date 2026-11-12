import type { HookResponse } from "../types/hook.types.js";

/** Matches upstream's `z.record(z.string(), z.unknown())` for `updatedInput`. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The hook response for an approval, and what happened to any edited input.
 * Named apart from the frontend's `ApprovalOutcome` (what a card displays).
 *  - `plain`: an allow or deny with no edit.
 *  - `edited`: an allow carrying `updatedInput`.
 *  - `rejected`: an `updatedInput` was supplied but unusable; `rejected` names
 *    what arrived ("null", "string", ...). The edit is dropped and the original
 *    call approved; the caller logs it.
 * `edited` mirrors `kind === "edited"` for callers that only need the flag; the
 * union makes "edited and rejected at once" unrepresentable.
 */
export type ApprovalDecision =
  | { kind: "plain"; response: HookResponse; edited: false; rejected?: undefined }
  | { kind: "edited"; response: HookResponse; edited: true; rejected?: undefined }
  | { kind: "rejected"; response: HookResponse; edited: false; rejected: string };

/** Sent to Claude as the deny `message` when the user gave no reason. */
export const DEFAULT_DENY_MESSAGE = "The user denied this tool call from Claude Controller.";

/**
 * Build the hook response for an approval decision.
 *
 * **Every decision uses the schema form**
 * `{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior, ...}}}`.
 * That is the only PermissionRequest shape the hooks reference documents, and the
 * only one observed to be honoured on 2.1.322: the PreToolUse-style flat `{permissionDecision}` form was
 * ignored outright for a plain allow AND a plain deny (checked live: the CLI
 * opened its own "Do you want to create …?" terminal picker, which the phone
 * cannot see, and the session hung with no error anywhere). The same thing had
 * long been true of an `updatedInput` on the flat form. Don't reintroduce the
 * flat form without re-testing a real approval of each kind.
 *
 * A deny always carries a `message` (Claude reads it as the reason). `updatedInput`
 * is deliberately ignored on `deny`, so a denial can never smuggle in a
 * modified call.
 *
 * Since 2.1.300 the CLI validates `updatedInput` like Claude's own input: unknown
 * keys are dropped silently, and input the tool rejects denies the call with a
 * tool_result starting `PermissionRequest hook for <Tool> returned updatedInput
 * that failed schema validation:` — the frontend shows that on the card.
 *
 * Pure so the branches (allow, allow+edit, deny, deny+edit) can be asserted
 * without a CLI — getting this shape wrong hangs a session silently, which is
 * exactly the kind of thing that should not need a live session to catch.
 */
export function buildApprovalResponse(
  decision: "allow" | "deny",
  reason?: string,
  updatedInput?: unknown,
): ApprovalDecision {
  if (decision === "deny") {
    return {
      kind: "plain",
      response: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: reason?.trim() || DEFAULT_DENY_MESSAGE },
        },
      },
      edited: false,
    };
  }
  const plainAllow: HookResponse = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  };
  if (updatedInput === undefined) {
    return { kind: "plain", response: plainAllow, edited: false };
  }
  // Validate rather than trusting the client. Upstream types this as
  // `z.record(z.string(), z.unknown())`, so null, an array or a scalar fails
  // validation, and with `onFailure: "block"` (hooks-config.ts) an invalid
  // response is a denial. `ApprovalCard` already guards, but a stale cached PWA
  // bundle or any non-browser client reaches this path too, and a bare
  // `!== undefined` would happily forward `null`.
  if (!isPlainObject(updatedInput)) {
    return {
      kind: "rejected",
      response: plainAllow,
      edited: false,
      rejected: updatedInput === null ? "null" : typeof updatedInput,
    };
  }
  return {
    kind: "edited",
    response: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput },
      },
    },
    edited: true,
  };
}
