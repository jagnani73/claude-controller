// Verifies the agents view's data path end to end against a real CLI session:
//
//   SubagentStart/Stop hooks  -> agent_update   (the live tree and its status)
//   agent-<id>.meta.json      -> names + parent (the tree's shape)
//   SendMessage PreToolUse    -> agent_message  (the agent-to-agent conversation)
//   agent-<id>.jsonl tail     -> subscribe_agent replay (an agent's own history)
//   an unknown agent id       -> agent_unavailable (so the sheet never waits forever)
//
// Everything here was reverse-engineered from a live CLI (the frozen source
// snapshot predates all of it), so a CLI update can break it with no error: a
// renamed meta field just leaves the tree flat, a dropped hook just leaves the
// strip empty. This is the check that notices.
//
// Requires a running backend (`pnpm dev:backend`): the data path runs through the
// controller. Costs a few credits — it asks a Sonnet session to run a two-agent team.

import { connect, createSession, send, waitForReady } from "./lib/controller.mjs";
import { sessionCwd, targetVersion } from "./lib/env.mjs";

const PROMPT =
  "Create an agent team with two teammates named alpha and beta. Have alpha send beta one " +
  "short question via SendMessage, then have beta reply to alpha via SendMessage. Use no " +
  "tools other than the team and messaging tools. When both have sent their message, shut " +
  "the team down and reply DONE.";

function report(code, verdict, detail) {
  console.log("\n================ RESULT ================");
  console.log(verdict);
  if (detail) console.log(detail);
  process.exit(code);
}

console.log(`target : ${targetVersion()}\n`);

let ws;
try {
  ws = await connect();
} catch (err) {
  report(2, `INCONCLUSIVE - ${err.message}`);
}

const session = await createSession(ws, {
  cwd: sessionCwd,
  model: "sonnet",
  permissionMode: "acceptEdits",
  effort: "low",
}).catch((err) => report(2, `INCONCLUSIVE - ${err.message}`));
console.log(`session: ${session.id}`);
// status_line, or a bounded fallback when remote control delays the first render.
const ready = await waitForReady(ws, session.id);
console.log(`CLI is up (${ready}) - starting the team\n`);

/** agentId -> latest node, as the frontend would hold it. */
const agents = new Map();
const everRunning = new Set();
const messages = [];
const agentStream = []; // events received on a subscribed agent stream
let streamId = null;
let streamHistory = false;
let done = false;
let unavailableReason = null; // reply to a subscribe for an agent that does not exist
const BOGUS_AGENT = "agent-that-does-not-exist";

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.sessionId === session.id) {
    if (msg.type === "agents_snapshot") {
      for (const a of msg.agents) agents.set(a.agentId, a);
      for (const m of msg.messages) if (!messages.some((x) => x.id === m.id)) messages.push(m);
    } else if (msg.type === "agent_update") {
      agents.set(msg.agent.agentId, msg.agent);
      if (msg.agent.status === "running") everRunning.add(msg.agent.agentId);
      console.log(
        `agent_update : ${(msg.agent.name ?? msg.agent.agentType).padEnd(14)} ${msg.agent.status}`,
      );
    } else if (msg.type === "agent_message") {
      messages.push(msg.message);
      console.log(
        `agent_message: ${msg.message.fromAgentId ?? "lead"} -> ${msg.message.to} [${msg.message.kind}]`,
      );
    } else if (msg.type === "approval_request") {
      // Anything the team asks for is part of the experiment, not the subject.
      send(ws, {
        type: "approval_response",
        sessionId: session.id,
        toolUseId: msg.toolUseId,
        decision: "allow",
      });
    } else if (msg.type === "assistant_text" && /\bDONE\b/.test(msg.text)) {
      done = true;
    }
    return;
  }
  if (msg.type === "agent_unavailable" && msg.sessionId.endsWith(`::agent::${BOGUS_AGENT}`)) {
    unavailableReason = msg.reason;
    return;
  }
  if (streamId && msg.sessionId === streamId) {
    if (msg.type === "history_available") streamHistory = true;
    else agentStream.push(msg.type);
  }
});

send(ws, { type: "input", sessionId: session.id, text: PROMPT });

const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  if (done && agents.size >= 2) break;
}
// Let the trailing SubagentStop / meta refresh land.
await new Promise((r) => setTimeout(r, 4000));

// Open one agent's own transcript, the way the sheet does.
const target = [...agents.values()][0];
if (target) {
  streamId = target.streamId;
  send(ws, { type: "subscribe_agent", sessionId: session.id, agentId: target.agentId });
  await new Promise((r) => setTimeout(r, 4000));
}
// And one that cannot exist: the viewer must be told, not left waiting.
send(ws, { type: "subscribe_agent", sessionId: session.id, agentId: BOGUS_AGENT });
await new Promise((r) => setTimeout(r, 3000));
send(ws, { type: "stop_session", sessionId: session.id });

// ---- assertions. The first is the control: without agents there is nothing to judge.
console.log(`\nagents seen: ${agents.size}, messages: ${messages.length}`);
const kinds = [...new Set(messages.map((m) => m.kind))];
console.log(`message kinds seen: ${kinds.join(", ") || "(none)"}`);
for (const n of agents.values()) {
  console.log(
    `  ${n.agentId.padEnd(26)} name=${n.name ?? "-"} type=${JSON.stringify(n.agentType)} ` +
      `status=${n.status} parent=${n.parentAgentId ?? "lead"} toolUseId=${n.toolUseId ? "yes" : "no"}`,
  );
}
if (agents.size === 0 || everRunning.size === 0) {
  report(
    2,
    "INCONCLUSIVE - no agent ever reached the controller.",
    "Either the model did not spawn a team (the prompt was not followed), or the\n" +
      "SubagentStart hook no longer fires / is no longer registered. Re-run once; if it\n" +
      "repeats, check the SubagentStart/Stop entries in hooks-config.ts.",
  );
}

const failures = [];
const nodes = [...agents.values()];
if (!nodes.some((n) => n.name)) {
  failures.push(
    "no agent has a name - agent-<id>.meta.json is no longer being read (renamed field or moved path?)",
  );
}
// Teammates (taskKind in_process_teammate) are spawned by the team, not by an Agent
// tool call, so their meta carries a name but no toolUseId - they hang off the lead.
// Only a plain subagent without one has lost its parent link.
if (nodes.some((n) => !n.toolUseId && !n.name)) {
  failures.push("a plain subagent has no toolUseId - the parent link cannot be built");
}
if (!messages.some((m) => m.fromAgentId && m.text)) {
  failures.push(
    "no agent-to-agent message arrived - SendMessage PreToolUse is no longer reaching the controller, " +
      "or agent teams are not enabled (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)",
  );
}
// A teammate that agreed to shut down must end `done`. Whether the model got as far
// as a shutdown is not ours to force, so a run where none did is reported, not failed.
const approvers = new Set(
  messages
    .filter(
      (m) =>
        m.fromAgentId &&
        (m.kind === "shutdown_approved" || m.kind === "shutdown_response") &&
        !/"approve"\s*:\s*false/.test(m.text),
    )
    .map((m) => m.fromAgentId),
);
if (approvers.size === 0) {
  console.log(
    "note: no teammate approved a shutdown this run, so the done status was not exercised",
  );
}
for (const id of approvers) {
  const n = agents.get(id);
  if (n && n.status !== "done") {
    failures.push(
      `${n.name ?? id} agreed to shut down but ended "${n.status}", not "done" - the shutdown-approval path is not reaching the registry`,
    );
  }
}
if (unavailableReason !== "unknown_agent") {
  failures.push(
    `subscribing to an unknown agent got ${unavailableReason ?? "no reply"}, expected agent_unavailable/unknown_agent - the sheet would wait forever`,
  );
}
if (!streamHistory || agentStream.length === 0) {
  failures.push(
    `subscribing to an agent stream replayed nothing (history_available=${streamHistory}, events=${agentStream.length}) - ` +
      "the sidechain transcript is no longer found or parsed",
  );
}

if (failures.length > 0) {
  report(
    1,
    `FAIL - ${failures.length} contract(s) broke:`,
    failures.map((f) => `  - ${f}`).join("\n"),
  );
}
report(
  0,
  "PASS - agents, names, agent messages, per-agent history and the unavailable reply all reached the controller.",
);
