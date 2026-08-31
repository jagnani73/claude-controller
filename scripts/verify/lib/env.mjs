// Shared setup for the CLI verification probes.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** require() rooted in the backend package, so its deps (ws, node-pty) resolve. */
export const backendRequire = createRequire(
  `file:///${join(repoRoot, "packages", "backend", "package.json").replaceAll("\\", "/")}`,
);

/**
 * The env keys the controller strips before spawning, imported from the backend
 * build rather than restated — a probe that stripped a different set would be
 * testing something the controller never does.
 *
 * Requires `pnpm --filter backend build` (or a dev run) to have produced dist.
 */
export function strippedChildEnv() {
  const distPath = join(repoRoot, "packages", "backend", "dist", "services", "pty.service.js");
  if (!existsSync(distPath)) {
    throw new Error(`backend dist not found at ${distPath}\nrun: pnpm --filter backend build`);
  }
  return backendRequire(distPath).STRIPPED_CHILD_ENV;
}

/**
 * Absolute path to the Claude Code binary under test.
 *
 * Never resolves a bare `claude` off PATH: this project has already been bitten
 * by a machine with two installs where PATH order silently selected the older
 * one, so a probe that trusted PATH could verify the wrong binary entirely.
 */
export function claudeBin() {
  const explicit = process.env.CLAUDE_BIN?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CLAUDE_BIN does not exist: ${explicit}`);
    return explicit;
  }
  const candidates =
    process.platform === "win32"
      ? [join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe")]
      : [join(process.env.HOME ?? "", ".local", "bin", "claude")];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `could not locate the Claude Code binary.\n` +
        `set CLAUDE_BIN to an absolute path. tried:\n  ${candidates.join("\n  ")}`,
    );
  }
  return found;
}

/** process.env minus the keys the controller strips, for spawning a clean child. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of strippedChildEnv()) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

/** The version the relays are verified against, read from the built common package. */
export function targetVersion() {
  const distPath = join(repoRoot, "packages", "common", "dist", "version.js");
  if (!existsSync(distPath)) {
    throw new Error(`common dist not found at ${distPath}\nrun: pnpm --filter common build`);
  }
  return backendRequire(distPath).CLAUDE_CODE_TARGET_VERSION;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
