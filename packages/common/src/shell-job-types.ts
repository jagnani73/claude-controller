export type ShellJobStatus = "running" | "completed" | "failed" | "stopped" | "unknown";
export interface ShellJob {
  id: string;
  toolUseId: string;
  command: string;
  description: string;
  contextCwd: string;
  status: ShellJobStatus;
  source: "hook" | "transcript" | "replay";
  exitCode: null;
}
export type ShellJobClientMessage =
  | { type: "shell_jobs_request"; sessionId: string; requestId?: string }
  | {
      type: "shell_job_output_request";
      sessionId: string;
      jobId: string;
      offset?: number;
      requestId?: string;
    };
export type ShellJobServerMessage =
  | {
      type: "shell_jobs_snapshot";
      requestId?: string;
      sessionId: string;
      jobs: ShellJob[];
      truncated: boolean;
      error?: string;
    }
  | {
      type: "shell_job_output";
      requestId?: string;
      sessionId: string;
      jobId: string;
      text: string;
      offset: number;
      reset: boolean;
      truncated: boolean;
      error?: string;
    };
