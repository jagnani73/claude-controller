/**
 * Parsing for the `<teammate-message>` envelope Claude Code wraps around
 * anything one agent (or the lead) sends another:
 *
 *   <teammate-message teammate_id="team-lead" color="blue" summary="Brief">body</teammate-message>
 *
 * It lands in the receiving agent's transcript as an ordinary user turn, so
 * without this it renders as a raw tagged blob in a "you said" bubble. The
 * envelope was captured live on 2.1.322. The rules around it (several envelopes
 * can share one block; plumbing notices are hidden) follow the CLI's own
 * renderer as it appears in the frozen v2.1.87 source snapshot, so a newer CLI
 * may add shapes this treats generically.
 *
 * Pure on purpose: nothing here touches React.
 */

export type TeammateBody =
  /** Plain text from the sender. */
  | { kind: "text"; text: string }
  /** A protocol message the CLI renders specially (shutdown, task done, ...). */
  | { kind: "notice"; label: string; detail?: string; tone: "info" | "success" | "warning" }
  /** Structured JSON we do not recognise; shown as-is rather than dropped. */
  | { kind: "json"; label: string; json: string };

export interface TeammateMessage {
  from: string;
  color?: string;
  summary?: string;
  body: TeammateBody;
}

export interface ParsedTeammateText {
  messages: TeammateMessage[];
  /** Text outside any envelope, trimmed. Normally empty. */
  rest: string;
}

// Attributes are parsed out of the opening tag rather than matched positionally,
// so a reordered or extra attribute cannot silently turn a message into plain
// text. Values are quoted, so a `>` inside a summary does not end the tag.
const ENVELOPE_RE =
  /<teammate-message((?:\s+[\w-]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/teammate-message>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

/** Protocol types that are plumbing between agents and never worth showing. */
const HIDDEN_TYPES: ReadonlySet<string> = new Set([
  "idle_notification",
  "teammate_terminated",
  "shutdown_approved",
]);

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) attrs[m[1]] = m[2];
  return attrs;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Turn a message body into what to show; null means hide it entirely. */
export function classifyBody(content: string): TeammateBody | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return { kind: "text", text: trimmed };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "text", text: trimmed };
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { kind: "text", text: trimmed };
  }

  const type = parsed.type;
  if (HIDDEN_TYPES.has(type)) return null;

  switch (type) {
    case "shutdown_request":
      return {
        kind: "notice",
        label: "Shutdown requested",
        detail: str(parsed.reason),
        tone: "warning",
      };
    case "shutdown_rejected":
      return {
        kind: "notice",
        label: "Declined to shut down",
        detail: str(parsed.reason),
        tone: "warning",
      };
    case "task_completed": {
      const id = str(parsed.taskId);
      const subject = str(parsed.taskSubject);
      return {
        kind: "notice",
        label: id ? `Completed task #${id}` : "Completed a task",
        detail: subject,
        tone: "success",
      };
    }
    default: {
      // A message the sender wrapped in JSON: show its words when it has any.
      const words = str(parsed.message) ?? str(parsed.text) ?? str(parsed.reason);
      if (words) {
        return { kind: "notice", label: type.replaceAll("_", " "), detail: words, tone: "info" };
      }
      return {
        kind: "json",
        label: type.replaceAll("_", " "),
        json: JSON.stringify(parsed, null, 2),
      };
    }
  }
}

// The lead's transcript wraps a batch of envelopes in scaffolding the CLI writes
// for the model, not for people: a one-line intro before them and a standing
// notice after ("This came from another Claude session ... permission
// laundering."). Both are dropped; anything else around the envelopes is kept.
const PEER_INTRO_RE = /^\s*Another Claude session sent a message:[ \t]*/;
const PEER_NOTICE_RE = /\s*This came from another Claude session[\s\S]*$/;

/**
 * Pull every teammate envelope out of a user turn. Returns null when the text
 * has none, so the caller renders it as an ordinary message.
 *
 * Hidden envelopes (idle notices and the like) leave nothing behind: the
 * blank lines that separated them are collapsed, so a turn made only of those
 * has an empty `rest` and the caller draws nothing.
 */
export function parseTeammateText(text: string): ParsedTeammateText | null {
  if (!text.includes("<teammate-message")) return null;

  const messages: TeammateMessage[] = [];
  let found = false;
  const stripped = text.replace(ENVELOPE_RE, (_all, rawAttrs: string, content: string) => {
    found = true;
    const attrs = parseAttrs(rawAttrs);
    const body = classifyBody(content);
    if (body) {
      messages.push({
        from: attrs.teammate_id ?? "unknown",
        color: attrs.color,
        summary: attrs.summary,
        body,
      });
    }
    return "";
  });
  if (!found) return null;

  const rest = stripped
    .replace(PEER_INTRO_RE, "")
    .replace(PEER_NOTICE_RE, "")
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n\n")
    .trim();

  return { messages, rest };
}
