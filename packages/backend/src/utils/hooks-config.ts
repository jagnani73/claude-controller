import type { HookEventName } from "../types/hook.types.js";

/**
 * We only register the two hooks we consume:
 * - `SessionStart` (async) — delivers the transcript_path we tail for content.
 * - `PermissionRequest` (sync) — Claude blocks on our response for approval gating.
 *
 * Content (user prompts, assistant text, tool calls, tool results) comes from
 * the transcript JSONL. No need to register UserPromptSubmit / PostToolUse / Stop.
 */
const HOOK_SYNC: readonly HookEventName[] = ["PermissionRequest"];
const HOOK_ASYNC: readonly HookEventName[] = ["SessionStart"];

/**
 * Build the `--settings '{...}'` JSON payload for a spawned Claude Code session.
 * Session id is embedded in the hook URL path so the HTTP listener can route
 * by session without consulting any map.
 */
export function buildHooksConfig(baseUrl: string, sessionId: string): string {
  const hooks: Record<string, unknown> = {};

  const mkHook = (event: HookEventName, async: boolean) => ({
    hooks: [
      {
        type: "http",
        url: `${baseUrl}/hooks/${sessionId}/${event}`,
        async,
      },
    ],
  });

  for (const event of HOOK_SYNC) hooks[event] = [mkHook(event, false)];
  for (const event of HOOK_ASYNC) hooks[event] = [mkHook(event, true)];

  return JSON.stringify({ hooks });
}
