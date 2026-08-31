// Verifies that approving with `updatedInput` actually changes what the tool runs.
//
// This guards the subtlest contract in the project. Claude Code accepts TWO
// different PermissionRequest response shapes and they are not interchangeable:
//
//   flat   { permissionDecision: "allow" }                       -> plain allow works
//   schema { hookEventName, decision: { behavior, updatedInput } } -> carries an edit
//
// Putting `updatedInput` on the flat form does not merely drop the edit — the CLI
// discards the whole response, loses the allow, and falls through to its own
// terminal picker, which the phone cannot see. The session then hangs with no
// error anywhere. That failure is invisible to logs and to typechecking, so it
// is exactly the kind of thing that regresses silently on a CLI update.
//
// Requires a running backend (`pnpm dev:backend`) because PermissionRequest does
// not fire under headless `claude -p` — there is nobody to prompt.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createSession, send, waitForReady } from "./lib/controller.mjs";
import { repoRoot, targetVersion } from "./lib/env.mjs";

const dir = mkdtempSync(join(tmpdir(), "verify-approval-"));
const target = join(dir, "APPROVAL_PROBE.md");

function cleanup() {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Claude Code may still hold the directory; it is under the OS temp dir.
  }
}

function report(code, verdict, detail) {
  console.log("\n================ RESULT ================");
  console.log(verdict);
  if (detail) console.log(detail);
  cleanup();
  process.exit(code);
}

console.log(`target : ${targetVersion()}`);
console.log(`probe  : ${target}\n`);

let ws;
try {
  ws = await connect();
} catch (err) {
  report(2, `INCONCLUSIVE - ${err.message}`);
}

// The session runs in the repo (a cwd known to start reliably) while the write
// target stays outside it, so a run never touches tracked files.
const session = await createSession(ws, {
  cwd: repoRoot,
  model: "sonnet",
  permissionMode: "default",
  effort: "high",
}).catch((err) => report(2, `INCONCLUSIVE - ${err.message}`));

console.log(`session: ${session.id}`);
await waitForReady(ws, session.id).catch((err) => report(2, `INCONCLUSIVE - ${err.message}`));
console.log("CLI is up — requesting a write\n");

let sawApproval = false;
let sawResult = false;

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.sessionId && msg.sessionId !== session.id) return;

  if (msg.type === "approval_request") {
    if (msg.toolName !== "Write") {
      // Let anything else through unchanged so the run can reach the Write.
      send(ws, {
        type: "approval_response",
        sessionId: session.id,
        toolUseId: msg.toolUseId,
        decision: "allow",
      });
      return;
    }
    sawApproval = true;
    console.log(`approval_request: Write`);
    console.log(`  proposed: ${JSON.stringify(msg.toolInput)}`);
    send(ws, {
      type: "approval_response",
      sessionId: session.id,
      toolUseId: msg.toolUseId,
      decision: "allow",
      updatedInput: { ...msg.toolInput, content: "EDITED\n" },
    });
    console.log(`  approved with content rewritten to "EDITED"`);
  }

  if (msg.type === "tool_result" && sawApproval && !sawResult) {
    sawResult = true;
    setTimeout(finish, 3000);
  }
});

send(ws, {
  type: "input",
  sessionId: session.id,
  text: `Use the Write tool to create the file ${target} containing exactly ORIGINAL. Then say DONE. Do nothing else.`,
});

function finish() {
  const exists = existsSync(target);
  const content = exists ? readFileSync(target, "utf8").trim() : null;
  if (!sawApproval) {
    report(2, "INCONCLUSIVE - no PermissionRequest arrived, so nothing is proven.");
  }
  if (!exists) {
    report(
      1,
      "FAIL - the file was never written.",
      "The edited approval was not honoured as an allow. The CLI most likely fell\n" +
        "back to its own terminal picker — check the newest dump/captures/*.raw for\n" +
        'a "Do you want to create ..." prompt.',
    );
  }
  if (content !== "EDITED") {
    report(
      1,
      `FAIL - the file contains ${JSON.stringify(content)}, expected "EDITED".`,
      "The call was allowed but updatedInput was ignored, so the tool ran Claude's\n" +
        "original input. Approving an edited call silently does the wrong thing.",
    );
  }
  report(0, 'PASS - updatedInput was applied; the tool ran the edited call ("EDITED").');
}

setTimeout(() => {
  // An approval that went out and produced nothing is the failure itself, not an
  // untestable run: it is the hung-session symptom of a rejected response. Only
  // never seeing an approval is genuinely inconclusive.
  if (sawApproval) {
    report(
      1,
      "FAIL - the edited approval was sent but the tool never ran.",
      "This is the hung-session failure: the CLI did not accept the response and\n" +
        "fell back to its own terminal picker, which nothing can answer. Check the\n" +
        'newest dump/captures/*.raw for a "Do you want to ..." prompt.',
    );
  }
  report(
    2,
    "INCONCLUSIVE - no approval was ever requested.",
    "The model may not have called Write, so the contract was never exercised.",
  );
}, 240000);
