import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Closes the gap the unit tests cannot reach.
 *
 * `runtime-reconciler.test.ts` proves the *rule* — defer while suppressed,
 * replay on a collapse, invalidate on respawn. It cannot prove `Session`
 * actually calls it in those places, and that wiring is exactly where the
 * original bug lived: the logic for correcting a stale alias was already there,
 * it just never ran again once suppression dropped the observation.
 *
 * Everything that touches the outside world is mocked away: the PTY, the
 * session locator, the statusline poller, and the transcript watcher. Mocking
 * the watcher is also the seam that makes this testable at all — it receives
 * `handleModelChange`/`handleEffortChange` as constructor arguments, so
 * capturing them lets a test feed the session a transcript observation without
 * a transcript.
 */

/** Callbacks the real TranscriptWatcher would invoke; captured from the mock. */
const captured: {
  onModelChange?: (m: string) => void;
  onEffortChange?: (e: string) => void;
} = {};

class FakePty extends EventEmitter {
  spawn = vi.fn();
  write = vi.fn();
  kill = vi.fn(() => {
    // The real PTY exits asynchronously; _doRespawn awaits that before spawning.
    setTimeout(() => this.emit("exit", { exitCode: 0 }), 0);
  });
}

vi.mock("../src/services/pty.service.js", () => ({
  PtyService: FakePty,
  STRIPPED_CHILD_ENV: [],
}));

vi.mock("../src/services/session-locator.service.js", () => ({
  SessionLocator: class {
    start() {}
    stop() {}
  },
}));

vi.mock("../src/services/statusline.service.js", () => ({
  statusLineDumpScriptPath: () => "dump.cjs",
  statusLinePayloadPath: () => "payload.json",
  readDumpedPayload: async () => null,
  resolveStatusLineCommand: async () => null,
  runStatusLine: async () => null,
}));

vi.mock("../src/services/transcript.service.js", () => ({
  TranscriptWatcher: class {
    constructor(
      _path: string,
      _bus: unknown,
      onModelChange?: (m: string) => void,
      _onCliVersion?: (v: string) => void,
      onEffortChange?: (e: string) => void,
    ) {
      captured.onModelChange = onModelChange;
      captured.onEffortChange = onEffortChange;
    }
    async start() {}
    stop() {}
  },
}));

const { Session } = await import("../src/session/session");

const deps = {
  serverConfig: {
    port: 0,
    host: "127.0.0.1",
    hooksPort: 0,
    dumpDir: "dump",
    capturePty: false,
    workDir: ".",
    claudeBin: "claude",
    pty: { cols: 120, rows: 40 },
  },
  hooksBaseUrl: "http://127.0.0.1:1",
};

/** A resumed session, because that path builds the watcher we capture from. */
function makeSession(model: "sonnet" | "opus" = "sonnet") {
  return new Session(
    {
      cwd: "D:\\Work\\claude-controller",
      model,
      permissionMode: "default",
      effort: "low",
      resumeSessionId: "11111111-2222-3333-4444-555555555555",
    },
    deps,
    // biome-ignore lint/suspicious/noExplicitAny: mocked deps, not the real shape
  ) as any;
}

beforeEach(() => {
  captured.onModelChange = undefined;
  captured.onEffortChange = undefined;
});

describe("Session wiring: a pending pick that collapses", () => {
  it("replays a model observation the pending pick suppressed", () => {
    // The exact sequence from the bug report, driven through the public API.
    const session = makeSession("sonnet");
    expect(captured.onModelChange).toBeTypeOf("function");

    session.setPendingModel("opus");
    captured.onModelChange?.("claude-opus-5");

    // Suppressed: the alias must NOT move while the pick is outstanding.
    expect(session.model).toBe("sonnet");

    // The user changes their mind back to what is running. No respawn happens,
    // so this is the last chance to act on the observation.
    session.setPendingModel("sonnet");
    expect(session.model).toBe("opus");
  });

  it("replays a suppressed effort observation too", () => {
    const session = makeSession("sonnet");
    // A pending effort pick suppresses reconciliation the same way a model pick
    // does, and the effort path is the one that used to drop the datum outright.
    session.setPendingModel("sonnet", "high");
    captured.onEffortChange?.("max");
    expect(session.currentEffort).toBe("low");

    session.setPendingModel("sonnet", "low");
    expect(session.currentEffort).toBe("max");
  });

  it("does not reconcile on a pick that changes nothing", () => {
    // Guards the flush from firing on every no-op pick: `changed` is false, so
    // setPendingModel returns before touching anything.
    const session = makeSession("sonnet");
    captured.onModelChange?.("claude-sonnet-5");
    session.setPendingModel("sonnet");
    expect(session.model).toBe("sonnet");
  });
});

/**
 * `_doRespawn` waits for the resumed CLI to settle: a bus event newer than the
 * spawn, then 400ms of quiet. With no events it falls back to an 8s timeout,
 * which would make this file the slowest thing in a suite that is supposed to be
 * instant. Nudging the bus is also the more faithful simulation — a real resume
 * does write to the transcript.
 *
 * The interval must exceed that quiet window: each event *resets* the timer, so
 * nudging faster than 400ms keeps the wait alive until the 8s fallback — which
 * is exactly what a first attempt at this did.
 */
// biome-ignore lint/suspicious/noExplicitAny: mocked session, not the real shape
async function respawnTo(session: any, model: "opus" | "sonnet") {
  const done = session.respawn({ model, effort: "low", permissionMode: "default" });
  const nudge = setInterval(() => {
    session.bus?.push({
      kind: "interrupt",
      sessionId: session.bus.sessionId,
      timestamp: new Date().toISOString(),
    });
  }, 600);
  try {
    await done;
  } finally {
    clearInterval(nudge);
  }
}

describe("Session wiring: respawn", () => {
  it("does not revert the new intent using a pre-respawn observation", async () => {
    // The mirror-image trap. After respawning to opus the retained id still
    // reads claude-sonnet-5 until the resumed session takes a turn; replaying it
    // would "correct" the alias straight back to sonnet and undo the switch.
    const session = makeSession("sonnet");
    captured.onModelChange?.("claude-sonnet-5");
    expect(session.model).toBe("sonnet");

    await respawnTo(session, "opus");

    expect(session.model).toBe("opus");
  }, 20_000);

  it("clears the observation so the resumed session reports fresh", async () => {
    const session = makeSession("sonnet");
    captured.onModelChange?.("claude-sonnet-5");
    await respawnTo(session, "opus");

    // Same id again must register rather than be deduped away, or a session that
    // resumed onto the same model would never reconcile again.
    captured.onModelChange?.("claude-sonnet-5");
    expect(session.model).toBe("sonnet");
  }, 20_000);

  it("cannot be made to revert the switch by a later collapse", async () => {
    // The trap in full. The test above passes even without invalidate(), because
    // today nothing replays right after a respawn — so on its own it documents
    // the invariant rather than enforcing it. This one enforces it: a pending
    // pick that collapses *after* the respawn does flush, and if the pre-respawn
    // id were still retained the flush would reconcile `opus` against a stale
    // claude-sonnet-5 and silently undo the user's switch.
    const session = makeSession("sonnet");
    captured.onModelChange?.("claude-sonnet-5");
    await respawnTo(session, "opus");
    expect(session.model).toBe("opus");

    session.setPendingModel("haiku");
    session.setPendingModel("opus"); // collapses back to the running model
    expect(session.model).toBe("opus");
  }, 20_000);
});
