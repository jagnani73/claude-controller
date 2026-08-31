// Verifies the PostModelSwitch payload still carries the fields the controller
// reads, by driving a real `/model` switch through a PTY.
//
// `requested_model` is the one that matters: Session.handleModelSwitch applies
// it as the stored alias. If it disappears or is renamed upstream, model
// reconciliation silently degrades to family-matching with no error anywhere.

import { backendRequire, childEnv, claudeBin, targetVersion, wait } from "./lib/env.mjs";
import { startHookProbe, stripAnsi } from "./lib/hooks.mjs";

const pty = backendRequire("node-pty");

const bin = claudeBin();
console.log(`binary : ${bin}`);
console.log(`target : ${targetVersion()}`);

// PreToolUse is the control: it proves hook delivery works in this run, so an
// absent PostModelSwitch means the event changed rather than the probe failing.
const probe = await startHookProbe(["PostModelSwitch", "PreToolUse"], { name: "model-switch" });
console.log(`listener: ${probe.base}\n`);

const term = pty.spawn(
  process.platform === "win32" ? "cmd.exe" : "/bin/bash",
  process.platform === "win32"
    ? [
        "/c",
        bin,
        "--permission-mode",
        "default",
        "--model",
        "sonnet",
        "--settings",
        probe.settingsPath,
      ]
    : [
        "-c",
        `'${bin}' --permission-mode default --model sonnet --settings '${probe.settingsPath}'`,
      ],
  { name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env: childEnv() },
);

let out = "";
term.onData((d) => {
  out += d;
});

console.log("booting (25s)...");
await wait(25000);

console.log("sending: /model opus");
term.write("/model opus");
await wait(1200);
term.write("\r");
await wait(15000);

console.log("sending: tool-triggering prompt (control)");
term.write("\x1b[200~Use the Glob tool once to list *.json here, then say DONE.\x1b[201~");
await wait(1200);
term.write("\r");
await wait(35000);

term.kill();
probe.stop();

const switches = probe.captured.filter((c) => c.event === "PostModelSwitch");
const controlFired = probe.countOf("PreToolUse") > 0;

console.log("\n================ RESULT ================");
console.log(`PostModelSwitch calls : ${switches.length}`);
console.log(`control (PreToolUse)  : ${controlFired ? "fired" : "NEVER FIRED"}`);

if (!controlFired) {
  console.log("\nINCONCLUSIVE: hook delivery never worked in this run, so the absence of");
  console.log("PostModelSwitch proves nothing. Fix the probe first.");
  console.log(`\n--- PTY tail ---\n${stripAnsi(out).slice(-1200)}`);
  process.exit(2);
}

if (switches.length === 0) {
  console.log("\nFAIL: PostModelSwitch did not fire on an explicit /model switch.");
  console.log("Session.handleModelSwitch is now dead code; model reconciliation");
  console.log("has silently fallen back to transcript family-matching.");
  process.exit(1);
}

const payload = switches[0].payload;
console.log(`\npayload:\n${JSON.stringify(payload, null, 2)}`);

const required = ["hook_event_name", "from_model", "to_model", "requested_model"];
const missing = required.filter((k) => !(k in payload));
console.log("");
for (const key of required) {
  console.log(`${key in payload ? "PASS" : "FAIL"}  ${key}`);
}
if (missing.length) {
  console.log(`\nFAIL: missing ${missing.join(", ")} — update ModelSwitchPayload and the handler.`);
  process.exit(1);
}
if (payload.requested_model !== "opus") {
  console.log(
    `\nFAIL: requested_model was ${JSON.stringify(payload.requested_model)}, expected "opus".`,
  );
  console.log("The alias is no longer passed through verbatim.");
  process.exit(1);
}
console.log("\nPASS: PostModelSwitch delivers the alias the controller relies on.");
process.exit(0);
