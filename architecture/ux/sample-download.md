# UX flow: curated model catalog

The curated catalog gives users known GGUF variants and makes results more
comparable across machines.

## Guided flow

The user selects a hardware level, model, or explicit catalog scope. Guided run
then interleaves:

1. download one catalog entry;
2. discover and plan it;
3. benchmark its configs;
4. apply the selected retention policy;
5. continue with the next entry.

This avoids requiring enough free disk for the whole catalog. The exact model
list, sizes, upstream repositories, and context limits live in
`models_catalog.json`; presets live in `default_bench_presets.json`.

Raw catalog commands remain available for maintainers, but they are not the
primary download UX.
