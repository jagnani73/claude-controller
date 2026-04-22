import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { HooksService } from "./services/hooks.service.js";
import { LoggerService } from "./services/logger.service.js";
import { SessionManager } from "./services/session-manager.service.js";
import { TranscriptWatcher } from "./services/transcript.service.js";

const log = LoggerService.scoped("init");

const config = loadConfig();
const sessionManager = new SessionManager(config);

const hooksService = new HooksService(
  (sessionId) => sessionManager.getBus(sessionId),
  (sessionId, transcriptPath) => {
    const bus = sessionManager.getBus(sessionId);
    if (!bus) {
      throw new Error(`Cannot create transcript watcher — no bus for session ${sessionId}`);
    }
    return new TranscriptWatcher(transcriptPath, bus);
  },
);

const hooksPort = await hooksService.start();
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
