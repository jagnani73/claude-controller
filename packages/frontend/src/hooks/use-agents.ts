import type { AgentMessage, AgentNode } from "common/types";
import { useEffect, useState } from "react";
import { useWsMessage } from "./use-ws";

/**
 * The agents (subagents/teammates) of one session, plus the messages they have
 * sent each other. The backend sends a full snapshot when the session is
 * subscribed and whole-node updates after that, so merging is a plain upsert.
 */
export function useAgents(sessionId: string): {
  agents: AgentNode[];
  messages: AgentMessage[];
} {
  const [agents, setAgents] = useState<AgentNode[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);

  // Reset when the route switches session: the component instance is reused, so
  // without this the previous session's agents would linger until a snapshot
  // (which is only sent when the session has any) replaced them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger, not a value read in the body
  useEffect(() => {
    setAgents([]);
    setMessages([]);
  }, [sessionId]);

  useWsMessage("agents_snapshot", (msg) => {
    if (msg.sessionId !== sessionId) return;
    setAgents(msg.agents);
    setMessages(msg.messages);
  });

  useWsMessage("agent_update", (msg) => {
    if (msg.sessionId !== sessionId) return;
    setAgents((prev) => {
      const idx = prev.findIndex((a) => a.agentId === msg.agent.agentId);
      if (idx < 0) return [...prev, msg.agent];
      const next = [...prev];
      next[idx] = msg.agent;
      return next;
    });
  });

  useWsMessage("agent_message", (msg) => {
    if (msg.sessionId !== sessionId) return;
    setMessages((prev) =>
      prev.some((m) => m.id === msg.message.id) ? prev : [...prev, msg.message],
    );
  });

  return { agents, messages };
}
