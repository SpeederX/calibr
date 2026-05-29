# calibr

Interactive console for **[calibr](https://github.com/SpeederX/calibr)** — a
benchmark crawler that measures what your local `llama.cpp` builds actually
do on your hardware (eval speed, prompt speed, real VRAM, and the silent
shared-memory paging that turns a `47 t/s` config into `10 t/s` with no
error message).

The CLI wraps the existing PowerShell engine and gives you a navigable
console UI for running discovery → plan → bench → report and for browsing
the resulting leaderboard.

## Install

```bash
npm install -g calibr
```

Then run:

```bash
calibr
```

You get an interactive menu. No flags, no PowerShell prompt to copy from a
README.

## Requirements

- **Windows 10 / 11.** The engine uses Windows-only perf counters
  (`Get-Counter \GPU Adapter Memory(*)\Shared Usage`) to detect silent
  WDDM paging. The CLI refuses to start on other platforms.
- **PowerShell 5.1** (ships with Windows — no install needed).
- **Node.js 18 or newer.**
- A working **llama.cpp** build with `llama-server.exe`. The first run
  (`init`) detects it if it is on `PATH`; otherwise you set the path in
  `config.json`.
- An **NVIDIA GPU** for the headline use case. CPU-only and other backends
  bench, but the WDDM-paging heuristic is NVIDIA + Windows shaped.

## Quickstart

```
$ calibr
> init        — detect hardware, write config.json
  discover    — scan scan_paths for .gguf files
  plan        — expand catalog into a test plan
  bench       — run pending bench configs
  report      — build HTML report + .bat launchers
  all         — discover -> plan -> bench -> report
  results     — browse benchmark winners
```

A typical first session:

1. **init** — auto-detect GPU/CPU/VRAM, write the local config.
2. Edit `config.json` and set `scan_paths` to the folders that contain
   your `.gguf` files.
3. **all** — runs discover, plan, bench, report end-to-end. Expect this
   to take hours depending on how many models you have.
4. **results** — browse a leaderboard of winners per model. Press
   `enter` to drill into per-config detail, `o` to open the full HTML
   report in your browser, `q` to go back.

For sub-tasks (re-bench one model, change run count):

5. From the menu pick **bench** → configure model filter, tier, runs,
   force flag → start.

## Where things are stored

After `npm install -g calibr`, the engine + defaults sit inside the
installed package. Your own data goes to:

```
%LOCALAPPDATA%\calibr\
├── config.json          your overrides
├── catalog.json         models discovered on disk
├── plan.json            test plan expanded from catalog
├── downloads.json       which .gguf files calibr downloaded (rotation manifest)
├── results\*.json       one file per bench config
├── logs\*.log           full llama-server stderr per config
├── bats\*.bat           per-config launch scripts
└── report.html          aggregated dashboard
```

If you run from a checkout of the
[main repo](https://github.com/SpeederX/calibr), data lives under
`<repo>/data/` instead — the CLI auto-detects which mode you are in by
looking for `calibr.ps1` walking up from itself.

To override either path:

```bash
$env:CALIBR_DATA_DIR = "D:\calibr-data"
$env:CALIBR_CONFIG = "D:\calibr-data\config.json"
calibr
```

## Commands

The menu exposes the engine verbs verbatim. Brief summary:

| Verb | What it does |
|---|---|
| `init` | Detect hardware, write `config.json` with sane defaults. |
| `discover` | Scan `scan_paths` for `*.gguf`, build the model catalog. |
| `plan` | Expand the catalog into a sweep of bench configurations per tier. |
| `bench` | Run each pending plan entry, write a result JSON per config. When models came from `get-sample-models`, each model's .gguf is deleted from disk after its configs all finish (use `-KeepDownloads` to opt out). |
| `report` | Build the HTML dashboard and per-config `.bat` launchers. |
| `all` | discover → plan → bench → report, end to end. |
| `status` | Print current config + counts (also shown as a card in the menu). |

## Status keybinds

- `↑` / `↓` — move
- `enter` — select / drill
- `q` / `esc` — back / quit
- `o` (results screen) — open `report.html` in your default browser
- `q` / `esc` (run screen) — cancel an in-flight bench

## Known limitations

- **Windows only.** See Requirements. Cross-platform support is on the
  roadmap when the PowerShell engine is rewritten in TypeScript.
- **`discover` pairs mmproj by directory.** If two model variants live
  in the same folder and physically share one `mmproj-*.gguf` file but
  the projector is only valid for one of them (different vision
  `n_embd`), bench will fail at load on the other. The curated samples
  set keeps Gemma 4 E2B and E4B in separate folders for this reason;
  for your own models, keep each multimodal variant in its own
  subfolder. `discover` now emits a `WARNING` whenever it sees one
  mmproj paired with multiple distinct text models.
- **No re-run-single-config from the results screen** yet. Use the
  bench screen with a tight `-Model` filter and `-Force` instead.

## Links

- Main repo, engine source, contributor docs:
  <https://github.com/SpeederX/calibr>
- Issues: <https://github.com/SpeederX/calibr/issues>

## Development

```bash
cd cli
npm install
npm run dev          # tsx watch-free, attaches to your TTY
npm run build        # tsc -> dist/
npm test             # install smoke test: npm pack -> install in tempdir -> assert
```

The `npm test` command exercises the full publish path: it runs
`npm pack` (which copies `calibr.ps1` into `engine/` via the prepack
script), installs the tarball into a clean temp dir, and asserts the
bundled engine resolves to the right paths and `readStatus()` loads
the bundled default config. Anything that breaks packaging fails the
smoke test before it can ship.

## Release

Maintainer flow:

1. From `cli/`: `npm version <patch|minor|major>` bumps
   `package.json` and creates a matching git tag.
2. `git push --follow-tags origin <branch>` — push the branch and
   the tag.
3. GitHub Actions runs `.github/workflows/release.yml` on the tag.
   It re-runs the smoke test and then publishes to npm with
   `--provenance` (signed attestation linking the tarball to the
   commit).

Requires a repo secret `NPM_TOKEN` with publish rights to the
`calibr` package on npmjs.org. Set it under **Settings → Secrets and
variables → Actions → New repository secret**. Use a *Granular
Access Token* scoped to the `calibr` package, with **read and write**
permissions, expiring no later than you intend to re-issue it.

Plain commits to any branch run `.github/workflows/ci.yml` only
(build + smoke test on `windows-latest`). They do not publish.

## License

MIT — see [LICENSE](./LICENSE).
