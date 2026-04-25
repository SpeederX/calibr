# Architecture and working methodology

How the project is organized and how changes flow from idea to release.

## Branching: GitFlow lite

Two long-lived branches:

- `master` — released, tagged, stable. Every commit on master is reachable
  from a release tag.
- `dev` — integration branch. New work lands here first.

Short-lived branches off `dev`:

- `feat/<short-slug>` — new feature or behavior change.
- `chore/<short-slug>` — refactor, doc-only, infra, no behavior change.

Both merge back to `dev` via PR after CI passes.

Short-lived branches off `master`:

- `hotfix/<short-slug>` — urgent fix for a released version. Merges to
  `master` (with a new patch tag) AND back into `dev` to keep them aligned.

```
   master  ──●─────●─────●──────●────────●─────●──    tags v0.1.0, v0.1.1, v0.2.0, ...
              \           \             /     /
   hotfix      ─●─       hotfix         ─●──●
                          \                /
   dev    ──●─●─●─●─●───●─●─●─●───────●─●─●─●──
              \   \     /         \         /
   feat        ●   ●───●           ●───────●
```

## Versioning: semantic, prefixed `v`

`vMAJOR.MINOR.PATCH`.

| Bump  | Trigger                                   | Examples |
|-------|-------------------------------------------|----------|
| MAJOR | Breaking change to CLI, config schema, or output format | rename a subcommand, remove a flag, change `samples.json` schema |
| MINOR | New feature, backwards compatible         | new subcommand, new flag, new report column |
| PATCH | Fix only, no new behavior                 | crash fix, regex correction, doc-only typo fix |

Features accumulate on `dev` and ship as a MINOR when we cut a release.
Hotfixes go straight to `master` and ship as a PATCH on top of the latest tag.

## Folders

```
llm-lab/
├── architecture/           methodology + design rationale
│   ├── README.md           this file
│   ├── design/             why-we-chose-X notes (one .md per decision)
│   └── ux/                 user-facing flows (one .md per use case)
├── plans/                  implementation plans for non-trivial work
├── spec/                   smaller specs that one or more plans implement
├── tests/                  Pester unit + integration tests
├── docs/                   README assets (screenshots, etc.)
├── data/                   runtime artifacts (gitignored)
├── .github/workflows/      CI configs (placeholder; see ROADMAP.md)
├── llm-lab.ps1             the engine
├── llm-lab.cmd             cmd.exe / PS wrapper for global invocation
├── config.default.json     schema + defaults (committed)
├── config.json             personal overrides (gitignored)
├── samples.json            curated reference GGUFs
├── report.template.html    HTML skeleton for the dashboard
├── README.md               user-facing intro
├── ROADMAP.md              open points + done list (single screen)
├── LICENSE                 MIT
└── .gitignore
```

## Typical work cycle

1. Open or write a small **spec** in `spec/` describing the desired behavior.
2. Open or update a **plan** in `plans/` describing how to implement it.
3. Branch off `dev` (or `master` for hotfix), implement, add or update tests.
4. Open PR. CI runs tests. After approval, squash-merge into `dev`.
5. When ready to release, merge `dev` → `master` and tag `vX.Y.Z`. The tag
   triggers any release automation (TBD; see ROADMAP).

## Spec vs plan

- **Spec** is small, one feature or one decision. *What* should happen, with
  acceptance criteria. May fit under a single user-visible behavior
  (e.g. "config detect <key> behavior").
- **Plan** is bigger, often spans multiple specs or covers a coordinated set
  of changes. *How* we'll get there: file paths, ordering, verification
  steps, trade-offs considered.

A plan typically references one or more specs. A spec is implementable on
its own; a plan is an execution recipe.

## Decision rationale

Design choices live under `architecture/design/`. Each is a short doc with
**Why**, **Pros**, **Cons**, and a **Takeaway** that's empirical when
possible (measured numbers, not just speculation). When we make a non-trivial
choice (e.g. "use User PATH instead of a PowerShell module"), it gets a
file there before the change merges.

UX flows live under `architecture/ux/`. Each is the functional walk-through
of one use case (first-time install, bench cycle, config management, etc.)
written from the user's perspective: "the user types X, sees Y, then…".
