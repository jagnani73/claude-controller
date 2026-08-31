/** How Claude Code will interpret a message, decided by its first character. */
export type InputPrefixMode = "shell" | "command";

/**
 * Detect a prefix that changes how the CLI reads the message.
 *
 * Verified live against the target build: the controller sends every message as
 * a bracketed paste, and **pasting is not exempt from prefix handling**. Pasting
 * `!echo hi` renders `! echo hi` with a `! for shell mode` footer, so on submit
 * it runs as a shell command instead of reaching Claude. Pasting `/model` opens
 * the slash-command palette. A `!` or `/` anywhere but the first character is
 * inert — `run !echo hi` stays plain text.
 *
 * This exists to close an asymmetry, not to block anything. At the keyboard the
 * TUI footer tells you shell mode engaged; on the phone nothing did, so a
 * message meant as prose could silently execute. We warn rather than escape:
 * escaping would corrupt legitimate text, and stripping the prefix would remove
 * a real CLI feature.
 *
 * Deliberately reads position 0 of the raw string with no trimming, because
 * that is what was verified. A leading space almost certainly defeats the CLI's
 * own check too, but that case was not tested, and warning on it would be
 * guessing.
 */
export function inputPrefixMode(text: string): InputPrefixMode | null {
  switch (text.charAt(0)) {
    case "!":
      return "shell";
    case "/":
      return "command";
    default:
      return null;
  }
}

/** One-line explanation of what the prefix will do, for the composer hint. */
export function inputPrefixHint(mode: InputPrefixMode): string {
  return mode === "shell"
    ? "Runs as a shell command — Claude won't see this"
    : "Runs as a slash command";
}
