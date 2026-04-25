import type { PermissionMode } from "common/types";
import { cn } from "@/lib/utils";

interface PermissionModeBadgeProps {
  mode: PermissionMode;
  onCycle?: () => void;
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "default",
  acceptEdits: "accept edits",
  plan: "plan",
  auto: "auto",
  dontAsk: "don't ask",
};

// Pre-mapped variant classes (Tailwind can't compose `bg-${mode}` at build time).
const MODE_STYLE: Record<PermissionMode, string> = {
  default: "border-border/60 bg-card text-muted-foreground",
  acceptEdits: "border-success/40 bg-success/10 text-success",
  plan: "border-accent/40 bg-accent/10 text-accent",
  auto: "border-warning/40 bg-warning/10 text-warning",
  dontAsk: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function PermissionModeBadge({ mode, onCycle }: PermissionModeBadgeProps) {
  const label = MODE_LABEL[mode] ?? mode;
  const style = MODE_STYLE[mode] ?? MODE_STYLE.default;

  return (
    <button
      type="button"
      onClick={onCycle}
      disabled={!onCycle}
      className={cn(
        "shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider transition-opacity disabled:cursor-default",
        "enabled:hover:opacity-80 enabled:active:opacity-70",
        style,
      )}
      title={onCycle ? "Tap to cycle (Shift+Tab)" : undefined}
    >
      {label}
    </button>
  );
}
