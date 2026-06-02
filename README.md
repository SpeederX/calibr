# calibr — measure, don't guess: benchmark llama.cpp on consumer GPUs

> A `--ctx-size 262144` flag silently caused Windows to page model weights to
> system RAM, dropping eval from 45 t/s to 10 t/s. No error, no warning.
> `calibr` automates the discovery of that cliff and the configuration that
> avoids it.

`calibr` is a benchmark crawler/tester for local GGUF models served by
[llama.cpp](https://github.com/ggml-org/llama.cpp). Its sweet spot is NVIDIA
CUDA on Windows — where it also detects the silent WDDM VRAM-to-RAM paging
cliff — but it **runs on Linux too**. **It has no opinions about which models
you should have.** You decide what sits on disk; it catalogs them, sweeps a
planned set of configurations, runs each one, and emits an HTML dashboard plus
per-model optimized launchers (`.bat` on Windows, `.sh` on Linux).

![dashboard screenshot](docs/screenshot.png)

> **Windows + Linux.** On Windows, calibr detects silent VRAM-to-RAM paging via
> a Windows-specific perf counter (`\GPU Adapter Memory(*)\Shared Usage`) — the
> signal it was originally built around. On Linux there is no equivalent
> counter and the driver OOMs cleanly, so that detection is **skipped**: the
> engine benches throughput and picks winners on speed + fit. The Linux engine
> runs under [PowerShell Core (`pwsh`)](https://github.com/PowerShell/PowerShell);
> GPU VRAM/power metrics come from `nvidia-smi` when present (NVIDIA), otherwise
> degrade to best-effort temperature from sysfs (e.g. AMD), with RAM/disk read
> from `/proc`. See [`CLAUDE.md`](CLAUDE.md) for the phased direction.

> **For an LLM (or contributor) reading this**: start with
> [`CLAUDE.md`](CLAUDE.md) — it documents the current methodology,
> the three-phase product direction (CLI → backend → web UI), and what
> is REFERENCE ONLY vs authoritative. The folders `architecture/`,
> `spec/`, `plans/`, `memories/` are kept for history but do not
> reflect current practice. Domain vocabulary (`model` / `series` /
> `variant` / `tier` / `WDDM` / `headroom`) still lives in
> [`architecture/domain.md`](architecture/domain.md).

---

## Contents

- [Quickstart](#quickstart)
- [Why not just …?](#why-not-just-)
- [Want comparable numbers across machines?](#want-comparable-numbers-across-machines)
- [Requirements](#requirements)
- [Setup details](#setup-details)
- [Usage](#usage)
- [Reference dataset — `get-models`](#reference-dataset--get-models)
- [How it works](#how-it-works)
- [WDDM paging detection](#wddm-paging-detection)
- [Output layout](#output-layout)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Quickstart

Two ways to run, same engine underneath.

**Interactive CLI** (recommended — Node + Ink TUI with menus, forms, a
live progress strip, and a results browser):

```powershell
npm install -g calibr
calibr
```

You get a menu: `init`, `discover`, `plan`, `bench`, `report`, `all`,
`results`. Walk through it with arrow keys + enter. The `all` form
defaults to downloading the curated reference set and rotating files
off disk per model, so peak disk stays bounded to the largest single
model (~20 GB).

**Raw engine** (no Node required — useful for headless / CI):

```powershell
# Windows (Windows PowerShell 5.1)
git clone https://github.com/SpeederX/calibr.git    # or your fork
cd calibr
.\calibr.ps1 init                # detect HW + write config.json
.\calibr.ps1 all                 # discover -> plan -> bench -> report
start data\report.html           # open the dashboard
```

```bash
# Linux (PowerShell Core — install pwsh first: https://github.com/PowerShell/PowerShell)
git clone https://github.com/SpeederX/calibr.git
cd calibr
pwsh ./calibr.ps1 init           # detect HW + write config.json
pwsh ./calibr.ps1 all            # discover -> plan -> bench -> report
xdg-open data/report.html        # open the dashboard
```

Winning configurations land in `data/bats/{model}.bat` on Windows (double-click
to launch) or `data/bats/{model}.sh` on Linux (an executable `chmod +x` script)
— either way, llama-server runs with the optimized flags.

Don't have any `.gguf` files yet? Add `-FetchCatalog` and calibr
walks the curated set one model at a time (download → bench → delete):

```powershell
# full curated set, ~85 GB total bandwidth, ~20 GB peak on disk
.\calibr.ps1 all -FetchCatalog

# just one sample (fast, ~500 MB, finishes in minutes)
.\calibr.ps1 all -FetchCatalog -CatalogId qwen3.5-0.8b-q4xl
```

## Why not just …?

Several tools sit nearby in this space, mostly doing different things
from `calibr`. Some **estimate from hardware constants** without ever
running the model. Some **measure runtime parameters** (prompt size,
batch size, concurrency) rather than launch-time flags. Some
**aggregate community submissions** without measuring on your machine
at all. `calibr`'s slice is narrower and concrete: it measures
launch-flag configurations on **your own hardware** and reports which
one wins.

| Tool | Approach | Gap (relative to calibr) |
|---|---|---|
| llmfit | Pure estimation, hardcoded hardware constants | Does not measure on hardware; mixture-of-experts models treated as dense. TBD — pending hands-on test. |
| llm-checker | Ollama-focused, deterministic scoring, `ai-run` subcommand measures tokens per second | No mixture-of-experts support; Ollama only; no launch-flag sweep. TBD — pending hands-on test. |
| llama-benchy | Sweep over runtime parameters (prompt processing, token generation, depth, concurrency) | Sweeps runtime, not launch flags. TBD — pending hands-on test. |
| llama-bench (built-in to llama.cpp) | Single-configuration benchmark | No sweep across launch flags. |
| llama-sweep-bench | Sweep over performance parameters | Fork-specific to ik_llama; not applicable to mainline llama.cpp. |
| LocalMaxxing | Community leaderboard aggregator | Depends on third-party submissions; no measurement on the user's own hardware. |
| Bench360 | Academic benchmark framework | Not consumer-facing. |

## Want comparable numbers across machines?

Run `.\calibr.ps1 get-models -DownloadAll` (~100 GB) to populate a
[curated reference set](#reference-dataset--get-models) spanning 0.8B
dense up to 31B MoE. Anyone running the same set on different hardware
produces directly comparable `data/results/*.json` files — drop them into a
shared repo to crowdsource a "what runs well on what GPU" dataset.

## Requirements

**Windows (full feature set, incl. WDDM paging detection):**

- **Windows 10/11** with PowerShell 5.1+
- **NVIDIA GPU + recent driver** (tested on RTX 2070 8 GB, compute 7.5)
- `nvidia-smi` on PATH (bundled with the NVIDIA driver)

**Linux (throughput benchmarking; WDDM detection skipped):**

- **PowerShell Core (`pwsh`)** — [install guide](https://github.com/PowerShell/PowerShell).
  The engine is the same `calibr.ps1`, run under `pwsh`.
- A GPU is optional. On **NVIDIA** with `nvidia-smi` on PATH you get VRAM /
  power / temp / util metrics; on other GPUs (e.g. AMD) those degrade to
  best-effort GPU temperature from sysfs, and VRAM-budget planning is opt-in
  (set `hardware.vram_total_mib` yourself). CPU-only works too.

**Both platforms:**

- A **llama.cpp build** — get a release from the
  [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases)
  (CUDA recommended on NVIDIA), or build from source. A Vulkan-only build also
  works on NVIDIA, but is ~10-15% slower; `bench` prints a yellow warning if it
  spots this mismatch. Older builds may lack newer model architectures —
  `bench` detects "unknown model architecture" failures and skips the
  remaining tests of the affected model instead of running them all to fail.
  *(Note: on older CPUs lacking AVX2/FMA/BMI2, prebuilt binaries may crash with
  SIGILL — build llama.cpp with `-DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_BMI2=OFF`.)*

## Setup details

`init` is interactive (or pass `-NonInteractive`) and produces `config.json`
with absolute paths from your machine. It:
- detects the GPU + VRAM: `nvidia-smi` on Windows/NVIDIA; on Linux without
  `nvidia-smi` it reads the GPU name from `lspci` and leaves `vram_total_mib`
  for you to set (no reliable VRAM readout on, e.g., the AMD `radeon` driver)
- detects CPU cores/threads: WMI on Windows, `/proc/cpuinfo` on Linux
- searches PATH + sibling folders for the llama-server binary
  (`llama-server.exe` on Windows, `llama-server` on Linux) and `.gguf` directories
- writes only the override fields; everything else inherits from `config.default.json`

`config.json` is in `.gitignore`, so personal paths stay off your fork.
Open [`config.default.json`](config.default.json) for the full schema with
inline comments.

You can edit `config.json` by hand, or use `config get/set/unset` from the
command line — see [Editing config from the CLI](#editing-config-from-the-cli)
below.

### Run `calibr` from anywhere

On Windows the repo ships with `calibr.cmd`, a thin wrapper around the
PowerShell script. Run `install` once to put this directory on your user PATH:

```powershell
.\calibr.ps1 install
```

On Linux, `install` instead writes a small executable wrapper to
`~/.local/bin/calibr` (which runs the engine through `pwsh`); make sure
`~/.local/bin` is on your PATH:

```bash
pwsh ./calibr.ps1 install
```

That's it. Now from any directory:

```powershell
calibr help
calibr status
calibr bench -Model Qwen3.5-9B
calibr config set hardware.vram_safety_budget_pct 0.92
```

`install` writes only the User-scope PATH (no admin rights), is
idempotent, and patches the current shell session so you don't have to
reopen the terminal. To revert, run `calibr uninstall`.

The wrapper sets `-ExecutionPolicy Bypass -NoProfile`, so it works on
locked-down machines and starts faster (no profile load). One caveat: if
you set `scan_paths` to a relative path like `"."`, that resolves to your
current working directory at invocation time — use absolute paths (e.g.
`config set scan_paths "D:\models"`) to make the global command
location-independent.

## Usage

After `calibr install` you can drop the `.\calibr.ps1` prefix; before
that, every command works the same way with the prefix from the project
directory.

```powershell
calibr init                # one-time setup -> config.json
calibr discover            # scan scan_paths[] for .gguf -> data/catalog.json
calibr plan                # generate test configs -> data/plan.json
calibr bench               # run pending configs -> data/results/*.json
calibr report              # HTML + .bat for winners -> data/report.html + data/bats/
calibr all                 # discover + plan + bench + report
calibr status              # state + config + global-install indicator
calibr config <list|get|set|unset>  [<key>] [<value>]   # inspect/edit config
calibr install / uninstall # add or remove this dir from user PATH
calibr help [<command>]    # general help, or detail for one command
calibr get-models   # curated reference shelf (see below)
```

Run `.\calibr.ps1 help <command>` for the usage block + flags + examples of
any subcommand (e.g. `help bench`, `help config`).

### Filters

| Flag | Effect |
|------|--------|
| `-Model <regex>` | Only operate on models whose name matches |
| `-Tier {A,B,C}`   | Only operate on the selected tier |
| `-Id <pattern>`   | Only run configs whose test ID matches (wildcards ok) |
| `-DryRun`         | Print what would be done; don't run llama-server |
| `-Force`          | Re-run tests whose results already exist |

### CLI overrides (skip config.json editing)

| Flag | Used by | Effect |
|------|---------|--------|
| `-ScanPath <path[,path,...]>` | `discover`, `init`, `all` | Replaces `scan_paths` for this run |
| `-LlamaServer <path>`         | `bench`, `report`, `init`, `all` | Replaces `llama_server_exe` for this run |
| `-GroupBy {model,model+variant}` | `report`, `all` | How to group results when picking winners. Default `model`. With `model+variant` you get a separate winner (and `.bat`) per variant. |
| `-FetchCatalog`            | `all` | Run `get-models` before the pipeline. Without a filter implies "download everything"; combine with `-CatalogId` or `-Model` to narrow. |

```powershell
# Compare Q4 vs Q8 of the same model by giving them separate winners
.\calibr.ps1 all -GroupBy model+variant
# -> data/bats/Qwen3.5-9B_Q4_K_M.bat
# -> data/bats/Qwen3.5-9B_Q8_0.bat
```

### Common workflows

```powershell
# A. You already have .gguf files on disk
.\calibr.ps1 init      # one-time setup, writes config.json
.\calibr.ps1 all       # discover -> plan -> bench -> report

# B. Start fresh with the curated reference set (one shot, download + bench)
.\calibr.ps1 all -FetchCatalog                            # ~100 GB; prompts to confirm
.\calibr.ps1 all -FetchCatalog -CatalogId qwen3.5-9b-q4km  # one model, ~5 GB
.\calibr.ps1 all -FetchCatalog -Model "Qwen3.5"           # one model

# C. Pure CLI, no config.json (CI / try-and-throw-away)
.\calibr.ps1 get-models -CatalogId qwen3.5-0.8b-q4xl -Destination .\models
.\calibr.ps1 all -ScanPath .\models -LlamaServer "C:\bin\llama-server.exe"
```

### Editing config from the CLI

You don't have to open `config.json` to tweak settings. Four sub-actions cover
the common workflow:

```powershell
.\calibr.ps1 config list                                         # all keys, type, [default] vs [local]
.\calibr.ps1 config get hardware.vram_total_mib                  # one value
.\calibr.ps1 config get hardware                                 # whole subtree
.\calibr.ps1 config set hardware.vram_safety_budget_pct 0.92     # write to local override
.\calibr.ps1 config set scan_paths "D:\models,E:\cache"          # CSV for arrays
.\calibr.ps1 config set bench.warmup false                       # bools: true/false/1/0/yes/no
.\calibr.ps1 config unset hardware.vram_safety_budget_pct        # remove override, default applies
```

- Types are inferred from `config.default.json` (so `... vram_total_mib 8192`
  becomes int, not string). Keys with `null` defaults auto-detect from the
  value shape (digits → int, decimal → float, true/false → bool).
- `config set` writes only the leaf you specified into `config.json`;
  everything else continues to inherit from `config.default.json`. This
  matches the override-only philosophy — your fork stays clean.
- Trying to `set` a key that doesn't exist in the schema is rejected (so a
  typo doesn't silently bury a flag). Add new keys by editing
  `config.default.json` directly.

When `-FetchCatalog` runs without a configured scan path (no `config.json`,
no `-ScanPath`), calibr puts the files in `./downloaded-models/` under the
project root and points `discover` there automatically.

## Reference dataset — `get-models`

To make benchmark numbers **comparable across machines**, the repo ships a
curated list of reference GGUF models in [`models_catalog.json`](models_catalog.json)
spanning 0.8B up to 31B, dense and MoE. Anyone running `get-models`
gets the same dataset, so reported tokens/s on different hardware can be
compared directly.

```powershell
.\calibr.ps1 get-models                                    # list (OK = on disk)
.\calibr.ps1 get-models -CatalogId qwen3.5-9b-q4km          # download one
.\calibr.ps1 get-models -Model "Gemma-4"                   # by model
.\calibr.ps1 get-models -DownloadAll                       # all (~100 GB, prompts to confirm)
.\calibr.ps1 get-models -DownloadAll -DryRun               # preview
.\calibr.ps1 get-models -CatalogId qwen3.5-9b-q4km -Destination "D:\models"
```

Files land at `{scan_paths[0]}/{target_dir}/{hf_file}` so a subsequent
`discover` picks them up automatically.

| Tier hint | Model | Approx size | Why it's in the reference set |
|-----------|--------|-------------|-------------------------------|
| A | Qwen3.5 0.8B Q8_0 + Q4_K_XL    | 0.5 - 0.8 GB | Bandwidth/sanity baseline |
| A | Qwen3.5 2B UD-Q4_K_XL + BF16   | 1.3 - 3.5 GB | Multimodal small + quality reference |
| A | Qwen3.5 4B Q4_K_M              | 2.6 GB       | Mid-size dense |
| A | Qwen3.5 9B Q4_K_M              | 5.2 GB       | 8-GB-VRAM sweet spot |
| C | Qwen3.5 27B Q4_K_S             | 15 GB        | Partial-offload case |
| B | Qwen3.6 35B-A3B UD-Q4_K_M      | 20 GB        | MoE routing (3B active) |
| A | Gemma-4 E2B / E4B Q4_K_M       | 2.3 / 4.6 GB | Multimodal (vision + audio) |
| B | Gemma-4 26B-A4B UD-Q4_K_M      | 15 GB        | MoE counterpart to Qwen3.6 |
| C | Gemma-4 31B Q4_K_M             | 18 GB        | Large dense, partial offload |

When a download fails: 401 = accept license on HuggingFace; 404 = open a PR
fixing `models_catalog.json`; flaky network = fall back to `huggingface-cli download`.

## How it works

`calibr`'s pipeline is five sequential stages, each writing to a file the
next one reads:

```
       you (or get-models)
                │
                ▼
       ┌──────────────────┐
       │  .gguf files on  │ ◄── config.json (scan_paths, llama_server_exe, hardware)
       │  scan_paths[...] │
       └────────┬─────────┘
                │
                ▼
       ┌──────────────────┐
   1.  │     discover     │ ──► data/catalog.json   (N models, metadata)
       └────────┬─────────┘
                │
                ▼
       ┌──────────────────┐
   2.  │       plan       │ ──► data/plan.json      (K configs, K >> N)
       └────────┬─────────┘
                │
                ▼
       ┌──────────────────┐
   3.  │      bench       │ ──► data/results/*.json (one JSON per config)
       └────────┬─────────┘
                │
                ▼
       ┌──────────────────┐
   4.  │      report      │ ──► data/report.html   + data/bats/{group_key}.bat
       └──────────────────┘
```

### Stage 1 — `discover` builds the catalog

Recursive glob of `scan_paths`, filtered by `exclude_patterns` (defaults skip
`mmproj-*.gguf`, `ggml-vocab-*.gguf`, `*draft*.gguf`). For each surviving file:

- **Model** is the filename stem stripped of the variant suffix, e.g.
  `Qwen3.5-9B-Q4_K_M.gguf` → model `Qwen3.5-9B`, variant `Q4_K_M`.
- **Series** is parsed from the model (e.g. `Qwen3.5-9B` → series `Qwen3.5`).
- **MoE detection** is regex on the model: matches `A\d+B` (e.g. `Qwen3.6-35B-A3B`)
  or contains `MoE` / `Mixtral`. *(See [Known limitations](#known-limitations) for false-positive risk.)*
- **mmproj pairing**: a sibling `mmproj-*.gguf` in the same directory is
  auto-paired by precision preference (F16 → BF16 → F32). Concrete example:
  if the folder contains
  ```
  Qwen3.5-2B-UD-Q4_K_XL.gguf
  mmproj-F16.gguf
  ```
  the catalog entry for `Qwen3.5-2B-UD-Q4_K_XL.gguf` records
  `mmproj = ".../mmproj-F16.gguf"`, and every benchmark for that model gets
  `--mmproj "..."` injected automatically.

### Stage 2 — `plan` expands each model into a config sweep

Each cataloged model produces N test configurations based on its tier:

| Tier | Entry rule | Sweep dimension | Default values | # configs |
|------|-----------|-----------------|----------------|----------:|
| **A** | `model_size + mmproj_size + overhead < vram_safety_budget` | (ctx, KV quant) pairs from `tier_a_candidates` | 16K/32K/64K/96K @ q8_0; 128K/160K @ q4_0 | 6 |
| **B** | model is MoE | `--n-cpu-moe` from `moe_ncpumoe_sweep` | `[28, 30, 32, 34, 36]` | 5 |
| **C** | `model_size + overhead >= vram_safety_budget` and not MoE | `--gpu-layers` from `c_ngl_sweep` | `[20, 24, 28, 32, 36]` | 5 |

Two quants of the same model both get expanded — if you have
`Qwen3.5-0.8B-Q8_0.gguf` and `Qwen3.5-0.8B-UD-Q4_K_XL.gguf`, plan generates
12 configs (6 Tier A candidates × 2 variants). Both compete in the same model
pool when `report` picks winners.

#### `vram_safety_budget` defined explicitly

```
vram_safety_budget_mib = vram_total_mib × vram_safety_budget_pct
```

Default `vram_safety_budget_pct = 0.95`. On an RTX 2070 (8192 MiB) that's
`7782 MiB`. The 0.95 came from empirical observation on Windows 11: above
~95% VRAM use, the WDDM driver starts paging to system RAM (Shared GPU
Memory), and inference throughput collapses 2-4× without any error message.
Keeping the safety budget below this cliff avoids the issue.

If you have a 24-GB card and want to push closer to the limit, raise the pct
to 0.97 or 0.98 in `config.json`. If you keep heavy GPU compositors open
(many Chrome tabs, video calls), lower it to 0.90.

#### `overhead` defined explicitly

The `overhead_mib` budget (default `1200`, in `tier_classification.overhead_mib`)
covers everything that lives in VRAM **besides the model weights**:

| Component | Typical size |
|-----------|--------------|
| Compute buffers (one-shot tensors per forward pass) | 400 - 600 MiB |
| Recurrent / SSM state (for hybrid models like Qwen3.5) | 50 - 200 MiB |
| Graph / scheduler metadata | ~100 MiB |
| Driver headroom (avoids hitting the WDDM cliff during transients) | ~300 MiB |

Tune `overhead_mib` if your bench runs are repeatedly OOM-ing or, conversely,
leaving large VRAM unused.

The Tier A entry rule effectively reads "*the weights plus their mmproj plus
fixed overhead must fit in the safety budget*", and is used as a pre-flight
check so a 27 GB Q8 model isn't even considered for full-GPU configs.

### Stage 3 — `bench` runs each config

For every config:

1. Kill any leftover `llama-server.exe`. Snapshot baseline VRAM and Shared GPU memory.
2. Spawn `llama-server` with the config's flags + `base_args` from config + thread flags from `hardware.cpu_*`.
3. Wait up to `bench.wait_sec_ready` for `/v1/models` to respond 200.
4. **Warmup** — one identical-prompt completion with `cache_prompt=true`, `n_predict=8`. This compiles CUDA graphs for the actual batch sizes. **Without this the first prompt reports ~10× slower `prompt_tps`**, which would silently pollute every comparison.
5. **Bench** — the real `/completion` call, `cache_prompt=false`, `n_predict` from config. Pull `prompt_per_second` and `predicted_per_second` from the server's own timings.
6. Kill the process; parse stderr for `CUDA0 model buffer size`, `CUDA0 KV buffer size`, `CUDA_Host compute buffer size`, `offloaded N/M layers`, etc.
7. Compute WDDM flags (saturation %, shared-memory delta).
8. Cache to `data/results/{TestID}.json`. Subsequent runs skip configs whose JSON already exists, unless you pass `-Force`. **A long bench run is safely interruptible** — kill it any time and re-run; only missing tests re-execute.

### Stage 4 — `report` picks winners and emits artifacts

Results are grouped by `-GroupBy` (default `model`):

```text
for each result where ok == true:
    safe = (shared_peak_mib <= 0)         # no WDDM paging delta
    winner[group_key] = this result if:
      - no current winner for this group, OR
      - this is safe and current is not (safety upgrade), OR
      - both equally safe/unsafe AND this has higher eval_tps
```

Safety preference is intentional: a 30 t/s safe config is more useful than a
50 t/s config that's one Chrome tab away from collapsing.

Output:
- `data/report.html` — sortable tables, per-model winner cards, charts, WDDM
  watchlist (configs where `shared_peak_mib > shared_delta_confirm_mib` or
  `vram_saturation > 0.92`).
- `data/bats/{group_key}.bat` — one launcher per group with the winning
  cmdline, annotated header reporting the measured numbers.

## WDDM paging detection

> **Windows only.** This entire mechanism is skipped on Linux (no equivalent
> counter; the driver OOMs cleanly). On Linux, winners are picked on throughput
> + fit, and the WDDM fields below are simply recorded as zero/false.

On Windows, when VRAM is saturated the NVIDIA driver **does not raise OOM** —
it pages to "Shared GPU memory" (a slice of system RAM mapped via PCIe). The
model continues to run, but each token incurs PCIe round-trips, collapsing
eval throughput by 2-4×. Two heuristics are recorded in every result:

1. **`shared_peak_mib`** — peak of `Get-Counter "\GPU Adapter Memory(*)\Shared Usage"` *minus* the baseline measured before launching `llama-server`. Subtracting the baseline is essential — Chrome and Discord on a desktop can hold hundreds of MiB of shared GPU memory at all times. Treating absolute shared usage as paging would false-flag every run.
2. **`wddm_vram_saturation`** — `vram_peak_mib / vram_total_mib`. Above
   `wddm_detection.vram_saturation_threshold` (default 0.92) the run is
   marked as suspicious even if shared delta was zero (paging may happen
   between the polling samples).

A result is "**confirmed paging**" when the shared delta exceeds
`wddm_detection.shared_delta_confirm_mib` (default 500 MiB). Smaller deltas
are treated as background drift.

## Output layout

```
calibr/
├── config.default.json      # committed, no personal paths
├── config.json              # gitignored, written by `init`
├── calibr.ps1              # the tool
├── models_catalog.json             # committed, the reference shelf
├── report.template.html     # committed, HTML skeleton with %%placeholders%%
├── README.md
├── LICENSE
├── .gitignore
├── docs/
│   └── screenshot.png       # the dashboard image embedded above
└── data/                    # gitignored, all runtime artifacts
    ├── catalog.json         # discovered models
    ├── plan.json            # planned test configs
    ├── results/             # one JSON per test
    ├── logs/                # llama-server stderr per test
    ├── bats/                # winner launchers
    └── report.html          # the dashboard
```

## Known limitations

- **WDDM paging detection is Windows-only.** The shared-memory polling that
  detects silent paging uses `Get-Counter \GPU Adapter Memory(*)\Shared Usage`,
  a Windows-specific perf counter with no Linux equivalent. calibr now runs on
  Linux (under `pwsh`), but there it skips WDDM detection and picks winners on
  throughput + fit. macOS is untested.
- **GPU metrics are limited on non-NVIDIA Linux.** Without `nvidia-smi`, VRAM /
  power / utilization aren't read (the AMD `radeon` driver exposes no
  `mem_info_vram`); only GPU temperature (sysfs `hwmon`) and system RAM/disk
  (`/proc`) are captured. VRAM-budget tier planning needs a manual
  `hardware.vram_total_mib`.
- **MoE detection is a regex on the filename.** `model =~ /A\d+B/` correctly
  matches `Qwen3.6-35B-A3B` and `Mixtral-8x7B`-style names but a model
  innocently named `something-A100B-special.gguf` would be false-flagged as
  MoE and routed to a `--n-cpu-moe` sweep. Add the model to
  `config.dense_overrides` (case-sensitive, exact match) to opt it back out
  of Tier B classification.
- **Single GPU only.** No `--tensor-split` planning or per-device VRAM
  tracking. Multi-GPU users have to point `-LlamaServer` at a build that
  defaults to the right device.
- **Winner picker doesn't model quality.** Q4 is preferred over BF16 if it
  generates faster, even though BF16 has higher fidelity. If you care about
  the tradeoff, look at the report's per-model table and pick by hand —
  every number is preserved. (A future opt-in quality bench is being
  explored — see Roadmap.)
- **No HuggingFace authentication for `get-models`.** Models that
  require accepting a license (notably some Gemma variants) will return 401.
  Accept the license once on the website, or download those particular files
  with `huggingface-cli` separately.
- **Per-model `max_context` only honored for curated samples.** Entries in
  `models_catalog.json` carry `max_context` (scraped from the upstream model card),
  and `plan` skips Tier A candidates above it. User-owned `.gguf` files
  outside `models_catalog.json` fall back to the global `max_context_cap` (default
  262 144) — a future GGUF metadata parser would derive the per-model cap
  from the file itself.

## Roadmap

Direction lives in [`CLAUDE.md`](CLAUDE.md) (the project pivoted from a
strict SemVer + spec-driven backlog to a three-phase product approach:
CLI → backend → web UI). Concrete near-term ideas being explored:

- **Real-time metrics during bench**: stream CPU/GPU load + temperature,
  system-RAM pressure, disk read/write, GPU power draw into the CLI run
  view — and persist them on each result for the report.
- **TTFT (time-to-first-token)** as a first-class metric alongside
  `prompt_tps` / `eval_tps`. Free to measure, captures the felt latency
  for chat-style use.
- **KV-fill stub**: synthesize a long prompt to fill the KV cache to
  25/50/75/95% before timing, so `prompt_tps` reflects the attention-scaling
  cost at real-world context lengths instead of an empty-cache best case.
- **Optional quality bench**: integrate a small abstention test suite
  (the no-auth tasks only, opt-in via flag, multi-hour) and surface a
  per-model honesty score alongside speed.
- **Scoring profiles in the report**: weighted matrices over speed,
  efficiency, honesty, hardware stress, etc., so the same data renders
  multiple leaderboards.
- **GGUF metadata parser** for user-owned models: derive `max_context` and
  the architecture key from the binary header so the plan filter is exact
  for any model, not just curated samples.
- **Phase 2 — NestJS backend** that exposes the engine operations the CLI
  invokes today. Enables clients other than the CLI and a shared online
  leaderboard.
- **Phase 3 — Angular UI** on top of the backend.
- **Linux support has landed** (engine + CLI run under `pwsh`; WDDM detection
  skipped). Next on the cross-platform front: a native Linux GPU-metrics path
  (`rocm-smi` / amdgpu sysfs for AMD VRAM), macOS support, and Android as a
  Phase 2 API client.

## Contributing

The fastest first contribution is a new entry in `models_catalog.json` for a
model not yet covered (verify the HuggingFace URL resolves and add the
correct `max_context`).

The engine is one cross-platform PowerShell file (`calibr.ps1`, ~3 400 lines;
runs under Windows PowerShell 5.1 and `pwsh` on Linux) plus a test harness in
`tests/`. The CLI is a small Node + Ink + TypeScript app in `cli/` (~2 100
lines of TS). The HTML report template
(`report.template.html`) is self-contained — vanilla CSS plus ~150 lines
of inline JS, no build step.

## License

[MIT](LICENSE).
