import type { ParsedHandler } from "../types/index.js";

// ─── Content Patterns ───────────────────────────────────────────────

const SPINNER_CHARS = new Set(["✻", "✶", "✽", "✢", "·", "✳"]);

/** All 187 spinner verbs from Claude Code's Spinner component */
const SPINNER_VERBS = new Set([
    "Accomplishing",
    "Actioning",
    "Actualizing",
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
    "Gesticulating",
    "Germinating",
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
    "Mustering",
    "Musing",
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
    "Whatchamacalliting",
    "Whirlpooling",
    "Whirring",
    "Whisking",
    "Wibbling",
    "Working",
    "Wrangling",
    "Zesting",
    "Zigzagging",
    // Also catch "Analyzing" and "Reasoning" from earlier observations
    "Analyzing",
    "Reasoning",
]);

/** Thinking effort annotation */
const THINKING_EFFORT = /^\(thinking with (low|medium|high) effort\)$/;

/** Thought completion */
const THOUGHT_COMPLETE = /^\(thought for \d+s\)$/;

/** Meaningful line prefixes — lines starting with these are real content */
const MEANINGFUL_PREFIXES = new Set(["●", "⎿", "❯", "⧉", "⏺"]);

/** Minimum meaningful line length — shorter is likely fragment residue */
const MIN_LINE_LENGTH = 4;

/** Lines shorter than this without a meaningful prefix are likely noise */
const MIN_CONTENT_LENGTH = 10;

export class ParserService {
    private handlers: ParsedHandler[] = [];
    private lastEmittedText = "";
    private spinnerDebounce: ReturnType<typeof setTimeout> | null = null;
    private pendingSpinnerText: string | null = null;
    private buffer = "";

    /** Register a handler for parsed clean text */
    onParsed(handler: ParsedHandler): void {
        this.handlers.push(handler);
    }

    /** Feed raw PTY data into the parser */
    feed(rawChunk: string): void {
        // Prepend any buffered incomplete escape sequence
        const input = this.buffer + rawChunk;
        this.buffer = "";

        // Check if input ends mid-escape — buffer the tail
        const trailingEsc = this.findIncompleteEscape(input);
        let text: string;
        if (trailingEsc >= 0) {
            this.buffer = input.slice(trailingEsc);
            text = input.slice(0, trailingEsc);
        } else {
            text = input;
        }

        const clean = this.stripAnsi(text);
        if (!clean) return;

        const lines = clean.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.processLine(trimmed);
        }
    }

    /** Reset parser state */
    reset(): void {
        this.lastEmittedText = "";
        this.pendingSpinnerText = null;
        this.buffer = "";
        if (this.spinnerDebounce) {
            clearTimeout(this.spinnerDebounce);
            this.spinnerDebounce = null;
        }
    }

    // ─── Layer 1: ANSI Stripping ────────────────────────────────────

    /**
     * Find the start of an incomplete escape sequence at the end of input.
     * Returns the index where the incomplete sequence begins, or -1.
     */
    private findIncompleteEscape(text: string): number {
        // Scan backwards from end for ESC (\x1b)
        for (let i = text.length - 1; i >= 0 && i >= text.length - 64; i--) {
            if (text[i] !== "\x1b") continue;

            const remaining = text.slice(i);

            // Single ESC at very end — definitely incomplete
            if (remaining.length === 1) return i;

            const second = remaining[1];

            // OSC: \x1b] ... needs BEL or ST terminator
            if (second === "]") {
                if (!/\x07/.test(remaining) && !/\x1b\\/.test(remaining)) {
                    return i;
                }
                continue;
            }

            // CSI: \x1b[ ... needs a letter terminator
            if (second === "[") {
                if (!/\x1b\[[0-9;?]*[A-Za-z]/.test(remaining)) {
                    return i;
                }
                continue;
            }

            // DCS/private: \x1b> or \x1b< or \x1b=
            if (second === ">" || second === "<" || second === "=") {
                if (remaining.length < 8) return i;
            }

            // ESC + single char — complete
        }
        return -1;
    }

    private stripAnsi(text: string): string {
        let r = text;

        // Convert cursor-forward \x1b[nC to spaces BEFORE stripping
        r = r.replace(/\x1b\[(\d+)C/g, (_m, n) =>
            " ".repeat(Number.parseInt(n, 10)),
        );

        // Strip all escape sequences in one pass order
        // OSC: \x1b] ... (BEL or ST)
        r = r.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
        // CSI: \x1b[ ... letter (including private sequences with > < = ?)
        r = r.replace(/\x1b\[[><=?]?[0-9;]*[A-Za-z]/g, "");
        // DCS/private: \x1b> or \x1b< or \x1b=
        r = r.replace(/\x1b[><=][^\x1b\n]*/g, "");
        // Single-char escapes: \x1b( \x1b) \x1b#
        r = r.replace(/\x1b[()#][A-Z0-9]/g, "");
        // Catch-all remaining ESC + char
        r = r.replace(/\x1b[A-Z@[\]^_`a-z{|}~]/g, "");
        // BEL
        r = r.replace(/\x07/g, "");

        // Carriage returns → newline (overwrite lines)
        r = r.replace(/\r(?!\n)/g, "\n");

        // Strip noise content inline
        r = r.replace(/─{4,}/g, "\n"); // horizontal rules → line breaks
        r = r.replace(/(Sonnet|Opus|Haiku)\s+[\d.]+\s*\|[^●❯⎿⧉\n]*/g, ""); // status bar
        r = r.replace(/ctx\s+\d+%\s+used\s*\|[^●❯⎿⧉\n]*/g, ""); // ctx stats
        r = r.replace(/[○◐●◉]\s+(xhigh|low|medium|high)\s*·\s*\/effort/g, ""); // effort tag
        r = r.replace(/running stop hooks…\s*\d+\/\d+[^)\n]*/g, ""); // stop hooks
        r = r.replace(/· thought for \d+s\)/g, ""); // inline thought duration
        // Repeated spinner labels (from cursor overwrite concatenation)
        r = r.replace(/(\w[\w'-]*…\s*){2,}/g, "");

        // Collapse whitespace
        r = r.replace(/ {2,}/g, " ");

        return r;
    }

    // ─── Layer 2: Noise Filtering ───────────────────────────────────

    private processLine(line: string): void {
        // Too short — likely cursor repositioning fragment
        if (line.length < MIN_LINE_LENGTH) return;

        // Detect spinner lines (starts with spinner char)
        const firstChar = line[0];
        if (firstChar && SPINNER_CHARS.has(firstChar)) {
            this.handleSpinner(line);
            return;
        }

        // Standalone "*" with short text — also a spinner
        if (
            line.startsWith("* ") &&
            line.length < 80 &&
            !line.startsWith("* *")
        ) {
            this.handleSpinner(line);
            return;
        }

        // Skip spinner residue
        if (this.isSpinnerResidue(line)) return;

        // Deduplicate
        if (line === this.lastEmittedText) return;

        this.emit(line);
    }

    private handleSpinner(line: string): void {
        const text = line.slice(1).trim();
        if (!text || text.length < MIN_LINE_LENGTH) return;

        // Only emit spinner text that looks like a real verb phrase
        const firstWord = text.split(/[\s…]/)[0];
        if (
            firstWord &&
            !SPINNER_VERBS.has(firstWord) &&
            text.length < MIN_CONTENT_LENGTH
        )
            return;

        // Deduplicate spinner content
        if (text === this.pendingSpinnerText) return;
        this.pendingSpinnerText = text;

        // Debounce: 1 emit per second
        if (this.spinnerDebounce) {
            clearTimeout(this.spinnerDebounce);
        }
        this.spinnerDebounce = setTimeout(() => {
            if (this.pendingSpinnerText) {
                this.emit(`[spinner] ${this.pendingSpinnerText}`);
            }
            this.spinnerDebounce = null;
        }, 1000);
    }

    private isSpinnerResidue(line: string): boolean {
        // Check if line is a spinner verb (with or without …)
        const verbMatch = line.match(/^(\w[\w'-]*)…?$/);
        if (verbMatch && SPINNER_VERBS.has(verbMatch[1])) return true;

        // Spinner verb followed by … and any trailing garbage (cursor-overwrite fragments)
        const verbPrefixMatch = line.match(/^(\w[\w'-]*)…/);
        if (verbPrefixMatch && SPINNER_VERBS.has(verbPrefixMatch[1]))
            return true;

        // Tool/spinner timing suffix: (Ns · ↓ N tokens) or (Ns · ↑ N tokens)
        if (/\(\d+s\s*·\s*[↓↑]\s*\d+\s*tokens?\)/.test(line)) return true;

        if (THINKING_EFFORT.test(line)) return true;
        if (THOUGHT_COMPLETE.test(line)) {
            // Thought completion is meaningful
            this.emit(line);
            return true;
        }
        // Lines that are mostly color code remnants (digits, semicolons, m)
        if (/^[\d;m?hlu]+$/.test(line)) return true;
        // Lines starting with common CSI remnants
        if (/^[0-9;]*m/.test(line) && line.length < 30) return true;
        // Short lines ending with … are spinner animation fragments
        if (line.length < MIN_CONTENT_LENGTH && line.endsWith("…")) return true;
        // Short lines without meaningful prefixes are cursor-overwrite noise
        if (
            line.length < MIN_CONTENT_LENGTH &&
            !MEANINGFUL_PREFIXES.has(line[0])
        )
            return true;
        return false;
    }

    // ─── Emit ───────────────────────────────────────────────────────

    private emit(text: string): void {
        // Real content cancels any pending spinner emission
        if (!text.startsWith("[spinner]") && MEANINGFUL_PREFIXES.has(text[0])) {
            if (this.spinnerDebounce) {
                clearTimeout(this.spinnerDebounce);
                this.spinnerDebounce = null;
            }
            this.pendingSpinnerText = null;
        }
        this.lastEmittedText = text;
        for (const handler of this.handlers) {
            handler(text);
        }
    }
}
