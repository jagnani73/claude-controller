import type { AgentNode } from "common/types";
import { Bot, ChevronRight } from "lucide-react";
import { StatusDot } from "@/components/ui/StatusDot";
import { agentLabel } from "./agent-tree";

interface AgentsStripProps {
  agents: readonly AgentNode[];
  onOpen: () => void;
}

/**
 * A one-line summary of the session's agents, sitting above the input. Hidden
 * until an agent exists, so a session that never spawns one looks exactly as
 * before.
 */
export function AgentsStrip({ agents, onOpen }: AgentsStripProps) {
  if (agents.length === 0) return null;

  const running = agents.filter((a) => a.status === "running");
  const idle = agents.filter((a) => a.status === "idle").length;
  const done = agents.filter((a) => a.status === "done").length;

  // Say what is happening now; only when nothing is running do the quieter
  // states matter. A long list of running agents collapses to a count.
  let detail: string;
  if (running.length > 0) {
    const names = running.slice(0, 3).map(agentLabel).join(", ");
    const more = running.length > 3 ? ` +${running.length - 3}` : "";
    detail = `${running.length} running \u00b7 ${names}${more}`;
  } else {
    detail = [idle > 0 ? `${idle} idle` : null, done > 0 ? `${done} done` : null]
      .filter(Boolean)
      .join(" \u00b7 ");
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 border-t border-border/40 bg-background/60 px-3 py-1.5 text-left text-xs text-muted-foreground backdrop-blur transition-colors hover:bg-card/60 hover:text-foreground"
    >
      <StatusDot tone={running.length > 0 ? "accent" : "muted"} pulse={running.length > 0} />
      <Bot className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} />
      <span className="font-medium text-foreground/80">
        {agents.length} {agents.length === 1 ? "agent" : "agents"}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
        {detail}
      </span>
      {/* Points right because the sheet slides in from the right edge. */}
      <ChevronRight className="size-3.5 shrink-0" strokeWidth={1.75} />
    </button>
  );
}
