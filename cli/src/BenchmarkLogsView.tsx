import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  listBenchmarkLogs,
  openBenchmarkLog,
  openBenchmarkLogsFolder,
  readBenchmarkLogTail,
  readResults,
  type BenchmarkLog,
} from "./engine.js";

interface Props {
  onExit: () => void;
  logs?: BenchmarkLog[];
  opener?: (path: string) => boolean;
  folderOpener?: () => boolean;
  tailReader?: (path: string, maxLines?: number) => string[];
  resultLabels?: Map<string, string>;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export function BenchmarkLogsView({
  onExit,
  logs,
  opener = openBenchmarkLog,
  folderOpener = openBenchmarkLogsFolder,
  tailReader = readBenchmarkLogTail,
  resultLabels: injectedResultLabels,
}: Props) {
  const entries = useMemo(() => logs ?? listBenchmarkLogs(), [logs]);
  const resultLabels = useMemo(
    () => injectedResultLabels ?? new Map(readResults().map((result) => [result.id, result.label])),
    [injectedResultLabels],
  );
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<BenchmarkLog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useInput((input, key) => {
    if (input === "f") {
      setNotice(folderOpener() ? "opened benchmark logs folder" : "could not open benchmark logs folder");
      return;
    }
    if (selected) {
      if (input === "o") {
        setNotice(opener(selected.path) ? "opened log in the default application" : "could not open log");
      } else if (key.escape || key.leftArrow || input === "h" || input === "q") {
        setSelected(null);
        setNotice(null);
      }
      return;
    }
    if (entries.length === 0) {
      if (key.escape || key.return || input === "q") onExit();
      return;
    }
    if (key.upArrow || input === "k") setCursor((value) => Math.max(0, value - 1));
    else if (key.downArrow || input === "j") setCursor((value) => Math.min(entries.length - 1, value + 1));
    else if (key.return || key.rightArrow || input === "l") {
      setSelected(entries[cursor]);
      setNotice(null);
    } else if (key.escape || key.leftArrow || input === "h" || input === "q") onExit();
  });

  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">no benchmark run logs found.</Text>
        <Text dimColor>f open logs folder · enter/q/esc back</Text>
      </Box>
    );
  }

  if (selected) {
    const preview = tailReader(selected.path, 32);
    const label = selected.configId ? resultLabels.get(selected.configId) : null;
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{selected.name}</Text>
        {label && <Text>{label}</Text>}
        <Text dimColor>
          {selected.kind} · {selected.runCount || "?"} run{selected.runCount === 1 ? "" : "s"} · {sizeLabel(selected.sizeBytes)} · {shortDate(selected.modifiedAt)}
        </Text>
        <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
          {preview.length > 0
            ? preview.map((line, index) => <Text key={`${index}-${line}`} wrap="truncate">{line}</Text>)
            : <Text dimColor>log is empty</Text>}
        </Box>
        {notice && <Box marginTop={1}><Text color="cyan">{notice}</Text></Box>}
        <Box marginTop={1}>
          <Text dimColor>o open full log · f open folder · left/esc/q back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">benchmark run logs ({entries.length})</Text>
      <Text dimColor>Newest first. Config logs retain command lines and llama-server stderr for each repetition.</Text>
      <Box marginTop={1} flexDirection="column">
        {entries.slice(Math.max(0, cursor - 10), Math.max(0, cursor - 10) + 22).map((entry) => {
          const index = entries.indexOf(entry);
          const active = index === cursor;
          const display = entry.configId ? (resultLabels.get(entry.configId) ?? entry.configId) : entry.name;
          return (
            <Box key={entry.path}>
              <Text color={active ? "cyan" : undefined} inverse={active}>
                {active ? "> " : "  "}{display.slice(0, 70).padEnd(70)}
              </Text>
              <Text dimColor> {String(entry.runCount || "-").padStart(2)} run · {sizeLabel(entry.sizeBytes).padStart(9)}</Text>
            </Box>
          );
        })}
      </Box>
      {notice && <Box marginTop={1}><Text color="cyan">{notice}</Text></Box>}
      <Box marginTop={1}>
        <Text dimColor>up/down move · enter preview · f open folder · q/esc back</Text>
      </Box>
    </Box>
  );
}
