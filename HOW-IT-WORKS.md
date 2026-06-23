# How calibr works

calibr is a guided TypeScript CLI around llama.cpp. The user starts `calibr`,
chooses policies in one screen, and receives ranked results plus an HTML
report. The implementation still uses durable intermediate artifacts so runs
can resume and be inspected, but those artifacts are not separate user
journeys.

## Runtime ownership

```text
Ink CLI / guided run
        |
        v
TypeScript policy + EngineAdapter
        |
        +-- TypeScript: lifecycle, repeated runs, HTTP/SSE, metrics,
        |                aggregation, live/result views
        |
        `-- PowerShell adapter/fallback
             |-- platform/config/catalog operations
             |-- discovery and sweep expansion
             |-- non-CUDA fallback execution
             `-- report file emission
```

The CLI invokes the raw `all` verb once. `engine/workflow.ps1` coordinates the
internal stages. Direct PowerShell verbs remain available for maintainers,
headless experiments, diagnostics, and resuming a specific artifact boundary.

## Guided workflow

1. **Resolve setup**
   - select or download `llama-server`;
   - detect hardware;
   - choose a local model folder or catalog scope;
   - apply run count, context, cleanup, winner, and polling policies.
2. **Acquire models**
   - use existing GGUF files, or download catalog entries one at a time;
   - catalog downloads are interleaved with benchmarking so peak disk use is
     close to the largest active model rather than the whole preset.
3. **Index candidates**
   - scan GGUF files;
   - derive lineage/series/model/variant metadata;
   - pair sibling multimodal projectors.
4. **Expand run configs**
   - add one untuned llama.cpp control per model, excluded from winner
     selection;
   - quality-first context/KV sweep for models expected to fit: every primary
     context target uses `q8_0/q8_0`; `q4_0/q4_0` is a conditional fallback at
     the same context after direct capacity evidence;
   - for MoE models, estimate expert tensor placement from GGUF metadata and
     load-probe an initial `--n-cpu-moe` allocation anchor;
   - for dense models, estimate an initial GPU-layer position from GGUF tensor
     storage, then run bounded load-only probes against the detected VRAM
     budget;
   - verify the highest non-spilling layer count and expand a GPU-layer sweep
     around that measured cliff;
   - cap contexts at model metadata and selected policy limits;
   - attach an explicit workload profile and token targets to every config;
   - inspect the selected `llama-server --help`, adapt cache types to the
     values exposed by that build, and omit unsupported optional harness flags.

The CLI labels this phase `planning & load calibration`. It reports the
current model and each bounded load probe, including the tested GPU-layer or
`n-cpu-moe` allocation, fit outcome, and observed ready-state VRAM. These are
real llama-server loads rather than in-memory plan expansion, so large model
sets can spend substantial time here before token generation begins.
5. **Benchmark**
   - start llama-server and wait for readiness;
   - optionally warm up, then reset the KV slot;
   - issue one full-length streaming request;
   - use llama-server timings for official prefill/decode throughput;
   - collect TTFT, TPOT, ITL, delivery, VRAM/RAM, power, temperature, and
     utilization from the same measured run;
   - integrate sampled GPU-board power over the complete run and retain full
     UTC start/end timestamps plus elapsed duration;
   - repeat and aggregate according to metric policy.
6. **Rank and report**
   - select winners using the active policy;
   - render `data/report.html`;
   - generate launch scripts;
   - retain raw result JSON, per-run telemetry, and one command/stderr log per
     run config under `data/logs`;
   - expose both the benchmark leaderboard and retained run logs under the
     CLI's `results` menu.

The vanilla control receives only the model/support assets plus unavoidable
benchmark harness arguments for localhost networking and temporary state. It
does not receive calibr's base arguments, context size, cache types, GPU-layer
count, MoE placement, batch/thread tuning, or `--fit off`. It uses the same
prompt, generation length, request policy, warmup policy, and repeat count as
the optimized configs. This is a product-value comparison against real
llama.cpp defaults, not an isolated single-flag microbenchmark; the report
therefore shows both configurations and labels the claim accordingly. Result
rows also carry a launch profile: requested context/cache/offload flags plus
effective slot context, parallelism, offloaded layers, buffer sizes, and Flash
Attention state parsed from llama-server logs when available.

Adaptive offload probes reuse the TypeScript llama-server lifecycle and
hardware sampler. They force `--fit off`, disable warmup and prompt-cache
retention, wait for stable ready-state memory, then stop without inference.
The generated benchmark configs also use `--fit off`, preventing llama.cpp
from silently changing the allocation that planning selected. If the adapter
or required GGUF metadata is unavailable, PowerShell reports and uses the
explicit conservative fallback.

## llama.cpp argument compatibility

llama.cpp's canonical CLI registry lives in
[`common/arg.cpp`](https://github.com/ggml-org/llama.cpp/blob/master/common/arg.cpp),
but calibr does not identify support from a hard-coded build-number table.
The selected executable is the authority: calibr parses its `--help` output,
records option aliases and the allowed K/V cache types, and validates every
generated launch before starting the server. Unsupported cache requests fall
back quality-first to `q8_0`, then `f16`; optional harness flags such as
`--cache-ram`, `--slot-save-path`, and `--no-warmup` are emitted only when the
build exposes them. A missing required sweep flag produces an explicit
compatibility failure instead of a misleading readiness timeout.

This runtime capability contract survives backports and custom builds better
than version inference. Git history for `common/arg.cpp` remains useful for
maintainers when adding aliases or understanding a transition.

Shared-memory growth is retained as probe diagnostics but is not a standalone
fit veto: on WDDM, intentional CPU-offloaded model buffers may appear as
shared GPU memory. The load boundary uses readiness, dedicated VRAM against
the safety cap, and an explicit llama.cpp fit failure.

Successful probe sets are stored separately under
`data/calibrations/<calibration_id>.json`. Benchmark results carry only the
calibration id, fitted boundary, probe count, and candidate offset; probe
records never enter ranking or winner selection.

Guided planning may reuse a successful calibration when the model, mmproj,
llama.cpp executable, GPU budget, allocation flags, context/KV settings, and
planning policy still match. The cached VRAM baseline must also remain within
the configured tolerance and the record must be younger than
`cache_max_age_hours`; otherwise calibr probes again. Results and reports
identify whether planning used fresh probes or a cached calibration.

For MoE, llama.cpp keeps expert weights from the first `N` layers on CPU.
calibr maps that inverse axis to the same monotonic load-time estimator used
for dense GPU layers, then maps the result back to `--n-cpu-moe`. Unlike dense
offload, this load-fit point is only an anchor: runtime routing can activate
expert weights through WDDM shared memory even when dedicated VRAM looked
acceptable at startup. The actual benchmark therefore samples near the anchor,
at proportional CPU-offload points, and near full expert CPU offload. Winner
selection remains empirical and can prefer a much larger `--n-cpu-moe`.
When diagnostic workloads are enabled, calibr completes the baseline MoE
sweep first, selects its empirical speed winner, then runs the configured
prefill and KV-fill targets only on that placement. This preserves diagnostic
coverage without multiplying every MoE allocation candidate by every workload.
Large WDDM shared allocations remain visible for MoE, but are not called
confirmed spill unless llama.cpp itself reports a fit failure: CPU expert
mapping can legitimately appear in the shared-memory counter.

Cache reuse belongs to the current benchmark campaign even when the underlying
measurement is older. Reused results retain their original
`measurement_session_*` provenance while their `bench_session_*` fields are
stamped with the campaign that consumed them, so the report's latest-session
view does not hide valid cached baselines.

Context candidates may define K and V cache types independently. The legacy
single `kv` field remains shorthand for a symmetric pair. Winner tie-breaking
scores both sides, with more weight on K, so a larger context using rescue
`q4_0/q4_0` does not silently outrank a near-equivalent higher-quality cache.

## Why internal stages still exist

The stage modules are useful implementation boundaries:

| Internal module | Responsibility | Durable output |
|---|---|---|
| `discover.ps1` | inspect model files and normalize metadata | `data/catalog.json` |
| `plan.ps1` | expand models into candidate run configs | `data/plan.json` |
| `bench.ps1` + TS coordinator | execute and measure configs | `data/results/*.json` |
| `report.ps1` + TS result policy | build the consumable report | `data/report.html`, launchers |

These boundaries provide resume, cache, auditability, and focused tests. They
do not imply that users should manually run four commands.

## Benchmark request

Metric schema v5 uses one measured streaming request per run and adds complete
run duration plus sampled GPU-energy integration:

```text
optional warm-up -> KV erase -> measured stream
```

The measured request has fixed output length, deterministic sampling,
`timings_per_token`, and continuous socket draining. Official `prompt_tps` and
`eval_tps` come from the server clock; client timestamps are used only for
HTTP/SSE delivery and perceived latency. See [METRICS.md](METRICS.md).

Opt-in workload sweeps use the largest valid context config for each model.
Prefill profiles send a tokenizer-sized long prompt from an empty slot.
They use one small micro target plus context-relative targets such as
25/50/75/90%, so a 131K context produces a real high-context load curve instead
of several unrelated tiny prompts. KV-fill profiles use the same ratios: they
first cache that long prefix in the same slot, then measure a streaming request
that extends it. The final response's `cache_n` confirms the actual reused
prefix. Diagnostic workloads are never launcher winners.

On llama-server builds that cannot erase slots for multimodal servers, calibr
skips the optional warm-up so the measured request still starts cold.

## Memory and fit

Windows/NVIDIA uses system-level dedicated VRAM plus WDDM shared-memory
deltas. Linux/AMD can use GTT via `radeontop`. NVIDIA/Linux generally fails
cleanly on OOM. Per-process VRAM is not claimed when the platform cannot
attribute it reliably.

The balanced winner policy prefers configurations without confirmed spill.
Speed mode ignores that preference. High saturation remains a warning rather
than proof of paging.

## Configuration

`config.default.json` contains committed defaults and schema. Gitignored
`config.json` contains local overrides only. CLI session choices override both
without requiring users to edit JSON.

## Main files

```text
cli/                    TypeScript CLI and migrated runtime logic
engine/workflow.ps1     unified raw workflow orchestration
engine/*.ps1            adapter, platform, and internal stage modules
calibr.ps1              raw engine entrypoint
report.template.html    self-contained report application
data/                   runtime artifacts
```
