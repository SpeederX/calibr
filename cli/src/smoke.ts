import { classifyResult, getSharedThreshold, groupByModel, readResults } from "./engine.js";

const all = readResults();
const threshold = getSharedThreshold();
const tally: Record<string, number> = {};
for (const r of all) {
  const s = classifyResult(r, threshold);
  tally[s] = (tally[s] ?? 0) + 1;
}
console.log(`${all.length} results · threshold=${threshold} MiB · tally:`, tally);

const groups = groupByModel(all);
console.log(`\nleaderboard (${groups.length} models with ≥1 ok):\n`);
for (const g of groups) {
  const w = g.winner;
  const s = classifyResult(w, threshold);
  console.log(
    `  ${g.model.padEnd(28)} ${w.variant.padEnd(10)} ${w.tier} [${s.padEnd(4)}] ` +
    `eval=${(w.eval_tps ?? 0).toFixed(1).padStart(6)}t/s ` +
    `shared=${(w.shared_peak_mib ?? 0).toString().padStart(4)}MiB`
  );
}

console.log("\nfailures broken down by model:\n");
const failByModel: Record<string, Record<string, number>> = {};
for (const r of all) {
  const s = classifyResult(r, threshold);
  if (s === "safe" || s === "wddm" || s === "high") continue;
  const m = r.model ?? r.id;
  failByModel[m] = failByModel[m] ?? {};
  failByModel[m][s] = (failByModel[m][s] ?? 0) + 1;
}
for (const [m, breakdown] of Object.entries(failByModel)) {
  console.log("  " + m.padEnd(28), breakdown);
}
