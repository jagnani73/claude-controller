// A throwaway loopback hook listener plus a matching --settings file, mirroring
// what the controller injects. Used by the probes to observe which hook events
// a given CLI build actually delivers, and with what payload.

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Start a listener and write a settings file registering `events` against it.
 * Returns the captured calls array (mutated as hooks arrive) and a stop().
 */
export async function startHookProbe(events, { name = "verify" } = {}) {
  const captured = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {}
      captured.push({ url: req.url, event: payload?.hook_event_name ?? null, payload });
      // Always respond {} — these probes observe, they never decide.
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const hooks = {};
  for (const event of events) {
    const spec = typeof event === "string" ? { event } : event;
    hooks[spec.event] = [
      {
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: "http", url: `${base}/hooks/${spec.event}`, async: false }],
      },
    ];
  }
  const settingsPath = join(tmpdir(), `claude-verify-${name}-settings.json`);
  writeFileSync(settingsPath, JSON.stringify({ hooks }), "utf8");

  return {
    base,
    settingsPath,
    captured,
    countOf: (event) => captured.filter((c) => c.event === event).length,
    stop: () => server.close(),
  };
}

// Constructed via `new RegExp` to keep raw control bytes out of source — same
// approach as transcript.service.ts.
const ESC = "\\u001b";
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const OSC_RE = new RegExp(`${ESC}\\][^\\u0007]*\\u0007`, "g");
const CHARSET_RE = new RegExp(`${ESC}[()][B0]`, "g");

/** Strip ANSI/OSC so PTY output is readable in probe logs. */
export function stripAnsi(s) {
  return s.replace(CSI_RE, "").replace(OSC_RE, "").replace(CHARSET_RE, "");
}
