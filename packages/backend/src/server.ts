import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { HooksService } from "./services/hooks.service.js";
import { LoggerService } from "./services/logger.service.js";
import type { SessionManager } from "./services/session-manager.service.js";
import { handleConnection } from "./services/ws.service.js";
import type { ServerConfig } from "./types/index.js";
import { getAllowedOrigins, isOriginAllowed, isProduction } from "./utils/constants.js";

const log = LoggerService.scoped("server");

function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
  hooksService: HooksService,
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

  if (isProduction() && getAllowedOrigins().length === 0) {
    log.warn(
      "Running in production with no ALLOWED_ORIGINS set — all cross-origin WebSocket connections will be rejected. Set ALLOWED_ORIGINS to your tailnet hostname (e.g. https://laptop.tailnet-name.ts.net).",
    );
  }

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin }: { origin?: string }) => isOriginAllowed(origin),
  });

  wss.on("connection", (ws) => {
    handleConnection(ws, sessionManager, hooksService, config);
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
