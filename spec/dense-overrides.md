# Spec: `dense_overrides` to bypass MoE filename regex false positives

## Goal

Provide an explicit override list for families that match the MoE
filename heuristic but are actually dense, so they get a Tier A/C plan
sweep instead of a wasted `--n-cpu-moe` Tier B sweep.

## Background

`Get-ModelMetadata` flags a model as MoE when the family name matches
`A\d+B`, `MoE`, or `Mixtral`. The `A\d+B` regex matches **active params**
for real MoE models like `Qwen3.6-35B-A3B`, but it also matches innocent
names like `something-A100B-special.gguf` that happen to contain the
substring. Item from the v0.2.0 follow-up roadmap.

Without an override, those false-positive families get a `--n-cpu-moe`
sweep that does nothing useful (the flag is a no-op on dense models)
and the user wastes minutes per family.

## Behavior

Add `dense_overrides` to `config.default.json`, a top-level array of
**exact family names** (matched case-sensitively). Empty by default:

```json
"dense_overrides": [],
```

In `Invoke-Discover`, after `Get-ModelMetadata` returns, if the family
appears in `dense_overrides`, force `is_moe = $false` in the catalog
entry. This way the planner picks the right tier (A or C based on
size) and the report tier coloring stays accurate.

Override is a *post-hoc* filter on the regex; the regex stays as-is
(common case is real MoE).

## Acceptance

- [ ] A `.gguf` whose family matches `A\d+B` but is in `dense_overrides`
      lands in the catalog with `is_moe: false`.
- [ ] The same model gets a Tier A or Tier C plan sweep, not Tier B.
- [ ] An empty `dense_overrides` (default) leaves behavior unchanged
      from v0.2.0 (no regression on real MoE detection).
- [ ] `llm-lab config set dense_overrides "fam1,fam2"` sets the array
      via the existing CSV-on-set path.
- [ ] `Get-ModelMetadata` itself still records the regex match
      (`is_moe = true` for ambiguous names) — the override is applied
      by the caller, not inside the helper. This keeps the helper pure
      and testable in isolation.

## Out of scope

- A symmetric `moe_overrides` (forcing dense → MoE). No real-world need
  yet; if a MoE name slips past the regex, edit the family name or add
  a regex pattern. Future spec if it comes up.
- Wildcard matching in `dense_overrides`. Exact match keeps the
  semantics simple; users can list multiple variants explicitly.
