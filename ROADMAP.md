# llm-lab roadmap

Concise. One line per item. The entire file should fit on a single screen.
Mark items `[x]` when shipped. Move stale items to bottom or remove.

## Done

- [x] Pipeline: discover → plan → bench → report
- [x] Tier classification (A/B/C, MoE detection via filename regex)
- [x] WDDM paging detection (Windows shared-memory delta + saturation)
- [x] Backend cross-check (warn when NVIDIA GPU but Vulkan-only build)
- [x] Family-skip on `unknown model architecture` errors (saves ~10 min/run)
- [x] `Write-Progress` bar + ETA + summary table during bench
- [x] Curated reference set: `samples.json` + `get-sample-models`
- [x] One-shot `all -DownloadSamples` for fresh installs
- [x] Config CLI: `list / get / set / unset / detect`
- [x] `install / uninstall` (User-scope PATH, no admin)
- [x] `help` system, unified naming on `llm-lab` everywhere
- [x] `.cmd` wrapper for cmd.exe + PowerShell
- [x] Test suite (custom Describe/It harness, 42 tests, no external deps)
- [x] CI workflow scaffold (`.github/workflows/tests.yml`, runs on push/PR to dev/master)
- [x] git init, master + dev branches, v0.1.0 tagged
- [x] Reorder VRAM bar chart ascending (least = top, matching "less is better")
- [x] 2D scatter chart: memory (Y) vs latency (X), GPU VRAM line with RAM tint above
- [x] VRAM-headroom annotation per config (`+N MiB ≈ +M tokens` on CUDA; MiB only on Vulkan)

## Open — code & UX

- [ ] **Scatter chart log-scale X axis**: the linear time axis is dominated by
      Tier C configs (~100 s+) and squishes Tier A (sub-second) into the
      origin. Switch to log-10 scale so the dot spread reflects relative
      latency across orders of magnitude. Keep all configs on one chart
      (no tier-split).
- [ ] N-run with median for variance reduction (current ±5 % on `eval_tps`).
- [ ] `dense_overrides` list to bypass MoE filename regex false positives.
- [ ] `-PreferSpeed` flag to disable WDDM-safety preference in winner picker.
- [ ] Speculative decoding: pair small drafter with big target; sweep `--draft-max`.
- [ ] Quality scoring: small task suite per config (truthful-qa subset, HumanEval-mini).

## Open — portability

- [ ] **Linux/macOS port**: NVML-based equivalent of WDDM perf-counter heuristic.
      `Get-LlamaBackends` to recognize `.so` / `.dylib`. `install/uninstall` to
      write to shell rc files instead of Windows User PATH. Shell wrapper
      `llm-lab` (no extension) mirroring `llm-lab.cmd`.
- [ ] Android exploration (Termux + llama.cpp ARM64 builds).
- [ ] Multi-GPU planning with `--tensor-split`.

## Open — process

- [ ] GitHub remote + push (currently local-only).
- [ ] Release automation (bump version, tag, generate changelog from commits).
