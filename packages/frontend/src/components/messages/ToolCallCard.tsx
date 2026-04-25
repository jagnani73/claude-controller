import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToolCallCardProps {
  toolName: string;
  input: unknown;
  result?: { value: unknown; isError: boolean } | null;
}

export function ToolCallCard({ toolName, input, result }: ToolCallCardProps) {
  const status = result === undefined ? "running" : result?.isError ? "error" : "success";
  const dotClass =
    status === "running"
      ? "bg-accent animate-pulse"
      : status === "error"
        ? "bg-destructive"
        : "bg-success";

  return (
    <div className="px-4 py-2">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/60 transition-colors hover:bg-card/80">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className={cn("inline-block size-1.5 shrink-0 rounded-full", dotClass)} />
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            {toolName}
          </span>
          {status === "running" && (
            <span className="ml-auto text-[11px] text-accent/80">running…</span>
          )}
        </div>
        <DetailsRow label="arguments">{formatValue(input)}</DetailsRow>
        {result && (
          <DetailsRow label={result.isError ? "error" : "result"} error={result.isError}>
            {formatValue(result.value)}
          </DetailsRow>
        )}
      </div>
    </div>
  );
}

function DetailsRow({
  label,
  error,
  children,
}: {
  label: string;
  error?: boolean;
  children: string;
}) {
  return (
    <details className="group/details border-t border-border/40">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open/details:rotate-90" />
        <span>{label}</span>
      </summary>
      <pre
        className={cn(
          "overflow-x-auto border-t border-border/40 bg-muted/30 px-3 py-2 font-mono text-[12px] leading-relaxed",
          error ? "text-destructive" : "text-foreground/85",
        )}
      >
        {children}
      </pre>
    </details>
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
