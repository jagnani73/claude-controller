import type { ClaudeModel, EffortLevel, PermissionMode, SessionConfig } from "common/types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { clampEffort, effortOptionsFor, MODEL_OPTIONS } from "./model-config";
import { OptionPills } from "./OptionPills";

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
];

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
    setEffort((prev) => clampEffort(next, prev));
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
    <Card className="gap-5 border-border/60 bg-card/60 p-6 backdrop-blur-sm">
      <div className="space-y-1">
        <div className="font-mono text-xs text-muted-foreground/70" dir="rtl">
          {cwd}
        </div>
      </div>

      <Input
        type="text"
        placeholder="Session name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <OptionPills
        label="Model"
        value={model}
        options={MODEL_OPTIONS}
        onChange={handleModelChange}
      />
      <OptionPills
        label="Permission mode"
        value={permissionMode}
        options={PERMISSION_OPTIONS}
        onChange={setPermissionMode}
      />
      <OptionPills
        label="Effort"
        value={effort}
        options={effortOptionsFor(model)}
        onChange={setEffort}
      />

      <Button onClick={handleSubmit} className="mt-1 h-10 text-base">
        Create session
      </Button>
    </Card>
  );
}
