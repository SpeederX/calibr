# Spec: VRAM-headroom indicator

## Goal

Per `ok` config, surface "how much VRAM is left, and roughly how many
extra tokens of context that buys" so the user can answer the natural
follow-up: *could I push ctx higher on this config?*

## Background

The bench measures `vram_peak_mib` and (on CUDA builds) the breakdown
including `kv_cache_mib`. From those plus the run's `ctx_size` we can
back out a per-token KV cost and project the spare VRAM into extra
context. Item #3 in `ROADMAP.md`. Echoes the user's follow-up after
the first full run: *how much VRAM is left and how much additional
context does that buy?*

## Behavior

A new compact column appended to the existing per-config rows in
*"VRAM peak vs safety budget"* (or rendered as a side-aligned annotation
to keep DOM simple). For each `ok` config:

```
headroom_mib = max(0, vram_total_mib - vram_peak_mib)
```

If `kv_cache_mib > 0` AND `ctx_size` is parseable from `extra_args`:

```
per_token_mib    = kv_cache_mib / ctx_size      (tokens count, not bytes)
extra_tokens_est = round(headroom_mib / per_token_mib)
```

Display:
- With KV data:   `+{headroom_mib} MiB  ≈ +{extra_tokens_est} tokens`
- Without:        `+{headroom_mib} MiB`
- `headroom_mib == 0` (saturated): `saturated`

Estimate is *approximate*: KV grows monotonically with ctx, but compute
buffers grow too. We say `≈ +N tokens` (note the squiggle) and stick a
help tooltip at the column header explaining that this assumes only KV
cache scales, ignores compute buffer scaling, and doesn't account for
quality at longer context.

## Acceptance

- [ ] Every `ok` row in the VRAM bar chart shows a headroom annotation.
- [ ] CUDA-build runs (where `kv_cache_mib` is captured) show the token
      estimate. Vulkan-build runs (where the regex didn't match) show
      only the MiB number.
- [ ] A run that hit the VRAM ceiling (`vram_peak_mib >= vram_total_mib`)
      shows `saturated`, not a negative number.

## Out of scope

- Pure-GPU vs WDDM-hybrid split rows in the indicator (defer to a
  follow-up spec; for now the existing WDDM watchlist surfaces hybrid
  configs separately).
- Modeling per-architecture KV bytes-per-token from first principles
  (the empirical-from-this-run formula is good enough for "≈ N tokens").
- Revising the winner picker to take headroom into account.
