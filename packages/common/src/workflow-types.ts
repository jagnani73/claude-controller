/** Read-only workflow observation. No client-supplied file paths or execution. */
export type WorkflowAgentStatus = "recorded" | "running" | "completed" | "failed";
export interface WorkflowAgent {
  id: string;
  label: string;
  phase: string;
  status: WorkflowAgentStatus;
  /** Existing per-agent stream; absent if no safe transcript was discovered. */
  streamId?: string;
  modelId?: string;
  /** Latest reported request context (input + cache read/write); not total spend. */
  contextTokens?: number;
}
export interface WorkflowPhase {
  title: string;
  detail?: string;
  /** Counts of observed agents only; the runtime may schedule more later. */
  total: number;
  completed: number;
  failed: number;
  running: number;
  agents: WorkflowAgent[];
}
export interface WorkflowRun {
  id: string;
  taskId?: string;
  name: string;
  description?: string;
  /** Unknown/history must not be promoted to live just because the session resumed. */
  status: "observed" | "running" | "completed" | "failed" | "stopped";
  phases: WorkflowPhase[];
  truncated: boolean;
  notice?: string;
}
export type WorkflowClientMessage = {
  type: "workflows_request";
  sessionId: string;
  requestId: string;
};
export type WorkflowServerMessage = {
  type: "workflows_snapshot";
  sessionId: string;
  requestId: string;
  runs: WorkflowRun[];
  truncated: boolean;
  error?: string;
};
