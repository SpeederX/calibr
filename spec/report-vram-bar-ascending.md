# Spec: VRAM bar chart sorted ascending

## Goal

Sort the *"VRAM peak (MiB) vs safety budget"* bar chart in `report.html`
by `vram_peak_mib` **ascending** (least VRAM at the top), so the visual
order matches the semantic intent (less VRAM = better).

## Background

`report.template.html` renders two bar charts via the shared `bars()`
function (line 120) which always sorts descending by the chosen field.
That is correct for the eval bar (more t/s = better, top is best) but
inverted for VRAM (less = better, currently puts the worst at top).

Item #1 in `ROADMAP.md`. Trivial change, high readability win.

## Behavior

`bars()` accepts an optional `direction` argument (`'asc' | 'desc'`,
default `'desc'`). The VRAM chart passes `'asc'`. The eval chart passes
nothing (still descending).

Visually:
- VRAM chart: row 1 = smallest `vram_peak_mib`. Last row = largest.
- Eval chart: row 1 = largest `eval_tps`. Last row = smallest. Unchanged.

## Acceptance

- [ ] In a freshly built `report.html`, the first bar in *"VRAM peak"* has
      the lowest `vram_peak_mib` of all `ok` configs.
- [ ] The last bar in *"VRAM peak"* has the highest `vram_peak_mib`.
- [ ] *"Eval tokens/s"* still goes from highest to lowest top-to-bottom.

## Out of scope

- Adding new sort directions or a clickable sort toggle.
- Changing the `vram-bars` rendering style or color logic.
- Sorting the *"All results"* table (separate concern).
