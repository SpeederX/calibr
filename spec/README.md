# Specs

One small, atomic feature or decision per file, named after the behavior
(`config-cli.md`, `vram-headroom-indicator.md`). A spec answers **what**:

1. **Goal** — one sentence.
2. **Background** — why this matters (link out to design or roadmap).
3. **Behavior** — what the user sees / what the API does.
4. **Acceptance criteria** — testable, verifiable.
5. **Out of scope** — explicit non-goals.

A spec is implementable on its own. Larger work that spans multiple specs
gets a plan in `../plans/`. See `../architecture/README.md`.

## Index

- [config-cli.md](config-cli.md) — `llm-lab config <list|get|set|unset|detect>`
- [report-vram-bar-ascending.md](report-vram-bar-ascending.md) — VRAM bar chart sort order
- [report-2d-scatter.md](report-2d-scatter.md) — 2D scatter plot, memory vs latency
- [report-vram-headroom.md](report-vram-headroom.md) — per-config VRAM headroom indicator
- [scatter-log-scale.md](scatter-log-scale.md) — log-10 X axis for the latency-vs-memory scatter
- [winner-picker-prefer-speed.md](winner-picker-prefer-speed.md) — `-PreferSpeed` flag, opt-out of safety preference
- [dense-overrides.md](dense-overrides.md) — explicit list to override MoE filename false positives
- [v1-taxonomy-rename.md](v1-taxonomy-rename.md) — `family` → `model`, add `series`
- [v1-project-rename.md](v1-project-rename.md) — `llm-lab` → `calibr`
- [v1.0.1-docs-and-roadmap-sync.md](v1.0.1-docs-and-roadmap-sync.md) — README positioning, competitor table, priority-ordered ROADMAP rewrite
- [v1.0.1-strict-semver.md](v1.0.1-strict-semver.md) — remove pre-public-flexibility allowance, restore strict SemVer
- [download-rotation.md](download-rotation.md) — `-Rotate` flag: delete each downloaded model after bench, working set drops from ~100 GB to ~20 GB
- [localmaxxing-export.md](localmaxxing-export.md) — `localmaxxing-export` subcommand, bearer-auth submission to the public leaderboard
- [n-run-median.md](n-run-median.md) — N-run median per config (default 3) for variance reduction on the noisy metrics
