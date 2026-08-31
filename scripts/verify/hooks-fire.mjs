// Verifies the hook events the controller depends on still fire on this CLI
// build, and that safe mode still suppresses them.
//
// Runs headless (`claude -p`), so no picker is involved. Every assertion is
// anchored on a control: a run where the hook is expected to fire. Without one,
// "0 hooks fired" reads identically whether the event was removed upstream or
// the probe itself is broken — which is exactly the mistake this harness exists
// to avoid repeating.

import { spawn } from "node:child_process";
import { childEnv, claudeBin, targetVersion, wait } from "./lib/env.mjs";
import { startHookProbe } from "./lib/hooks.mjs";

const PROMPT =
  "Use the Glob tool once to list *.json in the current directory, then reply with just the word DONE. Do nothing else.";

const bin = claudeBin();
console.log(`binary : ${bin}`);
console.log(`target : ${targetVersion()}`);

const probe = await startHookProbe(["PreToolUse"], { name: "hooks-fire" });
console.log(`listener: ${probe.base}\n`);

function run({ args = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-p", PROMPT, "--settings", probe.settingsPath, ...args], {
      cwd: process.cwd(),
      env: childEnv(env),
      // No shell: on Windows `shell: true` concatenates argv unescaped, which
      // silently truncates the prompt at its first space. stdin ignored so -p
      // does not block waiting for it.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: e.message });
    });
  });
}

const cases = [
  ["control (no safe mode)", {}, "fires"],
  ["--safe-mode flag", { args: ["--safe-mode"] }, "suppressed"],
  ["CLAUDE_CODE_SAFE_MODE=1", { env: { CLAUDE_CODE_SAFE_MODE: "1" } }, "suppressed"],
];

const results = [];
for (const [label, opts, expectation] of cases) {
  const before = probe.captured.length;
  process.stdout.write(`running: ${label} ... `);
  const r = await run(opts);
  await wait(500);
  const fired = probe.captured.length - before;
  results.push({ label, fired, expectation, code: r.code, err: r.err });
  console.log(`hooks=${fired} exit=${r.code}`);
  if (r.err) console.log(`  stderr: ${r.err.slice(0, 200)}`);
}
probe.stop();

console.log("\n================ RESULT ================");
let failed = 0;
const control = results[0];
if (control.fired === 0) {
  console.log("INCONCLUSIVE: the control fired no hooks, so nothing here is a finding.");
  console.log("Fix the probe before reading the other rows.");
  process.exit(2);
}
for (const r of results) {
  const ok = r.expectation === "fires" ? r.fired > 0 : r.fired === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${r.label.padEnd(26)} hooks=${r.fired} (expected ${r.expectation})`,
  );
}
if (failed) {
  console.log(
    `\n${failed} expectation(s) broke — the CLI changed behaviour the controller relies on.`,
  );
}
process.exit(failed ? 1 : 0);
