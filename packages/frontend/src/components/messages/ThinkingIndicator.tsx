import { useEffect, useRef, useState } from "react";

/**
 * Mirrors Claude Code's in-terminal "thinking" spinner: a cycling symbol in
 * the brand orange plus a randomly picked verb that stays stable for the
 * duration of one turn. Elapsed time ticks beside the verb.
 */

// Spinner glyphs and orange tones are lifted directly from Claude Code's UI
// (see `claude-code-source/src/components/Spinner/`).
// `︎` (VS15) forces text presentation — without it iOS/Safari renders
// several of these asterisks as colour emoji, ignoring our inline colour.
const SPINNER_CHARS = ["✻︎", "✶︎", "✽︎", "✢︎", "·", "✳︎"] as const;
const SPINNER_COLOR = "#D77757";
const VERB_COLOR = "#EB9F7F";
const SPINNER_INTERVAL_MS = 120;

// Curated subset of Claude Code's verb list — the full 187 is overkill here.
const VERBS = [
  "Accomplishing",
  "Actioning",
  "Actualizing",
  "Analyzing",
  "Architecting",
  "Baking",
  "Beaming",
  "Beboppin'",
  "Befuddling",
  "Billowing",
  "Blanching",
  "Bloviating",
  "Boogieing",
  "Boondoggling",
  "Booping",
  "Bootstrapping",
  "Brewing",
  "Bunning",
  "Burrowing",
  "Calculating",
  "Canoodling",
  "Caramelizing",
  "Cascading",
  "Catapulting",
  "Cerebrating",
  "Channeling",
  "Channelling",
  "Choreographing",
  "Churning",
  "Clauding",
  "Coalescing",
  "Cogitating",
  "Combobulating",
  "Composing",
  "Computing",
  "Concocting",
  "Conjuring",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Crystallizing",
  "Cultivating",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Dilly-dallying",
  "Discombobulating",
  "Doing",
  "Doodling",
  "Drizzling",
  "Ebbing",
  "Effecting",
  "Elucidating",
  "Embellishing",
  "Enchanting",
  "Envisioning",
  "Evaporating",
  "Fermenting",
  "Fiddle-faddling",
  "Finagling",
  "Flambéing",
  "Flibbertigibbeting",
  "Flowing",
  "Flummoxing",
  "Fluttering",
  "Forging",
  "Forming",
  "Frolicking",
  "Frosting",
  "Gallivanting",
  "Galloping",
  "Garnishing",
  "Generating",
  "Germinating",
  "Gesticulating",
  "Gitifying",
  "Grooving",
  "Gusting",
  "Harmonizing",
  "Hashing",
  "Hatching",
  "Herding",
  "Honking",
  "Hullaballooing",
  "Hyperspacing",
  "Ideating",
  "Imagining",
  "Improvising",
  "Incubating",
  "Inferring",
  "Infusing",
  "Ionizing",
  "Jitterbugging",
  "Julienning",
  "Kneading",
  "Leavening",
  "Levitating",
  "Lollygagging",
  "Manifesting",
  "Marinating",
  "Meandering",
  "Metamorphosing",
  "Misting",
  "Moonwalking",
  "Moseying",
  "Mulling",
  "Musing",
  "Mustering",
  "Nebulizing",
  "Nesting",
  "Newspapering",
  "Noodling",
  "Nucleating",
  "Orbiting",
  "Orchestrating",
  "Osmosing",
  "Perambulating",
  "Percolating",
  "Perusing",
  "Philosophising",
  "Photosynthesizing",
  "Plotting",
  "Pollinating",
  "Pondering",
  "Pontificating",
  "Pouncing",
  "Precipitating",
  "Prestidigitating",
  "Processing",
  "Proofing",
  "Propagating",
  "Puttering",
  "Puzzling",
  "Quantumizing",
  "Razzle-dazzling",
  "Razzmatazzing",
  "Reasoning",
  "Recombobulating",
  "Reticulating",
  "Roosting",
  "Ruminating",
  "Sautéing",
  "Scampering",
  "Schlepping",
  "Scurrying",
  "Seasoning",
  "Shenaniganing",
  "Shimmying",
  "Simmering",
  "Skedaddling",
  "Sketching",
  "Slithering",
  "Smooshing",
  "Sock-hopping",
  "Spelunking",
  "Spinning",
  "Sprouting",
  "Stewing",
  "Sublimating",
  "Swirling",
  "Swooping",
  "Symbioting",
  "Synthesizing",
  "Tempering",
  "Thinking",
  "Thundering",
  "Tinkering",
  "Tomfoolering",
  "Topsy-turvying",
  "Transfiguring",
  "Transmuting",
  "Twisting",
  "Undulating",
  "Unfurling",
  "Unravelling",
  "Vibing",
  "Waddling",
  "Wandering",
  "Warping",
  "Weaving",
  "Whatchamacalliting",
  "Whirlpooling",
  "Whirring",
  "Whisking",
  "Wibbling",
  "Working",
  "Wrangling",
  "Zesting",
  "Zigzagging",
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
    <div className="flex items-end gap-2 px-4 py-3 font-serif text-base">
      <span className="inline-block w-4 text-center" style={{ color: SPINNER_COLOR }}>
        {SPINNER_CHARS[frame]}
      </span>
      <span style={{ color: VERB_COLOR }}>{verbRef.current}…</span>
      <span className="font-sans text-[11px] not-italic text-muted-foreground/50">
        ({elapsed}s)
      </span>
    </div>
  );
}
