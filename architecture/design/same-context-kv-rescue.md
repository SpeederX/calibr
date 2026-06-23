# Same-context KV rescue

KV quantization rescue answers one narrow question: can the requested context
target run if cache quality is reduced? It must not silently change the target
being tested.

For each primary dense context config at or above the configured rescue
threshold, planning adds a conditional q4 KV config with:

- the same model, context size, GPU offload, and runtime arguments;
- only the K/V cache types changed;
- `conditional_kind=kv_rescue`;
- `conditional_source_id` pointing to the primary config.

The rescue is skipped when the primary succeeds. It is also skipped after
transport errors, timeouts, invalid completions, compatibility failures, and
other ambiguous errors; those retain their normal retry/error policy. It runs
only when the primary exhausts its attempts and produces direct `load_oom`
capacity evidence.

This keeps the comparison interpretable:

- primary succeeds: retain the higher-quality cache;
- primary fails for capacity and rescue succeeds: the context is possible with
  an explicit quality compromise;
- both fail for capacity: the context target does not fit under the tested
  allocation policy.

q4 is therefore a fallback capability probe, never the default primary cache
profile.
