import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  text: string;
  /** Muted variant tones down body colour (for user messages). */
  variant?: "default" | "muted";
}

const components: Components = {
  p: ({ children }) => (
    <p className="mb-3 whitespace-pre-wrap break-words leading-relaxed last:mb-0">{children}</p>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic text-foreground/90">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0 marker:text-muted-foreground/50">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0 marker:text-muted-foreground/50">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 font-serif text-2xl text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 font-serif text-xl text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 font-serif text-lg text-foreground first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-base font-semibold text-foreground first:mt-0">{children}</h4>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-accent/50 pl-4 italic text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border/60" />,
  code: ({ className, children, ...props }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code className={cn(className, "font-mono text-[12.5px] leading-relaxed")} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12.5px] text-accent" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3 text-foreground last:mb-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto rounded-md border border-border/60 last:mb-0">
      <table className="min-w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border/60 bg-muted/30">{children}</thead>
  ),
  th: ({ children }) => <th className="px-3 py-1.5 font-semibold text-foreground">{children}</th>,
  td: ({ children }) => (
    <td className="border-t border-border/40 px-3 py-1.5 text-muted-foreground">{children}</td>
  ),
  input: ({ type, checked, disabled }) =>
    type === "checkbox" ? (
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        readOnly
        className="mr-1.5 translate-y-[1px] accent-accent"
      />
    ) : null,
};

export function Markdown({ text, variant = "default" }: MarkdownProps) {
  return (
    <div
      className={cn(
        "text-base leading-relaxed",
        variant === "muted" ? "text-foreground/90" : "text-foreground",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
