import type { WorkflowRun } from "common/workflow-types";
import { ChevronRight, Workflow } from "lucide-react";
import { StatusDot } from "@/components/ui/StatusDot";
import { pickDisplayRun, runStatusLabel, runSummary } from "./workflow-format";

interface WorkflowsStripProps {
  runs: readonly WorkflowRun[];
  onOpen: () => void;
}

/**
 * The entry point to the workflow view, sitting above the input next to the
 * agents strip.
 *
 * It is always rendered — a session with no runs still needs a way in, and the
 * panel is where "no runs yet" belongs. Before the first snapshot arrives it is
 * just the label; once one does, the line describes **one** run (the newest that
 * is still working, else the newest) so the dot, the status word and the counts
 * can never describe different runs.
 *
 * It asks for nothing itself: the poll belongs to the one `useWorkflows` its
 * owner runs, so this line costs no traffic.
 */
export function WorkflowsStrip({ runs, onOpen }: WorkflowsStripProps) {
  const run = pickDisplayRun(runs);
  const extra = runs.length > 1 ? ` · +${runs.length - 1} more` : "";

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={run ? `Workflows: ${run.name}, ${runStatusLabel(run)}` : "Workflows: no runs yet"}
      className="flex w-full min-w-0 items-center gap-2 border-t border-border/40 bg-background/60 px-3 py-1.5 text-left text-xs text-muted-foreground backdrop-blur transition-colors hover:bg-card/60 hover:text-foreground pointer-coarse:min-h-10"
    >
      <StatusDot
        tone={run ? (run.status === "running" ? "accent" : "muted") : "muted"}
        pulse={run?.status === "running"}
      />
      <Workflow className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} />
      {run ? (
        <>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">{run.name}</span>
          <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-muted-foreground/60">
            {runStatusLabel(run)}
          </span>
          <span className="max-w-[55%] shrink-0 truncate text-right font-mono text-[11px] tabular-nums text-muted-foreground/70">
            {runSummary(run)}
            {extra}
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium font-medium text-foreground/80">
          Workflows
          <span className="ml-1.5 font-sans font-normal text-muted-foreground/60">None yet</span>
        </span>
      )}
      <ChevronRight className="size-3.5 shrink-0" strokeWidth={1.75} />
    </button>
  );
}
