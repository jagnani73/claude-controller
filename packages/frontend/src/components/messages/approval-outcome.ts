/**
 * What Claude Code actually did with an answered approval, when that differs
 * from what the card would otherwise claim.
 *
 * Both cases arrive only as the tool call's error `tool_result` in the
 * transcript (texts verified live on 2.1.322):
 *
 * - `edit_rejected`: since 2.1.300 an `updatedInput` is validated like Claude's
 *   own input. Unknown keys are dropped silently (the call runs), but input the
 *   tool rejects denies the call:
 *   `PermissionRequest hook for Write returned updatedInput that failed schema
 *   validation: Write failed due to the following issue:\nThe required parameter
 *   \`content\` is missing\nThe tool input from the model was valid; the hook's
 *   rewrite of it was not.`
 * - `hook_failed`: the PermissionRequest hook is registered with
 *   `onFailure: "block"`, so a backend that is down, a timeout, or a bad response
 *   denies the call: `[http hook]: timed out; blocking because onFailure is
 *   "block"` (or `failed; …` plus the cause, e.g. `the request failed
 *   (ECONNREFUSED)`).
 */
export interface ApprovalOutcome {
  kind: "edit_rejected" | "hook_failed";
  reason: string;
}

interface ToolLike {
  kind: "tool";
  toolName: string;
  input: unknown;
  result: { value: unknown; isError: boolean } | null;
}

interface ApprovalLike {
  kind: "approval";
  id: string;
  toolName: string;
  toolInput: unknown;
}

type ItemLike = ToolLike | ApprovalLike | { kind: string };

const EDIT_REJECTED =
  /^PermissionRequest hook for \S+ returned updatedInput that failed schema validation:\s*/;
const HOOK_FAILED = /blocking because onFailure is "block"/;

/** Classify a tool result as one of the approval failures above, or null. */
export function classifyApprovalResult(result: ToolLike["result"]): ApprovalOutcome | null {
  if (!result?.isError) return null;
  const text = resultText(result.value).trim();
  const edit = EDIT_REJECTED.exec(text);
  if (edit) return { kind: "edit_rejected", reason: text.slice(edit[0].length).trim() || text };
  if (HOOK_FAILED.test(text)) return { kind: "hook_failed", reason: text };
  return null;
}

/**
 * Map approval card id → outcome, for every approval whose call ended in one of
 * the failures above.
 *
 * The approval's id is synthesized (PermissionRequest carries no
 * `tool_use_id`), so it is paired with its call by tool name and input. The
 * input is the model's original either way (the transcript records Claude's
 * call, not the edit), compared with sorted keys so key order cannot break it.
 * Each approval takes the first unpaired matching call after it, falling back to
 * the nearest one before it in case the transcript beat the hook.
 */
export function approvalOutcomes(items: readonly ItemLike[]): Map<string, ApprovalOutcome> {
  const out = new Map<string, ApprovalOutcome>();
  const tools: { index: number; key: string; item: ToolLike }[] = [];
  items.forEach((it, index) => {
    if (it.kind === "tool") {
      const tool = it as ToolLike;
      tools.push({ index, key: callKey(tool.toolName, tool.input), item: tool });
    }
  });
  if (tools.length === 0) return out;
  const paired = new Set<number>();
  items.forEach((it, index) => {
    if (it.kind !== "approval") return;
    const approval = it as ApprovalLike;
    const key = callKey(approval.toolName, approval.toolInput);
    let match = tools.find((t) => t.index > index && t.key === key && !paired.has(t.index));
    if (!match) {
      for (let i = tools.length - 1; i >= 0; i--) {
        const t = tools[i];
        if (t.index < index && t.key === key && !paired.has(t.index)) {
          match = t;
          break;
        }
      }
    }
    if (!match) return;
    paired.add(match.index);
    const outcome = classifyApprovalResult(match.item.result);
    if (outcome) out.set(approval.id, outcome);
  });
  return out;
}

function callKey(toolName: string, input: unknown): string {
  return `${toolName}\u0000${stableStringify(input)}`;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}
