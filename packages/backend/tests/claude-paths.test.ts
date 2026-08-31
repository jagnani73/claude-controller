import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectsRoot, encodedProjectDir } from "../src/utils/claude-paths";

const root = join(homedir(), ".claude", "projects");
const dirName = (cwd: string) => encodedProjectDir(cwd).slice(root.length + 1);

afterEach(() => {
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
});

describe("claudeProjectsRoot", () => {
  it("points at Claude Code's per-project transcript store", () => {
    expect(claudeProjectsRoot()).toBe(root);
  });
});

describe("encodedProjectDir", () => {
  it("replaces path separators", () => {
    expect(dirName("D:\\Work\\claude-controller")).toBe("D--Work-claude-controller");
    expect(dirName("/home/user/proj")).toBe("-home-user-proj");
  });

  it("replaces EVERY non-alphanumeric character, not just separators", () => {
    // The regression this guards: an earlier version replaced only [:\\/], so a
    // path containing a space or bracket derived a directory that does not
    // exist. The watcher then tailed nothing and the session streamed no events
    // at all — the least debuggable failure mode in the project.
    //
    // Expectation captured from a live ~/.claude/sessions entry.
    expect(
      dirName(
        "D:\\Education\\NTU\\Courses\\Trimester 1\\[SC6103] DISTRIBUTED SYSTEMS\\SC6103-project",
      ),
    ).toBe("D--Education-NTU-Courses-Trimester-1--SC6103--DISTRIBUTED-SYSTEMS-SC6103-project");
  });

  it("collapses each special character to exactly one dash", () => {
    // One dash per character, not per run — the CLI does a character-wise
    // replace, so "a  b" is "a--b" and not "a-b".
    expect(dirName("C:\\a  b")).toBe("C--a--b");
    expect(dirName("C:\\a.b_c")).toBe("C--a-b-c");
    expect(dirName("C:\\(x)")).toBe("C---x-");
  });

  it("leaves alphanumerics and existing dashes untouched", () => {
    expect(dirName("C:\\abc123-XYZ")).toBe("C--abc123-XYZ");
  });

  it("honours CLAUDE_CODE_PROJECT_DIR_NAME over the derived name", () => {
    // Upstream 2.1.234: hosts may name the per-project directory themselves.
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "custom-name";
    expect(dirName("D:\\Work\\claude-controller")).toBe("custom-name");
  });

  it("ignores a blank CLAUDE_CODE_PROJECT_DIR_NAME", () => {
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "   ";
    expect(dirName("D:\\Work\\claude-controller")).toBe("D--Work-claude-controller");
  });
});
