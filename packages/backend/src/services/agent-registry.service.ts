import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AgentMessage, type AgentNode, type AgentStatus, agentStreamId } from "common/types";
import type {
  PreToolUsePayload,
  SubagentStartPayload,
  SubagentStopPayload,
} from "../types/hook.types.js";
import { LoggerService } from "./logger.service.js";
import { SessionBus } from "./session-bus.service.js";
import { TranscriptWatcher } from "./transcript.service.js";

const log = LoggerService.scoped("agents");

const MAX_MESSAGES = 500;
const ACTIVITY_EMIT_MS = 400;
/** Subagent folders nest at most `subagents/workflows/<runId>/`. */
const MAX_SCAN_DEPTH = 3;
/** Give up on a parent chain this long: a cycle, or a corrupt meta file. */
const MAX_PARENT_HOPS = 32;
/** Tool names under which a parent spawns an agent (renamed Task -> Agent upstream). */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What `agent-<id>.meta.json` holds (shape captured live on 2.1.322). */
interface AgentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  toolUseId?: string;
  spawnDepth?: number;
  requestShape?: string;
  finished?: boolean;
}

export interface AgentFiles {
  agentId: string;
  jsonlPath?: string;
  metaPath?: string;
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Find every agent's files under a session's `subagents/` directory, including
 * the `workflows/<runId>/` grouping the CLI uses for workflow runs.
 *
 * A missing directory is normal (the CLI creates it lazily, and a session with
 * no agents never does). Anything else, such as a permissions error, would make
 * the whole tree silently empty, so it is reported.
 */
export function listAgentFiles(dir: string, depth = 0): AgentFiles[] {
  if (depth >= MAX_SCAN_DEPTH) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") {
      log.error("could not list the subagents directory", {
        dir,
        error: (err as Error).message,
      });
    }
    return [];
  }
  const byId = new Map<string, AgentFiles>();
  const out: AgentFiles[] = [];
  const slot = (agentId: string): AgentFiles => {
    let s = byId.get(agentId);
    if (!s) {
      s = { agentId };
      byId.set(agentId, s);
      out.push(s);
    }
    return s;
  };
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAgentFiles(full, depth + 1));
      continue;
    }
    const meta = /^agent-(.+)\.meta\.json$/.exec(entry.name);
    if (meta) {
      slot(meta[1]).metaPath = full;
      continue;
    }
    const jsonl = /^agent-(.+)\.jsonl$/.exec(entry.name);
    if (jsonl) slot(jsonl[1]).jsonlPath = full;
  }
  return out;
}

/** Paths whose meta file we have already complained about, so a retry loop stays quiet. */
const reportedMeta = new Set<string>();

/**
 * Read one meta file. Null means "nothing usable yet": the file is missing or is
 * mid-write (the CLI writes it lazily, and a partial JSON is retried by the
 * callers), both expected. Anything else (permissions, a non-object) is reported
 * once per path, since it would otherwise leave an agent unnamed with no trace.
 */
function readMeta(path: string): AgentMeta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AgentMeta;
    if (!reportedMeta.has(path)) {
      reportedMeta.add(path);
      log.error("agent meta file is not a JSON object", { path });
    }
    return null;
  } catch (err) {
    if (err instanceof SyntaxError || errnoCode(err) === "ENOENT") return null;
    if (!reportedMeta.has(path)) {
      reportedMeta.add(path);
      log.error("could not read agent meta file", { path, error: (err as Error).message });
    }
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** What a `SendMessage` tool input says. */
export interface ParsedSendMessage {
  to: string;
  kind: string;
  summary?: string;
  text: string;
  /** Present on a shutdown response: whether the teammate agreed to stop. */
  approve?: boolean;
}

/** Read the recipient, kind, summary and text out of a `SendMessage` tool input. */
export function parseSendMessageInput(input: unknown): ParsedSendMessage {
  const rec = isRecord(input) ? input : {};
  const raw = rec.message;
  const to = typeof rec.to === "string" ? rec.to : "";
  let kind = "message";
  if (typeof rec.type === "string") kind = rec.type;
  else if (isRecord(raw) && typeof raw.type === "string") kind = raw.type;

  let text = "";
  if (typeof raw === "string") text = raw;
  else if (isRecord(raw) && typeof raw.reason === "string") text = raw.reason;
  else if (typeof rec.content === "string") text = rec.content;
  else if (raw !== undefined) {
    try {
      text = JSON.stringify(raw);
    } catch {
      // Input arrives as parsed JSON so this cannot happen; the guard keeps an
      // odd value from taking the hook handler down.
      text = String(raw);
    }
  }

  let approve: boolean | undefined;
  if (typeof rec.approve === "boolean") approve = rec.approve;
  else if (isRecord(raw) && typeof raw.approve === "boolean") approve = raw.approve;

  return {
    to,
    kind,
    summary: typeof rec.summary === "string" ? rec.summary : undefined,
    text,
    approve,
  };
}

interface WatchEntry {
  bus: SessionBus;
  watcher: TranscriptWatcher | null;
  ready: Promise<void>;
}

interface AgentRegistryDeps {
  sessionId: string;
  /** The lead's bus, searched to find which agent a spawn call belongs to. */
  mainBus: SessionBus;
  /** `<projectDir>/<sessionId>/subagents`, derived without any hook context. */
  subagentsDir: () => string | null;
}

type RegistryEvents = {
  update: [AgentNode];
  message: [AgentMessage];
};

/**
 * Everything a session knows about the agents it has spawned.
 *
 * Disk is the source of truth, hooks only add liveness:
 *  - `subagents/**\/agent-<id>.meta.json` names each agent and links it to the
 *    parent's spawning tool call, so a scan alone rebuilds the whole tree,
 *    including for a session resumed long after its agents finished.
 *  - SubagentStart/Stop say when one is running.
 *  - Each agent's `agent-<id>.jsonl` is an ordinary transcript, so it is tailed
 *    by the same `TranscriptWatcher` into a per-agent child bus. That bus is
 *    addressed as a *virtual session* (`agentStreamId`), which is what lets the
 *    existing stream/history machinery render it unchanged.
 */
export class AgentRegistry extends EventEmitter<RegistryEvents> {
  private readonly nodes = new Map<string, AgentNode>();
  private readonly watchers = new Map<string, WatchEntry>();
  private readonly jsonlPaths = new Map<string, string>();
  private readonly metaPaths = new Map<string, string>();
  private readonly activityTimers = new Map<string, NodeJS.Timeout>();
  private readonly messages: AgentMessage[] = [];
  private readonly messageIds = new Set<string>();
  /**
   * Agents that told the lead they agree to shut down (by agent id, from the
   * hook's own `agent_id`). Their next stop is final. A request alone proves
   * nothing: a teammate stops after every message it handles, and may decline.
   * It wakes to answer the request (a SubagentStart) before stopping, so a start
   * must not clear this.
   */
  private readonly shutdownApproved = new Set<string>();
  /** Authoritative once any hook has run: the CLI's own view of the path. */
  private hookDir: string | null = null;
  private disposed = false;

  constructor(private readonly deps: AgentRegistryDeps) {
    super();
    this.setMaxListeners(50);
  }

  handleStart(p: SubagentStartPayload): void {
    this.learnDir(p.transcript_path, p.session_id);
    const node = this.ensureNode(p.agent_id, p.agent_type);
    this.setStatus(node, "running");
    node.lastActivityAt = Date.now();
    this.emitUpdate(node);
    this.scheduleMetaRefresh(p.agent_id, [150, 600, 1800]);
    void this.ensureWatcher(p.agent_id);
  }

  handleStop(p: SubagentStopPayload): void {
    this.learnDir(p.transcript_path, p.session_id);
    // The CLI also runs internal forked agents that fire a SubagentStop with no
    // matching start and nothing on disk (seen twice per turn on 2.1.322). They
    // are not the user's agents, and a real one always starts first, so a stop
    // for a stranger with no transcript is not worth a node.
    if (!this.nodes.has(p.agent_id) && !this.hasTranscript(p)) return;
    const node = this.ensureNode(p.agent_id, p.agent_type);
    // A stop is "idle", not "done": a teammate stops between messages and starts
    // again. It is finished when meta.json says so (plain subagents), or when it
    // agreed to a shutdown and has now stopped (teammate meta has no flag).
    this.setStatus(node, this.hasAgreedToStop(node) ? "done" : "idle");
    node.lastActivityAt = Date.now();
    if (p.last_assistant_message) node.lastMessage = p.last_assistant_message;
    if (p.agent_transcript_path) this.jsonlPaths.set(p.agent_id, p.agent_transcript_path);
    this.emitUpdate(node);
    this.scheduleMetaRefresh(p.agent_id, [300, 1500]);
    void this.ensureWatcher(p.agent_id);
  }

  /** A `SendMessage` tool call, from the PreToolUse hook. */
  handleSendMessage(p: PreToolUsePayload): void {
    const message = this.recordMessage(
      p.tool_use_id,
      p.agent_id ?? null,
      p.tool_input,
      new Date().toISOString(),
    );
    if (message) this.emit("message", message);
  }

  /**
   * Rebuild what the hooks would have reported, from the transcripts. The
   * message log and shutdown approvals only fill from live hooks, so after a
   * backend restart a session's agent conversation would be empty and every
   * shut-down teammate would read `idle`. Each `SendMessage` is in its sender's
   * own transcript under the same tool_use id the hook carried, so replaying
   * them cannot duplicate a live message. Opening every agent's transcript also
   * lets nested agents find their parents. Safe to call repeatedly.
   */
  backfill(): void {
    this.harvest(this.deps.mainBus, null);
    for (const agentId of this.nodes.keys()) {
      if (this.watchers.has(agentId) || !this.jsonlPaths.has(agentId)) continue;
      void this.ensureWatcher(agentId);
    }
  }

  /** Current agents (oldest first) plus the message log, after re-reading disk. */
  getSnapshot(): { agents: AgentNode[]; messages: AgentMessage[] } {
    this.scan();
    this.backfill();
    const agents = [...this.nodes.values()]
      .map((n) => ({ ...n }))
      .sort((a, b) => a.startedAt - b.startedAt);
    return { agents, messages: [...this.messages] };
  }

  /** Display label for an agent: its teammate name, else its type. */
  labelFor(agentId: string): string | undefined {
    const node = this.nodes.get(agentId);
    return node ? (node.name ?? node.agentType) : undefined;
  }

  hasAgent(agentId: string): boolean {
    return this.nodes.has(agentId);
  }

  /** Whether any agent is running now (the idle reaper must not stop the session). */
  hasRunning(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === "running") return true;
    }
    return false;
  }

  /**
   * The agent's event bus, with its transcript fully drained so a replay sees
   * the whole history. Null when the agent is unknown or its transcript never
   * appeared (callers tell the two apart with `hasAgent`).
   */
  async getAgentBus(agentId: string): Promise<SessionBus | null> {
    this.scan();
    return await this.ensureWatcher(agentId);
  }

  /** Non-blocking variant for callers that only want an already-open bus. */
  peekAgentBus(agentId: string): SessionBus | null {
    return this.watchers.get(agentId)?.bus ?? null;
  }

  /** Rebuild nodes for agents that exist on disk but were never seen live. */
  scan(): void {
    const dir = this.subagentsDir();
    if (!dir) return;
    for (const files of listAgentFiles(dir)) {
      if (files.jsonlPath) this.jsonlPaths.set(files.agentId, files.jsonlPath);
      if (files.metaPath) this.metaPaths.set(files.agentId, files.metaPath);
      if (this.nodes.has(files.agentId)) continue;
      const meta = files.metaPath ? readMeta(files.metaPath) : null;
      const node = this.ensureNode(files.agentId, meta?.agentType ?? "agent", false);
      const stamp = this.fileTimes(files);
      node.startedAt = stamp.created;
      node.lastActivityAt = stamp.modified;
      // Nothing is running that we did not see start: a scan only ever finds
      // history. Whether it could still wake is not knowable from disk.
      if (meta) this.applyMeta(node, meta);
      this.resolveParent(node);
      this.emitUpdate(node);
    }
  }

  /** The PTY that ran these agents is gone (respawn or exit): none are running. */
  settleRunning(): void {
    for (const node of this.nodes.values()) {
      if (node.status !== "running") continue;
      this.setStatus(node, "idle");
      this.emitUpdate(node);
    }
  }

  /** Re-run parent lookup for every agent, e.g. after a transcript replay. */
  reresolveParents(): void {
    for (const node of this.nodes.values()) {
      if (!node.toolUseId) continue;
      const before = node.parentAgentId;
      this.resolveParent(node);
      if (node.parentAgentId !== before) this.emitUpdate(node);
    }
  }

  /** Stop tailing transcripts but keep everything already known. */
  stopWatching(): void {
    for (const entry of this.watchers.values()) entry.watcher?.stop();
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
    for (const entry of this.watchers.values()) entry.bus.dispose();
    this.watchers.clear();
    this.removeAllListeners();
  }

  /**
   * The one place a status changes, so the rules hold everywhere:
   *  - `done` is only left by a start (a wake), never by a later stop or a scan;
   *  - a status other than `running` has no current tool, so `activity` is cleared.
   * Returns whether anything changed.
   */
  private setStatus(node: AgentNode, next: AgentStatus): boolean {
    if (node.status === "done" && next === "idle") return false;
    if (node.status === next) return false;
    node.status = next;
    if (next !== "running") node.activity = undefined;
    return true;
  }

  /**
   * Add one `SendMessage` to the log, in time order. Returns null when it is
   * already known (the hook and the transcript describe the same call) or is
   * not a message at all.
   */
  private recordMessage(
    id: string,
    senderId: string | null,
    input: unknown,
    timestamp: string,
  ): AgentMessage | null {
    if (this.messageIds.has(id)) return null;
    const parsed = parseSendMessageInput(input);
    if (!parsed.to && !parsed.text) {
      // Nothing to show and nobody to show it to: a malformed input, not a message.
      log.info("ignoring a SendMessage with no recipient and no text", { toolUseId: id });
      return null;
    }
    this.messageIds.add(id);
    const message: AgentMessage = {
      id,
      fromAgentId: senderId,
      to: parsed.to,
      toAgentId: this.resolveRecipient(parsed.to),
      kind: parsed.kind,
      summary: parsed.summary,
      text: parsed.text,
      timestamp,
    };
    this.noteShutdownTraffic(senderId ?? undefined, parsed);
    // Live messages arrive in order; harvested ones can be older than what is
    // already here. ISO timestamps compare correctly as strings.
    let at = this.messages.length;
    while (at > 0 && this.messages[at - 1].timestamp > timestamp) at--;
    this.messages.splice(at, 0, message);
    if (this.messages.length > MAX_MESSAGES) {
      const dropped = this.messages.shift();
      if (dropped) this.messageIds.delete(dropped.id);
    }
    return message;
  }

  /** Replay the `SendMessage` calls recorded on one bus (the sender's transcript). */
  private harvest(bus: SessionBus, ownerId: string | null): void {
    for (const event of bus.getEventLog()) {
      if (event.kind !== "tool_call" || event.name !== "SendMessage") continue;
      const message = this.recordMessage(event.toolUseId, ownerId, event.input, event.timestamp);
      if (message) this.emit("message", message);
    }
    if (!ownerId) return;
    // A teammate whose own transcript shows it agreed to stop, and that is not
    // running now, has finished: the hook that would have said so is gone.
    const node = this.nodes.get(ownerId);
    if (node && node.status === "idle" && this.hasAgreedToStop(node)) {
      if (this.setStatus(node, "done")) this.emitUpdate(node);
    }
  }

  /** Record whether a teammate agreed to or declined a shutdown, from its own `SendMessage`. */
  private noteShutdownTraffic(senderId: string | undefined, parsed: ParsedSendMessage): void {
    if (!senderId) return;
    if (
      parsed.kind === "shutdown_approved" ||
      (parsed.kind === "shutdown_response" && parsed.approve !== false)
    ) {
      this.shutdownApproved.add(senderId);
    } else if (
      parsed.kind === "shutdown_rejected" ||
      (parsed.kind === "shutdown_response" && parsed.approve === false)
    ) {
      this.shutdownApproved.delete(senderId);
    }
  }

  private hasAgreedToStop(node: AgentNode): boolean {
    return this.shutdownApproved.has(node.agentId);
  }

  private hasTranscript(p: SubagentStopPayload): boolean {
    if (p.agent_transcript_path && existsSync(p.agent_transcript_path)) return true;
    return this.transcriptPathFor(p.agent_id) !== null;
  }

  private subagentsDir(): string | null {
    return this.hookDir ?? this.deps.subagentsDir();
  }

  private learnDir(transcriptPath: string | undefined, sessionId: string | undefined): void {
    if (!transcriptPath || !sessionId) return;
    this.hookDir = join(dirname(transcriptPath), sessionId, "subagents");
  }

  private fileTimes(files: AgentFiles): { created: number; modified: number } {
    const path = files.metaPath ?? files.jsonlPath;
    const jsonl = files.jsonlPath ?? path;
    const now = Date.now();
    try {
      const first = path ? statSync(path) : null;
      const last = jsonl ? statSync(jsonl) : null;
      return {
        created: first?.birthtimeMs || first?.mtimeMs || now,
        modified: last?.mtimeMs || now,
      };
    } catch (err) {
      // The file vanished between listing and stat: the timestamps are only an
      // ordering hint, so fall back to "now" rather than drop the agent.
      log.info("could not stat an agent file; using the current time", {
        path,
        error: (err as Error).message,
      });
      return { created: now, modified: now };
    }
  }

  private ensureNode(agentId: string, agentType: string, announce = true): AgentNode {
    let node = this.nodes.get(agentId);
    if (!node) {
      const now = Date.now();
      node = {
        agentId,
        streamId: agentStreamId(this.deps.sessionId, agentId),
        agentType,
        parentAgentId: null,
        status: "idle",
        startedAt: now,
        lastActivityAt: now,
      };
      this.nodes.set(agentId, node);
      if (announce) log.debug("agent discovered", { agentId, agentType });
    }
    return node;
  }

  private emitUpdate(node: AgentNode): void {
    if (this.disposed) return;
    this.emit("update", { ...node });
  }

  private scheduleMetaRefresh(agentId: string, delaysMs: number[]): void {
    void (async () => {
      for (const ms of delaysMs) {
        await delay(ms);
        if (this.disposed) return;
        try {
          this.loadMeta(agentId);
        } catch (err) {
          // An unhandled rejection here would take the whole backend down, and
          // the remaining retries would be lost with it.
          log.error("agent meta refresh failed", {
            agentId,
            error: (err as Error).stack ?? (err as Error).message,
          });
        }
      }
    })();
  }

  private loadMeta(agentId: string): void {
    const node = this.nodes.get(agentId);
    if (!node) return;
    let path = this.metaPaths.get(agentId);
    if (!path || !existsSync(path)) {
      const dir = this.subagentsDir();
      const found = dir ? listAgentFiles(dir).find((f) => f.agentId === agentId) : undefined;
      if (found?.jsonlPath) this.jsonlPaths.set(agentId, found.jsonlPath);
      if (found?.metaPath) this.metaPaths.set(agentId, found.metaPath);
      path = found?.metaPath;
    }
    const meta = path ? readMeta(path) : null;
    if (!meta) return;
    const before = JSON.stringify(node);
    this.applyMeta(node, meta);
    this.resolveParent(node);
    if (JSON.stringify(node) !== before) this.emitUpdate(node);
  }

  private applyMeta(node: AgentNode, meta: AgentMeta): void {
    if (meta.agentType) node.agentType = meta.agentType;
    if (meta.name) node.name = meta.name;
    if (meta.description) node.description = meta.description;
    if (meta.toolUseId) node.toolUseId = meta.toolUseId;
    if (typeof meta.spawnDepth === "number") node.spawnDepth = meta.spawnDepth;
    if (meta.requestShape) node.background = meta.requestShape === "background";
    // Only a stopped agent can be "done"; one that is running right now has
    // woken since the flag was written.
    if (meta.finished === true && node.status !== "running") this.setStatus(node, "done");
  }

  /**
   * Which agent spawned this one: the owner of the `Agent` tool call its
   * meta.json names. null means the lead. An owner not yet seen anywhere leaves
   * the parent as it was; `reresolveParents` retries after every transcript
   * replay, nested spawn, meta refresh and resume. Until the spawning agent's
   * own transcript is being tailed, its children show at the top level.
   */
  private resolveParent(node: AgentNode): void {
    if (!node.toolUseId) return;
    const owner = this.ownerOf(node.toolUseId);
    if (owner === undefined || owner === node.agentId) return;
    if (owner !== null && this.leadsBackTo(owner, node.agentId)) {
      log.error("ignoring a parent link that would form a cycle", {
        agentId: node.agentId,
        owner,
      });
      return;
    }
    node.parentAgentId = owner;
  }

  /** True when walking up from `from` reaches `target`, i.e. linking would make a cycle. */
  private leadsBackTo(from: string, target: string): boolean {
    let cursor: string | null = from;
    for (let hops = 0; cursor !== null && hops < MAX_PARENT_HOPS; hops++) {
      if (cursor === target) return true;
      cursor = this.nodes.get(cursor)?.parentAgentId ?? null;
    }
    return false;
  }

  /** null = the lead, string = an agent id, undefined = not seen anywhere yet. */
  private ownerOf(toolUseId: string): string | null | undefined {
    if (hasToolCall(this.deps.mainBus, toolUseId)) return null;
    for (const [agentId, entry] of this.watchers) {
      if (hasToolCall(entry.bus, toolUseId)) return agentId;
    }
    return undefined;
  }

  private resolveRecipient(to: string): string | null | undefined {
    if (!to || to === "*") return undefined;
    for (const node of this.nodes.values()) {
      if (node.agentId === to || node.name === to) return node.agentId;
    }
    // The lead answers to several names: `team-lead` in team protocol messages
    // and `main` from teammates (both observed on 2.1.322). A teammate actually
    // named one of these is matched above, by name, and so wins.
    return /^(team-lead|lead|main)$/.test(to) ? null : undefined;
  }

  private transcriptPathFor(agentId: string): string | null {
    const known = this.jsonlPaths.get(agentId);
    if (known && existsSync(known)) return known;
    const dir = this.subagentsDir();
    if (!dir) return null;
    const direct = join(dir, `agent-${agentId}.jsonl`);
    if (existsSync(direct)) {
      this.jsonlPaths.set(agentId, direct);
      return direct;
    }
    const found = listAgentFiles(dir).find((f) => f.agentId === agentId)?.jsonlPath;
    if (found) this.jsonlPaths.set(agentId, found);
    return found ?? null;
  }

  private async ensureWatcher(agentId: string): Promise<SessionBus | null> {
    const existing = this.watchers.get(agentId);
    if (existing) {
      await existing.ready;
      return this.watchers.get(agentId)?.bus ?? null;
    }
    const node = this.nodes.get(agentId);
    if (!node || this.disposed) return null;

    const entry: WatchEntry = {
      bus: new SessionBus(node.streamId),
      watcher: null,
      ready: Promise.resolve(),
    };
    this.watchers.set(agentId, entry);
    entry.ready = this.startWatcher(agentId, entry).catch((err) => {
      log.error("agent watcher failed", {
        agentId,
        error: (err as Error).stack ?? (err as Error).message,
      });
      this.dropWatcher(agentId, entry);
    });
    await entry.ready;
    return this.watchers.get(agentId)?.bus ?? null;
  }

  /** Forget a watcher so the next start, stop or subscribe tries again. */
  private dropWatcher(agentId: string, entry: WatchEntry): void {
    entry.watcher?.stop();
    entry.bus.dispose();
    if (this.watchers.get(agentId) === entry) this.watchers.delete(agentId);
  }

  private async startWatcher(agentId: string, entry: WatchEntry): Promise<void> {
    // The transcript is created a beat after SubagentStart, and the CLI makes
    // the subagents/ directory lazily: wait for the file rather than watch a
    // directory that may not exist yet (the watcher would give up for good).
    let path: string | null = null;
    for (let i = 0; i < 24 && !this.disposed; i++) {
      path = this.transcriptPathFor(agentId);
      if (path) break;
      await delay(250);
    }
    if (!path || this.disposed) {
      if (!this.disposed) {
        // Visible at the default log level: this is what a "transcript not found"
        // in the sheet traces back to. The next stop or subscribe retries.
        log.info("agent transcript never appeared; will retry on the next event", {
          agentId,
          subagentsDir: this.subagentsDir(),
        });
      }
      this.dropWatcher(agentId, entry);
      return;
    }
    entry.bus.on("event", (event) => {
      if (event.kind !== "tool_call") return;
      this.noteActivity(agentId, event.name);
      if (SPAWN_TOOLS.has(event.name)) this.reresolveParents();
    });
    const watcher = new TranscriptWatcher(path, entry.bus);
    entry.watcher = watcher;
    await watcher.start();
    // History was replayed silently, so seed the activity hint from it.
    const events = entry.bus.getEventLog();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.kind === "tool_call") {
        const node = this.nodes.get(agentId);
        if (node && node.status === "running" && !node.activity) node.activity = ev.name;
        break;
      }
    }
    // Its own SendMessage calls (and any shutdown it agreed to) are now known.
    this.harvest(entry.bus, agentId);
    // Spawns made by this agent are now visible; settle any child waiting on them.
    this.reresolveParents();
  }

  /** Record what an agent is doing, coalescing bursts into one update. */
  private noteActivity(agentId: string, tool: string): void {
    const node = this.nodes.get(agentId);
    if (!node) return;
    node.activity = tool;
    node.lastActivityAt = Date.now();
    if (this.activityTimers.has(agentId)) return;
    this.activityTimers.set(
      agentId,
      setTimeout(() => {
        this.activityTimers.delete(agentId);
        const current = this.nodes.get(agentId);
        if (current) this.emitUpdate(current);
      }, ACTIVITY_EMIT_MS),
    );
  }
}

/** Ids are kept apart from the event log, so this survives the log's retention cap. */
function hasToolCall(bus: SessionBus, toolUseId: string): boolean {
  return bus.hasToolCall(toolUseId);
}
