# Plan: hardware-aware offload planning

## Goal

Replace the fixed dense-model offload sweep with a hardware-aware planner that
predicts the useful GPU-layer range, calibrates that prediction against real
llama.cpp allocations, and benchmarks only configurations around the observed
VRAM cliff.

The local planner uses the exact detected memory budget. Discrete
2/4/6/8/12/16/24 GB tiers remain useful for tests, leaderboard comparison, and
hardware guidance, but do not drive a user's sweep.

## Target behavior

### 1. Build a cheap structural estimate from the GGUF

Discovery reads the block count and tensor directory in addition to the
architecture and maximum context collected today. Tensor names, dimensions,
types, and offsets provide estimates for per-block weights, global tensors,
and expert tensors.

This estimate only selects the first probe position. It does not reproduce
llama.cpp's allocator or encode every dense, MoE, recurrent, hybrid-attention,
or sliding-window architecture.

### 2. Derive the budget from the complete local run configuration

Planning starts from detected dedicated VRAM, its configured safety limit, and
the current memory used by the OS and other applications:

```text
safe_cap_mib = installed_vram_mib * safety_fraction
available_mib = safe_cap_mib - current_baseline_vram_mib
```

Context size, KV type, batch/ubatch, flash-attention mode, multimodal
projector, and other allocation-relevant flags must match the configuration
that will later be benchmarked. Fit belongs to the complete run config, not
only to the model file or requested layer count.

### 3. Calibrate with short llama.cpp load probes

calibr starts llama-server with a candidate `--gpu-layers` value, waits for
`server_ready`, records stable hardware counters, parses llama.cpp allocation
logs, and stops the server without generating tokens.

Each probe records:

- requested and actually offloaded layers;
- CUDA and CPU model-buffer sizes;
- KV and CUDA compute-buffer sizes;
- VRAM baseline and stable VRAM after readiness;
- shared-memory growth and load outcome;
- exact allocation arguments and llama.cpp build.

Two probes normally provide a local allocation slope. The predicted cliff is
then validated by another real probe. The planner may use more probes when
allocations are non-linear or a probe fails, but the count is bounded by
configuration. The design does not assume that exactly two probes always
suffice.

### 4. Benchmark densely around the calibrated cliff

The highest verified non-spilling layer count becomes `N_fit`. The benchmark
plan is concentrated around that boundary instead of using the fixed
`[20, 24, 28, 32, 36]` list:

```text
[N_fit - 6, N_fit - 3, N_fit - 1, N_fit, N_fit + 1, N_fit + 3]
```

Values are deduplicated and clamped to the model's valid layer range. Points
above `N_fit` intentionally measure the first spill and its performance cost.
Execution remains ascending so a confirmed overflow can prune higher points.

The normal benchmark remains the source of truth for throughput, latency,
memory pressure, and winner selection. Probe results guide the plan but never
become winners.

### 5. Persist and explain calibration

The plan and report expose why candidates were selected: hardware budget,
probe observations, predicted cliff, verified `N_fit`, and each candidate's
offset from it. This makes wrong predictions diagnosable and allows future
runs with the same model, build, hardware, and allocation settings to reuse
calibration safely.

Dense offload is implemented first. MoE follows with the same probe mechanism,
but its structural estimate separates expert tensors affected by
`--n-cpu-moe`. Static VRAM tiers and purchase guidance are out of scope for
the local planner.

## Current state

Both current planners make this binary decision:

```text
model file size + mmproj size + planning.overhead_mib < safety budget
    -> full-GPU context sweep
otherwise
    -> fixed GPU-layer sweep
```

Current limitations:

- `planning.overhead_mib` is one opaque estimate;
- its comment mentions possible mmproj cost although `Get-SweepKind` already
  adds the mmproj file separately;
- `planning.offload_sweep` is fixed and implicitly tuned around the original
  8 GB development machine;
- current baseline VRAM is not used;
- context, KV type, batch size, topology, and real llama.cpp allocation do not
  participate in the decision;
- discovery reads only GGUF architecture and context length;
- allocation fields are parsed after a benchmark, but no load-only
  calibration operation exists;
- TypeScript and PowerShell duplicate the sweep policy.

## Required implementation

### A. Extend GGUF discovery metadata

Update `engine/discover.ps1` so the GGUF reader retains:

- architecture block count;
- tensor directory entries required for byte accounting;
- estimated bytes grouped into repeated blocks, global tensors, and expert
  tensors.

Storage calculation must account for GGML tensor type, dimensions,
block-quantized formats, and alignment. Unknown types degrade to a coarse
file-size estimate instead of failing discovery.

Add the fields to `catalog.json` and matching TypeScript contracts. Extend
`tests/unit/discover.Tests.ps1` with synthetic GGUF fixtures containing block
names and multiple tensor types.

Likely files:

- `engine/discover.ps1`
- `cli/src/planCore.ts` or a new shared planning contract module
- `tests/unit/discover.Tests.ps1`

### B. Introduce explicit offload-planning configuration

Replace:

```json
"overhead_mib": 1200,
"offload_sweep": [20, 24, 28, 32, 36]
```

with an explicit calibration policy:

```json
"offload_planning": {
  "runtime_reserve_mib": 512,
  "benchmark_offsets": [-6, -3, -1, 0, 1, 3],
  "probe_validation_tolerance_mib": 256,
  "max_probe_count": 4
}
```

`runtime_reserve_mib` is only a conservative first-probe fallback. Observed
allocation takes precedence after a successful probe. The mmproj remains a
separate term and is not hidden inside this reserve.

Update Preferences to describe adaptive planning rather than display a static
layer list.

Likely files:

- `config.default.json`
- `cli/src/PreferencesView.tsx`
- configuration tests and public documentation

### C. Add a TypeScript load-probe operation

Build a probe coordinator on the existing TypeScript lifecycle:

1. construct the same llama-server arguments as the candidate run;
2. start it and wait for readiness;
3. sample VRAM/shared memory until stable;
4. parse allocation data from stderr;
5. stop without issuing a completion;
6. return a typed `LoadProbeResult`.

Reuse `serverLifecycle.ts`, platform metric sampling, and
`parseLlamaServerStderr`; do not create another process-management path.
Missing log fields remain null and hardware counters still determine fit.

Suggested contract:

```text
LoadProbeResult {
  requested_layers
  offloaded_layers
  ready
  load_ms
  vram_baseline_mib
  vram_ready_mib
  shared_growth_mib
  cpu_model_mib
  cuda_model_mib
  kv_cache_mib
  compute_cuda_mib
  fit_under_safe_cap
  error
}
```

Likely files:

- new `cli/src/offloadProbe.ts`
- `cli/src/serverLifecycle.ts`
- `cli/src/resultCore.ts`
- existing platform metric sampler/coordinator modules
- new TypeScript tests with fake lifecycle, stderr, and metric samples

### D. Add the adaptive cliff estimator

Implement a pure TypeScript planner that:

- derives the first probe from GGUF weights and available VRAM;
- chooses a second separated probe;
- fits a local allocation curve from observed total VRAM, not only model
  buffer size;
- predicts the maximum safe layer count;
- validates it with a real probe;
- adds probes or brackets the boundary when error exceeds tolerance;
- returns `N_fit`, diagnostics, and benchmark candidates.

Non-linearity, repeated actual layer counts, server failure, missing stderr,
full-model fit, and zero-layer fit need deterministic bounded fallbacks.

Table-test synthetic 2/4/6/8/12/16/24 GB budgets. These validate scaling but
do not become runtime tiers.

Likely files:

- new `cli/src/offloadPlanner.ts`
- new `cli/tests/offloadPlanner.test.mjs`

### E. Integrate calibration into guided planning

`Invoke-Plan` currently expands a static sweep synchronously in PowerShell.
Hardware probes require lifecycle ownership, so the boundary must change
deliberately.

Recommended incremental path:

1. keep discovery and durable `catalog.json` in PowerShell;
2. move dense offload candidate generation into TypeScript guided planning;
3. run load probes before writing the final `plan.json`;
4. pass calibrated candidates through the adapter;
5. retain a conservative, explicitly documented PowerShell/headless fallback.

PowerShell and TypeScript must not silently implement different adaptive
policies. PowerShell should consume TypeScript planner output or clearly report
that it used the fallback.

Plan items add:

```text
planning_mode = "adaptive-offload"
calibration_id
predicted_fit_layers
verified_fit_layers
fit_offset
probe_count
```

Likely files:

- `cli/src/engine.ts`
- guided-run planning/orchestration components
- `cli/src/planCore.ts`
- `engine/plan.ps1`
- `engine/workflow.ps1`
- `calibr.ps1` only if raw calibration needs an explicit flag

### F. Persist calibration and explain it in results

Store probe records separately from benchmark results. Cache identity includes:

- model file identity/fingerprint;
- llama.cpp build;
- GPU identity and safe budget;
- context and KV types;
- batch/ubatch and allocation flags;
- mmproj identity;
- requested layer count.

Any changed input invalidates reuse. The report distinguishes probe
observations from benchmark measurements. Probe-only records never enter
winner selection or launcher generation.

Likely files:

- a new calibration artifact under the calibr data directory
- `cli/src/resultCore.ts`
- `engine/report.ps1`
- `report.template.html`
- winner-policy parity tests

### G. Tests and real validation

Automated coverage:

- GGUF tensor byte accounting and unknown-type fallback;
- budget calculation with baseline and safety cap;
- probe parsing with complete and partial llama.cpp logs;
- linear and non-linear allocation curves;
- full fit, partial fit, no fit, failed probe, and bounded retry;
- candidate clamping, deduplication, and spill-side points;
- cache identity and invalidation;
- TypeScript/PowerShell fallback behavior;
- calibration records excluded from winners.

Real UAT uses at least:

1. a conventional dense transformer with KV on every attention layer, showing
   a clear context-dependent cliff;
2. Qwen3.5-9B or another recurrent/attention hybrid, verifying sparse KV
   behavior without architecture-specific formulas;
3. a dense model larger than available VRAM, validating partial offload and
   first-spill measurement.

For each model compare the old fixed sweep, predicted and verified `N_fit`,
probe count/duration, measured safe winner, and first-spill throughput loss.

## Delivery order

1. GGUF metadata and pure estimator contracts.
2. Load-only probe coordinator and tests.
3. Adaptive dense offload planning in guided run.
4. Calibration persistence and report explanation.
5. Dense-model UAT and removal of the fixed sweep.
6. Separate follow-up for MoE expert accounting and adaptive
   `--n-cpu-moe`.

## Explicit non-goals

- Predicting exact KV allocation for every architecture statically.
- Using VRAM tiers to choose the local sweep.
- Replacing measured spill detection with an estimate.
- Running token generation during calibration probes.
- Implementing adaptive MoE planning in the first dense delivery.
