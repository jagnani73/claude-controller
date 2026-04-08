import { readdirSync } from "node:fs";
import { normalize, resolve } from "node:path";
import type { DirListData, EffortLevel, WsMessage } from "common/types";
import type { WebSocket } from "ws";
import type { Session } from "../session/session.js";
import type { ClientState, ServerConfig } from "../types/index.js";
import { LoggerService } from "./logger.service.js";
import type { SessionManager } from "./session-manager.service.js";

const log = LoggerService.scoped("ws");

const clients = new Map<WebSocket, ClientState>();

function send(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function listChildDirs(dirPath: string, workDir: string): string[] {
    const resolved = resolve(dirPath);
    const normalizedWork = normalize(workDir);
    if (!resolved.startsWith(normalizedWork)) {
        return [];
    }
    try {
        return readdirSync(resolved, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("."))
            .map((d) => d.name)
            .sort();
    } catch {
        return [];
    }
}

function subscribeToSession(ws: WebSocket, session: Session): void {
    const state = clients.get(ws);
    if (!state) return;

    if (state.cleanup) {
        state.cleanup();
    }

    log.info("Client subscribing to session", { sessionId: session.id });

    const replayData = session.getReplayBuffer();
    log.debug("Replaying buffer", { chunks: replayData.length });
    for (const chunk of replayData) {
        send(ws, {
            type: "stream",
            sessionId: session.id,
            data: { raw: chunk },
            timestamp: Date.now(),
        });
    }

    const onOutput = (data: string) => {
        send(ws, {
            type: "stream",
            sessionId: session.id,
            data: { raw: data },
            timestamp: Date.now(),
        });
    };

    const onExit = () => {
        send(ws, {
            type: "disconnected",
            sessionId: session.id,
            timestamp: Date.now(),
        });
    };

    session.on("output", onOutput);
    session.on("exit", onExit);

    state.subscribedSessionId = session.id;
    state.cleanup = () => {
        session.off("output", onOutput);
        session.off("exit", onExit);
    };

    send(ws, {
        type: "session_metadata",
        sessionId: session.id,
        data: session.getInfo(),
        timestamp: Date.now(),
    });
}

function handleMessage(
    ws: WebSocket,
    msg: WsMessage,
    sessionManager: SessionManager,
    config: ServerConfig,
): void {
    switch (msg.type) {
        case "input": {
            const session = msg.sessionId
                ? sessionManager.get(msg.sessionId)
                : null;
            if (!session) {
                log.warn("Input to unknown session", {
                    sessionId: msg.sessionId,
                });
                send(ws, {
                    type: "error",
                    data: { message: "Session not found" },
                    timestamp: Date.now(),
                });
                return;
            }
            const data = msg.data as { text: string };
            log.debug("Forwarding input to session", {
                sessionId: session.id,
                length: data.text.length,
            });
            session.sendInput(data.text);
            break;
        }

        case "command": {
            const data = msg.data as Record<string, unknown>;

            if (data.action === "create_session") {
                const sessionConfig = data.config as {
                    cwd: string;
                    model: string;
                    permissionMode: string;
                    effort?: string;
                    name?: string;
                    tags?: string[];
                };
                log.info("Creating session", sessionConfig);
                const session = sessionManager.create({
                    cwd: sessionConfig.cwd,
                    model: sessionConfig.model as "opus" | "sonnet" | "haiku",
                    permissionMode: sessionConfig.permissionMode as
                        | "default"
                        | "plan",
                    effort: sessionConfig.effort as EffortLevel | undefined,
                    name: sessionConfig.name,
                    tags: sessionConfig.tags,
                });
                subscribeToSession(ws, session);

                // Auto-send /effort after PTY is ready
                if (sessionConfig.effort) {
                    setTimeout(() => {
                        session.sendSlashCommand(
                            `/effort ${sessionConfig.effort}`,
                        );
                    }, 3000);
                }
                return;
            }

            if (data.action === "stop_session") {
                const id = (data.sessionId ?? msg.sessionId) as string;
                log.info("Stopping session", { sessionId: id });
                sessionManager.stop(id);
                return;
            }

            if (data.action === "list_sessions") {
                log.debug("Listing sessions");
                send(ws, {
                    type: "connected",
                    data: { sessions: sessionManager.list() },
                    timestamp: Date.now(),
                });
                return;
            }

            if (data.action === "list_dirs") {
                const dirPath = (data.path as string) || config.workDir;
                log.debug("Listing directories", { path: dirPath });
                const dirs = listChildDirs(dirPath, config.workDir);
                const response: DirListData = {
                    path: resolve(dirPath),
                    dirs,
                };
                send(ws, {
                    type: "dir_list",
                    data: response,
                    timestamp: Date.now(),
                });
                return;
            }

            if (data.action === "subscribe") {
                const id = (data.sessionId ?? msg.sessionId) as string;
                const session = sessionManager.get(id);
                if (!session) {
                    log.warn("Subscribe to unknown session", {
                        sessionId: id,
                    });
                    send(ws, {
                        type: "error",
                        data: { message: "Session not found" },
                        timestamp: Date.now(),
                    });
                    return;
                }
                subscribeToSession(ws, session);
                return;
            }

            // Slash command
            if (data.text) {
                const session = msg.sessionId
                    ? sessionManager.get(msg.sessionId)
                    : null;
                if (session) {
                    log.debug("Forwarding slash command", {
                        sessionId: session.id,
                        command: data.text,
                    });
                    session.sendSlashCommand(data.text as string);
                }
            }
            break;
        }

        case "approve": {
            const session = msg.sessionId
                ? sessionManager.get(msg.sessionId)
                : null;
            if (session) {
                log.info("Approving", { sessionId: session.id });
                session.approve();
            }
            break;
        }

        case "deny": {
            const session = msg.sessionId
                ? sessionManager.get(msg.sessionId)
                : null;
            if (session) {
                log.info("Denying", { sessionId: session.id });
                session.deny();
            }
            break;
        }
    }
}

export function handleConnection(
    ws: WebSocket,
    sessionManager: SessionManager,
    config: ServerConfig,
): void {
    clients.set(ws, { subscribedSessionId: null, cleanup: null });

    log.info("Client connected");

    // Send session list + workDir on connect
    send(ws, {
        type: "connected",
        data: {
            sessions: sessionManager.list(),
            workDir: config.workDir,
        },
        timestamp: Date.now(),
    });

    ws.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw.toString()) as WsMessage;
            handleMessage(ws, msg, sessionManager, config);
        } catch (err) {
            log.error("Invalid message received", { error: err });
            send(ws, {
                type: "error",
                data: { message: "Invalid message format" },
                timestamp: Date.now(),
            });
        }
    });

    ws.on("close", () => {
        log.info("Client disconnected");
        const state = clients.get(ws);
        if (state?.cleanup) state.cleanup();
        clients.delete(ws);
    });
}
