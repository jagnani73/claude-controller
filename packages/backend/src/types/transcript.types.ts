/**
 * JSONL transcript entry types. Only the entries we actually consume are typed;
 * everything else falls through the default branch in `transcript.service.ts`.
 *
 * Verified against real transcripts at ~/.claude/projects/<cwd>/<sid>.jsonl. The
 * format is not publicly documented and tracks whatever CLI build wrote it —
 * see `CLAUDE_CODE_TARGET_VERSION` (common/version) for the build these shapes
 * are verified against. Tolerate unknown fields.
 */

interface BaseEntry {
  uuid: string;
  timestamp: string;
  sessionId: string;
  /**
   * Claude Code's own version, stamped on every user/assistant/system/attachment
   * entry. This is the authoritative record of which CLI build is driving the
   * session — the controller spawns `claude` off PATH, so the binary that
   * actually ran is not knowable up front.
   */
  version?: string;
}

// ─── Content blocks (Anthropic Messages API shape) ─────────────────

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// ─── Entry types ──────────────────────────────────────────────────

export interface UserEntry extends BaseEntry {
  type: "user";
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
}

export interface AssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AssistantEntry extends BaseEntry {
  type: "assistant";
  /**
   * Reasoning effort the turn actually ran at, recorded on every assistant
   * message since v2.1.212. This is the *resolved* level, so a session
   * configured `auto` reports a concrete level here, not "auto". Typed as a
   * plain string because Claude Code accepts levels we don't model.
   */
  effort?: string;
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason: string | null;
    usage?: AssistantUsage;
  };
}

/**
 * Local-command entries appear as `system / subtype: "local_command"` for
 * UI-only commands (e.g. `/rename`) and as `user` entries with content
 * `<command-name>/X</command-name>...` for commands that affect the
 * conversation context (e.g. `/effort`).
 */
export interface SystemEntry extends BaseEntry {
  type: "system";
  subtype?: string;
  content?: string;
  level?: string;
}

export type TranscriptEntry = UserEntry | AssistantEntry | SystemEntry | { type: string };
