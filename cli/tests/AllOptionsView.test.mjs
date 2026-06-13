// Unit tests for the guided-run (`all`) arg builder, focused on the new
// model-filter + runs and their interaction with the preset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAllArgs } from "../dist/AllOptionsView.js";

const base = {
  decision: null, fetchCatalog: true, model: null, customIds: "",
  currentPreset: "low", runs: 0, downloadRetention: "cleanup", preferSpeed: false,
  minimalPolling: false, rerunAll: false,
};

test("preset path: -FetchCatalog -Preset low", () => {
  assert.deepEqual(buildAllArgs(base).args, ["all", "-FetchCatalog", "-Preset", "low"]);
});

test("a model filter overrides the preset (-Model instead of -Preset)", () => {
  const a = buildAllArgs({ ...base, model: "Qwen3.5-2B" }).args;
  assert.ok(a.includes("-Model"), "should pass -Model");
  assert.ok(!a.includes("-Preset"), "preset must be skipped when a model is fixed");
});

test("runs passes through as -Runs", () => {
  assert.deepEqual(buildAllArgs({ ...base, currentPreset: "all", runs: 5 }).args,
    ["all", "-FetchCatalog", "-Runs", "5"]);
});

test("model + runs together", () => {
  assert.deepEqual(buildAllArgs({ ...base, currentPreset: "all", model: "M", runs: 3 }).args,
    ["all", "-FetchCatalog", "-Model", "M", "-Runs", "3"]);
});

test("preset 'all' emits no -Preset", () => {
  assert.deepEqual(buildAllArgs({ ...base, currentPreset: "all" }).args, ["all", "-FetchCatalog"]);
});

test("custom ids used when no model is fixed", () => {
  const a = buildAllArgs({ ...base, currentPreset: "custom", customIds: "a,b" }).args;
  assert.ok(a.includes("-CatalogId"));
});

test("context sizes pass through as -ContextSizes csv", () => {
  const a = buildAllArgs({ ...base, currentPreset: "custom", customIds: "a", contextSizes: [16384, 32768] }).args;
  const i = a.indexOf("-ContextSizes");
  assert.ok(i >= 0, "should include -ContextSizes");
  assert.equal(a[i + 1], "16384,32768");
});

test("download retention passes through as -DownloadRetention", () => {
  assert.deepEqual(buildAllArgs({ ...base, downloadRetention: "keep-top-3" }).args,
    ["all", "-FetchCatalog", "-Preset", "low", "-DownloadRetention", "keep-top-3"]);
});
