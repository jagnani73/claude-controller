import { resolve } from "node:path";
import type { ServerConfig } from "./types/index.js";
import {
  DEFAULT_CLAUDE_BIN,
  DEFAULT_DUMP_DIR,
  DEFAULT_HOOKS_PORT,
  DEFAULT_HOST,
  DEFAULT_IDLE_STOP_MINUTES,
  DEFAULT_PORT,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  isProduction,
} from "./utils/constants.js";

export function loadConfig(): ServerConfig {
  const workDir = process.env.WORK_DIR;
  if (!workDir) {
    throw new Error(
      "WORK_DIR is required — set it in packages/backend/.env to the directory your projects live in (where sessions spawn).",
    );
  }
  return {
    port: Number(process.env.PORT || DEFAULT_PORT),
    host: process.env.HOST || DEFAULT_HOST,
    hooksPort: Number(process.env.HOOKS_PORT || DEFAULT_HOOKS_PORT),
    dumpDir: resolve(process.env.DUMP_DIR || DEFAULT_DUMP_DIR),
    // PTY captures are a debug aid only — never write them in production.
    capturePty: !isProduction(),
    workDir: resolve(workDir),
    claudeBin: process.env.CLAUDE_BIN?.trim() || DEFAULT_CLAUDE_BIN,
    pty: {
      cols: Number(process.env.PTY_COLS || DEFAULT_PTY_COLS),
      rows: Number(process.env.PTY_ROWS || DEFAULT_PTY_ROWS),
    },
    idleStopMs: idleStopMs(process.env.IDLE_STOP_MINUTES),
  };
}

/** `IDLE_STOP_MINUTES` (fractions allowed; 0 disables) in ms, or the default. */
function idleStopMs(raw: string | undefined): number {
  const minutes = raw?.trim() ? Number(raw) : DEFAULT_IDLE_STOP_MINUTES;
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_STOP_MINUTES * 60_000;
  return Math.round(minutes * 60_000);
}
