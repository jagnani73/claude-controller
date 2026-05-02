import type { SessionInfo } from "common/types";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type SessionSettings, SessionSettingsPanel } from "./SessionSettingsPanel";

interface SessionSettingsPopoverProps {
  session: SessionInfo;
  onChange: (next: SessionSettings) => void;
}

export function SessionSettingsPopover({ session, onChange }: SessionSettingsPopoverProps) {
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
        <div className="p-4">
          <SessionSettingsPanel
            value={{
              model: session.model,
              effort: session.effort ?? "auto",
              permissionMode: session.permissionMode,
            }}
            onChange={onChange}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
