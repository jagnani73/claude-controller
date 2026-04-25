import type { RateLimitWindow, SessionInfo } from "common/types";
import { PanelLeftOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebarShell } from "@/lib/sidebar-shell-context";
import { cn } from "@/lib/utils";

interface SessionTopBarProps {
  session: SessionInfo;
}

function pctTone(pct: number): string {
  if (pct >= 85) return "border-destructive/40 bg-destructive/15 text-destructive";
  if (pct >= 60) return "border-warning/40 bg-warning/15 text-warning";
  return "border-success/40 bg-success/15 text-success";
}

function formatReset(epoch: number): string {
  const secs = Math.max(0, Math.round(epoch - Date.now() / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

// `dateStyle`/`timeStyle` cannot be combined with `timeZoneName` in some
// runtimes — they throw "Invalid option : option". Use field-level options.
const RESET_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function formatResetAbsolute(epoch: number): string {
  return RESET_FORMATTER.format(new Date(epoch * 1000));
}

function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function QuotaBadge({ label, window }: { label: string; window: RateLimitWindow }) {
  const pct = Math.round(window.usedPercentage);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn("font-mono text-xs uppercase tracking-wider tabular-nums", pctTone(pct))}
        >
          {label} {pct}%
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="space-y-0.5">
          <div>
            {label} window: {pct}% used
          </div>
          <div className="text-muted-foreground">
            Resets in {formatReset(window.resetsAt)} ({formatResetAbsolute(window.resetsAt)})
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function SessionTopBar({ session }: SessionTopBarProps) {
  const { collapsed, expand } = useSidebarShell();
  const { name: title, cwd, effort, statusSnapshot: status } = session;
  // Until Claude Code's first dump arrives, every session-detail badge is
  // unreliable (model alias is wrong on resume, effort can be overridden).
  // Show the title alone until we have ground truth.
  const ready = !!status;
  const ctxPct = status?.contextUsedPercentage;
  const inTokens = status?.totalInputTokens;
  const outTokens = status?.totalOutputTokens;

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-background/60 px-3 py-2 backdrop-blur">
      {collapsed && (
        <button
          type="button"
          onClick={expand}
          aria-label="Show sidebar"
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-card hover:text-foreground"
        >
          <PanelLeftOpen className="size-4" strokeWidth={1.75} />
        </button>
      )}

      <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="truncate font-serif text-lg leading-tight text-foreground">{title}</h1>
          {ready && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {status.modelDisplayName && (
                <Badge variant="secondary" className="font-mono text-xs tracking-wider">
                  {status.modelDisplayName}
                </Badge>
              )}
              {effort && (
                <Badge
                  variant="outline"
                  className="border-border/60 font-mono text-xs uppercase tracking-wider text-muted-foreground"
                >
                  {effort}
                </Badge>
              )}
            </div>
          )}
        </div>

        {cwd && (
          <div className="flex min-w-0 max-w-[60%] flex-col items-end gap-2">
            <div className="truncate font-mono text-[11px] text-muted-foreground/60" dir="rtl">
              {cwd}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
              {ctxPct !== undefined && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 font-mono tracking-wider tabular-nums",
                        pctTone(Math.round(ctxPct)),
                      )}
                    >
                      ctx {Math.round(ctxPct)}%
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <div className="space-y-0.5">
                      <div>Context window: {Math.round(ctxPct)}% used</div>
                      {inTokens !== undefined && outTokens !== undefined && (
                        <div className="text-muted-foreground">
                          ↑ {formatTokens(inTokens)} in · ↓ {formatTokens(outTokens)} out
                        </div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              {status?.fiveHour && <QuotaBadge label="5h" window={status.fiveHour} />}
              {status?.sevenDay && <QuotaBadge label="wk" window={status.sevenDay} />}
              {status?.costUsd !== undefined && status.costUsd > 0 && (
                <span className="rounded-md border border-border/60 bg-card px-1.5 py-0.5 font-mono tabular-nums text-success">
                  ${status.costUsd.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
