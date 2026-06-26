# Runtime failure policy

Benchmark failures are control-flow signals, not interchangeable failed rows.
The runtime records a structured failure and uses its cause to decide whether
the same work should be retried, a monotonic branch can be pruned, or the
benchmark must stop.

## Failure contract

Every failed measured attempt records:

- `phase`: where the failure occurred;
- `cause`: the normalized reason;
- `evidence`: the concise source message retained for diagnosis;
- `action`: the next runtime decision;
- `retryable`, `attempts`, and `retry_exhausted`.

The TypeScript coordinator is authoritative on the primary CUDA path.
PowerShell preserves the same contract for portable fallback execution.

## Decision tree

| Cause | First action | Action after three attempts |
| --- | --- | --- |
| unsupported architecture | abandon the model | unchanged |
| unsupported argument or incompatible cache profile | abandon that profile | unchanged |
| load OOM / failed fit | abandon heavier targets in the same monotonic sweep | unchanged |
| request timeout during prefill or KV-fill | retry the same config | skip larger targets from the same diagnostic source |
| process exit, readiness timeout, transport error, invalid completion, unknown | retry the same config | skip this config and continue |
| missing model | skip this config | unchanged |
| unavailable engine, user cancellation, persistence failure | abort the benchmark | unchanged |

Retryable failures receive three measured attempts. In the interactive raw
workflow, an exhausted failure offers skip, another group of retries, or abort.
Headless execution skips and continues. The final summary groups unresolved
failures by cause and keeps the corresponding log path.

## Pruning boundaries

Pruning is allowed only when the failure identifies a monotonic relationship:

- load OOM can prune heavier context/offload targets in the same sweep;
- an exhausted prefill or KV-fill timeout can prune larger targets for the
  same diagnostic source;
- an unsupported cache pair can prune that cache profile, but not other
  profiles or contexts;
- an unsupported architecture can prune the whole model.

An ambiguous process exit, timeout, or invalid response must not be interpreted
as capacity failure before retries are exhausted.

## Memory evidence is not a failure cause

Shared-memory growth by itself does not prove OOM, failed fit, or performance
spill. It remains measurement evidence for the separate spill-risk and
correlated-degradation methodology. This policy only classifies an allocation
failure as `load_oom` when llama.cpp reports failed fit or the process output
contains direct allocation/OOM evidence.

This distinction prevents a successful but memory-heavy run from being pruned
before a KV-fill workload can determine whether shared allocation correlates
with a throughput cliff.
