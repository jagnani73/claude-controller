/** Independent machine shells. These messages never address Claude's PTY. */
export interface TerminalInfo {
  id: string;
  sessionId: string;
  cwd: string;
  shell: string;
  state: "starting" | "running" | "closing" | "exited" | "error";
  exitCode: number | null;
  error?: string;
  cols: number;
  rows: number;
  /** UTF-8 byte offsets, not JS string indices. */
  firstSeq: number;
  nextSeq: number;
  controlled: boolean;
}

type Request = { sessionId: string; requestId: string };
type Target = Request & { terminalId: string };
export type TerminalClientMessage =
  | (Request & { type: "terminal_list" })
  | (Request & { type: "terminal_create"; cols: number; rows: number })
  | (Target & { type: "terminal_subscribe"; after: number })
  | (Target & { type: "terminal_output_ack"; after: number })
  | (Target & { type: "terminal_unsubscribe" })
  | (Target & { type: "terminal_claim" | "terminal_release" | "terminal_close" })
  | (Target & { type: "terminal_input"; data: string })
  | (Target & { type: "terminal_resize"; cols: number; rows: number });

export type TerminalServerMessage =
  | { type: "terminal_list"; sessionId: string; requestId: string; terminals: TerminalInfo[] }
  | {
      type: "terminal_state";
      sessionId: string;
      requestId?: string;
      terminal: TerminalInfo;
      controller: boolean;
    }
  | { type: "terminal_ack"; sessionId: string; terminalId: string; requestId: string }
  | { type: "terminal_removed"; sessionId: string; terminalId: string; requestId?: string }
  | {
      type: "terminal_output";
      sessionId: string;
      terminalId: string;
      start: number;
      end: number;
      data: string;
    }
  | {
      type: "terminal_gap";
      sessionId: string;
      terminalId: string;
      requested: number;
      available: number;
    }
  | { type: "terminal_error"; sessionId: string; requestId: string; message: string };

export const TERMINAL_LIMITS = {
  total: 12,
  perSession: 3,
  scrollbackBytes: 256 * 1024,
  outputBytes: 8 * 1024,
  inputBytes: 8 * 1024,
  queueBytes: 64 * 1024,
  socketBytes: 256 * 1024,
  minCols: 20,
  maxCols: 240,
  minRows: 5,
  maxRows: 100,
} as const;
