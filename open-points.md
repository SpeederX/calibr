# calibr - open points

Operational TODO for the current product phase. Keep this file as a live radar:
only open work, no shipped feature archaeology.

Current baseline:

- npm package line: `0.1.6`.
- `dev` contains the Phase-1 CLI, engine split, mirrored tests, expanded
  presets, report redesign, guided llama.cpp auto-fetch, Linux support,
  `doctor`, the guided-run / advanced-tools menu split, and readiness badges.
- Public-facing docs stay in `README.md` and `cli/README.md`.
- Process rules live in `AGENTS.md`.

Recently shipped and removed from the TODO queue:

- Engine modularization plus mirrored PowerShell tests.
- Report UI redesign.
- llama.cpp auto-fetch and guided setup prompt.
- Main-menu guided run / advanced tools split with setup badges.
- Linux port, dependency checks, GPU-readiness doctor path, and diagnostic
  export.
- npm trusted-publishing release path.

---

## Near-term polish

### Doctor issue template

Add `.github/ISSUE_TEMPLATE/` for "doctor report / startup failure" issues.
The template should ask for:

- `calibr doctor -Export`
- `calibr doctor -Export -Extended` when logs are needed
- OS, GPU, llama.cpp build, and whether the user used auto-fetch or a custom
  `llama-server`

This closes the loop between the diagnostic bundle and useful user reports.

### Auto-fetch hardening

The happy path is shipped. Remaining useful hardening:

- checksum or size validation for downloaded llama.cpp archives
- config-level build pinning, not only `CALIBR_LLAMA_CPP_TAG`
- clearer cache listing / cleanup for `llama-bin`
- Metal/macOS auto-fetch once macOS support is actually in scope

### Results action: re-run selected config

The results screen can show winners, but cannot re-run a selected config yet.
Add an action that launches `bench -Force` with the model/config already
selected from the result row.

### Per-sample elapsed timer

The catalog bench loop already emits per-sample start markers. Add a matching
completion marker:

```text
[sample-done X/N] sampleId elapsed=MM:SS
```

RunView can then show useful timing during long guided runs.

### Bench summary wording

Rewrite the final bench summary into a more user-facing shape:

```text
===============================================================
 calibr - bench for {model name} - completed in 1m57s
   configs: 2 ok (100%) - 0 fail - 0 skipped / 3 runs per config
   files: 1 downloaded and deleted - 0 kept
===============================================================
```

For multi-model runs, keep a generic title or list model names separately.
Update RunView parsing with the engine change.

---

## Engine and benchmark correctness

### CPU + RAM as first-class metrics

GPU metrics are strong; CPU and system RAM still need to become first-class
bench signals. This matters for CPU-only machines, APUs, and MoE partial
offload where capacity is really VRAM + spill/GTT + RAM.

Needed:

- CPU utilization percentage during inference
- capacity view across VRAM, shared/spill memory, and system RAM
- report changes that explain CPU/RAM offload instead of framing everything as
  VRAM-only

### Background polling during bench POST

Live polling currently covers load wait more than inference. Add a background
poller during the synchronous HTTP POST so peak GPU power/temp/util and RAM
are captured while inference is actually running.

### reasoning_mode wiring

Catalog entries can mark `reasoning_mode`, but the bench path does not yet
thread that into llama.cpp. Verify the current llama.cpp switch/API shape, then
pass the catalog setting into either server startup args or the chat request
body.

This is especially important for Qwen reasoning models, where default thinking
can distort speed measurements.

### Gemma chat-template verification

Verify which chat template llama.cpp chooses for Gemma 2 / 3 / 4 entries. If
defaults are wrong, add catalog-driven template wiring in the same path used for
`reasoning_mode`.

### KV-fill benchmark mode

Add an opt-in mode that fills KV cache to known levels before timing
generation. This reveals attention-scaling cost at high context sizes, which
the current mostly-empty-cache benchmark hides.

### GGUF metadata parser

Add a small GGUF header reader for user-owned models so calibr can extract the
model context cap instead of falling back to the global `max_context_cap`.

---

## Model acquisition and advanced modes

### GGUF multi-shard model management

Defer until a native helper / Rust layer is justified. Workstation-sized
80B/100B+ models often ship as multiple shards, and robust handling needs more
than another string field.

Needed shape:

- catalog schema for ordered shard groups
- resumable download with partial-failure cleanup
- per-shard validation when hashes are available
- disk preflight for the whole shard set
- correct handoff of the first shard path to llama.cpp

### MTP / speculative decoding benchmark mode

Keep this out of the normal recommendation path until it can be compared
fairly. Add an opt-in mode that runs baseline vs MTP/speculative decoding and
captures draft tokens, accepted tokens, acceptance rate, and speedup.

This is useful for MoE models, but it needs a dedicated report track so normal
throughput numbers stay comparable.

### Abstention / behavioral quality bench

Speed-only recommendation is the current product. A future quality layer can
add abstention and behavioral tests, producing an honesty/quality axis beside
throughput and fit.

Open choices:

- bundled prompt set vs fetched prompt set
- result schema: per model or per model/config
- how to combine quality with speed in the final recommendation

### Configurable scoring profiles

The report has fixed profile buttons. A future version can expose sliders for:

- speed
- efficiency
- safety/headroom
- honesty/quality
- hardware stress

Persist user profiles to `data/user_score_profiles.json`.

---

## Cross-platform

### Platform probe fallback chain

Windows and Linux work, but probe logic should become provider-based instead of
large OS branches. This makes macOS and Android easier to add without spreading
platform checks through the engine.

Example shape:

```text
cpu_cores  : WMI -> /proc/cpuinfo -> sysctl -> nproc -> null
ram_avail  : Win32_OS -> /proc/meminfo -> vm_stat -> null
gpu_name   : nvidia-smi -> lspci -> amd-smi -> system_profiler -> null
vram_total : nvidia-smi -> glxinfo/radeontop -> amd-smi -> manual/unified -> null
vram_used  : nvidia-smi -> radeontop -> amd-smi -> 0
gpu_util   : nvidia-smi -> radeontop -> amd-smi -> 0
gpu_temp   : nvidia-smi -> sysfs hwmon -> amd-smi -> 0
gpu_power  : nvidia-smi -> amdgpu hwmon -> amd-smi -> 0
spill      : WDDM shared counter -> GTT/radeontop -> 0
```

### AMD dedicated GPUs via amd-smi

Experimental provider wiring is in the current line: `amd-smi` is preferred
for ROCm-class metrics when present, with `radeontop` / sysfs fallbacks
preserved. Remaining work is real-machine validation on a dedicated AMD GPU
and any parser tuning needed for the exact `amd-smi --json` shape.

### Experimental macOS / Metal validation

Experimental detection is wired in the current line:

- `sysctl` / `vm_stat` for CPU + memory
- `system_profiler` for GPU + Metal capability
- unified-memory fields alongside the existing `vram_total_mib`
- npm `os` metadata includes `darwin`

Remaining: run `doctor`, `init`, and a tiny CPU/Metal smoke on real Apple
hardware or `macos-latest`, then tune the unified-memory budget if needed.

### Android experimental path

Do not port the PowerShell engine to Android. The credible path is a direct
llama.cpp adapter:

- MVP: Termux + Node CLI + direct `llama-cli` / `llama-server` adapter
- `doctor` detects Android/Termux, ARM64, RAM, storage, and Vulkan visibility
- later consumer app: Kotlin/Compose + llama.cpp Android binding or JNI

Android should get separate `mobile` / `mobile-plus` presets because RAM,
thermal throttling, storage, and battery make desktop tiers misleading.

---

## Future product phases

### Phase 2 backend

NestJS service exposing the engine operations the CLI invokes today. This
enables other clients and a shared leaderboard / feedback loop.

### Phase 3 web UI

Angular UI on top of the Phase-2 API. Do not scaffold before the API exists and
the CLI has clarified the needed workflows.

### Opt-in diagnostics upload

Once Phase 2 exists, `doctor` can optionally upload a redacted diagnostic bundle
instead of asking users to attach it manually.
