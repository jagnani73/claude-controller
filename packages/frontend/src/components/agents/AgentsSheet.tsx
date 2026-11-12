import type { AgentMessage, AgentNode, AgentStatus } from "common/types";
import { ArrowRight, ChevronLeft, MessagesSquare, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { MessageStream } from "@/components/messages/MessageStream";
import { summaryAddsInfo } from "@/components/messages/teammate-message";
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
import { agentLabel, buildAgentRows, formatAgo, labelForId, recipientLabel } from "./agent-tree";

type Tab = "tree" | "messages";

const STATUS_TONE: Record<AgentStatus, "accent" | "muted" | "success"> = {
  running: "accent",
  idle: "muted",
  done: "success",
};

interface AgentsSheetProps {
  sessionId: string;
  agents: readonly AgentNode[];
  messages: readonly AgentMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The agents view: the spawn tree, each agent's own transcript, and the
 * messages they have sent one another. Read-only: there is no input channel
 * to an individual agent, so nothing here can talk back to one.
 */
export function AgentsSheet({ sessionId, agents, messages, open, onOpenChange }: AgentsSheetProps) {
  const [tab, setTab] = useState<Tab>("tree");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? agents.find((a) => a.agentId === selectedId) : undefined;
  // What the server said about the open agent's stream: nothing yet (loading),
  // its history arrived (loaded, possibly empty), or it cannot be served.
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  // Bumped by Retry to re-run the subscribe effect below.
  const [attempt, setAttempt] = useState(0);

  // Opening an agent starts its transcript stream; leaving (or closing the sheet,
  // or switching session) stops it. The subscription replays the tail on open, so
  // there is nothing to keep warm.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the Retry trigger, not a value read in the body
  useEffect(() => {
    setLoaded(false);
    setUnavailable(null);
    if (!open || !selectedId) return;
    wsService.send({ type: "subscribe_agent", sessionId, agentId: selectedId });
    return () => wsService.send({ type: "unsubscribe_agent", sessionId, agentId: selectedId });
  }, [open, selectedId, sessionId, attempt]);

  useWsMessage("history_available", (msg) => {
    if (msg.sessionId === selected?.streamId) setLoaded(true);
  });

  useWsMessage("agent_unavailable", (msg) => {
    if (msg.sessionId === selected?.streamId) setUnavailable(msg.message);
  });

  // A different session has different agents; never carry a selection across.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger, not a value read in the body
  useEffect(() => {
    setSelectedId(null);
    setTab("tree");
  }, [sessionId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl" side="right">
        <SheetHeader className="shrink-0 border-b border-border/60 pr-12">
          <SheetTitle className="font-serif text-lg">
            {selected ? agentLabel(selected) : "Agents"}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Agents spawned by this session, their transcripts, and their messages.
          </SheetDescription>
          {selected ? (
            <AgentSummary node={selected} onBack={() => setSelectedId(null)} />
          ) : (
            <div className="flex gap-1 pt-1">
              <TabButton active={tab === "tree"} onClick={() => setTab("tree")}>
                <Network className="size-3.5" strokeWidth={1.75} />
                Tree
              </TabButton>
              <TabButton active={tab === "messages"} onClick={() => setTab("messages")}>
                <MessagesSquare className="size-3.5" strokeWidth={1.75} />
                Messages
                {messages.length > 0 && (
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {messages.length}
                  </span>
                )}
              </TabButton>
            </div>
          )}
        </SheetHeader>

        <div className="min-h-0 flex-1">
          {selected && unavailable ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="font-serif text-base italic text-muted-foreground/80">{unavailable}</p>
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            </div>
          ) : selected ? (
            <MessageStream
              // Keyed so switching agents remounts the stream instead of
              // reconciling one agent's items into another's.
              key={selected.streamId}
              sessionId={selected.streamId}
              emptyLabel={
                loaded
                  ? "This agent has not written anything yet."
                  : "Loading this agent's transcript\u2026"
              }
            />
          ) : tab === "tree" ? (
            <TreeView agents={agents} onSelect={setSelectedId} />
          ) : (
            <MessagesView agents={agents} messages={messages} onSelect={setSelectedId} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active || undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        "border-border/60 text-muted-foreground hover:bg-accent/10 hover:text-foreground",
        active && "border-accent/50 bg-accent/15 text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function AgentSummary({ node, onBack }: { node: AgentNode; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" strokeWidth={1.75} />
        All agents
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <StatusDot tone={STATUS_TONE[node.status]} pulse={node.status === "running"}>
          {node.status}
        </StatusDot>
        {node.agentType !== node.name && (
          <span className="font-mono text-[11px]">{node.agentType}</span>
        )}
        {node.background && <span className="font-mono text-[11px]">background</span>}
        <span className="font-mono text-[11px]">started {formatAgo(node.startedAt)}</span>
      </div>
      {node.description && <p className="text-sm text-muted-foreground">{node.description}</p>}
    </div>
  );
}

function TreeView({
  agents,
  onSelect,
}: {
  agents: readonly AgentNode[];
  onSelect: (id: string) => void;
}) {
  const rows = buildAgentRows(agents);
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center font-serif text-base italic text-muted-foreground/60">
        No agents yet. They appear here when Claude spawns one.
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto px-2 py-2">
      <ul className="flex flex-col gap-0.5">
        {rows.map(({ node, depth }) => (
          <li key={node.agentId}>
            <button
              type="button"
              onClick={() => onSelect(node.agentId)}
              style={{ paddingLeft: `${0.5 + depth * 1.1}rem` }}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg py-2 pr-2 text-left transition-colors hover:bg-card/70",
                // Finished agents stay readable but recede behind the live ones.
                node.status === "done" && "opacity-60",
              )}
            >
              <span className="mt-1.5">
                <StatusDot tone={STATUS_TONE[node.status]} pulse={node.status === "running"} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {agentLabel(node)}
                  </span>
                  {/* Teammates are typed by their own name; repeating it says nothing. */}
                  {node.name && node.agentType !== node.name && (
                    <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                      {node.agentType}
                    </span>
                  )}
                </span>
                {node.description && (
                  <span className="truncate text-xs text-muted-foreground">{node.description}</span>
                )}
                <span className="truncate font-mono text-[11px] text-muted-foreground/60">
                  {node.status}
                  {node.status === "running" && node.activity ? ` \u00b7 ${node.activity}` : ""}
                  {` \u00b7 ${formatAgo(node.lastActivityAt)}`}
                </span>
                {node.status !== "running" && node.lastMessage && (
                  <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/80">
                    {node.lastMessage}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessagesView({
  agents,
  messages,
  onSelect,
}: {
  agents: readonly AgentNode[];
  messages: readonly AgentMessage[];
  onSelect: (id: string) => void;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center font-serif text-base italic text-muted-foreground/60">
        No messages between agents yet.
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <ul className="flex flex-col gap-2">
        {messages.map((m) => (
          <li key={m.id} className="rounded-xl border border-border/60 bg-card/50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Party
                label={labelForId(agents, m.fromAgentId)}
                agentId={m.fromAgentId}
                onSelect={onSelect}
              />
              <ArrowRight className="size-3 text-muted-foreground/60" strokeWidth={1.75} />
              <Party
                label={recipientLabel(agents, m)}
                agentId={m.toAgentId ?? null}
                onSelect={onSelect}
              />
              {m.kind !== "message" && (
                <span className="rounded-md border border-warning/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warning">
                  {m.kind.replaceAll("_", " ")}
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] text-muted-foreground/60">
                {new Date(m.timestamp).toLocaleTimeString()}
              </span>
            </div>
            {summaryAddsInfo(m.summary, m.text) && (
              <div className="mt-1 text-xs text-muted-foreground">{m.summary}</div>
            )}
            <div className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/90">
              {m.text}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Party({
  label,
  agentId,
  onSelect,
}: {
  label: string;
  agentId: string | null;
  onSelect: (id: string) => void;
}) {
  const className = "font-mono font-medium text-foreground";
  // The lead has no transcript of its own to open; it is the main stream.
  if (!agentId) return <span className={className}>{label}</span>;
  return (
    <button
      type="button"
      onClick={() => onSelect(agentId)}
      className={cn(className, "underline decoration-dotted underline-offset-2 hover:text-accent")}
    >
      {label}
    </button>
  );
}
