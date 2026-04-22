import Anser, { type AnserJsonEntry } from "anser";
import { useMemo } from "react";

interface StatusLineProps {
  /** Raw ANSI text from the user's statusline command. */
  text: string;
}

/**
 * Renders the user's statusline output with ANSI colours preserved.
 * `anser` handles SGR parsing (basic + 256 + truecolour); we map its output
 * to inline styles so whatever the script emits shows up faithfully.
 */
export function StatusLine({ text }: StatusLineProps) {
  const parts = useMemo(
    () =>
      Anser.ansiToJson(text, {
        remove_empty: true,
        use_classes: false,
        json: true,
      }),
    [text],
  );

  if (!text.trim()) return null;

  return (
    <div className="shrink-0 overflow-x-auto whitespace-pre border-t border-neutral-900 bg-neutral-950 px-3 py-1.5 font-mono text-xs leading-tight text-neutral-400">
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ANSI parts have no stable id
        <span key={i} style={styleFor(part)}>
          {part.content}
        </span>
      ))}
    </div>
  );
}

function styleFor(part: AnserJsonEntry): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (part.fg) style.color = cssColor(part.fg);
  if (part.bg) style.background = cssColor(part.bg);
  if (part.decorations && part.decorations.length > 0) {
    if (part.decorations.includes("bold")) style.fontWeight = 600;
    if (part.decorations.includes("italic")) style.fontStyle = "italic";
    if (part.decorations.includes("underline")) style.textDecoration = "underline";
    if (part.decorations.includes("dim")) style.opacity = 0.7;
    if (part.decorations.includes("strikethrough")) {
      style.textDecoration = style.textDecoration ? "underline line-through" : "line-through";
    }
  }
  return style;
}

/**
 * Anser gives us `"rrr, ggg, bbb"` for colours it recognises. Wrap into rgb().
 * Named colours / truecolour fall through as raw values, which browsers accept.
 */
function cssColor(value: string): string {
  if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(value)) return `rgb(${value})`;
  return value;
}
