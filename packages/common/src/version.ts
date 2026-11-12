/**
 * The Claude Code CLI build the relays were last verified against. This is the
 * **fallback** drift reference, not the live one.
 *
 * The live reference is the version of the binary the backend will spawn,
 * resolved once at startup by running `<claudeBin> --version` (see
 * `cli-version.service.ts` in the backend) and handed to each session. This
 * constant is used only when that probe fails (binary missing, timeout,
 * unparseable output), and by `scripts/verify/`, which reads it from the built
 * package and is deliberately not dynamic.
 *
 * We are a PTY relay driving a CLI we neither ship nor pin, and the fragile
 * parts — the AskUserQuestion and ExitPlanMode keystroke scripts, the JSONL
 * entry shapes, the hook payload contracts — were all reverse-engineered
 * against one specific build. When that build moves underneath us the failure
 * is silent, not loud: a picker gains an option and a digit keystroke selects
 * the wrong one; a JSONL field is renamed and the watcher just goes quiet.
 *
 * Bump this only after re-verifying the relays against the newer build.
 */
export const CLAUDE_CODE_TARGET_VERSION = "2.1.322";

/**
 * Version of the gitignored `claude-code-source/` reference snapshot.
 *
 * Frozen, and not updatable: that tree exists only because a one-time
 * source-map exposure briefly made the unbundled TypeScript downloadable (see
 * its README). There is no newer unbundled source to re-vendor, and the shipped
 * CLI is a compiled Bun binary whose embedded strings are compressed and so not
 * greppable. Treat the snapshot as a *hint* about intent, never as ground truth
 * for current behavior — that has to come from live PTY captures against the
 * build actually running.
 */
export const CLAUDE_CODE_REFERENCE_SNAPSHOT_VERSION = "2.1.87";

/**
 * Oldest CLI build the AskUserQuestion keystroke relay is correct against.
 *
 * Three upstream fixes are load-bearing for `question.input.ts`, and below this
 * version the relay silently produces the *wrong answer* rather than failing —
 * which is why this is a hard floor and not just drift:
 *
 *  - **v2.1.144** made Esc in the preview-notes field return to option
 *    selection instead of aborting the turn. `buildQuestionKeystrokes` exits
 *    notes with Esc, so on an older build a note-carrying answer kills the turn.
 *  - **v2.1.181** stopped multi-select questions dropping a typed "Other"
 *    free-text answer, which the multi-select `customText` path depends on.
 *  - **v2.1.235**: "arrow keys and Enter pressed in quick succession now select
 *    the option you navigated to instead of the previously highlighted one".
 *    That is exactly what the relay emits — `buildKeystrokes` pairs `\x1b[B`
 *    with `\r` only `CHUNK_DELAY_MS` (35ms) apart — so below it *every* answer
 *    needing navigation commits the previously highlighted option instead. It
 *    is the most systematic of the three: not an edge case in notes or
 *    free-text, but any non-default pick.
 *
 * Never lower this without re-verifying each path against live PTY captures.
 * `pnpm verify:question-relay` covers the 2.1.235 case directly: it drives the
 * real script at a non-default option and asserts what the CLI committed.
 */
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.235";

/** How a session's CLI version relates to the drift reference (see {@link classifyCliVersion}). */
export type CliVersionStatus = "match" | "older" | "newer";

/** Split a dotted version into numeric segments; unparseable segments read as 0. */
function segments(version: string): number[] {
  return version.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Numeric dotted-version compare. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Classify a session's CLI version against a reference version.
 *
 * The backend passes the installed binary's version as `target`, so a non-match
 * means the session is running a different build than the one installed now
 * (e.g. it was resumed across an upgrade). Without an argument it compares
 * against the static fallback, {@link CLAUDE_CODE_TARGET_VERSION}.
 */
export function classifyCliVersion(
  observed: string,
  target: string = CLAUDE_CODE_TARGET_VERSION,
): CliVersionStatus {
  const diff = compareVersions(observed, target);
  if (diff === 0) return "match";
  return diff < 0 ? "older" : "newer";
}

/**
 * True when the observed build predates a fix the keystroke relays require.
 * Distinct from a plain version mismatch: this one means answers can be
 * silently wrong. See {@link CLAUDE_CODE_MINIMUM_VERSION}.
 */
export function isBelowMinimumVersion(observed: string): boolean {
  return compareVersions(observed, CLAUDE_CODE_MINIMUM_VERSION) < 0;
}
