import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("statusline");

interface StatusLineSettings {
  /** Command to run — passed through the user's shell. */
  command: string;
  /** Claude Code supports `type: "command"`; other types aren't supported yet. */
  type?: string;
  /** Unused here but part of the spec — kept so we don't warn on parse. */
  padding?: number;
}

interface SettingsJson {
  statusLine?: StatusLineSettings | string;
}

/** A usage window in the statusline payload's snake_case shape. */
interface StatusLineRateWindow {
  used_percentage: number;
  resets_at: number;
}

/**
 * Claude Code's `StatusLineCommandInput`, as it actually arrives on disk.
 *
 * Purely descriptive — nothing here constructs one. Claude Code writes the
 * payload via our dump script and we forward the raw JSON string to the user's
 * statusline command untouched, so this type documents the dump and types any
 * future parse of it. Verified field-by-field against captured payloads in
 * `dump/statusline/`; fields marked "unverified" come from the changelog and
 * postdate those captures.
 *
 * Optionality reflects observed reality: a field is optional when it was absent
 * from at least one capture, because Claude Code emits several of these
 * conditionally (a repo only when one is detected, a worktree only inside one).
 */
export interface StatusLinePayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  /** Resolved reasoning effort — a concrete level even when the session is `auto`. */
  effort: { level: string };
  /** Set by `/rename`; absent on unnamed sessions. */
  session_name?: string;
  model: { id: string; display_name: string };
  workspace: {
    current_dir: string;
    project_dir: string;
    added_dirs: string[];
    /** Present when a git remote is detected (added upstream in 2.1.145). */
    repo?: { host: string; owner: string; name: string };
    /**
     * Unverified: documented upstream in 2.1.97 as set inside a linked git
     * worktree, but absent from all of our captures — none were taken in one, so
     * neither its presence nor its type is confirmed here.
     */
    git_worktree?: string;
  };
  output_style: { name: string };
  version: string;
  fast_mode: boolean;
  thinking: { enabled: boolean };
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    /** An object, not a scalar — this was previously typed `number`. */
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    used_percentage: number;
    remaining_percentage: number;
  };
  exceeds_200k_tokens: boolean;
  /** Read by `Session.absorbDumpedPayload`; was missing from this type entirely. */
  rate_limits?: {
    five_hour?: StatusLineRateWindow;
    seven_day?: StatusLineRateWindow;
    /** Unverified: documented in 2.1.251, postdates our captures. */
    spend_limit?: StatusLineRateWindow;
  };
  /** Unverified: documented in 2.1.251, postdates our captures. */
  prompt_cache?: Record<string, unknown>;
}

const RUN_TIMEOUT_MS = 5000;
let windowsOwnershipFailed = false;

/** Leading + trailing latest-value work, with no overlapping executions. */
export class StatusLineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private lastStarted = -Infinity;
  private readonly controller = new AbortController();

  constructor(
    private readonly work: (signal: AbortSignal) => Promise<void>,
    private readonly intervalMs = 1000,
  ) {}

  request(): void {
    if (this.controller.signal.aborted) return;
    this.pending = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.controller.signal.aborted || this.running || this.timer || !this.pending) return;
    const delay = Math.max(0, this.intervalMs - (Date.now() - this.lastStarted));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = false;
      this.running = true;
      this.lastStarted = Date.now();
      void this.work(this.controller.signal)
        .catch((err: unknown) => {
          if (!this.controller.signal.aborted) {
            log.warn("status-line tick failed", { error: String(err) });
          }
        })
        .finally(() => {
          this.running = false;
          this.schedule();
        });
    }, delay);
    this.timer.unref();
  }

  stop(): void {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }
}

/**
 * Absolute path to the committed `statusline-dump.cjs` bridge script that Claude
 * Code runs as its statusLine command (see scripts/statusline-dump.cjs). Resolved
 * relative to this compiled module (dist/services/ -> ../../scripts) and memoized
 * — the location is fixed for the process lifetime.
 */
let cachedScriptPath: string | undefined;
export function statusLineDumpScriptPath(): string {
  if (cachedScriptPath !== undefined) return cachedScriptPath;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "..", "scripts", "statusline-dump.cjs");
  if (!existsSync(path)) {
    // error, not warn: this is a packaging/deploy fault that silently breaks all
    // statusline metadata, and it never self-heals. Must survive the default
    // info,error log level so the operator actually sees it.
    log.error("statusline dump script not found — statusline metadata will be unavailable", {
      path,
    });
  }
  cachedScriptPath = path;
  return path;
}

export function statusLinePayloadPath(dumpDir: string, sessionId: string): string {
  return join(dumpDir, "statusline", `${sessionId}.json`);
}

export async function readDumpedPayload(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

let cachedBashPath: string | null | undefined;
function findBashExe(): string | null {
  if (cachedBashPath !== undefined) return cachedBashPath;
  cachedBashPath = WINDOWS_BASH_CANDIDATES.find((p) => existsSync(p)) ?? null;
  return cachedBashPath;
}

function directBashSpawn(command: string): { exe: string; args: string[] } | null {
  const match = /^bash(\s+)(.+)$/i.exec(command);
  if (!match) return null;
  const bash = findBashExe();
  if (!bash) return null;
  return { exe: bash, args: ["-c", match[2]] };
}

/**
 * Resolve the status-line command from `~/.claude/settings.json`, falling back
 * to the project-level `<cwd>/.claude/settings.json`. Project settings win.
 */
export async function resolveStatusLineCommand(cwd: string): Promise<string | null> {
  const candidates = [
    join(homedir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  let command: string | null = null;
  for (const path of candidates) {
    const parsed = await tryReadSettings(path);
    if (parsed?.statusLine) {
      command =
        typeof parsed.statusLine === "string" ? parsed.statusLine : parsed.statusLine.command;
    }
  }
  return command;
}

async function tryReadSettings(path: string): Promise<SettingsJson | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as SettingsJson;
  } catch {
    return null;
  }
}

/**
 * Run the user's status-line command with the JSON payload on stdin, return
 * raw stdout (ANSI preserved — the frontend parses it). Swallows errors and
 * returns null on timeout / non-zero exit so a broken script never crashes
 * the session loop.
 */
export async function runStatusLine(
  command: string,
  payloadJson: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted || (platform() === "win32" && windowsOwnershipFailed)) return null;
  return await new Promise<string | null>((resolve) => {
    const isWindows = platform() === "win32";
    const direct = isWindows ? directBashSpawn(command) : null;
    const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
    const proc = isWindows
      ? spawn(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(scripts, "statusline-job.ps1"),
            process.execPath,
            join(scripts, "statusline-runner.cjs"),
          ],
          { windowsHide: true },
        )
      : spawn(command, { shell: "/bin/sh", detached: true });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let cancelled = false;
    let cleanupTimer: NodeJS.Timeout | undefined;

    const done = (value: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abort);
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();

      proc.unref();
      resolve(value);
    };

    const killGroup = (signal: NodeJS.Signals) => {
      if (!proc.pid) return;
      try {
        // detached creates a group owned by this invocation, never our server's.
        process.kill(-proc.pid, signal);
      } catch {
        // Already gone, or group termination unavailable.
        if (proc.exitCode === null) proc.kill(signal);
      }
    };
    const abort = () => {
      if (cancelled || finished) return;
      cancelled = true;
      stdout = "";
      stderr = "";
      clearTimeout(timer);
      // Stop consuming immediately, but keep the scheduler occupied throughout
      // bounded tree cleanup. `close` is not a deadline: inherited pipes can
      // survive the shell forever, even after its exit event.
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
      if (isWindows) {
        // Kill the job OWNER via Node's process handle, never a shell PID.
        // It joins a kill-on-close job before launching user code, and keeps
        // the only job handle alive through inherited-pipe completion. Even
        // an unexpected owner exit closes that handle and kills descendants.
        proc.kill("SIGKILL");
        cleanupTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            windowsOwnershipFailed = true;
            log.error(
              "Windows status-line owner did not exit; further executions disabled. " +
                "Check process permissions and restart the backend after resolving the stuck launcher.",
            );
          }
          done(null);
        }, 1000);
      } else {
        killGroup("SIGTERM");
        cleanupTimer = setTimeout(() => {
          killGroup("SIGKILL");
          cleanupTimer = setTimeout(() => done(null), 250);
        }, 250);
      }
    };
    const timer = setTimeout(() => {
      log.warn("status-line command timed out", { command });
      abort();
    }, RUN_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    proc.stdin.on("error", () => {
      // EPIPE when a command exits without consuming its input.
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      if (!cancelled && !finished) stdout += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (isWindows) log.error("status-line job launcher failed", { error: err.message });
      else log.warn("status-line spawn failed", { error: err.message });
      if (!cancelled) done(null);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (!cancelled && !finished) stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (cancelled) return;
      if (code !== 0) {
        const report = isWindows ? log.error : log.warn;
        report("status-line exited non-zero (on Windows, also check the job launcher)", {
          code,
          stderr: stderr.slice(0, 500),
          stdout: stdout.slice(0, 200),
        });
        done(null);
        return;
      }
      done(stdout);
    });

    try {
      proc.stdin.write(
        isWindows
          ? JSON.stringify({
              shell: direct ? "bash" : "cmd",
              exe: direct?.exe ?? "cmd.exe",
              args: direct?.args ?? ["/d", "/s", "/c", `"${command}"`],
              payload: payloadJson,
            })
          : `${payloadJson}\n`,
      );
      proc.stdin.end();
    } catch {
      // Process likely already exited; close handler will resolve.
    }
  });
}
