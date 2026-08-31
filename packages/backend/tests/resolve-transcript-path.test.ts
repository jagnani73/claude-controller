import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect the whole lookup into a temp tree: `claudeProjectsRoot()` is derived
// from homedir(), and the real one holds the user's transcripts — a test must
// never write there.
//
// Hoisted, and built by string concat rather than join(), because vi.mock's
// factory runs before imports are initialised — nothing imported here exists
// yet. Both sides normalise it through join() below, so the separator is fine.
const HOME_RAW = vi.hoisted(
  () => `${process.env.TEMP || process.env.TMPDIR || "/tmp"}/cc-resolve-transcript-${process.pid}`,
);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME_RAW };
});

const { encodedProjectDir, resolveTranscriptPath } = await import("../src/utils/claude-paths");

const HOME = join(HOME_RAW);
const PROJECTS = join(HOME, ".claude", "projects");
const CWD = "D:\\Work\\claude-controller";
const DERIVED = join(PROJECTS, "D--Work-claude-controller");
const SESSION = "11111111-2222-3333-4444-555555555555";

const seed = (dir: string, id = SESSION) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "");
};

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(PROJECTS, { recursive: true });
});

afterEach(() => {
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  rmSync(HOME, { recursive: true, force: true });
});

describe("resolveTranscriptPath", () => {
  it("redirects at the temp home, so nothing here touches real transcripts", () => {
    // Control for every case below: if the mock ever stops applying, these
    // assertions would be exercising the user's own ~/.claude tree.
    expect(encodedProjectDir(CWD)).toBe(DERIVED);
    expect(DERIVED.startsWith(HOME)).toBe(true);
  });

  it("returns the derived path when the transcript is where we expect", () => {
    seed(DERIVED);
    expect(resolveTranscriptPath(CWD, SESSION)).toBe(join(DERIVED, `${SESSION}.jsonl`));
  });

  it("falls back to a scan when the encoding derived the wrong directory", () => {
    // The blind spots the fallback exists for: paths over ~200 chars (upstream
    // disambiguates them under a scheme we have not verified) and non-ASCII
    // segments. Either way the file is real, just not where we guessed.
    const actual = join(PROJECTS, "some-other-encoding");
    seed(actual);
    expect(resolveTranscriptPath(CWD, SESSION)).toBe(join(actual, `${SESSION}.jsonl`));
  });

  it("keeps the derived path when the scan finds nothing", () => {
    // Since v2.1.126 the JSONL is not created until the first user message, so a
    // fresh session legitimately has no file yet. Returning the derived path
    // lets TranscriptWatcher's parent-dir watch pick it up when it appears.
    seed(join(PROJECTS, "unrelated-project"), "99999999-0000-0000-0000-000000000000");
    expect(resolveTranscriptPath(CWD, SESSION)).toBe(join(DERIVED, `${SESSION}.jsonl`));
  });

  it("keeps the derived path when the projects root does not exist at all", () => {
    // readdirSync throws here; a fresh machine must not crash the lookup.
    rmSync(HOME, { recursive: true, force: true });
    expect(resolveTranscriptPath(CWD, SESSION)).toBe(join(DERIVED, `${SESSION}.jsonl`));
  });

  it("matches on the session id, never on the directory alone", () => {
    seed(DERIVED, "aaaaaaaa-0000-0000-0000-000000000000");
    expect(resolveTranscriptPath(CWD, SESSION)).toBe(join(DERIVED, `${SESSION}.jsonl`));
  });

  it("honours CLAUDE_CODE_PROJECT_DIR_NAME for the derived path", () => {
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "host-named";
    const named = join(PROJECTS, "host-named");
    seed(named);
    expect(resolveTranscriptPath(CWD, SESSION)).toBe(join(named, `${SESSION}.jsonl`));
  });
});
