# UX flow: sample download

The user has no `.gguf` files yet, or wants comparable benchmark numbers
against the curated reference set.

## Goal

Get a known set of GGUF models on disk and benchmark them.

## The curated set

`samples.json` lists 12 reference models spanning 0.5 GB → 22 GB:

- Qwen3.5: 0.8B (Q8 + Q4_K_XL), 2B (Q4_K_XL + BF16), 4B, 9B, 27B
- Qwen3.6 35B-A3B (MoE)
- Gemma 4: E2B, E4B, 26B-A4B (MoE), 31B

Each entry has `hf_repo`, `hf_file`, `target_dir`, `size_bytes`, `tier_hint`,
and an optional `mmproj_file` for multimodal pairs.

## Steps

### Listing what's available

```powershell
llm-lab get-sample-models
```

Prints the 12 entries as a table. `OK` next to ones already on disk.
No download triggered without a flag.

### Single sample

```powershell
llm-lab get-sample-models -SampleId qwen3.5-9b-q4km   # ~5 GB
```

### Model

```powershell
llm-lab get-sample-models -Model "Qwen3.5"            # all Qwen3.5-* models
```

### The full set

```powershell
llm-lab get-sample-models -DownloadAll                # ~100 GB; prompts to confirm
```

Failures (401 = HF license needed; 404 = renamed file) print actionable
hints.

### One-shot: download + benchmark

```powershell
llm-lab all -DownloadSamples                          # full set + pipeline
llm-lab all -DownloadSamples -SampleId qwen3.5-9b-q4km # one model + pipeline
llm-lab all -DownloadSamples -Model "Qwen3.5"         # one model + pipeline
```

If neither `config.json` nor `-ScanPath` provides a scan path, the samples
land in `<lab>/downloaded-models/` and discover is auto-pointed there.

## What success looks like

- Files at `<scan_paths[0]>/<target_dir>/<hf_file>`. Sizes within ~1 % of
  `size_bytes` from `samples.json`.
- A subsequent `llm-lab discover` includes them in the catalog.

## Why a curated set

So benchmark numbers are comparable across machines. Anyone running the
same set produces directly-comparable `data/results/*.json` files,
enabling crowdsourced "what runs well on what GPU" datasets.
