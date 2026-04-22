import { describe, expect, it } from "bun:test";
import { SessionBus, type SessionBusEvent } from "../../src/services/session-bus.service.js";

describe("SessionBus", () => {
  it("stores sessionId", () => {
    const bus = new SessionBus("abc");
    expect(bus.sessionId).toBe("abc");
  });

  it("push appends to the event log and emits to listeners", () => {
    const bus = new SessionBus("s1");
    const received: SessionBusEvent[] = [];
    bus.on("event", (e) => received.push(e));

    bus.push({
      kind: "user_prompt",
      sessionId: "s1",
      timestamp: "t1",
      text: "hi",
    });

    expect(bus.getEventLog()).toHaveLength(1);
    expect(received).toHaveLength(1);
    if (received[0].kind !== "user_prompt") throw new Error("unreachable");
    expect(received[0].text).toBe("hi");
  });

  it("dedups tool_call events by toolUseId", () => {
    const bus = new SessionBus("s1");
    bus.push({
      kind: "tool_call",
      sessionId: "s1",
      timestamp: "t1",
      toolUseId: "tu-1",
      name: "Bash",
      input: { command: "ls" },
    });
    bus.push({
      kind: "tool_call",
      sessionId: "s1",
      timestamp: "t2",
      toolUseId: "tu-1",
      name: "Bash",
      input: { command: "ls" },
    });

    expect(bus.getEventLog()).toHaveLength(1);
  });

  it("does not dedup other event kinds", () => {
    const bus = new SessionBus("s1");
    bus.push({
      kind: "assistant_text",
      sessionId: "s1",
      timestamp: "t1",
      turnId: "turn-1",
      text: "part one",
    });
    bus.push({
      kind: "assistant_text",
      sessionId: "s1",
      timestamp: "t2",
      turnId: "turn-1",
      text: "part two",
    });

    expect(bus.getEventLog()).toHaveLength(2);
  });

  it("dispose clears event log and removes listeners", () => {
    const bus = new SessionBus("s1");
    let calls = 0;
    bus.on("event", () => {
      calls++;
    });
    bus.push({
      kind: "user_prompt",
      sessionId: "s1",
      timestamp: "t1",
      text: "hi",
    });
    expect(calls).toBe(1);

    bus.dispose();
    expect(bus.getEventLog()).toHaveLength(0);

    bus.push({
      kind: "user_prompt",
      sessionId: "s1",
      timestamp: "t2",
      text: "after dispose",
    });
    // Listener should not fire after dispose.
    expect(calls).toBe(1);
  });
});
