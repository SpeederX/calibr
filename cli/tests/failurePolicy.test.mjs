import test from "node:test";
import assert from "node:assert/strict";
import { classifyRuntimeFailure } from "../dist/failurePolicy.js";

test("classifies quantized V / Flash Attention incompatibility as profile abandonment", () => {
  const failure = classifyRuntimeFailure({
    ok: false,
    ready: false,
    stderr: "quantized V cache was requested, but this requires Flash Attention",
  });
  assert.equal(failure?.cause, "incompatible_cache_profile");
  assert.equal(failure?.action, "abandon_profile");
  assert.equal(failure?.retryable, false);
});

test("retries transport failures and skips after the third attempt", () => {
  const first = classifyRuntimeFailure({
    ok: false,
    ready: true,
    error: "fetch failed",
    attempt: 1,
    maxAttempts: 3,
  });
  const third = classifyRuntimeFailure({
    ok: false,
    ready: true,
    error: "fetch failed",
    attempt: 3,
    maxAttempts: 3,
  });
  assert.equal(first?.cause, "transport_error");
  assert.equal(first?.action, "retry_same_config");
  assert.equal(third?.action, "skip_config_continue");
  assert.equal(third?.retry_exhausted, true);
});

test("retries a diagnostic timeout, then prunes larger targets after exhaustion", () => {
  const first = classifyRuntimeFailure({
    ok: false,
    ready: true,
    error: "This operation was aborted",
    workloadKind: "kv-fill",
    attempt: 1,
    maxAttempts: 3,
  });
  const third = classifyRuntimeFailure({
    ok: false,
    ready: true,
    error: "This operation was aborted",
    workloadKind: "kv-fill",
    attempt: 3,
    maxAttempts: 3,
  });
  assert.equal(first?.cause, "request_timeout");
  assert.equal(first?.action, "retry_same_config");
  assert.equal(third?.action, "skip_larger_targets");
  assert.equal(third?.retry_exhausted, true);
});

test("does not infer OOM from shared allocation alone", () => {
  const failure = classifyRuntimeFailure({
    ok: false,
    ready: true,
    error: "invalid completion",
    fitStatus: "unknown",
  });
  assert.equal(failure?.cause, "invalid_completion");
});

test("aborts on persistence failures", () => {
  const failure = classifyRuntimeFailure({
    ok: false,
    error: "ENOSPC: no space left on device while writing result",
  });
  assert.equal(failure?.cause, "persistence_error");
  assert.equal(failure?.action, "abort_benchmark");
});
