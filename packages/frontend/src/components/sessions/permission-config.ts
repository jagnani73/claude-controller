import type { PermissionMode } from "common/types";

/**
 * Claude Code's Shift+Tab walks `default → acceptEdits → plan → auto → default`
 * when the auto-mode gate is enabled. `bypassPermissions` and `dontAsk` are
 * gated by env/feature flags and not surfaced here. See
 * `claude-code-source/src/utils/permissions/getNextPermissionMode.ts`.
 */
export const PERMISSION_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

/** Delay between cycle keystrokes so the PTY can process each before the next. */
export const PERMISSION_CYCLE_STEP_MS = 80;

export const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
];

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  auto: "Auto",
  dontAsk: "Don't Ask",
};

/** Tailwind border/bg/text classes per mode (resolved statically for JIT). */
export const PERMISSION_TONE: Record<PermissionMode, string> = {
  default: "border-border/60 text-muted-foreground",
  acceptEdits: "border-success/40 bg-success/15 text-success",
  plan: "border-accent/40 bg-accent/15 text-accent",
  auto: "border-warning/40 bg-warning/15 text-warning",
  dontAsk: "border-destructive/40 bg-destructive/15 text-destructive",
};
