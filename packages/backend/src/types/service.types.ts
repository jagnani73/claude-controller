import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";

// ─── Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dumpDir: string;
  workDir: string;
  pty: {
    cols: number;
    rows: number;
  };
}

// ─── PTY Service ─────────────────────────────────────────────────────

export interface PtySpawnOptions {
  cwd: string;
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
