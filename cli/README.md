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
| `bench` | Run each pending plan entry, write a result JSON per config. |
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
- **`discover` pairs mmproj by directory.** Two model variants in the
  same folder that ship the same `mmproj-F16.gguf` filename but with
  different `n_embd` (Gemma 4 E2B vs E4B is the known case) will
  cross-pair and the wrong one fails at load. Workaround: put each
  multimodal variant in its own subfolder.
- **No re-run-single-config from the results screen** yet. Use the
  bench screen with a tight `-Model` filter and `-Force` instead.

## Links

- Main repo, engine source, contributor docs:
  <https://github.com/SpeederX/calibr>
- Issues: <https://github.com/SpeederX/calibr/issues>

## License

MIT — see [LICENSE](./LICENSE).
