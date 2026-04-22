import type { ClaudeModel, EffortLevel, PermissionMode, SessionConfig } from "common/types";
import { useState } from "react";
import { OptionPills } from "./OptionPills";

const MODEL_OPTIONS: { value: ClaudeModel; label: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
];

function effortOptions(
  model: ClaudeModel,
): { value: EffortLevel; label: string; hint?: string; disabled?: boolean }[] {
  return [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    {
      value: "xhigh",
      label: "Extreme",
      hint: "opus only",
      disabled: model !== "opus",
    },
  ];
}

interface CreateSessionFormProps {
  cwd: string;
  onSubmit: (config: SessionConfig) => void;
}

export function CreateSessionForm({ cwd, onSubmit }: CreateSessionFormProps) {
  const [model, setModel] = useState<ClaudeModel>("sonnet");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [effort, setEffort] = useState<EffortLevel>("high");
  const [name, setName] = useState("");

  const handleModelChange = (next: ClaudeModel) => {
    setModel(next);
    if (next !== "opus" && effort === "xhigh") setEffort("high");
  };

  const handleSubmit = () => {
    onSubmit({
      cwd,
      model,
      permissionMode,
      effort,
      name: name.trim() || undefined,
    });
    setName("");
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <input
        type="text"
        placeholder="Session name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
      />

      <OptionPills
        label="Model"
        value={model}
        options={MODEL_OPTIONS}
        onChange={handleModelChange}
      />
      <OptionPills
        label="Permission Mode"
        value={permissionMode}
        options={PERMISSION_OPTIONS}
        onChange={setPermissionMode}
      />
      <OptionPills
        label="Effort"
        value={effort}
        options={effortOptions(model)}
        onChange={setEffort}
      />

      <button
        type="button"
        onClick={handleSubmit}
        className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-950 transition-opacity active:opacity-80"
      >
        Create Session
      </button>
    </div>
  );
}
