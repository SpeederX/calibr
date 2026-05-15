# Memory snapshot 3 — post-v1.0.1 documentation sync

A primer for a reader (human or language model) joining the project
after the v1.0.1 release. Read this, then follow the pointers at the
bottom for full context.

> See `memories/memory-2.md` for the previous snapshot (post-v1.0.0,
> 2026-04-27). Older snapshots are historical, not authoritative —
> always verify the current state via `git log` and `git status`
> before acting.

## Snapshot meta

- **Date**: 2026-05-13
- **Project version on master**: v1.0.1
- **Project name**: `calibr`
- **Active branch**: `chore/v1.0.1-post-v1-sync` (about to merge to
  `dev`, then `master`)
- **Remote**: public at `github.com/SpeederX/calibr`

## What changed in v1.0.1

Documentation and methodology only. No engine behavior change, no
configuration-schema change, no test change. Bump is a patch. No
engine code changed. The project version is tracked via the git tag
(`v1.0.1`); `calibr.ps1` does not currently carry a version
constant, and introducing one was deferred — see the open item in
the `ROADMAP.md` v1.4.0+ section.

1. **Strict semantic versioning is restored.** The "while offline,
   minor bumps may break" allowance is removed from
   `architecture/README.md`. From this release onward, every
   breaking change to the command-line interface, the configuration
   schema, or the output format is a major bump.

2. **`ROADMAP.md` is now a priority-ordered backlog.** Open work is
   grouped by target version (v1.1.0 through v3.0.0, plus a
   cross-cutting section without a version pin). Within each section,
   top means next. Rationale for the shape lives in
   `architecture/design/roadmap-priorities.md`.

3. **Positioning is corrected.** `README.md` no longer claims that no
   tool of this kind exists. A competitor table introduces llmfit,
   llm-checker, llama-benchy, llama-bench, llama-sweep-bench,
   LocalMaxxing, and Bench360, each with its approach and the gap it
   leaves. Gap fields are stubs ("TBD — pending hands-on test") where
   the maintainer has not yet validated by trying the tool; filling
   those stubs is a follow-up task that is not on the roadmap.

4. **Architectural decisions are now on file.** `ROADMAP.md` has an
   Architectural notes section recording three decisions:

   - Two interfaces, one engine. Technical users on the command-line
     interface in this repository. Less technical users on a future
     graphical interface in a separate `calibr-ui` repository, built
     on top of the v2.0.0 programming interface.
   - A graphical interface or web dashboard lands at v2.0.0 or later,
     never before. The form of the programming interface (local C
     library, local C++ library, local web service, or another) is
     undecided and is part of the v2.0.0 planning work itself.
   - The accuracy task suite (planned for v1.4.0 or later) stays
     narrow at five to ten representative tasks. It is not a general
     evaluation framework.

## What is open after v1.0.1

The next planned work is **v1.1.0 — quick wins**:

- Download rotation. Download a model, benchmark it, delete it, move
  to the next; working-set storage drops from roughly one hundred
  gigabytes to roughly twenty.
- `localmaxxing-export` subcommand for the public leaderboard.
- N-run with median (variance reduction).

After that, `ROADMAP.md` is the authoritative ordering. The short
tour: v1.2.0 report-interface overhaul, v1.3.0 measured key-value-
cache degradation, v1.4.0 and beyond for wattage and efficiency and
the narrow task suite, v2.0.0 programming-interface layer (landmark),
v3.0.0 multi-graphics-card planning (landmark, long shot).

A separate follow-up task, not on the roadmap, will resolve the
"TBD — pending hands-on test" stubs in the `README.md` competitor
table once the maintainer has tried each tool.

## What is preserved as-is (do not touch)

- `plans/2026-04-2*-*.md` — historical plans.
- `plans/2026-04-27-v1-rename.md` — historical; describes v1.0.0.
- `memories/memory-1.md` — frozen pre-v0.3.2 snapshot.
- `memories/memory-2.md` — frozen post-v1.0.0 snapshot, with one
  dated note added clarifying that the relaxed-versioning allowance
  applied to v1.0.0 only.
- `spec/v1-taxonomy-rename.md`, `spec/v1-project-rename.md` —
  describe v1.0.0 and necessarily reference the old `family` and
  `llm-lab` tokens.

## Pointers (in reading order)

1. **`README.md`** — user-facing introduction, quickstart, competitor
   table.
2. **`architecture/README.md`** — methodology, folder map, work
   cycle, strict semantic versioning.
3. **`architecture/domain.md`** — vocabulary. Authoritative.
4. **`architecture/design/`** — why each non-trivial choice was made.
   `roadmap-priorities.md` is the most recent entry and explains the
   backlog shape.
5. **`architecture/ux/`** — what each user-facing flow looks like.
6. **`ROADMAP.md`** — priority-ordered backlog, Done section,
   Architectural notes.
7. **`spec/`** and **`plans/`** — current and historical.
8. **`calibr.ps1`** — the engine. Single file. Search by function
   name to locate logic.
9. **`tests/`** — `Helpers.Tests.ps1`, `Config.Tests.ps1`,
   `Report.Tests.ps1`. Run with `tests/run-tests.ps1`.

## Caveats for a reader resuming work

- **Verify before acting.** This snapshot is a moment in time. Run
  `git log --decorate --oneline -10` and `git status` first.
- **Vocabulary is stable.** Use `model`, `series`, `variant`, `tier`.
  Do not reintroduce `family` or `quant` in new files.
- **Strict semantic versioning is in effect.** A breaking change is
  a major bump, period. If a proposed change would break the
  command-line interface, the configuration schema, or the output
  format, it goes on the v2.0.0 section of the backlog (or a later
  major section), not into a minor.
- **Two repositories, eventually.** This repository
  (`SpeederX/calibr`) stays the engine and the command-line
  interface. The future graphical interface (`calibr-ui`) is a
  separate repository that does not exist yet and does not need to
  be scaffolded until v2.0.0 is close.
- **Tests are cheap.** The suite finishes in roughly thirty seconds.
  Run before any non-trivial commit.
- **Maintainer environment is Windows plus Vulkan llama-server.**
  Tests that depend on CUDA-only fields will not have data on this
  machine. Tests must handle the empty case.
