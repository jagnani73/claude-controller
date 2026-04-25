import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";
import { PanelLeftOpen } from "lucide-react";
import { PermissionModeBadge } from "@/components/layout/PermissionModeBadge";
import { Badge } from "@/components/ui/badge";
import { useSidebarShell } from "@/lib/sidebar-shell-context";

interface SessionTopBarProps {
  title: string;
  cwd?: string;
  model?: ClaudeModel;
  /** Real Anthropic model id from transcript — preferred over alias when present. */
  currentModelId?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
}

const ALIAS_LABEL: Record<ClaudeModel, string> = {
  opus: "Opus",
  "opus[1m]": "Opus · 1M",
  opusplan: "Opus Plan",
  sonnet: "Sonnet",
  "sonnet[1m]": "Sonnet · 1M",
  haiku: "Haiku",
};

const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)-(\d+)$/;

/** Map "claude-opus-4-7" → "Opus 4.7" with graceful fallback. */
function modelIdLabel(id: string): string {
  const m = id.match(MODEL_ID_PATTERN);
  if (!m) return id;
  const [, family, major, minor] = m;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return `${name} ${major}.${minor}`;
}

export function SessionTopBar({
  title,
  cwd,
  model,
  currentModelId,
  permissionMode,
  effort,
}: SessionTopBarProps) {
  const modelLabel = currentModelId
    ? modelIdLabel(currentModelId)
    : model
      ? ALIAS_LABEL[model]
      : null;
  const isOneM = model === "opus[1m]" || model === "sonnet[1m]";
  const decoratedModel = modelLabel && currentModelId && isOneM ? `${modelLabel} · 1M` : modelLabel;

  const { collapsed, expand } = useSidebarShell();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-background/60 px-3 backdrop-blur">
      {collapsed && (
        <button
          type="button"
          onClick={expand}
          aria-label="Show sidebar"
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-card hover:text-foreground"
        >
          <PanelLeftOpen className="size-4" strokeWidth={1.75} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate font-serif text-lg leading-tight text-foreground">{title}</h1>
          {decoratedModel && (
            <Badge variant="secondary" className="font-mono text-xs uppercase tracking-wider">
              {decoratedModel}
            </Badge>
          )}
          {effort && (
            <Badge
              variant="outline"
              className="border-border/60 font-mono text-xs uppercase tracking-wider text-muted-foreground"
            >
              {effort}
            </Badge>
          )}
          {permissionMode && <PermissionModeBadge mode={permissionMode} />}
        </div>
        {cwd && (
          <div className="truncate font-mono text-xs text-muted-foreground/60" dir="rtl">
            {cwd}
          </div>
        )}
      </div>
    </header>
  );
}
