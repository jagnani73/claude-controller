import type { AgentMessage, AgentNode } from "common/types";

export interface AgentRow {
  node: AgentNode;
  depth: number;
}

/**
 * Flatten the agents into display order: each agent directly under the one that
 * spawned it, siblings oldest first. An agent whose parent is not in the list
 * (never seen, or filtered out) is shown at the top level rather than dropped.
 */
export function buildAgentRows(agents: readonly AgentNode[]): AgentRow[] {
  const known = new Set(agents.map((a) => a.agentId));
  const children = new Map<string | null, AgentNode[]>();
  for (const node of agents) {
    const parent =
      node.parentAgentId && known.has(node.parentAgentId) && node.parentAgentId !== node.agentId
        ? node.parentAgentId
        : null;
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  for (const list of children.values()) list.sort((a, b) => a.startedAt - b.startedAt);

  const rows: AgentRow[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      // Guards a parent cycle from a bad meta file; every node renders once.
      if (visited.has(node.agentId)) continue;
      visited.add(node.agentId);
      rows.push({ node, depth });
      walk(node.agentId, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function agentLabel(node: AgentNode): string {
  return node.name ?? node.agentType;
}

/** Name an agent id for display: the lead for null, else the agent's label. */
export function labelForId(
  agents: readonly AgentNode[],
  id: string | null | undefined,
  fallback?: string,
): string {
  if (id === null) return "lead";
  if (id === undefined) return fallback ?? "?";
  const node = agents.find((a) => a.agentId === id);
  return node ? agentLabel(node) : (fallback ?? id.slice(0, 8));
}

/** Recipient label: a resolved agent, the lead, a broadcast, or the raw address. */
export function recipientLabel(agents: readonly AgentNode[], message: AgentMessage): string {
  if (message.to === "*") return "everyone";
  if (message.toAgentId !== undefined) return labelForId(agents, message.toAgentId, message.to);
  // The recipient may have become known after the message was sent.
  const byName = agents.find((a) => a.name === message.to || a.agentId === message.to);
  return byName ? agentLabel(byName) : message.to || "?";
}

export function formatAgo(ts: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
