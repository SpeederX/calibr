# UX flow: first-time install

The user just cloned the repo and has never run calibr before.

## Goal

Get from `git clone` to "I can type `calibr` from anywhere" in three
commands.

## Steps

1. **Clone & enter**:
   ```powershell
   git clone <repo-url> calibr
   cd calibr
   ```

2. **Make the command global** (optional but recommended):
   ```powershell
   .\calibr.ps1 install
   ```
   This adds the project directory to the User-scope PATH (no admin) and
   patches the current shell session so `calibr` is usable immediately.
   Output ends with: *"You can now run 'calibr \<command>' from any directory."*

3. **First config** (interactive or non-interactive):
   ```powershell
   calibr init
   ```
   Detects HW (GPU via `nvidia-smi`, CPU via WMI), searches for
   `llama-server.exe` in sibling directories, searches for `.gguf` folders
   nearby, and writes `config.json`. If multiple `llama-server.exe`
   candidates are found, the user is prompted to pick one by index.

4. **First run**:
   ```powershell
   calibr all
   ```
   Goes through `discover → plan → bench → report`. The report opens with
   `start data\report.html`.

## Skipping `init`

The user can skip `init` entirely and pass overrides via flags:

```powershell
calibr all -ScanPath D:\models -LlamaServer C:\bin\llama-server.exe
```

Or fetch the curated reference set instead of using local files:

```powershell
calibr all -DownloadSamples -SampleId qwen3.5-9b-q4km
```

## What success looks like

- `calibr status` shows `global PATH: yes (User scope)` and the right
  paths under `Config:`.
- `data\report.html` exists and opens in a browser with at least one
  winning configuration.
- `data\bats\<model>.bat` files are present, double-clickable to launch
  llama-server with the optimized flags.

## Common first-run gotchas

- **No `llama-server.exe` found**: `init` prints a warning and leaves
  `llama_server_exe` empty. Re-run with `-LlamaServer <path>` or set
  via `calibr config set llama_server_exe "<path>"`.
- **Wrong build picked from multiple candidates**: re-run `init` with
  `-Force` or use `calibr config detect llama_server_exe` to pick again.
- **CUDA vs Vulkan mismatch**: `bench` prints a yellow warning if you have
  an NVIDIA GPU but a Vulkan-only build. Get a CUDA build from the
  llama.cpp releases page; usually the easier fix than tolerating the
  10-15 % perf penalty.
