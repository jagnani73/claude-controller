import type { PermissionMode } from "common/types";

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

// Tailwind classes can't be constructed dynamically, so precompute.
const MODE_STYLE: Record<PermissionMode, string> = {
  default: "bg-neutral-800 text-neutral-300 ring-neutral-700",
  acceptEdits: "bg-sky-900/60 text-sky-200 ring-sky-800",
  plan: "bg-amber-900/60 text-amber-200 ring-amber-800",
  auto: "bg-violet-900/60 text-violet-200 ring-violet-800",
  dontAsk: "bg-neutral-800 text-neutral-400 ring-neutral-700",
};

export function PermissionModeBadge({ mode, onCycle }: PermissionModeBadgeProps) {
  const label = MODE_LABEL[mode] ?? mode;
  const style = MODE_STYLE[mode] ?? MODE_STYLE.default;

  return (
    <button
      type="button"
      onClick={onCycle}
      disabled={!onCycle}
      className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 transition-opacity active:opacity-70 ${style}`}
      title={onCycle ? "Tap to cycle (Shift+Tab)" : undefined}
    >
      {label}
    </button>
  );
}
