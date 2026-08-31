// Verifies Claude Code's Shift+Tab permission-mode cycle still matches the model
// in `common/permission-cycle.ts` — the one the backend uses to decide how many
// `ESC [ Z` keystrokes to write when the phone picks a mode.
//
// Why this one is worth a probe: `cycleCanIncludeAuto()` is a hand-maintained
// mirror of an upstream gate, and a wrong answer is silent. If auto is really in
// the cycle and we think it is not (or the reverse), `cycleDistance()` writes the
// wrong number of keystrokes and the session lands in a *different* permission
// mode than the phone asked for, with no error anywhere.
//
// Unlike the other probes this one costs no plan credits: it never submits a
// prompt. It spawns the TUI, presses Shift+Tab, and reads the mode indicator the
// CLI renders in its own footer.
//
// Reading the footer is regex-over-PTY, which the *product* forbids. That rule
// exists so the relay never depends on a rendered surface; a probe whose entire
// job is to check a rendered surface against our model is the exception, and it
// is why this lives here and not in `packages/`.

import { join } from "node:path";
import { platform } from "node:process";
import { backendRequire, childEnv, claudeBin, repoRoot, targetVersion, wait } from "./lib/env.mjs";

const pty = backendRequire("node-pty");

const ESC = String.fromCharCode(27);
const SHIFT_TAB = `${ESC}[Z`;
const CTRL_C = String.fromCharCode(3);

/** Cursor-forward, which Ink emits *instead of* spaces when repainting a line. */
const CURSOR_FORWARD = new RegExp(`${ESC}\\[(\\d+)C`, "g");
/** OSC (window title), terminated by BEL or ST. */
const OSC = new RegExp(
  `${ESC}\\][^${ESC}${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)`,
  "g",
);
const CSI = new RegExp(`${ESC}\\[[0-9;?<>=]*[a-zA-Z]`, "g");
const SHORT_ESC = new RegExp(`${ESC}[^[\\]]`, "g");

/**
 * Footer labels the CLI renders for each mode, as observed live. These are the
 * TUI's own words, not our `PermissionMode` names — `default` renders as
 * "manual mode on", which is the pairing most likely to rot.
 */
const FOOTER_LABELS = [
  [/manual mode on/, "default"],
  [/accept edits on/, "acceptEdits"],
  [/plan mode on/, "plan"],
  [/auto mode on/, "auto"],
  [/bypass permissions on/, "bypassPermissions"],
];

/**
 * The predicate under test and the alias list, both read from the built package
 * rather than restated here. Restating either would let this probe pass while
 * the thing it guards drifts — and `CLAUDE_MODELS` keeps the walk exhaustive, so
 * a newly added alias is probed without editing this file. `opusplan` is why
 * that matters: it was the one wrong answer, and a representative subset would
 * have missed it.
 */
const { cycleCanIncludeAuto, nextPermissionMode } = backendRequire(
  join(repoRoot, "packages", "common", "dist", "permission-cycle.js"),
);
const { CLAUDE_MODELS } = backendRequire(
  join(repoRoot, "packages", "common", "dist", "types", "index.js"),
);

const PRESSES = 5;
const SETTLE_MS = 1500;
const BOOT_TIMEOUT_MS = 90_000;

/**
 * Strip ANSI so the label survives Ink's partial repaints. Cursor-forward
 * becomes spaces rather than nothing: Ink emits it in place of runs of spaces,
 * so dropping it welds words together and the label stops matching.
 */
function plain(text) {
  return text
    .replace(OSC, "")
    .replace(CURSOR_FORWARD, (_, n) => " ".repeat(Math.min(Number(n), 200)))
    .replace(CSI, "")
    .replace(SHORT_ESC, "");
}

/**
 * The mode the footer last claimed in this slice of output. Last match, not
 * first: a repaint can draw the footer twice in one frame (once in place, once
 * after the layout shifts), and only the final one is current.
 */
function decodeMode(chunk) {
  const text = plain(chunk);
  let best = null;
  for (const [pattern, mode] of FOOTER_LABELS) {
    const hit = text.match(pattern);
    if (!hit) continue;
    const idx = text.lastIndexOf(hit[0]);
    if (best === null || idx > best.idx) best = { idx, mode };
  }
  return best?.mode ?? null;
}

function spawnCli(model) {
  const bin = claudeBin();
  const args = ["--permission-mode", "default", "--model", model];
  const opts = { name: "xterm-256color", cols: 120, rows: 40, cwd: repoRoot, env: childEnv() };
  return platform === "win32"
    ? pty.spawn("cmd.exe", ["/c", bin, ...args], opts)
    : pty.spawn("/bin/bash", ["-c", [bin, ...args].join(" ")], opts);
}

/** Walk one model's cycle from `default`, returning the decoded mode at each stop. */
async function walkCycle(model) {
  const proc = spawnCli(model);
  let buf = "";
  proc.onData((d) => {
    buf += d;
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline && decodeMode(buf) === null) await wait(500);
  // The footer renders before the session is reading keys; settle before typing.
  await wait(3000);

  const start = decodeMode(buf);
  const observed = [];
  for (let i = 0; i < PRESSES; i++) {
    const mark = buf.length;
    proc.write(SHIFT_TAB);
    await wait(SETTLE_MS);
    observed.push(decodeMode(buf.slice(mark)));
  }

  // Two Ctrl-Cs: the first arms "press again to exit", the second takes it.
  proc.write(CTRL_C);
  await wait(300);
  proc.write(CTRL_C);
  await wait(500);
  try {
    proc.kill();
  } catch {
    // Already gone — the second Ctrl-C exited it.
  }
  return { start, observed };
}

/** What `common/permission-cycle.ts` says the same walk should produce. */
function predict(model) {
  const autoAvailable = cycleCanIncludeAuto(model);
  const out = [];
  let cur = "default";
  for (let i = 0; i < PRESSES; i++) {
    cur = nextPermissionMode(cur, { autoAvailable });
    out.push(cur);
  }
  return out;
}

console.log(`binary : ${claudeBin()}`);
console.log(`target : ${targetVersion()}`);
console.log("cost   : none — this probe never submits a prompt\n");

const pad = Math.max(...CLAUDE_MODELS.map((m) => m.length));
const rows = [];
for (const model of CLAUDE_MODELS) {
  process.stdout.write(`walking: ${model.padEnd(pad)} `);
  try {
    const result = await walkCycle(model);
    console.log(`${result.start ?? "?"} -> ${result.observed.map((m) => m ?? "?").join(" -> ")}`);
    rows.push({ model, ...result, expected: predict(model) });
  } catch (err) {
    console.log(`ERROR ${err.message}`);
    rows.push({ model, error: err.message });
  }
}

console.log("\n================ RESULT ================");

// Control: the probe must prove it can read a mode at all, and that Shift+Tab is
// landing. Without both, "auto never appeared" is indistinguishable from "the TUI
// never rendered" — the exact ambiguity this harness exists to refuse.
const readable = rows.filter((r) => r.start === "default");
const responsive = readable.filter((r) => r.observed.some((m) => m && m !== "default"));
if (responsive.length === 0) {
  console.log("INCONCLUSIVE: no model both started in `default` and responded to Shift+Tab.");
  console.log("Nothing below is a finding — the probe could not drive the TUI.");
  for (const r of rows) {
    console.log(`  ${r.model.padEnd(9)} start=${r.start ?? "?"} err=${r.error ?? "-"}`);
  }
  process.exit(2);
}

let failed = 0;
let skipped = 0;
for (const r of rows) {
  if (r.error || r.start !== "default" || r.observed.includes(null)) {
    skipped++;
    const why =
      r.error ?? `start=${r.start ?? "?"} stops=${r.observed.map((m) => m ?? "?").join(",")}`;
    console.log(`SKIP  ${r.model.padEnd(pad)} could not walk the cycle (${why})`);
    continue;
  }
  const ok = r.observed.join(">") === r.expected.join(">");
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${r.model.padEnd(pad)} default -> ${r.observed.join(" -> ")}`,
  );
  if (!ok) {
    console.log(`      expected default -> ${r.expected.join(" -> ")}`);
    console.log(
      `      cycleCanIncludeAuto("${r.model}") says ${cycleCanIncludeAuto(r.model)}; the CLI ` +
        `${r.observed.includes("auto") ? "does" : "does not"} include auto`,
    );
  }
}

if (skipped) console.log(`\n${skipped} model(s) skipped — those rows prove nothing either way.`);
if (failed) {
  console.log(
    `\n${failed} model(s) cycle differently than common/permission-cycle.ts predicts.\n` +
      `cycleDistance() is therefore writing the wrong number of Shift+Tabs for them,\n` +
      `landing the session in a different permission mode than the phone asked for.`,
  );
}
process.exit(failed ? 1 : 0);
