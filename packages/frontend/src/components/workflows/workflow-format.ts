import { formatModelName } from "common/model";
import type {
  WorkflowAgent,
  WorkflowAgentStatus,
  WorkflowPhase,
  WorkflowRun,
} from "common/workflow-types";
import { formatTokens } from "@/lib/format";

/**
 * What a workflow agent's status says, in words the panel can show. Nothing here
 * is a guess: `recorded` means the run wrote a start and no result, which on a
 * resume is history rather than something still in flight.
 */
export const AGENT_STATUS_LABEL: Record<WorkflowAgentStatus, string> = {
  running: "Working",
  completed: "Done",
  failed: "Failed",
  recorded: "No result",
};

export const AGENT_STATUS_TONE: Record<
  WorkflowAgentStatus,
  "accent" | "success" | "warning" | "muted"
> = {
  running: "accent",
  completed: "success",
  failed: "warning",
  recorded: "muted",
};

/**
 * The run a summary line and the panel's default view describe: the newest run
 * that is still working, else the newest run at all. `runs` arrives in launch
 * order, so the last match is the newest.
 *
 * The dot, the status word and the counts must all come from this one run — a
 * strip that said "running" (because *some* run was) while showing an older
 * finished run's counts described two different runs at once.
 */
export function pickDisplayRun(runs: readonly WorkflowRun[]): WorkflowRun | undefined {
  let latestRunning: WorkflowRun | undefined;
  for (const run of runs) {
    if (run.status === "running") latestRunning = run;
  }
  return latestRunning ?? runs[runs.length - 1];
}

/**
 * A phase's label with its observed counts, e.g. "80/83".
 *
 * The denominator is how many agents this run has *started* in the phase, not a
 * planned total: the runtime can schedule more later, and nothing on disk says
 * how many it will. A phase not started yet therefore reads "0/0", not a guessed
 * target.
 */
export function phaseCounts(phase: WorkflowPhase): string {
  const parts = [`${phase.completed}/${phase.total}`];
  if (phase.failed > 0) parts.push(`${phase.failed} failed`);
  if (phase.running > 0) parts.push(`${phase.running} working`);
  return parts.join(" · ");
}

/** How many agents the run has started at all — the honest "observed" total. */
export function runObservedCount(run: WorkflowRun): number {
  return run.phases.reduce((sum, phase) => sum + phase.total, 0);
}

/** One line describing a whole run, for the strip above the input. */
export function runSummary(run: WorkflowRun): string {
  const agents = run.phases.reduce((sum, phase) => sum + phase.total, 0);
  const running = run.phases.reduce((sum, phase) => sum + phase.running, 0);
  const failed = run.phases.reduce((sum, phase) => sum + phase.failed, 0);
  const done = run.phases.reduce((sum, phase) => sum + phase.completed, 0);
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} working`);
  parts.push(`${done}/${agents} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/**
 * The model a workflow agent ran as. The id comes from the agent's own
 * transcript (else its meta's picked model), and is read structurally — a
 * family nobody has heard of still formats, and an unparseable id shows as-is
 * rather than as a wrong name.
 */
export function agentModelLabel(agent: WorkflowAgent): string | null {
  if (!agent.modelId) return null;
  return formatModelName(agent.modelId) ?? agent.modelId;
}

/**
 * The agent's latest request context, labelled as such.
 *
 * This is input + cache read + cache creation on its newest request — what the
 * statusline calls context — not a spend total, so it is never summed across
 * turns and never presented as cost. Absent rather than zero when the transcript
 * had no usage to report.
 */
export function agentContextLabel(agent: WorkflowAgent): string | null {
  if (agent.contextTokens === undefined) return null;
  return `${formatTokens(agent.contextTokens)} context`;
}

/**
 * The run's own status, in words. `observed` is the honest label for a run
 * whose journal shows no agent working but whose outcome the CLI never
 * reported (the normal state after a resume, and for any run whose task
 * notification is not in this transcript).
 */
export function runStatusLabel(run: WorkflowRun): string {
  switch (run.status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Observed";
  }
}
