import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";

// ─── Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  host: string;
  hooksPort: number;
  /** Dump dir root: `statusline/` payloads (always) + `captures/` PTY `.raw` (dev only). */
  dumpDir: string;
  /** Whether to write PTY `.raw` captures — dev only, off in production. */
  capturePty: boolean;
  workDir: string;
  /**
   * Command used to launch Claude Code — bare `claude` (resolved off PATH) unless
   * `CLAUDE_BIN` pins an absolute path. Pin it when PATH is ambiguous.
   */
  claudeBin: string;
  pty: {
    cols: number;
    rows: number;
  };
}

// ─── PTY Service ─────────────────────────────────────────────────────

export interface PtySpawnOptions {
  cwd: string;
  /**
   * Command used to launch Claude Code — bare `claude` (PATH-resolved) or the
   * absolute path pinned via `CLAUDE_BIN`. See `ServerConfig.claudeBin`.
   */
  claudeBin: string;
  model: ClaudeModel;
  permissionMode: PermissionMode;
  cols: number;
  rows: number;
  /** Inline JSON string passed to `claude --settings`. Injects our hooks. */
  settingsJson?: string;
  /** When set, adds `--resume <id>` to pick up an existing session's transcript. */
  resumeSessionId?: string;
  /**
   * Force `--model <alias>` even on resume. Default behavior on resume is to
   * omit `--model` so Claude Code preserves the session's last model. Set this
   * for the respawn-on-settings-change path where the user explicitly chose a
   * new model and we want the resumed PTY to switch.
   */
  forceModel?: boolean;
  /**
   * When set, exports `CLAUDE_CODE_EFFORT_LEVEL` to the PTY's environment so
   * this child process is isolated from `settings.json` effort changes made
   * by parallel sessions. Env wins over both AppState and settings.json in
   * Claude Code's resolve chain (see effort.ts → resolveAppliedEffort).
   */
  effort?: EffortLevel;
}

export interface PtyManagerEvents {
  data: [string];
  exit: [{ exitCode: number; signal?: number }];
}

// ─── Session ─────────────────────────────────────────────────────────

export interface SessionDeps {
  serverConfig: ServerConfig;
  hooksBaseUrl: string;
}

export interface SessionEvents {
  exit: [{ exitCode: number; signal?: number }];
  metadataChanged: [];
  statusLine: [string];
  idResolved: [string];
}

// ─── WebSocket Service ───────────────────────────────────────────────

export interface ClientState {
  subscribedSessionId: string | null;
  cleanup: (() => void) | null;
}
