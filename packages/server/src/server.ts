import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { LoggerService } from "./services/logger.service.js";
import type { SessionManager } from "./services/session-manager.service.js";
import { handleConnection } from "./services/ws.service.js";
import type { ServerConfig } from "./types/index.js";

const log = LoggerService.scoped("server");

export function startServer(
    config: ServerConfig,
    sessionManager: SessionManager,
): { close: () => void } {
    const httpServer = createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    status: "ok",
                    sessions: sessionManager.list().length,
                }),
            );
            return;
        }

        res.writeHead(404);
        res.end("Not found");
    });

    const wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws) => {
        handleConnection(ws, sessionManager);
    });

    httpServer.listen(config.port, config.host, () => {
        log.info(`Listening on ws://${config.host}:${config.port}`);
    });

    return {
        close: () => {
            log.info("Shutting down HTTP + WS server");
            wss.close();
            httpServer.close();
        },
    };
}
