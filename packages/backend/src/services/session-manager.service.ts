import type { SessionConfig, SessionInfo } from "common/types";
import { Session } from "../session/session.js";
import type { ServerConfig } from "../types/index.js";
import { LoggerService } from "./logger.service.js";
import type { SessionBus } from "./session-bus.service.js";

const log = LoggerService.scoped("session-manager");

export class SessionManager {
  private byToken = new Map<string, Session>();
  private byId = new Map<string, Session>();
  private hooksBaseUrl = "";

  constructor(private serverConfig: ServerConfig) {}

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
      // `alive` is not optional: `stop()` leaves the session in `byId` (only
      // `remove()` evicts it), so a hit can be a session whose PTY is already
      // gone. Returning that would replace a duplicate-PTY bug with a worse
      // one — a client attached to a corpse, with no process behind it.
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
    });
    this.byToken.set(session.spawnToken, session);

    const register = (id: string) => {
      this.byId.set(id, session);
    };
    if (session.resolved) register(session.id);
    else session.once("idResolved", register);

    session.on("exit", () => {
      log.info("Session exited", { token: session.spawnToken });
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

  list(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const session of this.byToken.values()) {
      const info = session.getInfo();
      if (info) infos.push(info);
    }
    return infos;
  }

  stop(id: string): boolean {
    const session = this.byId.get(id);
    if (!session) return false;
    session.stop();
    return true;
  }

  remove(id: string): boolean {
    const session = this.byId.get(id);
    if (!session) return false;
    session.stop();
    this.byId.delete(id);
    this.byToken.delete(session.spawnToken);
    return true;
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
    for (const session of this.byToken.values()) {
      session.stop();
    }
  }
}
