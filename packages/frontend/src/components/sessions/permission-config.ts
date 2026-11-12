import type { ClaudeModel, PermissionMode } from "common/types";
import { supportsAutoMode, supportsLiveModeSwitch } from "./model-config";

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
];

/** Shown under the mode control when the running session's mode can't be changed. */
export const UNVERIFIED_MODE_NOTE = "Mode switching isn't verified for this model yet.";

/**
 * Mode options for `model`. `live` is a running session, where a change walks
 * the Shift+Tab cycle: for a model whose cycle is unverified every option is
 * disabled (the backend refuses anyway). At create time the mode is a spawn flag,
 * so only `auto` is gated.
 */
export function permissionOptionsFor(
  model: ClaudeModel,
  opts: { live?: boolean } = {},
): { value: PermissionMode; label: string; hint?: string; disabled?: boolean }[] {
  if (opts.live && !supportsLiveModeSwitch(model)) {
    return PERMISSION_OPTIONS.map((opt) => ({ ...opt, disabled: true }));
  }
  const autoDisabled = !supportsAutoMode(model);
  const autoHint = model === "haiku" ? "not on haiku" : "not verified for this model";
  return PERMISSION_OPTIONS.map((opt) =>
    opt.value === "auto"
      ? { ...opt, disabled: autoDisabled, hint: autoDisabled ? autoHint : undefined }
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
