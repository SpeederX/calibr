# UX flow: config management

> Guided preferences are the primary user surface. The commands below describe
> the advanced raw-engine interface used for maintenance, diagnosis, and
> automation.

The user wants to inspect, change, or auto-detect configuration without
opening `config.json` in an editor.

## Sub-actions

| Action  | Purpose                                              |
|---------|------------------------------------------------------|
| `list`  | Show all keys with type and source (`[default]` / `[local]`) |
| `get`   | Show one value (or all sub-keys when the key is an object) |
| `set`   | Override a leaf value, type-coerced from the schema  |
| `unset` | Remove a local override; default applies again       |
| `detect`| Re-run the same auto-detection that `init` would do  |

## Common operations

```powershell
# What's set right now?
calibr config list
calibr config get hardware.vram_total_mib
calibr config get hardware                # whole subtree

# Change something
calibr config set hardware.vram_safety_budget_pct 0.92    # float
calibr config set bench.warmup false                       # bool
calibr config set scan_paths "D:\models,E:\cache"          # array via CSV

# Revert to defaults
calibr config unset hardware.vram_safety_budget_pct

# Re-run auto-detect (after switching llama.cpp build, GPU upgrade, etc.)
calibr config detect llama_server_exe   # interactive picker if multiple
calibr config detect hardware            # re-detect via nvidia-smi + WMI
calibr config detect                     # both, in order
```

## What the user sees

- `list` prints one line per key with the runtime type in parentheses, the
  source marker (`[local]` in green, `[default]` in gray), and the value.
- `get` on an object key prints `key (object) [source]` followed by an
  indented list of sub-keys.
- `set` writes only the leaf to `config.json`; everything else continues
  to come from `config.default.json`.
- `unset` removes the key and prunes empty parent objects so the file
  stays clean.
- `detect llama_server_exe` shows numbered candidates and prompts the
  user to pick one (or auto-picks `[0]` with `-NonInteractive`).

## Discoverability

- `calibr config` (no action) prints a usage banner with the action list.
- `calibr config <unknown>` prints "Unknown action" + the same banner.
- `calibr help config` prints the full help with examples.

## Common mistakes the system catches

- `set` on a key not in `config.default.json` → rejected ("Edit the file
  to add new keys"). Prevents typos from silently burying a flag.
- `set` on an object (e.g. `set hardware whatever`) → rejected ("set its
  leaf keys individually").
- `set bench.warmup notabool` → rejected ("expected bool…").
