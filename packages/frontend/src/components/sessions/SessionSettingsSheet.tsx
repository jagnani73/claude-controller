import type { ClaudeModel, EffortLevel, SessionInfo } from "common/types";
import { PermissionModeBadge } from "@/components/layout/PermissionModeBadge";
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
    <>
      {/* backdrop */}
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="fixed inset-0 z-20 bg-black/40"
      />
      <div className="absolute inset-x-0 bottom-full z-30 border-t border-neutral-800 bg-neutral-950 px-4 pb-4 pt-3 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Session Settings
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-500 transition-colors active:text-neutral-300"
          >
            Close
          </button>
        </div>

        <div className="flex flex-col gap-3">
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
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-600">
              Permission Mode
            </span>
            <div>
              <PermissionModeBadge mode={session.permissionMode} onCycle={onCyclePermissionMode} />
              <span className="ml-2 text-[11px] text-neutral-600">Tap to cycle</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
