import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ControllerConfig } from "common/types";
import type { ServerConfig } from "./types/index.js";
import {
  DEFAULT_DUMP_DIR,
  DEFAULT_HOOKS_PORT,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
} from "./utils/constants.js";

function findConfigFile(): string | null {
  let dir = resolve(".");
  const root = resolve("/");
  while (dir !== root) {
    const candidate = resolve(dir, "controller.config.json");
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, "..");
  }
  return null;
}

function loadControllerConfig(): { config: ControllerConfig; rootDir: string } {
  const configPath = findConfigFile();
  if (configPath) {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return { config, rootDir: dirname(configPath) };
  }
  return { config: { workDir: "." }, rootDir: resolve(".") };
}

export function loadConfig(): ServerConfig {
  const { config: controller, rootDir } = loadControllerConfig();
  return {
    port: Number(process.env.PORT || DEFAULT_PORT),
    host: process.env.HOST || DEFAULT_HOST,
    hooksPort: Number(process.env.HOOKS_PORT || DEFAULT_HOOKS_PORT),
    dumpDir: resolve(rootDir, process.env.DUMP_DIR || DEFAULT_DUMP_DIR),
    workDir: resolve(controller.workDir),
    pty: {
      cols: Number(process.env.PTY_COLS || DEFAULT_PTY_COLS),
      rows: Number(process.env.PTY_ROWS || DEFAULT_PTY_ROWS),
    },
  };
}
