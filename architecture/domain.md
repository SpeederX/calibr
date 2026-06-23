# Domain glossary

Authoritative vocabulary for code, documentation, and UI.

## Model taxonomy

| Term | Meaning | Example |
|---|---|---|
| **Lineage** | Developer or brand | Qwen, Gemma, Llama |
| **Series** | One generation within a lineage | Qwen3.5, Gemma-4 |
| **Model** | One size/shape within a series | Qwen3.5-9B |
| **Variant** | Quantization or precision of a model | Q4_K_M, BF16 |
| **Run config** | Runtime flags measured for a variant | ctx=65536, KV=q8_0 |

Use `model`, `series`, and `variant` in data. `family` and `quant` are legacy
aliases only.

## Benchmark vocabulary

### Guided run

The primary product workflow: setup, source selection, scope/policies,
benchmark execution, ranking, and report generation as one user journey.

### Internal stage

A resumable implementation boundary inside guided run. Discovery, planning,
benchmarking, and report generation are stages, not separate product flows.

### Sweep

The dimension varied for a model:

- **context** — context size and KV-cache precision;
- **moe-cpu** — number of MoE expert/FFN layers assigned to CPU;
- **offload** — number of model layers offloaded to the GPU.

#### Sweep aliases and internal routing

Use these names for new user-facing/domain text:

- **context-only** — context size and KV-cache precision on a model expected
  to fit with full GPU offload;
- **context-only-partial-offload** — a context-primary model that still needs
  a small empirical offload check because vanilla/default behavior or measured
  memory pressure suggests full GPU offload may not be the fastest usable point;
- **moe-cpu** — number of MoE expert/FFN layers assigned to CPU;
- **offload-dense** — number of dense model layers offloaded to the GPU when
  full offload is not expected to fit.

Legacy result JSONs and some code paths may still store `context` and
`offload`; treat them as aliases for `context-only` and `offload-dense`.

### Level

Curated model scope: `low`, `middle`, `high`, or `ultra`. Level chooses which
models to consider; sweep chooses how each model is measured.

### Benchmark scope

Guided-run depth policy. `baseline` measures winner-eligible baseline configs.
`load-curves` adds prefill/KV-fill diagnostic profiles. `exhaustive` also keeps
the full speed curve instead of adaptive early-stop. This is separate from
catalog level: level chooses models, benchmark scope chooses campaign depth.

### Run

One measured execution of one run config. In metric schema v5, a run uses one
full-length streaming request after optional warm-up and KV reset.

### Workload profile

The input load applied to a run config: `baseline`, `prefill`, or `kv-fill`.
Prefill and KV-fill profiles carry explicit token targets. The profile and its
targets are part of config identity so cache/resume never mixes different
loads. Diagnostic profiles are not winner-eligible.

Diagnostic load curves are adaptive to the anchor context: one small micro
prefill target establishes the short-prompt baseline, then prefill and KV-fill
use context ratios such as 25/50/75/90%. Tiny fixed targets must not be
presented as evidence for high-context behavior.

### Launch profile

The pair of requested runtime flags and effective values observed from
llama-server logs. Examples: requested context/cache/GPU layers versus effective
slot context, `n_parallel`, slots, offloaded layers, buffers, and Flash
Attention state. Vanilla controls use llama.cpp defaults, so their throughput is
not directly comparable to calibrated configs until the launch profile is shown.

### Control run

A non-winner diagnostic run used for comparison. `vanilla` is the pure
llama.cpp-default control. `vanilla-adjacent` controls add one launch constraint
at a time near the calibrated context target so calibr can attribute a speed gap
to context, parallelism, KV-cache precision, or the remaining runtime flags.
Controls are never launcher winners.

### Winner

The run config selected for a model under the active policy. Balanced policy
prefers configs without confirmed spill, then compares speed and tie-breakers.
Speed policy chooses raw decode throughput.

### Backend

The llama.cpp compute backend: CUDA, Vulkan, HIP/ROCm, SYCL, Metal, or CPU.

## Memory vocabulary

### VRAM baseline

System dedicated VRAM already used before the run.

### VRAM peak

Highest system dedicated VRAM observed during the run. On Windows/WDDM this is
system-level, not reliably attributable to llama-server alone.

### Run VRAM

`VRAM peak - VRAM baseline`, an estimate of the benchmark's dedicated-memory
increment.

### Shared spill

GPU-addressable system memory above the pre-run baseline. On Windows this is
WDDM shared memory; on supported AMD/Linux setups it is GTT.

### Saturation

`VRAM peak / installed VRAM`. High saturation is a risk signal, not direct
proof of spill.

### Headroom

`installed VRAM - VRAM peak`.

### VRAM safety budget

Planning heuristic based on installed VRAM, configured safety percentage, and
estimated non-weight overhead. It narrows candidate configs; measured fit and
spill determine actual safety.

## Timing vocabulary

### Server clock

llama-server timing fields. Used for prefill, decode throughput, TPOT, ITL, and
server TTFT.

### Client clock

calibr timestamps around HTTP and SSE delivery. Used for headers, stream open,
first delivered reasoning/content, delivery gaps, and end-to-end latency.

Never present a client delivery interval as model generation throughput.
