# Telemetria streaming: latenza, throughput e consegna

> Design delle metriche per il benchmark in streaming (SSE) dei modelli via
> `llama-server`. Consolida formule, scope e il dettaglio TTFT/TTFR/TPOT.

---

## 1. Scope e principio guida

calibr benchmarka **un modello + una config llama.cpp su un hardware specifico**.
Il "system under test" è quindi l'inferenza (prefill + decode) su quella macchina,
**non** il trasporto HTTP.

Conseguenza pratica:

- Quello che vogliamo **isolare e togliere dal punteggio** non è "llama-server" in
  blocco, ma il **rumore di trasporto**: setup connessione, framing SSE, buffering
  TCP, jitter del client. Su localhost è piccolo e ~costante, ma va comunque
  separato per onestà della misura.
- Quello che **teniamo come segnale** è tutto ciò che fa llama.cpp: prefill,
  decode, andamento inter-token. È il cuore dell'hardware-fit.

Errore da evitare: trattare il prefill come "overhead del server". Il prefill è il
modello che lavora sul prompt — è benchmark a tutti gli effetti.

---

## 2. SSE: cos'è e cosa NON è

Server-Sent Events è una **funzione nativa di `llama-server`** (standard SSE), non
qualcosa che abbiamo costruito noi. Con `stream: true`, invece di attendere la
risposta completa, il server emette eventi progressivi:

```
data: {"choices":[{"delta":{"role":"assistant","content":null}}]}
data: {"choices":[{"delta":{"content":"Ciao"}}]}
data: {"choices":[{"delta":{"content":"!"}}]}
data: [DONE]
```

Pipeline interna (semplificata): `llama_decode()` → sample token → token→text →
check UTF-8 / stop sequence → partial response → delta OpenAI → SSE.

Cose da non assumere mai:

- **un evento ≠ un token.** Un delta può contenere più token (speculative decoding,
  parser reasoning) o trattenere testo (UTF-8 incompleto, verifica stop sequence).
- **più eventi possono arrivare nella stessa lettura TCP** → timestamp client
  praticamente identici. Per questo gli spike/drop sul rolling non riflettono la GPU.
- Il **t/s mostrato dalla Web UI di llama-server NON** deriva dalla distanza
  temporale tra eventi SSE. Usa i timing interni:
  `tokens/s = predicted_n / predicted_ms × 1000`. È equivalente al nostro eval t/s
  ufficiale, non al rolling.

Quindi: i timestamp SSE misurano la **cadenza di consegna al client**, non la
generazione interna. Sono un dato reale, ma vale solo come diagnostica di delivery.

---

## 3. Le opzioni server che usiamo

```json
{
  "stream": true,
  "timings_per_token": true,
  "return_progress": true
}
```

- **`timings_per_token`** aggiunge a ogni partial response i timing cumulativi:
  `predicted_n`, `predicted_ms`, `predicted_per_second` (+ `prompt_n`, `prompt_ms`).
  → clock interno del server, immune da buffering TCP, corretto anche con gruppi
  di token speculativi.
- **`return_progress`** espone durante il prefill: `total`, `cache`, `processed`,
  `time_ms` → avanzamento reale del prompt, invece di colorare genericamente tutta
  la fase pre-TTFT.

> ⚠️ Verifica i nomi esatti dei campi sulla tua build di `llama-server`: variano tra
> versioni. Questi sono quelli osservati; confermali sulla response reale.

---

## 4. Modello a eventi (timeline)

```
t0  request inviata
t1  header HTTP ricevuti
t2  primo evento SSE (anche vuoto: role / content:null)
t3  prefill completato            (da return_progress)
t4  primo token decodificato      (server-internal, da timings)
t5  primo reasoning delta          (client, choices[].delta.reasoning_content)
t6  primo content/answer delta     (client, choices[].delta.content)
```

**Principio dei due clock** — ogni metrica appartiene a uno solo:

| Clock | Sorgente | Cosa misura | Inquinato da |
|---|---|---|---|
| **Client** (`performance.now()`) | timestamp locali t0,t1,t2,t5,t6 | esperienza percepita / delivery | trasporto, buffering TCP |
| **Server** (timings) | `prompt_ms`, `predicted_ms`, `predicted_n` | inferenza pura | niente |

Regola d'oro: **non ricavare metriche del modello sottraendo l'HTTP dal client**
(`generation_ms = total_client − http_ms` ❌). La sottrazione lascia dentro il jitter
di buffering. Le metriche del modello si prendono **direttamente dal clock server**.

---

## 5. I tre bucket di metriche

### 5.1 Overhead / trasporto — diagnostico, NON nel winner score

| Metrica | Formula | Note |
|---|---|---|
| `ttfh_ms` | `t1 − t0` | risposta HTTP iniziale (header) |
| `stream_open_ms` | `t2 − t0` | ex-"TTFR": primo frame SSE, anche vuoto. **È trasporto, non modello.** |

> **Nota TTFR.** Il vecchio `TTFR = t2 − t0` aveva un nome che implicava "response"
> del modello, ma misura il primo frame SSE — spesso `content: null`, cioè zero
> output. È una metrica di **trasporto/HTTP**, non di inferenza. Rinominata in
> `stream_open_ms` e spostata in questo bucket. Se serviva il concetto "primo token
> utile", quello è `client_ttft_ms` (sezione 5.3), non questo.

### 5.2 Modello — **headline del benchmark** (clock server)

| Metrica | Formula | Note |
|---|---|---|
| `server_prefill_ms` | `prompt_ms` | tempo di processing del prompt |
| `server_ttft_ms` | `prompt_ms + predicted_ms(@n=1)` | TTFT vera: prefill + decode del 1° token |
| `tpot_ms` / `itl_ms` | `(predicted_ms_tot − predicted_ms(@n=1)) / (predicted_n_tot − 1)` | latenza media per token in steady-state (esclude il 1°) |
| `itl_p95_ms` | p95 dei delta `Δpredicted_ms / Δpredicted_n` | smaschera stall e loop nel reasoning |
| `throughput_tps` | `predicted_n / predicted_ms × 1000` | eval t/s ufficiale |
| `e2e_generation_ms` | `predicted_ms` totale | solo generazione, clock server |

> **Perché TPOT/ITL è la metrica regina mancante.** Per i modelli reasoning che
> loopano, `throughput_tps` resta alto (è tutto decoding) ma la latenza percepita è
> pessima. TPOT/ITL (e soprattutto il p95) è ciò che rende visibile la differenza
> tra "genera veloce" e "genera regolare". Va nel report; nel winner score
> entra solo se decidiamo di pesare la fluidità.

### 5.3 Delivery / UX — diagnostico (clock client)

| Metrica | Formula | Note |
|---|---|---|
| `client_ttft_ms` | `min(t5, t6) − t0` | primo delta **non vuoto** ricevuto |
| `e2e_first_reasoning_ms` | `t5 − t0` | primo reasoning al client |
| `e2e_first_content_ms` | `t6 − t0` | primo content finale al client — **NON è E2E** (vedi sotto) |
| `reasoning_delay_ms` | `t6 − t5` | quanto reasoning precede la risposta |
| `delivery_gap_ms` | intervallo tra due delta testuali consecutivi | mediana + p95 + max (stall) |

> **`time to answer` ≠ end-to-end.** `e2e_first_content_ms = t6 − t0` è il *primo
> token della risposta*, non la fine. L'E2E canonico è `t_last − t0` (ultimo token).
> Tenerli distinti nel glossario: uno è "quando inizia la risposta utile", l'altro
> "quanto ci mette in totale".

> **Il vecchio `rolling_tps`** misurava `7 / Δt(8 eventi SSE)` → cadenza di consegna,
> non token/s. Nome fuorviante e perimetro ambiguo. **Sostituito** da `delivery_gap_ms`
> (esplicitamente delivery, non generazione). La velocità di generazione vera viene da
> `tpot_ms` sul clock server.

---

## 6. Fasi: prefill / reasoning / answer

Ogni campione va taggato con la fase, così la timeline risponde a tre domande precise:

- **prefill** — da `return_progress` (`Δprocessed / Δtime_ms`) → quanto rapidamente
  viene elaborato il prompt.
- **reasoning** — delta in `reasoning_content`.
- **answer** — delta in `content`.

Reasoning e answer **non vanno più uniti**: oggi `prefill → generated output` nasconde
il caso "reasoning a 70 t/s per molto, poi risposta cortissima → eval alto, UX
pessima". Separare: first reasoning delta, first answer delta, durata reasoning,
durata answer, eventi/char per fase, token ufficiali quando disponibili, timeline con
colori distinti. Per Qwen con thinking disabilitato non cambia nulla; per i reasoning
è decisivo.

---

## 7. Glossario consolidato (da incollare nel report)

```
— OVERHEAD (trasporto, diagnostico) —
ttfh_ms            = t1 − t0                         header HTTP
stream_open_ms     = t2 − t0                         primo frame SSE (ex-TTFR)

— MODELLO (clock server, headline) —
server_prefill_ms  = prompt_ms
server_ttft_ms     = prompt_ms + predicted_ms(@n=1)
tpot_ms / itl_ms   = (predicted_ms_tot − predicted_ms@1) / (predicted_n_tot − 1)
itl_p95_ms         = p95( Δpredicted_ms / Δpredicted_n )
throughput_tps     = predicted_n / predicted_ms × 1000
e2e_generation_ms  = predicted_ms (totale)

— DELIVERY / UX (clock client, diagnostico) —
client_ttft_ms          = min(t5, t6) − t0          primo delta non vuoto
e2e_first_reasoning_ms   = t5 − t0
e2e_first_content_ms     = t6 − t0                   first-answer-token (NON E2E)
reasoning_delay_ms       = t6 − t5
delivery_gap_ms          = mediana/p95/max degli intervalli tra delta
```

Mapping ai nomi standard del serving (vLLM/TGI), per leggibilità esterna:

| Standard | Nostro equivalente |
|---|---|
| TTFT (Time To First Token) | `server_ttft_ms` |
| TPOT / ITL (Inter-Token Latency) | `tpot_ms` / `itl_ms` |
| Throughput (tok/s) | `throughput_tps` |
| E2E latency | `t_last − t0` (da aggiungere) |

---

## 8. Note implementative

- **Warm-up obbligatorio.** Scarta la prima run: altrimenti `prompt_ms` include il
  load dei pesi e falsa il prefill.
- **`performance.now()` monotono**, non `Date.now()`, per tutti i timestamp client.
- **TTFR/TTFH separati alla fonte.** Registrare distintamente quando `fetch()` riceve
  gli header e quando arriva il primo evento.
- **Headline = clock server.** Dato lo scope, il punteggio si basa sulle metriche
  server-internal; il client-side è diagnostica di delivery. Questo **ribalta**
  l'impostazione attuale, in cui i timestamp SSE erano primari.
- **Mediana sulle run** = valore centrale dopo ordinamento (con numero pari, il
  centrale inferiore). Non è il massimo: serve a impedire che uno spike vinca.
  Es. `61, 64, 90 → 64`.
- **Limite irriducibile:** se più eventi arrivano nella stessa lettura di rete, non
  possiamo ricostruire l'istante d'invio di ciascuno. `timings_per_token` aggira il
  problema dando il clock interno → distinguiamo "generazione lenta" da "generazione
  regolare ma consegna raggruppata".

---

## 9. Prossimi passi

Con la telemetria reasoning/content + clock server in piedi, costruirci sopra:

1. **Prefill sweep** — prompt progressivi 1K → 4K → 16K → 32K → 64K. Osserva:
   degradazione del prompt throughput, crescita reale VRAM/RAM, punto di spill WDDM,
   variazione di `server_ttft_ms`.
2. **KV-fill sweep** — riempimento del context configurato 25% → 50% → 75% → 90%
   (lasciando spazio per l'output). Osserva: eval degradation con KV quasi piena,
   crescita memoria, variazione TPOT.

Niente toggle streaming: complessità senza confronto utile.

---

## 10. Fonti

llama-server documentation, `server-context.cpp`, Web UI statistics.
Da validare contro la build in uso (nomi campi timings/progress variano per versione).
