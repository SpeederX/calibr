import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTokenTargetPrompt,
  prepareWorkloadPrompt,
} from "../dist/engine/bench/workloadPrompt.js";

function tokenizerMock() {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/apply-template")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ prompt: `<user>${body.messages[0].content}</user><assistant>` }),
      };
    }
    if (url.endsWith("/tokenize")) {
      const tokens = String(body.content).trim().split(/\s+/).filter(Boolean);
      return {
        ok: true,
        status: 200,
        json: async () => ({ tokens: tokens.map((_, index) => index + 1) }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test("buildTokenTargetPrompt uses llama-server template/tokenizer and converges near target", async () => {
  const target = 512;
  const built = await buildTokenTargetPrompt("http://127.0.0.1:18080", target, tokenizerMock());
  assert.ok(built.content.includes("calibr deterministic workload"));
  assert.ok(Math.abs(built.actualTokens - target) <= 12);
});

test("prepareWorkloadPrompt preserves the fill prefix for the measured KV request", async () => {
  const prepared = await prepareWorkloadPrompt({
    baseUrl: "http://127.0.0.1:18080",
    basePrompt: "unused",
    kind: "kv-fill",
    kvFillTargetTokens: 256,
    fetchImpl: tokenizerMock(),
  });
  assert.equal(prepared.kind, "kv-fill");
  assert.ok(prepared.fillPrompt);
  assert.ok(prepared.measuredPrompt.startsWith(prepared.fillPrompt));
  assert.ok(prepared.measuredPrompt.length > prepared.fillPrompt.length);
});
