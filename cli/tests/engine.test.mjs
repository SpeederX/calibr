import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "calibr-engine-"));
process.env.CALIBR_DATA_DIR = dataDir;

const engine = await import(`../dist/engine.js?cache=${Date.now()}`);

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("list/delete cached llama.cpp builds under CALIBR_DATA_DIR", () => {
  const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const flavorDir = join(dataDir, "llama-bin", "b9360", "vulkan");
  mkdirSync(flavorDir, { recursive: true });
  const server = join(flavorDir, binName);
  writeFileSync(server, "stub");

  const archiveDir = join(dataDir, "llama-bin", "archives", "b0000");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, binName), "ignored");

  const builds = engine.listCachedLlamaBuilds();
  assert.equal(builds.length, 1);
  assert.equal(builds[0].tag, "b9360");
  assert.equal(builds[0].flavor, "vulkan");
  assert.equal(builds[0].path, server);

  engine.deleteCachedLlamaBuild(builds[0]);
  assert.equal(existsSync(flavorDir), false);
});
