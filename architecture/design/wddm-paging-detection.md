# WDDM paging detection on Windows

## Why

Windows does not raise OOM when llama.cpp tries to allocate more VRAM than
the GPU has. The driver silently pages weights out to "Shared GPU memory"
(a slice of system RAM mapped via PCIe). The model continues to run but
every token incurs PCIe round-trips — eval throughput collapses 2-4× without
any error message.

Without detection, calibr would happily declare a paging configuration as
the "winner" because its tokens-per-second number, while degraded, is still
positive. We need to spot the cliff.

## Approach

Two heuristics, both per-test:

1. `shared_peak_mib` — peak of the perf counter
   `\GPU Adapter Memory(*)\Shared Usage` *minus* a baseline taken before
   spawning llama-server. The baseline correction is essential — Chrome,
   Discord, and similar apps hold hundreds of MiB of shared memory at idle
   on most desktops. Treating absolute values as paging would false-flag
   every run.
2. `wddm_vram_saturation` — `vram_peak_mib / vram_total_mib`. Above 0.92
   (configurable) the run is marked suspicious even if shared-delta was
   zero, because paging may happen between polling samples.

A run is "confirmed paging" when `shared_peak_mib > 500 MiB` (configurable
via `wddm_detection.shared_delta_confirm_mib`). The winner picker prefers a
slower-but-safe configuration over a faster-but-paging one.

## Pros

- Catches the silent-failure mode that other tools (`llama-bench`, LM Studio,
  Ollama) miss entirely.
- Pure-Windows perf counters: no driver-internal API calls, no privileged
  access needed.
- Cheap (1 sample / 500 ms during the bench).

## Cons

- Windows-only. On Linux/macOS the `\GPU Adapter Memory(*)\Shared Usage`
  counter doesn't exist; needs an NVML-based replacement (roadmap).
- Polling-based: a transient spike between samples can be missed (mitigated
  by the saturation backstop).
- The 500 MiB threshold is empirical, not derived from first principles.

## Takeaway (empirical, RTX 2070 8 GB, Windows 11)

WDDM paging starts at ~95 % VRAM utilization on this card with the standard
NVIDIA driver. Concrete data points from a Qwen3.5-9B Q4_K_M sweep:

| Config              | vram_peak | shared_delta | eval_tps |
|---------------------|-----------|--------------|----------|
| ctx=64K, KV q8_0    | 7698 MiB  | +1215 MiB    | 44.2     |
| ctx=98K, KV q8_0    | 7687 MiB  | +883 MiB     | (timeout) |
| ctx=131K, KV q4_0   | 7698 MiB  | +1407 MiB    | 44.2     |

The ctx=98K case timed out under WDDM pressure even though the on-paper
VRAM allocation was the same as ctx=64K — the driver started paging and
the request never completed within `wait_sec_ready`. The shared-memory
counter caught it. The winner picker preferred safe configs over
quietly-paging ones; a `-PreferSpeed` flag (roadmap) would let users
override that preference if they accept the risk.
