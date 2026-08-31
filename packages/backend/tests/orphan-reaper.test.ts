import { describe, expect, it } from "vitest";
import type { LiveSession, SpawnRecord } from "../src/services/orphan-reaper.service";
import { selectOrphans } from "../src/services/orphan-reaper.service";

/**
 * The consequence of a wrong answer here is killing a process, so both halves of
 * the match are asserted independently. The session id proves the process is the
 * one the record describes; the start time proves it is the one *we* spawned,
 * rather than a session the user opened in their own terminal.
 */
const record = (over: Partial<SpawnRecord> = {}): SpawnRecord => ({
  sessionId: "89b0e032-1baa-443c-9465-c80a86db74b4",
  spawnToken: "token-1",
  spawnedAt: 1_000_000,
  ...over,
});

const live = (over: Partial<LiveSession> = {}): LiveSession => ({
  pid: 4242,
  sessionId: "89b0e032-1baa-443c-9465-c80a86db74b4",
  startedAt: 1_000_500,
  ...over,
});

describe("selectOrphans", () => {
  it("matches a live process to the record that spawned it", () => {
    const picked = selectOrphans([record()], [live()]);
    expect(picked).toEqual([{ record: record(), pid: 4242 }]);
  });

  it("ignores a live session with a different id", () => {
    // Killing by pid alone is what this prevents: a machine that restarted can
    // recycle a pid onto something entirely unrelated.
    const picked = selectOrphans([record()], [live({ sessionId: "some-other-session" })]);
    expect(picked).toEqual([]);
  });

  it("spares a process that predates our spawn", () => {
    // The user already had this session open in their own terminal. It is not
    // ours to kill, and doing so would close a session they are sitting in.
    const picked = selectOrphans([record({ spawnedAt: 2_000_000 })], [live({ startedAt: 1_000 })]);
    expect(picked).toEqual([]);
  });

  it("tolerates the CLI's file reading marginally earlier than our spawn", () => {
    // It writes its own startedAt a moment after we spawn, and clock
    // granularity can invert them by a hair. Too strict here and the reaper
    // silently never fires.
    const picked = selectOrphans(
      [record({ spawnedAt: 1_000_000 })],
      [live({ startedAt: 999_000 })],
    );
    expect(picked).toHaveLength(1);
  });

  it("does not tolerate a wildly earlier start", () => {
    // The slack is for clock skew, not for adopting unrelated processes.
    const picked = selectOrphans(
      [record({ spawnedAt: 1_000_000 })],
      [live({ startedAt: 900_000 })],
    );
    expect(picked).toEqual([]);
  });

  it("reports nothing when the process is already gone", () => {
    // Claude Code removes its session file on exit, so an empty live list is the
    // normal case after a clean shutdown.
    expect(selectOrphans([record()], [])).toEqual([]);
  });

  it("handles several records and picks only the live ones", () => {
    const a = record({ sessionId: "aaa", spawnToken: "t-a" });
    const b = record({ sessionId: "bbb", spawnToken: "t-b" });
    const c = record({ sessionId: "ccc", spawnToken: "t-c" });
    const picked = selectOrphans(
      [a, b, c],
      [live({ sessionId: "aaa", pid: 1 }), live({ sessionId: "ccc", pid: 3 })],
    );
    expect(picked.map((p) => p.pid)).toEqual([1, 3]);
    expect(picked.map((p) => p.record.spawnToken)).toEqual(["t-a", "t-c"]);
  });

  it("is a no-op with no records at all", () => {
    expect(selectOrphans([], [live()])).toEqual([]);
  });
});
