import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("reaper");

const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/**
 * Where spawn records live. Deliberately **not** under `ServerConfig.dumpDir`:
 * that resolves against the working directory, so `pnpm dev:backend` (cwd
 * `packages/backend`) and `pnpm start` (cwd repo root) get different
 * directories. For captures that is untidy; for this it is fatal, because a
 * restart under a different launch path would read an empty registry and reap
 * nothing at all. Caught by a live test after the unit tests were all green.
 *
 * Temp is the right lifetime, not a shortcut: a record is only meaningful until
 * the machine reboots, and after a reboot there are no orphans to find.
 */
const REGISTRY_DIR = join(tmpdir(), "claude-controller-pty-registry");

/**
 * A PTY this controller spawned, written when the session id resolves and
 * deleted when the session stops.
 *
 * It exists to survive a hard kill. `SessionManager.stopAll` is wired to
 * SIGINT/SIGTERM and handles Ctrl+C, but a process terminated without a signal
 * skips it entirely. If a `claude --resume` outlives us it is detached and
 * unreachable, and reopening that session puts a second PTY on the same
 * transcript — the in-process guard in `SessionManager.create` cannot see it,
 * because a restart takes the registry with it.
 *
 * **Honest status: the surviving-orphan case has not been reproduced here.** Two
 * live hard-kill tests on Windows (`Stop-Process -Force` on the backend, with a
 * session running) both showed ConPTY tearing the child down with the parent.
 * This is therefore defence-in-depth against a failure mode that is *reasoned
 * about* rather than observed — the earlier duplicate PTYs that prompted it are
 * fully explained by the `create` bug fixed alongside it. What IS verified end
 * to end: the record is written on spawn, and a later startup clears it from any
 * working directory. Delete this whole file without regret if orphans never
 * materialise.
 */
export interface SpawnRecord {
  sessionId: string;
  spawnToken: string;
  /** When we spawned it, used to prove a live process is the one we started. */
  spawnedAt: number;
}

/** A live CLI, as Claude Code itself reports it in `~/.claude/sessions/<pid>.json`. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  startedAt: number;
}

/**
 * Tolerance when comparing our spawn time to the CLI's own `startedAt`. The CLI
 * writes its file a moment after we spawn, but clock granularity and write
 * ordering can make it read marginally earlier.
 */
const CLOCK_SLACK_MS = 5_000;

/**
 * Decide which recorded spawns still have a live process that is ours to kill.
 *
 * Both halves of the match matter. The **session id** proves the process is the
 * one our record describes; without it we would be killing by a bare pid, which
 * a restarted machine can recycle onto something unrelated. The **start time**
 * proves it is the process *we* spawned rather than one the user opened in their
 * own terminal for the same session — killing that would take down a session
 * they are sitting in front of.
 *
 * Pure so both rules can be asserted without processes: the cost of getting this
 * wrong is killing something that is not ours.
 */
export function selectOrphans(
  records: SpawnRecord[],
  live: LiveSession[],
): { record: SpawnRecord; pid: number }[] {
  const out: { record: SpawnRecord; pid: number }[] = [];
  for (const record of records) {
    const match = live.find(
      (l) => l.sessionId === record.sessionId && l.startedAt >= record.spawnedAt - CLOCK_SLACK_MS,
    );
    if (match) out.push({ record, pid: match.pid });
  }
  return out;
}

const recordPath = (spawnToken: string): string => join(REGISTRY_DIR, `${spawnToken}.json`);

/** Note that a PTY is running, so a hard kill leaves a trail to follow. */
export function rememberSpawn(record: SpawnRecord): void {
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    writeFileSync(recordPath(record.spawnToken), JSON.stringify(record), "utf8");
  } catch (err) {
    // Never fatal: the registry is a cleanup aid, not a correctness requirement.
    log.warn("could not record spawn", { token: record.spawnToken, error: String(err) });
  }
}

/** Drop the trail — the PTY is gone by a path that ran our own teardown. */
export function forgetSpawn(spawnToken: string): void {
  try {
    rmSync(recordPath(spawnToken), { force: true });
  } catch (err) {
    log.warn("could not clear spawn record", { token: spawnToken, error: String(err) });
  }
}

function readRecords(): SpawnRecord[] {
  let names: string[];
  try {
    names = readdirSync(REGISTRY_DIR);
  } catch {
    return [];
  }
  const out: SpawnRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(REGISTRY_DIR, name), "utf8")) as
        | Partial<SpawnRecord>
        | undefined;
      if (
        parsed &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.spawnToken === "string" &&
        typeof parsed.spawnedAt === "number"
      ) {
        out.push(parsed as SpawnRecord);
      }
    } catch {
      // Corrupt or half-written record — nothing safe to do with it.
    }
  }
  return out;
}

/**
 * Every CLI Claude Code currently believes is running. It writes one file per
 * live process and removes it on exit, so presence is the liveness check — and
 * the pid inside is `claude.exe` itself, not the `cmd.exe` wrapper node-pty
 * reports on Windows. Killing the wrapper is precisely how the orphans survive.
 */
export function readLiveSessions(dir: string = CLAUDE_SESSIONS_DIR): LiveSession[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        pid?: unknown;
        sessionId?: unknown;
        startedAt?: unknown;
      };
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.startedAt === "number"
      ) {
        out.push({ pid: parsed.pid, sessionId: parsed.sessionId, startedAt: parsed.startedAt });
      }
    } catch {
      // Not ours to reason about.
    }
  }
  return out;
}

/**
 * Kill PTYs left behind by a previous backend that died without running its
 * shutdown handler, then clear the registry.
 *
 * Safe to run at startup because the backend binds a fixed port: if we are
 * starting, no other instance owns these sessions.
 */
export function reapOrphans(): number {
  const records = readRecords();
  if (records.length === 0) return 0;

  const orphans = selectOrphans(records, readLiveSessions());
  for (const { record, pid } of orphans) {
    try {
      process.kill(pid);
      log.warn("Killed a PTY orphaned by a previous run", {
        pid,
        sessionId: record.sessionId,
        token: record.spawnToken,
      });
    } catch (err) {
      // Already gone, or not ours to signal. Either way the record is stale.
      log.info("Orphan already gone", { pid, sessionId: record.sessionId, error: String(err) });
    }
  }
  // Clear every record, matched or not: they all describe a previous run.
  for (const record of records) forgetSpawn(record.spawnToken);
  return orphans.length;
}
