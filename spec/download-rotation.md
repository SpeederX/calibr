# Spec: download rotation for the curated sample set

## Goal

Cut the working-set storage required to bench the full curated
sample set from roughly one hundred gigabytes to roughly one model
at a time, by deleting each model after its benchmarks finish and
before the next one downloads.

## Background

`-DownloadSamples` today fetches every model in `samples.json`
(approximately one hundred gigabytes across ten-plus files) before
the bench pipeline starts. A developer machine with an eight-
gigabyte graphics card and a two-hundred-fifty-six-gigabyte solid-
state drive cannot realistically run that path without juggling
disk space by hand. Rotation downloads one model, benchmarks it,
deletes the file, then moves to the next. Peak working-set drops to
the size of the largest single model (about twenty gigabytes).

The feature is strictly opt-in: existing users on machines with
ample storage continue to get the current behavior unless they ask
for rotation explicitly.

## Behavior

### New flag

- `-Rotate` is added to `calibr all` (and to `get-sample-models`
  when invoked standalone). It is valid only in combination with
  `-DownloadSamples`; using `-Rotate` without `-DownloadSamples` is
  a usage error and prints a one-line help message.

### Tag at download time

- When `calibr` itself downloads a file, the catalog entry for that
  file is written with `downloaded_by_calibr: true`. The tag lives
  in `data/catalog.json` next to the existing fields (`model`,
  `variant`, `series`, etc.).
- Files discovered by `discover` from `scan_paths[]` that calibr
  did not download have `downloaded_by_calibr: false` (or the field
  is absent — treated identically). User-owned files are never
  tagged.

### Delete after bench

- After every config that targets model M finishes (success or
  fail), the rotation step checks: if model M is the last model in
  the current rotation slice AND every config for M is now
  recorded in `data/results/`, AND the catalog entry has
  `downloaded_by_calibr: true`, AND every config for M succeeded:
  delete the model file and any auto-paired
  `mmproj-*.gguf` from disk.
- If any config for M failed, the model file is preserved on disk
  so the user can re-run or inspect. Rotation moves on to model
  M+1.
- The catalog entry for M is preserved with its `downloaded_by_calibr`
  flag and its other metadata. Only the `.gguf` and `mmproj` files
  on disk are removed. A subsequent `discover` will rediscover
  the entry only if the user re-runs `get-sample-models -SampleId M`.

### Ordering

- Rotation processes models in `samples.json` order, filtered by
  the same flags that filter `-DownloadSamples` (`-SampleId`,
  `-Model`, `-Tier`). Within one model, all configs run before the
  next model starts.

### Interruption

- A `Ctrl-C` mid-rotation leaves whatever has been downloaded so
  far on disk; the partially-benchmarked model is not deleted
  (because its results are not yet all recorded). Re-running the
  same command resumes: the partially-cached model is detected by
  `bench`'s existing cache check, only missing configs run, and
  the post-bench rotation step deletes the file once all configs
  for that model finish.

## Acceptance

- [ ] `calibr all -DownloadSamples -Rotate` on the full sample set
      keeps `data/downloaded-models/` (or the configured
      destination) bounded above by the size of one model plus
      the catalog and results.
- [ ] After a successful rotation run, every benchmarked model has
      an entry in `data/results/`, and no `.gguf` files remain in
      the rotation destination.
- [ ] A user-owned `.gguf` placed in the same destination directory
      (with `downloaded_by_calibr` false or absent) survives a
      rotation run untouched, even if its model gets benchmarked.
- [ ] When `bench` returns a non-zero exit for any config of model
      M, the `.gguf` for M remains on disk; the rotation continues
      to model M+1.
- [ ] `calibr all -Rotate` without `-DownloadSamples` exits with a
      usage error referencing both flags.
- [ ] The catalog entry for a rotated-and-deleted model is
      preserved (records exist, with `downloaded_by_calibr: true`),
      so a re-download is one `get-sample-models -SampleId` call.

## Out of scope

- Rotation across separate `calibr all` invocations. Each run is
  independent; nothing is deleted from a previous run.
- Pre-emptive deletion of cached files from non-rotated previous
  runs. A user who has the full set on disk and wants to free
  space removes the files manually.
- Selective rotation (e.g., "rotate only models above N
  gigabytes"). One opt-in flag with one behavior; size-based
  policy is over-engineering for the current need.
- Rotation of user-owned models, ever, under any flag combination.
- Re-download of a rotated model later in the same run. If a
  feature requires the file again, the design has to bring it back
  before deletion, not after.
