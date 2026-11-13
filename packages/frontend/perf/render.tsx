// Manual instrumentation, not a test: no backend connection or CLI is started.
// Open /perf/render.html on an isolated Vite port. Run once normally and once
// with ?baseline=1 to remove memo boundaries (the pre-optimization behavior).
import { type ComponentType, type createElement, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AssistantMessage } from "../src/components/messages/AssistantMessage";
import { Markdown } from "../src/components/messages/Markdown";
import { MessageStream } from "../src/components/messages/MessageStream";
import { wsService } from "../src/services/ws.service";

const baseline = new URLSearchParams(location.search).has("baseline");
const counts: Record<string, number> = {};
// Instrument the memo's inner function, so a skipped render is NOT counted.
// Baseline still uses React.memo but always declines its bailout.
for (const [name, component] of Object.entries({ MessageStream, AssistantMessage, Markdown })) {
  const wrapper = component as unknown as {
    type: ComponentType<never>;
    compare: (() => boolean) | null;
  };
  const original = wrapper.type;
  wrapper.type = ((props: never) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return (original as (props: never) => ReturnType<typeof createElement>)(props);
  }) as ComponentType<never>;
  if (baseline) wrapper.compare = () => false;
}

// Deliver through the same listener registry as the socket, without connecting.
function emit(message: Record<string, unknown>) {
  const listeners = (
    wsService as unknown as {
      listeners: Map<string, Set<(message: unknown) => void>>;
    }
  ).listeners;
  for (const handler of listeners.get(message.type as string) ?? []) handler(message);
}
const preview = { text: "Pending prompt", timestamp: "2026-01-01T00:00:00Z" };
function Harness() {
  const [tick, setTick] = useState(0);
  const [report, setReport] = useState("");
  function run() {
    flushSync(() => {
      for (let i = 0; i < 100; i++)
        emit({
          type: "assistant_text",
          sessionId: "benchmark",
          turnId: `${i}`,
          text: `## Response ${i}\n\nA **stable** paragraph with [a link](https://example.com).\n\n- One\n- Two`,
          timestamp: "2026-01-01T00:00:00Z",
        });
    });
    for (const key of Object.keys(counts)) counts[key] = 0;
    const start = performance.now();
    for (let i = 0; i < 30; i++) flushSync(() => setTick((value) => value + 1));
    const parentUpdates = { counts: { ...counts }, ms: performance.now() - start };
    for (const key of Object.keys(counts)) counts[key] = 0;
    flushSync(() =>
      emit({
        type: "assistant_text",
        sessionId: "benchmark",
        turnId: "new",
        text: "One new reply",
        timestamp: "2026-01-01T00:00:01Z",
      }),
    );
    setReport(JSON.stringify({ baseline, parentUpdates, appendCounts: counts }, null, 2));
  }
  // Run after child subscription effects have installed their handlers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only benchmark
  useEffect(() => {
    const timer = setTimeout(run, 100);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <p>Reload to repeat this benchmark with a fresh transcript.</p>
      <pre>{report}</pre>
      <span>Parent ticks: {tick}</span>
      <MessageStream sessionId="benchmark" inFlightPreview={baseline ? { ...preview } : preview} />
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing benchmark root");
createRoot(root).render(<Harness />);
