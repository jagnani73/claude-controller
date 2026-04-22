/**
 * JSONL transcript entry types. Only the entries we actually consume are typed;
 * everything else falls through the default branch in `transcript.service.ts`.
 *
 * Verified against real v2.1.117 transcripts at ~/.claude/projects/<cwd>/<sid>.jsonl.
 * Format is not publicly documented — tolerate unknown fields.
 */

interface BaseEntry {
  uuid: string;
  timestamp: string;
  sessionId: string;
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
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason: string | null;
    usage?: AssistantUsage;
  };
}

export type TranscriptEntry = UserEntry | AssistantEntry | { type: string };
