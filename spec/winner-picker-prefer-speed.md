# Spec: `-PreferSpeed` flag for winner picker

## Goal

Let the user opt out of the WDDM-safety preference in `Invoke-Report`'s
winner picker, accepting paging risk in exchange for raw throughput.

## Background

The default winner picker (since v0.1.0) prefers a *safe* config (no
WDDM paging) over a *fast-but-paging* one. This is the right default —
on a quiet desktop a non-paging 30 t/s config beats a 50 t/s config that
will collapse the moment a Chrome tab eats some shared GPU memory.

But sometimes the user *knows* their environment is stable and would
rather have the fastest config. Today the only escape hatch is editing
the picker by hand. Item from the v0.2.0 follow-up roadmap.

## Behavior

A new `-PreferSpeed` switch on the `report` and `all` subcommands:

```powershell
calibr report -PreferSpeed
calibr all    -PreferSpeed
```

When `-PreferSpeed` is set, the picker selects the highest `eval_tps`
per group key, ignoring `shared_peak_mib`. When **not** set (default),
behavior is unchanged from v0.2.0.

The selected winner's `.bat` launcher is named identically to the
non-PreferSpeed case (no suffix); regenerating the report toggles the
file in place. Documented in `help report`.

## Acceptance

- [ ] `calibr report -PreferSpeed` on a dataset where a paging config
      has a higher `eval_tps` than the safe one picks the paging config
      as winner; the same dataset without the flag picks the safe one.
- [ ] The winner is reflected in both the HTML report and the per-family
      `.bat` launcher (the launcher's flags match the picker's choice).
- [ ] `calibr help report` lists `-PreferSpeed` with a one-line
      description.
- [ ] `Test-IsBetterWinner` (the extracted helper) is covered by unit
      tests for the four cases: prefer-speed on/off × paging on/off.

## Out of scope

- Adding the flag to non-relevant subcommands (`bench`, `discover`, etc.).
- Persisting `-PreferSpeed` as a config field. Always opt-in per run.
- Additional preference axes (e.g. "prefer quality" — see the quality-
  scoring roadmap item, separate spec).
