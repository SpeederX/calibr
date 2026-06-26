import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groupWinners,
  isBetterWinner,
  isSafe,
  winnerScore,
  kvQualityValue,
} from "../dist/engine/results/winnerPolicy.js";

test("KV quality ranks mixed q8/q5 above the q4 rescue profile", () => {
  const standard = kvQualityValue({ extra_args: "--cache-type-k q8_0 --cache-type-v q8_0" });
  const compromise = kvQualityValue({ extra_args: "--cache-type-k q8_0 --cache-type-v q5_1" });
  const rescue = kvQualityValue({ extra_args: "--cache-type-k q4_0 --cache-type-v q4_0" });
  assert.ok(standard > compromise);
  assert.ok(compromise > rescue);
});

test("vanilla controls never participate in winner selection", () => {
  const winner = groupWinners([
    { model: "m", id: "vanilla", ok: true, eval_tps: 100, control_kind: "vanilla" },
    { model: "m", id: "tuned", ok: true, eval_tps: 80 },
  ], "speed").m;
  assert.equal(winner.id, "tuned");
});

const fixturePath = join(process.cwd(), "..", "tests", "fixtures", "winner-policy-cases.json");
const CASES = JSON.parse(readFileSync(fixturePath, "utf8"));

function pick(candidates, profile) {
  const withModel = candidates.map((c) => ({ ...c, model: "fixture", ok: true }));
  return groupWinners(withModel, profile, { confirmMib: 500 }).fixture;
}

for (const c of CASES) {
  test(`winner policy: ${c.name}`, () => {
    assert.equal(pick(c.candidates, c.profile).id, c.expected);
  });
}

test("isSafe uses the shared-memory confirmation threshold", () => {
  assert.equal(isSafe({ shared_peak_mib: 500 }, 500), true);
  assert.equal(isSafe({ shared_peak_mib: 501 }, 500), false);
});

test("isSafe does not treat inferred MoE shared allocation as confirmed spill", () => {
  assert.equal(isSafe({
    sweep: "moe-cpu",
    shared_peak_mib: 10_000,
    fit_status: "failed_but_running",
    fit_status_source: "inferred",
  }, 500), true);
  assert.equal(isSafe({
    sweep: "moe-cpu",
    shared_peak_mib: 10_000,
    fit_status: "failed_but_running",
    fit_status_source: "llama.cpp",
  }, 500), false);
});

test("winnerScore disqualifies efficiency when power is unavailable", () => {
  assert.equal(winnerScore({ eval_tps: 100, gpu_power_peak_w: 0 }, "efficiency"), -Infinity);
});

test("isBetterWinner accepts the first candidate", () => {
  assert.equal(isBetterWinner({ id: "a", eval_tps: 1 }, null, "speed"), true);
});

test("diagnostic workloads never replace a baseline winner", () => {
  const winners = groupWinners([
    { id: "baseline", model: "m", ok: true, eval_tps: 50, workload_kind: "baseline" },
    { id: "prefill", model: "m", ok: true, eval_tps: 500, workload_kind: "prefill" },
    { id: "kv", model: "m", ok: true, eval_tps: 600, workload_kind: "kv-fill" },
  ], "speed");
  assert.equal(winners.m.id, "baseline");
});
