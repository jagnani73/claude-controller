import type { ClaudeModel, PermissionMode } from "common/types";

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
