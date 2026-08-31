import type { HookEventName } from "../types/hook.types.js";

/**
 * We only register `PermissionRequest` — a sync (blocking) HTTP hook that
 * lets the phone approve or deny tool calls. `SessionStart` is not HTTP-capable
 * in Claude Code (command-only), so we learn the session id by reading
 * `~/.claude/sessions/<pid>.json` — see `session-locator.service.ts`.
 *
 * Assistant text, tool calls, tool results, and user prompts all come from
 * the transcript JSONL tail.
 */
const HOOK_SYNC: readonly { event: HookEventName; matcher?: string }[] = [
  { event: "PermissionRequest" },
  { event: "PreCompact" },
  { event: "PostCompact" },
  // PreToolUse fires BEFORE the interactive permission picker — the only signal
  // that reaches us before an ExitPlanMode plan picker opens (the tool_use lands
  // in the JSONL only after the picker resolves). Scoped to ExitPlanMode so it
  // doesn't fire for every tool; the handler responds {} (continue) and uses it
  // purely to surface the plan card in time.
  { event: "PreToolUse", matcher: "ExitPlanMode" },
  // Structured signal for an out-of-band `/model`, carrying the requested alias.
  // Post, not Pre: PreModelSwitch exists to block or confirm a switch and we
  // never want to do either. Sessions on a CLI older than 2.1.251 simply never
  // fire it — an unrecognized event name no longer invalidates the settings
  // file (upstream 2.1.101), so registering it is safe on older builds.
  { event: "PostModelSwitch" },
];

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

  for (const { event, matcher } of HOOK_SYNC) {
    hooks[event] = [
      {
        ...(matcher ? { matcher } : {}),
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
