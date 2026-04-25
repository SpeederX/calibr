# Spec: 2D scatter — memory vs latency

## Goal

Add a scatter plot to `report.html` that maps each benchmarked config onto
two axes:

- **Y** = total GPU + spilled-RAM memory used (`vram_peak_mib + max(0, shared_peak_mib)`)
- **X** = total task time in seconds (`prompt_n / prompt_tps + eval_n / eval_tps`)

A horizontal reference line at `vram_total_mib` marks the GPU VRAM cap.
Dots above the line are configs that spilled to "Shared GPU memory" via
WDDM (i.e. paged into system RAM).

## Background

The current bar charts answer "which config is fastest?" and "which uses
least VRAM?" *separately*. They don't show the trade-off, and they hide
configs that look fast on paper but pay for it via WDDM paging. Item #2
in `ROADMAP.md`.

The `vram_peak_mib` field is bounded by the GPU's actual VRAM (it's a
read of `nvidia-smi memory.used`). When the driver pages, the overflow
shows up in `shared_peak_mib` (Windows perf counter delta). Their sum is
the closest approximation we have to "total memory the model is touching".

## Behavior

A new section *"Memory vs latency"* between *"Eval tokens/s"* and
*"VRAM peak vs safety budget"*. SVG (vanilla, no library), one `<svg>`
sized 100 % wide × 360 px tall.

### Axes

- X axis: linear, 0 → max(`time_total_sec`) of all `ok` configs, with a
  little headroom (+10 %). 5 ticks. Label: *"Total time (s)"*.
- Y axis: linear, 0 → max(Y across all configs, `vram_total_mib + 4096`)
  whichever is bigger. 5 ticks. Label: *"Memory (MiB)"*.

### Reference regions

- A subtle horizontal band at `vram_total_mib`, dashed line, label
  *"GPU VRAM ({vram_total_mib} MiB)"*. Above = system RAM region (greyer
  background tint). Below = GPU region.

### Dots

- One per `ok` config.
- Color by family (deterministic mapping; same family = same color across
  this chart and any others that adopt the scheme later).
- Radius: 5 px. Stroke: tier color (A green, B orange, C red).
- Title attribute (browser-native tooltip):
  `"<label> · vram peak {N} · shared +{M} · time {X} s · eval {Y} t/s"`.

### Configs that overflowed

If `vram_peak_mib + shared_peak_mib > Y_max_axis` (very large paging),
the dot clamps to the top edge with `pointer-events: none` on the
overflow indicator and a `↑` glyph next to it.

## Acceptance

- [ ] Every `ok` config in the dataset has exactly one dot.
- [ ] The horizontal "GPU VRAM" line is visible and labeled with the
      detected `vram_total_mib`.
- [ ] Hovering a dot shows the title-attribute tooltip with the config
      label and key numbers.
- [ ] A config with `shared_peak_mib > 1000` lands visibly above the line.
- [ ] A pure-GPU config (`shared_peak_mib == 0`) lands below or on the line.

## Out of scope

- Pan / zoom / brush selection.
- Tier filtering buttons (deferrable; reuse the existing tabs idea later).
- Axis log scaling.
- Per-family legend (the dots' tooltip names the family; defer a real
  legend until needed).
