import { execFile } from "node:child_process";
import { CLAUDE_CODE_TARGET_VERSION } from "common/version";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("cli-version");

/** `claude --version` is instant; this only bounds a hung or misconfigured binary. */
const PROBE_TIMEOUT_MS = 10_000;

/** Where the drift reference came from. */
export type CliReferenceSource = "binary" | "fallback";

export interface CliReference {
  version: string;
  source: CliReferenceSource;
}

/**
 * Leading dotted version of `claude --version` output, e.g. "2.1.322" from
 * "2.1.322 (Claude Code)". Null when the output does not start with one.
 */
export function parseCliVersion(output: string): string | null {
  const match = /^\s*v?(\d+(?:\.\d+)+)/.exec(output);
  return match ? match[1] : null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: argv goes straight to the process, so a CLAUDE_BIN path with
    // spaces needs no quoting.
    execFile(
      file,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * Run `<claudeBin> --version` and parse the result. Throws on a missing binary,
 * a timeout, a non-zero exit, or output with no leading version.
 */
async function probeCliVersion(claudeBin: string): Promise<string> {
  let stdout: string;
  try {
    stdout = await run(claudeBin, ["--version"]);
  } catch (err) {
    // A bare `claude` that is really an npm `claude.cmd` shim cannot be started
    // without a shell (ENOENT, or EINVAL on current Node). The PTY launches via
    // `cmd.exe /c`, so retry the same way before giving up.
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "ENOENT" && code !== "EINVAL")) throw err;
    stdout = await run("cmd.exe", ["/d", "/c", claudeBin, "--version"]);
  }
  const version = parseCliVersion(stdout);
  if (!version) throw new Error(`unparseable --version output: ${JSON.stringify(stdout.trim())}`);
  return version;
}

/**
 * Resolve the drift reference for session version checks: the version of the
 * binary the controller will actually spawn, read once at startup.
 *
 * Falls back to the static `CLAUDE_CODE_TARGET_VERSION` when the probe fails.
 * That is logged at error, not warn: `warn` is outside the default log level,
 * and silently comparing sessions against a stale pin is the drift this exists
 * to catch.
 *
 * Deliberately not applied to `CLAUDE_CODE_MINIMUM_VERSION`, which is a static
 * correctness floor for the question relay, not drift.
 */
export async function resolveCliReference(claudeBin: string): Promise<CliReference> {
  try {
    const version = await probeCliVersion(claudeBin);
    log.info("Resolved installed Claude Code version", { claudeBin, version });
    return { version, source: "binary" };
  } catch (err) {
    log.error("Could not determine the installed Claude Code version; using the static fallback", {
      claudeBin,
      fallback: CLAUDE_CODE_TARGET_VERSION,
      reason: err instanceof Error ? err.message : String(err),
      impact: "version drift is judged against the last-verified build, not the installed one",
    });
    return { version: CLAUDE_CODE_TARGET_VERSION, source: "fallback" };
  }
}
