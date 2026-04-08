import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { LoggerService } from "./services/logger.service.js";
import { SessionManager } from "./services/session-manager.service.js";

const log = LoggerService.scoped("init");

const config = loadConfig();
const sessionManager = new SessionManager(config);
const server = startServer(config, sessionManager);

log.info("Claude Controller server started", {
    port: config.port,
    host: config.host,
});

function shutdown() {
    log.info("Shutting down...");
    sessionManager.stopAll();
    server.close();
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.on("SIGTERM", shutdown);
