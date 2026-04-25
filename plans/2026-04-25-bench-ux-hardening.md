# llm-lab — UX hardening: backend cross-check, progress bar, family-skip on arch failure

## Context

Durante la prima full-run con `samples.json` (68 test, ~20 min) l'utente ha visto:

- **22 fail consecutivi sui modelli Gemma 4** con peak=847 MiB identico (idle GPU baseline). Causa: la build di `llama-server.exe` installata via WinGet (`b8247`) non supporta l'architettura `gemma4` ed esce con `unknown model architecture: 'gemma4'` prima ancora di caricare i pesi. Lo script ha comunque avviato tutti i 22 test inutilmente, sprecando ~10 min.
- **Backend è Vulkan, non CUDA**. La build WinGet è Vulkan + CPU. Lo script funziona ma:
  - Le regex in `Invoke-OneBench` cercano `CUDA0 model buffer size`/`CUDA0 KV buffer size` → su Vulkan questi campi nel JSON risultato sono vuoti (la dashboard non li usa, quindi non si vede, ma è confusione tecnica latente).
  - Su NVIDIA la build CUDA è 10-15% più veloce di Vulkan. L'utente non era avvisato.
- **Output di progress povero**. Solo `Write-Host` per ogni test, niente percent / ETA / summary finale. UX percepita "ruvida".

L'obiettivo è rendere `bench` più informativo e robusto agli errori sistemici di una famiglia.

## Approccio raccomandato

Tre miglioramenti, tutti circoscritti a `llm-lab.ps1` (no template HTML, no schema JSON):

### 1. Cross-check GPU vs backend di llama-server

**Nuova funzione** `Get-LlamaBackends($exe)` — guarda i `ggml-*.dll` siblings dell'eseguibile e ritorna un hashtable `@{ cuda; vulkan; metal; hip; sycl; cpu }`. Il check è cheap (Get-ChildItem in una dir), zero side-effects, niente probe del processo.

**Nuova funzione** `Test-BackendHealthy($cfg, $backends)` — ritorna lista di warning string:

| GPU rilevata (`hardware.gpu_name`) | Backend disponibili | Warning |
|---|---|---|
| `NVIDIA …` | cuda=true | (nessuno: ottimale) |
| `NVIDIA …` | cuda=false, vulkan=true | "NVIDIA GPU but llama.cpp has no CUDA backend; Vulkan works but is ~10-15% slower. Get a CUDA build from https://github.com/ggml-org/llama.cpp/releases" |
| `AMD\|Radeon …` | hip=true OR vulkan=true | (nessuno) |
| `AMD\|Radeon …` | nessuno dei due | "AMD GPU but no HIP/Vulkan backend available" |
| altro / vuoto | vulkan=true | (nessuno) |
| altro / vuoto | nessuno | "No GPU backend (cuda/vulkan/hip) available; CPU only" |

**Punto di invocazione**: in cima a `Invoke-Bench`, subito dopo `Get-Config`, prima del loop. Stampati in giallo. Non bloccanti — l'utente può proseguire (la build Vulkan funziona comunque).

### 2. Progress bar + per-test line migliorato + summary finale

**Sostituisci il loop `Invoke-Bench` (righe ~696-702 attuali) con**:

```powershell
$total = $filtered.Count
$startTime = Get-Date
$i = 0
$abandoned = @{}   # vedi punto 3
$summary = @()      # raccolti per la tabella finale

foreach ($item in $filtered) {
    $i++

    if ($abandoned.ContainsKey($item.family)) {
        # vedi punto 3: skip family
        ...
        continue
    }

    $elapsed = (Get-Date) - $startTime
    $etaSec  = if ($i -gt 1) { ($elapsed.TotalSeconds / ($i-1)) * ($total - $i + 1) } else { 0 }
    $etaStr  = if ($etaSec -gt 0) { "{0}m{1:D2}s" -f ([int]($etaSec/60)), ([int]($etaSec%60)) } else { "?" }

    Write-Progress -Activity "llm-lab bench" `
                   -Status   ("[$i/$total] running · ETA $etaStr") `
                   -CurrentOperation $item.label `
                   -PercentComplete (($i - 1) / $total * 100)

    Write-Host ("`n[$i/$total] $($item.label)") -ForegroundColor Cyan
    $r = Invoke-OneBench -item $item -cfg $cfg
    $summary += $r
    # detection arch unsupported (vedi punto 3)
    ...
}
Write-Progress -Activity "llm-lab bench" -Completed
```

**Why `Write-Progress` e non un listone in-place**: 68 test eccedono spesso l'altezza terminale (es. 30-40 righe), e `[Console]::SetCursorPosition` su righe scrollate fuori dal viewport produce flickering / cursor displacement. `Write-Progress` è built-in, sempre top-of-window, robusto, e il flusso scroll-Write-Host sotto resta intuitivo per scrollare indietro nella history.

**Per-test summary line** (riga 672 attuale, dentro `Invoke-OneBench`): drop test ID dal display (resta nel JSON), enfasi su family/quant/label e numero. Esempio:

```
[OK]   Qwen3.5-0.8B  Q8_0  ctx=16384 kv=q8_0       960 t/s prompt   140 t/s eval   peak 2232 MiB
[FAIL] gemma-4-E2B-it  Q4_K_M  ctx=16384 kv=q8_0  (unsupported architecture: gemma4)
[SKIP] gemma-4-E2B-it  Q4_K_M  ctx=32768 kv=q8_0  (family abandoned)
```

**Summary finale alla fine di `Invoke-Bench`**:

```
═══════════════════════════════════════════════════════════════
 llm-lab bench — done in 19m32s
   64 ok · 4 fail · 22 skipped (out of 90)
   abandoned families: gemma-4-E2B-it, gemma-4-E4B-it, gemma-4-26B-A4B-it, gemma-4-31B-it
   reason: unsupported architecture 'gemma4'
═══════════════════════════════════════════════════════════════
```

### 3. Detection di "unknown model architecture" → skip resto della famiglia

**In `Invoke-OneBench`**, dopo il blocco di parsing stderr (righe ~644-654 attuali), aggiungi:

```powershell
$mArch = [regex]::Match($err, "unknown model architecture: '([^']+)'")
if ($mArch.Success) { $result.unsupported_architecture = $mArch.Groups[1].Value }
```

**In `Invoke-Bench`**, dopo `$r = Invoke-OneBench …`:

```powershell
if (-not $r.ok -and $r.unsupported_architecture) {
    $abandoned[$item.family] = "unsupported architecture '$($r.unsupported_architecture)'"
    Write-Host "  -> abandoning remaining tests for family '$($item.family)' (update llama.cpp to fix)" -ForegroundColor DarkYellow
}
```

E in cima al loop (visto sopra) lo skip vero:

```powershell
if ($abandoned.ContainsKey($item.family)) {
    $reason = $abandoned[$item.family]
    Write-Host ("[SKIP] {0,-50} ({1})" -f $item.label, $reason) -ForegroundColor DarkYellow
    $summary += @{ id=$item.id; label=$item.label; family=$item.family; ok=$false; skipped=$true; skip_reason=$reason }
    continue
}
```

I test skipped **non** producono `data/results/*.json`. Restano fuori dal report (corretto: niente da mostrare). Il summary in console li conta separatamente ("22 skipped"), così l'utente vede subito che il problema è sistemico e non test-by-test.

## File toccati

| File | Modifiche |
|---|---|
| `llm-lab/llm-lab.ps1` | + `Get-LlamaBackends`, + `Test-BackendHealthy` (nuove funzioni, ~40 righe). Riga ~672: cambia format del summary line. Riga ~683: aggiunge i warning di backend in cima a `Invoke-Bench`. Righe ~696-702: rifatto il loop con `Write-Progress`, abandoned tracking, summary table finale. Righe ~644-654: aggiunge regex `unknown model architecture`. |

Nessun altro file: il template HTML non legge i campi CUDA-specific (`cuda_model_mib` & co.), quindi il fatto che siano vuoti su Vulkan resta non-issue. README opzionale: una nota nel "Requirements" che il warning comparirà se la build non corrisponde al GPU.

## Verifica end-to-end

1. **Backend cross-check**: lanciare `.\llm-lab.ps1 bench -DryRun` con la build WinGet attuale (Vulkan) e verificare che venga stampato il warning giallo "NVIDIA GPU but llama.cpp has no CUDA backend …".
2. **Progress bar**: lanciare `.\llm-lab.ps1 all` (anche con un solo modello via `-Family Qwen3.5-0.8B`) e osservare la barra top-of-window aggiornarsi con `[i/total]` + ETA. Verificare che `Write-Progress -Completed` sparisca al termine.
3. **Family skip**: con la build WinGet Vulkan corrente che NON supporta gemma4, lanciare `.\llm-lab.ps1 bench -Family "gemma-4"` e verificare che dopo il primo `[FAIL]` con `unsupported architecture: gemma4`, i 21 successivi appaiano come `[SKIP] … (family abandoned)`. Tempo totale atteso: ~30 secondi anziché ~10 minuti.
4. **Summary finale**: dopo (3), verificare che la tabella di chiusura riporti `1 fail · 21 skipped (out of 22)` e che le famiglie abbandonate siano elencate.
5. **No regression**: verificare che `data/results/*.json` esistenti vengano riusati come cache (no `-Force`) e che il report HTML continui a leggere correttamente i campi che usa (`vram_peak_mib`, `eval_tps`, `wddm_*`, `layers_offloaded`, ...).
6. **Parser sanity**: `[System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$errs)` deve ritornare zero errori.
