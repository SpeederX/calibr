import { test } from "node:test";
import assert from "node:assert/strict";
import { invokePlan } from "../dist/planCore.js";

const cfg = {
  hardware: { vram_safety_budget_mib: 8000, cpu_cores_physical: 6, cpu_threads_logical: 12 },
  planning: { overhead_mib: 1200, moecpu_sweep: [28, 30], offload_sweep: [20, 24] },
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
  assert.deepEqual(plan.map((p) => ({
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
  assert.deepEqual(plan.map((p) => p.label), [
    "Qwen3.5-4B Q4_K_M @ ctx=8192_kv=q8_0",
    "Qwen3.5-4B Q4_K_M @ ctx=16384_kv=q8_0",
  ]);
});
