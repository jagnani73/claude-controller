import type { HookEventName } from "../types/hook.types.js";

/**
 * We only register `PermissionRequest` — a sync (blocking) HTTP hook that
 * lets the phone approve or deny tool calls. `SessionStart` is not HTTP-capable
 * in Claude Code (command-only); we don't need it, because the controller
 * chooses each fresh session's id and passes it as `--session-id`.
 *
 * Assistant text, tool calls, tool results, and user prompts all come from
 * the transcript JSONL tail.
 */
/**
 * Extra handler fields for one hook entry. Only PermissionRequest sets any.
 */
interface HandlerOptions {
  /** Seconds before Claude Code cancels the request (its default for http is 600). */
  timeout?: number;
  /** What a failed hook does to the action (upstream 2.1.295+; default "continue"). */
  onFailure?: "continue" | "block";
}

/**
 * PermissionRequest waits on a human with a phone, so it gets a day instead of
 * the 600s http default. That is past any wait we have reason to expect (an
 * answer 330s in was honoured live on 2.1.322, so there is no shorter cap in
 * the CLI's HTTP client), and still finite.
 */
const PERMISSION_REQUEST_TIMEOUT_S = 24 * 60 * 60;

const HOOK_SYNC: readonly { event: HookEventName; matcher?: string; handler?: HandlerOptions }[] = [
  // Fail closed. Without onFailure, a hook that fails (backend unreachable,
  // non-2xx, timeout, invalid body) is a non-blocking error and the CLI falls
  // back to its own terminal picker, which the phone cannot see: the session
  // hangs. With "block" the docs say a failure "denies the request", and live on
  // 2.1.322 it does, as a visible error tool_result:
  //   backend down -> `[http hook]: failed; blocking because onFailure is "block"`
  //                   `the request failed (ECONNREFUSED)`
  //   timeout      -> `[http hook]: timed out; blocking because onFailure is "block"`
  // A slow but live answer is unaffected (approved at 330s with a 900s timeout).
  // A body that fails validation also counts as a failure, so every response
  // must be the schema form (buildApprovalResponse).
  {
    event: "PermissionRequest",
    handler: { timeout: PERMISSION_REQUEST_TIMEOUT_S, onFailure: "block" },
  },
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
  // The agents view. SubagentStart/Stop drive the live tree (a teammate stops
  // and restarts around every message it handles). Both answer {} immediately.
  { event: "SubagentStart" },
  { event: "SubagentStop" },
  // The agent-to-agent conversation: every SendMessage's input is who it is
  // addressed to and what it says. Pre, not Post, so the feed shows a message
  // as it is sent. A second PreToolUse entry alongside ExitPlanMode's — see
  // buildHooksConfig, which must append rather than overwrite per event.
  { event: "PreToolUse", matcher: "SendMessage" },
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
  const hooks: Record<string, unknown[]> = {};

  // Append per event: several entries may share one event with different
  // matchers (PreToolUse is scoped to both ExitPlanMode and SendMessage), and
  // assigning would silently drop all but the last.
  for (const { event, matcher, handler } of HOOK_SYNC) {
    hooks[event] ??= [];
    hooks[event].push({
      ...(matcher ? { matcher } : {}),
      hooks: [
        {
          type: "http",
          url: `${baseUrl}/hooks/${sessionId}/${event}`,
          async: false,
          ...handler,
        },
      ],
    });
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
