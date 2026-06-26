# Design notes

These files explain decisions, but they are not the project workflow. Current
operating rules live in [`../../AGENTS.md`](../../AGENTS.md).

## Current references

- `override-only-config.md` — default-plus-local configuration model.
- `adaptive-speed-sweep.md` — measured peak detection and optional full-curve
  execution.
- `memory-cliff-policy.md` — shared-memory states, context-boundary estimation,
  and correlated degradation.
- `runtime-failure-policy.md` — structured failure causes, retries, and safe
  pruning boundaries.
- `same-context-kv-rescue.md` — conditional low-quality KV fallback without
  changing the requested context target.
- `vram-safety-budget.md` — planning headroom heuristic.
- `wddm-paging-detection.md` — Windows shared-memory spill detection.

## Archived decisions

- `install-via-user-path.md` — superseded by the installable Node CLI.
- `roadmap-priorities.md` — superseded by the phase and pace rules in
  `AGENTS.md`.

Archived files remain useful history; they must not drive new implementation.
