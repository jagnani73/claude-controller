import type { SessionConfig, SessionInfo } from "common/types";
import { Session } from "../session/session.js";
import type { ServerConfig } from "../types/index.js";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("session-manager");

export class SessionManager {
    private sessions = new Map<string, Session>();

    constructor(private serverConfig: ServerConfig) {}

    create(config: SessionConfig): Session {
        const session = new Session(config, this.serverConfig);
        this.sessions.set(session.id, session);

        session.on("exit", () => {
            log.info("Session exited", { id: session.id });
        });

        return session;
    }

    get(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    list(): SessionInfo[] {
        return Array.from(this.sessions.values()).map((s) => s.getInfo());
    }

    stop(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;
        session.stop();
        return true;
    }

    remove(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;
        session.stop();
        this.sessions.delete(id);
        return true;
    }

    stopAll(): void {
        log.info("Stopping all sessions", { count: this.sessions.size });
        for (const session of this.sessions.values()) {
            session.stop();
        }
    }
}
