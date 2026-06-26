import test from "node:test";
import assert from "node:assert/strict";
import { deriveMemoryPolicies } from "../dist/engine/bench/memoryPolicy.js";

const base = [
  { id: "a", model: "Q", variant: "9B", sweep: "context", workload_kind: "baseline", ok: true, extra_args: "--ctx-size 32768", vram_peak_mib: 6200, shared_peak_mib: 100 },
  { id: "b", model: "Q", variant: "9B", sweep: "context", workload_kind: "baseline", ok: true, extra_args: "--ctx-size 65536", vram_peak_mib: 6900, shared_peak_mib: 150 },
  { id: "c", model: "Q", variant: "9B", sweep: "context", workload_kind: "baseline", ok: true, extra_args: "--ctx-size 131072", vram_peak_mib: 7680, shared_peak_mib: 850 },
];

test("shared growth without KV-fill is risk, not confirmed degradation", () => {
  const policy = deriveMemoryPolicies(base, 8192).get("c");
  assert.equal(policy.memory_state, "spill_risk");
  assert.match(policy.memory_state_reason, /Might spill/);
  assert.ok(policy.estimated_cliff_tokens > 65536);
});

test("confirms degradation only when KV-fill crosses the cliff with shared allocation", () => {
  const fills = [
    { id: "f1", model: "Q", variant: "9B", sweep: "context", workload_kind: "kv-fill", ok: true, kv_fill_target_tokens: 32000, eval_tps: 40, shared_peak_mib: 100 },
    { id: "f2", model: "Q", variant: "9B", sweep: "context", workload_kind: "kv-fill", ok: true, kv_fill_target_tokens: 65000, eval_tps: 35, shared_peak_mib: 150 },
    { id: "f3", model: "Q", variant: "9B", sweep: "context", workload_kind: "kv-fill", ok: true, kv_fill_target_tokens: 140000, eval_tps: 12, shared_peak_mib: 900 },
  ];
  const policy = deriveMemoryPolicies([...base, ...fills], 8192).get("c");
  assert.equal(policy.memory_state, "spill_correlated_degradation");
  assert.ok(policy.cliff_degradation_pct > 20);
});

test("keeps MoE shared allocation ambiguous", () => {
  const policy = deriveMemoryPolicies([{
    id: "m", model: "M", variant: "A3B", sweep: "moe-cpu", workload_kind: "baseline",
    ok: true, vram_peak_mib: 7000, shared_peak_mib: 2000,
  }], 8192).get("m");
  assert.equal(policy.memory_state, "moe_shared_ambiguous");
});
