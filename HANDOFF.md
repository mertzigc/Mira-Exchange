# HANDOFF — Mira-Exchange sync-omtag

> Senast uppdaterad 2026-06-05. Läs detta + `ARKITEKTUR_OCH_OMTAG.md` (§1–9) för full kontext.
> Syfte: ny session ska kunna ta vid exakt här. Djupdesign finns i ARKITEKTUR_OCH_OMTAG.md.

---

## 0. TL;DR — var vi står
- **Fakturaspåret är KLART, validerat krona-för-krona och självgående** (cron live). F&E/Staff/HK 2026 stämmer exakt mot Fortnox/facit.
- **Steg 9a (kärn-utbyggnad för rader) är KODAT + lokalt testat (2026-06-05).** Generaliserad upsert (adapter.bubbleType/keyFields), ny `upsertDocWithRows` med delete-reconciliation (städar spökrader), `bubbleDelete` injicerad. Faktura-adaptrar har tomt rows-config → enkel-dokument-vägen, oförändrad. **Väntar: Christian pushar → diff-revalidering av HK/F&E/Staff (måste vara noop-dominerat) innan vi går vidare.**
- **NÄSTA konkreta kodsteg: 9b** — `fortnox-order` + `fortnox-offer`-adaptrar (huvud + rader) ovanpå 9a-kärnan.
- Efter order/offer/workorder: **ClientGroup-fasen** (kundkort-bundling).

---

## 1. Arbetssätt & miljö (viktigt)
- **Deploy:** Christian pushar själv (`git push origin main`) → Render auto-deployar från `main`. Claudes tool-shell saknar git-credentials OCH env-vars → kan committa lokalt men inte pusha/trigga. Claude ger curl-kommandon, Christian kör dem.
- **Repo:** `/Users/christianmertzig/Documents/GitHub/Mira-Exchange` (GitHub: `mertzigc/Mira-Exchange`, branch `main`).
- **Bubble Data API base:** `https://mira-fm.com` (default i index.js). Live-frontend: `mira-fm.com`. Render-tjänst: `https://mira-exchange.onrender.com`.
- **Auth mot `/sync/v2`:** kräver BÅDE `x-api-key: $KEY` (= MIRA_RENDER_API_KEY på Render) OCH `x-sync-secret: $SYNC_SECRET`. En GLOBAL `requireApiKey`-middleware körs före route-auth.
- **Christians shell-vars** (interaktiva, ofta EJ exporterade): `KEY`, `HOST`, `SYNC_SECRET`, `BUBBLE_API_KEY`, `MIRA_RENDER_API_KEY`. Curl funkar (in-shell-expansion) men `bash script.sh` ser dem ej om de inte exporteras → mappa in på raden vid lokal scripttest.
- **Kommunikation:** svenska, direkt + pushback. Raka quotes (inte smart-quotes). Heredoc (`<<'PYEOF'`) ej `python3 -c`. **INGA `#`-kommentarsrader i klistrade shell-block** (zsh utan interactive_comments kör dem som kommando → `unknown file attribute`). Bubble är case-sensitive på fältnamn.

---

## 2. Arkitektur (sync-kärnan)
**Fil: `invoice_sync.js`** — DI-injicerad från index.js (som emailer.js). NIR-baserad (Normalized Intermediate Representation) generisk kärna.

Flöde: `adapter.iterateRefs → fetchComplete (ALLTID detail) → normalize → NIR → buildPayload → upsertToBubble (diff|write)`.

- **NIR** = källagnostisk kanonisk modell. Varje adapter har liten `normalize(raw)→NIR`; `buildPayload(NIR)→ft_*` är stabil/källagnostisk. Nya källor skriver bara `normalize`, kärnan orörd. NIR är även pivot för framtida BOTH-WAYS (Mira→Fortnox push).
- **Adaptrar idag:** `fortnox-invoice`, `tengella-invoice`. (Order/offer/workorder ska läggas till.)
- **Diff-läge skriver INGENTING** (säkerhetsgaranti). `mode:"write"` krävs explicit. Default = diff.
- **`fast`-flagga:** reconcile-validering från listing utan detail-anrop (bara Tengella; INTE Fortnox som saknar Net i listing). `fast`+`write` kastar.
- **Reconcile i rapporten:** summerar ft_net per connection + per månad + per typ (Normal/Kredit), exkl makulerade → jämför direkt mot facit.

**Route:** `POST /sync/v2/:source` (index.js, nära `app.listen`). `createSyncEngine({...})` wiring strax ovanför.

**opts (body):** `mode` (diff|write), `fast`, `sinceYM`/`untilYM` ("YYYY-MM"), `fromdate`/`todate` (Fortnox listing), `modifiedDaysBack` (Fortnox lastmodified-sweep), `connection_id`, `customerId`, `orgNo`, `maxRecords`, `throttleMs`, `limit`, `maxPages`, `sampleDiffs`.

---

## 3. Klart & validerat (fakturaspåret)
- **Buggar lösta strukturellt:** Bug 1 (tomma fält → fetchComplete=detail, enrich avskaffat), Bug 2 (Tengella fältmappning → dedikerade ft_invoice_type/ft_tax_reduction_*), Bug 3 (kredit-tecken → räkna på signerat TotalAmount, ingen `total>0`-guard; Tengella skickar credits NEGATIVT), Bug 4 (enrich-loop borta), Bug 5 (datum → numeriskt `ft_invoice_ts`).
- **Härdat:** `bubbleFind` (200+trasig JSON → kastar, ej tom lista), `bubbleCreate` (lyckat utan id → kastar).
- **Reconcile krona-för-krona (2026):** F&E 33 155 083 (Fortnox 33 155 082,73), Staff 35 245 262 (35 245 261,98), HK 15 928 535 (facit jan-apr 15 928 196, +339). OBS: jämför rätt PERIOD — facit i handoffen var jan-apr, Fortnox-rapporten helår.
- **Cron live:** Render cron-jobb `bash sync_v2_cron.sh` (nightly `0 2 * * *`) + `bash sync_v2_cron.sh full` (`0 3 * * 0`). Env: HOST, MIRA_RENDER_API_KEY, SYNC_SECRET. Verifierad grön: nya fakturor auto-create, ändrade auto-update, oförändrade noop.
- **Borttaget:** enrich_zero_net.sh, fortnox_enrich.sh, samt 4 obsoleta enrich-routes + 3 hjälpfunktioner ur index.js (−364 rader, nu ~15 547). PDF-enrich-routerna BEHÅLLNA.

### Bubble-fältfakta (kritiskt vid write)
- `ft_total`, `ft_balance` = **TEXT** i Bubble → skriv `String(...)` (annars `INVALID_DATA: Expected a string, got a number`).
- `ft_net`, `ft_totalvat`, `ft_invoice_ts`, `ft_tax_reduction_amount` = **number**.
- `ft_cancelled` = historiskt "ja"/"nej"-text (computeSalesKpi rad ~10918 kollar `==="ja"`); nya synken skriver boolean — funkar men var medveten.
- `ft_url` EXKLUDERAS från diff (Tengella PDF-länk = temporär, regenereras → churn).
- Nya fält skapade i Bubble: `ft_invoice_type`, `ft_tax_reduction_type`, `ft_tax_reduction_amount`, `ft_invoice_ts`.

---

## 4. Konstanter
```
Connection IDs:
  F&E    (Fortnox):  1771579463578x385222043661358460
  Staff  (Fortnox):  1771579472595x998707043537409700
  Group  (Fortnox):  1771579485842x995491391876972200   ← exkluderas i KPI
  HK     (Tengella): 1771579481117x119544302020443410    ← TENGELLA_CONNECTION_ID
Tengella moms: 25% antaget (validerat mot bokföring). RUT/ROT är INTE annan momssats.
Fortnox kan ha blandad moms (sett 12%) → använd Fortnox riktiga Net, härled aldrig.
```

### Curl-mall (Christian kör)
```bash
curl -sS -X POST "$HOST/sync/v2/fortnox-invoice" \
  -H "x-api-key: $KEY" -H "x-sync-secret: $SYNC_SECRET" -H "Content-Type: application/json" \
  -d '{"mode":"diff","connection_id":"1771579463578x385222043661358460","fromdate":"2026-01-01","todate":"2026-12-31"}'
```

---

## 5. NÄSTA KONKRETA STEG — order/offer/workorder (§9 i designdoc)

### Beslut LÅSTA (2026-06-05, se §9.6)
1. **UnifiedOrder UTFASAS** (frontend anpassas).
2. **Workorder → FortnoxOrder** (connection=TENGELLA), speglar Tengella-faktura→FortnoxInvoice. En ordermodell över alla bolag. Operativa workorder-fält i `ft_raw_json`. Verifiera att frontend ej läser strukturerade `TengellaWorkorder`-fält före pensionering.
3. **Offert/Dokument-wrapper BEHÅLLS** för offer (Mira-native författaryta). Förbered both-ways (push Mira→Fortnox senare): NIR=pivot, round-trip-bara offer-rader, solid FortnoxOffer↔Offert-länk, `source/origin`-flagga.
4. **PDF för order+offer:** lagra allt nu, TTL/GC senare (kräver Bubble `delete_file`-workflow för äkta fil-frigöring).

### Byggordning
- **9a — KÄRN-UTBYGGNAD ✅ KODAT + lokalt testat (2026-06-05), väntar deploy + revalidering:**
  - KLART: `upsertToBubble(adapter, payload, {mode})` adapter-driven (`adapter.bubbleType` + `adapter.keyFields` + valfri `adapter.compareFields`). Faktura-adaptrarna deklarerar `bubbleType:"FortnoxInvoice"`, `keyFields:["connection_id","ft_document_number"]`.
  - KLART: `upsertDocWithRows(adapter, payload, rowNirs, {mode})` — upserta huvud → hämta befintliga rader via `adapter.rows.parentField`-relation (`bubbleFindAll`) → upserta inkommande (nyckel `adapter.rows.keyField`) → **RADERA rader vars nyckel saknas i källan**. Diff-läge skriver inget, rapporterar tänkt create/update/delete. `bubbleDelete` injicerad i wiring.
  - KLART: `diffPayload(payload, existing, fields)` tar nu compareFields-param. Drivern: `adapter.buildPayload || buildPayload`, dispatchar `adapter.rows ? upsertDocWithRows : upsertToBubble`. `report.counts.rows` aggregeras; connection-nyckel källagnostisk (`keyFields[0]`).
  - Lokalt verifierat med mockad Bubble-store: 2 rader create → R2 borttagen ger delete, R1 update, R3 create; diff skriver inget. (Smoke-test borttaget, ej committat.)
  - **ÅTERSTÅR för 9a:** Christian pushar → kör diff-curl för HK/F&E/Staff (se §0/§4) och bekräftar **noop-dominans** (faktura oförändrad). Rad-nyckel-fallback parentdoc#index (positionskänslig) byggs i 9b där order-rader faktiskt finns.
  - `buildPayload` är per-dokumentklass (faktura ≠ order ≠ offer); 9b-adaptrar sätter egen `adapter.buildPayload`.
- **9b — fortnox-order + fortnox-offer:** fetchComplete=detail (ger rader OCH Net/VAT). Diff → scoped write → full write → reconcile mot Fortnox order/offer-totaler. Behåll fältnamn `connection`. Radbelopp som strängar. Nya number-fält ft_order_ts/ft_offer_ts.
- **9c — PDF:** generisk `fetchAndStoreOrderPdf` mot `/orders/{n}/preview` (ALDRIG `/print` = sidoeffekt markerar utskriven). Mönster: `fortnoxGetBinary(path)` → `bubbleUploadFile` → patcha `ft_pdf`+`ft_pdf_fetched_at`+`needs_pdf_sync=false`. Separat flaggat PDF-cron. Offer har redan `fetchAndStoreOfferPdf` (rad ~3536).
- **9d — tengella-workorder → FortnoxOrder:** `/v2/WorkOrders` listing-only (rader inbäddade), GLOBAL discovery (ingen kund-loop), icke-ekonomiskt huvud → härled `ft_total`=Σ(pris×antal). Rader → FortnoxOrderRow.
- **9e — cron:** lägg order/offer/workorder + PDF i `sync_v2_cron.sh`.

### Nyckelfakta om befintlig order/offer/workorder-kod (från audit)
- Fortnox order/offer DETAIL (`/orders/{n}`, `/offers/{n}`) innehåller rader (OrderRows/OfferRows) + Net/TotalVAT. Listing saknar dem (samma Bug 1).
- Rad-typer: `FortnoxOrderRow` (nyckel `ft_unique_key` = `ROWID_..__CONN_..__ORDDOC_..`), `FortnoxOfferRow` (`OFFERROW_..`). **Standardisera nyckelformat i ny adapter.**
- FortnoxOrder/Offer använder fältet **`connection`** (inte `connection_id` som faktura). Radbelopp lagras som strängar.
- `linked_company` sätts EJ på order/offer idag (men resolvbart via FortnoxCustomer-bryggan som faktura).
- Workorder: `upsertTengellaWorkorderToBubble` (~7259), rader `upsertTengellaWorkorderRowToBubble` (~7362). Ekonomi bara på rad (price/cost_price, ingen moms). Blir EJ faktura automatiskt (indirekt via rad-`invoiced`).
- **Ingen av de tre städar borttagna rader idag** = luckan 9a fixar.
- **Ingen Bubble fil-GC** finns → PDF-omskrivning läcker gamla filer.

---

## 6. Senare faser
- **ClientGroup (kundkort-bundling):** rörig kunddata — samma företag har flera orgnr/Fortnox-ID/Tengella-ID. Org 556718-6654 (Alecta Fastigheter) har 3 FortnoxCustomers med olika namn (Alfab Göteborg 3/4, Ullevi Park) → org-matchning konflaterar fastigheter. Plan: ClientCompany = faktureringsenhet (källidentitet, ej org); ClientGroup (Christians Bubble-typ: companies[], primary_company, name, logo, slug — lägg till org_numbers[], aliases[]) = kundkort som buntar. Metodik: auto-FÖRESLÅ kluster → människa BEKRÄFTAR → durabelt, synken river aldrig bekräftad gruppering. Detta är det omdefinierade "Steg 1 orgnr-fundament".
- **Both-ways offer-push** (Mira→Fortnox). Förberett via NIR-pivot i 9b/9c.
- **Bryt upp index.js** (~15 547 rader) i moduler (KPI, kundportal, MS, Caspeco, jobb-pollers, inbjudan, emailer). Mål <5000.

---

## 7. Filöversikt
- `invoice_sync.js` — sync-kärnan (NIR, adaptrar, diff/write, reconcile). **Detta är där 9a-utbyggnaden görs.**
- `sync_v2_cron.sh` — löpande cron (nightly modified + full helår). Inga `#`-rader pga zsh.
- `ARKITEKTUR_OCH_OMTAG.md` — fullständig design §1–9 (arkitektur, buggar, NIR-design, order/offer/workorder-design, beslut).
- `index.js` — monolit (~15 547 rader). Wiring av createSyncEngine + route /sync/v2 nära botten. PDF-helpers: `fortnoxGetBinary` (~3366), `bubbleUploadFile` (~3395), `fetchAndStoreOfferPdf` (~3536), `fetchAndStoreInvoicePdf` (~14059).
- Gamla cron (PAUSADE/delvis kvar för ej-migrerat): `fortnox_cron_v1.sh`, `tengella_cron.sh`, `fortnox_offers_recent_10min.sh` — hanterar offer/order/artiklar/PDF som ej flyttats än. Stäng inte av de delarna förrän migrerade.

---

## 8. Fallgropar (lärda)
- Fortnox rate-limit: krävde retry+backoff (`fortnoxGetRetry`) + throttle (`throttleMs`, default 200, april behövde 350). Listing-fel mitt i paginering → kastar → 500 på hela requesten; idempotent så kör om.
- Render long-running: curl `--max-time` högt; idempotent så timeout ofarlig.
- `maxRecords` räknar FÖRSÖK (inte träffar) så scoped test stoppar även vid fel.
- Bubble 100-träffars-cap: använd `bubbleFindAll` (paginerar), inte rå `bubbleFind`.
