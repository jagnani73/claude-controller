// Verifies the AskUserQuestion keystroke relay still selects the option the
// phone actually picked.
//
// This is the most fragile thing in the project and the failure is silent: the
// relay synthesises navigation into an ink picker, so a picker that gains or
// reorders an option makes the same script commit a *different answer*. Nothing
// errors — the user simply gets a decision they did not make.
//
// The probe drives the real `buildKeystrokes` (from the backend build, never a
// hand-rolled key sequence — a probe with its own copy of the navigation rules
// would verify nothing) and asserts the CLI committed a NON-DEFAULT option.
// Non-default matters: option 1 is where the cursor already sits, so a script
// that does nothing at all would still "pass" on option 1.
//
// Costs plan credits: the picker only exists once Claude calls the tool.

import { join } from "node:path";
import { platform } from "node:process";
import { backendRequire, childEnv, claudeBin, repoRoot, targetVersion, wait } from "./lib/env.mjs";

const pty = backendRequire("node-pty");
const { buildKeystrokes, CHUNK_DELAY_MS } = backendRequire(
  join(repoRoot, "packages", "backend", "dist", "services", "question.input.js"),
);

const ESC = String.fromCharCode(27);
const OSC = new RegExp(
  `${ESC}\\][^${ESC}${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)`,
  "g",
);
const FWD = new RegExp(`${ESC}\\[(\\d+)C`, "g");
const CSI = new RegExp(`${ESC}\\[[0-9;?<>=]*[a-zA-Z]`, "g");
const SHORT = new RegExp(`${ESC}[^[\\]]`, "g");

const plain = (t) =>
  t
    .replace(OSC, "")
    .replace(FWD, (_, n) => " ".repeat(Math.min(Number(n), 200)))
    .replace(CSI, "")
    .replace(SHORT, "");

/**
 * The picker's own footer. Polling for the *option labels* instead would match
 * the echoed prompt long before the picker exists — an earlier version of this
 * probe did exactly that and fired its navigation into the void.
 */
const PICKER_READY = /Enter to select/;

const OPTIONS = ["Red", "Green", "Blue"];
/** Deliberately not the first option — see the header. */
const PICK = "Green";

const PROMPT =
  "Call the AskUserQuestion tool exactly once, with a single question " +
  `"Pick a colour" offering the options ${OPTIONS.join(", ")}. Do nothing else.`;

const BOOT_TIMEOUT_MS = 90_000;
const PICKER_TIMEOUT_MS = 180_000;

function spawnCli() {
  const bin = claudeBin();
  const args = ["--permission-mode", "default", "--model", "sonnet"];
  const opts = {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: repoRoot,
    env: childEnv({ CLAUDE_CODE_EFFORT_LEVEL: "low" }),
  };
  return platform === "win32"
    ? pty.spawn("cmd.exe", ["/c", bin, ...args], opts)
    : pty.spawn("/bin/bash", ["-c", [bin, ...args].join(" ")], opts);
}

/**
 * Which option number the picker is highlighting, from its `❯` cursor.
 *
 * Deliberately reads the *number*, not the label: stripping ANSI collapses the
 * option list onto one line and ink draws each label twice ("1. RedRed"), so
 * label parsing is guesswork. The position is unambiguous.
 */
function cursorIndex(text) {
  const hits = [...plain(text).matchAll(/❯\s*(\d+)\./g)];
  return hits.length ? Number(hits[hits.length - 1][1]) : null;
}

console.log(`binary : ${claudeBin()}`);
console.log(`target : ${targetVersion()}`);
console.log(`picking: ${PICK} (option ${OPTIONS.indexOf(PICK) + 1} of ${OPTIONS.length})`);
console.log("cost   : this probe submits a prompt and spends plan credits\n");

const proc = spawnCli();
let buf = "";
proc.onData((d) => {
  buf += d;
});

const fail = (code, msg) => {
  try {
    proc.write(String.fromCharCode(3));
    proc.kill();
  } catch {
    // already gone
  }
  console.log(`\n================ RESULT ================\n${msg}`);
  process.exit(code);
};

let deadline = Date.now() + BOOT_TIMEOUT_MS;
while (Date.now() < deadline && !/manual mode on/.test(plain(buf))) await wait(500);
if (!/manual mode on/.test(plain(buf))) {
  fail(2, "INCONCLUSIVE: the TUI never rendered, so nothing was driven.");
}
await wait(3000);

process.stdout.write("submitting prompt ... ");
proc.write(`${ESC}[200~${PROMPT}${ESC}[201~`);
await wait(600);
proc.write("\r");

deadline = Date.now() + PICKER_TIMEOUT_MS;
while (Date.now() < deadline && !PICKER_READY.test(plain(buf))) await wait(1000);
if (!PICKER_READY.test(plain(buf))) {
  fail(2, "INCONCLUSIVE: the picker never opened. Claude may not have called the tool.");
}
await wait(1500);
console.log("picker open");

// Control: the cursor must start on option 1. If it does not, ending up on
// Green would not prove the script moved it there.
const before = cursorIndex(buf);
console.log(`cursor starts at option ${before ?? "?"}`);
if (before !== 1) {
  fail(
    2,
    `INCONCLUSIVE: expected the cursor to start on option 1, read ${before ?? "none"}.\n` +
      "Without a known starting position the relay's move cannot be attributed.",
  );
}

// Drive with the real relay script.
const { chunks } = buildKeystrokes({
  questions: [{ multiSelect: false, optionLabels: OPTIONS }],
  answers: [{ selectedLabels: [PICK] }],
});
console.log(`script: ${chunks.length} chunk(s) from buildKeystrokes`);
if (chunks.length === 0) {
  fail(1, `FAIL  buildKeystrokes produced an empty script for "${PICK}".`);
}

const mark = buf.length;
for (let i = 0; i < chunks.length; i++) {
  if (i > 0) await wait(chunks[i - 1].settleMs ?? CHUNK_DELAY_MS);
  proc.write(chunks[i].bytes);
}
await wait(6000);

const after = plain(buf.slice(mark));
try {
  proc.write(String.fromCharCode(3));
  await wait(300);
  proc.write(String.fromCharCode(3));
  await wait(800);
  proc.kill();
} catch {
  // already gone
}

console.log("\n--- render after the script ran ---");
for (const line of after
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .slice(-8)) {
  console.log(`   | ${line.slice(0, 150)}`);
}

console.log("\n================ RESULT ================");

// The CLI echoes the committed answer as `⎿ · <question> → <answer>`. Anchor on
// that arrow rather than scanning for the bare label: the label also appears in
// the picker's own option list, so a redraw would read as a successful commit.
const committed = after.match(/→\s*([A-Za-z]+)/)?.[1] ?? null;

if (/declined to answer/.test(after)) {
  console.log(`FAIL  the relay cancelled the question instead of answering "${PICK}".`);
  process.exit(1);
}
if (committed === null) {
  if (PICKER_READY.test(after)) {
    console.log(`FAIL  the picker was still open after the script ran — nothing was committed.`);
    process.exit(1);
  }
  console.log("INCONCLUSIVE: could not read a committed answer from the render.");
  console.log("The result line format may have changed; re-read the render above.");
  process.exit(2);
}
if (committed !== PICK) {
  console.log(`FAIL  the relay committed "${committed}", not the requested "${PICK}".`);
  console.log("      This is the silent-wrong-answer failure the probe exists to catch:");
  console.log("      the picker's shape changed under a script that still 'succeeds'.");
  process.exit(1);
}
console.log(`PASS  the relay committed "${PICK}", the non-default option it was asked for.`);
process.exit(0);
