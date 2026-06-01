#!/usr/bin/env tsx
// Resize scripts/icon-source.png (the master logo) into the PWA icons
// (192, 512, apple-touch 180). Run: pnpm --filter frontend generate:icons

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "../public");
const source = readFileSync(join(scriptDir, "icon-source.png"));

const targets = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
];

for (const { name, size } of targets) {
  await sharp(source).resize(size, size).png().toFile(join(publicDir, name));
  console.log(`[icons] wrote ${name} (${size}x${size})`);
}
