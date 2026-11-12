import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { resolveCliReference } from "./services/cli-version.service.js";
import { HooksService } from "./services/hooks.service.js";
import { LoggerService } from "./services/logger.service.js";
import { modelCatalog } from "./services/model-catalog.service.js";
import { reapOrphans } from "./services/orphan-reaper.service.js";
import { SessionManager } from "./services/session-manager.service.js";
import { handleSessionEvicted, isSessionWatched } from "./services/ws.service.js";

// Load packages/backend/.env relative to the compiled file (dist/index.js ->
// ../.env), so the vars apply regardless of cwd. Must run before loadConfig().
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const log = LoggerService.scoped("init");

const config = loadConfig();

// Before anything can spawn: kill PTYs left by a previous backend that died
// without running `shutdown`, and clear the registry either way. A survivor
// would be detached and unreachable, and reopening its session would put a
// second `claude --resume` on the same transcript. Safe here because the backend
// binds a fixed port: if we are starting, nothing else owns them. (Whether a PTY
// actually survives is unproven — see the note in orphan-reaper.service.ts.)
const reaped = reapOrphans();
if (reaped > 0) log.warn("Reaped orphaned PTYs from a previous run", { count: reaped });

// The installed binary's version is the drift reference for every session's
// reported version. Resolved once, here, because the spawned `claude` can't
// change underneath a running backend without a restart anyway.
const cliReference = await resolveCliReference(config.claudeBin);

// The user's default model is an alias seen working, so stale-alias
// reconciliation may use it (see model-catalog.service.ts).
modelCatalog.loadUserSettings();

const sessionManager = new SessionManager(config, cliReference.version);

const hooksService = new HooksService((token) => sessionManager.getHookTarget(token));

const hooksPort = await hooksService.start(config.hooksPort);
sessionManager.setHooksBaseUrl(hooksService.baseUrl());

// A stopped session is dropped from the registry (see SessionManager.evict).
// When a resume of the same id is already running, its approvals and its
// subscribers belong to it, so leave both alone.
sessionManager.on("evicted", (session) => {
  if (!session.resolved || sessionManager.get(session.id)) return;
  hooksService.dropSession(session.id);
  handleSessionEvicted(session);
});
sessionManager.startIdleReaper({
  isWatched: isSessionWatched,
  hasPendingApproval: (id) => hooksService.hasPendingApproval(id),
});

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
