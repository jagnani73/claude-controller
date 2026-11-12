import { EventEmitter } from "node:events";
import type { SessionConfig, SessionInfo } from "common/types";
import { Session } from "../session/session.js";
import type { ServerConfig } from "../types/index.js";
import type { HookTarget } from "./hooks.service.js";
import { LoggerService } from "./logger.service.js";
import type { SessionBus } from "./session-bus.service.js";

const log = LoggerService.scoped("session-manager");

/** How long after `stop()` a session is evicted even if its PTY never reports an exit. */
const EVICT_FALLBACK_MS = 5_000;

/** What the idle reaper needs to know that a `Session` cannot see for itself. */
export interface IdleProbes {
  /** A client is subscribed to the session or to one of its agents. */
  isWatched(sessionId: string): boolean;
  /** A PermissionRequest (approval or AskUserQuestion) is held for it. */
  hasPendingApproval(sessionId: string): boolean;
}

type ManagerEvents = {
  /**
   * A stopped session was dropped from the registry. Emitted after its `exit`
   * listeners ran (subscribers have sent `session_stopped`).
   */
  evicted: [Session];
};

export class SessionManager extends EventEmitter<ManagerEvents> {
  private byToken = new Map<string, Session>();
  private byId = new Map<string, Session>();
  private hooksBaseUrl = "";
  private idleTimer: NodeJS.Timeout | null = null;
  /** Last sweep that found a client watching each session (see reapIdle). */
  private readonly lastWatchedAt = new WeakMap<Session, number>();

  /**
   * `cliReferenceVersion` is the installed Claude Code version resolved at
   * startup; sessions classify their reported version against it.
   */
  constructor(
    private serverConfig: ServerConfig,
    private cliReferenceVersion?: string,
  ) {
    super();
  }

  /** Called once the hooks HTTP listener is bound. */
  setHooksBaseUrl(url: string): void {
    this.hooksBaseUrl = url;
  }

  /**
   * Spawn a session, or return the running one when `resumeSessionId` names a
   * session this manager already has.
   *
   * Without that check a second create for the same id spawns a *second* PTY,
   * and `byId.set` then overwrites the first — leaving a `claude --resume`
   * process that no client can reach but that is still attached to the same
   * transcript JSONL. Two writers on one transcript is the real hazard; the
   * unreachable process is merely how it goes unnoticed. Observed live: a
   * single session id ended up with two PTYs after the client sent `subscribe`
   * and `create_session` for it in quick succession.
   *
   * Only guards within this process. A PTY orphaned by a *backend restart* is
   * not in the registry, so reopening its session still spawns a second one —
   * see the note on graceful shutdown in `stopAll`.
   */
  create(config: SessionConfig): Session {
    if (!this.hooksBaseUrl) {
      throw new Error(
        "SessionManager: hooksBaseUrl not set — call setHooksBaseUrl() before create()",
      );
    }
    if (config.resumeSessionId) {
      const existing = this.byId.get(config.resumeSessionId);
      // `alive` is not optional: a stopped session stays in `byId` until its PTY
      // exit evicts it (up to EVICT_FALLBACK_MS), so a hit can be a session
      // whose PTY is already gone. Returning that would replace a duplicate-PTY
      // bug with a worse one — a client attached to a corpse, with no process
      // behind it.
      if (existing?.alive) {
        log.info("Reusing running session instead of spawning a duplicate", {
          id: config.resumeSessionId,
          token: existing.spawnToken,
        });
        return existing;
      }
    }
    const session = new Session(config, {
      serverConfig: this.serverConfig,
      hooksBaseUrl: this.hooksBaseUrl,
      cliReferenceVersion: this.cliReferenceVersion,
    });
    this.byToken.set(session.spawnToken, session);

    const register = (id: string) => {
      this.byId.set(id, session);
    };
    if (session.resolved) register(session.id);
    else session.once("idResolved", register);

    session.on("exit", () => {
      log.info("Session exited", { token: session.spawnToken });
      // Deferred so the exit listeners attached after this one (each subscriber
      // telling its client `session_stopped`) run before the session is dropped.
      setImmediate(() => this.evict(session));
    });

    return session;
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  /** Resolve a SessionBus by the spawn token embedded in the hook URL path. */
  getBus(spawnToken: string): SessionBus | null {
    const session = this.byToken.get(spawnToken);
    return session?.resolved ? session.bus : null;
  }

  /** Bus + agent registry for a hook POST, by the spawn token in its URL. */
  getHookTarget(spawnToken: string): HookTarget | null {
    const session = this.byToken.get(spawnToken);
    return session?.resolved ? { bus: session.bus, agents: session.agents } : null;
  }

  list(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const session of this.byToken.values()) {
      const info = session.getInfo();
      if (info) infos.push(info);
    }
    return infos;
  }

  /** Stop a session's PTY; it is evicted once the PTY exits. */
  stop(id: string): boolean {
    const session = this.byId.get(id);
    if (!session) return false;
    this.stopAndEvict(session);
    return true;
  }

  /** Stop a session and evict it at once, without waiting for its PTY to exit. */
  remove(id: string): boolean {
    const session = this.byId.get(id);
    if (!session) return false;
    session.stop();
    this.evict(session);
    return true;
  }

  private stopAndEvict(session: Session): void {
    session.stop();
    // Normally the PTY's exit evicts the session. One that was already gone (or
    // a kill that never reports) emits no exit, so don't rely on it alone.
    setTimeout(() => this.evict(session), EVICT_FALLBACK_MS).unref();
  }

  /**
   * Drop a stopped session so nothing keeps it: the registry, its listeners,
   * and (via `stop()`, idempotent) its transcript/statusline watchers, agent
   * registry and timers. A natural PTY exit never called `stop()`, so this is
   * where that cleanup happens. Identity-checked: a resume of the same id may
   * already have replaced this session in `byId`. Reopening the session goes
   * through the ordinary resume path; its id and transcript are untouched.
   */
  private evict(session: Session): void {
    let removed = false;
    if (this.byToken.get(session.spawnToken) === session) {
      this.byToken.delete(session.spawnToken);
      removed = true;
    }
    if (session.resolved && this.byId.get(session.id) === session) {
      this.byId.delete(session.id);
      removed = true;
    }
    if (!removed) return;
    session.stop();
    log.info("Evicted stopped session", {
      id: session.resolved ? session.id : undefined,
      token: session.spawnToken,
      remaining: this.byToken.size,
    });
    this.emit("evicted", session);
  }

  /**
   * Stop sessions nobody is using. Opening a past chat spawns `claude --resume`,
   * and without this the process lived until an explicit Stop or a backend
   * shutdown. A session is stopped only when ALL hold for
   * `serverConfig.idleStopMs`: no client subscribed (to it or one of its
   * agents), no turn in flight or tool running, no pending approval / question
   * / plan picker, no running agent, no respawn, and it has a transcript to
   * resume from. Reopening it resumes transparently.
   */
  startIdleReaper(probes: IdleProbes): void {
    const timeoutMs = this.serverConfig.idleStopMs;
    if (timeoutMs <= 0) {
      log.info("Idle stop disabled");
      return;
    }
    const sweepMs = Math.min(60_000, Math.max(1_000, Math.floor(timeoutMs / 4)));
    this.idleTimer = setInterval(() => this.reapIdle(probes, timeoutMs), sweepMs);
    this.idleTimer.unref();
    log.info("Idle stop enabled", { idleStopMs: timeoutMs, sweepMs });
  }

  private reapIdle(probes: IdleProbes, timeoutMs: number): void {
    const now = Date.now();
    for (const session of [...this.byToken.values()]) {
      if (!session.resolved || !session.alive) continue;
      const id = session.id;
      // Watching counts as activity, so a session the phone just left gets the
      // full timeout rather than being stopped on the next sweep.
      if (probes.isWatched(id)) {
        this.lastWatchedAt.set(session, now);
        continue;
      }
      if (session.idleBlocker() !== null) continue;
      if (probes.hasPendingApproval(id)) continue;
      if (!session.resumable) continue;
      const idleSince = Math.max(session.lastActivityAt, this.lastWatchedAt.get(session) ?? 0);
      if (now - idleSince < timeoutMs) continue;
      log.info("Stopping idle session", {
        id,
        token: session.spawnToken,
        idleForMs: now - idleSince,
      });
      this.stopAndEvict(session);
    }
  }

  /**
   * Kill every PTY. Wired to SIGINT/SIGTERM in `index.ts`, which covers Ctrl+C.
   *
   * It does NOT cover a hard kill — anything terminating the process without a
   * signal skips this entirely. Whether the PTYs then survive is unresolved:
   * two live tests on Windows showed ConPTY killing the children along with the
   * parent. `orphan-reaper.service.ts` covers the case where they don't, and
   * documents how little of it is proven.
   */
  stopAll(): void {
    log.info("Stopping all sessions", { count: this.byToken.size });
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const session of this.byToken.values()) {
      session.stop();
    }
  }
}
