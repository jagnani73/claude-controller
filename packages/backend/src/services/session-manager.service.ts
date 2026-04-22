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

  create(config: SessionConfig): Session {
    if (!this.hooksBaseUrl) {
      throw new Error(
        "SessionManager: hooksBaseUrl not set — call setHooksBaseUrl() before create()",
      );
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

  stopAll(): void {
    log.info("Stopping all sessions", { count: this.byToken.size });
    for (const session of this.byToken.values()) {
      session.stop();
    }
  }
}
