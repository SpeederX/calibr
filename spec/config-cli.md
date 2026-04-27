# Spec: `calibr config <action>`

## Goal

Inspect and edit `config.json` from the command line, with type-safe
coercion, override-only writes, and an interactive auto-detect that
mirrors `init`. No JSON editing required.

## Background

`config.json` is gitignored and contains the user's overrides on top of
`config.default.json` (see `architecture/design/override-only-config.md`).
Editing it by hand is fine but error-prone (typos, wrong types, leftover
empty objects after partial deletes). A CLI wrapper makes scripted
configuration possible (CI, dotfiles, troubleshooting docs).

## Behavior

Five actions, dispatched by the first positional argument after `config`:

### `list` (or no action → usage banner)

Print every key reachable via dot-notation. Columns: key, runtime type
(`int / float / bool / string / array / object`), source marker
(`[default]` or `[local]`), value. Sort alphabetically. Skip keys named
`_comment_*`. Source colors: gray for default, green for local.

### `get <key>`

Print one value. If the key is an object, print its sub-keys recursively
indented under the object header. If the key doesn't exist in either
default or local config, print `key '<key>' not found.` (yellow) and
return.

### `set <key> <value>`

Look up `<key>` in `config.default.json` to determine the schema type.
Coerce `<value>` accordingly:

- `bool`: accept `true|1|yes|on` / `false|0|no|off`. Anything else throws.
- `int`: `[int]<value>`. Throws on non-numeric.
- `float`: `[double]<value>`.
- `array`: split `<value>` on `,`, trim each, drop empties.
- `object`: rejected ("set its leaf keys individually").
- `null` (default placeholder): auto-detect from value shape — bool /
  int / float / string in that order.
- `unknown` (key not in schema): rejected ("Edit `config.default.json`
  to add new keys").

Write the leaf into the local `config.json`. Do not touch other keys.
Print `set <key> = <value> (<type>) -> config.json` (green).

### `unset <key>`

Remove `<key>` from local config. After removal, walk back up the parent
chain and prune any parent hashtable that became empty as a result —
stop at the first parent that still has siblings. If the key wasn't
present, print yellow note and return.

### `detect [<key>]`

Re-run the same auto-detection that `init` would run, but write only the
requested key:

- `llama_server_exe`: search via `Find-LlamaServerExe`. If 0 candidates,
  warn. If 1, auto-pick. If >1, prompt the user with numbered list (or
  pick `[0]` under `-NonInteractive`).
- `hardware`: query `nvidia-smi` and WMI. Set `auto_detect=false`,
  `vram_total_mib`, `vram_safety_budget_mib` (computed from
  `vram_safety_budget_pct`), `gpu_name`, `gpu_compute_cap`,
  `cpu_cores_physical`, `cpu_threads_logical`.
- No key, or `all`: do both, in that order.

Save the result to `config.json` only if at least one detection
succeeded.

## Acceptance criteria

- [ ] `calibr config` (no action) → prints usage banner with the five
      actions, doesn't run anything.
- [ ] `calibr config bogus` → prints "Unknown action" + the same banner.
- [ ] `calibr config list` → 25-30 lines, each tagged `[default]` or
      `[local]` with the right type.
- [ ] `set` + `get` round-trips bool, int, float, string, and array values.
- [ ] `set` rejects unknown keys, object keys, and bad type input with
      clear error messages.
- [ ] `unset` after `set foo.bar X` leaves `config.json` without an empty
      `foo: {}` carcass.
- [ ] `detect llama_server_exe` with `-NonInteractive` picks index 0 of
      the candidates and prints the rest.
- [ ] All actions exit with code 0 on success (cf. `nvidia-smi`'s residual
      `$LASTEXITCODE` issue, fixed at the end of dispatch).

## Out of scope

- Adding new keys (the user is expected to edit `config.default.json`).
- Importing/exporting full configs (use `config.json` directly).
- Encrypted secrets handling (no secrets in the schema today).
