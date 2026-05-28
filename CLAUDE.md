\# calibr — operating principles (current phase)



This file is the source of truth for how to work in this repository

right now. It supersedes everything under `architecture/`, `spec/`,

`plans/`, `memories/`, and the priority-ordered backlog in

`ROADMAP.md`. Those files stay on disk as historical reference and

because their implicit knowledge is real, but they do not define the

methodology for new work.



The project is in an early-iteration product phase. The improvement

target is the user experience of the existing command-line tool: a

PowerShell script with flags becomes an installable interactive

console-and-dashboard command. The previous methodology (strict

semantic versioning, spec-and-plan-for-everything, design docs with

Why/Pros/Cons, memory snapshots, priority-ordered backlog) was sized

for a different phase. It is mostly suspended.



\## Three operating principles



\### 1. Process is minimal



\- No strict semantic versioning. Breaking changes are fine; record

&#x20; them in the commit message.

\- No migration shims for hypothetical users. The maintainer is the

&#x20; user. If the maintainer wants their own data preserved, the

&#x20; maintainer says so.

\- No acceptance-criteria checklists for hypothetical users. Write

&#x20; acceptance only when the criterion catches a bug the maintainer

&#x20; would otherwise miss.

\- No new memory snapshots until the project stabilizes again.

\- No new design docs in `architecture/design/` with Why / Pros /

&#x20; Cons / Takeaway unless the maintainer explicitly asks. A paragraph

&#x20; in the commit message is the default.

\- Specs and plans are optional. For non-trivial work, a short plan

&#x20; in chat or in a scratch file is fine; do not create entries under

&#x20; `spec/` and `plans/` by default.



\### 2. Pace is the priority



\- Ship the smallest version that does the thing. Iterate from there.

\- Do not pre-discuss minor decisions. Make a reasonable call,

&#x20; commit, note the call in the commit message; revisit only if it

&#x20; turns out wrong.

\- Force-shrink conversations. If a feature is small, the

&#x20; conversation about it should be smaller.

\- Surface design tensions only when they have lasting consequences

&#x20; (data model, public interface shape, framework or language choice).

&#x20; Implementation details are not design tensions.



\### 3. Architecture pivots incrementally



The product evolves in three phases. Each builds on the previous;

each is shipped before the next is started.



\- \*\*Phase 1 (now). Interactive command-line tool.\*\* A Node.js plus

&#x20; Ink application, written in TypeScript, installable globally as

&#x20; the `calibr` command (`npm i -g calibr`). It wraps the existing

&#x20; `calibr.ps1` engine through a single adapter that shells out and

&#x20; parses the engine's existing JSON output. The user experience is

&#x20; a console-and-dashboard style: pickable lists, live progress

&#x20; during bench runs, navigable result views. Reference for the

&#x20; feel: llmfit. Ink covers the interactive components; add a

&#x20; dashboard library (such as `blessed-contrib`) only when Ink alone

&#x20; cannot express what a screen needs.

\- \*\*Phase 2 (later, only when phase 1 is shipped and stable).\*\*

&#x20; A NestJS HTTP application that exposes the engine operations the

&#x20; CLI already invokes. The CLI becomes one of several clients of

&#x20; this application; other clients become possible.

\- \*\*Phase 3 (later still, only if there is a reason).\*\* An Angular

&#x20; web application on top of the phase-2 API. This is the endgame

&#x20; UI but it is not started until the API exists and the CLI

&#x20; surfaces a real need for it.



PowerShell logic migrates into the new layers piece by piece, only

when a concrete reason appears (the CLI needs something the engine

cannot give over its current interface; the subprocess boundary

becomes a bottleneck; a Linux user needs a feature). Never as a

wholesale rewrite.



\## Project shape (current target)



```

calibr/

├── CLAUDE.md                this file

├── cli/                     Node + Ink + TypeScript; installable as

│                            the `calibr` global command; wraps

│                            calibr.ps1 via subprocess through an

│                            EngineAdapter

├── calibr.ps1               existing engine, called by the CLI

├── tests/                   existing PowerShell test harness

├── architecture/            REFERENCE ONLY for new work; domain.md

│                            still authoritative for vocabulary

├── spec/, plans/, memories/ REFERENCE ONLY; not the workflow

└── ROADMAP.md               REFERENCE ONLY; superseded by this file

```



Phase-2 and phase-3 add `backend/` (NestJS) and `ui/` (Angular)

respectively. Do not scaffold them ahead of time.



\## What still applies from the previous phase



\- \*\*`architecture/domain.md`\*\* is still authoritative for

&#x20; vocabulary. Use `model`, `series`, `variant`, `tier`, `WDDM`,

&#x20; `headroom`, `saturation`, `winner`, `backend`. Do not reintroduce

&#x20; `family` or `quant`.

\- \*\*`README.md`\*\* is public-facing and stays current. Update it

&#x20; when user-facing behavior changes.

\- \*\*`calibr.ps1` and its tests\*\* are running, working code. Do not

&#x20; break them without a reason. The CLI wraps the engine; it does

&#x20; not replace it.



\## What does NOT apply from the previous phase



\- The strict semantic versioning rules in `architecture/README.md`.

\- The priority-ordered backlog in `ROADMAP.md` (v1.1.0 quick wins,

&#x20; v1.2.0 report-interface overhaul, v1.3.0 key-value-cache

&#x20; degradation, v2.0.0 programming-interface landmark, v3.0.0

&#x20; multi-graphics-card landmark). Replaced by: ship the CLI, then

&#x20; the API, then the web UI.

\- The spec-versus-plan distinction. Write what is useful, where

&#x20; it is useful.

\- The "design doc with Why / Pros / Cons / Takeaway for every

&#x20; non-trivial choice" rule.

\- The `memories/` snapshot cadence.



\## In-flight branches



Existing feature branches (`feat/v1.1-quick-wins`,

`feat/v1.2-ux-overhaul`) carry good ideas: download rotation,

median-of-N, leaderboard export, scatter improvements, sortable

results table. They are not abandoned, but they do not get

continued as PowerShell-engine commits. Those ideas resurface as

features of the new CLI or its eventual API, in whatever order

makes sense for the product.



\## When to check in with the maintainer



Check in for:



\- Strategic decisions (a new top-level dependency, a schema break

&#x20; that affects the report shape, a change of language or framework,

&#x20; a new engine adapter, a phase transition).

\- Anything that takes more than half a day of implementation.

\- Anything where the choice between two reasonable approaches has

&#x20; lasting consequences.



Do NOT check in for:



\- Routine implementation questions.

\- Consistency between files; use scripts for that, not the

&#x20; maintainer's attention.

\- Migration concerns for users who do not exist.

\- Whether to add a test; yes, add it if it is cheap and the bug it

&#x20; catches is real.

\- Whether the methodology in `architecture/` applies; it does not,

&#x20; per this file.



\## Vocabulary specific to the new phase



\- \*\*Engine\*\* — a process that runs the actual inference. Default

&#x20; today: llama.cpp via `calibr.ps1`. Future: a direct llama.cpp

&#x20; client, a C-based loader, other inference engines.

\- \*\*EngineAdapter\*\* — an abstraction in the CLI (and later in the

&#x20; API) that hides which engine is running. One implementation today

&#x20; (`PowerShellEngineAdapter`) that shells out to `calibr.ps1`.

\- \*\*CLI\*\* — the Node + Ink application in `cli/`. The primary

&#x20; product surface in the current phase. Installable as the `calibr`

&#x20; global command.

\- \*\*Backend (future)\*\* — the NestJS application that will appear in

&#x20; `backend/` when phase 2 starts.

\- \*\*UI (future)\*\* — the Angular application that will appear in

&#x20; `ui/` when phase 3 starts.

