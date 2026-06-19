import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  readModelCatalog,
  saveUserPreset,
  type CatalogEntry,
} from "./engine.js";

interface Props {
  // The caller (AllOptionsView) prepends the verb + top-level flags; this view
  // contributes the model selection and, in v2, the context-size set.
  onSubmit: (catalogIdList: string, contextSizes?: number[]) => void;
  onCancel: () => void;
}

// The default context sweep (mirrors config.context_candidates). The user
// cross-products the checked ctx sizes with the checked models.
const CTX_OPTIONS = [16384, 32768, 65536, 131072, 262144];
const ctxLabel = (n: number) => `${Math.round(n / 1024)}k`;

type Mode = "nav" | "search" | "savePrompt";

// CustomBenchView v2: typed search filter + model checkboxes + context-size
// checkboxes (cross-product = bench scope) + save-as-user-preset.
export function CustomBenchView({ onSubmit, onCancel }: Props) {
  const catalog = useMemo<CatalogEntry[]>(readModelCatalog, []);
  const [checkedModels, setCheckedModels] = useState<Set<string>>(() => new Set());
  const [checkedCtx, setCheckedCtx] = useState<Set<number>>(() => new Set(CTX_OPTIONS)); // all on = full sweep
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("nav");
  const [saveName, setSaveName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  // Filtered model list (live narrowing by id/model/series/variant substring).
  const filtered = useMemo<CatalogEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(e =>
      [e.id, e.model, e.series, e.variant].some(s => (s ?? "").toLowerCase().includes(q))
    );
  }, [catalog, query]);

  // Flat navigable list: [filtered models] [ctx options] [submit].
  const ctxStart = filtered.length;
  const submitIdx = filtered.length + CTX_OPTIONS.length;
  const total = submitIdx + 1;
  const clampedCursor = Math.min(cursor, total - 1);

  const selectedIds = catalog.filter(e => checkedModels.has(e.id)).map(e => e.id);
  const ctxAllOn = checkedCtx.size === CTX_OPTIONS.length;
  // Only send an explicit ctx set when the user actually narrowed it.
  const ctxForSubmit = ctxAllOn ? undefined : [...checkedCtx].sort((a, b) => a - b);
  const totalGB = catalog.filter(e => checkedModels.has(e.id))
    .reduce((acc, e) => acc + (e.size_bytes || 0), 0) / (1024 ** 3);

  const toggleModel = (id: string) =>
    setCheckedModels(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleCtx = (n: number) =>
    setCheckedCtx(prev => { const s = new Set(prev); s.has(n) ? s.delete(n) : s.add(n); return s; });

  const submit = () => {
    if (selectedIds.length === 0 || checkedCtx.size === 0) return;
    onSubmit(selectedIds.join(","), ctxForSubmit);
  };

  useInput((input, key) => {
    setNotice(null);

    if (mode === "search") {
      if (key.return || key.escape) { setMode("nav"); return; }
      if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setCursor(0); return; }
      if (input && /^[\w.\- ]$/.test(input)) { setQuery(q => q + input); setCursor(0); }
      return;
    }

    if (mode === "savePrompt") {
      if (key.escape) { setMode("nav"); setSaveName(""); return; }
      if (key.return) {
        const name = saveName.trim().toLowerCase().replace(/\s+/g, "-");
        if (name && selectedIds.length > 0) {
          try { saveUserPreset(name, selectedIds, ctxForSubmit); setNotice(`saved preset '${name}' (${selectedIds.length} models)`); }
          catch (e) { setNotice(`save failed: ${String(e)}`); }
        }
        setMode("nav"); setSaveName("");
        return;
      }
      if (key.backspace || key.delete) { setSaveName(s => s.slice(0, -1)); return; }
      if (input && /^[\w.\- ]$/.test(input)) setSaveName(s => s + input);
      return;
    }

    // nav mode
    if (key.escape || input === "q") { onCancel(); return; }
    if (input === "/") { setMode("search"); return; }
    if (input === "a") { setCheckedModels(new Set(filtered.map(e => e.id))); return; }
    if (input === "x") { setCheckedModels(new Set()); return; }
    if (input === "s") { if (selectedIds.length > 0) { setSaveName(""); setMode("savePrompt"); } return; }
    if (key.upArrow) { setCursor(c => Math.max(0, Math.min(c, total - 1) - 1)); return; }
    if (key.downArrow) { setCursor(c => Math.min(total - 1, c + 1)); return; }
    if (key.return || input === " ") {
      const c = clampedCursor;
      if (c < ctxStart) { const e = filtered[c]; if (e) toggleModel(e.id); }
      else if (c < submitIdx) { toggleCtx(CTX_OPTIONS[c - ctxStart]); }
      else { submit(); }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">custom — pick models × context sizes</Text>

      <Box marginTop={1}>
        <Text>
          <Text dimColor>search: </Text>
          {mode === "search"
            ? <Text color="cyan">{query}_</Text>
            : <Text>{query ? query : <Text dimColor>(press / to filter)</Text>}</Text>}
          {query && <Text dimColor>  · {filtered.length}/{catalog.length} match</Text>}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {filtered.length === 0 && <Text dimColor>  (no models match the filter)</Text>}
        {filtered.map((e, i) => {
          const selected = clampedCursor === i;
          const mark = checkedModels.has(e.id) ? "[x]" : "[ ]";
          const tag = e.sweep_hint ? `[${e.sweep_hint}]` : "";
          const sz  = e.size_bytes ? ((e.size_bytes / (1024 ** 3)).toFixed(2) + " GB") : "?";
          return (
            <Text key={e.id} color={selected ? "cyan" : undefined} inverse={selected}>
              {selected ? "> " : "  "}{mark} {e.id.padEnd(26)}<Text dimColor>{tag.padEnd(10)}{sz.padStart(9)}  ctx ≤ {e.max_context ?? "?"}</Text>
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>context sizes (cross-product with selected models):</Text>
        {CTX_OPTIONS.map((n, j) => {
          const idx = ctxStart + j;
          const selected = clampedCursor === idx;
          const mark = checkedCtx.has(n) ? "[x]" : "[ ]";
          return (
            <Text key={n} color={selected ? "cyan" : undefined} inverse={selected}>
              {selected ? "> " : "  "}{mark} {ctxLabel(n)}
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={clampedCursor === submitIdx ? "cyan" : (selectedIds.length > 0 ? "green" : "gray")} inverse={clampedCursor === submitIdx}>
          {clampedCursor === submitIdx ? "> " : "  "}{">"} bench selected ({selectedIds.length} model{selectedIds.length === 1 ? "" : "s"} × {checkedCtx.size} ctx, ~{totalGB.toFixed(1)} GB)
        </Text>
      </Box>

      {notice && <Box marginTop={1}><Text color="green">{notice}</Text></Box>}
      {mode === "savePrompt" && (
        <Box marginTop={1}><Text>save as preset: <Text color="cyan">{saveName}_</Text> <Text dimColor>(enter to save · esc cancel)</Text></Text></Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑/↓ move · space/enter toggle · / search · a all · x none · s save preset · enter on submit · q/esc back</Text>
      </Box>
    </Box>
  );
}
