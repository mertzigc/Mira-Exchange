# Sync-kärnan (NIR) — Fortnox / Tengella

> Den ursprungliga sync-doccen. NIR-baserad generisk kärna i `invoice_sync.js`,
> route `POST /sync/v2/:source`, cron `sync_v2_cron.sh`.
> **Innehåller §4 connection-ID:n och §8 fallgropar — läs dem innan du rör synk.**
> Djupdesign: `../ARKITEKTUR_OCH_OMTAG.md`.

---
## 0. TL;DR — var vi står (2026-06-08)
- **Fakturaspåret: KLART, validerat krona-för-krona, självgående** (cron live). F&E/Staff/HK 2026 stämmer mot Fortnox/facit.
- **§9 Order/Offer/Workorder: KLART & LIVE.** Hela omtaget (9a kärn-generalisering med delete-reconciliation → 9b fortnox-order/offer → 9c PDF → 9d tengella-workorder→unified FortnoxOrder → 9e cron-cutover) är kodat, backfillat 2026 (workorder 2025+2026), idempotensbevisat (omkörning = rent noop, 0 dubbletter) och i drift. `SYNC_V2_ORDERS=1` live, nightly grön, PDF-cron drar undan ~2600 flaggade order, weekly safety-net härdad. Gamla order/offer/workorder-cron avstängda. **Inget öppet här.** Detaljer + lärda buggar i §5/§8.
- **ClientGroup: ⛔ AUTO-klustring avbruten · ✅ LÄSLAGRET BYGGT 2026-09-01.** Se §6b. `GET /admin/companies/groups[/:id]` (companies_api, x-admin-token). ⚠️ **Medlemmar härleds ur `ClientCompany.group` — ALDRIG ur `ClientGroup.companies`.**
- **ClientGroup-fasen (auto): ⛔ AVBRUTET 2026-06-08** (Christians beslut — mjuka variabler + smutsig källdata gör auto-klustring opålitlig; manuell metodik finns; rätt lever = ren data vid inmatning). Kod ligger kvar oanvänd, 0 poster skrivna. Se §6.
- **linked_company-backfill: KODAT 2026-06-08, väntar diff-resultat.** Egen route `POST /sync/v2-linkcompany/:source` (frikopplad från ClientGroup — den vägen aktivt bortvald). Fyller bryggfältet på FortnoxInvoice/Order/Offer (Fortnox + Tengella) som synkens noop-väg aldrig satte. Bubble-intern, diff-default. Se §8c.
- **Nästa möjliga spår (inget pågår):** (a) datakvalitet-vid-ingest — orgnr-validering/normalisering när kund→ClientCompany skapas (det verkliga ClientGroup-fundamentet); (b) Intelliplan-adapter för Staffs order/offert; (c) both-ways offer-push (Mira→Fortnox); (d) bryt upp index.js (~15,6k rader) i moduler.
- **§9-DETALJSTATUS (historik, allt KLART):**
- **Steg 9b är KODAT + lokalt e2e-testat (2026-06-05).** `fortnox-order` + `fortnox-offer`-adaptrar (huvud + rader) på 9a-kärnan, registrerade → nåbara via `POST /sync/v2/fortnox-order|fortnox-offer` direkt efter deploy. **Väntar: (1) skapa nya number-fält `ft_order_ts`/`ft_offer_ts` i Bubble, (2) diff-revalidering mot Fortnox order/offer-totaler innან write.**
- **Steg 9c är KODAT (2026-06-05).** Sync flaggar `needs_pdf_sync=true` på order/offer (create+update); generisk `fetchAndStoreOrderPdf` (index.js, `/orders/{n}/preview`, ingen Offert-wrapper); separat PDF-cron `POST /sync/v2-pdf/:source` (token cacheat per connection, bundet av `maxRecords`).
- **Steg 9d är KODAT + lokalt e2e-testat (2026-06-05).** `tengella-workorder`-adapter → unified `FortnoxOrder`/`FortnoxOrderRow` (connection=TENGELLA, `source="tengella-workorder"`). Global discovery `/v2/WorkOrders` (cursor, inbäddade rader, pass-through fetchComplete), härled `ft_total`=Σ(pris×antal) + net via 25%. `listWorkOrders` injicerad.
- **Steg 9e FÖRBEREDD i kod (2026-06-05), EJ aktiverad.** `sync_v2_cron.sh` har order/offer/workorder + `pdf`-läge bakom env-flagga `SYNC_V2_ORDERS` (default 0). Aktivering = operativ cutover (stäng av gamla cron FÖRST), se §5 9e runbook.
- **CUTOVER LIVE 2026-06-08 ✅.** `SYNC_V2_ORDERS=1` aktiv. Nightly grön med order/offer/workorder (nya docs create, allt annat noop, err 0). PDF-cron (`sync_v2_pdf`, */30) drar 50/run, betar av ~2600 flaggade order. Weekly safety-net (`full`) hängde på helårs-invoice → härdat: resilient `post` (fel→fortsätt, ej abort), max-time 30min, invoices kvartalsvis. Gamla order/offer/workorder-cron avstängda.
- **BACKFILL KLAR + idempotent (2026-06-07):** order F&E (2026, maj veckodelad), offer F&E (2026, feb+maj veckodelade), workorder→FortnoxOrder (2025+2026) — alla rent noop på omkörning (heads u=0, rows u=0/del=0, err=0). Buggar lösta under backfill (se §8): linked_company-fält saknades, 401-token-refresh, tunga månader chunkas, FortnoxOrderRow ft_discount/ft_vat är NUMBER (ej ""), härledda belopp round2.

### 📌 SCOPE-FAKTA: order/offer = BARA F&E
- **Staff har endast faktura i Fortnox.** Staffs order/offert skapas i **Intelliplan** (separat system) → `/orders` på Staff-kontot ger `400` (modulen finns ej). Kör därför `fortnox-order`/`fortnox-offer` **enbart för F&E** (`1771579463578x385222043661358460`). Cron uppdaterad därefter.
- **Intelliplan order/offert = framtida egen källa** (egen adapter → samma unified FortnoxOrder/FortnoxOffer, connection=Staff eller egen). Ej i scope nu.

### ✅ KLART (historik): Bubble-fält som skapades under §9 — alla på plats
1. **Skapat på FortnoxOrder/Offer:** `ft_order_ts`/`ft_offer_ts` (number). (Number-fält behövs för pålitlig datumfiltrering.)
1b. **Skapa på FortnoxOrder i Bubble (9c):** `needs_pdf_sync` (yes/no), `ft_pdf` (file), `ft_pdf_fetched_at` (text). FortnoxOffer har dem redan. Utan dessa nollar PDF-cronen aldrig flaggan → samma dokument hämtas om och om.
1c. **Skapa på FortnoxOrder i Bubble (9d):** `source` (text). Sätts till `"fortnox"` (fortnox-order) resp `"tengella-workorder"` (workorder) för spårbarhet i unified-modellen. Skrivs additivt vid varje write, ej i compareFields (ingen diff-brus). Utan fältet droppas det tyst.
2. **Coexistence-krig:** gamla cron (`fortnox_cron_v1.sh` m.fl.) skriver fortfarande FortnoxOrder/Offer + rader. Nya adaptern speglar EXAKT befintliga fältnamn, beloppstyper (order-rad=STRÄNG, offer-rad=NUMBER) och `ft_unique_key`-format just för att undvika create/delete-krig — men kör INTE nya order/offer-write i cron parallellt med gamla på samma dokument. Manuell scoped write OK för validering. Full cron-cutover = 9e (stäng av gamla först). Nyckel-standardisering medvetet uppskjuten till dess.

---

## 0b. Invoice-PDF-lucka — LÖST 2026-06-11
- **Lucka:** sync_v2 hämtar invoice-DATA men ALDRIG PDF (PDF kräver separat binärt `/preview`-anrop). Invoice-PDF fylldes av legacy-routen `POST /fortnox/enrich/invoice-pdfs` (söker `ft_pdf is_empty`), driven av `fortnox_cron_v1.sh` Step 1c — som stängdes av vid §9-cutovern. → Nya/ändrade fakturor fick data men ingen `ft_pdf` (450 F&E saknade). Blockerade kundportals-release.
- **Fix:** `sync_v2_cron.sh` `pdf`-läge kör nu invoice-PDF-enrich ALLTID (oberoende av SYNC_V2_ORDERS), **per connection** (`$FORTNOX_NATIVE` = F&E+Staff+Group) — INTE `all_connections` (då skickas TENGELLA-conn till Fortnox-API → `404 Kan inte hitta fakturan`). HK-PDF via separat `/tengella/enrich/invoice-pdfs`. Enrich-routen är idempotent (bara tomma ft_pdf, ingen re-fetch/churn).
- **Lärdom:** "sync_v2 ersätter alla enrich-script" gäller DATA, inte PDF. PDF/binärhämtning är ett eget steg som måste leva i pdf-cronen.
- **Backfill (2026-06-11) VERIFIERAT KLAR:** drän via enrich-routerna → `count: 0` aktiva (icke-makulerade) FortnoxInvoice utan ft_pdf, över alla connections (auktoritativ Data-API `results`-hämtning; Bubbles `remaining`-räknare ligger efter/cachad → lita på `count`/`results`, inte `remaining`). Makulerade fakturor saknar ft_pdf medvetet (behövs ej). Steady-state: `sync_v2_cron.sh pdf` (*/30) håller det fyllt.
- **HK/Tengella-enrich-routen är tung** (global svep alla kunder×fakturor) → kan timeouta i cron men slutför server-side; resilient `post` tolererar. Om nya HK-fakturor framöver inte får ft_pdf i tid: bygg lätt variant (query FortnoxInvoice connection=TENGELLA + ft_pdf is_empty, hämta från `ft_url`/raw) i stället för helsvepet.


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
- **9b — fortnox-order + fortnox-offer ✅ KODAT + lokalt e2e-testat (2026-06-05), väntar Bubble-fält + revalidering:**
  - KLART: `makeFortnoxDocAdapter`-factory i `invoice_sync.js` (efter fortnox-faktura-adaptern) → `fortnoxOrderAdapter` + `fortnoxOfferAdapter`, båda i registry. fetchComplete=detail (`/orders/{n}`, `/offers/{n}`) ger rader + Net/VAT. Egen `buildPayload` per typ (per-dokumentklass).
  - KLART: speglar EXAKT befintliga fältnamn/typer: `connection` (ej connection_id), **order ft_total + radbelopp = STRÄNG**, **offer ft_total + radbelopp = NUMBER** (avviker!). Rad-nyckelformat behållet: order `ROWID_${rowId}__CONN_${conn}__ORDDOC_${doc}` (fallback `FALLBACK__..__IDX_nnn`), offer `OFFERROW_${RowId||idx}_${conn}_${doc}`. Parent-relation: order-rad→`order`, offer-rad→`offer`.
  - KLART: nya number-fält `ft_order_ts`/`ft_offer_ts` skrivs (huvud). `linked_company` sätts nu via FortnoxCustomer-bryggan (read-only, additivt — gamla synken satte den ej). lastmodified-sweep + fromdate/todate i iterateRefs som faktura.
  - Lokalt verifierat: huvud-create med rätt fälttyper, ROWID-nyckel, 2 rader → en borttagen ger delete (set-reconciliation), update, diff skriver inget.
  - **LIVE-VALIDERAT 2026-06-05 (fortnox-order):** diff mot F&E april → 10 huvud-update (idempotent, 0 create, backfill av ft_order_ts/ft_your_reference + färskt ft_total). Decisivt rad-test: write maxRecords:1 (huvud update + 12 rad-create) → re-diff DIREKT = huvud **noop** + rad **noop 12**, 0 create/0 delete. ⇒ rad-find via parent-relation funkar, ingen dubblering, idempotens bekräftad ned till radnivå. (De 98 rad-create i första diffen var benignt: aprilordrarnas rader var aldrig populerade.)
  - **ÅTERSTÅR:** (1) skapa `ft_order_ts`/`ft_offer_ts` i Bubble; (2) `fortnox-offer` diff-sanity (speglar order, ej testad live än); (3) full scoped write per source → reconcile mot Fortnox order/offer-totaler; (4) cutover. Kör EJ parallellt i cron med gamla order/offer-synken (se ⚠️ §0).
- **9c — PDF ✅ KODAT (2026-06-05), väntar Bubble-fält + test:**
  - KLART: `fetchAndStoreOrderPdf` (index.js ~3610, efter `fetchAndStoreOfferPdf`) mot `/orders/{n}/preview` (ALDRIG `/print`). Mönster: `fortnoxGetBinary` → `bubbleUploadFile` → patcha `ft_pdf`+`ft_pdf_fetched_at`+`needs_pdf_sync=false`. Ingen Offert/Dokument-wrapper (bara offer har den, beslut 9.6.3).
  - KLART: sync-adaptrarna (9b) sätter `needs_pdf_sync:true` i order/offer-huvudet (skrivs vid create/update, ej i compareFields → triggar ingen egen diff). PDF-cronen nollar den.
  - KLART: route `POST /sync/v2-pdf/:source` (`fortnox-order`|`fortnox-offer`) i index.js intill `/sync/v2/:source`. Hämtar `needs_pdf_sync=true` via `bubbleFindAll`, token cacheat per connection, bundet av `maxRecords` (default 25), `throttleMs` (default 300). Body: `{connection_id?, maxRecords?, throttleMs?}`.
  - **ÅTERSTÅR:** skapa Bubble-fälten på FortnoxOrder (se §0 punkt 1b); kör `/sync/v2-pdf/fortnox-order` med litet `maxRecords` och verifiera att PDF dyker upp på FortnoxOrder + flaggan nollas. Offer-PDF i denna cron: kör EJ parallellt med gamla `/fortnox/upsert/offers`-PDF-flödet förrän cutover (9e).
- **9d — tengella-workorder → FortnoxOrder ✅ KODAT + lokalt e2e-testat (2026-06-05), väntar source-fält + diff-test:**
  - KLART: `tengellaWorkorderAdapter` (invoice_sync.js, före registry). `bubbleType:"FortnoxOrder"`, rows→`FortnoxOrderRow` (samma typer som fortnox-order; connection=TENGELLA → egna records, ingen kollision). GLOBAL discovery `/v2/WorkOrders` (cursor, `resp.Data`/`Next`/`ExistsMoreData`, ingen kund-loop), rader inbäddade, `fetchComplete` pass-through.
  - KLART: härled ekonomi — `ft_total`=Σ(Quantity×Price) som STRÄNG, `ft_net`=round(total/1.25), `ft_totalvat`=total−net (order ≠ intäkt i KPI, markerat). Egen `buildPayload`. Operativa workorder-fält bevaras i `ft_raw_json` (head + rad). Kundupplösning read-only/diff, full/write (som faktura). Rad-nyckel `WORID_${WorkOrderRowId}__CONN_${conn}__ORDDOC_${docNo}` (fallback IDX).
  - KLART: `listWorkOrders` (=`listTengellaWorkOrders`) injicerad i tengella-deps.
  - **ÅTERSTÅR:** skapa `source` på FortnoxOrder (§0 punkt 1c); `curl POST /sync/v2/tengella-workorder` diff (orgNo default), granska sample_diffs/rad-churn; scoped write; verifiera ett WO i Bubble. Gamla `/tengella/workorders/sync` + UnifiedOrder-hook kör kvar tills 9e-cutover (UnifiedOrder utfasas, beslut 9.6.1).
- **9e — cron ✅ FÖRBEREDD i kod (2026-06-05), EJ aktiverad:**
  - KLART: `sync_v2_cron.sh` har order/offer/workorder i både `full` och `nightly`, plus nytt `pdf`-läge (`./sync_v2_cron.sh pdf`) — allt bakom env-flaggan `SYNC_V2_ORDERS` (default **0** = av). Fakturadelen orörd. Syntax-checkad, flagg-gate verifierad.
  - **CUTOVER-RUNBOOK (Christians operativa steg, gör i ordning):**
    1. Klart innan: order+offer+workorder write-validerade, Bubble-fälten skapade (§0 1/1b/1c).
    2. **STÄNG AV gamla order/offer/workorder-cron** på Render: `fortnox_cron_v1.sh`, `tengella_cron.sh` (workorder-delen), `fortnox_offers_recent_10min.sh`. (Fakturornas gamla cron är redan pensionerad.)
    3. Sätt `SYNC_V2_ORDERS=1` i Render-env. Nästa nightly/full tar då med order/offer/workorder.
    4. Lägg ett separat cron-jobb för PDF: `bash sync_v2_cron.sh pdf` (t.ex. var 30:e min) — betar av `needs_pdf_sync` i egen takt.
    5. Verifiera grönt (counts noop-dominerat efter första full), slå sen av sista resterna av gammal order/offer-kod.
  - **Workorder nightly-not:** saknar modified-filter → window:as på OrderDate (skippar gamla docs men pagar /v2/WorkOrders globalt varje natt). OK nu; optimera vid behov.
  - **`full` chunkar order/offer i 7-dagarsfönster** (`order_offer_weekly`, GNU date → Render Linux) — tunga F&E-månader timeoutar annars. Workorder window:ad till året. Invoices kör helår (klarar det).
  - **PDF-cron:** separat Render-jobb `bash sync_v2_cron.sh pdf` (*/30), egen env (HOST, MIRA_RENDER_API_KEY, SYNC_SECRET, **SYNC_V2_ORDERS=1** — annars exit). `SYNC_V2_ORDERS` ska på varje cron som kör sync_v2_cron.sh, EJ på web-tjänsten. Backfill flaggade ~3000+ order → drän tar ~1-2 dygn vid maxRecords 50 (höj tillfälligt vid behov). Offer-PDF stannar på gamla flödet tills separat cutover.

### Nyckelfakta om befintlig order/offer/workorder-kod (från audit)
- Fortnox order/offer DETAIL (`/orders/{n}`, `/offers/{n}`) innehåller rader (OrderRows/OfferRows) + Net/TotalVAT. Listing saknar dem (samma Bug 1).
- Rad-typer: `FortnoxOrderRow` (nyckel `ft_unique_key` = `ROWID_..__CONN_..__ORDDOC_..`), `FortnoxOfferRow` (`OFFERROW_..`). **Standardisera nyckelformat i ny adapter.**
- FortnoxOrder/Offer använder fältet **`connection`** (inte `connection_id` som faktura). Radbelopp lagras som strängar.
- `linked_company` sattes EJ på order/offer i den GAMLA koden (men resolvbart via FortnoxCustomer-bryggan som faktura). Nya adaptern sätter det på create/update; historiska/oförändrade dokument backfillas via §8c.
- Workorder: `upsertTengellaWorkorderToBubble` (~7259), rader `upsertTengellaWorkorderRowToBubble` (~7362). Ekonomi bara på rad (price/cost_price, ingen moms). Blir EJ faktura automatiskt (indirekt via rad-`invoiced`).
- **Ingen av de tre städar borttagna rader idag** = luckan 9a fixar.
- **Ingen Bubble fil-GC** finns → PDF-omskrivning läcker gamla filer.

---

## 6. Senare faser
- **ClientGroup (kundkort-bundling) — ⛔ AVBRUTET 2026-06-08 (Christians beslut).**
  - **Varför avbrutet:** gruppkomposition styrs av för många mjuka variabler för att (semi-)automatiseras tillförlitligt. Dessutom är grundorsaken till "strul" SMUTSIG KÄLLDATA — felskrivna/felformaterade orgnr — inte saknad klustringslogik. Christian har redan en manuell metodik för att skapa grupper och addera företag.
  - **linked_company-backfill frikopplad (2026-06-08):** att fylla bryggfältet `linked_company` på dokumenten var tidigare inplanerat som en del av ClientGroup-fasen. Det är nu AKTIVT BORTVALT från ClientGroup och görs i stället via egen route (§8c). Skälet: backfillen är ren bryggdata (FortnoxCustomer/TengellaCustomer → ClientCompany), inte gruppering — den behöver varken klustring eller mjuka beslut. Gruppering (ClientGroup-kundkort) gör Christian separat och manuellt i Bubble i de fall det bedöms lämpligt. De två är skilda lager och hålls isär.
  - **Rätt lever framåt (ej auto-klustring):** få in företagen KORREKT vid inmatning (validerade orgnr) så blir datan självstädande. En framtida "datakvalitet vid ingest"-insats (orgnr-validering/normalisering när FortnoxCustomer/TengellaCustomer→ClientCompany skapas) är den verkliga grunden, inte retroaktiv klustring.
  - **Kod-status:** `clientgroup.js` + routes (`/clientgroup/suggest`, `/clientgroup/apply`, `/clientgroup/rollup`) finns deployade men OANVÄNDA. `apply write` lyckades aldrig (bubbleCreate-fel mot ClientGroup, ej felsökt) → **0 ClientGroup-poster skrevs**, ren tavla. `rollupGroup` (omsättning/order per grupp över medlems-CCs) kan återanvändas för Christians MANUELLT skapade grupper om så önskas. Auto-klustring (suggest/apply) bör tas bort eller lämnas vilande. CG-1-kartläggningen finns kvar nedan som referens.
  - **Historik/referens (CG-1 kartläggning, kan vara nyttig för datakvalitets-arbetet):** rörig kunddata — samma företag har flera orgnr/Fortnox-ID/Tengella-ID. Org 556718-6654 (Alecta Fastigheter) har 3 FortnoxCustomers med olika namn (Alfab Göteborg 3/4, Ullevi Park) → org-matchning konflaterar fastigheter. Plan: ClientCompany = faktureringsenhet (källidentitet, ej org); ClientGroup (Bubble-typ: companies[], primary_company, name, logo, slug — lägg till org_numbers[], aliases[]) = kundkort som buntar. **Beslut 2026-06-08: orgnr = HINT (ej facit), conflate-fall flaggas för människa, källidentitet bevaras.**
  - **Datamodell (kartlagd):** ClientCompany nycklas på `Org_Number`+`ft_customer_number`. Bryggor: `FortnoxCustomer.linked_company` + `TengellaCustomer.company` → ClientCompany. Org-helpers: `normalizeOrgNo` (~6671), `findClientCompanyByOrgNo` (~6725). Gammal destruktiv dedup: `/customer/diag-by-org` + DEDUP-APPLY (mergar+raderar CCs) — ClientGroup ERSÄTTER den med icke-destruktiv buntning.
  - **CG-1 ✅ KODAT + lokalt testat:** `clientgroup.js` (DI) + `POST /clientgroup/suggest` (read-only). Föreslår `clusters` (union på identiskt normaliserat namn ELLER orgnr; namn+orgnr→high, samma-namn/olika-org=split→high, samma-org/olika-namn=conflate→low+flagga), `conflate_by_source` (CC vars käll-kunder har olika namn), `stats`. Skriver INGET. **Väntar: deploy + kör mot live, granska skala → designa CG-2.**
  - **PRODUKTBESLUT 2026-06-08 (Christian):** kunderna/medarbetarna vill BEHÅLLA separata kundnummer (korrekt fakturering) men ha en grupperad överblick (t.ex. "Vasakronan" = vy över många CCs med summerad omsättning/ärenden). ⇒ **ClientGroup = icke-destruktivt överblickslager. Splitta INGET, merga INGET.** Källidentitet (kundnummer, CCs) orörd. Conflate-fallen behöver EJ splittas — aggregering summerar korrekt över underliggande fakturor/kundnummer ändå. Ev. per-enhet-split görs isolerat/människostyrt senare om en storkund kräver det.
  - **CG-2 ✅ KODAT + lokalt testat (2026-06-08):** ClientGroup Bubble-typ har fälten (aliases, companies, logo, name, org_numbers, primary_company, slug, status). `clientgroup.js`: `applyClusters` (skapar/uppdaterar `status:"suggested"` från kluster, idempotent på slug, **durabelt — confirmed grupp + dess CCs rörs aldrig**, default diff) + `rollupGroup` (omsättning/order/antal över medlems-CCs, makulerat exkl, by_company). Routes: `POST /clientgroup/apply`, `/clientgroup/rollup`. **Väntar: deploy → apply diff → write minConfidence:high → Christian bekräftar i Bubble (status→confirmed) → rollup-test.**
  - **CG-3 (nästa):** sync-integration (nya kunder auto-föreslås in i grupper, flaggas suggested). Ev. förfining: kanonisera orgnr (sista 10 siffror) så 19-prefix/trunkering inte ser ut som split.
  - Metodik: auto-FÖRESLÅ kluster → människa BEKRÄFTAR → durabelt. Detta är det omdefinierade "Steg 1 orgnr-fundament".
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

## 8b. Order/offer-write — lärda (2026-06-05, live-backfill)
- **`linked_company` måste finnas på FortnoxOrder + FortnoxOffer** (skapat). Saknas fältet → Bubble 400 `Unrecognized field` → HELA skrivningen failar. Skrivs bara på create/update (noop backfillar EJ → ett oförändrat dokument får aldrig fältet). Bubble case-sensitive: fältet heter exakt `linked_company` (som FortnoxInvoice). **Historisk backfill: se §8c — egen dedikerad route, INTE längre kopplad till ClientGroup-fasen (den vägen aktivt bortvald, se §6).**
- **FortnoxOrderRow `ft_discount`/`ft_vat` är NUMBER-fält i Bubble** (inte text, trots tidigare audit). Skicka ALDRIG `""` → Bubble 400 `INVALID_DATA: Expected a number, but got a string (original data: "")` → bubbleCreate kastar → rad-create failar tyst som `rows.error`. Workorder-rader (saknar rabatt/moms) sänkte hela rad-persisteringen pga detta → fixat: skicka `null` för tomma number-fält. Order-rader härdade likadant (Number/null, ej String/""). Lärdom: empty-string-fallback funkar bara för TEXT-fält; number-fält kräver null. (ft_price/ft_total är text-fält → "" OK där.)
- **Härledda belopp måste avrundas (2 dec) för idempotens.** Workorder härleder `ft_total`/`ft_net`/`ft_totalvat` (huvud) och rad-`ft_total` = qty×price → float-artefakter (`950.4000000000001`) → `eqLoose` ser ≠ lagrat `950.4` → evig `update`-churn. Fix: `Math.round(n*100)/100` på alla härledda belopp. Order/offer opåverkade (använder Fortnox råa belopp). Efter deploy: en sista städ-update per workorder, sen konvergerar allt till noop.
- **Token-utgång mid-svep (401):** fixat med `fortnoxGetAuthed`-wrapper i invoice_sync.js — force-refreshar (`ensureFortnoxAccessToken(id, true)`) och kör om vid 401. `ensureFortnoxAccessToken` har nu `force`-param. Gäller faktura+order+offer, list+detail.
- **Order F&E 2026-backfill KLAR + idempotent (2026-06-07):** Jan–Jun noop, Jul–Dec tomt, err=0 hela vägen. Maj (~712 ordrar/~8266 rader) var för tung för en request → delades i veckor.
- **TUNGA MÅNADER måste delas vid full-resync:** en enskild månad-request kan timeouta (>25 min). Maj F&E behövde veckofönster (`fromdate`/`todate` per vecka). Cron `full` kör helår i ett svep per source → kan timeouta på tunga konton; överväg månads-/vecko-chunkning i cron `full` om det smäller. Nightly (`modifiedDaysBack`) är litet och opåverkat.
- **F&E orderволym: ~500–600/månad.** `sinceYM` (utan övre gräns) listar månad→årsslut = O(n²) sidor + långa requests → använd `fromdate`+`todate` (riktiga månadsfönster) vid manuell backfill. Detail-anrop sker per dok även vid noop (Bug 1-design) → backfill är tung men engångs; nightly använder `modifiedDaysBack`.
- **Order/offer = BARA F&E** (Staff = faktura only; order/offert i Intelliplan → /orders 400 på Staff).

## 6b. KUNDGRUPPER — läslagret (Fas 1, byggt 2026-09-01)

**Vad som byggdes:** `GET /admin/companies/groups` (lista + hälsa) och
`GET /admin/companies/groups/:id` (detalj med medlemsrader) i `companies_api.js`.
`x-admin-token`, täcks av `/admin/companies`-prefixet i `openPrefixes`.
**Noll Bubble-anrop** — allt kommer ur `companyFullMap` + `companyRevenueMap` +
`_groups`, som redan är förvärmda för företagslistan.

### 🔴 Riktningsregeln (den enda som verkligen betyder något)

| Fält | Skrivs av | Läses av | Status |
|---|---|---|---|
| **`ClientCompany.group`** | companies_api inline-edit (`EDITABLE.group`) | listan, filtret, CC-cachens `group_id` | ✅ **SANNINGEN** |
| `ClientGroup.companies` | bara `applyClusters` — kördes aldrig skarpt (0 poster) | ~~`rollupGroup`~~ (flyttad 2026-09-01) | ⛔ underhålls av ingen |

Exakt samma fälla som `Fastighet.Hyresgäster`. Läser man `companies` får varje
manuellt skapad grupp `medlemmar: 0` — tyst. **`rollupGroup` i `clientgroup.js`
gjorde precis det** och var den sista läsaren på det döda fältet; den härleder nu
ur `ClientCompany.group` via en constraintad query. Det är samma flytt som
[[project-mira-omtag]] föreskriver: när ett fält pensioneras måste ALLA läsare
flyttas i samma andetag — regeln vi själva bröt mot med TengellaWorkorder.

**Speglingen ignoreras inte — men bara halva den är ett problem.**

| Fall | Betyder | Åtgärd |
|---|---|---|
| **`bara_i_companies`** | bolaget ligger i den döda listan men saknar `group` → **OSYNLIGT**, räknas inte, syns inte i filtret | ⚠️ sätt `group` på företaget |
| `bara_i_group` | `companies`-listan släpar efter en korrekt gruppering | ingen — normalfallet |

⚠️ **Första versionen flaggade på båda** och var därmed en varning som med tiden
skulle lysa på ALLA grupper (listan underhålls ju inte). Rättat 2026-09-01 samma
dag den byggdes, efter skarp data: Scandic hade 6 släpande, Strawberry 1 — helt
ofarliga — medan **Benify** hade det enda verkliga fallet (`Benifex AB` osynligt,
gruppen visade 0 medlemmar). Samma regel som åtgärdslistan i Staff-modulen:
*en avvikelse utan handling är bara en notis man vänjer sig vid.*

Hälsomåttet heter därför `grupper_med_osynliga_bolag` + `osynliga_bolag`, inte
"avvikelse" i största allmänhet. Detaljvyn bär `atgard_kravs` så ingen behöver
tolka två arrayer rätt.

### Hälsomått (det som styr om den interna rutinen fungerar)
`foretag_med_grupp` / `foretag_utan_grupp` / `andel_grupperade` ·
`grupper_tomma` (skapade men ej fyllda) · `grupper_utan_namn` ·
**`grupper_med_osynliga_bolag`** / `osynliga_bolag` · **`doda_gruppreferenser`** (företag vars `group`
pekar på en raderad grupp — varje query mot den 400:ar MISSING_DATA) med
namngivna exempel.

### ⚠️ Två saker som INTE får misstolkas
- **Okänd omsättning ≠ noll.** En medlem vars omsättning inte är känd räknas i
  `oms_okand`, aldrig som 0 kr — annars ser en halvt okänd koncern ut som en fattig.
- **Kall faktura-cache ger `null`, inte 0.** `revenue_ready: false` säger att
  siffrorna inte är klara. Vyn måste visa "beräknar…", inte "0 kr".
- **Summorna underskattar.** De bygger på `linked_company`, som fortfarande har
  **1 778 olösta** (§8c.1). Redovisa det i vyn, göm det inte.

### Vad som INTE ingår
Auto-klustring (beslut 2026-06-08 står). Gruppfilter i affärsvyn (`affar_api.js`
har noll gruppmedvetenhet idag) — Fas 3.

---

## 6c. KUNDGRUPPER — Fas 2: skapa, bulk-tilldela, koncernlins (2026-09-01)

**Skrivningar (companies_api):**
`POST /admin/companies/groups {namn}` — skapar. `slug` härleds, dubblett på
normaliserat namn ger **409** (två "Vasakronan" som skiljer sig på ett mellanslag
är två grupper ingen menade skapa). Namnet läses tillbaka.
`POST /admin/companies/groups/:id/members {companies[], action:add|remove}` —
skriver `ClientCompany.group`. Varje rad läses tillbaka och räknas; **207** vid
delvis lyckat, **502** när allt föll. ⚠️ `ClientGroup.companies` skrivs ALDRIG —
mocken kastar om koden försöker.

**Koncernlinsen — `?group=<id>` på de BEFINTLIGA kortendpointerna**
(`/chain`, `/coworkers`, `/matters`, `/qc`). Ingen parallell gruppendpoint: en kodväg.
- ⚠️ **EN query per flik**, aldrig en per medlem. `_scopeC` ger `equals` för ett id
  och `in` för flera. En loop över 20 bolag hade blivit N+1 ovanpå varje flik.
  Medlems-id:na är gratis — de ligger i den förvärmda CC-cachen.
- ⚠️ Linsen är alltid DET HÄR bolagets koncern → `400 company_not_in_group` annars.
- ⚠️ Tak `GROUP_MAX = 100` med `trunkerad` i svaret.
- ⚠️ `_officeNameMap`/`_contractNameMap`/`_companyActivityRows` tar nu lista.
- ⚠️ **Flik-catcharna måste bära `e.status`** — hårdkodad 500 gjorde
  `company_not_in_group` till "något gick fel". Rättat i alla fyra.

**Frontend (`mira-foretag-lista.html`):** kryssrutekolumn + bulkbar i listan
(markera → välj grupp eller `+ Ny grupp` → tilldela/ta bort), linsväxel i kortets
hjälte (visas bara när bolaget har en grupp), bolagsbadge på varje rad i
koncernläge, och Hem-fliken byts mot en **koncernöversikt** (medlemmar med
omsättning per bolag, distinkta fastigheter, kundansvariga).

### 🔴 Fyra fel som bara renderingen hittade
1. **Linsklicket låg i LIST-grenen.** Klick-lyssnaren grenar på `STATE.view==="card"`
   innan den når listans hanterare → klicket dog tyst. Flyttat till kortgrenen.
2. **Bulk-kvittot försvann** när urvalet rensades vid framgång — baren renderas nu
   även med tomt urval så länge det finns ett meddelande. Samma fel som i
   Staff-blocket; en skrivning får aldrig sluta i tystnad.
3. **Tre blandade baser i koncernläge:** hjältens nyckeltal, onboarding-strippen
   och flikbadgarna är alla BOLAGETS siffror. Nyckeltalen märks nu
   ("Nyckeltalen ovan avser X"), strippen och badgarna döljs. Inget tal är bättre
   än ett fel tal.
4. **Onboarding aggregerar inte** — "12 av 20 klara" vore rätt form men datan finns
   inte, så strippen döljs hellre än att se ut att gälla koncernen.

**Verifierat:** `companies_smoke.mjs` **513 gröna**. **Mutationstestat (20 till):**
N+1 i st.f. `in` 4 · tappad bolagskolumn 2 · lins släpper främmande bolag 1 · ingen
återläsning i bulk 1 · tyst fältdrop 1 · 200 vid delvis fel 1 · borttaget
dubblettskydd 1 · okända företag skrivs 1 · cachen ej uppdaterad 2 · gruppmeta
utelämnad 1 · lins glömd per hämtare 1 vardera · flikcachar ej tömda 1 · linsen
bärs vidare 1 · badge alltid synlig 1 · kall oms som 0 kr 1 · colspan 1 · linsklick
i fel gren 1 · de tre blandade baserna 1 vardera.

**Renderat och klickat på riktigt** (lokal harness, stubbad fetch): bulkflödet,
linsväxeln, bolagsbadgarna, koncernöversikten med alla tre varningarna. Inga
konsolfel, ingen sidledes scroll.

### 🎨 Designen lyft till affärsvyns manér (2026-09-01)
`mira-foretag-lista.html` bar en egen navypalett (`#0f1830`/`#16223d`/`#df6f39`) och
en sans-rubrik. Nu samma manér som `mira-affar-samlad.html`: DM Serif-rubrik med
orange accent, versal underrubrik, `--base:#1e2235`-paletten, affärsvyns
tabellmått (th 9,5 px versalt `--w40`, td 12 px, `1.5px` underkant) och
blockformen `padding:22px 26px 40px;border-radius:14px`.

**⭐ Gjort via VARIABELMAPPNING, inte via tusen regeländringar.** De gamla
`--fl-*`-namnen finns kvar men pekar nu på affärsvyns variabler
(`--fl-bg:var(--base)` osv). Varje befintlig regel — både `.fl-` och `.fk-` — bytte
utseende utan att röras. De portade avtals-/abonnemangspanelernas egna variabelblock
(`--acc:#db6923`) justerades på samma sätt, bara värden.

⚠️ **`--fl-mut` är `rgba(255,255,255,.58)`, inte affärsvyns `--w40`.** Listan använder
den även till brödtext i celler, och `.40` blir oläsligt i den storleken.
Tabellrubrikerna sätts explicit till `--w40`, där affärsvyns värde hör hemma.

**Uppdatera-knappen flyttad** intill "+ Nytt företag" i övre högra hörnet. Båda hade
`margin-left:auto` och sköt isär varandra — nu ligger de i en `.fl-headact`-grupp.

**Verifierat:** 5 designtester + 4 mutationer (gamla paletten tillbaka · DM Serif
borttagen · knapparna separerade · fl-variablerna hårdkodade) — alla faller.

### 🔴 button:hover-skyddet saknades HELT i blocket (skarpt 2026-09-01)
Christian såg knapparna bli **helorange med osynlig text** vid hover. Det var inte
testvyn — `dashboard_crm` har en global `button:hover{background:#F47B30
!important;color:#F47B30 !important}` som varje `<button>` i ett inklistrat block
ärver. **Specificitet hjälper inte**; enda motmedlet är `!important` på BÅDE
`background` och `color`. Se [[reference-bubble-button-hover-important]].

Blocket hade **noll** sådana regler — det är äldre än minnet (upptäckt 2026-08-26 i
`mira-personer.html`). Fixen är en basregel för alla `<button>` i `.fl` plus
explicita grupper som vinner på specificitet och därför måste bära `!important`
själva: accent-outline · ifyllda (primära) · destruktiva.

⚠️ **Åtta gamla hover-regler togs bort** — de satte bara `border-color` och var
redundanta efter den nya blocken. Två regler för samma sak inbjuder någon att
"fixa" hovern på fel ställe.

⚠️ **`--fl-err` användes på tre ställen men var ALDRIG definierad** → CSS:en
droppade deklarationen tyst, och felmeddelanden i foto-/logo-uppladdningen
renderades grå i stället för röda. Nu definierad.

**Verifierat empiriskt** med minnets egen metod: den fientliga regeln injicerad i
harnessen och riktig hovring → `background rgb(46,51,80)` mot `color rgb(244,123,48)`
på både `Uppdatera`, `+ Nytt företag` och `✎ Redigera`. Utan fixen är båda orange.
9 statiska tester + 5 mutationer (basregel utan `!important` · bara background
skyddad · primär/destruktiv/accent-grupp utan `!important`) — alla faller.

### ⚠️ NITTON ANDRA BLOCK SAKNAR SAMMA SKYDD
Genomsökning 2026-09-01: bara `mira-foretag-lista`, `mira-personer`,
`mira-kommunikation-admin`, `mira-staff` och `mira-visitor` har skyddet. Utan det:
`mira-affar-samlad` (50 knappar) · `mira-abonnemang-admin` (67) · `mira-offert-admin`
(17) · `mira-produktion-ipad` (12) · `mira-motesbokning` (10) ·
`mira-approval-archive` (10) · `mira-kalender` (8) · `mira-kund-dashboard-tjanster`
(8) · m.fl.

De syns bara på sidor som HAR den globala regeln — därför är felet osynligt tills
ett block flyttas eller en sidas CSS ändras. **Eget spår**, inte en fix i förbifarten:
varje block har egna knappklasser och måste testas per sida.

### 📊 Skarpt utgångsläge 2026-09-01
5 682 företag · **87 grupperade** i 28 grupper · 0 döda gruppreferenser · 0 namnlösa ·
**1 osynligt bolag** (Benifex AB). ⚠️ Läs inte 1,5 % som en backlog — gruppering är bara
meningsfull för kunder med FLERA faktureringsenheter. Måtten som ska vara noll är
`osynliga_bolag` och `doda_gruppreferenser`, inte andelen.

⚠️ **Öppen nivåfråga:** de 28 blandar koncerner (Vasakronan, Sweco, Fabege) med enskilda
hotell (Clarion Hotel Stockholm, Grand Hôtel, Hilton Slussen) — och Clarion/Quality är
Strawberry-varumärken som redan har egen grupp. Samma fråga som ett steg ned mot
Intelliplan-kontona: vad är koncern och vad är anläggning? Beslut behövs, inte slump.

**Verifierat:** `companies_smoke.mjs` **458 gröna**, egen fixtur så befintliga
tester inte rubbas. **Mutationstestat (11, alla faller utan att krascha sviten):**
medlemmar ur `ClientGroup.companies` fäller 7 · okänd omsättning som noll 1 · kall
cache som 0 kr 1 · tystad spegling 2 · död gruppreferens 1 · namnlös grupp
bortfiltrerad 3 · trasigt svep som tom lista 1 · fastigheter ej distinkta 1 ·
flagga även på släpande lista 2 · slutar flagga osynliga bolag 2 · `atgard_kravs`
alltid sant 1.

---

## 8c. linked_company-backfill — tillvägagångssätt (2026-06-08)

**Problemet (verifierat mot live-databasen):** `linked_company` var glest ifyllt på FortnoxInvoice/Order/Offer. Rotorsak: synken sätter fältet bara på create/update OCH det ligger INTE i `COMPARE_FIELDS` ([invoice_sync.js](invoice_sync.js) `COMPARE_FIELDS`) → ett oförändrat dokument blir `noop` och skrivningen hoppas helt (`upsertToBubble`, rad ~151). Allt som synkats men aldrig ändrats sedan linked_company-logiken kom in saknar därför fältet. Den ursprungligt planerade historiska backfillen låg i ClientGroup-fasen — som avbröts 2026-06-08 → kördes aldrig.

**BESLUT 2026-06-08: ClientGroup-vägen för detta är AKTIVT BORTVALD.** linked_company-backfill görs via en egen dedikerad route, helt frikopplad från ClientGroup/auto-klustring. Gruppering (ClientGroup) hanterar Christian separat och manuellt i Bubble i de fall det bedöms lämpligt — det är ett annat lager (icke-destruktiv överblick) och ska inte blandas ihop med att fylla bryggfältet på dokumenten. Se §6.

**Lösningen — `POST /sync/v2-linkcompany/:source`** (index.js, intill `/sync/v2/:source`; `backfillLinkedCompany` i invoice_sync.js):
- `source` = `invoice` | `order` | `offer` | `all`. Auth: `x-api-key` + `x-sync-secret` (som /sync/v2).
- **BUBBLE-INTERN — inga Fortnox/Tengella-anrop.** All bryggdata finns redan i Bubble. Bygger båda bryggorna till lookup-maps EN gång (inte en find per dokument), sen ren minnesuppslagning per dokument.
- Bryggval per dokument: `connection == TENGELLA_CONNECTION_ID` → TengellaCustomer-bryggan (`tengella_customer_no` ELLER `tengella_customer_id == ft_customer_number` → `.company`), annars FortnoxCustomer-bryggan (`connection_id|customer_number → linked_company`). Täcker Fortnox (F&E/Staff/Group) OCH Tengella i samma svep per typ. OBS fältnamn: FortnoxInvoice använder `connection_id`, FortnoxOrder/Offer använder `connection`.
- **`mode:"diff"` (default) skriver INGET.** Rapport per typ: `missing` (saknar fältet), `resolved` (kan fyllas), `unresolved` (brygga saknas → granska `sampleUnresolved`; betyder oftast att FortnoxCustomer/TengellaCustomer-posten saknas, dvs kundbryggan måste fyllas först), `mismatch` (har en länk som skiljer sig från bryggan), `alreadyOk`. Plus `totals` över alla typer.
- **Robust default: FULL skanning** (inte `is_empty`-genväg). Skäl: `is_empty` är ett känt fotgevär (Fynd A i designdoc) som tyst kan returnera 0 träffar och få det att SE klart ut fast det inte är det — exakt felläget vi precis städade. `onlyMissing:true` finns som opt-in snabbväg när man medvetet vill det.
- **Default rör INTE `mismatch`** (bara tomma fält fylls). `overwrite:true` korrigerar även fel-länkade — men kör diff och granska `sampleMismatch` först.
- Idempotent: omkörning i write → `resolved`/`patched` mot 0, `alreadyOk` upp. Chunka per bolag med `connection_id` om `all` timeoutar (computeSalesKpi skannar redan alla fakturor i prod så full skanning är beprövat genomförbar, men stora typer kan vara tunga).

**Curl-mall (Christian kör):**
```bash
curl -sS -X POST "$HOST/sync/v2-linkcompany/all" \
  -H "x-api-key: $KEY" -H "x-sync-secret: $SYNC_SECRET" -H "Content-Type: application/json" \
  --max-time 1800 -d '{"mode":"diff"}'
```
Byt `"mode":"diff"` → `"mode":"write"` när diffen ser rätt ut. Connection IDs i §4.

### 8c.1 Körningsresultat + kringverktyg (2026-06-08)
- **Backfill körd: unresolved 3 245 → 1 778** (order 3 910 + offer 2 825 patchade på create/update-gapet; faktura `resolved:0` = de resolvbara hade redan länk). Två rundor: först doc-backfill, sen kund-bryggan ifylld → ytterligare 1 467 docs.
- **Rapporten har distinkt-kund-statistik:** `unresolvedCustomersTotal.distinctCustomers` + per typ `unresolvedCustomers {total, noCustomer, noLink, top[50]}`. `noCustomer` = FortnoxCustomer/TengellaCustomer saknas helt; `noLink` = kundpost finns men `linked_company`/`company` tom.
- **`POST /sync/v2-linkcustomer`** (index.js) — fyller customer→ClientCompany-länken (noLink). `target: fortnox|tengella|both`. Fortnox-grenen kör `ensureClientCompanyForFortnoxCustomer` (hittar/skapar CC på orgnr); Tengella-grenen matchar `ClientCompany.Org_Number == TengellaCustomer.org_no`. BUBBLE-INTERN. Body `{mode, target, connection_id?, maxRecords?}`. Ersätter den blunta `/fortnox/upsert/customers/all` som **502:ar på volym** (self-HTTP per sida + returnerar hela kundlistor — använd INTE för stor backfill).
- **Restposten (~1 700) är till >80% RÄTT olänkad:** privatpersoner (offerter), "EJ FAKTURERA"-interna platshållare, utländska bolag utan svenskt orgnr. Ska inte länkas. Värda manuell orgnr-inmatning i källan: Kungliga Borgen (30 dok), POWER Sverige, Tapto Home Hotel, DNB Bank ASA, Norstat.
- **99 Tengella-mismatch** (HK) = fakturans `linked_company` ≠ `TengellaCustomer.company` nu (länk har driftat). Backfillen rör dem ej (overwrite=false). `{"mode":"write","overwrite":true}` på `invoice` riktar in dem om bryggan är facit — granska `sampleMismatch` först.

### 8c.2 Dedup-härdning (orgnr) — 2026-06-08
Rot till dubbletter (Cecil-fallet): `Org_Number` lagrat i blandat format (bindestreck vs siffror) → `findClientCompanyByOrgNo` missar → `ensureClientCompany` skapar ny CC. Fix:
- **`POST /admin/clientcompany/normalize-orgno`** (diff/write) — kanoniserar `Org_Number` → siffror-bara. **Kört write 2026-06-08: 87 patchade, 0 kollisioner** (= inga org-dubbletter kvar; Cecil-dubbletten var redan manuellt rensad). Detta gör auto-create framöver säker (matchar alltid befintlig CC).
- **`POST /admin/clientcompany/dedupe-orgno`** (diff/write) — grupperar CC på normaliserat orgnr; `mergeable` (samma orgnr+namn) mergas i write (survivor=äldsta, pekar om FortnoxCustomer/TengellaCustomer/dokument → survivor, raderar dup); `conflate` (samma orgnr, OLIKA namn — Alecta-fastigheter) FLAGGAS, mergas aldrig (källidentitet bevaras, människa avgör). `maxGroups` chunkar.
- **Datamodell-beslut bekräftat:** ClientCompany = en-per-bolag för rena fall (samma namn mergas), list-of källid läggs INTE på ClientCompany. ClientGroup = överblickslager (manuellt, se §6). Conflate-fall människostyrda.

### 8c.3 Självläkande ClientCompany-reconcile i cron — 2026-06-08
**Problemet:** kund→bolag-länken var INTE självläkande. (A) Fortnox/Tengella-kundsynken låg i de gamla cronen `fortnox_cron_v1.sh` (Render: "Mira-Exchange-CronJob") + `tengella_cron.sh` ("TengellaNightlySync") som **suspenderades vid §9e-cutovern** → städad/ny orgnr-data nådde aldrig Bubble. (B) `linked_company` ej i `COMPARE_FIELDS` → fixade bryggor propagerades ej till befintliga oförändrade dokument.
**Fix (gör systemet självläkande givet att rätt grunddata matas in i Fortnox/Tengella):**
- **Kund-synken är nu INKREMENTELL:** `/fortnox/sync/customers` + `/fortnox/upsert/customers[/all]` tar `days_back`/`lastmodified` → drar bara nya/ändrade kunder (utan filter drog den ALLA → 502 på volym). En redigerad kund i Fortnox får ny lastmodified och fångas inom dagar.
- **`sync_v2_cron.sh` delar upp arbetet (WU-OPTIMERAT 2026-06-15):** `sync_customers()` = inkrementell Fortnox-kundsynk F&E+Staff (`days_back=$CUST_DAYS` default 3, `max_pages=$CUST_PAGES` default 3) + Tengella-kundsynk (119 kunder). Den sätter `linked_company`/`company` PÅ KUNDPOSTEN vid upsert. **Körs NATTLIGT + full, FÖRE dokumentsynken** → nya dokument får sin linked_company redan vid create. `reconcile_links()` = `/sync/v2-linkcustomer` (both) + `/sync/v2-linkcompany/all` write — **bara i `full` (veckovis)**. Kunde EJ återaktivera gamla cronen: den drar order/offer-synk som krockar med v2.
- **⚠️ WU-FÄLLA (löst 2026-06-15):** första versionen körde `reconcile_links` (helskanning av ~20k dokument inkl `ft_raw_json` + ~7,7k kunder) NATTLIGT → drog enorma Bubble-WU (FortnoxInvoice-synken blev ~75% av API-WU). Flyttat till weekly. Nattligt = bara inkrementell kund-synk + modified-sweep (bundet). Nya/ändrade docs länkas ändå vid create/update; reconcile fångar bara historiska noop-docs + efterhands-städade kunder → veckovis räcker. Nästa WU-knapp om det fortf. är högt: sänk `MODIFIED_DAYS_BACK` (3→2).
- **Render-status:** gamla kund-cronen (Mira-Exchange-CronJob, TengellaNightlySync) suspenderade — behövs ej, sync_customers ersätter dem. Aktiva cron: Nightly/Weekly fakturasync (= sync_v2_cron), sync_v2_pdf.
- **Svaret på "blir Mira komplett":** JA — Mira lever sig självt givet att korrekt orgnr matas in i Fortnox/Tengella vid kund-skapande. Nya kunder/dokument länkas vid create (nattligt); historiska luckor fylls av weekly-reconcile när källan rättas. Restpost som aldrig länkas (privatpersoner, utländska utan svenskt orgnr, "EJ FAKTURERA"-interna) är korrekt olänkad by design.

## 8. Fallgropar (lärda)
- Fortnox rate-limit: krävde retry+backoff (`fortnoxGetRetry`) + throttle (`throttleMs`, default 200, april behövde 350). Listing-fel mitt i paginering → kastar → 500 på hela requesten; idempotent så kör om.
- Render long-running: curl `--max-time` högt; idempotent så timeout ofarlig.
- `maxRecords` räknar FÖRSÖK (inte träffar) så scoped test stoppar även vid fel.
- Bubble 100-träffars-cap: använd `bubbleFindAll` (paginerar), inte rå `bubbleFind`.
- **WU-FÄLLA: `ft_pdf is_empty`-sökning i PDF-enrich (löst delvis 2026-06-22).** `/fortnox/enrich/invoice-pdfs` söker `ft_pdf is_empty` över hela FortnoxInvoice (~10k rader) — `is_empty` kan ej indexeras → heltabellsskanning, mycket dyrt i Bubble-WU. `sync_v2_pdf`-cronen körde det i blind `for i in 1..6` × 3 conn = 18 skanningar/körning var 30:e min, dygnet runt → ~1000 WU/h konstant (FortnoxInvoice = ~75% av API-WU). **Fix nivå 2:** loopen är nu självterminerande (`enrich_invoice_pdfs`, bryter när found<40) → steady state 1 sökning/conn. **Nivå 1 (Christians Render-åtgärd):** sänk sync_v2_pdf-frekvens */30 → 1/h eller 4/h. **Nivå 3 (permanent) ✅ GJORD 2026-06-30 (P1+P2):**
  - **P1 (Fortnox):** `invoice_sync.js` `upsertToBubble` sätter `needs_pdf_sync=true` BARA på CREATE (via `adapter.flagPdfOnCreate` på båda faktura-adaptrarna) — ej på update (saldoändring rör ej PDF → ingen churn). `/fortnox/enrich/invoice-pdfs` fick `flagged_only`-param → söker `needs_pdf_sync==true` (indexerad equality) i st.f. `ft_pdf is_empty`.
  - **P2 (HK):** ny route `POST /tengella/enrich/invoice-pdfs-flagged` — söker bara flaggade HK-fakturor (connection=TENGELLA + needs_pdf_sync==true), hämtar InvoiceId ur `ft_raw_json` → `getTengellaInvoiceById` → Url → ladda ner → patcha. Ersätter det dyra globala svepet (~3700 findOne/körning).
  - **Cron:** `pdf`-läget kör nu BARA flagg-dränen (billigt). Dyra is_empty-svepet + HK-helsvepet flyttade till `enrich_invoice_pdfs_deep` + globalt svep i `full`-läget (VECKOVIS safety-net för drift). `fetchAndStoreInvoicePdf` + nya HK-routen nollar flaggan vid success.
  - **Ingen engångsbackfill behövs:** aktiva utan ft_pdf = ~0 (verifierat 2026-06-11), nya fakturor flaggas vid create, veckovis deep-svep fångar ev. drift. Fältet `needs_pdf_sync` finns redan på FortnoxInvoice (PDF-routerna patchar det).
- **WU-FÄLLA #2: veckovisa `full`-cronen skannade om HELA året (P0, löst 2026-07-01).** Diagnos via WU-graf: söndagens `full` (`0 3 * * 0`, körde 03:00→~08:00) drog ~34k WU — `order_offer_weekly` skrev om alla 52 veckor av ordrar/offerter (per-doc `bubbleFindOne` + `bubbleFindAll(rows)`) + full-år-invoices + `reconcile_links` (helskanning ~7,7k kunder + ~20k docs). Nästan allt redundant (nattens modified-sweep håller allt färskt). **Fix i `sync_v2_cron.sh`:** `full` täcker nu bara **senaste `FULL_WINDOW_DAYS` (default 90)** — `order_offer_recent` + `invoices_recent` + tengella/workorder `sinceVM=recent`. `reconcile_links` utbruten till eget **`reconcile`-läge** (`bash sync_v2_cron.sh reconcile`) → schemalägg MÅNADSVIS i Render (t.ex. `0 4 1 * *`). Deep-PDF-safety-net kvar i full.
  - **P3 ✅ GJORD 2026-08-17:** KPI-megascanen (`computeSalesKpi` — hela FortnoxInvoice inkl `ft_raw_json`; ligger vid `SALES_TTL` ~10829, INTE i `/api/invoices` som är per-företag) → **TTL 4h→24h**. Kvar som möjlig förbättring: exkludera `ft_raw_json` / gör KPI:t inkrementellt, samt SWR så att första anropet efter TTL inte blockerar 20–60 s.
  - **P4 ✅ GJORD 2026-08-17:** `MODIFIED_DAYS_BACK` default 3→2 i `sync_v2_cron.sh` (kolla att ingen Render-env överskuggar).
  - **E-postpollerns `is_empty`-query ✅ GJORD 2026-08-17** (se WU-städningen i §0k). Kvar: 5xx-backoff i pollern.
  - **Kvar: Overnight 500/524** = Bubble "Service temporarily unavailable" (Bubble-sidig överbelastning); mindre WU-last → mindre risk.
