import type { WorkspaceQuery, WorkspaceResponse } from "common/types";
import { findSessionByTranscript } from "../utils/find-session.js";
import type { SessionManager } from "./session-manager.service.js";
import { filePage, listWorkspace, workspacePath } from "./workspace-files.service.js";
import { workspaceChanges, workspaceDiff } from "./workspace-git.service.js";

function offset(value: unknown, max: number): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error("Invalid page offset.");
  }
  return value;
}
function queryOf(value: unknown): WorkspaceQuery {
  if (!value || typeof value !== "object") throw new Error("Invalid workspace request.");
  const q = value as Record<string, unknown>;
  switch (q.kind) {
    case "list":
      return { kind: "list", path: workspacePath(q.path, true), offset: offset(q.offset, 10000) };
    case "file":
      return { kind: "file", path: workspacePath(q.path), lineOffset: offset(q.lineOffset, 4000) };
    case "changes":
      return { kind: "changes", offset: offset(q.offset, 100000) };
    case "diff": {
      if (q.area !== "staged" && q.area !== "unstaged" && q.area !== "untracked") {
        throw new Error("Invalid change area.");
      }
      return { kind: "diff", path: workspacePath(q.path), area: q.area };
    }
    default:
      throw new Error("Unknown workspace request.");
  }
}

const active = new WeakMap<object, number>();
let totalActive = 0;
/** Isolated dispatcher: never accepts a client root and never starts a Claude session. */
export async function handleWorkspaceRequest(
  client: object,
  raw: unknown,
  sessions: Pick<SessionManager, "get">,
  send: (response: WorkspaceResponse) => void,
): Promise<void> {
  const msg = raw as Record<string, unknown>;
  if (
    !msg ||
    typeof msg.requestId !== "string" ||
    msg.requestId.length > 128 ||
    typeof msg.sessionId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.sessionId)
  ) {
    return;
  }
  const envelope = {
    type: "workspace_response" as const,
    requestId: msg.requestId,
    sessionId: msg.sessionId,
  };
  if ((active.get(client) ?? 0) >= 4 || totalActive >= 16) {
    send({ ...envelope, ok: false, message: "Workspace is busy. Retry in a moment." });
    return;
  }
  active.set(client, (active.get(client) ?? 0) + 1);
  totalActive++;
  try {
    const query = queryOf(msg.query);
    const cwd =
      sessions.get(msg.sessionId)?.config.cwd ??
      (await findSessionByTranscript(msg.sessionId))?.cwd;
    if (!cwd) throw new Error("The session workspace is not known. Open the session first.");
    const result =
      query.kind === "list"
        ? await listWorkspace(cwd, query.path, query.offset ?? 0)
        : query.kind === "file"
          ? await filePage(cwd, query.path, query.lineOffset ?? 0)
          : query.kind === "changes"
            ? await workspaceChanges(cwd, query.offset ?? 0)
            : await workspaceDiff(cwd, query.path, query.area);
    send({ ...envelope, ok: true, result });
  } catch (error) {
    // OS/Git messages can contain absolute paths outside the session root.
    const err = error as Error & { code?: unknown; cmd?: unknown };
    const message =
      err.code !== undefined || err.cmd !== undefined
        ? "Read unavailable: file missing, access denied, or Git exceeded its time/output limit. Refresh and retry."
        : err.message;
    send({ ...envelope, ok: false, message: message || "Workspace read failed. Retry." });
  } finally {
    active.set(client, (active.get(client) ?? 1) - 1);
    totalActive--;
  }
}
