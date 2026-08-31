import { defineConfig } from "vitest/config";

// Unit tests only — pure logic, no Claude Code process, no cost.
//
// Anything that needs a real CLI (hook payload shapes, keystroke relays, resume
// behaviour) lives in `scripts/verify/` instead, because it spawns Claude Code
// and consumes plan credits. See scripts/verify/README.md.
//
// Tests live in a per-package `tests/` directory rather than beside the source:
// each package's tsconfig sets `rootDir` to `./src`, so test files under `src`
// would be emitted into `dist`.
export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    environment: "node",
  },
});
