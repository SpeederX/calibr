#!/usr/bin/env node
// End-to-end install smoke test: runs `npm pack` in cli/, installs the
// produced tarball into a clean temp dir, and asserts that the bundled
// engine resolves correctly via smoke-assert.mjs. Cleans up on success
// and on failure.
//
// Invoked by `npm test` and by CI. Exit 0 on pass, non-zero on fail.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
// npm is `npm.cmd` on Windows; spawning .cmd via Node requires shell: true.
// Wrap the spawn options so every npm call inherits the right behavior.
const isWindows = process.platform === "win32";

function spawnOpts(extra = {}) {
  return { shell: isWindows, ...extra };
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n[smoke] ${label}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...spawnOpts(opts) });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}${result.error ? ` (${result.error.message})` : ""}`);
  }
  return result;
}

function runCapture(label, cmd, args, opts = {}) {
  console.log(`\n[smoke] ${label}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { encoding: "utf8", ...spawnOpts(opts) });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${label} failed with exit ${result.status}${result.error ? ` (${result.error.message})` : ""}`);
  }
  return result.stdout;
}

let tarball = null;
let tempDir = null;
let exitCode = 1;

try {
  // 1. Pack. --json so we can extract the filename without parsing the
  //    human-readable banner.
  const packJson = runCapture("npm pack", "npm", ["pack", "--json"], { cwd: cliRoot });
  // npm prints a JSON array of entries; the first one has `filename`.
  const parsed = JSON.parse(packJson);
  const filename = Array.isArray(parsed) && parsed[0]?.filename;
  if (!filename) throw new Error(`could not extract tarball filename from npm pack output: ${packJson}`);
  tarball = resolve(cliRoot, filename);
  if (!existsSync(tarball)) throw new Error(`expected tarball not found at ${tarball}`);

  // 2. Temp dir + minimal package.json + install.
  tempDir = mkdtempSync(join(tmpdir(), "calibr-smoke-"));
  console.log(`[smoke] temp install dir: ${tempDir}`);
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ name: "calibr-smoke", version: "0.0.0", private: true, type: "module" }, null, 2),
  );

  // Copy the assertion script into the temp dir so it can resolve
  // `calibr/dist/engine.js` from the local node_modules.
  copyFileSync(join(here, "smoke-assert.mjs"), join(tempDir, "smoke-assert.mjs"));

  run("install tarball", "npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: tempDir });

  const installed = join(tempDir, "node_modules", "calibr");
  if (!existsSync(installed)) throw new Error(`calibr not present in ${installed}`);
  const installedFiles = readdirSync(installed).sort();
  console.log(`[smoke] installed package contents: ${installedFiles.join(", ")}`);

  // 3. Run the assertion script.
  //    `shell: false` here so the path to node.exe (which lives under
  //    "C:\Program Files\nodejs\" on Windows) isn't word-split by cmd.
  run("assertions", process.execPath, ["smoke-assert.mjs"], { cwd: tempDir, shell: false });

  console.log("\n[smoke] PASS");
  exitCode = 0;
} catch (err) {
  console.error(`\n[smoke] FAIL: ${err.message}`);
  exitCode = 1;
} finally {
  if (tarball && existsSync(tarball)) {
    try { rmSync(tarball, { force: true }); } catch {}
  }
  if (tempDir && existsSync(tempDir)) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(exitCode);
}
