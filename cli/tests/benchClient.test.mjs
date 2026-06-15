import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeChatCompletionStream,
  buildChatCompletionRequest,
  metricsFromLlamaTimings,
  parseSseDataLines,
} from "../dist/benchClient.js";

test("buildChatCompletionRequest mirrors the llama.cpp chat endpoint shape", () => {
  assert.deepEqual(buildChatCompletionRequest({
    prompt: "hello",
    maxTokens: 32,
    stream: true,
    cachePrompt: false,
    reasoningMode: "off",
  }), {
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32,
    temperature: 0,
    stream: true,
    cache_prompt: false,
    enable_thinking: false,
  });
});

test("metricsFromLlamaTimings rounds prompt/eval metrics and guards sentinel eval speeds", () => {
  assert.deepEqual(metricsFromLlamaTimings({
    prompt_n: 128,
    prompt_per_second: 1234.567,
    prompt_ms: 98.765,
    predicted_n: 64,
    predicted_per_second: 42.4242,
    predicted_ms: 1508,
  }), {
    prompt_n: 128,
    prompt_tps: 1234.57,
    prompt_ms: 98.77,
    eval_n: 64,
    eval_tps: 42.42,
  });

  assert.equal(metricsFromLlamaTimings({
    predicted_n: 1,
    predicted_per_second: 1000000,
    predicted_ms: 0,
  }).eval_tps, null);
});

test("parseSseDataLines extracts JSON data events and DONE markers", () => {
  const events = parseSseDataLines([
    "event: ignored",
    "data: {\"a\":1}",
    "",
    "data: [DONE]",
  ].join("\n"));

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: "json", value: { a: 1 } });
  assert.deepEqual(events[1], { kind: "done" });
});

test("analyzeChatCompletionStream measures first response and first content separately", () => {
  const chunks = [
    { atMs: 110, text: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' },
    { atMs: 145, text: 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' },
    {
      atMs: 210,
      text: 'data: {"choices":[{"delta":{"content":" world"}}],"timings":{"prompt_ms":33,"predicted_n":12,"predicted_ms":500,"predicted_per_second":24}}\n\n',
    },
    { atMs: 215, text: "data: [DONE]\n\n" },
  ];

  const metrics = analyzeChatCompletionStream(chunks, 100);
  assert.equal(metrics.ttfr_ms, 10);
  assert.equal(metrics.e2e_ttft_ms, 45);
  assert.equal(metrics.response_chunk_count, 3);
  assert.equal(metrics.content_chunk_count, 2);
  assert.deepEqual(metrics.timings, {
    prompt_ms: 33,
    predicted_n: 12,
    predicted_ms: 500,
    predicted_per_second: 24,
  });
});
