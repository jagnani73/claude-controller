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

/**
 * Payload matches Claude Code's `StatusLineCommandInput`. We fill what we can
 * (session id, cwd, model, permission mode) and zero out fields that require
 * API-level knowledge (cost, tokens, rate limits) — we're a PTY relay, not an
 * API client. Scripts that only use model/cwd/mode render accurately; ones
 * that print cost/token stats will see zeros.
 */
export interface StatusLinePayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  model: { id: string; display_name: string };
  workspace: {
    current_dir: string;
    project_dir: string;
    added_dirs: string[];
  };
  output_style: { name: string };
  version: string;
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
    current_usage: number;
    used_percentage: number;
    remaining_percentage: number;
  };
  exceeds_200k_tokens: boolean;
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
export async function runStatusLine(
  command: string,
  payload: StatusLinePayload | string,
): Promise<string | null> {
  const payloadJson = typeof payload === "string" ? payload : JSON.stringify(payload);
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
