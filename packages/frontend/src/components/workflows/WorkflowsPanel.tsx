import type { WorkflowAgent, WorkflowPhase, WorkflowRun } from "common/workflow-types";
import { Bot, ChevronLeft, Cpu, Loader2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { MessageStream } from "@/components/messages/MessageStream";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useWsMessage } from "@/hooks/use-ws";
import { cn } from "@/lib/utils";
import { wsService } from "@/services/ws.service";
import {
  AGENT_STATUS_LABEL,
  AGENT_STATUS_TONE,
  agentContextLabel,
  agentModelLabel,
  phaseCounts,
  pickDisplayRun,
  runObservedCount,
  runStatusLabel,
} from "./workflow-format";

export interface WorkflowsPanelProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The owner's one `useWorkflows` value. This panel never polls on its own. */
  runs: readonly WorkflowRun[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

/**
 * The workflow runs this session launched, as a read-only view.
 *
 * Deliberately observational: no stop, pause or restart, because the CLI exposes
 * no supported way to control a run and a guessed keystroke would be worse than
 * no button. What it shows is what the run's own files say — the phases its
 * script declared, and per phase how many agents it has actually started and how
 * they ended.
 *
 * The run list is **props**, not a second `useWorkflows`: snapshots are
 * pull-only and the backend serves one per socket, so two pollers would starve
 * each other. The owner (the session view) fetches; this panel renders and asks
 * for nothing but an agent's transcript.
 *
 * An agent row opens that agent's transcript through the existing agent stream,
 * exactly as the agents sheet does; the chat behind the sheet stays mounted.
 */
export function WorkflowsPanel({
  sessionId,
  open,
  onOpenChange,
  runs,
  truncated,
  loading,
  error,
  onRetry,
}: WorkflowsPanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Embedded/backgrounded browsers can suspend slide-in frames offscreen. */}
      <SheetContent
        animated={false}
        side="right"
        className="h-dvh max-h-dvh min-w-0 w-full gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-2xl"
      >
        {open && (
          // Keyed by session: switching chats remounts instead of carrying a
          // run, phase or agent selection into a session it does not belong to.
          <WorkflowsView
            key={sessionId}
            sessionId={sessionId}
            runs={runs}
            truncated={truncated}
            loading={loading}
            error={error}
            onRetry={onRetry}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

type ViewProps = Omit<WorkflowsPanelProps, "open" | "onOpenChange">;

function WorkflowsView({ sessionId, runs, truncated, loading, error, onRetry }: ViewProps) {
  /** A run picked from the list; null means "the newest run" (see `pickDisplayRun`). */
  const [runId, setRunId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  /** Set when the run being viewed left the list, so the jump is never silent. */
  const [lostNotice, setLostNotice] = useState<string | null>(null);

  // The open agent's transcript state, mirroring AgentsSheet: nothing yet
  // (loading), its history arrived (loaded, possibly empty), or it cannot be
  // served (unavailable, with Retry).
  const [agentLoaded, setAgentLoaded] = useState(false);
  const [agentUnavailable, setAgentUnavailable] = useState<string | null>(null);
  /** Bumped by Retry to re-run the subscribe effect. */
  const [attempt, setAttempt] = useState(0);

  const latestRun = pickDisplayRun(runs);
  const selectedRun = runId ? runs.find((run) => run.id === runId) : latestRun;
  // Only while a list is on screen: an empty list mid-load is not a removal.
  const runLost = runId !== null && selectedRun === undefined && !loading && !error;
  const agent =
    selectedRun && agentId
      ? findAgent(selectedRun, agentId)
      : (undefined as WorkflowAgent | undefined);
  const agentLost = agentId !== null && selectedRun !== undefined && agent === undefined;
  const agentKey = agent?.id ?? null;
  const phases = selectedRun ? withSelection(selectedRun.phases, phase) : [];

  // A selected run that disappeared must not be swapped silently: drop the
  // phase/agent selection that named it, and say what happened.
  useEffect(() => {
    if (!runLost) return;
    setRunId(null);
    setPhase(null);
    setAgentId(null);
    setLostNotice(
      "The run you were viewing is no longer in this session's list. Showing the latest.",
    );
  }, [runLost]);

  // Opening an agent starts its transcript stream; closing it, leaving the
  // sheet (this view unmounts) or switching session stops it. The subscription
  // replays the tail on open, so there is nothing to keep warm.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the Retry trigger, not a value read in the body
  useEffect(() => {
    setAgentLoaded(false);
    setAgentUnavailable(null);
    if (!agentKey) return;
    wsService.send({ type: "subscribe_agent", sessionId, agentId: agentKey });
    return () => wsService.send({ type: "unsubscribe_agent", sessionId, agentId: agentKey });
  }, [sessionId, agentKey, attempt]);

  useWsMessage("history_available", (msg) => {
    if (agent?.streamId && msg.sessionId === agent.streamId) setAgentLoaded(true);
  });

  // A snapshot means the session subscription was (re)established — after a
  // reconnect, or a resume — and the backend ends every agent stream with the
  // session subscription it belonged to. Ask for the open agent again; its
  // MessageStream drops the replayed tail it already shows.
  useWsMessage("agents_snapshot", (msg) => {
    if (msg.sessionId !== sessionId || !agentKey) return;
    wsService.send({ type: "subscribe_agent", sessionId, agentId: agentKey });
  });

  useWsMessage("agent_unavailable", (msg) => {
    if (agent?.streamId && msg.sessionId === agent.streamId) {
      setAgentUnavailable(msg.message || "This agent's transcript isn't available.");
    }
  });

  const selectRun = (nextRunId: string) => {
    setRunId(nextRunId);
    setPhase(null);
    setAgentId(null);
    setLostNotice(null);
  };

  const backToRun = () => {
    setAgentId(null);
  };

  return (
    <>
      <SheetHeader className="max-h-[50dvh] min-w-0 shrink-0 gap-1 overflow-y-auto border-b border-border/60 pr-14 [overflow-wrap:anywhere]">
        <SheetTitle className="font-serif text-lg">{agent ? agent.label : "Workflows"}</SheetTitle>
        <SheetDescription className="text-xs">
          {agent ? (
            [agent.phase || null, AGENT_STATUS_LABEL[agent.status], agentModelLabel(agent)]
              .filter(Boolean)
              .join(" · ")
          ) : (
            <>
              Read-only view of the runs this session launched.
              {selectedRun && runs.length > 1 && (
                <span className="text-muted-foreground/70">
                  {" "}
                  Showing {runStatusLabel(selectedRun).toLowerCase()} run.
                </span>
              )}
            </>
          )}
        </SheetDescription>
        {(agent || agentLost) && (
          <button
            type="button"
            onClick={backToRun}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-10"
          >
            <ChevronLeft className="size-3.5" strokeWidth={1.75} />
            Back to {selectedRun?.name ?? "run"}
          </button>
        )}
      </SheetHeader>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {agent ? (
          agentUnavailable ? (
            <div className="flex h-full flex-col items-center justify-center-safe gap-3 overflow-y-auto px-6 py-4 text-center [overflow-wrap:anywhere]">
              <p className="font-serif text-base italic text-muted-foreground/80">
                {agentUnavailable}
              </p>
              <Button
                variant="secondary"
                className="pointer-coarse:min-h-10"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry
              </Button>
            </div>
          ) : agent.streamId ? (
            <MessageStream
              key={agent.streamId}
              sessionId={agent.streamId}
              emptyLabel={
                agentLoaded
                  ? "This agent has not written anything yet."
                  : "Loading this agent's transcript\u2026"
              }
            />
          ) : (
            <div className="flex h-full items-center justify-center-safe px-6 text-center font-serif text-base italic text-muted-foreground/70">
              This agent's transcript isn't available.
            </div>
          )
        ) : agentLost ? (
          <div className="flex h-full flex-col items-center justify-center-safe gap-3 overflow-y-auto px-6 py-4 text-center [overflow-wrap:anywhere]">
            <p className="font-serif text-base italic text-muted-foreground/80">
              That agent is no longer listed in this run.
            </p>
            <Button variant="secondary" className="pointer-coarse:min-h-10" onClick={backToRun}>
              Back to the run
            </Button>
          </div>
        ) : (
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            {error && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <output className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</output>
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            )}
            {lostNotice && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                <output className="min-w-0 flex-1 [overflow-wrap:anywhere]">{lostNotice}</output>
                <Button size="sm" variant="ghost" onClick={() => setLostNotice(null)}>
                  Dismiss
                </Button>
              </div>
            )}
            {runs.length > 1 && (
              <RunRail runs={runs} selected={selectedRun?.id ?? null} onSelect={selectRun} />
            )}
            {selectedRun ? (
              <>
                <div className="shrink-0 border-b border-border/40 px-3 py-2">
                  <RunHeading run={selectedRun} />
                </div>
                {selectedRun.notice && (
                  <div className="shrink-0 border-b border-border/40 bg-warning/10 px-3 py-2 text-xs text-warning [overflow-wrap:anywhere]">
                    {selectedRun.notice}
                  </div>
                )}
                {truncated && (
                  <div className="shrink-0 border-b border-border/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                    This session has more runs than are listed.
                  </div>
                )}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
                  <PhasePicker
                    phases={selectedRun.phases}
                    selected={phase}
                    onSelect={(title) => {
                      setPhase(title);
                      setAgentId(null);
                    }}
                  />
                  <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                    {selectedRun.phases.length === 0 ? (
                      <div className="px-4 py-6 text-center font-serif text-base italic text-muted-foreground/60">
                        This run has not recorded any agents yet.
                      </div>
                    ) : phases.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center font-serif text-base italic text-muted-foreground/60">
                        That phase is no longer listed in this run.
                        <Button size="sm" variant="secondary" onClick={() => setPhase(null)}>
                          Show all phases
                        </Button>
                      </div>
                    ) : (
                      phases.map((entry) => (
                        <PhaseSection
                          key={entry.title}
                          phase={entry}
                          selected={agentId}
                          onSelect={(nextAgentId) => setAgentId(nextAgentId)}
                        />
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : loading ? (
              <div className="flex flex-1 items-center justify-center-safe gap-2 px-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-accent" />
                Loading runs…
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center-safe px-6 text-center font-serif text-base italic text-muted-foreground/60">
                No workflow runs yet. They appear here when this session launches one.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** One button per run, so a session with several is not stuck on the newest. */
function RunRail({
  runs,
  selected,
  onSelect,
}: {
  runs: readonly WorkflowRun[];
  selected: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <nav
      aria-label="Workflow runs"
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border/40 bg-background/85 px-3 py-2"
    >
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          onClick={() => onSelect(run.id)}
          aria-pressed={selected === run.id}
          className={cn(
            "flex min-w-0 max-w-[14rem] shrink-0 items-baseline gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-colors pointer-coarse:min-h-10",
            "border-border/60 text-muted-foreground hover:bg-accent/10 hover:text-foreground",
            selected === run.id && "border-accent/50 bg-accent/15 text-foreground",
          )}
        >
          <span className="min-w-0 truncate font-medium">{run.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
            {runStatusLabel(run)}
          </span>
        </button>
      ))}
    </nav>
  );
}

function RunHeading({ run }: { run: WorkflowRun }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 max-w-full truncate text-sm font-medium text-foreground">
          {run.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
          {runStatusLabel(run)}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
          <Users className="mr-1 inline size-3" strokeWidth={1.75} />
          {runObservedCount(run)} observed
        </span>
      </div>
      {run.description && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{run.description}</p>
      )}
    </div>
  );
}

/**
 * The phase picker and count table. Chips in a horizontal scroller on a phone;
 * a vertical side list from `md` up, where the sheet is wide enough for two
 * columns. One DOM either way — only the layout changes.
 */
function PhasePicker({
  phases,
  selected,
  onSelect,
}: {
  phases: readonly WorkflowPhase[];
  selected: string | null;
  onSelect: (title: string | null) => void;
}) {
  if (phases.length === 0) return null;
  const itemClass = (active: boolean) =>
    cn(
      "flex min-w-0 shrink-0 items-center gap-2 rounded-md border px-2 py-1 text-xs transition-colors pointer-coarse:min-h-10",
      "border-border/60 text-muted-foreground hover:bg-accent/10 hover:text-foreground",
      "md:w-full md:justify-start",
      active && "border-accent/50 bg-accent/15 text-foreground",
    );
  return (
    <nav
      aria-label="Workflow phases"
      className={cn(
        "flex shrink-0 gap-1.5 overflow-x-auto border-b border-border/40 bg-background/85 px-3 py-2 backdrop-blur",
        "md:sticky md:top-0 md:z-10 md:w-56 md:flex-col md:overflow-y-auto md:border-r md:border-b-0",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-pressed={selected === null}
        className={itemClass(selected === null)}
      >
        <span className="min-w-0 truncate font-medium">All phases</span>
      </button>
      {phases.map((phase) => (
        <button
          key={phase.title}
          type="button"
          onClick={() => onSelect(phase.title)}
          aria-pressed={selected === phase.title}
          title={phase.title}
          className={itemClass(selected === phase.title)}
        >
          <span className="min-w-0 truncate font-medium">{phase.title}</span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
            {phaseCounts(phase)}
          </span>
        </button>
      ))}
    </nav>
  );
}

function PhaseSection({
  phase,
  selected,
  onSelect,
}: {
  phase: WorkflowPhase;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
}) {
  return (
    <section className="border-b border-border/40 last:border-b-0">
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pt-3 pb-1">
        <h3 className="min-w-0 max-w-full truncate text-sm font-medium text-foreground">
          {phase.title}
        </h3>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/80">
          {phaseCounts(phase)}
        </span>
      </header>
      {phase.detail && (
        <p className="max-h-24 overflow-y-auto px-3 pb-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {phase.detail}
        </p>
      )}
      {phase.agents.length === 0 ? (
        <p className="px-3 pb-3 text-xs italic text-muted-foreground/60">No agents started yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5 px-1.5 pb-2">
          {phase.agents.map((agent) => (
            <li key={agent.id}>
              <AgentRow agent={agent} selected={agent.id === selected} onClick={onSelect} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentRow({
  agent,
  selected,
  onClick,
}: {
  agent: WorkflowAgent;
  selected: boolean;
  onClick: (agentId: string) => void;
}) {
  const model = agentModelLabel(agent);
  const context = agentContextLabel(agent);
  const openable = Boolean(agent.streamId);
  return (
    <button
      type="button"
      // A row with no transcript still shows its label/status/model, but is not
      // offered as a link that would go nowhere.
      onClick={() => openable && onClick(agent.id)}
      disabled={!openable}
      data-active={selected || undefined}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-lg py-1.5 pr-2 pl-2 text-left transition-colors",
        openable ? "hover:bg-card/70" : "cursor-default",
        selected && "bg-card/70",
      )}
    >
      <span className="mt-1 shrink-0">
        <StatusDot tone={AGENT_STATUS_TONE[agent.status]} pulse={agent.status === "running"} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-sm text-foreground">{agent.label}</span>
          <span
            className={cn(
              "ml-auto shrink-0 font-mono text-[11px] tabular-nums",
              agent.status === "failed" ? "text-warning" : "text-muted-foreground/70",
            )}
          >
            {AGENT_STATUS_LABEL[agent.status]}
          </span>
        </span>
        {(model || context) && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground/60">
            {model && (
              <span className="flex min-w-0 items-center gap-1">
                <Bot className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{model}</span>
              </span>
            )}
            {context && (
              <span className="flex shrink-0 items-center gap-1 tabular-nums">
                <Cpu className="size-3" strokeWidth={1.75} />
                {context}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/** The phase a chip selected, as a single-element list. */
function withSelection(
  phases: readonly WorkflowPhase[],
  selected: string | null,
): readonly WorkflowPhase[] {
  if (!selected) return phases;
  return phases.filter((phase) => phase.title === selected);
}

function findAgent(run: WorkflowRun | undefined, agentId: string): WorkflowAgent | undefined {
  if (!run || !agentId) return undefined;
  for (const phase of run.phases) {
    const found = phase.agents.find((agent) => agent.id === agentId);
    if (found) return found;
  }
  return undefined;
}
