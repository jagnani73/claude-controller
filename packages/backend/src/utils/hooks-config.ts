import type { HookEventName } from "../types/hook.types.js";

/**
 * We only register `PermissionRequest` — a sync (blocking) HTTP hook that
 * lets the phone approve or deny tool calls. `SessionStart` is not HTTP-capable
 * in Claude Code (command-only), so we learn the transcript path by watching
 * the project dir instead — see `transcript-locator.service.ts`.
 *
 * Assistant text, tool calls, tool results, and user prompts all come from
 * the transcript JSONL tail.
 */
const HOOK_SYNC: readonly HookEventName[] = ["PermissionRequest", "PreCompact", "PostCompact"];

/**
 * Build the `--settings '{...}'` JSON payload for a spawned Claude Code session.
 * Session id is embedded in the hook URL path so the HTTP listener can route
 * by session without consulting any map.
 */
interface SettingsOptions {
  statusLine?: {
    dumpScriptPath: string;
    payloadFilePath: string;
  };
}

export function buildHooksConfig(
  baseUrl: string,
  sessionId: string,
  opts: SettingsOptions = {},
): string {
  const hooks: Record<string, unknown> = {};

  for (const event of HOOK_SYNC) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "http",
            url: `${baseUrl}/hooks/${sessionId}/${event}`,
            async: false,
          },
        ],
      },
    ];
  }

  const settings: Record<string, unknown> = { hooks };
  if (opts.statusLine) {
    settings.statusLine = {
      type: "command",
      command: `node "${opts.statusLine.dumpScriptPath}" "${opts.statusLine.payloadFilePath}"`,
    };
  }
  return JSON.stringify(settings);
}
