import type { HookResponse } from "../types/hook.types.js";

/** Matches upstream's `z.record(z.string(), z.unknown())` for `updatedInput`. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface ApprovalOutcome {
  response: HookResponse;
  /** True when the schema form was chosen to carry an edited tool input. */
  edited: boolean;
  /**
   * Set when an `updatedInput` was supplied but unusable, naming what arrived
   * ("null", "string", ...). The edit is dropped and the original call approved;
   * the caller logs it.
   */
  rejected?: string;
}

/**
 * Build the hook response for an approval decision.
 *
 * **The shape differs by path, and that is load-bearing.** A plain allow/deny
 * uses the flat `{permissionDecision}` form. `updatedInput` — the phone
 * approving a *corrected* call — is honoured only in the schema form
 * `{hookEventName, decision:{behavior, updatedInput}}`. Putting `updatedInput`
 * on the flat form makes the CLI discard the entire response, lose the allow,
 * and fall through to its own terminal picker, which the phone cannot see: the
 * session hangs with no error anywhere. Both forms are verified live against
 * `CLAUDE_CODE_TARGET_VERSION`; don't unify them without re-testing a real
 * approval (`pnpm verify:approval-edit`).
 *
 * `updatedInput` is deliberately ignored on `deny`, so a denial can never
 * smuggle in a modified call.
 *
 * Pure so the four branches (allow, allow+edit, deny, deny+edit) can be
 * asserted without a CLI — getting this shape wrong hangs a session silently,
 * which is exactly the kind of thing that should not need a live session to
 * catch.
 */
export function buildApprovalResponse(
  decision: "allow" | "deny",
  reason?: string,
  updatedInput?: unknown,
): ApprovalOutcome {
  const flat: HookResponse = {
    hookSpecificOutput: {
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  if (decision !== "allow" || updatedInput === undefined) {
    return { response: flat, edited: false };
  }
  // Validate rather than trusting the client. Upstream types this as
  // `z.record(z.string(), z.unknown())`, so null, an array or a scalar fails
  // validation and the CLI discards the whole response — the silent hang this
  // shape exists to avoid. `ApprovalCard` already guards, but a stale cached PWA
  // bundle or any non-browser client reaches this path too, and a bare
  // `!== undefined` would happily forward `null`.
  if (!isPlainObject(updatedInput)) {
    return {
      response: flat,
      edited: false,
      rejected: updatedInput === null ? "null" : typeof updatedInput,
    };
  }
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput },
      },
    },
    edited: true,
  };
}
