// Unit tests for the guided-run (`all`) arg builder, focused on the new
// model-filter + runs and their interaction with the preset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAllArgs, catalogModelNamesForScope, countGgufModels, isSelectableModelGguf, modelNameFromGgufFileName, scanLocalModelNames } from "../dist/AllOptionsView.js";

const base = {
  decision: null, modelFolder: "", fetchCatalog: true, model: null, customIds: "",
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

test("catalog model choices can be narrowed by preset scope", () => {
  const catalog = [
    { id: "low-a-q4", model: "Low A", hf_file: "low-a-q4.gguf" },
    { id: "high-b-q4", model: "High B", hf_file: "high-b-q4.gguf" },
    { id: "high-b-q8", model: "High B", hf_file: "high-b-q8.gguf" },
    { id: "mmproj-f16", model: "mmproj-F16", hf_file: "mmproj-F16.gguf" },
  ];
  const presets = {
    low: { label: "Low", models: ["low-*"] },
    high: { label: "High", models: ["high-*"] },
  };
  assert.deepEqual(catalogModelNamesForScope(catalog, presets, "all"), ["High B", "Low A"]);
  assert.deepEqual(catalogModelNamesForScope(catalog, presets, "low"), ["Low A"]);
  assert.deepEqual(catalogModelNamesForScope(catalog, presets, "high"), ["High B"]);
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

test("VRAM warning threshold passes through as a run-scoped override", () => {
  assert.deepEqual(buildAllArgs({ ...base, vramUsageWarningPct: 15 }).args,
    ["all", "-FetchCatalog", "-Preset", "low", "-VramUsageWarningPct", "15"]);
});

test("model folder passes through as scan path and download destination", () => {
  assert.deepEqual(buildAllArgs({ ...base, modelFolder: "D:\\models" }).args,
    ["all", "-ScanPath", "D:\\models", "-Destination", "D:\\models", "-FetchCatalog", "-Preset", "low"]);
});

test("model folder scan returns 0 for empty or missing paths", () => {
  assert.equal(countGgufModels(""), 0);
  assert.deepEqual(scanLocalModelNames(""), []);
  assert.equal(countGgufModels(join(tmpdir(), "calibr-missing-model-folder")), 0);
});

test("model folder scan counts local gguf files and exposes model names", () => {
  const root = mkdtempSync(join(tmpdir(), "calibr-model-folder-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "Qwen3.5-9B-Q4_K_M.gguf"), "stub");
    writeFileSync(join(root, "nested", "Gemma-4-E2B-it.F16.gguf"), "stub");
    writeFileSync(join(root, "nested", "mmproj-F16.gguf"), "stub");
    writeFileSync(join(root, "notes.txt"), "ignore");
    assert.equal(countGgufModels(root), 2);
    assert.deepEqual(scanLocalModelNames(root), ["Gemma-4-E2B-it", "Qwen3.5-9B"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mmproj gguf files are support assets, not selectable models", () => {
  assert.equal(isSelectableModelGguf("mmproj-F16.gguf"), false);
  assert.equal(isSelectableModelGguf("MMProj-model-f16-12B.gguf"), false);
  assert.equal(isSelectableModelGguf("Gemma-4-E2B-it.F16.gguf"), true);
});

test("local model name parser mirrors common variant suffixes", () => {
  assert.equal(modelNameFromGgufFileName("Qwen3.5-9B-Q4_K_M.gguf"), "Qwen3.5-9B");
  assert.equal(modelNameFromGgufFileName("Phi-4-mini-instruct.Q8_0.gguf"), "Phi-4-mini-instruct");
});
