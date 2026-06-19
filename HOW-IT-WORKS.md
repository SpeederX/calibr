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
   - context/KV sweep for models expected to fit;
   - CPU-expert sweep for MoE models;
   - GPU-layer offload sweep for oversized dense models;
   - cap contexts at model metadata and selected policy limits.
5. **Benchmark**
   - start llama-server and wait for readiness;
   - optionally warm up, then reset the KV slot;
   - issue one full-length streaming request;
   - use llama-server timings for official prefill/decode throughput;
   - collect TTFT, TPOT, ITL, delivery, VRAM/RAM, power, temperature, and
     utilization from the same measured run;
   - repeat and aggregate according to metric policy.
6. **Rank and report**
   - select winners using the active policy;
   - render `data/report.html`;
   - generate launch scripts;
   - retain raw result JSON and per-run telemetry.

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

Metric schema v4 uses one measured streaming request per run:

```text
optional warm-up -> KV erase -> measured stream
```

The measured request has fixed output length, deterministic sampling,
`timings_per_token`, and continuous socket draining. Official `prompt_tps` and
`eval_tps` come from the server clock; client timestamps are used only for
HTTP/SSE delivery and perceived latency. See [METRICS.md](METRICS.md).

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
