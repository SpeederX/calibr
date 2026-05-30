import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { CALIBR_LOCAL_CFG } from "./engine.js";

interface Props {
  onRun: (args: string[], label: string) => void;
  onCancel: () => void;
}

// The engine refuses to overwrite an existing config.json without -Force.
// The CLI runs engine commands non-interactively, so the user can't answer
// the engine's prompt — this form makes the choice explicit before we
// invoke. If no config exists yet, we just run init and skip the form
// from App.tsx (no toggle needed).
export function InitOptionsView({ onRun, onCancel }: Props) {
  const exists = useMemo(() => existsSync(CALIBR_LOCAL_CFG), []);
  const [force, setForce] = useState<boolean>(false);
  const [cursor, setCursor] = useState(0);

  const rows = [
    {
      kind: "force" as const,
      label: `overwrite: ${force ? "yes (-Force; replaces existing config.json)" : "no (engine will refuse if config.json exists)"}`,
    },
    { kind: "run" as const, label: "> run init" },
    { kind: "cancel" as const, label: "  cancel" },
  ];

  const activate = (i: number) => {
    const row = rows[i];
    switch (row.kind) {
      case "force": setForce(!force); break;
      case "run": {
        const args: string[] = ["init"];
        if (force) args.push("-Force");
        const label = force ? "init -Force" : "init";
        onRun(args, label);
        break;
      }
      case "cancel": onCancel(); break;
    }
  };

  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor(c => Math.min(rows.length - 1, c + 1));
    else if (key.return || input === " ") activate(cursor);
    else if (key.escape || input === "q") onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">init — configure</Text>
      <Box marginTop={1} flexDirection="column">
        {exists ? (
          <Text color="yellow">
            config.json already exists at {CALIBR_LOCAL_CFG}. Re-running init
            without -Force will print a warning and exit; with -Force the
            file is rewritten from auto-detected hardware values.
          </Text>
        ) : (
          <Text dimColor>
            No config.json found. init will detect hardware and create one at {CALIBR_LOCAL_CFG}.
          </Text>
        )}
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
      <Box marginTop={1}><Text dimColor>↑/↓ move · enter cycles or runs · q/esc back</Text></Box>
    </Box>
  );
}
