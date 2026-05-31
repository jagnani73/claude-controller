// Pure parsing helpers for recovering an AskUserQuestion answer from its tool
// result. Extracted from QuestionCard so they can be unit-tested without
// rendering the component. Local state is lost on a page reload; the tool result
// is the only durable record of what was answered, so these reconstruct it.

/**
 * Pull the answer value for `question` out of the AskUserQuestion tool result.
 * Claude Code formats the result as `"<question>"="<answer>"[ selected preview:
 * …][ user notes: …], "<q2>"="<a2>"…` — so the answer is the text between
 * `"<question>"="` and the next `"`. Extracting the whole span (rather than
 * splitting on commas) keeps multi-select values and comma-bearing custom text
 * intact. Returns null when the result isn't a string or the marker is absent.
 */
export function extractAnswer(resultValue: unknown, question: string): string | null {
  const text = resultToText(resultValue);
  if (!text) return null;
  const marker = `"${question}"="`;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  const end = text.indexOf('"', from);
  if (end < 0) return null;
  return text.slice(from, end);
}

/** Coerce a tool_result value (string, or array of text/content blocks) to text. */
export function resultToText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const joined = v
      .map((b) =>
        typeof b === "string"
          ? b
          : b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
      )
      .join("");
    return joined || null;
  }
  return null;
}

/**
 * Whether a recovered answer string selected `label`. The result joins
 * multi-select labels with ", ", so test for the label as a delimited token
 * (start/end or comma-bounded) to avoid matching a label that's merely a
 * substring of a longer one or of free-text.
 */
export function answerIncludesLabel(answer: string, label: string): boolean {
  if (answer === label) return true;
  return answer.split(", ").includes(label);
}
