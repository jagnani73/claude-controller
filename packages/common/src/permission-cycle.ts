import type { ClaudeModel, PermissionMode } from "./types/index.js";

/**
 * Claude Code's Shift+Tab cycle is dynamic. The base path is
 * `default → acceptEdits → plan → default`. When auto mode is reachable
 * for the session, `plan → auto → default` extends it by one stop.
 *
 * See `claude-code-source/src/utils/permissions/getNextPermissionMode.ts`.
 * Both the frontend (for optimistic UI updates) and the backend (for
 * predicting how many Shift+Tab keystrokes to write into the PTY) need
 * the same model — this is that single source of truth.
 */

/**
 * Whether auto mode participates in the cycle for a given model alias.
 * Mirrors Claude Code's runtime gate (`modelSupportsAutoMode`,
 * `betas.ts:160`), whose external (firstParty, non-ant) allowlist is
 * `/^claude-(opus|sonnet)-4-6/` — the plain Opus and Sonnet families.
 * `opusplan` and `haiku` are deliberately excluded.
 *
 * Two caveats this predicate intentionally does NOT encode:
 *  - The upstream gate is additionally behind the `TRANSCRIPT_CLASSIFIER`
 *    flag + a GrowthBook config, so a `true` here is the model-family
 *    *precondition*, not a guarantee auto is live in a given session.
 *  - We match on the alias family (`opus`/`sonnet`), not the resolved
 *    canonical id — upstream's regex is pinned to `-4-6`, so a future
 *    `-4-7`+ could drift past it while this still returns `true`.
 *
 * Exhaustive `switch` (no `default`) on purpose: adding a `ClaudeModel`
 * alias becomes a compile error here rather than silently falling through to
 * `false`. This is a hand-maintained mirror of a moving upstream gate, and
 * that silent fall-through is exactly the bug we want the compiler to catch.
 */
export function cycleCanIncludeAuto(model: ClaudeModel): boolean {
  switch (model) {
    case "opus":
    case "opus[1m]":
    case "sonnet":
    case "sonnet[1m]":
      return true;
    case "opusplan":
    case "haiku":
      return false;
  }
}

/** The next mode Claude Code transitions to on a single Shift+Tab. */
export function nextPermissionMode(
  current: PermissionMode,
  opts: { autoAvailable: boolean },
): PermissionMode {
  switch (current) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      return opts.autoAvailable ? "auto" : "default";
    case "auto":
      return "default";
  }
}

/**
 * How many Shift+Tabs to fire to walk from `from` to `to`. Cycle wraps,
 * so the result is always non-negative. `from === to` returns 0.
 */
export function cycleDistance(
  from: PermissionMode,
  to: PermissionMode,
  opts: { autoAvailable: boolean },
): number {
  if (from === to) return 0;
  let cur = from;
  for (let steps = 1; steps <= 4; steps++) {
    cur = nextPermissionMode(cur, opts);
    if (cur === to) return steps;
  }
  // Target unreachable from `from` under the current gate (e.g. asking
  // for `auto` on a session where it isn't part of the cycle).
  return 0;
}
