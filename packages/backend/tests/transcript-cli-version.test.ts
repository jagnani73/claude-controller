import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionBus } from "../src/services/session-bus.service";
import { TranscriptWatcher } from "../src/services/transcript.service";

/**
 * The version reported to `Session.handleCliVersion` must describe the CLI
 * *currently* writing the transcript, not the one that created it.
 *
 * On resume the head of the file carries the build the session was first
 * started on, which can be many releases old. Reporting mid-scan announces that
 * stale value — and once `CLAUDE_CODE_MINIMUM_VERSION` rose above it, that
 * surfaced as an error claiming the question relay may produce wrong answers,
 * on a session running a perfectly current build. Observed live: a resumed
 * session logged `observed: 2.1.217` seconds before reporting 2.1.251.
 */
const DIR = join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  `cc-transcript-version-${process.pid}`,
);
const FILE = join(DIR, "session.jsonl");

const entry = (version: string, i: number) =>
  JSON.stringify({
    type: "system",
    subtype: "informational",
    content: `line ${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    version,
  });

const write = (versions: string[]) =>
  writeFileSync(FILE, `${versions.map(entry).join("\n")}\n`, "utf8");

/** Drain a transcript and collect every version reported during start(). */
async function reportedVersions(versions: string[]): Promise<string[]> {
  write(versions);
  const seen: string[] = [];
  const watcher = new TranscriptWatcher(FILE, new SessionBus("s1"), undefined, (v) => {
    seen.push(v);
  });
  await watcher.start();
  watcher.stop();
  return seen;
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

describe("TranscriptWatcher CLI version reporting", () => {
  it("reports the newest stamp, not the one at the head of the file", async () => {
    // The resume case: session created on 2.1.217, now running on 2.1.251.
    const seen = await reportedVersions(["2.1.217", "2.1.217", "2.1.251", "2.1.251"]);
    expect(seen).toEqual(["2.1.251"]);
  });

  it("reports a stale version exactly once when nothing newer exists", async () => {
    // A session genuinely still on an old build must still be reported, or the
    // below-minimum warning would never fire when it actually matters.
    const seen = await reportedVersions(["2.1.100", "2.1.100"]);
    expect(seen).toEqual(["2.1.100"]);
  });

  it("says nothing when no entry carries a version", async () => {
    const seen = await reportedVersions([]);
    expect(seen).toEqual([]);
  });

  it("does not announce intermediate versions the scan passed through", async () => {
    // Each distinct value is a "change", so an unguarded scan would report all
    // three — two of them describing builds that are no longer running.
    const seen = await reportedVersions(["2.1.100", "2.1.180", "2.1.251"]);
    expect(seen).toEqual(["2.1.251"]);
    expect(seen).not.toContain("2.1.100");
    expect(seen).not.toContain("2.1.180");
  });
});
