import { describe, expect, it } from "vitest";
import { buildApprovalResponse, DEFAULT_DENY_MESSAGE } from "../src/services/approval-response";

/**
 * Picking the wrong response shape fails *silently*: the CLI ignores the
 * response and opens its own terminal picker that the phone cannot see, so the
 * session hangs with no error. On 2.1.322 only the schema form is honoured, for
 * every decision. `pnpm verify:approval-edit` proves the CLI still honours it;
 * these assert we still emit it per branch, which is the half that does not
 * need a live session.
 */
const allow = {
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
};

describe("buildApprovalResponse", () => {
  it("uses the schema form for a plain allow", () => {
    const { response, edited, rejected } = buildApprovalResponse("allow");
    expect(response).toEqual(allow);
    expect(edited).toBe(false);
    expect(rejected).toBeUndefined();
  });

  it("uses the schema form for a deny, carrying the reason as the message", () => {
    const { response } = buildApprovalResponse("deny", "not now");
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "not now" },
      },
    });
  });

  it("gives a deny without a reason a default message", () => {
    const { response } = buildApprovalResponse("deny");
    expect(response).toHaveProperty("hookSpecificOutput.decision.message", DEFAULT_DENY_MESSAGE);
  });

  it("carries an edited input on the allow", () => {
    const { response, edited } = buildApprovalResponse("allow", undefined, { command: "ls -la" });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { command: "ls -la" } },
      },
    });
    expect(edited).toBe(true);
  });

  it("never lets a denial smuggle in a modified call", () => {
    const { response, edited } = buildApprovalResponse("deny", "no", { command: "rm -rf /" });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "no" },
      },
    });
    expect(edited).toBe(false);
  });

  it("sends no updatedInput when there is no edit at all", () => {
    // `undefined` means "no edit", which must not drift into an edit.
    const { response, edited } = buildApprovalResponse("allow", undefined, undefined);
    expect(response).toEqual(allow);
    expect(edited).toBe(false);
  });

  it("approves the original call when the edit is not a plain object", () => {
    // Upstream types updatedInput as z.record(z.string(), z.unknown()). Anything
    // else fails validation, which onFailure "block" turns into a denial — so we
    // downgrade to a plain allow rather than send something invalid.
    for (const [bad, kind] of [
      [null, "null"],
      [[1, 2], "object"],
      ["ls", "string"],
      [42, "number"],
      [true, "boolean"],
    ] as const) {
      const { response, edited, rejected } = buildApprovalResponse("allow", undefined, bad);
      expect(response, kind).toEqual(allow);
      expect(edited, kind).toBe(false);
      expect(rejected, kind).toBe(kind);
    }
  });

  it("treats an empty object as a real edit", () => {
    // `{}` is a valid record — clearing every field is a legitimate correction,
    // and it must not be confused with "no edit supplied".
    const { response, edited } = buildApprovalResponse("allow", undefined, {});
    expect(edited).toBe(true);
    expect(response).toHaveProperty("hookSpecificOutput.decision.updatedInput", {});
  });
});
