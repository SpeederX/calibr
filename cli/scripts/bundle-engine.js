#!/usr/bin/env node
// Copies the PowerShell engine (calibr.ps1 + engine/*.ps1) and its default config into
// cli/engine/ so that `npm publish` bundles them alongside dist/.
// Runs automatically before `npm pack` / `npm publish` (via prepack).
import { copyFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "..");
const engineDir = join(cliRoot, "engine");
const engineModulesDir = join(repoRoot, "engine");

const sources = [
  { src: join(repoRoot, "calibr.ps1"), required: true },
  { src: join(repoRoot, "config.default.json"), required: true },
  // models_catalog.json drives the curated download catalog and the CLI's
  // pre-bench disk-space gate (downloadFootprintBytes / readModelCatalog).
  { src: join(repoRoot, "models_catalog.json"), required: true },
  // default_bench_presets.json: shipped hardware-tier presets
  // (low/middle/high/all) that the CLI's AllOptionsView preset row reads.
  { src: join(repoRoot, "default_bench_presets.json"), required: true },
  // report.template.html: required by `calibr report` (Invoke-Report reads
  // it from $CALIBR_ROOT = the directory holding calibr.ps1). Without
  // bundling it, `report` throws "Missing report.template.html" on a
  // fresh npm install.
  { src: join(repoRoot, "report.template.html"), required: true },
];

const engineModules = existsSync(engineModulesDir)
  ? readdirSync(engineModulesDir)
      .filter(name => name.endsWith(".ps1"))
      .map(name => ({ src: join(engineModulesDir, name), required: true }))
  : [];

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
if (!existsSync(engineModulesDir) || !statSync(engineModulesDir).isDirectory()) {
  console.error(`bundle-engine: missing required engine module directory: ${engineModulesDir}`);
  process.exit(1);
}
if (engineModules.length === 0) {
  console.error(`bundle-engine: no engine/*.ps1 modules found in ${engineModulesDir}`);
  process.exit(1);
}
for (const { src } of engineModules) {
  if (!existsSync(src) || !statSync(src).isFile()) {
    console.error(`bundle-engine: invalid engine module: ${src}`);
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

const bundledModulesDir = join(engineDir, "engine");
rmSync(bundledModulesDir, { recursive: true, force: true });
mkdirSync(bundledModulesDir, { recursive: true });
for (const { src } of engineModules) {
  const dest = join(bundledModulesDir, src.split(/[\\/]/).pop());
  copyFileSync(src, dest);
  console.error(`bundle-engine: ${src} -> ${dest}`);
}
