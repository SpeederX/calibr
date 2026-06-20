import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffloadBenchmarkCandidates, estimateOffloadCliff } from "../dist/offloadPlanner.js";

const probe = (layer, vram, fit = true, actual = layer) => ({
  requested_layers: layer, offloaded_layers: actual,
  vram_ready_mib: vram, fit_under_safe_cap: fit, ready: true,
});

test("estimateOffloadCliff starts from the structural estimate", () => {
  const result = estimateOffloadCliff({ blockCount: 40, safeCapMib: 7800, initialEstimate: 17, probes: [] });
  assert.equal(result.next_probe_layers, 17);
  assert.equal(result.confidence, "none");
  assert.equal(result.complete, false);
});

test("estimateOffloadCliff searches upward after a fitting first probe", () => {
  const result = estimateOffloadCliff({
    blockCount: 40, safeCapMib: 7800, initialEstimate: 16, probes: [probe(16, 6000)],
  });
  assert.equal(result.next_probe_layers, 28);
  assert.match(result.reason, /upward/);
});

test("estimateOffloadCliff predicts and validates a linear boundary", () => {
  const result = estimateOffloadCliff({
    blockCount: 40, safeCapMib: 7800, initialEstimate: 16,
    probes: [probe(10, 4000), probe(20, 7000)],
  });
  assert.equal(result.slope_mib_per_layer, 300);
  assert.equal(result.predicted_fit_layers, 22);
  assert.equal(result.next_probe_layers, 22);
  assert.equal(result.confidence, "linear");
});

test("estimateOffloadCliff jumps to the upper boundary after fitted probes beat prediction", () => {
  const result = estimateOffloadCliff({
    blockCount: 32, safeCapMib: 7782, initialEstimate: 22,
    probes: [probe(22, 6551), probe(27, 7596), probe(28, 7619)],
  });
  assert.equal(result.predicted_fit_layers, 28);
  assert.equal(result.verified_fit_layers, 28);
  assert.equal(result.next_probe_layers, 32);
  assert.match(result.reason, /upper boundary/);
});

test("estimateOffloadCliff completes on an adjacent fit/spill bracket", () => {
  const result = estimateOffloadCliff({
    blockCount: 40, safeCapMib: 7800, initialEstimate: 20,
    probes: [probe(21, 7600, true), probe(22, 7900, false)],
  });
  assert.equal(result.verified_fit_layers, 21);
  assert.equal(result.first_spill_layers, 22);
  assert.equal(result.confidence, "bracketed");
  assert.equal(result.next_probe_layers, null);
  assert.equal(result.complete, true);
});

test("estimateOffloadCliff detects actual-layer clamping through deduplication", () => {
  const result = estimateOffloadCliff({
    blockCount: 40, safeCapMib: 7800, initialEstimate: 20, maxProbeCount: 4,
    probes: [probe(30, 7000, true, 20), probe(35, 7005, true, 20)],
  });
  assert.equal(result.confidence, "single-probe");
  assert.equal(result.next_probe_layers, 30);
});


test("estimateOffloadCliff uses a failed high probe as a spill boundary", () => {
  const failed = { requested_layers: 24, offloaded_layers: null, vram_ready_mib: null, fit_under_safe_cap: false, ready: false };
  const result = estimateOffloadCliff({
    blockCount: 40, safeCapMib: 7800, initialEstimate: 16,
    probes: [probe(16, 6500, true), failed],
  });
  assert.equal(result.verified_fit_layers, 16);
  assert.equal(result.first_spill_layers, 24);
  assert.equal(result.next_probe_layers, 20);
  assert.match(result.reason, /bracket/);
});
test("buildOffloadBenchmarkCandidates is dense around the cliff and clamped", () => {
  assert.deepEqual(buildOffloadBenchmarkCandidates(20, 40), [14, 17, 19, 20, 21, 23]);
  assert.deepEqual(buildOffloadBenchmarkCandidates(1, 4), [0, 1, 2, 4]);
});

for (const vramGb of [2, 4, 6, 8, 12, 16, 24]) {
  test(`linear prediction scales continuously for a ${vramGb} GB synthetic budget`, () => {
    const cap = vramGb * 1024 * 0.95;
    const result = estimateOffloadCliff({
      blockCount: 80, safeCapMib: cap, initialEstimate: 10,
      probes: [probe(0, 600), probe(20, 4600)],
    });
    const expected = Math.max(0, Math.min(80, Math.floor((cap - 600) / 200)));
    assert.equal(result.predicted_fit_layers, expected);
  });
}
