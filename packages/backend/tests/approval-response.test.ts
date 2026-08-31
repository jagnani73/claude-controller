import { describe, expect, it } from "vitest";
import { buildApprovalResponse } from "../src/services/approval-response";

/**
 * The two response forms are not interchangeable, and picking the wrong one
 * fails *silently*: the CLI discards the response, loses the allow, and opens
 * its own terminal picker that the phone cannot see, so the session hangs with
 * no error. `pnpm verify:approval-edit` proves the CLI still honours each form;
 * these assert we still emit the right one per branch, which is the half that
 * does not need a live session.
 */
describe("buildApprovalResponse", () => {
  it("uses the flat form for a plain allow", () => {
    const { response, edited, rejected } = buildApprovalResponse("allow");
    expect(response).toEqual({
      hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: undefined },
    });
    expect(edited).toBe(false);
    expect(rejected).toBeUndefined();
  });

  it("uses the flat form for a deny, carrying the reason", () => {
    const { response } = buildApprovalResponse("deny", "not now");
    expect(response).toEqual({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not now" },
    });
  });

  it("switches to the schema form to carry an edited input", () => {
    // The flat form silently discards updatedInput AND loses the allow.
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
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" },
    });
    expect(edited).toBe(false);
  });

  it("keeps the flat form when there is no edit at all", () => {
    // `undefined` means "no edit", which must not drift into the schema form.
    const { response, edited } = buildApprovalResponse("allow", undefined, undefined);
    expect(response).toHaveProperty("hookSpecificOutput.permissionDecision", "allow");
    expect(edited).toBe(false);
  });

  it("approves the original call when the edit is not a plain object", () => {
    // Upstream types updatedInput as z.record(z.string(), z.unknown()). Anything
    // else fails validation and the CLI discards the whole response — so we
    // downgrade to a plain allow rather than send something that hangs.
    for (const [bad, kind] of [
      [null, "null"],
      [[1, 2], "object"],
      ["ls", "string"],
      [42, "number"],
      [true, "boolean"],
    ] as const) {
      const { response, edited, rejected } = buildApprovalResponse("allow", undefined, bad);
      expect(response, kind).toEqual({
        hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: undefined },
      });
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
