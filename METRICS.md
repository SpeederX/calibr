# calibr metric guide

This document defines what calibr measures, where each value comes from, and
how it should be interpreted. The benchmark target is llama.cpp inference on a
specific machine. HTTP and SSE delivery are measured separately and are not
treated as model throughput.

## Two clocks

calibr deliberately keeps two clocks separate:

| Clock | Source | Measures |
|---|---|---|
| Server | llama-server `timings` and `prompt_progress` | Prefill and token generation inside llama.cpp |
| Client | monotonic timestamps around `fetch` and SSE parsing | HTTP setup, stream delivery, and user-observed latency |

Server metrics describe inference. Client metrics describe delivery. A client
timestamp must not be presented as token-generation time.

## Vanilla control and calibr uplift

Every model has one `control_kind = vanilla` run using llama.cpp defaults
instead of calibr's launch tuning. It uses the same measured request and repeat
policy as the optimized configs, but context and allocation may differ because
that difference is part of the product comparison.

When both runs complete:

`uplift_tps = winner_eval_tps - vanilla_eval_tps`

`uplift_pct = uplift_tps / vanilla_eval_tps * 100`

The report compares a winner with the vanilla control from the same benchmark
session when possible. If vanilla fails to load or complete and an optimized
config succeeds, the outcome is reported as “calibr made it usable”; no
percentage is calculated from a missing or zero baseline. Controls are
excluded from winner selection and launcher generation.

## Request sequence

Each measured configuration runs:

1. an optional non-streaming warm-up;
2. a KV-slot reset after a successful warm-up;
3. one full-length streaming request with fixed output length,
   `timings_per_token`, and `return_progress`.

The measured streaming request is the single source for official `prompt_tps`,
`eval_tps`, TTFT, ITL, delivery, and timeline metrics. Final throughput comes
from llama-server's internal `timings`, not client timestamps. The request uses
`ignore_eos`, a fixed seed, and the configured `n_predict`, so every run does
the same amount of decode work.

If the installed llama-server cannot erase the slot after a successful warm-up,
calibr rejects the measurement. With multimodal servers on builds where slot
erase is unsupported, calibr skips the optional warm-up instead.

The isolated streaming-overhead UAT used to validate this consolidation compares
three modes with identical work and an erased KV slot before every measurement:

- **A — non-streaming:** server-clock reference;
- **B — streaming drain:** drains response bytes immediately, then parses SSE
  only after the socket closes;
- **C — streaming production:** runs the same per-event coordinator callback
  used to build the report timeline. Ink does not currently render each token.

The order is mirrored (`A B C C B A`) to reduce thermal drift. The primary
comparisons are B−A (server streaming cost) and C−B (calibr callback cost).
Run it from `cli/` with `npm run uat:stream-overhead -- --payload <file.json>`.

## Model metrics

These values use llama-server's internal clock.

### `server_prefill_ms`

Prompt-processing duration reported as `prompt_ms`.

```text
server_prefill_ms = prompt_ms
```

This is model work, not HTTP overhead. Larger prompts and KV pressure can make
it grow substantially.

### `prompt_tps`

Prompt-processing throughput:

```text
prompt_tps = prompt_n / (prompt_ms / 1000)
```

Higher is better. It measures prefill, not generation.

### `server_ttft_ms`

Time through prompt processing and first-token decode:

```text
server_ttft_ms = prompt_ms + predicted_ms at predicted_n = 1
```

This is available only when the installed llama-server build emits a timing
sample for the first decoded token. calibr leaves it null rather than deriving
it from client delivery timestamps.

### `eval_tps`

Official sustained decode throughput from the measured streaming request:

```text
eval_tps = predicted_n / (predicted_ms / 1000)
```

This is the primary generation-speed metric used by the existing winner
policies. It includes reasoning tokens when the model generates reasoning.

### `tpot_ms`

Average time per output token after the first token:

```text
tpot_ms =
  (last predicted_ms - first-token predicted_ms)
  / (last predicted_n - 1)
```

TPOT avoids mixing first-token startup with steady-state decode.

### `itl_p95_ms`

The 95th percentile of server-side inter-token intervals:

```text
interval = delta predicted_ms / delta predicted_n
itl_p95_ms = p95(intervals)
```

This highlights generation stalls that average `eval_tps` can hide. It is
diagnostic and is not currently part of winner selection.

## Client and delivery metrics

These values use the client clock and include local HTTP/SSE behavior.

### `ttfh_ms`

Time until the HTTP response headers are available:

```text
ttfh_ms = headers received - request start
```

This mainly diagnoses request dispatch and server response setup.

### `stream_open_ms`

Time until the first non-terminal SSE frame:

```text
stream_open_ms = first SSE frame - request start
```

The first frame can contain only `role: assistant` and `content: null`.
Therefore this is not TTFT. Older results store the same concept as `ttfr_ms`.

### `client_ttft_ms`

Time until the client receives the first non-empty reasoning or answer delta:

```text
client_ttft_ms =
  min(first reasoning delta, first answer delta) - request start
```

This measures when generated text becomes observable to the client. Older
results store this concept as `e2e_ttft_ms`.

### `e2e_first_reasoning_ms`

Time until the first non-empty `reasoning_content` delta reaches the client.

### `e2e_first_content_ms`

Time until the first non-empty final-answer `content` delta reaches the client.
Despite the historical prefix, this is not complete end-to-end latency: it is
the start of the useful answer.

### `reasoning_delay_ms`

When both phases are present:

```text
reasoning_delay_ms =
  first answer delta - first reasoning delta
```

It shows how long the model reasons before beginning its answer. It does not
measure reasoning quality.

### `e2e_latency_ms`

Full client-observed duration of the measured streaming request:

```text
e2e_latency_ms = stream completed - request start
```

This includes inference, response serialization, SSE framing, buffering, and
delivery on localhost.

### Delivery gaps

For every pair of consecutive non-empty reasoning or answer deltas:

```text
delivery_gap_ms = current arrival - previous arrival
```

calibr reports median, p95, and maximum gaps. These describe how regularly text
arrives at the client. They are not token latency because one delta can contain
zero, one, or multiple token pieces and several SSE events can arrive in one
network read.

## Diagnostic workload sweeps

Baseline configs remain the only winner-eligible results. Prefill and KV-fill
profiles are diagnostic curves attached to the largest valid context config for
the model.

### Prefill workload

calibr builds deterministic text, applies llama-server's chat template, and
uses the same server's `/tokenize` endpoint until the formatted prompt is near
the requested token target. The measured streaming request then processes that
prompt from an empty slot.

```text
workload_target_error_tokens =
  workload_prompt_tokens - prefill_target_tokens
```

`prompt_ms`, `prompt_tps`, memory, utilization, and latency therefore describe
one long-prompt prefill followed by normal generation.

### KV-fill workload

calibr prepares the same token-targeted prefix, submits it to the selected slot
with prompt caching enabled, then sends the measured streaming request with the
same prefix plus a short suffix.

```text
kv_fill_cached_tokens = measured request timings.cache_n
```

This field is the confirmation signal: it reports how much of the prepared
prefix llama-server actually reused. `kv_fill_ms` is the unscored preparation
request; official throughput and latency still come from the following measured
stream.

Targets are bounded by:

```text
target <= context size - context reserve - generated tokens
```

The reserve covers chat-template overhead and the measured suffix.

## Timeline phases

New telemetry points use these phases:

| Phase | Meaning |
|---|---|
| `kv_fill` | Unscored cached-prefix preparation before the measured stream |
| `latency_prompt` | Prompt processing or stream setup before generated text |
| `latency_reasoning` | A non-empty reasoning delta was received |
| `latency_answer` | A non-empty final-answer delta was received |

Legacy results can contain `latency_eval`; the report continues to display
them.

Timeline generation speed is computed from cumulative server timings:

```text
server_tps = delta predicted_n / (delta predicted_ms / 1000)
```

The timeline tooltip can also show the client-side delivery gap for the same
received delta. This makes server stalls distinguishable from batched delivery.

## Memory and utilization

### `vram_baseline_mib`

Dedicated VRAM already used before the benchmark configuration starts.

### `vram_peak_mib`

Peak system dedicated VRAM observed during the run. Under Windows WDDM this is
a system-level reading, not reliable per-process attribution.

### VRAM run

Baseline-adjusted dedicated VRAM:

```text
VRAM run = system VRAM peak - pre-run VRAM baseline
```

### `shared_peak_mib`

Growth in shared GPU memory above its pre-run baseline. calibr treats it as
confirmed spill only after the configured confirmation threshold.

### `ram_used_peak_mib`

Peak reduction in available system RAM:

```text
RAM delta = available RAM baseline - minimum available RAM
```

### CPU/GPU utilization

Arithmetic mean of the hardware samples collected during the run. Power,
temperature, RAM growth, and disk throughput are retained as peaks.

## Aggregation across runs

Typical varying metrics use the median, not the maximum. For three runs:

```text
61, 64, 90 -> 64
```

With an even number of samples calibr uses the lower middle value. This keeps a
single optimistic spike from winning. Risk metrics such as peak power,
temperature, RAM growth, and disk throughput use the maximum.

## Compatibility

Metric schema version 4 makes one full streaming request the common source for
throughput and latency. Version 3 introduced the server/client clock split.
Legacy aliases remain:

| Legacy field | Current meaning |
|---|---|
| `ttfr_ms` | `stream_open_ms` |
| `e2e_ttft_ms` | `client_ttft_ms` |
| `latency_total_request_ms` | `total_request_ms` for v4 runs |
| `rolling_tps` | Legacy SSE event frequency; shown only for old telemetry |

Support for `timings_per_token` and `return_progress` depends on the installed
llama-server build. Missing server fields remain null; calibr does not replace
them with client-clock estimates.

## Sources

- [llama-server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama-server request and timing implementation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp)
- [llama-server Web UI generation statistics](https://github.com/ggml-org/llama.cpp/blob/master/tools/ui/src/lib/components/app/chat/ChatMessages/ChatMessageStatistics/ChatMessageStatistics.svelte)
