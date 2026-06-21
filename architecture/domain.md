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

### Level

Curated model scope: `low`, `middle`, `high`, or `ultra`. Level chooses which
models to consider; sweep chooses how each model is measured.

### Run

One measured execution of one run config. In metric schema v5, a run uses one
full-length streaming request after optional warm-up and KV reset.

### Workload profile

The input load applied to a run config: `baseline`, `prefill`, or `kv-fill`.
Prefill and KV-fill profiles carry explicit token targets. The profile and its
targets are part of config identity so cache/resume never mixes different
loads. Diagnostic profiles are not winner-eligible.

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
