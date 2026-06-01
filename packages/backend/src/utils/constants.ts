/** Default server port */
export const DEFAULT_PORT = 4577;

/**
 * Default hooks-listener port. `0` = OS-assigned free port (collision-proof);
 * the port is auto-injected into Claude Code's settings, so nothing external
 * needs to know it. Override with `HOOKS_PORT` to pin it to a fixed value.
 */
export const DEFAULT_HOOKS_PORT = 0;

/**
 * Default server host. Binds to loopback only, so the backend is never directly
 * reachable over the LAN or the public internet — remote access goes through
 * Caddy (bound to the Tailscale address), which reverse-proxies here. Override
 * with the `HOST` env var only if you intend to bind the Tailscale IP directly.
 */
export const DEFAULT_HOST = "127.0.0.1";

/** Default data directory for session persistence */
export const DEFAULT_DATA_DIR = "./data";

/** Default dump directory for PTY captures and statusline payloads (gitignored). */
export const DEFAULT_DUMP_DIR = "./dump";

/** Default PTY terminal dimensions */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 40;

/** Whether the server is running in production mode. */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Dev-only origins: local Vite + backend ports. */
const DEV_ORIGINS: string[] = [
  `http://localhost:${DEFAULT_PORT}`,
  `http://127.0.0.1:${DEFAULT_PORT}`,
  "http://localhost:4578",
  "http://127.0.0.1:4578",
];

function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Allowed request origins.
 *
 * - Production: ONLY the origins listed in the `ALLOWED_ORIGINS` env var
 *   (comma-separated), e.g. `https://laptop.tailnet-name.ts.net`. If unset, the
 *   list is empty and every cross-origin request is denied (fail closed).
 * - Development: localhost ports, for convenience.
 */
export function getAllowedOrigins(): string[] {
  if (isProduction()) {
    return parseOriginList(process.env.ALLOWED_ORIGINS);
  }
  return DEV_ORIGINS;
}

/**
 * Single source of truth for whether a request/WebSocket origin may connect.
 *
 * Production fails closed: a request with no `Origin` header, or one not in the
 * allowlist, is rejected. Browsers always send `Origin`, so a missing header in
 * production means a non-browser client and is treated as untrusted.
 *
 * Development is lenient: requests without an `Origin` are allowed (local tools),
 * and any origin in the dev list is allowed.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  const allowed = getAllowedOrigins();
  if (isProduction()) {
    if (!origin) return false;
    return allowed.includes(origin);
  }
  if (!origin) return true;
  return allowed.includes(origin);
}
