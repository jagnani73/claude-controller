import { describe, expect, it, vi } from "vitest";

/**
 * `create` is where a duplicate PTY gets spawned, so the Session it constructs
 * is mocked down to the surface the manager actually touches. Spawning a real
 * one would defeat the point: the bug being guarded is *that a second process
 * starts at all*.
 */
let constructed = 0;

vi.mock("../src/session/session.js", () => ({
  Session: class {
    readonly spawnToken: string;
    readonly resolved = true;
    alive = true;
    // biome-ignore lint/suspicious/noExplicitAny: mocked config, not the real shape
    constructor(readonly config: any) {
      constructed++;
      this.spawnToken = `token-${constructed}`;
    }
    get id(): string {
      return this.config.resumeSessionId ?? `fresh-${this.spawnToken}`;
    }
    on() {}
    once() {}
    stop() {
      // Mirrors the real thing: the PTY dies but SessionManager.stop leaves the
      // session in byId, which is exactly what the `alive` guard is for.
      this.alive = false;
    }
  },
}));

const { SessionManager } = await import("../src/services/session-manager.service");

const makeManager = () => {
  // biome-ignore lint/suspicious/noExplicitAny: mocked server config
  const m = new SessionManager({ dumpDir: "dump", capturePty: false } as any);
  m.setHooksBaseUrl("http://127.0.0.1:1");
  return m;
};

const RESUMED = "89b0e032-1baa-443c-9465-c80a86db74b4";

describe("SessionManager.create", () => {
  it("returns the running session instead of spawning a second PTY for it", () => {
    // The live failure: the client sent subscribe and create_session for one id
    // in quick succession, and two `claude --resume` processes ended up attached
    // to the same transcript JSONL, with byId pointing at only one of them.
    constructed = 0;
    const m = makeManager();
    const first = m.create({
      cwd: ".",
      model: "opus",
      permissionMode: "default",
      resumeSessionId: RESUMED,
    });
    const second = m.create({
      cwd: ".",
      model: "opus",
      permissionMode: "default",
      resumeSessionId: RESUMED,
    });

    expect(second).toBe(first);
    expect(constructed).toBe(1);
    expect(m.get(RESUMED)).toBe(first);
  });

  it("still spawns a distinct session per fresh (non-resume) create", () => {
    // The guard keys on resumeSessionId, so two fresh sessions must stay two.
    constructed = 0;
    const m = makeManager();
    const a = m.create({ cwd: ".", model: "opus", permissionMode: "default" });
    const b = m.create({ cwd: ".", model: "opus", permissionMode: "default" });

    expect(b).not.toBe(a);
    expect(constructed).toBe(2);
  });

  it("spawns for a resume id it has never seen", () => {
    constructed = 0;
    const m = makeManager();
    m.create({ cwd: ".", model: "opus", permissionMode: "default", resumeSessionId: RESUMED });
    m.create({ cwd: ".", model: "opus", permissionMode: "default", resumeSessionId: "other-id" });
    expect(constructed).toBe(2);
  });

  it("spawns a real session again after the previous one was stopped", () => {
    // The trap in the guard itself. `stop()` kills the PTY but leaves the entry
    // in byId — only `remove()` evicts it — so a naive registry hit would hand
    // back a dead session and the client would attach to nothing at all.
    constructed = 0;
    const m = makeManager();
    m.create({ cwd: ".", model: "opus", permissionMode: "default", resumeSessionId: RESUMED });
    m.stop(RESUMED);
    const revived = m.create({
      cwd: ".",
      model: "opus",
      permissionMode: "default",
      resumeSessionId: RESUMED,
    });
    expect(constructed).toBe(2);
    expect(revived.alive).toBe(true);
  });

  it("also spawns again after remove(), which does evict", () => {
    constructed = 0;
    const m = makeManager();
    m.create({ cwd: ".", model: "opus", permissionMode: "default", resumeSessionId: RESUMED });
    m.remove(RESUMED);
    m.create({ cwd: ".", model: "opus", permissionMode: "default", resumeSessionId: RESUMED });
    expect(constructed).toBe(2);
  });
});
