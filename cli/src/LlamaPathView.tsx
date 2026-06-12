import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { basename, dirname } from "node:path";
import {
  deleteCachedLlamaBuild,
  listCachedLlamaBuilds,
  loadConfig,
  pickFileSync,
  updateLocalConfigField,
  CALIBR_LOCAL_CFG,
  type CachedLlamaBuild,
} from "./engine.js";

interface Props {
  onCancel: () => void;
}

type Phase =
  | { kind: "form" }
  | { kind: "manual"; value: string }
  | { kind: "cachedPick"; action: "use" | "delete"; cursor: number }
  | { kind: "confirm"; newPath: string }
  | { kind: "deleted"; build: CachedLlamaBuild }
  | { kind: "saved"; newPath: string };

/**
 * Form to update config.json's `llama_server_exe` without rewriting the
 * rest of the config (which `init -Force` would do). Windows gets a native
 * file dialog; POSIX terminals get a typed path prompt. The picked path is
 * shown on a confirm screen so the user can back out if they grabbed the
 * wrong file.
 *
 * For exotic cases (path to a file that doesn't exist yet, scripted
 * setups), editing `config.json` by hand still works — the field is
 * just `"llama_server_exe": "..."`.
 */
export function LlamaPathView({ onCancel }: Props) {
  const isWindows = process.platform === "win32";
  const expectedBinaryName = isWindows ? "llama-server.exe" : "llama-server";
  const currentPath = useMemo<string | null>(() => {
    const cfg = loadConfig();
    return cfg.llama_server_exe || null;
  }, []);
  const cachedBuilds = useMemo(() => listCachedLlamaBuilds(), []);

  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [cursor, setCursor] = useState(0);

  const rows = [
    { kind: "path" as const, label: isWindows ? `browse for ${expectedBinaryName}...` : `type path to ${expectedBinaryName}...` },
    ...(cachedBuilds.length > 0 ? [
      { kind: "useCached" as const, label: `use cached llama.cpp build... (${cachedBuilds.length})` },
      { kind: "deleteCached" as const, label: "delete cached llama.cpp build..." },
    ] : []),
    { kind: "cancel" as const, label: "  cancel" },
  ];

  const pickPath = () => {
    if (!isWindows) {
      setPhase({ kind: "manual", value: currentPath || "" });
      return;
    }

    // Initial dir = the folder of the currently configured exe, when set,
    // so the dialog opens near where the user last looked.
    const initialDir = currentPath ? dirname(currentPath) : undefined;
    const picked = pickFileSync({
      title: `Select ${expectedBinaryName}`,
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
    if (phase.kind === "cachedPick") {
      if (key.escape || input === "q") { setPhase({ kind: "form" }); return; }
      if (key.upArrow || input === "k") { setPhase({ ...phase, cursor: Math.max(0, phase.cursor - 1) }); return; }
      if (key.downArrow || input === "j") { setPhase({ ...phase, cursor: Math.min(cachedBuilds.length - 1, phase.cursor + 1) }); return; }
      if (key.return || input === " ") {
        const picked = cachedBuilds[phase.cursor];
        if (!picked) return;
        if (phase.action === "use") {
          setPhase({ kind: "confirm", newPath: picked.path });
        } else {
          deleteCachedLlamaBuild(picked);
          setPhase({ kind: "deleted", build: picked });
        }
      }
      return;
    }
    if (phase.kind === "deleted") {
      onCancel();
      return;
    }
    if (phase.kind === "manual") {
      const typedKey = key as typeof key & { backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean };
      if (key.escape) { setPhase({ kind: "form" }); return; }
      if (key.return) {
        const next = phase.value.trim();
        if (next) setPhase({ kind: "confirm", newPath: next });
        return;
      }
      if (typedKey.backspace || typedKey.delete || input === "\u007f") {
        setPhase({ kind: "manual", value: phase.value.slice(0, -1) });
        return;
      }
      if (input && !typedKey.ctrl && !typedKey.meta) {
        setPhase({ kind: "manual", value: phase.value + input });
      }
      return;
    }
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
      if (row.kind === "path") pickPath();
      else if (row.kind === "useCached") setPhase({ kind: "cachedPick", action: "use", cursor: 0 });
      else if (row.kind === "deleteCached") setPhase({ kind: "cachedPick", action: "delete", cursor: 0 });
      else onCancel();
    }
  });

  if (phase.kind === "cachedPick") {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{phase.action === "use" ? "use cached llama.cpp build" : "delete cached llama.cpp build"}</Text>
        <Box marginTop={1} flexDirection="column">
          {cachedBuilds.map((build, i) => {
            const selected = i === phase.cursor;
            return (
              <Text key={build.path} color={selected ? "cyan" : undefined} inverse={selected}>
                {selected ? "> " : "  "}{build.label}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}><Text dimColor>up/down move · enter select · q/esc back</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "deleted") {
    return (
      <Box flexDirection="column">
        <Text bold color="green">cached llama.cpp build deleted.</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{phase.build.tag} {phase.build.flavor}</Text>
          <Text dimColor>{phase.build.path}</Text>
        </Box>
        <Box marginTop={1}><Text dimColor>press any key to return to the menu</Text></Box>
      </Box>
    );
  }

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

  if (phase.kind === "manual") {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">enter llama-server path</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>path: <Text color="cyan">{phase.value || " "}</Text></Text>
          <Text dimColor>expected binary name: {expectedBinaryName}</Text>
        </Box>
        <Box marginTop={1}><Text dimColor>enter confirms · backspace edits · esc cancels</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "confirm") {
    const sameAsBefore = currentPath === phase.newPath;
    const wrongName = basename(phase.newPath).toLowerCase() !== expectedBinaryName;
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
            <Text color="yellow">note: filename is "{basename(phase.newPath)}", not "{expectedBinaryName}". bench will fail if this is not actually llama.cpp's server.</Text>
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
        {cachedBuilds.length > 0 && <Text dimColor>cached builds: {cachedBuilds.length}</Text>}
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
