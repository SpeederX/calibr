# VRAM safety budget and overhead estimate

## Why

Tier classification needs a heuristic for "will this model fit fully on the
GPU?". A naive check (`weights_size < vram_total`) overshoots — there's
~1 GiB of compute buffers, KV cache, scheduler metadata, and driver headroom
on top of weights. Without a budget, every borderline model would be
classified Tier A and then page hard at runtime (see
`wddm-paging-detection.md`).

## Approach

```
vram_safety_budget_mib = vram_total_mib × vram_safety_budget_pct
needed_for_tier_A      = model_size + mmproj_size + overhead_mib
tier = if needed_for_tier_A < vram_safety_budget_mib then A else C
```

Defaults:
- `vram_safety_budget_pct = 0.95`
- `overhead_mib = 1200`

Both are in `config.default.json` and overridable. MoE models bypass this
check entirely and go straight to Tier B with a `--n-cpu-moe` sweep.

## Pros

- One tunable per machine. Users with 24 GB cards can push to 0.97; desktops
  with heavy GPU compositors can drop to 0.90.
- Decouples "fits?" from "what context can it handle?" — two separate
  questions, separately tuned.
- Catches the "almost-fits-but-pages" case that the WDDM detection then
  confirms at runtime; the two work together.

## Cons

- Constants are calibrated on RTX 2070 + Qwen 3.5 series. Other architectures
  (Mamba, Phi) might draw less or more overhead.
- `overhead_mib` is one number. A per-architecture override could shave a
  few percent off the budget for known-lean families.

## Takeaway (empirical, RTX 2070, Qwen3.5)

Overhead components on this card:

| Component               | Typical |
|-------------------------|---------|
| Compute buffer (CUDA0)  | 400-600 MiB |
| KV cache (q8_0, 16K)    | ~50 MiB |
| Recurrent / SSM state   | 50-200 MiB |
| Graph / scheduler       | ~100 MiB |
| Driver / WDDM headroom  | ~300 MiB |
| **Total**               | **~1.0-1.2 GiB** |

The 95 % safety threshold came from observing that `vram_peak ≥ 7800 MiB`
(out of 8192) on this card consistently triggered paging. 7782 MiB =
0.95 × 8192. Above that, even successful runs had elevated `shared_peak_mib`,
indicating the driver had started spilling. Below that, runs were typically
clean.
