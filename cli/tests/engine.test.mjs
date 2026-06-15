import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("traceAction writes JSONL and human log with redacted paths", () => {
  engine.traceSessionStart();
  engine.traceAction({
    flow: "guided run",
    action: "llama.cpp download",
    status: "selected",
    message: "guided run > llama.cpp > download selected (latest)",
    details: { build: "latest", path: join(dataDir, "llama-bin", "b9360") },
  });

  assert.equal(existsSync(engine.CALIBR_ACTION_TRACE), true);
  const lines = readFileSync(engine.CALIBR_ACTION_TRACE, "utf8").trim().split(/\r?\n/);
  const entry = JSON.parse(lines.at(-1));
  assert.equal(entry.source, "cli");
  assert.equal(entry.flow, "guided run");
  assert.equal(entry.action, "llama.cpp download");
  assert.equal(entry.status, "selected");
  assert.equal(entry.details.build, "latest");
  assert.equal(entry.details.path, join("<CALIBR_DATA_DIR>", "llama-bin", "b9360"));

  assert.equal(existsSync(engine.CALIBR_ACTION_TRACE_LOG), true);
  const human = readFileSync(engine.CALIBR_ACTION_TRACE_LOG, "utf8");
  assert.match(human, /SESSION /);
  assert.match(human, /TIME\s+\| SOURCE\s+\| FLOW/);
  assert.match(human, /guided run/);
  assert.match(human, /llama\.cpp download/);
  assert.match(human, /<CALIBR_DATA_DIR>/);
  assert.doesNotMatch(human, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("groupByModel applies the same near-tie winner rule as the report", () => {
  const cfg = { wddm_detection: { shared_delta_confirm_mib: 500 } };
  const groups = engine.groupByModel([
    {
      id: "small-fast",
      model: "Qwen",
      variant: "Q4",
      ok: true,
      eval_tps: 100,
      shared_peak_mib: 0,
      vram_peak_mib: 2400,
      extra_args: "--ctx-size 16384",
    },
    {
      id: "large-near",
      model: "Qwen",
      variant: "Q4",
      ok: true,
      eval_tps: 97,
      shared_peak_mib: 0,
      vram_peak_mib: 2600,
      extra_args: "--ctx-size 65536",
    },
  ], cfg);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].winner.id, "large-near");
});
