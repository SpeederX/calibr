# Spec: rename `family` → `model`, add `series`

## Goal

Align the codebase with `architecture/domain.md`'s vocabulary: what is
currently called `family` is the **model** level (`Qwen3.5-9B`,
`Gemma-4-E2B`), not the family level. Rename throughout, and add a
parsed `series` field for the broader cluster (`Qwen3.5`, `Gemma-4`).

## Background

`Get-ModelMetadata` returns a `family` field that holds e.g.
`"Qwen3.5-9B"` — but per the project glossary that is a **model**, not
a family/lineage. The misnomer pollutes catalog.json, plan.json,
data/results/*.json, samples.json, the CLI flag `-Family`, the help
dict, the report template, the spec/plan/design documents, and the
test suite.

Fixing it now is an API break, but the project is still pre-public
(no GitHub remote, no external users). v1.0.0 is the right moment.

## Behavior

### New JSON shape

Each catalog/plan/result entry gains:

- `model` — what was previously `family` (e.g. `Qwen3.5-9B`).
- `series` — parsed from `model`: everything before the size token,
  with the size+suffix stripped. Examples:
  - `Qwen3.5-9B` → series `Qwen3.5`
  - `Qwen3.5-0.8B` → series `Qwen3.5`
  - `Gemma-4-E2B-it` → series `Gemma-4`
  - `Qwen3.6-35B-A3B` → series `Qwen3.6` (the `A3B` active-params
    annotation is part of the model identity, not the series)

The old `family` field is **removed** from the output. No alias.

Parsing rule for `series`: strip the trailing
`-?\d+(\.\d+)?[BM](-A\d+B)?(-it|-Instruct)?$` token group from `model`.
If nothing matches, `series` falls back to `model` itself.

### CLI flag rename

- `-Family <regex>` → `-Model <regex>` on `discover`, `plan`, `bench`,
  `report`, `all`, `get-sample-models`, `config detect`. Same regex
  semantics, just the parameter name.
- Help dict updates accordingly.

### samples.json schema

Each sample entry gains `model` (replacing `family`) and `series`
(parsed). Example:

```json
{
  "id": "qwen3.5-9b-q4km",
  "model": "Qwen3.5-9B",
  "series": "Qwen3.5",
  "variant": "Q4_K_M",
  ...
}
```

### Migration of existing data

A one-shot migration script (`tests/migrate-v1.ps1` or run inline at
`Invoke-Report` start with a deprecation note) rewrites every
`data/results/*.json` to add `model` + `series` and drop `family`.
Idempotent: running it twice is safe.

The migration runs automatically on first execution of
`calibr.ps1 report` if any cached result still uses `family` — the
user gets a one-line "migrating N files" notice and the operation
completes in well under a second.

## Acceptance

- [ ] No `family` token survives in `llm-lab.ps1` (or its successor),
      tests, specs, plans, design docs, samples.json, or
      `report.template.html`. Grep returns zero matches outside of the
      historical plans (`plans/2026-04-25-*.md`, kept for archeology).
- [ ] Every existing v0.3.2 test still passes after the rename.
- [ ] `bench -Model Qwen3.5-9B` works exactly like the old
      `bench -Family Qwen3.5-9B`.
- [ ] `data/results/*.json` from a pre-v1 run get migrated on first
      `report` invocation; the migration is idempotent.
- [ ] `architecture/domain.md` no longer needs the "Pending rename"
      callout (the rename has happened).

## Out of scope

- Backwards-compatible `-Family` alias. Cleaner break, no external
  users to protect.
- Renaming the actual `.gguf` files on disk. The model identity is
  parsed from the filename; we do not rewrite filenames.
- Changing how `series` is computed. Simple regex, documented above;
  edge cases (Phi-3, DeepSeek, etc.) handled when the project sees
  them.
