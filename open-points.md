# calibr — open points

Operational TODO. Nothing here is blocking. The v0.1.x feature work and the
cross-platform Linux port are done and live on `dev` / `feat/linux-port`
(see the Cross-platform section); this file is the queue for what's next.

Items are grouped by *kind of work*, not strict priority. Within each
group the rough order is "smaller / more isolated first".

---

## Engine + CLI: deferred but designed

### Engine modularization + mirrored test hierarchy
**Shipped in `feat/soc-ps-engine-and-test`.** `calibr.ps1` remains the public
engine entrypoint, but it now bootstraps and dispatches only; the behavior was
mechanically split across dot-sourced files:

```
calibr.ps1
engine/config.ps1
engine/platform.ps1
engine/llama.ps1
engine/discover.ps1
engine/catalog.ps1
engine/plan.ps1
engine/bench.ps1
engine/report.ps1
engine/commands.ps1
```

Tests now mirror the same boundaries under `tests/unit/`, `tests/integration/`,
`tests/static/`, and `tests/smoke/`. The npm bundle script copies
`engine/*.ps1` with the root entrypoint so global installs keep working.

### Phase F — report UI redesign
**Shipped.** See `report.template.html` + the `Phase F` markers in
`tests/integration/report-command.Tests.ps1`. Visual demo:
`node tests/smoke/generate-demo-report.mjs`
writes `report_ui/demo-report.html` from synthetic data. What landed:

- Memory-vs-latency scatter is the first visible chart.
- Filter selector at the top picks the winner criterion: speed /
  efficiency / safety-balanced / overall-weighted (the embryo of
  scoring profiles — item 10 expands it to configurable weights).
- Models list is a collapsible `<details>` per model: collapsed row =
  winning config for the current filter; expand = all configs for the
  model with the winner highlighted.
- Eval-tokens-per-second and VRAM-peak bars are tabs of one widget.
- Client-side `.bat` generation for any config (the engine still
  pre-generates one per model in `data/bats/` for the safety-first
  winner).
- Engine serializes the extended metrics (`ttft_sec`,
  `gpu_power_peak_w`, etc.) and `model_path` / `mmproj_path` into the
  report JSON so the efficiency scorer and the bat generator work.

### llama.cpp auto-fetch
**Shipped in `feat/llama-auto-fetch`.** `init` can download an official
llama.cpp release when `llama-server` is missing; `-AutoFetchLlama` bypasses
the prompt for CLI/headless use, and `all -AutoFetchLlama` passes it through
during auto-init. Downloads land under
`$CALIBR_DATA_DIR/llama-bin/<tag>/<flavor>/`; CUDA on Windows also fetches the
matching `cudart-llama` archive. Follow-ups only if useful: checksum
validation, a config key for tag pinning (currently `CALIBR_LLAMA_CPP_TAG`),
and Metal/macOS auto-fetch once macOS is in scope.

Historical design note: the original fresh-machine problem was that `init`
required the user to have llama-server.exe installed. The shipped path fetches
llama.cpp itself from the upstream releases:

- `https://github.com/ggml-org/llama.cpp/releases/download/<bN>/llama-<bN>-bin-win-cuda-<x>.<y>-x64.zip`
- `https://github.com/ggml-org/llama.cpp/releases/download/<bN>/cudart-llama-bin-win-cuda-<x>.<y>-x64.zip` (only if CUDA build)

Steps:

1. Detect hardware (already done in `Get-DetectedHardware`).
2. Pick the right build flavor: CUDA if NVIDIA GPU present, Vulkan or
   ROCm if AMD, CPU-only as fallback. **CUDA version must match the
   driver** — see compat note below.
3. Resolve the latest build tag from the GitHub releases API (or
   accept a config-pinned `bN`).
4. Download into `~/AppData/Local/calibr/llama-bin/<bN>/`. Unzip there.
   For CUDA, also fetch + unzip cudart into the same dir.
5. Point `llama_server_exe` at the new path; persist in `config.json`.

UX-wise, this means `init` no longer fails when llama isn't installed: it
offers to fetch it in interactive mode and uses `-AutoFetchLlama` for
headless/CLI setups.

**CUDA build picker rules (load-bearing — silently picking the wrong
CUDA variant bricks every bench with a PTX toolchain error):**

| llama.cpp build | CUDA in zip name | Min Windows driver |
|-----------------|------------------|--------------------|
| any             | cuda-12.4        | ~R535+             |
| any             | cuda-13.0        | R580+              |
| any             | cuda-13.1        | R590+              |
| any             | cuda-13.3        | R598+              |
| any             | cpu              | (n/a)              |
| any             | vulkan           | (n/a)              |

The numbers above are empirical (R596.21 on RTX 2070 ran b9360 cuda-13.1
cleanly but failed b9482 cuda-13.3 with `PTX was compiled with an
unsupported toolchain` in `ggml_cuda_kernel_can_use_pdl`). Probe with
`nvidia-smi --query-gpu=driver_version --format=csv,noheader` and pick
the highest CUDA variant whose minimum is `<= driver`. Cuda-12.4 is the
safe default for anything R535+. The README's Requirements section
holds the same table for users who set up manually.

### Main menu guided run / advanced tools split + readiness badges
**Shipped in `feat/soc-ps-engine-and-test`.** The top-level CLI menu is now:

- **Guided run**: the current `all` flow. This is the default consumer path.
- **Advanced tools**: the current individual verbs (`status`, `init`,
  `discover`, `plan`, `bench`, `report`, `reset`, etc.) except `all`, because
  `all` becomes the guided recommendation flow.
- **Configure llama path**: keep as a top-level configuration action, not
  buried under Advanced tools.

Readiness badges:

- `init`: red `*` when required setup is missing, green check when local config
  exists and hardware was detected.
- `configure llama path`: red `*` when `llama_server_exe` is unset/invalid,
  green check when the configured executable exists.

The first screen now answers "what do I need to do next?" without teaching the
user the engine pipeline.

### GGUF multi-shard model management
*Post-Rust/helper-native candidate.*

Current catalog entries assume one `hf_file` per model. Many 80B/100B+ GGUFs
ship as multiple shards, and treating that as "just download more files" is
fragile. Defer this until a native helper / Rust layer can own model
acquisition and cache management.

Needed shape:

- Catalog schema for `hf_files` / shard groups, not only `hf_file`.
- Ordered download with resume, cleanup after partial failures, and per-shard
  size/hash validation when available.
- Disk preflight based on the whole shard set while rotation still keeps peak
  working-set predictable.
- Path handoff to llama.cpp that preserves the expected first-shard filename.
- Clear separation between single-file curated presets and workstation-class
  multi-shard candidates.

### MTP / speculative decoding benchmark mode
*Depends on: current llama.cpp MTP support check.*

Qwen-style MTP models should not be mixed into the normal preset path until the
bench can compare baseline vs MTP fairly. Add an opt-in benchmark mode that:

- Probes `llama-server --help` / version output for MTP support.
- Runs the same model/prompt once as baseline and once with MTP/speculative
  flags.
- Captures `spec_type`, draft tokens, accepted tokens, acceptance rate, and
  `speedup_vs_baseline` when llama.cpp exposes them.
- Keeps prompt eval and generation speed separate; MTP mostly helps decode, so
  a single aggregate TPS number can mislead.

This is especially useful for MoE models, but it belongs in a dedicated track
so the normal "recommend me a model" path stays stable.

### reasoning_mode wiring
*Estimate: 1-2h.*

`models_catalog.json` already carries `reasoning_mode: off` on the
Qwen3 entry, but `Invoke-OneBenchRun` does not pass anything through to
llama-server. Needs:

1. Verify whether current llama.cpp supports `enable_thinking: false` in
   the chat-completion request body, or `--reasoning off` as a startup
   flag. (Last checked when Qwen3 first dropped — may have changed.)
2. Thread the catalog entry's `reasoning_mode` into the bench item via
   `Get-ModelMetadata` / `New-PlanItem`.
3. Modify the bench POST body or the llama-server spawn args based on
   it.

Without this, Qwen3.x catalog entries bench with "thinking" enabled by
default, which 5-10x's eval time and is not what we're measuring.

### Gemma chat-template investigation
*Estimate: 0.5-1h research, then 1-2h implementation.*

`template_note` field marks Gemma 2 / 3 / 4 entries in the catalog.
Gemma uses specific BOS/EOS conventions that may distort timing if the
wrong template is applied. Need to:

1. Verify which template llama.cpp picks by default for each Gemma
   variant (`--chat-template gemma2`, `gemma3`, etc.).
2. If the default is wrong, either pin via `--chat-template <name>`
   or pre-format the prompt accordingly.

Same plumbing as `reasoning_mode` (thread through the bench item).

### Background-thread polling during the bench POST
*Estimate: 2-3h.*

Today's "live" polls run during the LOAD wait only. The bench POST is
synchronous; we take a single post-bench snapshot to grab the peak
GPU power/temp at the hottest moment. This works but isn't real-time.

To capture peaks DURING inference (not just on either side of it):

1. Spawn a PowerShell Runspace before the HTTP POST.
2. Runspace runs the existing `Get-GpuSnapshot` + CIM RAM/disk loop on
   a synchronized hashtable.
3. Main thread does the POST; after the response, reads the
   accumulated peaks from the shared hashtable.
4. Folds those into the per-run record.

Worth doing because the GPU is at its hottest during eval, not load.
Today's peak numbers are biased low.

### CustomBenchView v2
*Estimate: 2h.*

v1 (already shipped) lets the user multi-pick models from the catalog.
v2 adds the rest of what the user designed:

- **Typed search filter** at the top of the model list (live narrowing
  by model/series/variant/id substring).
- **Context-size checkbox set** (16k / 32k / 64k / 96k / 128k / 160k).
  Cross-product with selected models = the actual bench scope.
- **Save as user preset** — writes `data/user_bench_presets.json` so
  the selection can be re-used as a named preset later. The Phase B
  preset loader already merges user presets on top of defaults; this
  closes the loop.

### Per-sample elapsed timer
*Estimate: 30 min.*

The `all -FetchCatalog` per-sample loop already emits `[sample X/N]
sampleId` markers. Adding `[sample-done X/N] sampleId elapsed=MM:SS`
at the end of each iteration would let RunView show per-sample timing
in the live strip — useful when the loop is multi-hour and the user
wants to know "how long did Qwen3.5-9B take vs Gemma 4 E4B".

### Bench summary line rewrite (cosmetic)
*Estimate: 15 min.*

Today the final summary the engine emits at the end of Invoke-Bench is:

```
===============================================================
 calibr bench - done in 1m57s
   2 ok . 0 fail . 0 skipped (out of 2 configs (3 runs each))
   rotated: 1 deleted . 0 kept
===============================================================
```

The user wants:

```
===============================================================
 calibr - bench for {model name} - completed in 1m57s
   configs: 2 ok (100%) - 0 fail - 0 skipped / 3 runs per config
   files: 1 downloaded and deleted . 0 kept
===============================================================
```

Three small wording changes (`calibr - bench for {model}`, add the
`(100%)` ok-rate, "files: N downloaded and deleted" instead of
"rotated"). RunView's SUMMARY_RE will need updating to match the
new shape. The `{model name}` slot only applies for single-model
runs — for the multi-model `all` case fall back to the current
phrasing or list the models separately.

---

## Bigger / design-needed (the user explicitly deferred these earlier)

### CPU + RAM load as first-class bench metrics (capacity = VRAM + RAM)
*Estimate: ~0.5d. Flagged important by the maintainer.*

Today the bench tracks GPU (vram / util / temp / power) and system RAM *used*
(`ram_baseline_mib`, `ram_used_peak_mib`) but **not CPU utilization**, and the
report frames memory as **VRAM vs safety-budget only**. For CPU inference, and
especially **MoE / Tier B** (`--n-cpu-moe` offloads experts to CPU+RAM), the
CPU+RAM side *is* the benchmark — it's how MoE models partially offload off the
GPU. Add:

- **CPU utilization %** during the run, aggregated like `gpu_util_avg_pct`
  (Linux: `/proc/stat` jiffies delta; Windows: WMI / perf counter; macOS:
  `host_processor_info` / `top`).
- **Capacity = VRAM + spill (WDDM/GTT) + RAM**, not just VRAM. A model "fits"
  across GPU VRAM, GPU spill, and CPU RAM together; the report's memory view
  should show that whole picture so MoE partial CPU offload is visible (how
  much landed in RAM/CPU vs GPU), not just "VRAM vs budget".
- Makes the bench meaningful on CPU-only / APU machines and explains MoE
  offload behavior. Builds on the radeontop/GTT + /proc work already landed.

### KV-fill stub
*Estimate: 0.5-1d.*

Synthesize a long prompt to fill KV cache to 25/50/75/95% BEFORE timing
the request. Surfaces real attention-scaling cost at high ctx — today's
bench measures with an effectively-empty cache, so high-ctx numbers
look better than they would in actual chat use.

Design choices to settle:

- Filler content (random tokens? a known long doc?).
- How to express the per-fill-level measurements in the result JSON
  (sub-record per fill level, or separate result records).
- Default opt-in or opt-out per tier?

### Abstention bench
*Estimate: 1-2d.*

Integrate a quality test suite (the user has an abstention-bench they
used in another project — 1724 questions, no auth required). Opt-in,
multi-hour. Per-model honesty score that the report can render
alongside speed.

Open questions:

- Where does the prompt set live? (Bundle? Fetch?)
- Result schema (one row per model, or per (model, config)?).
- How to combine with the speed bench in the final report.

### Scoring profiles in report (configurable weights UI)
*Depends on: extended metrics (done), abstention bench (above).
Filter selector with four hard-coded profiles already shipped in Phase F.*

Replace the four hard-coded profile buttons with a UI that lets the
user dial weights themselves: speed / efficiency (perf/watt) / safety
(no-paging) / honesty / hardware-stress columns, each with a
0-100 slider; "save as user profile" persists to
`data/user_score_profiles.json` so the profile shows up alongside the
defaults.

Tied into the abstention bench for the honesty axis; without it, the
profile can dim that slider as N/A.

### GGUF metadata parser
*Estimate: 0.5d.*

A small PowerShell GGUF reader (no full parser, just the header KV
section) that extracts `<arch>.context_length` so user-owned `.gguf`
files (not in `models_catalog.json`) get a precise per-model context
cap. Today they fall through to the global `max_context_cap`.

---

## Cross-platform (post-Linux)

The Linux port has landed on `feat/linux-port`: engine + CLI under `pwsh`;
AMD GPU metrics via radeontop (live VRAM/util) + glxinfo (VRAM total) +
amdgpu-hwmon power; and GTT-as-`shared_peak_mib` so the VRAM→system-RAM
spill detection (the Windows WDDM equivalent) works on AMD/Linux too.
Follow-ups, lowest-commitment first:

### Platform detection as a fallback chain
*Estimate: 0.5d (refactor, no new behavior on Win/Linux).*

The current platform branches are `if ($IsWin) {...} else { <linux> }`,
so the non-Windows path hardcodes Linux specifics (`/proc`, `/sys`,
`lspci`). Refactor each probe into an ordered chain of providers, trying
each until one answers, so adding an OS = adding one link instead of a
new `if`:

```
cpu_cores  : WMI (Win) -> /proc/cpuinfo [done] -> sysctl (mac) -> nproc -> null
ram_avail  : Win32_OS  -> /proc/meminfo [done] -> vm_stat (mac) -> null
gpu_name   : nvidia-smi -> lspci [done] -> amd-smi -> system_profiler (mac) -> null
vram_total : nvidia-smi -> glxinfo/radeontop [done] -> amd-smi -> (mac: unified) -> manual
vram_used  : nvidia-smi -> radeontop [done] -> amd-smi -> 0
gpu_util   : nvidia-smi -> radeontop [done] -> amd-smi -> 0
gpu_temp   : nvidia-smi -> sysfs hwmon [done] -> amd-smi -> 0
gpu_power  : nvidia-smi -> amdgpu hwmon power1_average [done] -> amd-smi -> 0 (radeon/APU: none)
spill      : WDDM counter (Win) -> GTT via radeontop [done] -> (NVIDIA/Linux: clean OOM) -> 0
```

Linux/AMD links are already in place (the `[done]` rows); the refactor is
to turn the current `if ($IsWin) {...} else {...}` blocks into an explicit
ordered chain so the remaining links (amd-smi, macOS) drop in cleanly.

### AMD dedicated GPUs via amd-smi
*Cannot be verified in-house (no ROCm-class AMD card owned).*

`amd-smi` (successor to `rocm-smi`) is the AMD analog of `nvidia-smi` for
dedicated amdgpu/ROCm cards — VRAM / power / util / temp in one tool. It does
NOT support old APUs (this dev box falls back to radeontop). Add it as the
preferred AMD link in the metrics chain above (before radeontop), parsing
`amd-smi metric --json`. Must be verified by a user with a dedicated AMD GPU.
(`btop` also shows AMD GPU stats but is a mixed system monitor, not a
machine-readable per-GPU source — not suitable as a probe.)

### Experimental macOS support
*Estimate: 0.5-1d. Cannot be verified in-house (no macOS machine owned).*

Extend compatibility with **experimental** support for macOS. The CLI
already allows `darwin` and spawns `pwsh`; the engine runs but the
non-Windows probes are Linux-shaped, so on macOS CPU/RAM/disk/GPU
detection are silent no-ops (bench still works, threads fall back to
the llama.cpp default). Concretely:

- Add the macOS links to the detection chain above (`sysctl`,
  `system_profiler`, `vm_stat`).
- Metal: on Apple Silicon `--gpu-layers` actually offloads (unlike a
  CPU-only build where it is ignored); memory is **unified**, so there
  is no separate VRAM pool and no WDDM-style paging. No per-device VRAM
  readout — `hardware.vram_total_mib` must be set manually for tier
  planning, and memory metrics report 0.
- Backend detection already matches `*ggml-*.dylib` -> flags `metal`.
- **Must be tested by a real user on a macOS machine (which I do not
  own).** This is exactly what the user-diagnostics layer below is for.

### Automated cross-platform testing without owning the hardware
*Estimate: 0.5d.*

- **GitHub Actions `macos-latest`** runs on real Apple hardware and is
  free for public repos — add a job that smoke-tests the macOS detection
  path + a tiny CPU bench. Headless Metal/GPU access is uncertain, but it
  at least guards against regressions in the platform code. (Today CI
  only runs `windows-latest`.)
- **Cloud Macs** (AWS EC2 Mac, MacStadium) if dedicated hardware is ever
  needed. Emulation is not viable: Metal needs a real Apple GPU (no VM on
  non-Apple hardware provides it), and running macOS off Apple hardware is
  against its license — so the only meaningful macOS test is on real
  Apple silicon (CI or a real user's machine).

### User-diagnostics + structured feedback layer
*Estimate: 1-2d. Design discussed in chat: `doctor`/preflight -> redacted,
versioned diagnostic bundle -> GitHub issue-form intake -> opt-in phone-home
(Phase 2). The `doctor` "does llama-server --version run?" check would
auto-diagnose the kind of silent SIGILL this dev box hit (AVX2/BMI2).*

A `doctor`/preflight "check layer" plus a redacted diagnostic bundle and
GitHub issue intake, so failures on machines we don't own come back as
structured, parseable data instead of vague bug reports. Graduates to an
opt-in phone-home once the Phase-2 backend exists. (Captured separately
once the design is settled.)

### GPU-readiness check — guide the user to a working GPU path (esp. AMD APUs)
*Estimate: ~0.5d. Concrete checklist discovered on the Mullins APU dev box.*

App-side `doctor` step that detects whether GPU inference is even possible and
tells the user exactly what's missing + the steps. The decision tree we hit:

- **NVIDIA**: `nvidia-smi` present -> use a CUDA build. Done.
- **AMD - which kernel driver?** `cat /sys/class/drm/card*/device/uevent`:
  - `amdgpu` -> RADV hardware Vulkan works -> build a Vulkan llama-server.
  - `radeon` (legacy, older GPUs like Mullins/Kabini) -> **RADV does NOT
    support it**; `vulkaninfo --summary` shows only `llvmpipe`
    (`PHYSICAL_DEVICE_TYPE_CPU` = software). No real GPU offload. Guide:
    switch the card to amdgpu via kernel params + reboot -
    `radeon.cik_support=0 radeon.si_support=0 amdgpu.cik_support=1
    amdgpu.si_support=1` (experimental for SI/CIK; may be flaky), OR accept
    CPU-only.
  - dedicated AMD (amdgpu/ROCm) -> prefer `amd-smi` for metrics (see above).
- **Vulkan sanity check**: `vulkaninfo --summary` - if the only device is
  `llvmpipe`, warn "no hardware GPU available to Vulkan; inference would run on
  the CPU software rasterizer, slower than the native CPU backend".
- **Tooling the user may need**, surfaced with the exact apt line: `radeontop`
  + `mesa-utils` (AMD metrics), `libvulkan-dev` + `glslc` + `vulkan-tools`
  (to build/verify a Vulkan llama-server).
- **CPU build gotcha** (already noted): on old CPUs lacking AVX2/FMA/BMI2,
  prebuilt llama.cpp SIGILLs - guide to a `-DGGML_AVX2=OFF ...` source build.

This is the "test run / check layer" the maintainer asked for: per machine,
say what's present, what's missing, and the steps to a working GPU (or CPU)
inference path.

---

## Roadmap (CLAUDE.md phases 2/3)

- **Phase 2 — NestJS backend** that exposes the engine operations the
  CLI invokes today. Enables clients other than the CLI and a shared
  online leaderboard.
- **Phase 3 — Angular UI** on top of the backend.
- **Cross-platform**: Linux is **done** — engine + CLI run natively under
  `pwsh` (see the Cross-platform section above), not as a Phase-2 client.
  Remaining: macOS (experimental, untested) and Android (Termux+TS or a
  thin Phase-2 API client).
- **Trusted-publisher npm OIDC** so `NPM_TOKEN` is no longer needed in
  GitHub Actions.

---

## Pointers for whoever picks this up

- Current state: `master` is tagged v0.1.2 on npm; `dev` is the integration
  branch (the v0.1.x feature work — renames, presets, custom view, +18 models,
  minimal-polling, report archival, init-in-all — is already merged there).
  `feat/linux-port` (off `dev`, 6 commits) adds the cross-platform port and is
  ready to fast-forward back into `dev`.
- Engine helpers are split across `engine/*.ps1` and covered by the mirrored
  `tests/unit/*.Tests.ps1` tree.
- CLI views in `cli/src/*.tsx`, with one screen per concern. Engine
  boundary is `cli/src/engine.ts`. CLI smoke install is
  `cli/scripts/smoke-install.js`.
- `CLAUDE.md` documents the current methodology and what's REFERENCE
  ONLY (architecture/, spec/, plans/, memories/).
