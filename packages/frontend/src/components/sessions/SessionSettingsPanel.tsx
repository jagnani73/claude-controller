import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";
import { clampEffort, clampPermissionMode, effortOptionsFor, MODEL_OPTIONS } from "./model-config";
import { OptionPills } from "./OptionPills";
import { permissionOptionsFor } from "./permission-config";

export interface SessionSettings {
  model: ClaudeModel;
  effort: EffortLevel;
  permissionMode: PermissionMode;
}

interface SessionSettingsPanelProps {
  value: SessionSettings;
  onChange: (next: SessionSettings) => void;
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
export function SessionSettingsPanel({ value, onChange }: SessionSettingsPanelProps) {
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
        options={MODEL_OPTIONS}
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
        options={permissionOptionsFor(value.model)}
        onChange={handlePermissionMode}
      />
    </div>
  );
}
