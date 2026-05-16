# Spec: export bench results to localmaxxing's leaderboard

## Goal

Contribute calibr's measured tokens-per-second data points back to
the community leaderboard at localmaxxing.com via its documented
API, so users see how their hardware compares against others
running the same configurations.

## Background

[localmaxxing.com](https://www.localmaxxing.com/en/api-docs)
aggregates community benchmark submissions across hardware. The
fields it records (launch command, engine, version, weight
quantization, key-value-cache quantization, operating system,
context size, batch size, plus hardware metadata) are exactly the
fields calibr already gathers locally. The gap is the submission
plumbing — schema mapping, authentication, error handling — not
the data itself.

Submission requires an OAuth-issued bearer token from
localmaxxing's web UI (sign-in via GitHub or Hugging Face). calibr
consumes the token; the OAuth flow stays in the browser.

## Behavior

### New subcommand

- `calibr localmaxxing-export` reads every result in
  `data/results/*.json`, maps each to the localmaxxing schema, and
  POSTs to `/api/benchmarks` with
  `Authorization: Bearer $env:CALIBR_LOCALMAXXING_API_KEY`.
- `calibr localmaxxing-export -Force` resubmits every result,
  including those previously recorded as `submitted`.
- Without `-Force`, results whose stored
  `localmaxxing_export.status` is `submitted` are skipped silently.

### Auto-submission opt-in

- The first time a user runs `calibr all`, calibr prompts:

  > Submit results to localmaxxing after each bench cycle? (Y/N)
  > Generate an API key at https://www.localmaxxing.com/<key-page>
  > and export it as `$env:CALIBR_LOCALMAXXING_API_KEY` before
  > running again.

- The answer is persisted as `localmaxxing.auto_submit: bool` in
  `config.json`. Subsequent `calibr all` runs honor the stored
  value without re-prompting.
- The user can change the answer later via
  `calibr config set localmaxxing.auto_submit true` / `false`.
- The prompt fires only from `calibr all` and only when
  `localmaxxing.auto_submit` is unset. Other subcommands
  (`bench`, `report`) never prompt.
- With `-NonInteractive`, the prompt is skipped and the field
  defaults to `false`.

### Authentication

- Bearer-only. The token is read at submission time from
  `$env:CALIBR_LOCALMAXXING_API_KEY`. If the env var is empty or
  missing when submission would fire, the export step is skipped
  with one warning line that points to localmaxxing's key page;
  the rest of the pipeline (bench, report) is unaffected.
- The token is never written to `config.json`, never logged, never
  embedded in `data/results/` files, never printed.

### Hugging Face model id

- The localmaxxing schema requires an `hf_model_id` per result. The
  source by model class:
  - **Sample-set models** (downloaded from `samples.json`): the
    Hugging Face URL is already known; the id is derived once at
    download time and persisted in the catalog entry's
    `hf_model_id` field.
  - **User-owned models** (discovered from `scan_paths[]`): the
    first time `localmaxxing-export` encounters one without a
    cached id, it prompts:

    > Hugging Face model id for `<filename>`?
    > (e.g. `Qwen/Qwen2.5-7B-Instruct-GGUF`. Press Enter to skip.)

    The answer is persisted in `data/catalog.json` under the
    catalog entry's `hf_model_id` field. Subsequent runs read the
    cached value silently. A blank answer marks the entry
    `hf_model_id: null` permanently — no re-prompting until the
    user explicitly resets it via `config unset` or by editing the
    catalog by hand.
- A catalog entry with `hf_model_id: null` is excluded from
  export. The skip is logged but is not an error. No heuristic
  filename-to-Hugging-Face guessing.
- With `-NonInteractive`, the prompt is skipped; entries without
  a cached id are excluded from this export call.

### Per-result submission tracking

- Each result's JSON gains a `localmaxxing_export` sub-object
  populated after the submission attempt:

  ```json
  "localmaxxing_export": {
    "status": "submitted" | "failed" | "skipped",
    "attempted_at": "<ISO 8601>",
    "http_code": <int | null>,
    "error_message": <string | null>,
    "submission_id": <string | null>
  }
  ```

- `submitted` results carry the `submission_id` returned by the
  API. `failed` results carry `http_code` and `error_message`
  (raw response body, truncated to two hundred fifty-six bytes).
  `skipped` results carry the reason (e.g., `"no hf_model_id"`).

### Report integration

- The report HTML gains one new panel: "localmaxxing submissions".
  Two summary numbers (submitted, failed) and, for the failed
  results, an expandable details block per result showing
  `http_code`, `error_message`, and the test id. The submitted-
  results list is not enumerated in the report (the report is for
  the user; submitted-list is queryable from the JSON).

### Submission ordering

- Results are processed in the order they appear under
  `data/results/*.json` (filesystem order). Each submission is a
  separate HTTP request; failures do not block subsequent
  submissions.
- A timeout of thirty seconds per request is enforced. A timeout
  is recorded as `failed` with `http_code: null` and
  `error_message: "timeout"`.

## Acceptance

- [ ] With `$env:CALIBR_LOCALMAXXING_API_KEY` set and
      `localmaxxing.auto_submit: true`, a `calibr all` run ends by
      attempting submission for every result not already marked
      `submitted`, and the terminal prints one outcome line per
      attempt.
- [ ] With the env var absent, `calibr all` finishes bench
      normally, then prints exactly one warning line referring
      the user to the key page; no HTTP request is made.
- [ ] `calibr localmaxxing-export` invoked explicitly is
      independent of `auto_submit`: it submits unsubmitted results
      whether or not auto-submit is on.
- [ ] A user-owned `.gguf` without a recorded `hf_model_id`:
      `localmaxxing-export` prompts once (interactive runs),
      writes the answer to `data/catalog.json`, and includes the
      result in this submission attempt; subsequent runs read the
      cached id silently.
- [ ] A 401, 403, or 5xx response is captured in the result's
      `localmaxxing_export` sub-object, surfaces in the report's
      submissions panel, and re-attempts on the next
      `localmaxxing-export` call (unless `submitted`).
- [ ] A submission already marked `submitted` is not resubmitted
      without `-Force`.
- [ ] `data/catalog.json` and `data/results/*.json` are the only
      files written by export; no separate user-editable JSON is
      generated.
- [ ] The bearer token never appears in any file, log line, or
      report output.

## Out of scope

- Reading data back from localmaxxing (importing other users'
  numbers into the report). Future feature; not v1.1.0.
- Importing localmaxxing's evaluation methodology (MMLU and
  similar) into calibr. Touches v1.3.0 / v1.4.0+ scope.
- Playwright or any browser-UI scraping path. API only.
- Generating a JSON file the user can edit and submit manually. No
  manual-upload workflow.
- Handling the OAuth flow itself. The user gets the bearer from
  localmaxxing's web UI; calibr only consumes it.
- Per-result opt-out. Either auto-submit is on (every unsubmitted
  result goes) or off (none go).
- Retry policy beyond "try again on next `localmaxxing-export`
  call". No exponential backoff, no scheduled retry, no daemon.
