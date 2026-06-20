import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  classifyResult,
  getSharedThreshold,
  groupByModel,
  openReport,
  readResults,
  type ModelGroup,
  type Result,
  type ResultStatus,
} from "./engine.js";

interface Props {
  onExit: () => void;
  onRun?: (args: string[], label: string) => void;
}

function fmtTps(n?: number): string {
  if (n === undefined || n === null) return "—";
  return n.toFixed(1).padStart(6);
}

function safetyTag(r: Result, threshold: number): { text: string; color: string; dim?: boolean } {
  const s = classifyResult(r, threshold);
  switch (s) {
    case "safe":   return { text: "safe  ", color: "green" };
    case "wddm":   return { text: "WDDM  ", color: "yellow" };
    case "high":   return { text: "high  ", color: "yellow" };
    case "fail":   return { text: "fail  ", color: "red" };
    case "noload": return { text: "no-load", color: "yellow", dim: true };
    case "na":     return { text: "n/a   ", color: "gray", dim: true };
  }
}

// In the per-model drill view we want successful configs at the top
// (by tps), then no-loads, then real fails, then n/a at the bottom.
const STATUS_ORDER: Record<ResultStatus, number> = {
  safe: 0, wddm: 0, high: 0, fail: 1, noload: 2, na: 3,
};
function sortDrillConfigs(configs: Result[], threshold: number): Result[] {
  return [...configs].sort((a, b) => {
    const sa = STATUS_ORDER[classifyResult(a, threshold)];
    const sb = STATUS_ORDER[classifyResult(b, threshold)];
    if (sa !== sb) return sa - sb;
    return (b.eval_tps ?? -1) - (a.eval_tps ?? -1);
  });
}

function ctxFromArgs(args?: string): string {
  const m = args?.match(/--ctx-size\s+(\d+)/);
  return m ? m[1] : "—";
}

function kvFromArgs(args?: string): string {
  const m = args?.match(/--cache-type-k\s+(\S+)/);
  return m ? m[1] : "—";
}

function workloadFromResult(result: Result): string {
  if (result.workload_kind === "prefill") return `prefill ${result.workload_prompt_tokens ?? result.prefill_target_tokens ?? "?"} tok`;
  if (result.workload_kind === "kv-fill") {
    const cached = result.kv_fill_cached_tokens != null ? ` · ${result.kv_fill_cached_tokens} cached` : "";
    return `KV-fill ${result.workload_prompt_tokens ?? result.kv_fill_target_tokens ?? "?"} tok${cached}`;
  }
  return "baseline";
}

function calibrationFromResult(result: Result): string | null {
  if (result.planning_mode === "adaptive-moe") {
    const verified = result.verified_n_cpu_moe ?? "?";
    const source = result.calibration_cache_hit
      ? `cached${result.calibration_cache_age_hours != null ? ` ${result.calibration_cache_age_hours}h` : ""}`
      : `${result.probe_count ?? "?"} probes`;
    const offset = result.fit_offset == null
      ? ""
      : ` · candidate ${result.fit_offset >= 0 ? "+" : ""}${result.fit_offset}`;
    return `adaptive MoE · minimum n-cpu-moe ${verified} · ${source}${offset}`;
  }
  if (result.planning_mode !== "adaptive-offload") return null;
  const verified = result.verified_fit_layers ?? "?";
  const source = result.calibration_cache_hit
    ? `cached${result.calibration_cache_age_hours != null ? ` ${result.calibration_cache_age_hours}h` : ""}`
    : `${result.probe_count ?? "?"} probes`;
  const offset = result.fit_offset == null
    ? ""
    : ` · candidate ${result.fit_offset >= 0 ? "+" : ""}${result.fit_offset}`;
  return `adaptive offload · verified ${verified} layers · ${source}${offset}`;
}

export function ResultsView({ onExit, onRun }: Props) {
  const threshold = useMemo(() => getSharedThreshold(), []);
  const groups = useMemo<ModelGroup[]>(() => groupByModel(readResults()), []);
  const [cursor, setCursor] = useState(0);
  const [drill, setDrill] = useState<ModelGroup | null>(null);
  const [detailCursor, setDetailCursor] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const tryOpenReport = () => {
    const ok = openReport();
    setNotice(ok ? "opened report.html in your default browser" : "no report yet — run `report` from the main menu");
  };

  useInput((input, key) => {
    if (input === "o") {
      tryOpenReport();
      return;
    }
    if (drill) {
      const ordered = sortDrillConfigs(drill.configs, threshold);
      const selected = ordered[detailCursor];
      if ((input === "r" || input === "R") && selected && onRun) {
        onRun(["bench", "-Id", selected.id, "-Force"], `bench -Id ${selected.id} -Force`);
        return;
      }
      if (key.upArrow || input === "k") setDetailCursor(c => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setDetailCursor(c => Math.min(drill.configs.length - 1, c + 1));
      else if (key.leftArrow || key.escape || input === "h" || input === "q") {
        setDrill(null);
        setDetailCursor(0);
        setNotice(null);
      }
      return;
    }
    if (groups.length === 0) {
      if (key.escape || input === "q" || key.return) onExit();
      return;
    }
    if (key.upArrow || input === "k") setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor(c => Math.min(groups.length - 1, c + 1));
    else if (key.return || key.rightArrow || input === "l") {
      setDrill(groups[cursor]);
      setNotice(null);
    } else if (key.escape || input === "q" || key.leftArrow || input === "h") onExit();
  });

  if (groups.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">no successful results yet. run `bench` first.</Text>
        <Box marginTop={1}><Text dimColor>press any key to go back</Text></Box>
      </Box>
    );
  }

  if (drill) {
    return <DetailView group={drill} cursor={detailCursor} threshold={threshold} notice={notice} canRun={Boolean(onRun)} />;
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">leaderboard ({groups.length} models)</Text>
      <Box marginTop={1}>
        <Text dimColor>
          {"  "}{"model".padEnd(28)} {"variant".padEnd(10)} {"level".padEnd(7)} {"safe".padEnd(6)} {" eval t/s"} {" prompt t/s"} {" ctx".padStart(7)} {" kv"}
        </Text>
      </Box>
      {groups.map((g, i) => {
        const w = g.winner;
        const tag = safetyTag(w, threshold);
        const selected = i === cursor;
        return (
          <Box key={g.model}>
            <Text color={selected ? "cyan" : undefined} inverse={selected}>
              {selected ? "▶ " : "  "}
              {g.model.padEnd(28)} {(w.variant ?? "—").padEnd(10)} {(w.level ?? "custom").padEnd(7)}{" "}
            </Text>
            <Text color={tag.color}>{tag.text}</Text>
            <Text color={selected ? "cyan" : undefined} inverse={selected}>
              {" "}{fmtTps(w.eval_tps)}    {fmtTps(w.prompt_tps)}    {ctxFromArgs(w.extra_args).padStart(6)}  {kvFromArgs(w.extra_args)}
            </Text>
          </Box>
        );
      })}
      {notice && <Box marginTop={1}><Text color="cyan">{notice}</Text></Box>}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · enter to drill · o open report · q/esc back</Text>
      </Box>
    </Box>
  );
}

function DetailView({
  group, cursor, threshold, notice, canRun,
}: {
  group: ModelGroup; cursor: number; threshold: number; notice: string | null; canRun: boolean;
}) {
  const ordered = sortDrillConfigs(group.configs, threshold);
  const sel = ordered[cursor];
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{group.model}</Text>
      <Text dimColor>
        {group.successCount}/{group.totalCount} configs ok · winner: {group.winner.label}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>
            {"  "}{"config".padEnd(50)} {"safe".padEnd(6)} {" eval t/s"} {" prompt t/s"} {" vram".padStart(9)} {" ctx".padStart(7)} {" kv"}
          </Text>
        </Box>
        {ordered.map((c, i) => {
          const tag = safetyTag(c, threshold);
          const selected = i === cursor;
          return (
            <Box key={c.id}>
              <Text color={selected ? "cyan" : undefined} inverse={selected}>
                {selected ? "▶ " : "  "}
                {c.id.padEnd(50)}{" "}
              </Text>
              <Text color={tag.color}>{tag.text}</Text>
              <Text color={selected ? "cyan" : undefined} inverse={selected}>
                {" "}{fmtTps(c.eval_tps)}    {fmtTps(c.prompt_tps)}    {(c.vram_peak_mib ?? 0).toString().padStart(5)}MiB {ctxFromArgs(c.extra_args).padStart(6)}  {kvFromArgs(c.extra_args)}
              </Text>
            </Box>
          );
        })}
      </Box>
      {sel && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>{sel.label}</Text>
          <Text dimColor>workload: {workloadFromResult(sel)}</Text>
          {sel.workload_kind !== "baseline" && (
            <Text dimColor>
              preparation: {sel.workload_prepare_ms ?? "—"} ms · target error: {sel.workload_target_error_tokens ?? "—"} tok
              {sel.kv_fill_ms != null ? ` · KV fill: ${sel.kv_fill_ms} ms` : ""}
            </Text>
          )}
          {calibrationFromResult(sel) && <Text color="magenta">{calibrationFromResult(sel)}</Text>}
          <Text dimColor>{sel.extra_args ?? ""}</Text>
          {sel.error && <Text color="red">error: {sel.error}</Text>}
          {sel.unsupported_architecture && (
            <Text color="gray">
              n/a — llama.cpp build doesn't support architecture: {sel.unsupported_architecture}
            </Text>
          )}
          {!sel.ok && !sel.unsupported_architecture && sel.ready === false && (
            <Text color="yellow">
              no-load — server never answered /v1/models within wait_sec_ready. likely OOM during model load.
            </Text>
          )}
          <Text>
            <Text dimColor>vram peak: </Text>{sel.vram_peak_mib ?? "—"} MiB ·{" "}
            <Text dimColor>shared peak: </Text>{sel.shared_peak_mib ?? "—"} MiB ·{" "}
            <Text dimColor>saturation: </Text>{((sel.wddm_vram_saturation ?? 0) * 100).toFixed(0)}%
          </Text>
        </Box>
      )}
      {notice && <Box marginTop={1}><Text color="cyan">{notice}</Text></Box>}
      {canRun && <Box marginTop={1}><Text color="cyan">r re-run selected config with -Force</Text></Box>}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · o open report · ←/esc/q back to leaderboard</Text>
      </Box>
    </Box>
  );
}
