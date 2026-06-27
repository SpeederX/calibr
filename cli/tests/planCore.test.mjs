import { test } from "node:test";
import assert from "node:assert/strict";
import { contextCandidateKv, invokePlan, newPlanItem, workloadProfilesForContext } from "../dist/engine/planning/planCore.js";

const cfg = {
  hardware: { vram_safety_budget_mib: 8000, cpu_cores_physical: 6, cpu_threads_logical: 12 },
  planning: {
    overhead_mib: 1200,
    moecpu_sweep: [28, 30],
    offload_sweep: [20, 24],
    kv_rescue: { enabled: false },
  },
  base_args: "--flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2",
  context_candidates: [
    { ctx: 16384, kv: "q8_0" },
    { ctx: 32768, kv: "q8_0" },
    { ctx: 65536, kv: "q8_0" },
  ],
  max_context_cap: 262144,
};

const catalog = [
  {
    path: "C:\\models\\qwen3.5-4b-q4km.gguf",
    model: "Qwen3.5-4B",
    variant: "Q4_K_M",
    series: "qwen",
    size_mib: 3100,
    is_moe: false,
    mmproj: null,
    reasoning_mode: "off",
    template_note: null,
    gguf_context_length: 131072,
    gguf_architecture: "qwen3",
  },
  {
    path: "C:\\models\\qwen3.6-35b-a3b-q4km.gguf",
    model: "Qwen3.6-35B-A3B",
    variant: "Q4_K_M",
    series: "qwen",
    size_mib: 19000,
    is_moe: true,
    mmproj: null,
    reasoning_mode: "off",
    template_note: null,
    gguf_context_length: 262144,
    gguf_architecture: "qwen3moe",
  },
  {
    path: "C:\\models\\phi-4-reasoning-plus-q4km.gguf",
    model: "Phi-4-reasoning-plus",
    variant: "Q4_K_M",
    series: "phi",
    size_mib: 9200,
    is_moe: false,
    mmproj: null,
    reasoning_mode: "default",
    template_note: null,
    gguf_context_length: 131072,
    gguf_architecture: "phi3",
  },
];

const modelsCatalog = [
  { id: "qwen4b", hf_file: "qwen3.5-4b-q4km.gguf", max_context: 131072 },
  { id: "qwen35b", hf_file: "qwen3.6-35b-a3b-q4km.gguf", max_context: 262144 },
  { id: "phi4", hf_file: "phi-4-reasoning-plus-q4km.gguf", max_context: 131072 },
];

const presets = {
  middle: { label: "middle", models: ["qwen4b"] },
  ultra: { label: "ultra", models: ["qwen35b"] },
  high: { label: "high", models: ["phi4"] },
};

test("invokePlan matches the PowerShell-equivalent mixed-sweep fixture", () => {
  const plan = invokePlan(catalog, cfg, modelsCatalog, presets);
  assert.equal(plan.filter((p) => p.control_kind === "vanilla").length, 3);
  assert.equal(plan.filter((p) => p.control_kind === "vanilla-matched").length, 3);
  assert.deepEqual(plan.filter((p) => !p.control_kind).map((p) => ({
    id: p.id,
    model: p.model,
    level: p.level,
    sweep: p.sweep,
    label: p.label,
    extra_args: p.extra_args,
  })), [
    {
      id: "Qwen3_5_4B_Q4_K_M__ctx_16384_kv_q8_0",
      model: "Qwen3.5-4B",
      level: "middle",
      sweep: "context",
      label: "Qwen3.5-4B Q4_K_M @ ctx=16384_kv=q8_0",
      extra_args: "--ctx-size 16384 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
    {
      id: "Qwen3_5_4B_Q4_K_M__ctx_32768_kv_q8_0",
      model: "Qwen3.5-4B",
      level: "middle",
      sweep: "context",
      label: "Qwen3.5-4B Q4_K_M @ ctx=32768_kv=q8_0",
      extra_args: "--ctx-size 32768 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
    {
      id: "Qwen3_5_4B_Q4_K_M__ctx_65536_kv_q8_0",
      model: "Qwen3.5-4B",
      level: "middle",
      sweep: "context",
      label: "Qwen3.5-4B Q4_K_M @ ctx=65536_kv=q8_0",
      extra_args: "--ctx-size 65536 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
    {
      id: "Qwen3_5_4B_Q4_K_M__ctx_131072_kv_q8_0",
      model: "Qwen3.5-4B",
      level: "middle",
      sweep: "context",
      label: "Qwen3.5-4B Q4_K_M @ ctx=131072_kv=q8_0",
      extra_args: "--ctx-size 131072 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
    {
      id: "Qwen3_6_35B_A3B_Q4_K_M__ncpumoe_28",
      model: "Qwen3.6-35B-A3B",
      level: "ultra",
      sweep: "moe-cpu",
      label: "Qwen3.6-35B-A3B Q4_K_M @ ncpumoe_28",
      extra_args: "--ctx-size 16384 --gpu-layers 99 --n-cpu-moe 28 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
    {
      id: "Qwen3_6_35B_A3B_Q4_K_M__ncpumoe_30",
      model: "Qwen3.6-35B-A3B",
      level: "ultra",
      sweep: "moe-cpu",
      label: "Qwen3.6-35B-A3B Q4_K_M @ ncpumoe_30",
      extra_args: "--ctx-size 16384 --gpu-layers 99 --n-cpu-moe 30 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
    {
      id: "Phi_4_reasoning_plus_Q4_K_M__ngl_20",
      model: "Phi-4-reasoning-plus",
      level: "high",
      sweep: "offload",
      label: "Phi-4-reasoning-plus Q4_K_M @ ngl_20",
      extra_args: "--ctx-size 16384 --gpu-layers 20 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
    {
      id: "Phi_4_reasoning_plus_Q4_K_M__ngl_24",
      model: "Phi-4-reasoning-plus",
      level: "high",
      sweep: "offload",
      label: "Phi-4-reasoning-plus Q4_K_M @ ngl_24",
      extra_args: "--ctx-size 16384 --gpu-layers 24 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn auto --parallel 1 --batch-size 2048 --ubatch-size 512 --no-mmap --prio 2 --threads 6 --threads-batch 12",
    },
  ]);
});

test("invokePlan applies preset context caps and explicit context overrides", () => {
  const plan = invokePlan(catalog.slice(0, 1), cfg, modelsCatalog, presets, {
    presetMaxCtx: 32768,
    contextSizes: [8192, 16384, 65536],
  });
  assert.deepEqual(plan.filter((p) => !p.control_kind).map((p) => p.label), [
    "Qwen3.5-4B Q4_K_M @ ctx=8192_kv=q8_0",
    "Qwen3.5-4B Q4_K_M @ ctx=16384_kv=q8_0",
  ]);
});

test("long-context candidates keep q8 primary and generate same-context q4 rescue", () => {
  assert.deepEqual(contextCandidateKv({ kv: "q8_0" }), {
    k: "q8_0", v: "q8_0", label: "kv=q8_0",
  });
  assert.deepEqual(contextCandidateKv({ kv_k: "q8_0", kv_v: "q5_1" }), {
    k: "q8_0", v: "q5_1", label: "kvk=q8_0_kvv=q5_1",
  });

  const qualityCfg = {
    ...cfg,
    planning: {
      ...cfg.planning,
      kv_rescue: {
        enabled: true,
        min_context_tokens: 131072,
        kv_k: "q4_0",
        kv_v: "q4_0",
      },
    },
    context_candidates: [
      { ctx: 65536, kv: "q8_0" },
      { ctx: 131072, kv: "q8_0" },
      { ctx: 262144, kv: "q8_0" },
    ],
  };
  const planned = invokePlan(
    [{ ...catalog[0], gguf_context_length: 262144 }],
    qualityCfg,
    [],
    {},
  ).filter((item) => !item.control_kind);
  const standard = planned.find((item) => item.label.includes("ctx=65536"));
  const longContextPrimary = planned.find((item) =>
    item.label.includes("ctx=131072") && !item.conditional_kind);
  const rescue = planned.find((item) =>
    item.label.includes("ctx=131072") && item.conditional_kind === "kv_rescue");
  assert.match(standard.extra_args, /--cache-type-k q8_0 --cache-type-v q8_0/);
  assert.match(longContextPrimary.extra_args, /--cache-type-k q8_0 --cache-type-v q8_0/);
  assert.match(longContextPrimary.label, /kv=q8_0/);
  assert.match(rescue.extra_args, /--cache-type-k q4_0 --cache-type-v q4_0/);
  assert.equal(rescue.conditional_source_id, longContextPrimary.id);
  const maxContextPrimary = planned.find((item) =>
    item.label.includes("ctx=262144") && !item.conditional_kind);
  assert.match(maxContextPrimary.extra_args, /--cache-type-k q8_0 --cache-type-v q8_0/);
  assert.ok(planned.some((item) =>
    item.label.includes("ctx=262144") && item.conditional_kind === "kv_rescue"));
});

test("vanilla controls include raw default plus matched baselines and stay out of workload sweeps", () => {
  const plan = invokePlan(catalog.slice(0, 1), cfg, modelsCatalog, presets, {
    workloadSweep: "all",
  });
  const controls = plan.filter((item) => item.control_kind === "vanilla");
  assert.equal(controls.length, 1);
  assert.equal(controls[0].extra_args, "");
  assert.equal(controls[0].workload_kind, "baseline");
  assert.match(controls[0].id, /vanilla_llama_cpp/);
  const adjacent = plan.filter((item) => item.control_kind === "vanilla-matched");
  assert.deepEqual(adjacent.map((item) => ({
    label: item.label,
    extra_args: item.extra_args,
    workload_kind: item.workload_kind,
  })), [
    {
      label: "Qwen3.5-4B Q4_K_M @ llama_cpp_matched_ctx=131072_default",
      extra_args: "--ctx-size 131072",
      workload_kind: "baseline",
    },
    {
      label: "Qwen3.5-4B Q4_K_M @ llama_cpp_matched_ctx=131072_parallel1",
      extra_args: "--ctx-size 131072 --parallel 1",
      workload_kind: "baseline",
    },
    {
      label: "Qwen3.5-4B Q4_K_M @ llama_cpp_matched_ctx=131072_parallel1_kv=q8_0",
      extra_args: "--ctx-size 131072 --parallel 1 --cache-type-k q8_0 --cache-type-v q8_0",
      workload_kind: "baseline",
    },
  ]);
});

test("plan item identity includes non-baseline workload targets", () => {
  const meta = catalog[0];
  const baseline = newPlanItem(meta, "context", "middle", "--ctx-size 65536", "ctx=65536_kv=q8_0");
  const prefill = newPlanItem(meta, "context", "middle", "--ctx-size 65536", "ctx=65536_kv=q8_0", {
    kind: "prefill",
    prefillTokens: 32768,
  });
  const kvFill = newPlanItem(meta, "context", "middle", "--ctx-size 65536", "ctx=65536_kv=q8_0", {
    kind: "kv-fill",
    kvFillTokens: 49152,
  });

  assert.equal(baseline.workload_kind, "baseline");
  assert.equal(baseline.id.includes("workload"), false);
  assert.notEqual(prefill.id, kvFill.id);
  assert.match(prefill.id, /prefill_32768/);
  assert.match(kvFill.id, /kvfill_49152/);
});

test("workload profiles respect context reserve and expand only the largest context anchor", () => {
  const workloadCfg = {
    ...cfg,
    bench: { n_predict: 128 },
    planning: {
      ...cfg.planning,
      workload_sweeps: {
        prefill_micro_tokens: [512],
        prefill_ratios: [0.25, 0.9, 0.99],
        kv_fill_ratios: [0.25, 0.9, 0.99],
        context_reserve_tokens: 512,
      },
    },
  };
  const profiles = workloadProfilesForContext(16384, workloadCfg, "all");
  assert.deepEqual(profiles, [
    { kind: "prefill", prefillTokens: 512 },
    { kind: "prefill", prefillTokens: 4096 },
    { kind: "prefill", prefillTokens: 14745 },
    { kind: "kv-fill", kvFillTokens: 4096 },
    { kind: "kv-fill", kvFillTokens: 14745 },
  ]);

  const plan = invokePlan(catalog.slice(0, 1), workloadCfg, modelsCatalog, presets, {
    presetMaxCtx: 32768,
    workloadSweep: "all",
  });
  const diagnostics = plan.filter((item) => item.workload_kind !== "baseline");
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.every((item) => item.extra_args.includes("--ctx-size 32768")));
  assert.ok(plan.filter((item) => item.workload_kind === "baseline").some((item) =>
    item.extra_args.includes("--ctx-size 16384")));
});
