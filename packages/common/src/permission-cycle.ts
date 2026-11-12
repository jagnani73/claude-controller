import type { ClaudeModel, KnownClaudeModel, PermissionMode } from "./types/index.js";
import { isKnownClaudeModel } from "./types/index.js";

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
 *
 * Every answer here is **observed**, not derived: `pnpm verify:permission-cycle`
 * walks the real cycle for each `KnownClaudeModel` by pressing Shift+Tab in a live
 * TUI and reading the mode the CLI renders. Haiku is the only alias whose cycle
 * omits auto; `opusplan` includes it, because it resolves to Opus in plan mode
 * and Sonnet outside it and both of those are auto-capable, so the alias never
 * lands on a model that would drop the stop.
 *
 * Do not re-derive this from `claude-code-source/`. That snapshot's gate
 * (`modelSupportsAutoMode`, `betas.ts:160`) allowlists `/^claude-(opus|sonnet)-4-6/`,
 * which would exclude the Opus 5 / Sonnet 5 models actually in use — and the
 * live cycle includes auto for both. The snapshot is a frozen hint, and here it
 * is simply wrong about current behaviour.
 *
 * One caveat this predicate cannot encode: the snapshot also gates auto behind
 * a feature flag and remote config, so the cycle could in principle differ by
 * account or rollout. The probe can only observe the machine it runs on.
 *
 * Exhaustive `switch` (no `default`) on purpose: adding a `KnownClaudeModel`
 * alias becomes a compile error here rather than silently falling through to
 * `false`. This is a hand-maintained mirror of a moving upstream gate, and
 * that silent fall-through is exactly the bug we want the compiler to catch.
 *
 * Every other model (an alias learned at runtime, a full model id) is
 * **unverified**: see {@link autoCycleSupport}, which callers holding an
 * arbitrary `ClaudeModel` must use instead.
 */
export function cycleCanIncludeAuto(model: KnownClaudeModel): boolean {
  switch (model) {
    case "opus":
    case "opus[1m]":
    case "opusplan":
    case "sonnet":
    case "sonnet[1m]":
      return true;
    case "haiku":
      return false;
  }
}

/**
 * Tri-state auto-cycle capability for any model: `true`/`false` for a verified
 * alias (from {@link cycleCanIncludeAuto}), `null` when it is **unknown**.
 *
 * Unknown means do not predict. A guessed answer is a guessed keystroke count,
 * and a wrong count makes the next prompt run under a mode the user did not
 * pick, so callers refuse Shift+Tab mode changes for an unknown model rather than
 * walk the cycle (spawn-time `--permission-mode` is unaffected: it needs no
 * prediction). Full model ids are unknown even for a verified family, since an
 * older version of it may gate auto differently.
 *
 * Adding a model: add its alias to `KnownClaudeModel` and `CLAUDE_MODELS` (the
 * probe walks that list), run `pnpm verify:permission-cycle`, and record the
 * answer it observed in the switch in `cycleCanIncludeAuto`. Only then is the
 * model verified; until the probe agrees, it must not be listed.
 */
export function autoCycleSupport(model: ClaudeModel): boolean | null {
  return isKnownClaudeModel(model) ? cycleCanIncludeAuto(model) : null;
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
