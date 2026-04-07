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
    | "disconnected";

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

/** Model options */
export type ClaudeModel = "opus" | "sonnet" | "haiku";

/** Session configuration when spawning */
export interface SessionConfig {
    name?: string;
    cwd: string;
    model: ClaudeModel;
    permissionMode: PermissionMode;
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
    tags: string[];
    createdAt: number;
    tokenCount?: number;
    cost?: number;
    contextUsage?: number;
}
