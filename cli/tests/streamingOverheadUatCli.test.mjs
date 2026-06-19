import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBalancedOrder,
  runStreamingOverheadUat,
  summarizeStreamingOverhead,
} from "../dist/streamingOverheadUatCli.js";

const emptyMemory = {
  gpu_mem_baseline_mib: null,
  gpu_mem_peak_mib: null,
  process_vram_peak_mib: null,
  ram_growth_peak_mib: null,
};

function row(mode, predictedMs, tps) {
  return {
    config: "test", mode, repetition: 1, order: 1, ok: true, status: 200,
    prompt_n: 300, prompt_ms: 100, predicted_n: 256, predicted_ms: predictedMs,
    server_eval_tps: tps, client_first_to_last_ms: null, client_eval_tps: null,
    cache_n: 0, exact_token_count: true, cache_empty: true,
    total_request_ms: predictedMs + 100, memory: emptyMemory,
  };
}

test("buildBalancedOrder balances A/B/C with a mirrored block", () => {
  assert.deepEqual(buildBalancedOrder(2), [
    "nonstream", "stream_drain", "stream_production",
    "stream_production", "stream_drain", "nonstream",
  ]);
  assert.deepEqual(buildBalancedOrder(1), [
    "nonstream", "stream_drain", "stream_production",
  ]);
});

test("summarizeStreamingOverhead separates stream and production callback costs", () => {
  const summary = summarizeStreamingOverhead([
    row("nonstream", 2500, 102.4),
    row("stream_drain", 2628, 97.412),
    row("stream_production", 2756, 92.888),
  ], 256);
  assert.equal(summary.drain_vs_nonstream_overhead_ms_per_token, 0.5);
  assert.equal(summary.production_vs_drain_overhead_ms_per_token, 0.5);
  assert.equal(summary.interpretation, "insufficient-data");
});

test("runStreamingOverheadUat resets cache and applies identical deterministic work", async () => {
  const resets = [];
  const requests = [];
  let nonstreamCalls = 0;
  let streamCalls = 0;
  const timings = {
    prompt_n: 300, prompt_ms: 100, predicted_n: 256, predicted_ms: 2560,
    predicted_per_second: 100, cache_n: 0,
  };
  const output = await runStreamingOverheadUat({
    baseUrl: "http://127.0.0.1:18080",
    config: "unit",
    prompt: "fixed prompt",
    repetitions: 2,
    cooldownMs: 0,
  }, {
    resetSlot: async (baseUrl, slotId) => { resets.push([baseUrl, slotId]); },
    runNonstream: async (request) => {
      requests.push(request);
      nonstreamCalls++;
      return {
        ok: true, status: 200, total_request_ms: 2660, body: {}, timings,
        metrics: { prompt_n: 300, prompt_tps: 3000, prompt_ms: 100, eval_n: 256, eval_tps: 100 },
      };
    },
    runStream: async (request, onEvent) => {
      requests.push(request);
      streamCalls++;
      onEvent({ at_ms: 100, index: 0, kind: "answer", text: "a", timings });
      onEvent({ at_ms: 2640, index: 1, kind: "answer", text: "b", timings });
      return {
        ok: true, status: 200, total_request_ms: 2660, content: "ab",
        latency: {
          ttfh_ms: 1, stream_open_ms: 2, ttfr_ms: 2, client_ttft_ms: 100, e2e_ttft_ms: 100,
          e2e_first_reasoning_ms: null, e2e_first_content_ms: 100, reasoning_delay_ms: null,
          e2e_latency_ms: 2660, server_prefill_ms: 100, server_ttft_ms: 110, tpot_ms: 10,
          itl_p95_ms: 10, delivery_gap_median_ms: 10, delivery_gap_p95_ms: 10,
          delivery_gap_max_ms: 10, response_chunk_count: 2, content_chunk_count: 2, timings,
        },
        metrics: { prompt_n: 300, prompt_tps: 3000, prompt_ms: 100, eval_n: 256, eval_tps: 100 },
      };
    },
  });

  assert.equal(nonstreamCalls, 3);
  assert.equal(streamCalls, 4);
  assert.equal(resets.length, 7);
  assert.deepEqual(output.order, [
    "nonstream", "stream_drain", "stream_production",
    "stream_production", "stream_drain", "nonstream",
  ]);
  assert.equal(output.runs.length, 6);
  assert.ok(output.runs.every(run => run.exact_token_count && run.cache_empty));
  assert.ok(requests.every(request =>
    request.ignore_eos === true && request.seed === 42 && request.temperature === 0 &&
    request.cache_prompt === false && request.id_slot === 0
  ));
  assert.ok(requests.filter(request => request.stream).every(request => request.timings_per_token === true));
});
