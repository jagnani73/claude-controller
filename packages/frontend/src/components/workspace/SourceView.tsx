import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const CODE_EXT =
  /\.(?:[cm]?[jt]sx?|json|css|scss|html|xml|md|py|sh|bash|ya?ml|toml|rs|go|java|c|cpp|h|cs|sql)$/i;
// Small lexical highlighter, not an editor or an HTML renderer. Unknown languages
// stay plain text. Tokens remain React text nodes, including HTML source.
const TOKEN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|#.*$|\b(?:import|export|from|const|let|var|function|return|if|else|for|while|class|interface|type|async|await|new|throw|try|catch|true|false|null|undefined|def|self|fn|pub|use|SELECT|FROM|WHERE)\b|\b\d+(?:\.\d+)?\b)/g;

function HighlightedLine({ text, path }: { text: string; path: string }) {
  if (!CODE_EXT.test(path) || text.length > 4000) return <>{text || " "}</>;
  const parts: React.ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    if (start > end) parts.push(text.slice(end, start));
    const token = match[0];
    const tone =
      token.startsWith("//") || token.startsWith("#")
        ? "text-muted-foreground"
        : /^["'`]/.test(token)
          ? "text-success"
          : /^\d/.test(token)
            ? "text-warning"
            : "text-accent";
    parts.push(
      <span key={start} className={tone}>
        {token}
      </span>,
    );
    end = start + token.length;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}

export function CopyPath({ path }: { path: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        if (!navigator.clipboard) {
          toast.error("Clipboard is unavailable");
          return;
        }
        void navigator.clipboard.writeText(path || ".").then(
          () => toast.success("Relative path copied"),
          () => toast.error("Clipboard is unavailable"),
        );
      }}
    >
      Copy path
    </Button>
  );
}

export function SourceView({
  text,
  path,
  lineOffset,
}: {
  text: string;
  path: string;
  lineOffset: number;
}) {
  const [wrap, setWrap] = useState(false);
  const lines = text
    .split("\n")
    .map((line, index) => ({ text: line, number: lineOffset + index + 1 }));
  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
        <span>
          {CODE_EXT.test(path) ? "Source · basic syntax highlighting" : "Plain text"} · read-only
        </span>
        <Button size="sm" variant="ghost" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          Wrap {wrap ? "on" : "off"}
        </Button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll source horizontally */}
      <section className="min-h-0 flex-1 overflow-auto" tabIndex={0} aria-label="File source">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {lines.map((line) => (
              <tr key={line.number}>
                <td className="w-12 select-none border-r border-border/40 px-2 text-right align-top text-muted-foreground/60">
                  {line.number}
                </td>
                <td
                  className={
                    wrap
                      ? "whitespace-pre-wrap break-all px-3 align-top"
                      : "whitespace-pre px-3 align-top"
                  }
                >
                  <HighlightedLine text={line.text} path={path} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
