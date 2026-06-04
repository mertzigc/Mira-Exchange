# Mira-Exchange — Arkitektur-karta & Designdokument för sync-omtag

> Steg 0 (audit) levererad 2026-06-04. INGEN kod ändrad. Detta dokument är underlag för beslut innan omtaget börjar.
> Källa: full läsning av `index.js` (15 888 rader / 604 KB), `emailer.js` (63 KB) och fem `.sh`-cronscript.

---

## 1. Arkitektur-karta

### 1.1 Process-modell
- **En enda Node/Express-process** på Render. `index.js` startar servern (rad 15887) och anropar sedan `startEmailPoller(...)` (rad 15888) — **emailern körs in-process i samma server**, inte som separat tjänst. Bubble-helpers injiceras in i emailern (DI för att undvika cirkulärt beroende).
- **5 externa cron-script** (`.sh`) postar mot `https://mira-exchange.onrender.com`. Schemat ligger i Renders cron-config, inte i filerna. Loop-logiken ligger däremot inuti vissa script.
- **Email-poller**: `node-cron` var 2:a minut, max 20 rader per tick. Gate på `SENDGRID_API_KEY`.

### 1.2 Externa integrationer (6 st)
| System | Roll | Token-modell |
|---|---|---|
| **Fortnox** | Fakturor, ordrar, offerter, kunder, artiklar (F&E, Staff, Group) | OAuth refresh-token, proaktiv refresh via `ensureFortnoxAccessToken` |
| **Tengella** | Fakturor, arbetsordrar, kunder (Housekeeping) | App-key (header) + login-per-anrop → Bearer. **Ingen refresh — ny login varje gång** |
| **Microsoft Graph** | Kalender, rum, tillgänglighet | OAuth + app-token |
| **Caspeco** | Bokningar, tillgänglighet | egen auth |
| **SendGrid** | Utgående mail | API-key |
| **Bubble Data API** | Hela datalagret | API-key, **hård 100-träffars-cap/request** |

**Detta är inte ett "faktura-sync-projekt". Det är en monolit som limmar ihop sex system + en hel evenemang/inbjudan-modul + kundportal + KPI + mailmotor.** Se §5 (pushback) om vad det betyder för "index.js < 5000 rader".

### 1.3 Route-yta — 125 routes
| Klass | Antal | Exempel |
|---|---|---|
| READ-ONLY | 53 | `/kpi/sales`, `/api/invoices`, Caspeco/MS-läsning, admin-listningar |
| SYNC-WRITE | 49 | `/fortnox/sync/*`, `/fortnox/upsert/*`, `/tengella/*/sync`, `/caspeco/bookings/sync` |
| AUTH/TOKEN | 9 | Fortnox/MS OAuth + refresh |
| ENRICH | 7 | `/fortnox/enrich/*`, `/tengella/enrich/invoice-pdfs` ← **ska bort efter omtag** |
| CLEANUP/ADMIN | 6 | `/fortnox/cleanup/ghost-invoices`, `/fortnox/backfill/...-from-csv`, cache-flush |
| OTHER | 1 | `/debug/unifiedorder/resolve` |

Funktionella block i monoliten (utöver Fortnox/Tengella-sync):
- **Microsoft** (`/ms/*`): kalender, rum, tillgänglighet — rad ~6023–6597
- **Caspeco** (`/caspeco/*`): bokningar — rad ~9569–9953
- **Jobb-pollers** (`/jobs/matter/*`, `/jobs/mail/*`): inkommande mail/matter — rad ~4744–5993
- **Inbjudan/evenemang** (`/admin/invite/*`, `/admin/audience/*`, `/invite/*`, `/public/*`): hel gäst/RSVP-modul — rad ~12947–14019
- **KPI** (`/kpi/*`, `/api/kpi/*`): sales, summary, leads, grades, company — rad ~10655–11349
- **Kundportal** (`/invoice/lookup`, `/invoice/submit`, `/api/invoices`): rad ~12440–14315
- **Analytics** (`/analytics/articles*`): rad ~11970–12176

### 1.4 Cron-script → endpoints
| Script | Anropar | Loop-risk |
|---|---|---|
| `fortnox_cron_v1.sh` | `/fortnox/cron/v1`, `/sync/invoices/modified`, `/enrich/invoice-pdfs`, `/tengella/enrich/invoice-pdfs`, `/upsert/articles/all`, `/analytics/articles/refresh` | Ingen — bounded `for`-loopar |
| `tengella_cron.sh` | `/tengella/debug-env`, `/auth/test`, `/cron` (`--max-time 43200` = **12 h**) | Ingen i scriptet |
| `fortnox_offers_recent_10min.sh` | `/fortnox/sync/offers`, `/upsert/offers` | Ingen — mest defensiva scriptet (bounded retry) |
| `fortnox_enrich.sh` | `/fortnox/enrich/invoices`, `/enrich/offers` | **MEDEL** — `while rounds<200`, bryter på `found==0` |
| `enrich_zero_net.sh` | `/fortnox/enrich/invoices/zero-net` | **HÖG** — `while true`, brytvillkor enbart `found<100`, tak 200×200 = 20 000 POST |

### 1.5 Bubble-datalager (kärn-helpers)
| Funktion | Rad | Not |
|---|---|---|
| `bubbleFind(type, {constraints, limit=1, cursor})` | 1070 | **default `limit:1`** (fotgevär), **ingen intern paginering**, sväljer JSON-parsefel tyst → trasigt svar = tom array |
| `bubbleFindAll` | 1110 | Paginerar korrekt (limit 100, cursor +100) |
| `bubbleFindAllCursor` | 2928 | Paginerande variant, stop vid 500 sidor |
| `bubbleFindOne` | 1126 | `limit:1`, första träff |
| `bubbleCreate` / `bubblePatch` / `bubbleDelete` | 1245 / 406 / 451 | Det finns **ingen `bubbleUpdate`** — kommentarer refererar till den, men allt går via `bubblePatch` |
| `bubbleUploadFile` | 3378 | multipart → fil-URL |

Upsert-nyckel för fakturor: **`connection_id` + `ft_document_number`** (rad 8198), med legacy-fallback på enbart docno för poster utan connection_id (rad 8209).

---

## 2. Buggarna — verifierade mot kod (med korrigeringar)

| # | Påstående | Status | Bevis | Korrigering / nyans |
|---|---|---|---|---|
| 1 | Listing saknar Net/VAT/refs; upsert skriver bara om värde finns → tomma fält | **BEKRÄFTAD** | 8148-8151, 8190-8191; call-sites 9290, 14498 | Defensiv kod är *medveten* (skriver inte över redan enrichad data). Tomma fält gäller främst första CREATE → blir **NULL, inte tom sträng**. Roten är att upsert matas med *listing*, inte detail. |
| 2 | Tengella: `ft_our_reference`=InvoiceType, `ft_your_reference`=TaxReductionType | **BEKRÄFTAD** | 10238, 10240 | Exakt som beskrivet. |
| 3 | Kreditfakturor får inget negativt tecken | **BEKRÄFTAD + VÄRRE + ROT-ORSAK FUNNEN** | 10205-10213 | Ingen sign-flip. `total > 0 ? net : 0` nollställer credits. **Bekräftat 2026-06-04 mot live-data:** Tengella skickar credits med **negativt** `TotalAmount` (−29688, −1022, −6073). Guarden gör att de blir net=0/NULL → räknas inte → −888 388 saknas. **Fix: ta bort guarden, räkna `net = round(total/1.25)` på signerat total.** Tecknet följer automatiskt; ingen explicit Kredit-check behövs för matematiken. |
| 4 | Enrich skriver ft_net=0 för genuint nollvärda → oändlig loop | **BEKRÄFTAD (nyans)** | enrich 8266-8269 + search 8448 | Ingen `while` i *koden*. Loopen sitter i **`enrich_zero_net.sh`** (`while true`, bryter på `found<100`). Servern returnerar samma genuint-noll-rader varje runda → scriptet snurrar till taket. **De 13 000 enrichningarna = shell-loop × server-no-op.** |
| 5 | `ft_invoice_date` ISO-string; Bubbles "greater than" opålitlig | **BEKRÄFTAD** | toIsoDate 2647-2652; lokal filtrering 8380, 10934, 14366 | Koden kringgår redan med **lokal JS-filtrering** i `/kpi/sales`, `/api/invoices`, zero-net. Det fungerar men har en dold kostnad (se §4, scaling). |
| 6 | `findClientCompanyByOrgNo` provar 3 orgnr-varianter | **BEKRÄFTAD — men är medveten design** | 6680-6686 | Det är ett *dubblettskydd* ("vaccinet"), inte en oavsiktlig bugg. Men det bevisar att orgnr lagras inkonsekvent → normalisering är ändå rätt. |

### Nya fynd utöver handoffen
- **A. `is_empty` ≠ 0 drabbar ORDRAR, inte bara fakturor.** `/fortnox/enrich/orders` (rad 8556) defaultar `filter_field="ft_net"` och kör `is_empty` (rad 8569). Ordrar med `ft_net=0` hittas aldrig → enrichas aldrig. Det finns en `zero-net`-workaround för *fakturor* men **ingen motsvarande för ordrar**.
- **B. Casing-premissen stämmer inte i koden.** Typen anropas **alltid** `"FortnoxInvoice"` (PascalCase), aldrig lowercase. Bubble är case-*insensitivt* på typslug, så det fungerar. Det är ingen aktiv bugg — men en latent risk (blir Bubble någon gång case-känsligt bryts ~35 anrop samtidigt).
- **C. `bubbleFind` sväljer fel tyst** (rad 1093, `.catch(()=>({}))`). Ett trasigt API-svar blir tom array, inte ett kastat fel → partiella fel ser ut som "inga träffar". Detta är farligt för datakorrekthet.
- **D. Connection-id:n hårdkodade på flera ställen** (F&E på rad 9387 *utan* env-fallback). `CONNECTION_NAMES` (10891) är enda samlade källan men används bara för presentation. Ingen single-source-of-truth.
- **E. Tengella har ingen token-refresh** — login körs per anrop. Annorlunda modell än Fortnox; adaptern måste hantera det.
- **F. emailer.js: `bubbleGet("Avtal", ...)` (rad 511) är odefinierad** (bara injicerad `_bubbleGet` finns) → kastar, fångas tyst → Avtal-titel blir alltid tom i `qc_new`.
- **G. Permanent-felande mailrader retriar var 2:a minut för evigt** (raden förblir `email_sent=false`). Mjuk skena via SendGrid-kvot.

---

## 3. Designdokument — den nya sync-kärnan

### 3.1 Kontrakt (en kärna, källagnostisk)
```
fetchComplete(adapter, ref)      → ALLTID detail-anrop. Aldrig listing. Returnerar komplett rå-post.
buildPayload(source, raw)        → normaliserar till ft_*. Teckenmedveten. Rätt fältmappning. Typad datum-nyckel.
upsertToBubble(payload)          → idempotent på (connection_id, ft_document_number). En funktion.
syncForSource(source, opts)      → listing ger bara REFS → fetchComplete per ref → buildPayload → upsert.
```
Adaptrar: `fortnoxAdapter` (Invoice/Order/Offer), `tengellaAdapter` (Invoice/Workorder).

### 3.2 Hur varje bugg dör i den nya kärnan
| Bugg | Var den fixas |
|---|---|
| 1 (tomma fält) | `fetchComplete` hämtar **alltid detail före upsert** → Net/VAT/refs finns alltid. **Hela enrich-konceptet försvinner.** |
| 2 (fel Tengella-fält) | `buildPayload` i `tengellaAdapter` mappar `InvoiceType`/`TaxReductionType` till rätt/dedikerade fält. |
| 3 (kredit-tecken) | `buildPayload` applicerar tecken från `InvoiceType==="Kredit"` OCH hanterar redan-negativt `TotalAmount`. Net/vat beräknas teckenmedvetet, nollställs aldrig. |
| 4 (enrich-loop) | Enrich raderas. Genuint-noll skrivs en gång, korrekt, skannas aldrig om. |
| 5 (datum) | Se §3.3 — beslut krävs. |
| 6 (orgnr) | Engångsmigration + kanonisk nyckel → `findClientCompanyByOrgNo` blir en query. |

### 3.3 Datum-fixen (beslut krävs — se §6)
Rekommendation: behåll `ft_invoice_date` men lägg till **`ft_invoice_ts` (epoch ms, numeriskt)**. Bubbles *numeriska* constraints är pålitliga (till skillnad från string-datum). Då kan `/kpi/sales` och `/api/invoices` filtrera **serverside** på `ft_invoice_ts >= X AND < Y` istället för att hämta ALLA fakturor och filtrera lokalt. Detta fixar både korrekthet (Bug 5) **och** scaling-problemet (§4).

### 3.4 Verifiering — diff-läge istället för shadow-typ (avviker från handoffen)
Handoffen föreslår en separat shadow-Bubble-typ + 7 dagars parallell skrivning. Jag föreslår istället **`syncForSource(source, {mode:'diff'|'write'})`**:
- `mode:'diff'` → fetchComplete + buildPayload, **jämför mot befintlig Bubble-post, skriver INGENTING, loggar deltan**.
- När diff är ren → `mode:'write'`.

Varför bättre än shadow-typ: noll dubbla skrivningar, ingen fördubblad Bubble-rate-limit-belastning, ingen shadow-data att städa, omedelbar per-post-diff. Samma säkerhet — big-bang undviks lika väl. (Se §6, detta är ett beslut.)

---

## 4. Dold strukturell skuld: scaling

`/kpi/sales` (→ `computeSalesKpi`, rad 10901) och `/api/invoices` (rad 14315) **hämtar ALLA FortnoxInvoice via `bubbleFindAll` vid varje anrop** och filtrerar år lokalt. Varje sådant anrop = (antal fakturor / 100) Bubble-requests. Det växer linjärt med datamängden och slår i 100-cap-paginering hårt. `ft_invoice_ts` + serverside-constraint (§3.3) tar bort detta. Bör vara med i omtaget, inte efteråt.

---

## 5. Pushback på strategin

1. **"index.js < 5000 rader" nås INTE av sync-omtaget.** Sync (Fortnox+Tengella faktura/order/offer) är ~15–20 % av filen. Bulken är MS, Caspeco, Matter/Mail-jobb, Inbjudan/RSVP, KPI, kundportal, emailer. Sätt rätt förväntning: sync-modulen krymper filen måttligt; <5000 kräver att *alla* block extraheras (Steg 6 är egentligen 6 separata extraktioner).

2. **Ordningen bör ändras.** Handoffen kör orgnr-fundament (Steg 1) före faktura-sync (Steg 2). Men:
   - Orgnr-migrationen rör `ClientCompany` → **hög blast-radius**, och blockerar inte fakturakorrekthet.
   - Den **enda kvarvarande reconcile-luckan** är HK -888k = Tengella-mappning (Bug 2+3). Den är **isolerad och lågrisk** att fixa.
   - **Förslag: fixa Tengella-adaptern FÖRST** (högst värde, lägst risk, stänger 888k-gapet) under diff-läge → sedan orgnr-fundament → sedan Fortnox-adapter.

3. **`enrich_zero_net.sh` bör stoppas redan nu**, innan omtaget. Den gör inget nyttigt (server-no-op) men kan skena. Att pausa den i cron är noll-risk och stoppar 13k-onödan omedelbart. (Detta är ej kod — bara att avregistrera cron-jobbet.)

4. **Versionsnumreringen (vNN) bör dö.** Den är ur synk med git och med mig. Använd git-taggar + den fingerprint-sträng som redan finns i scripten (t.ex. `2026-05-31_..._v2`). En källa till sanning.

5. **`bubbleFind` default `limit:1` + tyst fel-svaljning (Fynd C)** är en latent datakorrekthet-bomb oberoende av sync. Värt en liten, isolerad härdning tidigt: default `limit` borttagen/explicit, och låt parse-fel kasta istället för att bli `[]`.

---

## 6. Beslut jag behöver från dig innan Steg 1

1. **Verifiering: diff-läge (§3.4) eller shadow-typ (handoffen)?** Jag förordar diff-läge.
2. **Datum: `ft_invoice_ts`-numeriskt fält (§3.3)?** Kräver ett nytt Bubble-fält + en backfill. Annars kvarstår lokal filtrering + scaling-problemet.
3. **Ordning: Tengella-adapter först (min §5.2) eller orgnr-fundament först (handoffen)?**
4. **Får jag pausa `enrich_zero_net.sh` i cron redan nu (§5.3)?**
5. **Tengella-moms:** ~~standard 25 % antas~~ — **LÖST, se §7.1.**

---

## 7. Beslutslogg & Tengella-adapter design (2026-06-04)

### 7.0 Beslut låsta
| Fråga | Beslut |
|---|---|
| Verifiering | **Diff-läge** — `syncForSource(mode:'diff')` jämför mot Bubble utan att skriva. Inte shadow-typ. |
| Ordning | **Tengella-adapter först** → orgnr-fundament → Fortnox-adapter. |
| Datum | **Lägg till `ft_invoice_ts`** (numeriskt, epoch ms). |
| `enrich_zero_net.sh` | **Pausas** i Render cron-config (Christians åtgärd — ej repo-ändring). |

### 7.1 Moms — LÖST
Live-peek 2026-06-04 visar att Tengellas **detail-svar saknar Net/VAT-uppdelning** (bara `TotalAmount` inkl moms + `TaxReductionAmount`). 25 %-antagandet **behöver inte ersättas** — det är redan validerat: HK Normal-summa (Mira ≈ facit, diff 0,001 %) bygger på `TotalAmount/1.25` och ligger mot bokföringen (15,93 ≈ 15,9 Mkr).

**Handoffens premiss "RUT/ROT har annan momssats" är fel.** RUT/ROT är en inkomstskattereduktion för kunden, inte en annan momssats. Städtjänster har 25 % moms oavsett. RUT-fakturor är `InvoiceType="Normal"` med `TaxReductionType` satt — alltså redan med i den validerade summan. Ingen särhantering av moms.

### 7.2 Tengella-detail — faktiska fält
`/v2/Invoices/{InvoiceId}` returnerar: `InvoiceId, InvoiceNo, TotalAmount, PaidAmount, TaxReductionAmount, TaxReductionType, InvoiceDate, DueDate, Void, InvoiceType, Url`. Listing saknar `DueDate, TaxReductionAmount, TaxReductionType, Url` → **fetchComplete måste hämta detail**, inte bara listing (samma rotorsak som Bug 1 för Fortnox).

### 7.3 Adapter-design

**Källa:** Discovery via `/v2/Invoices` listing (kräver customerId → loopa TengellaCustomer). `fetchComplete` hämtar **alltid** `/v2/Invoices/{InvoiceId}` detail per ref.

**buildPayload (teckenmedveten, ingen guard):**
```
const total = Number(raw.TotalAmount ?? 0);      // SIGNERAT: credits negativa
const net   = Math.round(total / 1.25);          // tecken följer total
const vat   = total - net;                        // tecken följer total
const paid  = Number(raw.PaidAmount ?? 0);
```

**Fältmappning (→ FortnoxInvoice):**
| ft_-fält | Källa | Ändring mot idag |
|---|---|---|
| `connection_id` | TENGELLA_CONNECTION_ID | — |
| `ft_document_number` | `InvoiceNo \|\| InvoiceId` | — |
| `ft_invoice_date` | `toIsoDate(InvoiceDate)` | — |
| `ft_invoice_ts` | epoch ms av InvoiceDate | **NYTT** (Bug 5 + scaling) |
| `ft_due_date` | `toIsoDate(DueDate)` | nu från detail |
| `ft_total` | `total` (numeriskt, signerat) | **idag sträng → numeriskt** |
| `ft_net` | `net` (signerat) | **Bug 3 fixad** |
| `ft_totalvat` | `vat` (signerat) | **Bug 3 fixad** |
| `ft_balance` | `total - paid` (signerat) | numeriskt |
| `ft_currency` | "SEK" | — |
| `ft_ocr` | `Ocr/OCR` | — |
| `ft_cancelled` | `Void === true` | — |
| `ft_url` | `Url` | från detail |
| `ft_invoice_type` | `InvoiceType` | **NYTT dedikerat fält (Bug 2)** |
| `ft_tax_reduction_type` | `TaxReductionType` | **NYTT (Bug 2)** |
| `ft_tax_reduction_amount` | `Number(TaxReductionAmount ?? 0)` | **NYTT** |
| `ft_our_reference` | `""` | **tömt (Bug 2 — Tengella har inget motsv.)** |
| `ft_your_reference` | `""` | **tömt (Bug 2)** |
| `ft_raw_json` | `JSON.stringify(raw)` | nu detail-json |

**Upsert-nyckel:** `connection_id` (=TENGELLA) + `ft_document_number`. Oförändrad.

**Validering (diff-läge):** kör `syncForSource('tengella-invoice', {mode:'diff'})`. Förväntat: HK net-summa jan-apr = **15 928 196** (16 816 584 − 888 388). Avvikelse ≈ 2×888k = teckenmodellen fel.

### 7.4 Öppna punkter (löses i diff-läge, ej blockerande)
- **`ft_net` lagrat = NULL (ej 0)** på nuvarande credits → de skapades troligen inte via netVal=0-grenen (äldre synk-väg). Diff-läget visar exakt vad varje credit ska bli och fångar credits som aldrig synkats.
- **Avrundning på negativt belopp:** `Math.round(-23750.4) = -23750` (mot +∞). Subkrona-asymmetri mot positiva. Vid behov: `sign * round(abs(total)/1.25)`. Försumbart för aggregat.
- **Rör inte `ft_invoice_type`/`ft_tax_reduction_*` befintliga Bubble-fält finns?** Måste skapas i Bubble innan write-läge (annars tyst droppade av Data API).

---

## 8. Generiska sync-kärnan — `invoice_sync.js` (design, ej kod)

### 8.1 Designprincip: normaliserat mellanlager (NIR) — avvikelse från handoffen
Handoffen skissade `buildPayload({source, raw})`. Problemet: då måste `buildPayload` känna till varje källas råformat → en `switch(source)` som växer för varje ny källa. Det bryter mot återanvändningsmålet.

**Istället:** varje adapter översätter sitt råformat till en **kanonisk mellanrepresentation (NIR)**. `buildPayload` tar BARA NIR → `ft_*`. Den är källagnostisk och ändras aldrig när en ny källa läggs till.

```
adapter.fetchComplete(ref) → raw  →  adapter.normalize(raw) → NIR  →  buildPayload(NIR) → ft_*-payload
                                      └ källspecifik (liten)        └ EN funktion, stabil
```

**NIR-form (kanonisk faktura):**
```
{
  documentNumber, connection_id,
  invoiceDate, dueDate,            // Date | null
  total,                           // SIGNERAT tal (credits negativa)
  net, vat,                        // tal | null  (null = härled från total+vatRate)
  vatRate,                         // 0.25 default när net/vat saknas (Tengella)
  paid, balance,
  currency, ocr,
  customerName, customerNumber,
  cancelled,                       // bool
  type,                            // "Normal" | "Kredit" | null
  taxReductionType, taxReductionAmount,   // RUT/ROT
  url, raw                         // PDF-länk + rå-json
}
```

### 8.2 Adapter-interface
Varje adapter (DI-injicerad, som emailer.js) implementerar:
```
{
  source: "tengella-invoice",
  resolveAuth(opts)              → { connection_id, token/accessToken }   // hanterar Tengella-login-per-anrop vs Fortnox-refresh
  iterateRefs(auth, opts)        → async generator av minimala refs       // äger discovery-komplexiteten (Tengella: kunder→fakturor)
  fetchComplete(auth, ref)       → raw (ALLTID detail, aldrig listing)
  normalize(raw, ctx)            → NIR
}
```
Att `iterateRefs` är en async generator låter adaptern kapsla in valfri upptäcktsform: Fortnox = en nivå (paginera `/invoices`), Tengella = två nivåer (loopa `TengellaCustomer` → `/v2/Invoices?customerId`). Kärnan bryr sig inte.

### 8.3 Kärn-funktioner
```
buildPayload(nir) → payload
   net = nir.net ?? Math.round(nir.total / (1 + nir.vatRate))   // härled bara när källan saknar
   vat = nir.vat ?? (nir.total - net)
   // tecken följer nir.total automatiskt; ingen total>0-guard
   returnerar ft_*-objekt inkl ft_invoice_ts = invoiceDate.getTime()

upsertToBubble(payload, { mode }) → { action, changedFields }
   existing = bubbleFindOne("FortnoxInvoice", [connection_id==, ft_document_number==])
   diff = jämför payload mot existing fält-för-fält
   mode==="diff"  → returnera { action: create|update|noop, changedFields } UTAN att skriva
   mode==="write" → existing ? bubblePatch : bubbleCreate

syncForSource(source, { mode="diff", since, ...opts }) → report
   adapter = registry[source]; auth = adapter.resolveAuth(opts)
   for await (ref of adapter.iterateRefs(auth, opts)):
     try { raw=fetchComplete; nir=normalize(raw); pl=buildPayload(nir); r=upsertToBubble(pl,{mode}); acc(r) }
     catch (e) { report.errors.push({ref,e}) }   // per-ref isolering, ingen tyst partiell succé
   return report  // counts + per-record diffs + RECONCILE-TOTAL per connection
```

### 8.4 Diff-läget är verifieringsmotorn
- `mode:"diff"` skriver **ingenting**. Det är säkerhetsgarantin — noll risk att förstöra.
- Rapporten innehåller en **reconcile-total**: `sum(payload.ft_net)` per connection. Vi jämför direkt mot facit i en blick: **HK ska bli 15 928 196**. Fel teckenmodell ger ~2×888k avvikelse omedelbart.
- Per-record-diff (`changedFields: [{field, old, new}]`) visar exakt vad write skulle ändra → vi granskar innan vi flippar till `write`.

### 8.5 Strukturella härdningar som byggs in från start
- **Bubble-helper kastar vid fel** istället för att svälja parse-fel till `[]` (Fynd C). Annars ser diff:en "inga ändringar" ut när API:t egentligen fallerade.
- **Ingen `limit:1`-default** i sök — explicit alltid.
- **Connection-id:n från EN konstantkälla** (Fynd D), inte hårdkodade spritt.
- **Enrich existerar inte** i den nya världen — fetchComplete ger alltid komplett data (dödar Bug 1 + Bug 4 strukturellt).

### 8.6 Inkoppling i index.js (minimal yta tills utfasning)
- Ny route `POST /sync/v2/:source` `{ mode, since }` → `syncForSource`. Inget annat rörs.
- Gamla sync/upsert/enrich-routes + cron lämnas ORÖRDA tills diff visar 100 % → då utfasning (Steg 5).
- När write-läget är validerat: peka om cron till `/sync/v2/*`, ta bort gamla routes.

### 8.7 Återanvändning order/offer/offer/workorder
Motorn (iterate → fetchComplete → normalize → buildPayload → upsert → diff) är identisk. Nya dokumentklasser får egen NIR-form + egen `buildPayload`-variant (faktura/order/offert har olika ft_-fält), men **discovery- och diff-maskineriet återanvänds oförändrat**. Adaptrar: `fortnoxAdapter` (invoice/order/offer), `tengellaAdapter` (invoice/workorder).

### 8.8 Förutsättningar innan write-läge (recap)
Nya Bubble-fält på `fortnoxinvoice`: `ft_invoice_type` (text), `ft_tax_reduction_type` (text), `ft_tax_reduction_amount` (number), `ft_invoice_ts` (number). `ft_total` bör bli numeriskt (är sträng idag).
