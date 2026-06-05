# calibr

Interactive console for **[calibr](https://github.com/SpeederX/calibr)** — a
guided local-LLM recommender that finds the fastest safe `llama.cpp`
model/configuration your hardware can actually run. It measures eval speed,
prompt speed, real VRAM, and the silent shared-memory paging that turns a
`47 t/s` config into `10 t/s` with no error message.

The CLI wraps the existing PowerShell engine and gives you a navigable
console UI for running discovery → plan → bench → report and for browsing the
resulting winners. Recommendations are based on measured fit, speed, headroom,
and spill behavior, not model-quality scoring.

![calibr CLI all flow](https://raw.githubusercontent.com/SpeederX/calibr/master/docs/cli-all.png)

![calibr full report](https://raw.githubusercontent.com/SpeederX/calibr/master/docs/report-complete.png)

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

- **Windows 10 / 11** or **Linux.** On Windows the engine uses Windows-only
  perf counters (`Get-Counter \GPU Adapter Memory(*)\Shared Usage`) to detect
  silent WDDM paging. On AMD/Linux, `radeontop` exposes the equivalent GTT
  spill signal; on NVIDIA/Linux, OOMs are clean and there is no silent spill to
  detect. macOS/Metal is not supported yet.
- **PowerShell:** Windows PowerShell 5.1 (ships with Windows) on Windows, or
  [**PowerShell Core (`pwsh`)**](https://github.com/PowerShell/PowerShell) on
  Linux — the CLI spawns `pwsh` there.
- **Node.js 18 or newer.**
- A working **llama.cpp** build with `llama-server` (`.exe` on Windows).
  `guided run` and `init` can auto-fetch an official llama.cpp release when it
  is missing; use **configure llama path** only for custom builds or offline
  setups.
- An **NVIDIA GPU** for the headline use case. CPU-only and other backends
  bench fine, but the WDDM-paging heuristic is NVIDIA + Windows shaped. On
  **AMD Linux**, install `radeontop` + `mesa-utils` for VRAM + utilization
  metrics (else temperature-only); GPU power draw isn't exposed.

### Linux dependencies

`pwsh` is required on Linux. The npm package installs the Node CLI, but the
engine still runs through PowerShell Core.

| Dependency | Required? | Used for | Typical package |
|---|---:|---|---|
| `pwsh` | yes | run `calibr.ps1` from the CLI | `powershell` (see PowerShell install docs) |
| `llama-server` | yes, auto/manual | llama.cpp inference backend | auto-fetched llama.cpp release or custom build |
| `tar` | yes for auto-fetch on Linux | extract official `.tar.gz` llama.cpp archives | usually preinstalled |
| `bash`, `chmod` | yes for `install` / launchers | `~/.local/bin/calibr` wrapper and `.sh` launchers | usually preinstalled |
| `xdg-open` | optional | open the HTML report from the CLI | `xdg-utils` |
| `lspci` | optional | GPU-name fallback | `pciutils` |
| `nvidia-smi` | optional, NVIDIA | NVIDIA VRAM / power / temp / utilization metrics | NVIDIA driver |
| `radeontop` | optional, AMD | AMD VRAM-used / utilization / GTT spill metrics | `radeontop` |
| `glxinfo` | optional, AMD | AMD VRAM-total detection | `mesa-utils` |

For AMD/Vulkan troubleshooting, `vulkaninfo` from `vulkan-tools` is the quick
way to check whether Vulkan sees real hardware or only `llvmpipe`.

## Quickstart

```
$ calibr
> guided run           download -> bench -> report
  results              browse benchmark winners
  advanced tools       status, init, discover, plan, bench, report, reset
  configure llama path * choose a llama.cpp server binary
```

A typical first session:

1. **configure llama path** if you already know the exact custom build you want.
   Otherwise skip it: if `llama_server_exe` is missing, **guided run** asks
   whether to download official llama.cpp (latest, or a typed `bNNNN` build) or
   scan existing local `llama-server` binaries. One local binary is selected
   automatically; multiple binaries open a picker.
2. **guided run** -> configure: leave `model catalog: yes`, start with the default
   starter `low` preset, choose the llama.cpp setup when prompted, and leave
   `auto-cleanup: yes`. The CLI shows the peak disk
   requirement and free space before it downloads catalog models. After you
   accept, the engine downloads each model, benches it, deletes it, and moves
   to the next.
3. **results** - browse the fastest safe winners per model. Press
   `enter` to drill into per-config detail, `o` to open the full HTML
   report in your browser, `q` to go back.

Once the starter run works, repeat `guided run` and switch `which models` to
`middle`, `high`, `ultra`, or `all` for a broader recommendation set.

For sub-tasks (re-bench one model, change run count):

4. From the menu pick **advanced tools** -> **bench** -> configure model filter,
   tier, runs, force flag, rotation -> start. If you want to keep the downloaded
   `.gguf` files on disk after the bench, toggle `rotate: no`.

## Privacy and model licenses

Benchmark data stays in the platform user-data directory and is not uploaded.
The optional catalog download step fetches GGUF files from upstream model
repositories; those files keep their original licenses and terms.

## Where things are stored

After `npm install -g calibr`, the engine + defaults sit inside the
installed package. Your own data goes to `%LOCALAPPDATA%\calibr\` on Windows,
or `$XDG_DATA_HOME/calibr` (default `~/.local/share/calibr`) on Linux:

```
calibr-data/
├── config.json          your overrides
├── catalog.json         models discovered on disk
├── plan.json            test plan expanded from catalog
├── downloads.json       which .gguf files calibr downloaded (rotation manifest)
├── llama-bin/           auto-fetched llama.cpp builds
├── results/*.json       one file per bench config
├── logs/*.log           full llama-server stderr per config
├── bats/*.bat           per-config launch scripts (*.sh on Linux)
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

The main menu is product-facing. **Guided run** wraps the engine's `all` flow,
while **advanced tools** exposes the individual engine verbs when you need
manual control:

| Verb | What it does |
|---|---|
| `init` | Detect hardware, auto-fetch llama.cpp if requested, write `config.json` with sane defaults. |
| `discover` | Scan `scan_paths` for `*.gguf`, build the model catalog. |
| `plan` | Expand the catalog into a sweep of bench configurations per tier. |
| `bench` | Run each pending plan entry, write a result JSON per config. When models came from `get-models`, each model's .gguf is deleted from disk after its configs all finish (use `-KeepDownloads` to opt out). |
| `report` | Build the HTML dashboard and per-config `.bat` launchers. |
| `all` | discover → plan → bench → report, end to end. With `catalog: on`, fetches the curated set first; with auto-fetch on, downloads llama.cpp when setup is incomplete. |
| `status` | Print current config + counts (also shown as a card in the menu). |
| `doctor` | Sanity-check the system: CPU/GPU/OS + every dependency, each with a status (ok/warn/fail/missing/skipped) and the exact fix. `-Export` writes a redacted JSON bundle to attach to an issue; `-Extended` keeps full logs. In the TUI it lives under `help` → `doctor` with navigable rows. |

## Status keybinds

- `↑` / `↓` — move
- `enter` — select / drill
- `q` / `esc` — back / quit
- `o` (results screen) — open `report.html` in your default browser
- `q` / `esc` (run screen) — cancel an in-flight bench

## Known limitations

- **Quality scoring is not implemented yet.** calibr recommends by measured
  fit, throughput, headroom, and spill behavior. Use the report to choose
  between close winners by task quality.
- **Spill detection depends on platform/tooling.** Windows/NVIDIA uses WDDM
  shared-memory counters. AMD/Linux uses GTT from `radeontop` when installed.
  NVIDIA/Linux usually fails cleanly at OOM, so there is no silent spill signal
  to detect. macOS/Metal is not supported yet.
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
`npm pack` (which copies `calibr.ps1` and `engine/*.ps1` into the package via
the prepack script), installs the tarball into a clean temp dir, and asserts the
bundled engine resolves to the right paths and `readStatus()` loads
the bundled default config. Anything that breaks packaging fails the
smoke test before it can ship.

## Release

Maintainer flow:

1. Bump `cli/package.json` and `cli/package-lock.json`, then create a matching
   tag (`vX.Y.Z`). `npm version <patch|minor|major>` does both when the working
   tree is clean; if the release commit already contains the bump, create the
   tag manually.
2. `git push --follow-tags origin <branch>` - push the branch and the tag.
3. GitHub Actions runs `.github/workflows/release.yml` on the tag. It re-runs
   the smoke test and then publishes to npm through trusted publishing (OIDC).
   npm generates provenance automatically for the public package.

Requires npm package settings to trust this GitHub repository and the exact
workflow filename `release.yml` under **Package settings -> Trusted
publishing**. No `NPM_TOKEN` repository secret is needed for publish.

Plain commits to any branch run `.github/workflows/ci.yml` only
(build + smoke test on Windows and Ubuntu). They do not publish.

## License

MIT — see [LICENSE](./LICENSE).
