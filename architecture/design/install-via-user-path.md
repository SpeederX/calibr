# `install` via User-scope PATH

## Why

Most users want to type `llm-lab status` from any directory, not
`.\llm-lab.ps1 status` from the project folder. Options:

1. Install as a PowerShell module (`Install-Module`).
2. Drop a wrapper into a system-wide bin directory (admin-only).
3. Add the project directory itself to PATH.

## Approach

Option 3, scoped to **User PATH** (no admin needed):

```powershell
[Environment]::SetEnvironmentVariable("PATH", "<old>;<lab_root>", "User")
$env:PATH = "$env:PATH;<lab_root>"   # patches the current shell too
```

A `.cmd` wrapper (`llm-lab.cmd`) lets cmd.exe find a `llm-lab` command;
PowerShell finds it via PATHEXT. The wrapper invokes the `.ps1` with
`-NoProfile -ExecutionPolicy Bypass` so it works on locked-down machines
and starts faster (no profile load).

`uninstall` removes the entry it added. Both are idempotent.

## Pros

- One command (`llm-lab install`) for the user. Zero filesystem moves, no
  symlinks, no junctions.
- Reversible: `llm-lab uninstall` removes only the entry it added.
- No admin rights required. Works on locked-down corporate machines.
- The script can self-update via `git pull` and changes take effect
  immediately — no module re-import or re-install.

## Cons

- Two filenames in the project (`.ps1` and `.cmd`). Mitigated by the help
  system using `llm-lab` everywhere; the user rarely thinks about which
  extension is invoked.
- Relative paths in `config.json` resolve to the user's CWD at invocation
  time, not the project dir. Documented; recommended fix is absolute paths
  in `scan_paths`.
- Cross-platform port needs a different mechanism (rc-file injection on
  Linux/macOS; see ROADMAP).

## Takeaway

The simplest thing that could possibly work was the right call. Module
packaging would have meant a manifest, an `Install-Module` convention, and
giving up the ability to live-edit the script. PATH manipulation is boring
and ubiquitous and it's exactly enough.
