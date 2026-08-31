import { describe, expect, it } from "vitest";
import { inputPrefixHint, inputPrefixMode } from "../src/components/layout/input-prefix";

/**
 * Expectations transcribed from a live PTY capture against the target build,
 * not from the CLI source: the controller sends every message as a bracketed
 * paste, and the open question was whether pasting bypasses prefix handling.
 * It does not.
 */
describe("inputPrefixMode", () => {
  it("flags a leading ! as shell mode", () => {
    // Verified: pasting `!echo hi` renders `! echo hi` with a `! for shell mode`
    // footer, so on submit it runs as a shell command and never reaches Claude.
    expect(inputPrefixMode("!echo hi")).toBe("shell");
    expect(inputPrefixMode("!")).toBe("shell");
  });

  it("flags a leading / as a slash command", () => {
    expect(inputPrefixMode("/model")).toBe("command");
    expect(inputPrefixMode("/")).toBe("command");
  });

  it("ignores ! and / anywhere but the first character", () => {
    // Verified: `run !echo hi` stays plain text and changes no mode.
    expect(inputPrefixMode("run !echo hi")).toBeNull();
    expect(inputPrefixMode("what does a/b mean")).toBeNull();
    expect(inputPrefixMode("wow!")).toBeNull();
  });

  it("does not trim, because only position 0 was verified", () => {
    // A leading space very likely defeats the CLI's own check too, but that was
    // not tested — warning on it would be guessing, and this file records only
    // what was observed.
    expect(inputPrefixMode(" !echo hi")).toBeNull();
    expect(inputPrefixMode("\n/model")).toBeNull();
  });

  it("treats an empty draft as plain", () => {
    expect(inputPrefixMode("")).toBeNull();
  });
});

describe("inputPrefixHint", () => {
  it("says the shell case bypasses Claude entirely", () => {
    // The whole point of the warning: the user thinks they are talking to
    // Claude, and they are not.
    expect(inputPrefixHint("shell")).toMatch(/shell command/i);
    expect(inputPrefixHint("shell")).toMatch(/won't see/i);
  });

  it("describes the slash case without alarming", () => {
    // Slash routing is intended behaviour, so this is information, not a warning.
    expect(inputPrefixHint("command")).toMatch(/slash command/i);
    expect(inputPrefixHint("command")).not.toMatch(/won't see/i);
  });
});
