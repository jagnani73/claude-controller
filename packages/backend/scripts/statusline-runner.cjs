// Only launched inside statusline-job.ps1's kill-on-close job. A JSON envelope
// keeps arbitrary commands/payloads out of PowerShell's argument parser/env.
const { spawn } = require("node:child_process");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const { exe, args, payload } = JSON.parse(input);
    const child = spawn(exe, args, { windowsHide: true });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdin.on("error", () => {}); // Commands need not read stdin.
    child.stdin.end(`${payload}\n`);
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("close", (code) => {
      // Wait for inherited pipes as before, but under the owner's deadline.
      // The job also kills descendants that deliberately closed their stdio.
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
});
