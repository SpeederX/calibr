# calibr roadmap

> calibr — measure, don't guess: benchmark llama.cpp on consumer GPUs.

Priority-ordered backlog grouped by target version. The top of each
section is what's next. Rationale for the shape lives in
[`architecture/design/roadmap-priorities.md`](architecture/design/roadmap-priorities.md).
Concise — one line per item; the whole file should fit on a single
screen. Mark items `[x]` when shipped.

## Done

- [x] Pipeline: discover → plan → bench → report
- [x] Tier classification (A/B/C, MoE detection via filename regex)
- [x] WDDM paging detection (Windows shared-memory delta + saturation)
- [x] Backend cross-check (warn when NVIDIA GPU but Vulkan-only build)
- [x] Model-skip on `unknown model architecture` errors (saves ~10 min/run)
- [x] `Write-Progress` bar + ETA + summary table during bench
- [x] Curated reference set: `samples.json` + `get-sample-models`
- [x] One-shot `all -DownloadSamples` for fresh installs
- [x] Config CLI: `list / get / set / unset / detect`
- [x] `install / uninstall` (User-scope PATH, no admin)
- [x] `help` system, unified naming on `calibr` everywhere
- [x] `.cmd` wrapper for cmd.exe + PowerShell
- [x] Test suite (custom Describe/It harness, 42 tests, no external deps)
- [x] CI workflow scaffold (`.github/workflows/tests.yml`, runs on push/PR to dev/master)
- [x] git init, master + dev branches, v0.1.0 tagged
- [x] Reorder VRAM bar chart ascending (least = top, matching "less is better")
- [x] 2D scatter chart: memory (Y) vs latency (X), GPU VRAM line with RAM tint above
- [x] VRAM-headroom annotation per config (`+N MiB ≈ +M tokens` on CUDA; MiB only on Vulkan)
- [x] Scatter chart log-scale X axis (orders of magnitude readable)
- [x] `dense_overrides` exact-match list for MoE filename false positives
- [x] `-PreferSpeed` flag (winner picker can opt out of safety preference)
- [x] Picker uses `wddm_detection.shared_delta_confirm_mib` as the paging
      threshold (was a too-strict `> 0`). Default + `-PreferSpeed` now diverge
      meaningfully on real desktops with Chrome/Discord baselines.
- [x] **v1.0.0**: taxonomy rename (`family` → `model`, `quant` → `variant`,
      add `series`); project rename (`llm-lab` → `calibr`); methodology
      doc allows MINOR breaking changes post-v1 while still offline.
- [x] **v1.0.1**: documentation and methodology sync

## Open

### v1.1.0 — quick wins

- Download rotation: bench one, delete, next. Working set ~100 GB → ~20 GB.
- `localmaxxing-export` subcommand for the public leaderboard.
- N-run with median for variance reduction (currently ±5 % on `eval_tps` at N=1).

### v1.2.0 — report-interface overhaul

- Memory-tier reference lines on scatter (VRAM, +WDDM shared, +system RAM).
- Bar charts grouped by model, collapse/expand.
- Column-header tooltips and `?` overlays explaining each metric.
- All-results table: sort, search, group-by-model toggle.
- Frontend test harness via Edge headless.

### v1.3.0 — KV-cache degradation, measured on hardware

- Empirical quality test of KV-cache quantization (q8 / q4 / f16) on the user's hardware. Open: metric, dataset, report integration.
- Cross-reference llmfit's theoretical estimates against measured numbers; report the delta.

### v1.4.0 and later — incremental

- Wattage tracking via `nvidia-smi`.
- Efficiency metric (tokens per joule).
- Accuracy task suite, 5–10 representative tasks (UI code, simple code gen).
- Speculative-decoding planning.
- Surface project version in `calibr.ps1` (help banner plus a `--version` flag). Source of truth stays the git tag; the engine reads it at build/install time or via a generated constant.

### v2.0.0 — programming-interface layer (landmark)

- Decide the form: local C library, local C++ library, local web service, or other.
- Refactor `calibr.ps1` into an engine library + CLI shell.
- First reference client (likely the CLI itself).
- Opens the way for the future `calibr-ui` repository and a possible web dashboard.

### v3.0.0 — multi-GPU planning (landmark, long shot)

- Planning with `--tensor-split` across more than one card.
- Per-card VRAM accounting and paging detection.

### Cross-cutting (no version pin)

- Linux/macOS port: NVML in place of the WDDM heuristic; shell rc files in place of Windows user PATH; a `calibr` shell wrapper (no extension).
- Android exploration (Termux + llama.cpp ARM64 builds).
- Release automation (version bump, tag, changelog from commits).

## Architectural notes

- **Two audiences, two interfaces.** Technical users stay on the command-line interface offered by `calibr.ps1`. Less technical users will be served by a future graphical interface in its own repository, `calibr-ui`, built on top of this tool's programming interface. Same engine, two surfaces — not two versions of the tool, and not maintained in this repository.
- **GUI / web dashboard lands at v2.0.0 or later, never before.** Both depend on the programming interface shipped in v2.0.0. The form of that interface (local C library, local C++ library, local web service, or another) is undecided and is part of the v2.0.0 planning work itself.
- **The accuracy task suite stays narrow:** 5–10 representative tasks. It is not a general evaluation framework, and avoiding that scope creep is the explicit choice.
