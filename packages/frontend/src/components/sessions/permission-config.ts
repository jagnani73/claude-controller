import type { ClaudeModel, PermissionMode } from "common/types";
import { supportsAutoMode } from "./model-config";

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
];

export function permissionOptionsFor(
  model: ClaudeModel,
): { value: PermissionMode; label: string; hint?: string; disabled?: boolean }[] {
  const autoDisabled = !supportsAutoMode(model);
  return PERMISSION_OPTIONS.map((opt) =>
    opt.value === "auto"
      ? { ...opt, disabled: autoDisabled, hint: autoDisabled ? "not on haiku" : undefined }
      : opt,
  );
}

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  auto: "Auto",
};

/** Tailwind border/bg/text classes per mode (resolved statically for JIT). */
export const PERMISSION_TONE: Record<PermissionMode, string> = {
  default: "border-border/60 text-muted-foreground",
  acceptEdits: "border-success/40 bg-success/15 text-success",
  plan: "border-accent/40 bg-accent/15 text-accent",
  auto: "border-warning/40 bg-warning/15 text-warning",
};
