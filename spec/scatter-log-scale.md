# Spec: scatter chart log-10 X axis

## Goal

Switch the *Memory vs latency* scatter chart's X axis from linear to
**log-10**, so configs that span orders of magnitude in `time_total_sec`
(Tier A sub-second vs Tier C ~100 s) are all readable at a glance.

## Background

In v0.2.0 the X axis is linear. The slowest config dominates the scale,
compressing fast configs into a narrow band near the origin. Item from
the v0.2.0 follow-up roadmap. The user explicitly chose
*single-axis log-10*, no tier-split.

## Behavior

- X domain: `[xMin, xMaxRaw * 1.5]` where:
  - `xMin = max(0.05, min(time_total_sec) * 0.5)` — guarantees a
    positive lower bound (log of zero is undefined) and pads on the left
    so the smallest dot isn't on the axis.
  - `xMaxRaw = max(time_total_sec)` — pad upper bound so the largest
    dot isn't clipped.
- Position function: `xs(v) = M.l + (log10(max(v, xMin)) - log10(xMin)) / (log10(xMaxUpper) - log10(xMin)) * innerW`
- Tick marks: 5 evenly spaced **in log space**. Render the linear value at
  each tick (`Math.pow(10, lv)`) with `.toFixed(1)` for `< 10`, integer
  for `>= 10`.
- Axis label unchanged: *"Total time (s)"*.

## Acceptance

- [ ] In the regenerated `data/report.html`, the X axis tick labels
      span more than one order of magnitude (e.g. `0.5  1.4  3.7  10  27`)
      rather than the linear `0  20  40  60  80  107`.
- [ ] A Tier A sub-second config (e.g. Qwen3.5-0.8B at ~0.5 s) lands
      visibly **right** of the leftmost edge, not pinned at x = 0.
- [ ] A Tier C 100 s config still lands near the right edge.
- [ ] No JS console errors; SVG renders identically when there is only
      one ok config (degenerate `min == max` handled by the xMin floor).

## Out of scope

- Y axis stays linear (memory in MiB; orders of magnitude are similar).
- Tick labeling at "natural" log positions (1, 2, 5, 10, 20, 50, ...).
  5 evenly-spaced log ticks is fine for v0.3.
- Tier-filter buttons.
