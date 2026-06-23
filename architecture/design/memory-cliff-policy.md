# Memory state and context cliff policy

Shared allocation and performance spill are related observations, not
synonyms. calibr records these states:

- `dedicated`: allocation remains in dedicated VRAM;
- `saturated`: dedicated VRAM is near capacity;
- `shared_allocated`: shared growth exists but is below the significance
  threshold;
- `spill_risk`: significant shared growth exists, but no workload curve proves
  its performance cost;
- `spill_correlated_degradation`: KV-fill crosses the estimated boundary and
  throughput loses more than 20% beyond the clean expected trend;
- `moe_shared_ambiguous`: CPU expert mapping and GPU spill cannot yet be
  separated reliably.

For dense context runs, the estimated active-context boundary uses the last
two clean allocation points:

```text
allocation slope = delta dedicated MiB / delta context tokens
remaining dedicated = installed VRAM - last clean dedicated peak
estimated cliff = last clean context + remaining dedicated / allocation slope
```

The estimate describes a context-token boundary implied by memory growth. It
is not itself proof of spill. Confirmation requires median KV-fill measurements
below and above that boundary, significant shared allocation above it, and
more than 20% throughput loss relative to the clean pre-boundary trend.

Without KV-fill, dense shared growth produces the user-facing warning:
“Might spill with high context usage.” MoE remains explicitly ambiguous until
an architecture-aware method can separate intentional CPU mapping.
