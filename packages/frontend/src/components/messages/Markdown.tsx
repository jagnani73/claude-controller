import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  text: string;
  /** Light variant uses muted body colour (for user messages); default is full-contrast (assistant). */
  variant?: "default" | "muted";
}

const components: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0 whitespace-pre-wrap break-words">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-sky-400 underline decoration-sky-400/40 underline-offset-2 hover:decoration-sky-400"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-neutral-50">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-neutral-500 line-through">{children}</del>,
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0 marker:text-neutral-600">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0 marker:text-neutral-600">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mt-2 mb-2 text-lg font-semibold text-neutral-50">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-2 text-base font-semibold text-neutral-50">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2 mb-1.5 text-sm font-semibold text-neutral-50">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-sm font-semibold text-neutral-200">{children}</h4>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-neutral-700 pl-3 text-neutral-400 italic last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-neutral-800" />,
  code: ({ className, children, ...props }) => {
    const isBlock =
      // react-markdown sets `language-*` class on fenced blocks.
      typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code className={`${className} font-mono text-xs leading-relaxed`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-neutral-800/70 px-1 py-0.5 font-mono text-[0.8125rem] text-neutral-200"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900 p-3 text-neutral-100 last:mb-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="min-w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-neutral-800">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1.5 font-semibold text-neutral-200">{children}</th>,
  td: ({ children }) => (
    <td className="border-t border-neutral-800/60 px-2 py-1.5 text-neutral-300">{children}</td>
  ),
  input: ({ type, checked, disabled }) =>
    // GFM task-list checkboxes only.
    type === "checkbox" ? (
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        readOnly
        className="mr-1.5 translate-y-[1px] accent-emerald-500"
      />
    ) : null,
};

export function Markdown({ text, variant = "default" }: MarkdownProps) {
  const tone = variant === "muted" ? "text-neutral-300" : "text-neutral-100";
  return (
    <div className={`text-sm leading-relaxed ${tone}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
