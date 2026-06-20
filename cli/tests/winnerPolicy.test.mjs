import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groupWinners,
  isBetterWinner,
  isSafe,
  winnerScore,
} from "../dist/winnerPolicy.js";

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
