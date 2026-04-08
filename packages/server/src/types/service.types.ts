import type { ClaudeModel, PermissionMode, SessionStatus } from "common/types";

// ─── Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
    port: number;
    host: string;
    dataDir: string;
    workDir: string;
    pty: {
        cols: number;
        rows: number;
    };
    ringBufferSize: number;
}

// ─── PTY Service ─────────────────────────────────────────────────────

export interface PtySpawnOptions {
    cwd: string;
    model: ClaudeModel;
    permissionMode: PermissionMode;
    cols: number;
    rows: number;
}

export interface PtyManagerEvents {
    data: [string];
    exit: [{ exitCode: number; signal?: number }];
}

// ─── Session ─────────────────────────────────────────────────────────

export interface SessionEvents {
    output: [string];
    status: [SessionStatus];
    exit: [{ exitCode: number; signal?: number }];
}

// ─── WebSocket Service ───────────────────────────────────────────────

export interface ClientState {
    subscribedSessionId: string | null;
    cleanup: (() => void) | null;
}
