# UX flow: benchmark report

How a user reads `data/report.html` after a run, and the rationale behind the
2026-06 redesign. This is presentation only: it changes how measurements are
shown, never how they are measured, ranked, or what a metric means.

## Goal

Let a user answer three questions without wading through raw rows:

1. Which model/config wins on my hardware, and how does it compare to plain
   llama.cpp defaults?
2. How does a config hold up as context fills?
3. How do the winning models compare against each other?

## Reading order

```text
Memory vs latency scatter      cross-model overview (unchanged)
Models (winners per filter)    the main view — one collapsible row per model
  └─ expand a row:
       Configs · Radar · Load curve   single-row comparison panel
       ▸ diagnostics (collapsed)       tabbed per-config bars + audit table
Complete session leaderboard   collapsed — winner per model, head to head
WDDM paging watchlist          unchanged
All results                    collapsed — opt-in raw table
```

## Before → after

| Area | Before | After |
|---|---|---|
| Per-model drilldown | One 12-column table mixing real configs, the vanilla control, vanilla-adjacent probes, and prefill/KV-fill workload rows. The Gemma-E4B retest made this "complete no sense". | A single-row panel: a lean **Configs** card · a **vanilla-vs-config radar** · a **prefill/KV-fill load curve**. Probe and workload rows move into a collapsed **diagnostics** block. |
| Config list | Raw engine label (`ctx=131072_kv=q8_0`), Level + per-config VRAM columns. | Friendly rows: `Baseline default llama.cpp configuration` (control) vs `Calibrated`, with **Context size** and **Key/Value** as columns plus **Prompt t/s** and **Eval t/s**. Vanilla's KV is pinned to `f16` (llama.cpp's default). Level/VRAM dropped (level is in the header; raw numbers live in diagnostics). |
| Multi-metric comparison | Implicit, spread across table columns. | Radar over **eval · prompt · context · VRAM · power · temp · RAM**, every axis scaled against the vanilla control as the reference ring. |
| Throughput & memory | Global tabbed bar section (all configs, every model). | Removed as a global section. The per-config bars are **folded into each model's diagnostics** as a tabbed widget. |
| Cross-model comparison | Only the scatter + the winners list. | **Complete session leaderboard**: collapsed, one bar per model's winner, tabbed by metric. |
| All results | A ~21-column table, always visible, dominating the page. | Collapsed `<details>` ("N configs · M models · raw table"). Lean 7-column default with a **+ all columns** toggle for the full raw set. |
| VRAM/WDDM explanation | Info-tip on the Throughput section. | Moved onto the **Models** heading (shown once, near where the numbers are read). |

## Key choices and why

### Radar referenced to vanilla
The radar compares the selected config against the **vanilla control**, which is
the reference ring. Per axis: higher-is-better metrics use `config / vanilla`;
lower-is-better metrics (VRAM, power, temp, RAM) use `vanilla / config`, so a
better config always bulges **outward** uniformly. Ratios map on a symmetric
log2 scale clamped to ~0.5×–2× so a runaway gap (e.g. context 131072 vs a
vanilla effective 4096) cannot shoot off the chart; large gaps read as
"N× vanilla" in the hover tooltip. An axis is drawn only when both sides have a
usable value, so power/temp/RAM drop out when unmeasured. **Context** is an
axis because it is the knob that most distinguishes calibr from vanilla
(vanilla's auto-parallelism often reduces effective per-slot context).

### Load curve as retention
Prefill and KV-fill live on very different absolute scales (prefill ≈ prompt
t/s in the hundreds-to-thousands; KV-fill ≈ eval t/s in the tens). Plotting both
as **throughput retained vs each series' own best** puts them on one 0–100% axis
so the question "how fast does it fall off as context fills?" is legible.
Absolute values stay in the point tooltips and the caption. The curve is
per-model at the **anchor** config (where the engine generates the workload
sweep), not per arbitrary config — see Limitations.

### Separating diagnostics from candidates
Vanilla-adjacent probes (`ctx-only`, `+parallel=1`, `+parallel=1+KV`) and
prefill/KV-fill workload rows are diagnostics, not pickable winners. Mixing them
into the main table was the original noise. They now collapse into
**diagnostics**, which keeps them for audit (with their launch profiles) while
the pickable table stays short. This matches the engine contract: controls and
non-baseline workloads are excluded from winner selection.

### Leaderboard = winners only, scope-aware
A "complete results" bar chart of every config would be thousands of rows. The
leaderboard instead shows **one bar per model — its winner under the current
filter** — so models can be ranked head to head. It follows the page's data
scope: *latest session* shows the models from the most recent campaign; *all
sessions* ranks everything measured. It reuses the same metric tabs and the same
`metricBars` renderer as the per-model diagnostics.

### Collapse the raw table
With the per-model drilldown carrying the readable view, the 21-column table is
an **opt-in appendix** for scanning/exporting everything. Collapsed by default,
lean columns first, full set one toggle away.

## Limitations / open follow-ups

- **Per-config load curves.** The prefill/KV-fill curve is generated only at the
  anchor config, so the load-curve chart is per-model, not switchable per
  selected config. Per-config curves would need an engine/methodology change
  (running the workload sweep across more configs).
- **Leaderboard scope.** It follows the page scope toggle; there is no
  independent "all sessions" override inside the leaderboard yet.
- **Diagnostics bar density.** The per-model bars cover the model's real configs
  plus the vanilla control; a model with many context candidates is still a tall
  list inside the (collapsed) diagnostics.

## Invariants

- No metric is recomputed in the report; every value comes from result JSON.
- Controls (`vanilla`, `vanilla-adjacent`) and non-baseline workloads never
  appear as winners or launcher candidates.
- The self-contained `report.template.html` keeps all rendering client-side
  (inline SVG, no chart libraries); the bundled copy under `cli/engine/` is a
  build artifact regenerated by `scripts/bundle-engine.js`.
