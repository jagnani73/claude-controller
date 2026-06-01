import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { HooksService } from "./services/hooks.service.js";
import { LoggerService } from "./services/logger.service.js";
import { SessionManager } from "./services/session-manager.service.js";

// Load packages/backend/.env relative to the compiled file (dist/index.js ->
// ../.env), so the vars apply regardless of cwd. Must run before loadConfig().
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const log = LoggerService.scoped("init");

const config = loadConfig();
const sessionManager = new SessionManager(config);

const hooksService = new HooksService((sessionId) => sessionManager.getBus(sessionId));

const hooksPort = await hooksService.start(config.hooksPort);
sessionManager.setHooksBaseUrl(hooksService.baseUrl());

const server = startServer(config, sessionManager, hooksService);

log.info("Claude Controller server started", {
  port: config.port,
  host: config.host,
  hooksPort,
});

function shutdown() {
  log.info("Shutting down...");
  sessionManager.stopAll();
  hooksService.stop();
  server.close();
  // Give PTY processes 3s to close gracefully before force-exiting
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.on("SIGTERM", shutdown);

// Don't let a single throw inside an async timer/promise tear the process
// down — log and keep serving. Genuine crashes still surface in logs.
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error("unhandledRejection", { error: err.message, stack: err.stack });
});
