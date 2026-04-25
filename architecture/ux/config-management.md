# UX flow: config management

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
llm-lab config list
llm-lab config get hardware.vram_total_mib
llm-lab config get hardware                # whole subtree

# Change something
llm-lab config set hardware.vram_safety_budget_pct 0.92    # float
llm-lab config set bench.warmup false                       # bool
llm-lab config set scan_paths "D:\models,E:\cache"          # array via CSV

# Revert to defaults
llm-lab config unset hardware.vram_safety_budget_pct

# Re-run auto-detect (after switching llama.cpp build, GPU upgrade, etc.)
llm-lab config detect llama_server_exe   # interactive picker if multiple
llm-lab config detect hardware            # re-detect via nvidia-smi + WMI
llm-lab config detect                     # both, in order
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

- `llm-lab config` (no action) prints a usage banner with the action list.
- `llm-lab config <unknown>` prints "Unknown action" + the same banner.
- `llm-lab help config` prints the full help with examples.

## Common mistakes the system catches

- `set` on a key not in `config.default.json` → rejected ("Edit the file
  to add new keys"). Prevents typos from silently burying a flag.
- `set` on an object (e.g. `set hardware whatever`) → rejected ("set its
  leaf keys individually").
- `set bench.warmup notabool` → rejected ("expected bool…").
