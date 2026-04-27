# Domain glossary

Single authoritative source for vocabulary used across the project. Every
spec, plan, design doc, code comment, and user-facing string must use these
terms in the sense defined here. If the project ever diverges, this file is
updated **first**, then the code follows.

## Taxonomy of GGUF models

A `.gguf` file represents one **variant** of one **model** within one
**series** within one **lineage**. The levels nest:

| Level | What it identifies | Examples |
|---|---|---|
| **Lineage** | The developer or brand | `Qwen`, `Gemma`, `Llama`, `Mistral` |
| **Series** | One specific generation within a lineage | `Qwen3.5`, `Qwen3.6`, `Gemma-4`, `Llama-3` |
| **Model** | One size or shape within a series | `Qwen3.5-9B`, `Qwen3.5-27B`, `Gemma-4-E2B`, `Qwen3.6-35B-A3B` |
| **Variant** | The quantization or precision applied to the model | `Q4_K_M`, `BF16`, `UD-Q4_K_XL`, `Q8_0` |
| **Run config** | The bench-time flags applied to a variant | `ctx=16384, kv=q8_0`, `--n-cpu-moe 32`, `--gpu-layers 28` |

The code uses these names directly: `model`, `series`, `variant`. Pre-v1.0
results may still carry the old `family` / `quant` field names; the report
migrates them on first run.

## Bench domain

### Tier
A planning category that determines which sweep dimension applies to a model:

- **Tier A** — dense model whose weights + mmproj + overhead fit inside the
  VRAM safety budget. Sweep over `(ctx, KV-quant)` pairs.
- **Tier B** — MoE (Mixture of Experts) model. Sweep over `--n-cpu-moe`
  values to find the optimal CPU-vs-GPU expert split.
- **Tier C** — dense model that exceeds the VRAM safety budget and is not
  MoE. Sweep over `--gpu-layers` for partial offload.

### VRAM safety budget
`vram_total_mib × vram_safety_budget_pct` (default 0.95). The threshold
below which a fully-GPU config is considered safe from WDDM paging.
See `architecture/design/vram-safety-budget.md`.

### WDDM paging
Windows Display Driver Model behavior where the NVIDIA driver silently
spills GPU memory to system RAM ("Shared GPU memory") via PCIe instead of
raising OOM. Inference continues but throughput collapses 2-4×. The bench
detects this via the perf counter `\GPU Adapter Memory(*)\Shared Usage`,
delta-corrected against a pre-launch baseline. See
`architecture/design/wddm-paging-detection.md`.

### Saturation
`vram_peak_mib / vram_total_mib`. A run is flagged "WDDM-suspect" when
this exceeds `wddm_detection.vram_saturation_threshold` (default 0.92),
even if no shared-memory delta was observed (paging may happen between
poll samples).

### Headroom
`vram_total_mib - vram_peak_mib`. The VRAM left over after a run.
Combined with that run's measured `kv_cache_mib`, projected into
"approximate extra context tokens this config could absorb" in the report.

### Winner
The configuration selected by `Invoke-Report` per group key (default: per
model). The picker prefers a non-paging config over a paging one; with
`-PreferSpeed` the safety preference is bypassed and the highest
`eval_tps` wins. "Paging" is `shared_peak_mib > shared_delta_confirm_mib`
(default 500 MiB) — the same threshold used by the WDDM watchlist.

### Backend
The compute backend baked into a llama.cpp build: CUDA, Vulkan, HIP, SYCL,
Metal, or CPU-only. Detected from sibling `ggml-*.dll` files of
`llama-server.exe`. The bench warns when the build's backend doesn't match
the GPU vendor (e.g. NVIDIA + Vulkan-only build → ~10-15 % slower than CUDA).

## Memory accounting on Windows

Three layers of memory addressable by a llama.cpp run on Windows. The
report's *"Memory vs latency"* scatter draws a horizontal reference line
for each.

- **GPU VRAM** — `vram_total_mib`, dedicated GPU memory. Reading from
  `nvidia-smi --query-gpu=memory.total`.
- **WDDM shared budget** — additional memory the OS lets the GPU
  driver page into. Default Windows policy: ~50 % of system RAM. The
  total addressable GPU-side memory is `vram_total + shared_available`.
  Once this is hit the model fails to load.
- **System RAM total** — full installed RAM. Beyond `vram_total +
  shared_available` the run cannot occur.

Sub-cases: `vram < ram` (typical desktop), `vram == ram` (rare,
balanced), `vram > ram` (data-center cards on a small workstation).

## Vocabulary ratchet

When introducing a new term:

1. Propose its definition in the same PR/branch that introduces it.
2. Update this file in the first commit of that branch.
3. Then write the code, spec, or plan that uses it.

This keeps the docs ahead of the code rather than the other way around.
