// Production IPC bridge — NOT debug output.
//
// Claude Code is spawned with this file as its `statusLine.command`
// (see hooks-config.ts). On every statusline render Claude pipes its
// authoritative StatusLineCommandInput JSON to our stdin; we write it verbatim
// to the payload path given as argv[2]. The backend then reads that file to (a)
// extract live model/context/cost/rate-limit metadata and (b) feed the user's
// real statusline command — neither of which we can compute ourselves, since
// we're a PTY relay, not an API client.
//
// Kept as a committed standalone file (rather than a string written at runtime)
// because Claude invokes it as `node "<path>"`, and because it's load-bearing
// production code that belongs under version control.

const fs = require("node:fs");
const path = require("node:path");

const outPath = process.argv[2];
let data = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  } catch {
    // Best-effort: a failed dump just means one stale statusline frame.
  }
});
