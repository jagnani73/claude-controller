#!/usr/bin/env tsx
// Cross-platform launcher for the Claude Controller stack.
//
// Loads the deploy .env, checks Tailscale, then runs the backend + Caddy
// together in one terminal. Ctrl+C stops both. Run from the repo root:
//   pnpm start
//
// The backend loads its own packages/backend/.env (via dotenv); this script
// only handles the deploy/Caddy vars (CONTROLLER_HOST, TAILSCALE_IP, …).

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Deploy/Caddy vars live in the repo-root .env.
loadDotenv({ path: join(root, ".env") });

/** Find a binary on PATH, falling back to known install locations per OS. */
function findBinary(name: string, candidates: string[]): string | null {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
  });
  if (probe.status === 0) {
    const onPath = probe.stdout.split(/\r?\n/).find(Boolean);
    if (onPath) return onPath.trim();
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

// Caddy needs these (site address + bind IP); fail early with a clear message.
for (const required of ["CONTROLLER_HOST", "TAILSCALE_IP"]) {
  if (!process.env[required]) {
    console.error(
      `[start] ERROR: ${required} is not set. Copy .env.example to .env and fill it in.`,
    );
    process.exit(1);
  }
}

// Soft Tailscale connectivity check — the phone can't reach us until it's up.
const tailscale = findBinary("tailscale", [
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
]);
if (tailscale) {
  const status = spawnSync(tailscale, ["status"], { encoding: "utf8" });
  console.log(
    status.status === 0
      ? "[start] Tailscale: connected"
      : "[start] WARNING: Tailscale not connected — run `tailscale up` (the phone can't reach this until it is)",
  );
} else {
  console.log("[start] WARNING: tailscale CLI not found; skipping connectivity check");
}

// Frontend must be built (Caddy serves the static bundle).
const frontendDist = resolve(root, process.env.FRONTEND_DIST ?? "packages/frontend/dist");
if (!existsSync(join(frontendDist, "index.html"))) {
  console.error(
    `[start] ERROR: frontend build not found at ${frontendDist}\n        Run: pnpm build:frontend`,
  );
  process.exit(1);
}

// Backend must be built.
const backendEntry = join(root, "packages", "backend", "dist", "index.js");
if (!existsSync(backendEntry)) {
  console.error(
    `[start] ERROR: backend build not found at ${backendEntry}\n        Run: pnpm build:backend`,
  );
  process.exit(1);
}

const caddy = findBinary("caddy", [
  join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft\\WinGet\\Packages\\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\\caddy.exe",
  ),
  "/usr/local/bin/caddy",
  "/opt/homebrew/bin/caddy",
  "/usr/bin/caddy",
]);
if (!caddy) {
  console.error(
    "[start] ERROR: caddy not found. Install it (Windows: winget install CaddyServer.Caddy; macOS: brew install caddy) and ensure it's on PATH.",
  );
  process.exit(1);
}

// Spawn both processes, prefix their output, and shut both down together.
const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
  process.exit(code);
}

function run(label: string, command: string, args: string[], extraEnv?: NodeJS.ProcessEnv): void {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...extraEnv } });
  const forward = (stream: Readable, sink: (line: string) => void): void => {
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) sink(`[${label}] ${line}`);
    });
  };
  if (child.stdout) forward(child.stdout, (line) => console.log(line));
  if (child.stderr) forward(child.stderr, (line) => console.error(line));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[${label}] exited (code ${code}) — stopping the other process`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => {
  console.log("\n[start] stopping…");
  shutdown(0);
});
process.on("SIGTERM", () => shutdown(0));

console.log("[start] launching backend + Caddy (Ctrl+C stops both)\n");
// `pnpm start` is the production run (built bundle behind Caddy over Tailscale).
// Force NODE_ENV=production so the backend's fail-closed CORS check and the
// dev-only PTY capture gate engage — unless the operator set it explicitly.
run("backend", process.execPath, [backendEntry], {
  NODE_ENV: process.env.NODE_ENV ?? "production",
});
run("caddy", caddy, ["run", "--config", join(root, "Caddyfile"), "--adapter", "caddyfile"]);

console.log(
  `\n[start] once both are up, open https://${process.env.CONTROLLER_HOST} on your phone (Tailscale on)\n`,
);
