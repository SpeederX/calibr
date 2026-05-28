#!/usr/bin/env node
// Copies the PowerShell engine (calibr.ps1) and its default config into
// cli/engine/ so that `npm publish` bundles them alongside dist/.
// Runs automatically before `npm pack` / `npm publish` (via prepack).
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "..");
const engineDir = join(cliRoot, "engine");

const sources = [
  { src: join(repoRoot, "calibr.ps1"), required: true },
  { src: join(repoRoot, "config.default.json"), required: true },
];

for (const { src, required } of sources) {
  if (!existsSync(src)) {
    if (required) {
      console.error(`bundle-engine: missing required source: ${src}`);
      process.exit(1);
    }
    continue;
  }
  if (!statSync(src).isFile()) {
    console.error(`bundle-engine: not a file: ${src}`);
    process.exit(1);
  }
}

mkdirSync(engineDir, { recursive: true });
for (const { src } of sources) {
  if (!existsSync(src)) continue;
  const dest = join(engineDir, src.split(/[\\/]/).pop());
  copyFileSync(src, dest);
  // Log to stderr: npm pack --json captures stdout and chokes on prose.
  console.error(`bundle-engine: ${src} -> ${dest}`);
}
