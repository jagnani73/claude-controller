import { useEffect, useRef, useState } from "react";

/**
 * Mirrors Claude Code's in-terminal "thinking" spinner: a cycling symbol in
 * the brand orange plus a randomly picked verb that stays stable for the
 * duration of one turn. Elapsed time ticks beside the verb.
 */

// Spinner glyphs and orange tones are lifted directly from Claude Code's UI
// (see `claude-code-source/src/components/Spinner/`).
const SPINNER_CHARS = ["✻", "✶", "✽", "✢", "·", "✳"] as const;
const SPINNER_COLOR = "#D77757";
const VERB_COLOR = "#EB9F7F";
const SPINNER_INTERVAL_MS = 120;

// Curated subset of Claude Code's verb list — the full 187 is overkill here.
const VERBS = [
  "Thinking",
  "Pondering",
  "Contemplating",
  "Cogitating",
  "Ruminating",
  "Musing",
  "Deliberating",
  "Analyzing",
  "Considering",
  "Crafting",
  "Composing",
  "Brewing",
  "Cooking",
  "Sketching",
  "Forging",
  "Weaving",
  "Plotting",
  "Generating",
  "Synthesizing",
  "Conjuring",
  "Imagining",
  "Envisioning",
  "Noodling",
  "Reasoning",
  "Puzzling",
  "Deciphering",
  "Orchestrating",
  "Working",
  "Simmering",
  "Unravelling",
];

export function ThinkingIndicator() {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const verbRef = useRef<string>(VERBS[Math.floor(Math.random() * VERBS.length)]);

  useEffect(() => {
    const startedAt = Date.now();
    const spin = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_CHARS.length);
    }, SPINNER_INTERVAL_MS);
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      clearInterval(spin);
      clearInterval(tick);
    };
  }, []);

  return (
    <div className="flex items-center gap-2 px-4 py-3 text-sm">
      <span className="inline-block w-4 text-center font-medium" style={{ color: SPINNER_COLOR }}>
        {SPINNER_CHARS[frame]}
      </span>
      <span style={{ color: VERB_COLOR }}>{verbRef.current}…</span>
      <span className="text-xs text-neutral-600">({elapsed}s)</span>
    </div>
  );
}
