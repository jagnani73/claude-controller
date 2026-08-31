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
    /** Present only inside a linked git worktree (added upstream in 2.1.97). */
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
export async function runStatusLine(command: string, payloadJson: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const isWindows = platform() === "win32";
    const direct = isWindows ? directBashSpawn(command) : null;
    const proc = direct
      ? spawn(direct.exe, direct.args, { windowsHide: true })
      : isWindows
        ? spawn("cmd.exe", ["/c", command], { windowsHide: true })
        : spawn(command, { shell: "/bin/sh" });

    let stdout = "";
    let finished = false;
    const done = (value: string | null) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      proc.kill();
      log.warn("status-line command timed out", { command });
      done(null);
    }, RUN_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      log.warn("status-line spawn failed", { error: err.message });
      done(null);
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.warn("status-line exited non-zero", {
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
      proc.stdin.write(`${payloadJson}\n`);
      proc.stdin.end();
    } catch {
      // Process likely already exited; close handler will resolve.
    }
  });
}
