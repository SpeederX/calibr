// Unit tests for the bench arg builder (the level/model -> engine-flag mapping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchArgs } from "../dist/BenchOptionsView.js";

const base = { model: null, modelOnDisk: false, level: "all", runs: 0, keepDownloads: false, minimalPolling: false, rerunAll: false };

test("all models + level 'all' -> plain bench of the existing plan", () => {
  assert.deepEqual(buildBenchArgs(base).args, ["bench"]);
});

test("a level -> -Level X -Fetch (download + bench the level)", () => {
  assert.deepEqual(buildBenchArgs({ ...base, level: "low" }).args, ["bench", "-Level", "low", "-Fetch"]);
});

test("a specific model on disk -> -Model X (no fetch)", () => {
  assert.deepEqual(buildBenchArgs({ ...base, model: "Qwen3.5-2B", modelOnDisk: true }).args,
    ["bench", "-Model", "Qwen3.5-2B"]);
});

test("a specific curated model not on disk -> -Model X -Fetch", () => {
  assert.deepEqual(buildBenchArgs({ ...base, model: "Qwen3.5-9B", modelOnDisk: false }).args,
    ["bench", "-Model", "Qwen3.5-9B", "-Fetch"]);
});

test("a specific model overrides the level (level is inherited, not sent)", () => {
  const a = buildBenchArgs({ ...base, model: "M", modelOnDisk: true, level: "high" }).args;
  assert.ok(!a.includes("-Level"), "level must not be sent when a model is fixed");
});

test("runs / cleanup / polling / force pass through", () => {
  const a = buildBenchArgs({ ...base, level: "middle", runs: 3, keepDownloads: true, minimalPolling: true, rerunAll: true }).args;
  assert.deepEqual(a, ["bench", "-Level", "middle", "-Fetch", "-Runs", "3", "-Force", "-KeepDownloads", "-MinimalPolling"]);
});
