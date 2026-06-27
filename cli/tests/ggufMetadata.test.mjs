import test from "node:test";
import assert from "node:assert/strict";
import { computeGgufHeaderMetadata, compareGgufSignature, isUnreadableGguf } from "../dist/engine/discover/ggufMetadata.js";

// Mirrors the offset-delta sizing of engine/discover.ps1 Get-GgufHeaderMetadata:
// each tensor's bytes = gap to the next tensor's offset (last -> file end), split
// into global / expert / per-block.
test("computeGgufHeaderMetadata splits global/expert/per-block bytes via offset deltas", () => {
  const parsed = {
    metadata: {
      "general.architecture": "llama",
      "llama.context_length": 4096n,
      "llama.block_count": 2,
    },
    tensorDataOffset: 0n,
    tensorInfos: [
      { name: "token_embd.weight", offset: 0n },          // global: 0..10
      { name: "blk.0.attn_q.weight", offset: 10n },        // block 0: 10..30
      { name: "blk.0.ffn_gate_exps.weight", offset: 30n }, // block 0 expert: 30..60
      { name: "blk.1.attn_q.weight", offset: 60n },        // block 1: 60..100 (file end)
    ],
  };
  const md = computeGgufHeaderMetadata(parsed, 100);

  assert.equal(md.architecture, "llama");
  assert.equal(md.context_length, 4096);
  assert.equal(md.block_count, 2);
  assert.equal(md.tensor_count, 4);
  assert.equal(md.tensor_data_offset, 0);
  assert.equal(md.tensor_bytes, 100);
  assert.equal(md.global_tensor_bytes, 10);
  assert.equal(md.expert_tensor_bytes, 30);
  assert.deepEqual(md.block_tensor_bytes, [
    { block: 0, bytes: 50, expert_bytes: 30 },
    { block: 1, bytes: 40, expert_bytes: 0 },
  ]);
});

test("computeGgufHeaderMetadata returns empties when the data offset is past EOF", () => {
  const md = computeGgufHeaderMetadata({ metadata: {}, tensorDataOffset: 500n, tensorInfos: [] }, 100);
  assert.equal(md.tensor_data_offset, null);
  assert.equal(md.tensor_bytes, null);
  assert.deepEqual(md.block_tensor_bytes, []);
});

test("context_length / block_count match by suffix regardless of architecture prefix", () => {
  const md = computeGgufHeaderMetadata({
    metadata: { "general.architecture": "qwen3moe", "qwen3moe.context_length": 262144n, "qwen3moe.block_count": 48 },
    tensorDataOffset: 0n,
    tensorInfos: [{ name: "output.weight", offset: 0n }],
  }, 64);
  assert.equal(md.context_length, 262144);
  assert.equal(md.block_count, 48);
});

const sig = (over = {}) => ({
  architecture: "llama", block_count: 28, context_length: 4096, tensor_count: 310,
  tensor_data_offset: 1000, tensor_bytes: 390753280, global_tensor_bytes: 127630336,
  expert_tensor_bytes: 0, block_tensor_bytes: [], ...over,
});

test("compareGgufSignature: identical fingerprints match", () => {
  const r = compareGgufSignature(sig(), sig());
  assert.equal(r.match, true);
  assert.deepEqual(r.diffs, []);
});

test("compareGgufSignature: a differing field is reported (e.g. tampered/wrong model)", () => {
  const r = compareGgufSignature(sig(), sig({ tensor_bytes: 999, architecture: "qwen3" }));
  assert.equal(r.match, false);
  assert.deepEqual(r.diffs.map((d) => d.field).sort(), ["architecture", "tensor_bytes"]);
});

test("isUnreadableGguf flags a header that could not be parsed", () => {
  // past-EOF data offset with no tensors yields the all-empty shape
  assert.equal(isUnreadableGguf(computeGgufHeaderMetadata({ metadata: {}, tensorDataOffset: 500n, tensorInfos: [] }, 100)), true);
  assert.equal(isUnreadableGguf(sig()), false);
});
