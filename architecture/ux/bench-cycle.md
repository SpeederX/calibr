# UX flow: guided benchmark

## Goal

Turn a model selection into comparable measurements, winners, launchers, and a
report without asking the user to manage engine stages.

## User journey

1. Run `calibr`.
2. Choose local models or a curated catalog scope.
3. Review the generated policy and start the run.
4. Follow model/config progress and live telemetry.
5. Inspect results in the CLI or open the generated HTML report.

The CLI makes one raw `all` adapter call. PowerShell internally performs setup,
discovery, planning, benchmarking, retention, and report emission. Catalog
models are downloaded and benchmarked one at a time so retention can bound disk
usage.

## Resume and artifacts

Internal stages retain separate JSON artifacts because they support caching,
resume, diagnostics, and focused tests. They are not separate UX steps.

Advanced maintainers may still invoke raw stage commands directly, but normal
product behavior must be designed around guided run.

## Success

- Every attempted config has an explicit result or failure reason.
- Cached successful work is reusable.
- The CLI and report agree on metrics and winners.
- Generated launchers reproduce the selected configuration.
