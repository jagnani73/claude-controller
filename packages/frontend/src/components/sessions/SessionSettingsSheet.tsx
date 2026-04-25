import type { ClaudeModel, EffortLevel, SessionInfo } from "common/types";
import { PermissionModeBadge } from "@/components/layout/PermissionModeBadge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { effortOptionsFor, MODEL_OPTIONS } from "./model-config";
import { OptionPills } from "./OptionPills";

interface SessionSettingsSheetProps {
  session: SessionInfo;
  onClose: () => void;
  onSetModel: (model: ClaudeModel) => void;
  onSetEffort: (effort: EffortLevel) => void;
  onCyclePermissionMode: () => void;
}

export function SessionSettingsSheet({
  session,
  onClose,
  onSetModel,
  onSetEffort,
  onCyclePermissionMode,
}: SessionSettingsSheetProps) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="rounded-t-2xl border-border/60 bg-card">
        <SheetHeader className="border-b border-border/40">
          <SheetTitle className="font-serif text-lg">Session settings</SheetTitle>
          <SheetDescription className="font-mono text-xs text-muted-foreground/70">
            {session.cwd}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6 pt-2">
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
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              Permission mode
            </span>
            <div className="flex items-center gap-2">
              <PermissionModeBadge mode={session.permissionMode} onCycle={onCyclePermissionMode} />
              <span className="text-xs text-muted-foreground/60">Tap to cycle</span>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
