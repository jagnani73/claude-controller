/** Read-only, session-rooted workspace protocol. Paths are slash-separated and relative. */
export type WorkspaceQuery =
  | { kind: "list"; path: string; offset?: number }
  | { kind: "file"; path: string; lineOffset?: number }
  | { kind: "changes"; offset?: number }
  | { kind: "diff"; path: string; area: ChangeArea };

export type ChangeArea = "staged" | "unstaged" | "untracked";
export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "unavailable";
}
export interface WorkspaceChange {
  path: string;
  oldPath?: string;
  area: ChangeArea;
  status: string;
}
export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}
export type WorkspaceResult =
  | { kind: "list"; path: string; entries: WorkspaceEntry[]; nextOffset?: number; limited: boolean }
  | {
      kind: "file";
      path: string;
      text: string;
      binary: boolean;
      totalBytes: number;
      lineOffset: number;
      nextLine?: number;
      truncated: boolean;
    }
  | {
      kind: "changes";
      isGit: boolean;
      entries: WorkspaceChange[];
      nextOffset?: number;
      limited: boolean;
    }
  | {
      kind: "diff";
      path: string;
      area: ChangeArea;
      lines: DiffLine[];
      notice?: string;
      binary: boolean;
      truncated: boolean;
      oldLabel: string;
      newLabel: string;
    };

export interface WorkspaceRequest {
  type: "workspace_request";
  requestId: string;
  sessionId: string;
  query: WorkspaceQuery;
}
export type WorkspaceResponse = {
  type: "workspace_response";
  requestId: string;
  sessionId: string;
} & ({ ok: true; result: WorkspaceResult } | { ok: false; message: string });
