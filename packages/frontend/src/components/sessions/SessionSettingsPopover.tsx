import type { ClaudeModel, EffortLevel, PermissionMode, SessionInfo } from "common/types";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { effortOptionsFor, MODEL_OPTIONS } from "./model-config";
import { OptionPills } from "./OptionPills";
import { PERMISSION_OPTIONS } from "./permission-config";

interface SessionSettingsPopoverProps {
  session: SessionInfo;
  onSetModel: (model: ClaudeModel) => void;
  onSetEffort: (effort: EffortLevel) => void;
  /** Walks Claude Code's Shift+Tab cycle to land on the target mode. */
  onSetPermissionMode: (mode: PermissionMode) => void;
}

export function SessionSettingsPopover({
  session,
  onSetModel,
  onSetEffort,
  onSetPermissionMode,
}: SessionSettingsPopoverProps) {
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
            value={session.effort ?? "auto"}
            options={effortOptionsFor(session.model)}
            onChange={onSetEffort}
          />
          <OptionPills
            label="Permission mode"
            value={session.permissionMode}
            options={PERMISSION_OPTIONS}
            onChange={onSetPermissionMode}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
