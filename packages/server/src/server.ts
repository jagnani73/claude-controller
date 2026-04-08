import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { LoggerService } from "./services/logger.service.js";
import type { SessionManager } from "./services/session-manager.service.js";
import { handleConnection } from "./services/ws.service.js";
import type { ServerConfig } from "./types/index.js";
import { getAllowedOrigins } from "./utils/constants.js";

const log = LoggerService.scoped("server");

function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    const allowed = getAllowedOrigins();

    if (origin) {
        const isAllowed = allowed.some((o) =>
            typeof o === "string" ? o === origin : o.test(origin),
        );
        if (isAllowed) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization, ngrok-skip-browser-warning",
            );
        }
    }

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return true;
    }

    return false;
}

export function startServer(
    config: ServerConfig,
    sessionManager: SessionManager,
): { close: () => void } {
    const httpServer = createServer((req, res) => {
        if (handleCors(req, res)) return;

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

    const allowed = getAllowedOrigins();
    const wss = new WebSocketServer({
        server: httpServer,
        verifyClient: ({ origin }: { origin?: string }) => {
            if (!origin || allowed.length === 0) return true;
            return allowed.some((o) =>
                typeof o === "string" ? o === origin : o.test(origin),
            );
        },
    });

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
