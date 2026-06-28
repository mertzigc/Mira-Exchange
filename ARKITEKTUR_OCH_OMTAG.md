# Mira-Exchange — Arkitektur-karta & Designdokument

> Detta dokument är djupdesign och beslutsmotivering. Operativ status (PÅGÅR/KLART/etc) per spår läses i `HANDOFF.md`.
>
> **Scope:**
> - §1-9 Sync-omtag (Fortnox/Tengella → Bubble för fakturor/ordrar/offerter/workorders). Designfas slutförd 2026-06-04, omtaget LIVE 2026-06-08. Operativ status: HANDOFF §0.
> - §10 Tjänste-grid + abonnemangsmodul (kund-dashboard + admin-modul + avtals-lifecycle). Bygge påbörjat 2026-06-28. Operativ status: HANDOFF §0f (live-delar) + §0g (pågående).
>
> Källa: full läsning av `index.js`, `emailer.js`, cronscript samt avtalsgenomgång (`Avtal från Carotte/`).

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

---

## 9. Order / Offer / Workorder — designdesign (2026-06-05)

### 9.1 Vad auditen visar (utgångsläge)
| | Fortnox Order | Fortnox Offer | Tengella Workorder |
|---|---|---|---|
| Detail-endpoint | `/orders/{n}` | `/offers/{n}` | **finns ej** — bara `/v2/WorkOrders` listing |
| Rader i detail? | Ja (`OrderRows`) | Ja (`OfferRows`) | Ja, **inbäddade i listing** (`WorkOrderRows`) |
| Net/TotalVAT på huvud | Ja (i detail) | Ja (i detail) | **Nej** — huvudet är icke-ekonomiskt |
| Ekonomi på rad | Price/Discount/VAT/Total | Price/Total | Price/CostPrice (ingen moms) |
| Discovery | listing (page) | listing (page) | listing **global** (ingen kund-loop) |
| PDF | finns ej (Fortnox `/orders/{n}/preview` funkar) | `/offers/{n}/preview` (byggt) | — |
| Bubble-typ | `FortnoxOrder` + `FortnoxOrderRow` | `FortnoxOffer` + `FortnoxOfferRow` | `TengellaWorkorder` + `TengellaWorkorderRow` |
| Nyckelfält connection | **`connection`** | **`connection`** | (snake_case, ingen prefix) |

**Gemensamma brister i nuvarande kod (att fixa i nya adaptern):**
1. **Borttagna rader städas ALDRIG** — alla tre gör bara create/update på inkommande rader. Ändras ett dokument blir gamla rader kvar som spökrader. **Detta är den största kvalitetsluckan.**
2. **Net/TotalVAT sätts inte på order-huvudet** (direct-upsert matas med listing utan detail → samma Bug 1 som faktura hade).
3. Radbelopp lagras som strängar; två olika unique-key-format (Order vs Offer); `connection` vs `connection_id`-inkonsekvens.
4. Ingen fil-GC: varje PDF-omskrivning läcker den gamla filen i Bubble-lagringen.

### 9.2 Kärn-utbyggnad: dokument MED rader (children)
Fakturakärnan hanterar ETT record per dokument. Order/offer/workorder kräver **dokument + rader**. Generalisering av `invoice_sync.js`:

- Varje adapter deklarerar nu: `bubbleType` (t.ex. `"FortnoxOrder"`), `keyFields` (t.ex. `["connection","ft_document_number"]`), och valfritt `rows`-config.
- `normalize` returnerar NIR med valfri `rows: [...]` (array av rad-NIR).
- Ny `upsertDocWithRows(payload, rows, {mode})`:
  1. Upserta huvudet (som idag) → få parent `_id`.
  2. Hämta **alla befintliga rader** för parent (via parent-relation).
  3. Upserta varje inkommande rad (nyckel = stabil unik nyckel, se nedan).
  4. **Radera rader vars nyckel saknas i nya setet** (set-reconciliation) → fixar lucka #1.
- I `diff`-läge: skriver inget, rapporterar tänkta create/update/**delete** per rad.

**Rad-unik-nyckel:** alltid källans rad-id när det finns — `RowId` (Fortnox), `WorkOrderRowId` (Tengella). Saknas RowId (kan hända för Fortnox-orderrader) → fallback `parentdoc#index`, men den är positionskänslig; flaggas i rapport. Stabil rad-id är förutsättning för pålitlig delete-reconciliation.

### 9.3 Adapter-specar
**`fortnox-order` / `fortnox-offer`** (nästan identiska):
- `resolveAuth` = som fortnox-invoice (ensureAccessToken + throttle + retry).
- `iterateRefs` = paginera `/orders` resp `/offers` (page + `@TotalPages`), eller `lastmodified` för nightly. Datumfönster `fromdate/todate`.
- `fetchComplete` = **detail** (`/orders/{n}` / `/offers/{n}`) → ger huvud + Net/VAT + rader. (Fixar Bug 1 för order/offer.)
- `normalize` → NIR med huvudfält (net/vat från Fortnox, korrekt signerat), `ft_*_ts` (numeriskt datum), referensfält bevaras, + `rows[]`.
- `buildPayload` återanvänds (NIR→ft_*). Belopp som matchar befintlig fälttyp (se 9.5).
- Reconcile: summera `ft_net` per connection (validera mot Fortnox order/offer-totaler, som faktura).

**`tengella-workorder`** (avviker):
- Ingen detail — `iterateRefs` paginerar `/v2/WorkOrders` **globalt** (cursor), raderna finns inbäddade.
- `fetchComplete` = pass-through (returnera listing-raden; rader redan med).
- `normalize` → huvud (icke-ekonomiskt: beskrivning, noter, datum, `is_deleted`) + `rows[]` (price/cost, ingen moms).
- **Ingen revenue-reconcile** (workorders är operativa, inte intäkt; intäkten är Tengella-fakturan). Ev. sanity: summera radpriser.
- Kundupplösning: read-only i diff, full (med ClientCompany-ensure) i write — som faktura.

### 9.4 PDF — för offer OCH order (Christians nya önskemål)
Mönstret är redan generiskt och bevisat (faktura + offer): `fortnoxGetBinary(path)` → `bubbleUploadFile` → patcha `ft_pdf` + `ft_pdf_fetched_at` + `needs_pdf_sync=false`.
- **Order:** ny `fetchAndStoreOrderPdf` mot `/orders/{n}/preview` (kopia av offer-helpern). Använd `/preview`, INTE `/print` (print markerar dokumentet utskrivet i Fortnox = sidoeffekt).
- **Frikopplat flöde:** synken sätter `needs_pdf_sync=true` på create/ändring; en **separat PDF-cron** betar av flaggade i egen takt (som offer gör idag). Skäl: PDF-volymen är stor och ska inte sakta ner eller riskera huvudsynken. Kan pausas oberoende.
- **Retention (Christians "kasta efter X tid"):** `ft_pdf_fetched_at` finns redan. En framtida cleanup-cron kan nolla `ft_pdf` för dokument äldre än X. **Öppen fråga:** Bubble raderar inte själva filen när man nollar fältet (ingen publik file-delete i Data API) → äkta lagringsfrigöring kräver en **Bubble backend-workflow `delete_file`** som vi anropar. Annars frigörs inte utrymmet, bara pekaren tas bort. Beslut om retention tas separat; lagring nu, GC-mekanik senare.

### 9.5 Datatyp-beslut (lärdom från faktura)
- **Behåll befintliga fältnamn per typ** (`connection` på order/offer, inte `connection_id`) — annars bryts Bubble-UI-referenser. Inkonsekvensen är kosmetisk; migrera ej nu.
- **Radbelopp:** matcha befintlig Bubble-fälttyp (strängar idag) för att undvika `INVALID_DATA` (samma som `ft_total` på faktura). KPI summerar inte radnivå, så numeriskt krävs ej. Lägg ev. `ft_*_ts` (number) på huvudet för pålitlig datumfiltrering.
- **Nya huvud-fält att skapa i Bubble:** `ft_order_ts`/`ft_offer_ts` (number) på FortnoxOrder/Offer; ev. `needs_pdf_sync`/`ft_pdf`/`ft_pdf_fetched_at` på FortnoxOrder (Offer har dem).

### 9.6 Beslut (låsta 2026-06-05)
1. **UnifiedOrder UTFASAS.** Ersätts av unifierad FortnoxOrder (se 9.8). Frontend anpassas.
2. **Workorder → FortnoxOrder** (connection = Tengella/HK), speglar Tengella-faktura → FortnoxInvoice. En ordermodell över alla bolag. Operativa workorder-fält bevaras i `ft_raw_json`. Verifiera att frontend inte läser strukturerade `TengellaWorkorder`-fält innan den typen pensioneras.
3. **Offert-wrapper BEHÅLLS** för offer (Mira-native författaryta). Förbered both-ways: NIR som pivot, round-trip-bara offer-rader (artikelnr/antal/pris), solid FortnoxOffer↔Offert-länk. Ingen order-wrapper ännu.
4. **PDF-retention:** lagra allt nu, TTL/GC senare (kräver Bubble `delete_file`-workflow).

### 9.8 Unifierad ordermodell (ersätter UnifiedOrder)
Som FortnoxInvoice rymmer alla fakturakällor rymmer **FortnoxOrder alla orderkällor**:
- Fortnox F&E/Staff-ordrar (connection = resp. Fortnox-id) — detail-fetch ger net/vat/rader.
- HK-workorders (connection = TENGELLA) — listing ger rader inbäddade; huvud icke-ekonomiskt → härled `ft_total` = Σ(pris×antal) från rader, net via 25% (som HK-faktura) om vi vill ha jämförbar siffra; markera att order ≠ intäkt i KPI.
- Rader → **FortnoxOrderRow** (en radtyp): mappa item_no→article, item_name→description, quantity, price; workorder-extra (cost_price, invoice-status, arbetstider) i `ft_raw_json`.
- `source`-fält på FortnoxOrder (`"fortnox"` / `"tengella-workorder"`) för spårbarhet.

### 9.9 Both-ways-förberedelse (offer push, framtid)
NIR är pivoten åt båda håll:
- **Läs (nu):** `Fortnox → fetchComplete → normalize → NIR → buildPayload → Bubble`.
- **Skriv (senare):** `Mira Offert → buildNIR → buildFortnoxPayload → POST /offers → DocumentNumber → länka FortnoxOffer↔Offert`.
Krav som byggs in redan nu så push blir möjlig utan omskrivning: (a) offer-rader lagrar artikelnr/antal/pris/enhet komplett; (b) `Offert`↔`FortnoxOffer`-länk via deal_id hålls solid; (c) inga destruktiva fält-överskrivningar på Mira-authored offerter som ännu inte pushats (en `source`/`origin`-flagga skiljer Mira-skapade från Fortnox-synkade).

### 9.7 Föreslagen byggordning
- **9a** Kärn-utbyggnad: `bubbleType`/`keyFields` per adapter + `upsertDocWithRows` med delete-reconciliation. (Faktura oförändrad — den får tomt rows-config.)
- **9b** `fortnox-order` + `fortnox-offer` (huvud + rader), diff → scoped write → full write → reconcile mot Fortnox.
- **9c** PDF: generisk `fetchAndStoreOrderPdf` + flaggat PDF-flöde + PDF-cron (order + offer; verifiera faktura-PDF ostörd).
- **9d** `tengella-workorder` (global discovery, inbäddade rader, icke-ekonomiskt huvud).
- **9e** Cron: lägg order/offer/workorder + PDF i `sync_v2_cron.sh` (nightly modified + full).
- Genomgående samma kvalitetsgrind som faktura: diff-läge bevisar innan write, reconcile validerar.

---

## 10. Tjänste-grid + abonnemangsmodul — designdokument (2026-06-28)

### 10.1 Kontext
Helt annat spår än §1-9. Inget sync-jobb — vi bygger Carottes affärslogiklager för abonnemang.

- **Live sedan 2026-06-28 (HANDOFF §0f):** kund-facing tjänste-grid på Mira-dashboard. Tiles per Office, popup-detalj, Mira-abonnemang som account-scope. `/services/dashboard` + `/services/request-activation`.
- **Bygge påbörjat 2026-06-28 (HANDOFF §0g):** admin-modul för Carotte att administrera kundernas Contracts, plus auto-koppling från OfferApproval Approved → Contract skapas → tile tänds. Två tilläggsfeatures i samma spår: PDF-import av befintliga avtal (LLM-parsning) och PDF-generering från avtalsmall som auto-skickas in i OfferApproval-flödet.

Detta kapitel = designprinciper, datamodell och flöden. Operativa faser, fält-listor och teststeg lever i HANDOFF §0g.

### 10.2 Konceptuella avtalstyper

Avtalsgenomgång 2026-06-28 (HK x EA, Staff x Scandic Bemanning, Scandic Master Resource Consultancy m.fl. i `Avtal från Carotte/`) avslöjade att Carottes avtal inte är ETT koncept utan minst tre:

| Typ | Exempel | Pricing | Auto-Contract vid signering? |
|---|---|---|---|
| **Subscription** | HK x EA (188 282 SEK/mån + Cleaning Index) | Fast månadskostnad + indexreglering | JA |
| **RateCard** | Staff x Scandic Bemanning | Roller × kr/h, OB-tillägg, ingen månadskostnad | NEJ (manuellt skapas) |
| **Hybrid** | T.ex. Reception med fast bas + tilläggsdebitering | Båda | Beroende på flagga |
| **One-off Offer** | F&E offerter idag | Per uppdrag, ingen subscription | NEJ — lever som Erbjudande + OfferApproval, fakturerat uppdrag, ingen Contract skapas |

**Konsekvens:** ett platt `monthly_cost`-fält räcker inte. Contract-typen i Bubble måste rymma både fast månadssubscription och rate-card. F&E-tile-statusen kan inte bero på Contract — den härleds från senaste FortnoxOrder.

### 10.3 Datamodell

**Princip:** Contract är persistent, OfferApprovalRequest är transient. Carotte fyller spec på OfferApprovalRequest vid skapande, motorn skapar N Contracts vid Approved. Bilagor (Floor Plan, KPI/SLA, Onboarding…) lever som separata Dokument-rader länkade från Contract så de kan revideras (t.ex. Price List efter indexreglering) utan ny signering av huvudavtalet.

**Contract (Bubble-typ, utökas Fas 1):**
- Befintliga: `Kundföretag` / `erbjudande` / `Kontor` / `Produktantal` / `Månadskostnad` / `Slutdatum` / `kategori`. Inkonsekvent case bevarad för bakåtkompat (`Kundföretag` cap, `erbjudande` lower). `Produktantal` avvecklas till förmån för strukturerat `volume_json`. `kategori` blir härledbart från Erbjudande.Category men behålls tills frontend rivit beroendet.
- Nya: ~17 fält som ger livscykel, kontraktstyp, prisreglering, bilagor, signaturspårning och bakåtspårning. Fullständig fält-lista per typ i HANDOFF §0g (inte duplicerad här — single source).

**OfferApprovalRequest (Bubble-typ, utökas Fas 1):**
- `contract_template_json` (text/long): JSON-array av Contract-specs som ska skapas vid Approved. En signering kan ge flera Contracts (Scandic-mönstret: ramavtal som täcker fler tjänster).
- `auto_create_contract` (yes/no, default yes): safety-valve mot oönskad auto-create per process.

**ContractTemplate (ny Bubble-typ, skapas Fas 5):**
- `template_html` (text/long): Handlebars-stiliserad HTML, A4-mall (samma teknik som `approval-cert.template.html`).
- `category` (option set, samma som FORFRAGAN.SUPPLIER_BY_CATEGORY-nycklarna): Food & Event / Staff / Housekeeping / Other facility services.
- `contract_type` (option set, samma som Contract.contract_type): Subscription / RateCard / Hybrid.
- `version` (number) + `superseded_by` (ContractTemplate, valfri): versionerad — ett aktivt utkast (draft) frusen mot specifik version, ny version skapas vid mall-revidering, draft påverkas inte.
- `name` + `subtitle` + `default_spec_json` (text/long): pre-fill för `contract_template_json` (typ "3 mån uppsägning, Cleaning Index för HK").

**Bilagor:** `Contract.attachments` är List of Dokument. En Dokument-rad har redan PDF-fil-fält (befintligt schema). Vid PDF-import laddar Carotte upp huvuddokumentet + valfria bilagor separat. Vid template-generering bifogar Carotte bilagor i admin-formuläret innan PDF-render — varje bilaga blir egen Dokument-rad och kopplas till Contract via `attachments`.

### 10.4 Lifecycle-flöde

Komplett kedja från kund-aktivering till tile-aktivering. Befintligt fett, nya hooks `[NYTT]`:

```
Kund klickar "Aktivera" på tile (kund-dashboard)
   │
   │ /services/request-activation (LIVE)
   ▼
Comission skapas (källagnostisk, sätter Comission.lead/Deal i sin tur)
   │
   │ [NYTT — Fas 2/3]
   ▼
Carotte ser aktiveringen i admin (Comission med source="Mira")
   │
   │ Carotte bygger offert/avtal — TVÅ vägar:
   │
   ├─── (a) PDF-import [Fas 4]                ─── (b) Template-generering [Fas 5]
   │    Drag-drop befintlig PDF                    Välj ContractTemplate (HK/Reception/Staff)
   │    /admin/contract/import                     Pre-fyll spec från template-defaults
   │    pdf-parse + Anthropic Haiku 4.5            Carotte fyller kundspecifika fält
   │    Strukturerad JSON tillbaka                 Bilagor (Floor Plan, KPI/SLA…)
   │    Carotte granskar i review-form             Render HTML → puppeteer-PDF
   │    Contract skapas DIREKT                     POST /approval/create
   │    (signerat redan — skipping OfferApproval)
   │                                                Standard OfferApproval-flödet
   │                                                Granskare + signers + OTP
   │                                                Signering → /approval/confirm
   │                                                _checkAndCompleteRequest
   │                                                  │
   │                                                  │ status="Approved" [BEFINTLIGT]
   │                                                  │
   │                                                  │ [NYTT — Fas 1, sektion 10.5]
   │                                                  ▼
   │                                                _createContractsFromApprovalRequest
   │                                                  Läs contract_template_json
   │                                                  För varje Subscription-spec → bubbleCreate Contract
   │                                                  RateCard/Hybrid skipas (manuella)
   │                                                  │
   ▼                                                  ▼
Contract finns i Bubble (signed_pdf + signed_at + offer_approval bakåtspårning)
   │
   │ Bekräftelsemail till signers + reviewers [BEFINTLIGT]
   │
   │ Nästa /services/dashboard-anrop från kund-frontend
   ▼
_buildServicesDashboard hittar Contract med Slutdatum > now
   │ Härleder status (_deriveContractStatus)
   │ Returnerar entry med { status, contract_id, contract_type, end_date }
   ▼
Tile tänds som AKTIV i kundens browser. Status-pill differentierad per kontraktstyp.
```

**Lifecycle-statusar (frontend härled-bara, ingen ny enum-typ behövs):**
- `Förslag` — ingen Comission finns för kombinationen (kund, slug, kontor)
- `Förfrågan` — Comission finns, status ≠ Avslutad, ingen OfferApprovalRequest
- `Offert` — OfferApprovalRequest finns, status ≠ Approved
- `Aktiv` — Contract finns, Slutdatum > now
- `Utgår snart` — Contract finns, Slutdatum − now ≤ 30d
- `Avslutad` — Contract finns, Slutdatum ≤ now
- `Pausat` / `Vilande` / `Tvistig` — Contract.status_override satt

### 10.5 Auto-Contract-hook (Subscription only)

**Hook-punkt:** `_checkAndCompleteRequest` direkt efter `bubblePatch("OfferApprovalRequest", id, {status:"Approved"})`, FÖRE bekräftelsemail. Inte i `/approval/confirm` eller `/approval/review` separat — den centrala completion-helpern är den enda code-path där processen verkligen blir helt klar (sista signer ELLER sista reviewer triggar).

**Idempotens:** läs alla Contract där `offer_approval == parent._id`. Om count > 0 → skip helt. Skydd mot retry vid Approved-status (samma princip som `_checkAndCompleteRequest`s egen idempotens på `parent.status === "Approved"`).

**Safety-valve:** om `parent.auto_create_contract === false` (eller "no") → skip. Carotte kan stänga av per process i skapande-UI:t. Default = yes.

**Kontraktstyp-filter:** loopa `contract_template_json`-array. Bara specs med `contract_type === "Subscription"` skapas auto. RateCard + Hybrid hoppas över med log — de kräver manuell granskning i admin-blocket (Fas 2-3) eftersom prislogik + bemanningsåtagande behöver mänskligt öga.

**Mjuk-fel:** auto-Contract felar ALDRIG Approval-flödet. Try/catch runt hook-anropet, fel loggas som warning, bekräftelsemail går ut ändå. Carotte kan skapa Contract:et manuellt om det fallerat.

**Fält-mappning spec → Contract:** spec.field → SERVICES.CT_*-konstanter (case-sensitivt mot Bubble). volume_json/rate_card_json konverteras till JSON-sträng om de skickas som objekt (Bubble vill ha sträng på text-fält). Null-fält droppas från payload så Bubble behåller defaults.

### 10.6 Status-härledning

`_deriveContractStatus(contract, nowMs)` är ren funktion utan side-effects, returnerar enum-string. Anropas i `_buildServicesDashboard` så frontend slipper räkna själv.

**Logik (prioritetsordning):**
1. Om `contract.status_override` är satt → returnera den (pausat/vilande/tvistig).
2. Annars läs `Slutdatum`. Saknas → `aktiv` (öppet avtal utan slutdatum).
3. Slutdatum < now → `avslutad`.
4. Slutdatum − now ≤ 30d → `utgar_snart`.
5. Annars → `aktiv`.

**Tile-rendering kontraktstyp-differentierad** (frontend, Fas 3):
- Subscription aktiv: `Aktiv — 188 282 kr/mån`
- RateCard aktiv: `Aktivt ramavtal — 10 roller`
- Båda utgår snart: `Utgår 30 nov` (gul border)
- F&E (offert-baserad, ingen Contract): `Senast: Sommarfest 12 maj` om FortnoxOrder.delivery_date ≤ 6 mån

### 10.7 PDF-import-spår (Fas 4)

**Mål:** snabbt få in Carottes befintliga kundbas i Contract-modellen utan att skriva av varje avtal manuellt.

**Pipeline:**
```
Carotte: drag-drop befintlig avtals-PDF i admin-block
   ↓
POST /admin/contract/import (multipart, x-admin-token)
   ↓
pdf-parse extraherar all text + sid-positioner
   ↓
Anthropic Haiku 4.5 + system-prompt "extrahera Carotte-avtalsfält"
   ↓ tool-use för structured output (JSON Schema-grindad)
   ↓
Strukturerad JSON tillbaka (kontraktstyp, månadskostnad, datum, bindning, prisreglering, volym, rate-card)
+ parsed_confidence_json (per-fält säkerhetsindikator)
   ↓
Render returnerar draft + originalet sparas som Dokument-rad i Bubble
   ↓
Carotte ser draft i editable review-form (HTML-block)
+ varje fält visar parsed value + LLM-säkerhet (chip "98%" eller "låg")
+ klick på fält visar PDF-sidan där värdet hittades (deep-link via sid-position)
   ↓
Carotte granskar, rättar, godkänner → "Skapa Contract"
   ↓
Contract skapas DIREKT (status = aktivt, signed_pdf = uppladdade originalet, parsed_confidence_json sparas för audit)
SKIPPING OfferApproval — det är redan signerat
```

**Säkerhet:**
- LLM kan halucinera siffror. Carotte MÅSTE granska varje fält. UI tvingar review innan "Skapa Contract"-knappen aktiveras.
- `parsed_confidence_json` lagras för audit ("hur säker var LLM:n på detta värde när det importerades?").
- Bilagor (Floor Plan, KPI/SLA) parsas INTE — bildrika PDF:er kostar för mycket att skicka till LLM och ger osäkra resultat. Carotte laddar upp bilagor separat efteråt som Dokument-rader i Contract.attachments.

**Modellval:** Haiku 4.5 (`claude-haiku-4-5-20251001`). Snabbt, billigt, bra på structured extraction. ~3-5k input tokens + ~1-2k output tokens per avtal = försumbar kostnad. Sonnet/Opus är overkill för fält-extraktion.

**Anthropic SDK:** `@anthropic-ai/sdk` läggs till i `package.json`. ENV `ANTHROPIC_API_KEY` sätts på Render.

### 10.8 Template-spår (Fas 5)

**Mål:** skapa nya avtal från strukturerade mallar med variable substitution, generera A4-PDF, skicka in i OfferApproval-flödet, auto-Contract vid signering.

**Pipeline:**
```
Carotte: "Skapa nytt avtal"-knapp i admin-block (kundkort eller global vy)
   ↓
Välj ContractTemplate (HK Subscription / Reception Subscription / Staff RateCard / …)
   ↓
Render: GET /admin/contract/template/:id → template_html + default_spec_json
   ↓
Pre-fyll formulär med template-defaults (3 mån uppsägning, Cleaning Index, …)
   ↓
Carotte fyller kundspecifika fält: månadskostnad, yta, kontaktpersoner, startdatum, bilagor
   ↓
POST /admin/contract/render-preview {template_id, spec, attachments_ids}
   ↓
Render: Handlebars-substitution i template_html med spec-värden
   ↓
puppeteer-core renderar HTML → PDF
+ pdf-lib mergar in bilagor-Dokument bakom huvuddokumentet (samma teknik som approval-cert)
   ↓
Returnera PDF-preview i iframe — Carotte granskar visuellt
   ↓
"Skicka för signering" → POST /approval/create med renderad PDF som dokument + recipients
+ contract_template_json sätts på OfferApprovalRequest med spec som ska bli Contract vid Approved
   ↓
Standard OfferApproval-flödet tar över
   ↓
Vid Approved: auto-Contract via Fas 1-hook (sektion 10.5)
```

**Mall-strategi:**
- 3 default-mallar i Fas 5: HK Subscription, Reception Subscription, Staff RateCard.
- **Extraheras från befintliga avtal i `Avtal från Carotte/`** — EA HK-avtalet är 99% färdigt som template. Variabler injiceras där hårdkodade värden står (EA → `{{client_name}}`, 188 282 → `{{monthly_cost}}`, etc.).
- Mallarna versioneras (`ContractTemplate.version` + `superseded_by`). Befintligt utkast (draft som ännu inte skickats) är pinnat till specifik version. Ny version påverkar bara framtida utkast.
- Mallar är HTML, inte Word-mallar. Det gör branding-kontrollen tight och eliminerar konverteringsrisker.

**Återanvändning:** `puppeteer-core` + `@sparticuz/chromium` + `pdf-lib` finns redan installerade för signeringsbeviset. Samma engine för Contract-PDF.

### 10.9 Beslut låsta (2026-06-28)

1. **Full scope, inte MVP.** Subscription + RateCard + Hybrid + F&E (offert-baserad). Anledning: kundvolym + framtida F&E-abonnemang gör att MVP-vägen skapar arkitekturskuld.
2. **Contract-typen utökas i Bubble** med ~17 nya fält + 3 nya Option Sets. Lista i HANDOFF §0g.
3. **Bilagor som separata Dokument-rader** (Floor Plan, KPI/SLA, Onboarding…), list på Contract. Redigerbara separat utan ny signering — kritiskt för avtal med Cleaning Index-revisioner som ändrar Appendix 4 utan att huvudavtalet rörs.
4. **F&E-tile är "aktiv"** om senaste FortnoxOrder.delivery_date ≤ 6 månader. Ingen Contract krävs för F&E. Ändras när F&E-abonnemang lanseras (då skapas Subscription Contract på vanligt sätt).
5. **PDF-import via Anthropic Haiku 4.5 + structured tool-use.** Carotte granskar parsed JSON innan Contract skapas. `parsed_confidence_json` sparas för audit.
6. **ContractTemplate som ny Bubble-typ** (Fas 5). Default-mallar extraheras från `Avtal från Carotte/`.
7. **Auto-Contract vid Approved** körs i `_checkAndCompleteRequest`, bara om `contract_type === "Subscription"` och `auto_create_contract != "no"`. RateCard + Hybrid kräver manuell skapande i admin-blocket (säkerhetsmarginal — prislogik och bemanningsåtagande behöver mänskligt öga).

### 10.10 Föreslagen byggordning (5 faser)

Detaljer + operativ status per fas finns i HANDOFF §0g. Kort summary här:

| Fas | Vad | Kärnleverans |
|---|---|---|
| 1. Fundament | Bubble-schema-utbyggnad + `_createContractsFromApprovalRequest`-hook + status-härledning i `_buildServicesDashboard` | Auto-Contract fungerar för Subscription, tile får härledd status |
| 2. Admin-block | Kundkort-flik "Abonnemang" + global "Alla abonnemang"-vy. Manuell create/edit/end + bilagor | Carotte produktivt verktyg innan resten är klart |
| 3. RateCard + Hybrid + F&E | Kontraktstyp-väljare i admin, RateCard-formulär, F&E-tile-logik (FortnoxOrder.delivery_date ≤ 6 mån) | Komplett täckning av alla avtalskoncept |
| 4. PDF-import | `pdf-parse` + Anthropic Haiku 4.5 + review-UI + Contract skapas direkt | Snabb on-boarding av befintlig kundbas |
| 5. Template + PDF-generering | `ContractTemplate`-typ + 3 default-mallar från `Avtal från Carotte/` + puppeteer-render + `/approval/create`-koppling | Helt skapa-skicka-signera-aktivera-pipeline |

Sekventiellt, inte parallellt — varje fas testbar isolerat innan nästa börjar. Total ~17-24 kod-dagar + Bubble-schema + Carotte-test = ~4-6 veckor kalendertid.

### 10.11 Synk mot sync-omtagets principer

Tjänste-grid-koden följer designprinciperna från §3.4, §8.5 och §1.5:

| §-referens (sync) | Princip | Tjänste-grid-tillämpning |
|---|---|---|
| §3.4 | Diff-läge istället för shadow-typ för verifiering | `?debug=1` på `/services/dashboard` returnerar `fas1_schema_check` (present/missing-fält per Contract) + per-contract dump utan write. Samma andas: verifiering utan side-effects. |
| §8.5 | Bubble-helper kastar vid fel istället för att svälja till `[]` | `_createContractsFromApprovalRequest` loggar synligt vid fel, kastar inte tyst. Felar mjukt mot Approval-flödet (try/catch + warning), men inom hook-funktionen själv är felhantering explicit. |
| §1.5 | `bubbleFind` default `limit:1` är fotgevär | Vi använder `bubbleFindAll` för idempotens-check (`Contract.offer_approval == parent._id`) och för dashboard-listning. Aldrig `bubbleFind` med default limit. |
| §8.5 | Connection-id:n från EN konstantkälla | `SERVICES`-konstanten är vår single source för Contract/OfferApprovalRequest-fältnamn. Allt case-sensitivt går via `SERVICES.CT_*`/`SERVICES.OAR_*`. |
| §8.6 | Minimal yta tills utfasning — nya routes utan att röra gamla | Fas 1 lägger till `_createContractsFromApprovalRequest` + status-härledning utan att riva något. `_checkAndCompleteRequest` får en mjuk hook (try/catch, non-fatal). Befintligt OfferApproval-beteende oförändrat. |

### 10.12 Öppna frågor

- **Retention på Contract.signed_pdf:** samma file-GC-problem som §9.4. Bubbles Data API har ingen file-delete, så att nolla `signed_pdf` frigör inte lagring — bara pekaren. Beslut om retention tas senare; lagring nu, GC-mekanik via Bubble backend-workflow `delete_file` om/när det blir nödvändigt.
- **ContractTemplate.version vs aktiva utkast:** mitt förslag är pin per draft (sparas mot specifik version), ny version skapas vid mall-revidering, draft påverkas inte. Alternativ: rebase draft mot senaste version (riskerar att Carotte arbetar med en spec som ändras under fötterna). Beslut tas i Fas 5.
- **F&E-tile-regeln 6 mån:** ska vara konfigurerbar per ServiceCatalog-rad (nytt fält `active_window_months`) eller global konstant? Förslag: global tills någon kategori kräver något annat. Spara inte komplexitet på framtid.
- **Multi-Office signering:** kan `contract_template_json` ha specs med olika `office_id` i samma OfferApprovalRequest? Tekniskt JA (auto-hook loopar alla specs oavsett office). UX-fråga: ska Carotte få bygga sådana i admin-blocket eller är one-spec-per-request MVP? Beslut tas i Fas 2.
- **RateCard-fakturering:** när Comission läggs för en kund med aktivt RateCard-Contract, ska prislogiken auto-fylla rad-priser från `rate_card_json`? Spår för Fas 3 — kräver Comission-koppling mot Contract via Office/kategori.
- **`Produktantal`-avveckling:** nya fältet `volume_json` är strukturerat och rikare. Frontend (kund-tile, admin-vy) måste först läsa `volume_json` parallellt, sedan kan `Produktantal` strykas. Tidpunkt: Fas 2 (admin-block migrerar UI:t).
- **`kategori`-avveckling på Contract:** Erbjudande.Category är single source. Contract.kategori är duplikat. Avveckling i Fas 3 när frontend härleder från relationen. Risk: Erbjudande utan Category → Contract utan kategori → måste vara explicit fel-hantering.
