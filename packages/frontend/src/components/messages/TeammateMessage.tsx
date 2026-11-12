import { AtSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { type TeammateMessage as ParsedMessage, summaryAddsInfo } from "./teammate-message";

// Claude Code assigns each teammate a colour name; map it to fixed utility
// classes (Tailwind only keeps classes it can see written out in full).
const COLOR_TEXT: Record<string, string> = {
  red: "text-red-400",
  blue: "text-sky-400",
  green: "text-emerald-400",
  yellow: "text-amber-400",
  purple: "text-violet-400",
  orange: "text-orange-400",
  pink: "text-pink-400",
  cyan: "text-cyan-400",
};

const NOTICE_TONE = {
  info: "border-border/60 bg-card/50",
  success: "border-success/40 bg-success/[0.05]",
  warning: "border-warning/40 bg-warning/[0.05]",
} as const;

interface TeammateMessageProps {
  message: ParsedMessage;
  timestamp: string;
}

/**
 * A message another agent (or the lead) sent to the one being viewed. Drawn on
 * the left, like the assistant, because it is not something the viewer typed.
 */
export function TeammateMessage({ message, timestamp }: TeammateMessageProps) {
  const { from, color, summary, body } = message;
  const nameColor = (color && COLOR_TEXT[color]) || "text-accent";

  return (
    <div className="px-4 py-2">
      <div
        className={cn(
          "max-w-[92%] rounded-2xl rounded-tl-md border px-4 py-2.5",
          body.kind === "notice" ? NOTICE_TONE[body.tone] : "border-border/60 bg-card/50",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className={cn("inline-flex items-center gap-1 font-mono font-medium", nameColor)}>
            <AtSign className="size-3" strokeWidth={2} />
            {from}
          </span>
          {summary && (body.kind !== "text" || summaryAddsInfo(summary, body.text)) && (
            <span className="text-muted-foreground">{summary}</span>
          )}
        </div>

        {body.kind === "text" && (
          <div className="mt-1.5 whitespace-pre-wrap wrap-break-word text-base leading-relaxed text-foreground/95">
            {body.text}
          </div>
        )}
        {body.kind === "notice" && (
          <div className="mt-1.5 text-sm">
            <span className="font-medium text-foreground/90">{body.label}</span>
            {body.detail && (
              <span className="whitespace-pre-wrap text-muted-foreground"> · {body.detail}</span>
            )}
          </div>
        )}
        {body.kind === "json" && (
          <div className="mt-1.5">
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {body.label}
            </div>
            <pre className="overflow-x-auto rounded-md bg-muted/30 px-2 py-1.5 font-mono text-[12px] text-foreground/85">
              {body.json}
            </pre>
          </div>
        )}

        <div className="mt-1 text-[11px] text-muted-foreground/50">{formatTime(timestamp)}</div>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
