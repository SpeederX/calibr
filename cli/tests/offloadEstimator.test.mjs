import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateInitialOffload } from "../dist/engine/planning/offloadEstimator.js";

const MiB = 1024 * 1024;

test("estimateInitialOffload uses non-uniform last-block storage from the GGUF directory", () => {
  const result = estimateInitialOffload({
    size_mib: 105,
    gguf_block_count: 4,
    gguf_tensor_bytes: 105 * MiB,
    gguf_global_tensor_bytes: 5 * MiB,
    gguf_block_tensor_bytes: [
      { block: 0, bytes: 10 * MiB },
      { block: 1, bytes: 20 * MiB },
      { block: 2, bytes: 30 * MiB },
      { block: 3, bytes: 40 * MiB },
    ],
  }, { availableMib: 75 });

  assert.equal(result.source, "tensor-directory");
  assert.equal(result.estimatedLayers, 2);
  assert.equal(result.availableWeightBytes, 70 * MiB);
  assert.equal(result.estimatedGpuWeightBytes, 75 * MiB);
  assert.equal(result.fullModelFits, false);
});

test("estimateInitialOffload subtracts runtime, mmproj, and global tensor reserves", () => {
  const result = estimateInitialOffload({
    size_mib: 205,
    gguf_block_count: 3,
    gguf_global_tensor_bytes: 25 * MiB,
    gguf_block_tensor_bytes: [
      { block: 0, bytes: 70 * MiB },
      { block: 1, bytes: 50 * MiB },
      { block: 2, bytes: 60 * MiB },
    ],
  }, {
    availableMib: 200,
    runtimeReserveMib: 50,
    mmprojMib: 25,
  });

  assert.equal(result.availableWeightBytes, 100 * MiB);
  assert.equal(result.estimatedLayers, 1);
  assert.equal(result.estimatedGpuWeightBytes, 85 * MiB);
});

test("estimateInitialOffload falls back to uniform file weight when tensor summaries are absent", () => {
  const result = estimateInitialOffload({
    size_mib: 440,
    gguf_block_count: 4,
    gguf_global_tensor_bytes: 40 * MiB,
  }, { availableMib: 250 });

  assert.equal(result.source, "uniform-file-size");
  assert.deepEqual(result.blockTensorBytes, [100 * MiB, 100 * MiB, 100 * MiB, 100 * MiB]);
  assert.equal(result.estimatedLayers, 2);
});

test("estimateInitialOffload reports unavailable metadata without inventing a layer count", () => {
  const result = estimateInitialOffload({ size_mib: 16000 }, { availableMib: 8000 });
  assert.equal(result.source, "unavailable");
  assert.equal(result.blockCount, 0);
  assert.equal(result.estimatedLayers, 0);
});