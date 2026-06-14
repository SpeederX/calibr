# Troubleshooting

calibr writes two useful diagnostics:

- `doctor-report.json` from `calibr doctor -Export -Extended`: system setup, dependencies, GPU/CPU visibility.
- `logs/action-trace.log` under the calibr data directory: human-readable actions, outcomes, and redacted paths.
- `logs/action-trace.jsonl`: the same trace in machine-readable JSONL for development/debug tooling.

When opening an issue, attach `doctor-report.json` and `action-trace.log` when possible. Doctor explains the machine; the trace explains the attempted flow.

Each app launch starts a new session section in `action-trace.log`. `session.end` is best-effort and may be missing after a crash or forced terminal close.

| Action | Meaning | Handled action |
|---|---|---|
| guided run > llama.cpp > download | The user chose to let calibr download an official llama.cpp build. | Resolve GitHub release, pick platform/GPU asset, download archive, extract `llama-server`, save preferred build when provided. |
| guided run > llama.cpp > scan local | The user chose to search for an existing `llama-server`. | Scan PATH, calibr cache, configured scan roots, and nearby folders; auto-select one candidate or show a picker. |
| guided run > llama.cpp > pick local | The user selected one discovered local `llama-server`. | Store that choice for the current guided run and pass it to the engine. |
| guided run > model folder | The user selected the folder used for local `.gguf` files and kept catalog downloads. | Pass it to the engine as the scan path, and as the download destination when catalog download is enabled. Trace details use `<model_folder_dir>` and include the `.gguf` model count. |
| guided run > model folder create | The selected model folder did not exist. | Ask before creating it, create on confirmation, or return to folder input on cancel/failure. |
| guided run > start | The user started the benchmark/recommendation flow. | Run setup/discover/plan/bench/report internally with the selected catalog, model scope, cleanup policy, and llama.cpp choice. |
| guided run > start > download model | The engine is downloading a catalog model from Hugging Face. | Download the model file, emit progress, record calibr-owned downloads in `downloads.json`, and report skip/fail/success. |
| guided run > start > cleanup model | A downloaded model finished its bench configs. | Delete it, keep all downloads, or keep only top 1/top 3 current winners according to the selected winner rule. User-owned local-folder models are never deleted. |
| configure llama path > pick file | The user opened the manual llama.cpp file picker. | Accept a selected path or record cancel/no selection. |
| configure llama path > save path | The user confirmed a custom `llama-server` path. | Write `llama_server_exe` to the local config. |
| configure llama path > use cached llama.cpp | The user selected an auto-fetched cached build. | Use that cached `llama-server` path as the configured binary. |
| configure llama path > delete cached llama.cpp | The user deleted an auto-fetched cached build. | Remove the cached build folder from `llama-bin/<build>/<flavor>`. |
| results > open report | The user asked to open the generated HTML report. | Launch the OS browser command or record that `report.html` is missing/open failed. |
| results > re-run selected config | The user re-ran one benchmark result. | Launch `bench -Id <id> -Force` for that config. |
| advanced tools > <command> | Deprecated developer/debug command path. | Run the selected engine command and record process start, exit code, or launch failure. Prefer `guided run` for normal use. |

