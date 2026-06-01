import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  readModelCatalog,
  type CatalogEntry,
} from "./engine.js";

interface Props {
  // Called with the args for the engine. The caller (App / AllOptionsView)
  // is responsible for prepending the 'all' / 'bench' verb and any other
  // top-level flags it already collected; this view only contributes the
  // model selection.
  onSubmit: (catalogIdList: string) => void;
  onCancel: () => void;
}

// CustomBenchView v1: multi-pick model selection only.
// Future iterations will add (a) typed search filter, (b) context-size
// checkboxes, (c) save-as-user-preset. For now, the user picks which
// models to bench; ctx sweep stays at the defaults from
// tier_a_candidates (filtered by per-model max_context and the global
// max_context_cap as usual).
export function CustomBenchView({ onSubmit, onCancel }: Props) {
  const catalog = useMemo<CatalogEntry[]>(readModelCatalog, []);
  // Default: nothing checked. Forces the user to pick at least one.
  const [checked, setChecked] = useState<boolean[]>(() => catalog.map(() => false));
  // Cursor row 0..catalog.length-1 is a model row; row catalog.length is
  // the '> bench selected' submit row.
  const [cursor, setCursor] = useState(0);

  const selectedCount = checked.filter(Boolean).length;
  const selectedEntries = catalog.filter((_, i) => checked[i]);

  const setAll = (v: boolean) => setChecked(catalog.map(() => v));
  const toggle = (i: number) => setChecked(prev => prev.map((v, idx) => idx === i ? !v : v));

  useInput((input, key) => {
    if (key.escape || input === "q") { onCancel(); return; }
    if (key.upArrow)   { setCursor(c => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor(c => Math.min(catalog.length, c + 1)); return; }
    if (input === "a") { setAll(true); return; }
    if (input === "n") { setAll(false); return; }
    if (key.return || input === " ") {
      if (cursor < catalog.length) {
        toggle(cursor);
      } else {
        // submit row
        if (selectedCount === 0) return;
        const idList = selectedEntries.map(e => e.id).join(",");
        onSubmit(idList);
      }
    }
  });

  // Total bytes of the current selection (informational, not a gate).
  const totalGB = (selectedEntries.reduce((acc, e) => acc + (e.size_bytes || 0), 0)) / (1024 ** 3);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">custom — pick which models to bench</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Pick one or more entries from the catalog. Context sizes still
          sweep the defaults (16k / 32k / 64k / 96k / 128k / 160k) filtered
          by each model's max_context. Ctx-set picking arrives in a future
          iteration.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {catalog.map((e, i) => {
          const selected = i === cursor;
          const mark = checked[i] ? "[x]" : "[ ]";
          const tag = e.tier_hint ? `[${e.tier_hint}]` : "[ ]";
          const sz  = e.size_bytes ? ((e.size_bytes / (1024 ** 3)).toFixed(2) + " GB") : "?";
          return (
            <Text key={e.id} color={selected ? "cyan" : undefined} inverse={selected}>
              {selected ? "> " : "  "}{mark} {tag} {e.id.padEnd(28)}{e.model.padEnd(30)}<Text dimColor>{sz.padStart(10)}  ctx ≤ {e.max_context ?? "?"}</Text>
            </Text>
          );
        })}
        <Text key="submit" color={cursor === catalog.length ? "cyan" : (selectedCount > 0 ? "green" : "gray")} inverse={cursor === catalog.length}>
          {cursor === catalog.length ? "> " : "  "}{">"} bench selected ({selectedCount} model{selectedCount === 1 ? "" : "s"}, ~{totalGB.toFixed(1)} GB download)
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · space/enter toggle · a = all · n = none · enter on submit row · q/esc back</Text>
      </Box>
    </Box>
  );
}
