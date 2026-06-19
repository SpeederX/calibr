# Design: priority-ordered backlog as the roadmap shape

> **Archived.** Strict SemVer and the version-ordered backlog are suspended.
> Current direction and working rules live in
> [`../../AGENTS.md`](../../AGENTS.md).

## Why

The project is a single-maintainer effort with no service-level
agreement and no committed release dates. A roadmap that pretends to
schedule work in time misrepresents how the project actually moves:
items are picked off in priority order, and a release happens when
a coherent group of items is done.

The committed roadmap should match that reality. The unit of
progression is the version number, not the calendar.

A consequence: large directional shifts (a new interface boundary,
support for a new class of hardware) naturally cluster into major
bumps, because such shifts almost always break the existing
command-line interface, configuration schema, or output format. That
alignment is exploited, not forced. Strict semantic versioning keeps
its meaning; the major bump is not a marketing label.

## Pros

- Strict semantic versioning is preserved. A consumer of this
  project (script, packager, downstream tool) reading "v2.0.0
  released" knows exactly what to expect: something might break for
  them. They do not have to read release notes to find out whether
  the bump is a real break or a feature milestone.
- "What is next" is always the topmost open item in the
  highest-priority open version section. No separate "currently
  working on" pointer is needed.
- Reordering is cheap and local. Moving an item up or down in the
  backlog is a one-line edit; renumbering across versions is not
  required.
- Rationale for the ordering lives in one place (this document), not
  scattered across the roadmap, the readme, and the memory snapshots.

## Cons

- A delayed major-bump landmark stretches the minor-bump tail. If
  the programming-interface refactor planned for v2.0.0 slips, the
  v1.x series may accumulate more minor versions than feels
  comfortable. Acceptable cost: better than tagging a release as
  v2.0.0 when nothing has actually broken.
- The roadmap reader has to accept a convention: target version is
  the unit of grouping, and order within a section is priority. This
  is a one-time learning curve; the header at the top of `ROADMAP.md`
  explains it in two sentences.
- "Cross-cutting (no version pin)" items have no scheduled home.
  They land in whichever release the maintainer has the time and
  hardware for. Calling this out explicitly is more honest than
  pretending a date.

## Landmark placement

Two landmarks are visible on the backlog at the time of writing:

- **v2.0.0, programming-interface layer.** Closer in. Separates the
  engine from the command-line interface so other clients can use it.
  The exact form of the interface — a local C library, a local C++
  library, a local web service, or another — is undecided and is
  part of the v2.0.0 planning work itself. This landmark earns the
  major bump because it changes how output is produced and consumed:
  existing consumers of the result files and the report template
  will need updates.
- **v3.0.0, multi-graphics-card planning.** Further out. Adds
  planning across more than one graphics card using `--tensor-split`.
  Earns the major bump because the planner's per-card video-memory
  accounting changes shape and the paging-detection heuristic has
  to learn to attribute pages to the right card.

Other major bumps may emerge between these or beyond. They are not
preempted in this document. When a new landmark is identified, it
gets a section here before it gets a section in `ROADMAP.md`.

## Takeaway

The roadmap is a priority-ordered backlog grouped by target version.
Major bumps are reserved for genuine breaks; they happen to coincide
with landmark features because landmark features break things. The
ordering is auditable here, not in the roadmap itself.
