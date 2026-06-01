import { resolve } from "node:path";
import type { ServerConfig } from "./types/index.js";
import {
  DEFAULT_DUMP_DIR,
  DEFAULT_HOOKS_PORT,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
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
    workDir: resolve(workDir),
    pty: {
      cols: Number(process.env.PTY_COLS || DEFAULT_PTY_COLS),
      rows: Number(process.env.PTY_ROWS || DEFAULT_PTY_ROWS),
    },
  };
}
