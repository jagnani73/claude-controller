# Frontend rendering measurements

Manual instrumentation, not a test suite. No CLI or backend is required by the
fixture. It is outside `src` and is not part of the production entry graph.

## Reproduce

1. `pnpm install --frozen-lockfile --offline`
2. `pnpm --filter common build`
3. `pnpm --filter frontend exec vite --port 4589 --strictPort`
4. Open `http://localhost:4589/perf/render.html?baseline=1`, then
   `http://localhost:4589/perf/render.html`. Each runs automatically once; reload
   for another fresh run. Stay on these fixture URLs: the ordinary app connects
   through the default Vite backend proxy.

The baseline mode disables memo bailouts and recreates the preview object, matching
pre-optimization behavior for this fixture. It is an instrumented comparison, not
an independently built old application. Both modes mount the actual MessageStream,
deliver 100 assistant messages to its WS listener registry without a socket, then
perform 30 synchronous parent updates and append one reply. Counters wrap the inner
component functions, not a Profiler above a memo boundary. No StrictMode is used.

Observed in the embedded Chromium browser (development React, 1100 x 800):

| Work | Baseline | Optimized |
| --- | ---: | ---: |
| MessageStream renders for 30 parent updates | 30 | 0 |
| AssistantMessage renders for those updates | 3,000 | 0 |
| Markdown renders for those updates | 3,000 | 0 |
| AssistantMessage renders for one append | 101 | 1 |
| Markdown renders for one append | 101 | 1 |

One timing sample was 8,491.6 ms vs 16.5 ms for the parent-update loop. These are
synthetic development-mode timings with instrumentation, not production latency,
frame-rate measurements, or a live-session throughput claim. Counts are the useful
regression signal. The fixture does not exercise queue dispatch, reconnect, history
pagination, approvals or mobile scrolling; their implementation was left unchanged.

## Production bundle

Run `pnpm build:frontend` after building common. Actual Vite 6.4.2 output:

| Asset | Before | After |
| --- | ---: | ---: |
| Entry JS | 747.93 kB / 230.08 kB gzip | 499.15 kB / 157.96 kB gzip |
| Deferred SessionView JS | none | 250.68 kB / 74.04 kB gzip |
| CSS | 75.12 kB / 14.40 kB gzip | unchanged |

Entry JS decreases 33.3% raw / 31.3% gzip. Total JS grows slightly (749.83 kB raw,
232.00 kB gzip): this defers chat/Markdown parsing on Home, not a claim of lower
total session bytes. A direct session URL still needs both chunks. Route loading
finishes before SessionView mounts/subscribes, keeping its stream listeners and
subscribe effect in the same mount. No suspense boundary was inserted around the
live stream.

## Fonts

The existing Fontsource imports already include `unicode-range` and `font-display:
swap`; all 18 emitted WOFF2 files are not all requested. Inspection of resource
entries on the English home screen found only Inter Latin and Source Serif 4 Latin
(48,556 and 51,124 transfer bytes including response overhead). Non-Latin subsets
were not downloaded. No unconditional font preloads or external font scripts exist.
Keep the imports and system fallback stacks intact: removing Cyrillic/Greek/etc.
would reduce build artifacts but not English-page transfer and would degrade those
languages. No font byte saving is claimed.
