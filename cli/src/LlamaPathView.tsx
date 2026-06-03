import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { basename, dirname } from "node:path";
import {
  loadConfig,
  pickFileSync,
  updateLocalConfigField,
  CALIBR_LOCAL_CFG,
} from "./engine.js";

interface Props {
  onCancel: () => void;
}

type Phase =
  | { kind: "form" }
  | { kind: "confirm"; newPath: string }
  | { kind: "saved"; newPath: string };

/**
 * Form to update config.json's `llama_server_exe` without rewriting the
 * rest of the config (which `init -Force` would do). Two options today:
 * browse for a new path via a native Windows file dialog, or cancel. The
 * picked path is shown on a confirm screen so the user can back out if
 * they grabbed the wrong file.
 *
 * For exotic cases (path to a file that doesn't exist yet, scripted
 * setups), editing `config.json` by hand still works — the field is
 * just `"llama_server_exe": "..."`.
 */
export function LlamaPathView({ onCancel }: Props) {
  const currentPath = useMemo<string | null>(() => {
    const cfg = loadConfig();
    return cfg.llama_server_exe || null;
  }, []);

  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [cursor, setCursor] = useState(0);

  const rows = [
    { kind: "browse" as const, label: "> browse for llama-server.exe..." },
    { kind: "cancel" as const, label: "  cancel" },
  ];

  const launchPicker = () => {
    // Initial dir = the folder of the currently configured exe, when set,
    // so the dialog opens near where the user last looked.
    const initialDir = currentPath ? dirname(currentPath) : undefined;
    const picked = pickFileSync({
      title: "Select llama-server.exe",
      filter: "llama-server (llama-server.exe)|llama-server.exe|Executables (*.exe)|*.exe|All files (*.*)|*.*",
      initialDir,
    });
    if (picked) {
      setPhase({ kind: "confirm", newPath: picked });
    }
    // If picked is null, the user cancelled the dialog — stay on the form.
  };

  const saveAndExit = (path: string) => {
    updateLocalConfigField("llama_server_exe", path);
    setPhase({ kind: "saved", newPath: path });
  };

  useInput((input, key) => {
    if (phase.kind === "confirm") {
      if (input === "y" || input === "Y" || key.return) { saveAndExit(phase.newPath); return; }
      if (input === "n" || input === "N" || input === "q" || key.escape) { setPhase({ kind: "form" }); return; }
      return;
    }
    if (phase.kind === "saved") {
      // Any key returns to the menu; the parent will refresh status from the
      // freshly-written config.json on its next render.
      onCancel();
      return;
    }
    // form
    if (key.upArrow)   { setCursor(c => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor(c => Math.min(rows.length - 1, c + 1)); return; }
    if (key.escape || input === "q") { onCancel(); return; }
    if (key.return || input === " ") {
      const row = rows[cursor];
      if (row.kind === "browse") launchPicker();
      else onCancel();
    }
  });

  if (phase.kind === "saved") {
    return (
      <Box flexDirection="column">
        <Text bold color="green">llama-server path updated.</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>new: <Text color="cyan">{phase.newPath}</Text></Text>
          <Text dimColor>written to {CALIBR_LOCAL_CFG}</Text>
        </Box>
        <Box marginTop={1}><Text dimColor>press any key to return to the menu</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "confirm") {
    const sameAsBefore = currentPath === phase.newPath;
    const wrongName = basename(phase.newPath).toLowerCase() !== "llama-server.exe";
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">confirm llama-server path</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>old: <Text dimColor>{currentPath || "(not set)"}</Text></Text>
          <Text>new: <Text color="cyan">{phase.newPath}</Text></Text>
        </Box>
        {sameAsBefore && (
          <Box marginTop={1}>
            <Text color="yellow">note: same as the current path. saving will be a no-op.</Text>
          </Box>
        )}
        {wrongName && (
          <Box marginTop={1}>
            <Text color="yellow">note: filename is "{basename(phase.newPath)}", not "llama-server.exe". bench will fail if this is not actually llama.cpp's server.</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>save? <Text color="cyan">[y/n]</Text></Text>
        </Box>
        <Box marginTop={1}><Text dimColor>y / enter = save · n / esc = back to picker</Text></Box>
      </Box>
    );
  }

  // form
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">change llama-server path</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>current: <Text color={currentPath ? "cyan" : "yellow"}>{currentPath || "(not set)"}</Text></Text>
        <Text dimColor>config: {CALIBR_LOCAL_CFG}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => {
          const selected = i === cursor;
          return (
            <Text key={row.kind} color={selected ? "cyan" : undefined} inverse={selected}>
              {selected ? "> " : "  "}{row.label}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑/↓ move · enter activates · q/esc back</Text>
        <Text dimColor>tip: 'init -Force' re-scans PATH automatically; this screen lets you point at a specific build.</Text>
      </Box>
    </Box>
  );
}
