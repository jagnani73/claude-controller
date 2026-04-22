interface ToolCallCardProps {
  toolName: string;
  input: unknown;
  result?: { value: unknown; isError: boolean } | null;
}

export function ToolCallCard({ toolName, input, result }: ToolCallCardProps) {
  return (
    <div className="px-4 py-2">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/50">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              result === undefined
                ? "animate-pulse bg-amber-400"
                : result?.isError
                  ? "bg-red-500"
                  : "bg-emerald-500"
            }`}
          />
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
            {toolName}
          </span>
          {result === undefined && (
            <span className="ml-auto text-xs text-neutral-600">running…</span>
          )}
        </div>
        <details className="group">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300">
            <span className="group-open:hidden">Show arguments</span>
            <span className="hidden group-open:inline">Hide arguments</span>
          </summary>
          <pre className="overflow-x-auto border-t border-neutral-800 px-3 py-2 text-xs text-neutral-300">
            {formatValue(input)}
          </pre>
        </details>
        {result && (
          <details className="group border-t border-neutral-800">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300">
              <span className="group-open:hidden">
                {result.isError ? "Show error" : "Show result"}
              </span>
              <span className="hidden group-open:inline">Hide result</span>
            </summary>
            <pre
              className={`overflow-x-auto border-t border-neutral-800 px-3 py-2 text-xs ${
                result.isError ? "text-red-400" : "text-neutral-300"
              }`}
            >
              {formatValue(result.value)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
