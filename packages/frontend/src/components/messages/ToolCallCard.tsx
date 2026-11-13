import type { ToolResult } from "common/types";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { fetchToolResult } from "@/services/tool-result.service";

interface ToolCallCardProps {
  sessionId?: string;
  toolUseId?: string;
  toolName: string;
  input: unknown;
  result?: ToolResult | null;
}

export function ToolCallCard({ sessionId, toolUseId, toolName, input, result }: ToolCallCardProps) {
  const status = result === undefined ? "running" : result?.isError ? "error" : "success";
  const dotClass =
    status === "running"
      ? "bg-accent animate-pulse"
      : status === "error"
        ? "bg-destructive"
        : "bg-success";
  const [full, setFull] = useState<ToolResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = () => {
    if (!result?.preview || full || loading || !sessionId || !toolUseId) return;
    setLoading(true);
    setFailure(null);
    void fetchToolResult(sessionId, toolUseId)
      .then((outcome) => {
        if (outcome.status === "available")
          setFull({ value: outcome.result, isError: outcome.isError });
        else
          setFailure(
            "Full result unavailable: the session or retained event is no longer available.",
          );
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : "Could not load result."),
      )
      .finally(() => setLoading(false));
  };
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
        <DetailsRow label="arguments" value={input} />
        {result && (
          <DetailsRow
            label={result.isError ? "error" : "result"}
            error={result.isError}
            value={full ? full.value : result.value}
            onOpen={() => {
              if (!failure) load();
            }}
          >
            {result.preview && !full && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                Truncated {result.preview.format} preview (
                {result.preview.totalBytes.toLocaleString()} bytes in full).
                {loading && " Loading full result…"}
                {failure && (
                  <>
                    <p role="alert">{failure}</p>
                    <button type="button" className="underline" onClick={load}>
                      Retry
                    </button>
                  </>
                )}
              </div>
            )}
          </DetailsRow>
        )}
      </div>
    </div>
  );
}

function DetailsRow({
  label,
  error,
  value,
  children,
  onOpen,
}: {
  label: string;
  error?: boolean;
  value: unknown;
  children?: ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group/details border-t border-border/40"
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open/details:rotate-90" />
        <span>{label}</span>
      </summary>
      {open && (
        <>
          {children}
          <FormattedValue value={value} error={error} />
        </>
      )}
    </details>
  );
}

function FormattedValue({ value, error }: { value: unknown; error?: boolean }) {
  const text = useMemo(() => formatValue(value), [value]);
  return (
    <pre
      className={cn(
        "overflow-x-auto border-t border-border/40 bg-muted/30 px-3 py-2 font-mono text-[12px] leading-relaxed",
        error ? "text-destructive" : "text-foreground/85",
      )}
    >
      {text}
    </pre>
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
