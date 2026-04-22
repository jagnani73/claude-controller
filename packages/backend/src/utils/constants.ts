/** Default server port */
export const DEFAULT_PORT = 4577;

/** Default server host — bind to all interfaces */
export const DEFAULT_HOST = "0.0.0.0";

/** Default data directory for session persistence */
export const DEFAULT_DATA_DIR = "./data";

/** Default PTY terminal dimensions */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 40;

/** Allowed CORS origins based on NODE_ENV */
export function getAllowedOrigins(): (string | RegExp)[] {
  const origins: (string | RegExp)[] = [];

  if (process.env.NODE_ENV !== "production") {
    origins.push(`http://localhost:${DEFAULT_PORT}`);
    origins.push(`http://127.0.0.1:${DEFAULT_PORT}`);
    origins.push("http://localhost:4578");
    origins.push("http://127.0.0.1:4578");
    origins.push(/^https:\/\/.*\.ngrok\.io$/);
    origins.push(/^https:\/\/.*\.ngrok-free\.app$/);
    origins.push(/^https:\/\/.*\.ngrok\.app$/);
  }

  return origins;
}
