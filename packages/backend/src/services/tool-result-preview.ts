import type { ApprovalResultOutcome, ToolResultPreview } from "common/types";
import type { SessionBusEvent } from "./session-bus.service.js";

/** Wire budget for the result value (JSON-encoded UTF-8), not the bus value. */
export const TOOL_RESULT_PREVIEW_BYTES = 4096;
const cache = new WeakMap<object, { result: unknown; preview?: ToolResultPreview }>();

function approvalOutcome(value: unknown): ApprovalResultOutcome | undefined {
  const text = (
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n")
        : ""
  ).trim();
  const edit =
    /^PermissionRequest hook for \S+ returned updatedInput that failed schema validation:\s*/.exec(
      text,
    );
  if (edit)
    return {
      kind: "edit_rejected",
      reason: text.slice(edit[0].length).trim().slice(0, 1024) || text.slice(0, 1024),
    };
  if (/blocking because onFailure is "block"/.test(text))
    return { kind: "hook_failed", reason: text.slice(0, 1024) };
}

export function previewToolResult(event: Extract<SessionBusEvent, { kind: "tool_result" }>): {
  result: unknown;
  preview?: ToolResultPreview;
} {
  const cached = cache.get(event);
  if (cached) return cached;
  const encoded = JSON.stringify(event.result) ?? "null";
  const totalBytes = Buffer.byteLength(encoded);
  let projection: { result: unknown; preview?: ToolResultPreview } = { result: event.result };
  if (totalBytes > TOOL_RESULT_PREVIEW_BYTES) {
    const text = typeof event.result === "string" ? event.result : encoded;
    // Account for JSON escaping, UTF-8 and surrogate pairs; never cut encoded JSON
    // and pretend it is an object. The full response retains the original shape.
    let end = Math.min(text.length, TOOL_RESULT_PREVIEW_BYTES);
    while (Buffer.byteLength(JSON.stringify(text.slice(0, end))) > TOOL_RESULT_PREVIEW_BYTES)
      end = Math.floor(end * 0.9);
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    projection = {
      result: text.slice(0, end),
      preview: {
        truncated: true,
        format: typeof event.result === "string" ? "text" : "json",
        totalBytes,
        ...(event.isError ? { approvalOutcome: approvalOutcome(event.result) } : {}),
      },
    };
  }
  cache.set(event, projection);
  return projection;
}
