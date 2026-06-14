# calibr - open points

Operational TODO for the current product phase. Keep this file as a live radar:
only open work, no shipped feature archaeology.

Current baseline:

- npm package line: `0.1.7`.
- `dev` contains the Phase-1 CLI, engine split, mirrored tests, expanded
  presets, report redesign, guided llama.cpp auto-fetch, Linux support,
  `doctor`, the guided-run main menu, and readiness badges.
- Public-facing docs stay in `README.md` and `cli/README.md`.
- Process rules live in `AGENTS.md`.

---

## 0.1.8 candidate track

These are the next larger product improvements to keep in view after the
current guided-run cleanup line.

Proposed order:

1. Prune unused legacy paths and duplicated UI/engine behavior.
2. Move the HTTP benchmark client toward TypeScript where stream parsing and
   telemetry are easier to maintain.
3. Add benchmark metric glossary / latency work and prompt-length prefill
   sweep.
4. Add opt-in telemetry / leaderboard submission when the server-side
   Cloudflare + PHP token layer exists.
5. Add MTP/speculative decoding support if it stays small enough for 0.1.8;
   otherwise shift it to 0.1.9.

### Engine pruning before deeper migration

Before moving more logic out of PowerShell, remove or isolate legacy branches
that no longer map to the current guided-run product.

Targets:

- stale command flags kept only for old prototype workflows
- duplicated model/catalog/filter behavior across CLI screens
- old report/backlog documentation that increases context without guiding
  current work

The goal is to shrink the surface before a TypeScript benchmark-client
migration, not to rewrite the engine wholesale.

### TypeScript benchmark-client migration

Move the llama.cpp HTTP request/response handling out of PowerShell in small
steps, keeping the existing engine adapter boundary.

Good first migration targets:

- chat/completions request building
- streaming response parsing for `ttfr_ms` / `e2e_ttft_ms`
- request timing and retry/error classification
- telemetry event serialization, redaction, and upload

Keep platform probing, model discovery, planning, and launcher generation in
PowerShell until a concrete reason appears to move each one.

### Benchmark metric glossary and latency pass

Make every benchmark metric explicit in the result schema and report. The
report should explain what each value measures, how it is measured, and why it
matters in the pipeline.

Candidate metric names:

- `load_ms`: `llama-server` process start to server-ready; model load plus
  backend/runtime initialization.
- `prompt_ms`: prefill / prompt-processing time reported by llama.cpp. This
  varies with prompt length, system prompt shape, context already loaded, and
  model architecture.
- `prompt_tps`: prefill throughput.
- `ttfr_ms`: time to first streamed response chunk, aligned with
  llama-benchy / vLLM-style terminology.
- `e2e_ttft_ms`: end-to-end time to first generated content token.
- `eval_tps`: decode / token-generation throughput.
- `total_request_ms`: full request duration, excluding model load.

Implementation note: robust stream timing is awkward in PowerShell. Consider
moving the HTTP benchmark client into TypeScript before adding `ttfr_ms` /
`e2e_ttft_ms`, while keeping the rest of the engine boundary intact.

### Prompt-length prefill sweep

Add an opt-in mode that varies prompt length to show how prefill cost scales.
This is not a quality test; it answers how quickly the model processes short,
medium, and long inputs.

Suggested buckets:

- short prompt
- medium chat/system prompt
- long synthetic prompt
- near-context stress prompt, bounded by the selected context size

Track `prompt_ms`, `prompt_tps`, memory deltas, and whether the model remains
usable under the longer prefill load.

### MTP / speculative decoding support

Unsloth documents llama.cpp MTP support around `--spec-type draft-mtp` and
`--spec-draft-n-max`. Treat this as an opt-in benchmark mode, not part of the
normal recommendation path until numbers are comparable.

Catalog shape to add:

```json
{
  "mtp": {
    "supported": true,
    "mode": "draft-mtp",
    "draft_file": "mtp-gemma-4-12B-it.gguf",
    "draft_n_default": 2,
    "draft_n_sweep": [1, 2, 3, 4, 5, 6],
    "extra_memory_mib": 2048
  }
}
```

Model notes:

- Gemma 4 MTP can use an `mtp-` prefixed draft GGUF via `--model-draft`.
- Qwen3.6 / Qwen3.5 MTP often lives in dedicated MTP GGUF repos and may not
  require a separate `--model-draft` file in the manual path.
- Unsloth suggests `--spec-draft-n-max 2` as a starting point, but recommends
  trying `1..6` because the best value is hardware-dependent.
- MTP needs extra memory; start with a conservative `extra_memory_mib` around
  2048 until measured locally.

Benchmark shape:

- baseline run without MTP
- MTP run with `draft_n_default`
- optional MTP sweep across `draft_n_sweep`
- same prompt/context/sampler settings between baseline and MTP runs
- report baseline eval t/s, MTP eval t/s, speedup, extra RAM/VRAM, best
  `spec-draft-n-max`, and failures caused by memory pressure

Keep sampler settings deterministic by default. Current bench requests set
`temperature = 0.0` and do not sweep `top_p`, `top_k`, `min_p`, or sampler
order. If sampler sweeps become useful, treat them as a separate benchmark
mode from hardware-fit recommendation.

### Benchmark telemetry and leaderboard upload

Add opt-in benchmark-result submission for a future leaderboard. Keep it
benchmark-only: no user account data, no prompt contents, no local paths, no
machine username, no raw logs.

Allowed payload shape:

- anonymous client/session id generated locally
- calibr version, llama.cpp version/backend, OS/platform family
- coarse hardware facts needed to compare results: CPU model/class, RAM size,
  GPU name, VRAM/unified-memory size, backend/tooling availability
- model id/name/variant/source metadata
- benchmark config: context, KV cache, offload flags, runs, cleanup policy
- measured timings and hardware metrics

Avoid:

- local filesystem paths
- usernames, hostnames, IP-derived identity in stored payloads
- prompt text
- action trace contents
- doctor raw export unless the user explicitly attaches it to an issue

Minimal trust model:

- PHP endpoint generates or validates a submission secret / run token.
- Client starts a run with the token and submits step/config completion events.
- Cloudflare layer handles rate limiting, bot filtering, and coarse abuse
  protection before PHP.
- Treat this as a deterrent, not proof: motivated users can still falsify
  local benchmark results.

Open choices:

- batch upload at report end vs event upload after each config completes
- whether failed configs are uploaded by default
- leaderboard schema and deduplication rules
- public opt-in wording in CLI and README privacy section

Recently shipped and removed from the TODO queue:

- Engine modularization plus mirrored PowerShell tests.
- Report UI redesign.
- llama.cpp auto-fetch and guided setup prompt.
- Main-menu guided run with setup badges.
- Dead CLI paths hidden behind the old advanced-tools screen.
- Linux port, dependency checks, GPU-readiness doctor path, and diagnostic
  export.
- npm trusted-publishing release path.
- Doctor issue template.
- config-level llama.cpp build pin from typed `bNNNN` downloads.
- llama.cpp cache listing / cleanup from `configure llama path`.
- per-sample elapsed markers and compact RunView sizing.
- friendlier bench summary wording.
- results-screen re-run for a selected config.
- base GGUF header metadata parsing for architecture/context cap.

---

## Near-term polish

### Auto-fetch hardening

The happy path is shipped. Remaining useful hardening:

- checksum or size validation for downloaded llama.cpp archives
- Metal/macOS auto-fetch once macOS support is actually in scope

### Linux browser opener validation

There is a reported Linux bug around opening the HTML report from the CLI.
Validate on a Linux machine because the Windows workspace cannot reproduce the
`xdg-open` / desktop-session edge cases.

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

Catalog entries can mark `reasoning_mode`, and the bench path now sends
`enable_thinking=false` in the chat request when `reasoning_mode = off`.
Remaining work: verify the current llama.cpp behavior against Qwen reasoning
models and decide whether any server-startup flag is also needed.

This is especially important for Qwen reasoning models, where default thinking
can distort speed measurements.

### Gemma chat-template verification

Catalog/template notes are now propagated into plan/results/report. Remaining
work: verify which chat template llama.cpp chooses for Gemma 2 / 3 / 4 entries.
If defaults are wrong, add explicit catalog-driven template wiring.

### KV-fill benchmark mode

Add an opt-in mode that fills KV cache to known levels before timing
generation. This reveals attention-scaling cost at high context sizes, which
the current mostly-empty-cache benchmark hides.

### Multimodal throughput benchmark mode

Multimodal entries currently carry and use their paired `mmproj` when present,
but calibr does not yet run a dedicated comparison track for multimodal
overhead.

Needed:

- baseline load/inference timing with and without `--mmproj` for the same model
- image-processing speed tests across a few fixed input sizes
- audio-processing speed tests when the model exposes an audio path
- report these as throughput/latency numbers only, not quality or fidelity

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

Tracked in the 0.1.8 candidate section above.

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
- largest parameter count that fits without OOM/spill
- lowest memory footprint among acceptable winners
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
