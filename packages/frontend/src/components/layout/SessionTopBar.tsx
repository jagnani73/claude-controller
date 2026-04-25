import type {
  ClaudeModel,
  EffortLevel,
  RateLimitWindow,
  SessionStatusSnapshot,
} from "common/types";
import { PanelLeftOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebarShell } from "@/lib/sidebar-shell-context";
import { cn } from "@/lib/utils";

interface SessionTopBarProps {
  title: string;
  cwd?: string;
  model?: ClaudeModel;
  /** Real Anthropic model id from transcript — preferred over alias when present. */
  currentModelId?: string;
  effort?: EffortLevel;
  status?: SessionStatusSnapshot;
}

const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)-(\d+)$/;

/** Map "claude-opus-4-7" → "Opus 4.7" with graceful fallback. */
function modelIdLabel(id: string): string {
  const m = id.match(MODEL_ID_PATTERN);
  if (!m) return id;
  const [, family, major, minor] = m;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return `${name} ${major}.${minor}`;
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

// Field-by-field options — `dateStyle`/`timeStyle` can't legally combine with
// `timeZoneName` in some runtimes and throws "Invalid option : option".
const RESET_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  // "short" gives the IANA short name when available (e.g. "PST", "IST").
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

export function SessionTopBar({
  title,
  cwd,
  model,
  currentModelId,
  effort,
  status,
}: SessionTopBarProps) {
  // Only show a model label when we have data observed from the live session
  // (Claude Code's own display name, or the model id from the latest assistant
  // turn). The create-time alias is unreliable on resumes, so we'd rather show
  // nothing than mislead — empty space fills as soon as the first dump or
  // assistant turn arrives.
  const isOneM = model === "opus[1m]" || model === "sonnet[1m]";
  const synthesizedFromId = currentModelId ? modelIdLabel(currentModelId) : null;
  const synthesizedDecorated =
    synthesizedFromId && isOneM ? `${synthesizedFromId} · 1M` : synthesizedFromId;
  const modelLabel = status?.modelDisplayName ?? synthesizedDecorated;

  const { collapsed, expand } = useSidebarShell();

  const ctxPct = status?.contextUsedPercentage;
  const inTokens = status?.totalInputTokens;
  const outTokens = status?.totalOutputTokens;

  // Until Claude Code's first dump arrives, we don't trust any of the
  // session-detail badges (model alias is wrong on resume, effort/permission
  // can be overridden by the loaded session). Show only the title until then.
  const ready = !!status;

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

      <div className="flex justify-between min-w-0 items-center flex-1 space-y-1">
        <div className="flex flex-col gap-2 w-full">
          <h1 className="truncate font-serif text-lg leading-tight text-foreground">{title}</h1>

          {ready && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {modelLabel && (
                <Badge variant="secondary" className="font-mono text-xs tracking-wider">
                  {modelLabel}
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
          <div className="flex flex-col justify-end gap-2 w-full">
            <div className="truncate font-mono text-[11px] text-muted-foreground/60" dir="rtl">
              {cwd}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 w-full text-xs text-muted-foreground">
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
