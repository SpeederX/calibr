# How calibr works

This file keeps the implementation-oriented notes out of the public README.
The user-facing path is the npm CLI: `npm install -g calibr`, run `calibr`,
pick `all`, then inspect the winners and report.

## Setup details

`init` produces a local `config.json` with absolute paths from your machine.
It:

- detects GPU + VRAM: `nvidia-smi` on Windows/NVIDIA; on Linux without
  `nvidia-smi`, it reads the GPU name from `lspci` and leaves
  `hardware.vram_total_mib` for you to set when no reliable VRAM readout is
  available
- detects CPU cores/threads: WMI on Windows, `/proc/cpuinfo` on Linux
- searches PATH + sibling folders for `llama-server.exe` on Windows or
  `llama-server` on Linux
- scans configured model folders for `.gguf` files
- writes only override fields; everything else inherits from
  `config.default.json`

`config.json` is gitignored, so personal paths stay out of commits. Open
[config.default.json](config.default.json) for the full schema.

## Legacy / deprecated: run raw calibr from anywhere

The project used to be driven directly through `calibr.ps1`. That path still
exists for maintainers and headless experiments, but it is deprecated as the
primary user workflow. Prefer the npm CLI.

Legacy wrapper install:

```powershell
.\calibr.ps1 install
```

On Linux:

```bash
pwsh ./calibr.ps1 install
```

This writes a wrapper so the raw engine can be launched from anywhere. It is
kept for compatibility while the npm CLI becomes the main product surface.

## Pipeline

`calibr`'s engine is a file pipeline. Each stage writes to a file that the
next stage reads:

```text
       candidate GGUF files
                |
                v
       +------------------+
       |    discover      | --> data/catalog.json
       +------------------+
                |
                v
       +------------------+
       |      plan        | --> data/plan.json
       +------------------+
                |
                v
       +------------------+
       |      bench       | --> data/results/*.json
       +------------------+
                |
                v
       +------------------+
       |      report      | --> data/report.html + data/bats/*
       +------------------+
```

## Stage 1 - discover builds the catalog

`discover` recursively scans `scan_paths`, filtered by `exclude_patterns`.
Defaults skip `mmproj-*.gguf`, `ggml-vocab-*.gguf`, and `*draft*.gguf`.

For each model file:

- **Model** is the filename stem stripped of the variant suffix, for example
  `Qwen3.5-9B-Q4_K_M.gguf` becomes model `Qwen3.5-9B`, variant `Q4_K_M`.
- **Series** is parsed from the model, for example `Qwen3.5-9B` becomes
  `Qwen3.5`.
- **MoE detection** is regex-based: `A\d+B`, `MoE`, or `Mixtral`.
- **mmproj pairing** uses a sibling `mmproj-*.gguf`, with precision preference
  F16, then BF16, then F32.

When a folder contains:

```text
Qwen3.5-2B-UD-Q4_K_XL.gguf
mmproj-F16.gguf
```

the catalog entry records the projector path and later bench configs receive
`--mmproj` automatically.

## Stage 2 - plan expands configs

Each cataloged model becomes a sweep of candidate launch configurations:

| Tier | Entry rule | Sweep dimension | Default values |
|---|---|---|---|
| A | weights + mmproj + overhead fit in the safety budget | context and KV quant | 16K/32K/64K/96K at q8_0; 128K/160K at q4_0 |
| B | model is MoE | `--n-cpu-moe` | 28, 30, 32, 34, 36 |
| C | dense model exceeds the safety budget | `--gpu-layers` | 20, 24, 28, 32, 36 |

Two variants of the same model both get expanded. They compete in the same
model pool unless a future UI chooses to group by variant.

### Safety budget

```text
vram_safety_budget_mib = vram_total_mib * vram_safety_budget_pct
```

Default `vram_safety_budget_pct` is `0.95`. On an 8192 MiB card, that is
7782 MiB. The default is intentionally conservative because Windows WDDM can
spill model memory into system RAM without raising an out-of-memory error.

### Fixed overhead

`tier_classification.overhead_mib` defaults to 1200 MiB. It covers memory that
lives in VRAM besides the model weights:

| Component | Typical size |
|---|---:|
| Compute buffers | 400 - 600 MiB |
| Recurrent / SSM state | 50 - 200 MiB |
| Graph / scheduler metadata | ~100 MiB |
| Driver headroom | ~300 MiB |

Tune it only when repeated runs show systematic OOMs or large unused headroom.

## Stage 3 - bench runs each config

For every planned config:

1. Kill leftover `llama-server` processes.
2. Snapshot baseline VRAM and shared/GTT memory.
3. Spawn `llama-server` with the config flags, base args, and CPU thread args.
4. Wait for `/v1/models` to answer.
5. Warm up once with the same prompt shape so first-run CUDA graph compilation
   does not pollute timings.
6. Run the measured `/completion` request.
7. Read `prompt_per_second` and `predicted_per_second` from llama.cpp timings.
8. Parse stderr for model/KV/host buffers and offloaded layer counts.
9. Compute fit, saturation, and spill fields.
10. Cache the result JSON.

Bench runs are interruptible. Re-running resumes from missing result JSONs
unless the user forces a rerun.

## Stage 4 - report picks winners

The report groups successful results by model and chooses a winner with this
rule:

```text
safety first; among equally safe configs, higher eval tokens/s wins
```

This is intentional. A 30 t/s config that avoids spill is more useful than a
50 t/s config that collapses once another app takes some VRAM.

The report emits:

- `data/report.html`: scatter, winner rows, throughput/memory bars, WDDM/GTT
  watchlist, all-results table
- `data/bats/*`: launchers for winning configs
- `data/results/*.json`: raw per-config results for later analysis

## WDDM and GTT spill detection

On Windows/NVIDIA, saturated VRAM may page into "Shared GPU memory" through
WDDM. The model keeps running, but token generation pays PCIe round-trips and
throughput collapses.

calibr records:

- `shared_peak_mib`: peak shared/GTT memory above baseline
- `wddm_vram_saturation`: `vram_peak_mib / vram_total_mib`
- `fit_status`: summarized fit outcome

On AMD/Linux, `radeontop` exposes the analogous GTT signal. On NVIDIA/Linux,
OOMs usually fail cleanly, so there is no silent spill signal to detect.

## Output layout

```text
calibr/
|-- config.default.json      committed defaults
|-- config.json              gitignored local overrides
|-- calibr.ps1               legacy engine implementation
|-- models_catalog.json      bundled catalog
|-- default_bench_presets.json
|-- report.template.html
|-- cli/                     npm CLI
|-- docs/                    README images
`-- data/                    gitignored runtime artifacts
    |-- catalog.json
    |-- plan.json
    |-- results/
    |-- logs/
    |-- bats/
    `-- report.html
```
