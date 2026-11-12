// Verifies the ExitPlanMode plan-picker relay end to end, including the fast-tap
// race it used to lose.
//
// The PlanCard is drawn from the PreToolUse hook, ~2.4s before the CLI renders its
// picker. A phone that answered inside that window used to have its digit written
// into the void (on 2.1.322 it actually landed in the main prompt box): the
// response was reported as unconfirmed and the picker stayed open with nothing on
// the phone able to answer it. `Session.answerPlan` now waits for the picker-open
// signal (ExitPlanMode's notification-only PermissionRequest) before writing. This
// probe answers FAST - well inside that window - which is exactly the case that
// used to fail, and asserts:
//
//   - the ExitPlanMode tool_result is not an error (the picker took the answer)
//   - the permission mode becomes `default` (approve-manual = picker option 2)
//
// Control: INCONCLUSIVE if no ExitPlanMode card ever arrives (the model did not
// plan, or the PreToolUse hook no longer fires).
//
// Requires a running backend (`pnpm dev:backend`): the gate under test lives in
// the controller. Costs a few credits (a Sonnet session at low effort).
//
// Not covered: the high-context "clear context" variant of the picker, which
// shifts every option down one. It cannot be reproduced on demand (see README).

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createSession, send, waitForReady } from "./lib/controller.mjs";
import { sessionCwd, targetVersion } from "./lib/env.mjs";

/** How soon after the card the probe answers. The picker opens ~2.4s after it. */
const ANSWER_AFTER_MS = 500;
const CARD_TIMEOUT_MS = 240000;
const RESULT_TIMEOUT_MS = 40000;
const MODE_TIMEOUT_MS = 15000;

const target = join(tmpdir(), "verify-plan-relay.txt");
const PROMPT =
  `Make a two-step plan to create the file ${target} containing the word hi. ` +
  "Keep the plan very short, then call ExitPlanMode. Do nothing else.";

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;

let ws;
let sessionId = null;

async function report(code, verdict, detail) {
  if (ws && sessionId) {
    try {
      send(ws, { type: "stop_session", sessionId });
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // socket already gone
    }
  }
  try {
    rmSync(target, { force: true });
  } catch {
    // best effort; it is under the OS temp dir
  }
  console.log("\n================ RESULT ================");
  console.log(verdict);
  if (detail) console.log(detail);
  process.exit(code);
}

console.log(`target : ${targetVersion()}`);
console.log("cost   : this probe submits a prompt and spends plan credits\n");

try {
  ws = await connect();
} catch (err) {
  await report(2, `INCONCLUSIVE - ${err.message}`);
}

const session = await createSession(ws, {
  cwd: sessionCwd,
  model: "sonnet",
  permissionMode: "plan",
  effort: "low",
}).catch((err) => report(2, `INCONCLUSIVE - ${err.message}`));
sessionId = session.id;
console.log(`session: ${session.id}`);
const ready = await waitForReady(ws, session.id);
console.log(`CLI is up (${ready}) - asking for a plan\n`);

let card = null; // { toolUseId, at, planless }
let result = null; // { isError, result }
let mode = session.permissionMode;
let modeDefaultAt = null;

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === "session_metadata" && msg.session?.id === session.id) {
    if (msg.session.permissionMode !== mode) {
      mode = msg.session.permissionMode;
      console.log(`${ts()} permission mode -> ${mode}`);
      if (mode === "default" && card && modeDefaultAt === null) modeDefaultAt = Date.now();
    }
    return;
  }
  if (msg.sessionId !== session.id) return;

  if (msg.type === "tool_call" && msg.name === "ExitPlanMode" && !card) {
    const plan = msg.input && typeof msg.input === "object" ? msg.input.plan : undefined;
    card = {
      toolUseId: msg.toolUseId,
      at: Date.now(),
      planless: !(typeof plan === "string" && plan.trim()),
    };
    console.log(
      `${ts()} ExitPlanMode card (${card.planless ? "NO plan text" : "with plan"}) - answering in ${ANSWER_AFTER_MS}ms`,
    );
    setTimeout(() => {
      send(ws, {
        type: "plan_response",
        sessionId: session.id,
        toolUseId: card.toolUseId,
        decision: "approve-manual",
      });
      console.log(`${ts()} sent plan_response approve-manual`);
    }, ANSWER_AFTER_MS);
  } else if (msg.type === "tool_result" && card && msg.toolUseId === card.toolUseId && !result) {
    result = { isError: msg.isError, result: msg.result };
    const text = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
    console.log(
      `${ts()} ExitPlanMode tool_result isError=${msg.isError} ${JSON.stringify(text.slice(0, 120))}`,
    );
  } else if (msg.type === "approval_request") {
    // Whatever runs after the plan is not the subject; let it through.
    send(ws, {
      type: "approval_response",
      sessionId: session.id,
      toolUseId: msg.toolUseId,
      decision: "allow",
    });
    console.log(`${ts()} approved ${msg.toolName}`);
  }
});

send(ws, { type: "input", sessionId: session.id, text: PROMPT });

const until = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await new Promise((r) => setTimeout(r, 250));
  return pred();
};

if (!(await until(() => card !== null, CARD_TIMEOUT_MS))) {
  await report(
    2,
    "INCONCLUSIVE - no ExitPlanMode card arrived, so the relay was never exercised.",
    "The model may not have called ExitPlanMode, or the PreToolUse(ExitPlanMode) hook no\n" +
      "longer fires. Re-run once; if it repeats, check hooks-config.ts.",
  );
}
if (!(await until(() => result !== null, RESULT_TIMEOUT_MS))) {
  await report(
    1,
    "FAIL - the plan response produced no tool_result at all.",
    "Neither the CLI nor the controller's own failure path answered. Check the newest\n" +
      "dump/captures/*.raw: the picker is probably still open.",
  );
}
if (result.isError) {
  await report(
    1,
    "FAIL - the ExitPlanMode tool_result is an error.",
    `result: ${JSON.stringify(result.result)}\n` +
      'If it is the controller\'s "could not be confirmed" / "never opened" message, the\n' +
      "keystroke did not reach the picker - the fast-tap race this probe exists for.",
  );
}
await until(() => mode === "default", MODE_TIMEOUT_MS);
if (mode !== "default") {
  await report(
    1,
    `FAIL - the plan was accepted but the session reports mode "${mode}", not "default".`,
    card.planless
      ? "The call had no plan text, so `1` was sent (the planless rule); on the full\n" +
          "picker that exits to auto/acceptEdits. Re-run: the model skipped writing a plan."
      : 'Option 2 no longer means "manually approve edits", or the mode note is not applied.',
  );
}
await new Promise((r) => setTimeout(r, 3000)); // let the approved plan start, then stop
await report(
  0,
  `PASS - a fast tap (${ANSWER_AFTER_MS}ms after the card) was delivered: non-error tool_result, ` +
    `mode -> default${existsSync(target) ? " (and the plan ran)" : ""}.`,
);
