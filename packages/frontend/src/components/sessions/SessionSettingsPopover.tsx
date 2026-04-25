import type { ClaudeModel, EffortLevel, PermissionMode, SessionInfo } from "common/types";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { effortOptionsFor, MODEL_OPTIONS } from "./model-config";
import { OptionPills } from "./OptionPills";

interface SessionSettingsPopoverProps {
  session: SessionInfo;
  onSetModel: (model: ClaudeModel) => void;
  onSetEffort: (effort: EffortLevel) => void;
  /** Sends one Shift+Tab to Claude Code's PTY. */
  onCyclePermissionMode: () => void;
}

// Claude Code's standard Shift+Tab cycle. Modes outside this cycle (auto,
// dontAsk, bypassPermissions) are gated by feature flags / settings; we don't
// surface them as pills.
const PERMISSION_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan"];

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
];

const CYCLE_STEP_MS = 80;

function cycleDistance(from: PermissionMode, to: PermissionMode): number | null {
  const fromIdx = PERMISSION_CYCLE.indexOf(from);
  const toIdx = PERMISSION_CYCLE.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return null;
  return (toIdx - fromIdx + PERMISSION_CYCLE.length) % PERMISSION_CYCLE.length;
}

export function SessionSettingsPopover({
  session,
  onSetModel,
  onSetEffort,
  onCyclePermissionMode,
}: SessionSettingsPopoverProps) {
  // Selecting a target mode = sending N Shift+Tabs to walk the cycle.
  // Tiny delays between sends so the PTY can process each before the next.
  const handleSetMode = (target: PermissionMode) => {
    const dist = cycleDistance(session.permissionMode, target);
    if (dist === 0) return;
    if (dist === null) {
      // Current mode is outside the standard cycle (e.g. "auto"). Send one
      // cycle as a best-effort nudge — user can re-tap if needed.
      onCyclePermissionMode();
      return;
    }
    for (let i = 0; i < dist; i++) {
      setTimeout(onCyclePermissionMode, i * CYCLE_STEP_MS);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Session settings"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Settings2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={12}
        className="w-[min(28rem,calc(100vw-1.5rem))] border-border/60 bg-popover p-0"
      >
        <div className="flex flex-col gap-5 p-4">
          <OptionPills
            label="Model"
            value={session.model}
            options={MODEL_OPTIONS}
            onChange={onSetModel}
          />
          <OptionPills
            label="Effort"
            value={session.effort ?? "medium"}
            options={effortOptionsFor(session.model)}
            onChange={onSetEffort}
          />
          <OptionPills
            label="Permission mode"
            value={session.permissionMode}
            options={PERMISSION_OPTIONS}
            onChange={handleSetMode}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
