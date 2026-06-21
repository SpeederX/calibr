import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compatibleCacheType,
  parseLlamaHelp,
  supportsOption,
  validateLlamaArgs,
} from "../dist/llamaCompatibility.js";

const help = `
-c, --ctx-size N                     context
-ngl, --gpu-layers N                 layers
-ncmoe, --n-cpu-moe N               CPU experts
-ctk, --cache-type-k TYPE            KV cache data type for K
                                      allowed values: f16, q8_0, q4_0, q5_1
-ctv, --cache-type-v TYPE            KV cache data type for V
                                      allowed values: f16, q8_0, q4_0
--fit [on|off]                       fit
`;

test("parseLlamaHelp extracts aliases and cache value domains", () => {
  const caps = parseLlamaHelp(help, "llama-server");
  assert.equal(caps.ok, true);
  assert.equal(supportsOption(caps, "--n-cpu-moe"), true);
  assert.deepEqual(caps.cacheTypesK, ["f16", "q8_0", "q4_0", "q5_1"]);
  assert.deepEqual(caps.cacheTypesV, ["f16", "q8_0", "q4_0"]);
});

test("compatibleCacheType preserves a supported type and otherwise selects a quality fallback", () => {
  assert.equal(compatibleCacheType("q5_1", ["f16", "q8_0", "q5_1"]), "q5_1");
  assert.equal(compatibleCacheType("q6_0", ["f16", "q8_0", "q4_0"]), "q8_0");
});

test("validateLlamaArgs reports unsupported flags and cache values before launch", () => {
  const caps = parseLlamaHelp(help);
  assert.deepEqual(validateLlamaArgs([
    "--ctx-size", "16384",
    "--cache-type-k", "q6_0",
    "--slot-save-path", "slots",
  ], caps), [
    "unsupported K cache type q6_0",
    "unsupported option --slot-save-path",
  ]);
});
