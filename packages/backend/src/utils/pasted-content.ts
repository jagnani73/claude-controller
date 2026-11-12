/**
 * Claude Code wraps multi-line pasted text in the transcript as
 *
 *   \n\n<pasted_content id="af54">\n…the text…\n</pasted_content id="af54">\n
 *
 * (observed on 2.1.322; the closing tag repeats the id). The controller sends
 * every phone message as a bracketed paste, so any multi-line message comes
 * back this way. Unwrapped once here so the chat title, the user bubble and
 * Up-arrow recall show what the user actually wrote.
 *
 * Text without a complete wrapper is returned unchanged.
 */
const PASTED_RE = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>/g;

export function unwrapPastedContent(text: string): string {
  if (!text.includes("<pasted_content")) return text;
  let found = false;
  const out = text.replace(PASTED_RE, (_all, _id: string, body: string) => {
    found = true;
    return body;
  });
  // The CLI pads the wrapper with blank lines; drop them, but only when a
  // wrapper was actually removed, so ordinary prompts keep their whitespace.
  return found ? out.trim() : text;
}
