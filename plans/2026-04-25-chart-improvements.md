# Plan: report chart improvements

## Context

ROADMAP items #1, #2, #3 — all touch `report.template.html` + the
`Invoke-Report` pre-processing step. Bundling them into one branch avoids
re-rendering the same file three times and keeps test/CI churn low.

Implements:
- [spec/report-vram-bar-ascending.md](../spec/report-vram-bar-ascending.md)
- [spec/report-2d-scatter.md](../spec/report-2d-scatter.md)
- [spec/report-vram-headroom.md](../spec/report-vram-headroom.md)

## Approach

### 1. Pre-compute derived fields server-side (PowerShell)

In `Invoke-Report`, when building the per-result object that lands in
`%%DATA%%`, add three fields:

| Field             | Formula                                                              |
|-------------------|----------------------------------------------------------------------|
| `time_total_sec`  | `prompt_n / prompt_tps + eval_n / eval_tps` (or `null` if either is 0) |
| `headroom_mib`    | `max(0, vram_total_mib - vram_peak_mib)`                             |
| `ctx_size`        | parsed from `extra_args` via regex `--ctx-size\s+(\d+)`              |

Doing it in PS keeps the JS template focused on rendering and means tests
can assert against the JSON shape without parsing extra_args in JS.

`vram_total_mib` is available via `$cfg.hardware.vram_total_mib` in
`Invoke-Report`'s scope.

### 2. Refactor `bars()` to accept sort direction

Current signature: `bars(id, field, maxv, unit)`. New: `bars(id, field, maxv, unit, dir)` where `dir` is `'asc'` or `'desc'` (default `'desc'`).
Comparator: `dir === 'asc' ? a[field] - b[field] : b[field] - a[field]`.

Call site change: `bars('vram-bars', 'vram_peak_mib', cap, 'MiB', 'asc')`.

### 3. VRAM bar headroom annotation

In the existing `bars()` rendering, when the field is `vram_peak_mib`,
extend the row with a third column showing the headroom string. To keep
`bars()` reusable, accept an optional `annotate(d)` callback parameter
that returns the annotation HTML; the eval bars pass nothing and stay
unchanged.

Annotation logic (matches the spec):

```js
function vramHeadroom(d) {
  if (d.vram_peak_mib >= cap) return '<span class="meta">saturated</span>';
  const left = d.headroom_mib;
  if (d.kv_cache_mib && d.ctx_size && d.kv_cache_mib > 0) {
    const tokens = Math.round(left / (d.kv_cache_mib / d.ctx_size));
    return '+' + left + ' MiB <span class="meta">≈ +' + tokens + ' tok</span>';
  }
  return '+' + left + ' MiB';
}
```

CSS: extend `.bar-row` grid to `260px 1fr 90px 130px` (headroom column ~130 px).

### 4. New scatter chart

Inserted **between** the eval bars and the VRAM bars sections. Vanilla
SVG, no library:

- `<svg id="scatter" width="100%" height="380" preserveAspectRatio="none" viewBox="0 0 1000 380">`
- Compute `xMax = ceil(max(time_total_sec) * 1.1)` and
  `yMax = max(max(vram + max(0, shared)), vram_total_mib + 4096)`.
- Render axis ticks (5 each), axis labels, the GPU-VRAM dashed line at
  `y(vram_total_mib)` with text label.
- Render dots: `<circle cx=x(time) cy=y(vram+shared) r=5 fill=familyColor stroke=tierColor>` plus a `<title>` child for native tooltip.
- Family color: deterministic hash from family name → HSL with fixed
  saturation/lightness. ~10 lines of JS, no shared state needed.
- Empty state: if 0 ok configs, render `<text>` "No ok runs to plot."

### 5. CSS additions

```css
.scatter-bg-ram   { fill: rgba(255,255,255,0.02); }
.scatter-line-gpu { stroke: var(--c-c); stroke-dasharray: 4 4; opacity: 0.6; }
.scatter-axis     { stroke: var(--c-border); }
.scatter-tick     { fill: var(--c-muted); font-size: 10px; font-family: Consolas, monospace; }
.scatter-dot      { stroke-width: 2; cursor: default; }
```

## Files touched

| File                                     | Change |
|------------------------------------------|--------|
| `llm-lab.ps1` `Invoke-Report`            | Add `time_total_sec`, `headroom_mib`, `ctx_size` to the JSON written into `%%DATA%%`. |
| `report.template.html`                   | New `<h2>` + `<svg>` between eval bars and vram bars. CSS additions. `bars()` accepts `dir` and `annotate`. New `vramHeadroom()` and `familyColor()` helpers. |
| `tests/Report.Tests.ps1` (new)           | Unit-style: drive `Invoke-Report` against a minimal canned dataset, assert on the produced JSON shape (`time_total_sec` present, headroom logic correct for the saturated case). HTML structure smoke-test (regex on output for `id="scatter"`, `class="scatter-line-gpu"`, headroom column). |
| `ROADMAP.md`                             | Mark items #1, #2, #3 as `[x] done`. |

## Verification

1. `tests/run-tests.ps1` — all existing tests pass (regression).
2. New `Report.Tests.ps1` — unit + smoke for the new fields + HTML.
3. Manual: run `llm-lab all` (or just `report` on existing results) and
   open `data/report.html`:
   - VRAM bar chart's first row is the smallest VRAM peak.
   - Scatter chart shows dots; the GPU VRAM line is visible.
   - Hovering a dot shows the tooltip.
   - At least one config (any of the WDDM-flagged ones from the prior
     full run) lands above the GPU VRAM line.
   - Each VRAM bar row has a `+N MiB ≈ +M tokens` annotation when CUDA
     fields are present, else `+N MiB`.
4. `[Parser]::ParseFile $llm-lab.ps1` clean (no syntax regressions).

## Risk / trade-offs

- **Family color hashing**: a deterministic but uncoordinated hash means
  Qwen3.5-9B and Gemma-4-E2B might end up with similar hues by chance.
  Acceptable for v0.2 since the title tooltips disambiguate; if it
  bothers users we can switch to a curated palette.
- **`ctx_size` parsing fragility**: regex on `extra_args`. If a future
  flag uses `-c` instead of `--ctx-size`, we miss it. Not currently the
  case; documented in the helper's comment.
- **Tooltip via `title=""`**: native browser tooltip is delayed (~1 s)
  and ugly. Acceptable for now; a custom hover panel is a v0.3 polish.
- **No D3/Plotly**: keeps `report.template.html` self-contained and
  diff-friendly. ~120 extra lines of JS total, all readable.

## Branch + release

- Branch: `feat/chart-improvements` off `dev`.
- Commits roughly: (1) docs (specs + this plan), (2) data fields in PS
  + test, (3) VRAM bar sort, (4) headroom annotation, (5) scatter chart,
  (6) ROADMAP update + final test pass.
- PR `feat/chart-improvements` → `dev`. CI green.
- When ready to release, `dev` → `master` with tag `v0.2.0` (MINOR — new
  features, backwards-compatible).
