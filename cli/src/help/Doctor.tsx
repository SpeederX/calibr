import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  runDoctor,
  exportDoctor,
  openUrl,
  DOCTOR_ISSUE_URL,
  type DoctorReport,
  type DoctorDep,
  type DoctorCheck,
} from "../engine.js";

type Mode =
  | { kind: "menu" }
  | { kind: "loading"; label: string }
  | { kind: "report"; report: DoctorReport }
  | { kind: "exported"; path: string }
  | { kind: "error"; message: string };

const CHECK_COLOR: Record<DoctorCheck, string> = {
  ok: "green",
  warning: "yellow",
  fail: "red",
  missing: "red",
  skipped: "gray",
};
const CHECK_TAG: Record<DoctorCheck, string> = {
  ok: " OK ",
  warning: "WARN",
  fail: "FAIL",
  missing: "MISS",
  skipped: "SKIP",
};

const OVERALL_COLOR: Record<DoctorReport["overallStatus"], string> = {
  ok: "green",
  degraded: "yellow",
  "unable-to-start": "red",
};

const ACTIONS = [
  { id: "run", label: "run check", description: "system + dependency sanity check" },
  { id: "run-extended", label: "run check (extended)", description: "same, with full uncapped command logs" },
  { id: "export", label: "export sanity check", description: "write a redacted bundle to attach to an issue" },
];

function MenuMode({ cursor }: { cursor: number }) {
  return (
    <Box flexDirection="column">
      <Text bold>doctor — system sanity check</Text>
      <Box marginTop={1} flexDirection="column">
        {ACTIONS.map((a, i) => {
          const sel = i === cursor;
          return (
            <Box key={a.id}>
              <Text color={sel ? "cyan" : undefined} inverse={sel}>
                {sel ? "> " : "  "}
                {a.label.padEnd(22)}
              </Text>
              <Text dimColor>  {a.description}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>up/down to move | enter to run | q/esc back</Text>
      </Box>
    </Box>
  );
}

function SystemHeader({ report }: { report: DoctorReport }) {
  const si = report.systemInfo;
  const gpu = si.gpus[0];
  const gpuMemory = gpu
    ? gpu.memoryUnified
      ? `${gpu.unifiedMemoryTotalMib ?? gpu.vramTotalMib ?? "?"} MiB unified`
      : `${gpu.vramTotalMib ?? "?"} MiB VRAM`
    : "";
  const gpuApi = gpu
    ? gpu.metalSupported !== undefined && gpu.metalSupported !== null
      ? `metal: ${gpu.metalSupported ? "yes" : "no"}`
      : `vk: ${gpu.vulkanDevice ?? "n/a"}`
    : "";
  const gpuBackend = gpu?.backendHint ? `, backend: ${gpu.backendHint}` : "";
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>OS  </Text> {si.os.name} {si.os.kernel ? `(${si.os.kernel})` : ""}
      </Text>
      <Text>
        <Text dimColor>CPU </Text> {si.cpu.model ?? "?"} [{si.cpu.arch}, {si.cpu.coresPhysical ?? "?"}c/{si.cpu.threadsLogical ?? "?"}t]
      </Text>
      <Text>
        <Text dimColor>RAM </Text> {si.ram.totalMib ?? "?"} MiB total, {si.ram.availableMib ?? "?"} MiB free
      </Text>
      <Text>
        <Text dimColor>GPU </Text>{" "}
        {gpu ? `${gpu.name} (${gpuMemory}, ${gpu.kernelDriver ?? "?"}, ${gpuApi}${gpuBackend})` : "none detected"}
      </Text>
    </Box>
  );
}

function ReportMode({ report, cursor }: { report: DoctorReport; cursor: number }) {
  const dep: DoctorDep | undefined = report.deps[cursor];
  const inf = report.inference;
  const problemNoFix =
    dep && (dep.check === "fail" || dep.check === "missing") && !dep.remediation;

  return (
    <Box flexDirection="column">
      <SystemHeader report={report} />
      <Box marginTop={1}>
        <Text>
          status: <Text color={OVERALL_COLOR[report.overallStatus]} bold>{report.overallStatus}</Text>
          {"  "}
          <Text dimColor>
            · inference: {inf.gpuOffloadPossible ? "GPU offload possible" : "GPU offload NOT available"} → {inf.recommendedBackend}
          </Text>
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {report.deps.map((d, i) => {
          const sel = i === cursor;
          return (
            <Box key={d.name}>
              <Text color={sel ? "cyan" : undefined} inverse={sel}>{sel ? ">" : " "}</Text>
              <Text color={CHECK_COLOR[d.check]} bold> [{CHECK_TAG[d.check]}] </Text>
              <Text color={sel ? "cyan" : undefined}>{d.name.padEnd(22)}</Text>
              <Text dimColor>{(d.detail ?? "").slice(0, 48)}</Text>
            </Box>
          );
        })}
      </Box>

      {dep && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text>
            <Text bold>{dep.name}</Text>
            <Text dimColor> · {dep.kind}{dep.version ? ` · ${dep.version}` : ""}{dep.required ? " · required" : ""}</Text>
          </Text>
          {dep.detail && <Text>{dep.detail}</Text>}
          {dep.remediation && (
            <Text>
              <Text color="cyan">fix: </Text>
              {dep.remediation}
            </Text>
          )}
          {problemNoFix && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow">No known fix for this one.</Text>
              <Text dimColor>Press e to export the extended bundle, then g to open a GitHub issue and attach it.</Text>
            </Box>
          )}
          {dep.command && <Text dimColor>cmd: {dep.command}</Text>}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>up/down move | e export bundle | g open issue | r re-run | q/esc back</Text>
      </Box>
    </Box>
  );
}

export function Doctor({
  onExit,
  runner = runDoctor,
  exporter = exportDoctor,
}: {
  onExit: () => void;
  // Injectable so the view can be unit-tested without spawning the engine.
  runner?: typeof runDoctor;
  exporter?: typeof exportDoctor;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const [menuCursor, setMenuCursor] = useState(0);
  const [rowCursor, setRowCursor] = useState(0);

  const doRun = (extended: boolean) => {
    setMode({ kind: "loading", label: extended ? "running extended check…" : "running check…" });
    runner(extended).then((res) => {
      if (res.report) {
        setRowCursor(0);
        setMode({ kind: "report", report: res.report });
      } else {
        setMode({ kind: "error", message: res.error ?? "unknown error" });
      }
    });
  };

  const doExport = () => {
    setMode({ kind: "loading", label: "exporting bundle…" });
    exporter(true).then((res) => {
      if (res.path) setMode({ kind: "exported", path: res.path });
      else setMode({ kind: "error", message: res.error ?? "export failed" });
    });
  };

  useInput((input, key) => {
    if (mode.kind === "loading") return;

    if (mode.kind === "menu") {
      if (input === "q" || key.escape) { onExit(); return; }
      if (key.upArrow) { setMenuCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setMenuCursor((c) => Math.min(ACTIONS.length - 1, c + 1)); return; }
      if (key.return || input === " ") {
        const a = ACTIONS[menuCursor];
        if (a?.id === "run") doRun(false);
        else if (a?.id === "run-extended") doRun(true);
        else if (a?.id === "export") doExport();
      }
      return;
    }

    if (mode.kind === "report") {
      if (input === "q" || key.escape) { setMode({ kind: "menu" }); return; }
      if (key.upArrow) { setRowCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setRowCursor((c) => Math.min(mode.report.deps.length - 1, c + 1)); return; }
      if (input === "e") { doExport(); return; }
      if (input === "g") { openUrl(DOCTOR_ISSUE_URL); return; }
      if (input === "r") { doRun(mode.report.extended); return; }
      return;
    }

    if (mode.kind === "exported" || mode.kind === "error") {
      if (input === "g") { openUrl(DOCTOR_ISSUE_URL); return; }
      if (input === "q" || key.escape || key.return) { setMode({ kind: "menu" }); return; }
      return;
    }
  });

  if (mode.kind === "loading") {
    return <Text><Text color="cyan">●</Text> {mode.label}</Text>;
  }
  if (mode.kind === "menu") {
    return <MenuMode cursor={menuCursor} />;
  }
  if (mode.kind === "report") {
    return <ReportMode report={mode.report} cursor={rowCursor} />;
  }
  if (mode.kind === "exported") {
    return (
      <Box flexDirection="column">
        <Text color="green">Bundle written (home dir + hostname redacted):</Text>
        <Text>{mode.path}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Attach this file to a GitHub issue describing what failed.</Text>
          <Text dimColor>g open the issue page | enter/q back</Text>
        </Box>
      </Box>
    );
  }
  // error
  return (
    <Box flexDirection="column">
      <Text color="red">doctor failed:</Text>
      <Text>{mode.message}</Text>
      <Box marginTop={1}><Text dimColor>enter/q back</Text></Box>
    </Box>
  );
}
