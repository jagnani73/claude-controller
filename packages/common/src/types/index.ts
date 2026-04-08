/** WebSocket message types sent between client and server */
export type WsMessageType =
    | "input"
    | "command"
    | "approve"
    | "deny"
    | "stream"
    | "approval_needed"
    | "tool_use"
    | "tool_result"
    | "thinking"
    | "turn_complete"
    | "session_metadata"
    | "error"
    | "connected"
    | "disconnected"
    | "dir_list";

/** Base WebSocket message shape */
export interface WsMessage {
    type: WsMessageType;
    sessionId?: string;
    data?: unknown;
    timestamp: number;
}

/** Session permission modes matching Claude Code CLI */
export type PermissionMode =
    | "default"
    | "acceptEdits"
    | "plan"
    | "auto"
    | "bypassPermissions"
    | "dontAsk";

/** Session state */
export type SessionStatus =
    | "running"
    | "idle"
    | "waiting_for_input"
    | "paused"
    | "stopped"
    | "error";

/** Model options — shorthand for CLI --model flag */
export type ClaudeModel = "opus" | "sonnet" | "haiku";

/** Effort levels for /effort slash command */
export type EffortLevel = "low" | "medium" | "high";

/** Session configuration when spawning */
export interface SessionConfig {
    name?: string;
    cwd: string;
    model: ClaudeModel;
    permissionMode: PermissionMode;
    effort?: EffortLevel;
    tags?: string[];
}

/** Session metadata displayed on dashboard */
export interface SessionInfo {
    id: string;
    name: string;
    status: SessionStatus;
    cwd: string;
    model: ClaudeModel;
    permissionMode: PermissionMode;
    effort?: EffortLevel;
    tags: string[];
    createdAt: number;
    tokenCount?: number;
    cost?: number;
    contextUsage?: number;
}

/** Controller config file shape */
export interface ControllerConfig {
    workDir: string;
}

/** Directory listing response data */
export interface DirListData {
    path: string;
    dirs: string[];
}
