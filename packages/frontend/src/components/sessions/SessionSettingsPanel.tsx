import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";
import { useModelOptions } from "@/hooks/use-model-options";
import {
  clampEffort,
  clampPermissionMode,
  effortOptionsFor,
  supportsLiveModeSwitch,
} from "./model-config";
import { OptionPills } from "./OptionPills";
import { permissionOptionsFor, UNVERIFIED_MODE_NOTE } from "./permission-config";

export interface SessionSettings {
  model: ClaudeModel;
  effort: EffortLevel;
  permissionMode: PermissionMode;
}

interface SessionSettingsPanelProps {
  value: SessionSettings;
  onChange: (next: SessionSettings) => void;
  /**
   * Editing a running session, whose mode changes walk the Shift+Tab cycle (vs.
   * the create form, where the mode is a spawn flag). Gates mode switching for
   * a model whose cycle is unverified.
   */
  live?: boolean;
  /**
   * The model the running PTY is on, when it differs from a pending pick in
   * `value.model`. A live mode change walks *its* Shift+Tab cycle, so it, not the
   * pick, decides whether mode switching is available and whether auto is a stop.
   */
  runningModel?: ClaudeModel;
}

/**
 * Single source of truth for the model/effort/permission-mode triplet UI.
 * Used by both the create-session form and the in-session settings popover so
 * gating and clamp-on-model-change behave identically in both places.
 *
 * Clamping fires only when the model changes — switching e.g. opus→haiku
 * downgrades effort (xhigh→max→high→auto path) and drops auto permission mode
 * back to default in a single onChange call so the consumer sees one atomic
 * tuple update instead of a sequence.
 */
export function SessionSettingsPanel({
  value,
  onChange,
  live = false,
  runningModel,
}: SessionSettingsPanelProps) {
  const modelOptions = useModelOptions(value.model);
  // Live mode changes act on the running process; the create form's mode is a
  // spawn flag for the picked model.
  const modeModel = live ? (runningModel ?? value.model) : value.model;
  const modeLocked = live && !supportsLiveModeSwitch(modeModel);
  const handleModel = (model: ClaudeModel) => {
    onChange({
      model,
      effort: clampEffort(model, value.effort),
      permissionMode: clampPermissionMode(model, value.permissionMode),
    });
  };
  const handleEffort = (effort: EffortLevel) => onChange({ ...value, effort });
  const handlePermissionMode = (permissionMode: PermissionMode) =>
    onChange({ ...value, permissionMode });

  return (
    <div className="flex flex-col gap-5">
      <OptionPills
        label="Model"
        value={value.model}
        options={modelOptions}
        onChange={handleModel}
      />
      <OptionPills
        label="Effort"
        value={value.effort}
        options={effortOptionsFor(value.model)}
        onChange={handleEffort}
      />
      <OptionPills
        label="Permission mode"
        value={value.permissionMode}
        options={permissionOptionsFor(modeModel, { live })}
        onChange={handlePermissionMode}
        note={modeLocked ? UNVERIFIED_MODE_NOTE : undefined}
      />
    </div>
  );
}
