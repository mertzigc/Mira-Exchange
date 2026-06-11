# HANDOFF — Mira-Exchange sync-omtag

> Senast uppdaterad 2026-06-08. Läs detta + `ARKITEKTUR_OCH_OMTAG.md` (§1–9) för full kontext.
> Syfte: ny session ska kunna ta vid exakt här. Djupdesign finns i ARKITEKTUR_OCH_OMTAG.md.

---

## 0. TL;DR — var vi står (2026-06-08)
- **Fakturaspåret: KLART, validerat krona-för-krona, självgående** (cron live). F&E/Staff/HK 2026 stämmer mot Fortnox/facit.
- **§9 Order/Offer/Workorder: KLART & LIVE.** Hela omtaget (9a kärn-generalisering med delete-reconciliation → 9b fortnox-order/offer → 9c PDF → 9d tengella-workorder→unified FortnoxOrder → 9e cron-cutover) är kodat, backfillat 2026 (workorder 2025+2026), idempotensbevisat (omkörning = rent noop, 0 dubbletter) och i drift. `SYNC_V2_ORDERS=1` live, nightly grön, PDF-cron drar undan ~2600 flaggade order, weekly safety-net härdad. Gamla order/offer/workorder-cron avstängda. **Inget öppet här.** Detaljer + lärda buggar i §5/§8.
- **ClientGroup-fasen: ⛔ AVBRUTET 2026-06-08** (Christians beslut — mjuka variabler + smutsig källdata gör auto-klustring opålitlig; manuell metodik finns; rätt lever = ren data vid inmatning). Kod ligger kvar oanvänd, 0 poster skrivna. Se §6.
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
- **Backfill (2026-06-11):** manuell drän av ~450 F&E + Staff/Group + HK kördes via enrich-routerna.

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
- **`sync_v2_cron.sh` har `reconcile_clientcompany()`** som körs för BÅDE nightly och full (ej pdf), sist i körningen: (1) inkrementell Fortnox-kundsynk F&E+Staff (`days_back=$CUST_DAYS`, default 3, `max_pages=$CUST_PAGES` default 3), (2) Tengella-kundsynk (full, 119 kunder = billigt), (3) `/sync/v2-linkcustomer` (both) fyller bryggan, (4) `/sync/v2-linkcompany/all` write propagerar länken ut på dokumenten. Idempotent → steady state = noop. Kunde EJ bara återaktivera gamla cronen: den drar även gammal order/offer-synk som krockar med v2 (coexistence) → bara kund-steget extraherat.
- **Render-status 2026-06-08:** gamla kund-cronen (Mira-Exchange-CronJob, TengellaNightlySync) suspenderade — de behövs INTE mer, reconcile-steget ersätter dem. Aktiva cron: Nightly/Weekly fakturasync (= sync_v2_cron), sync_v2_pdf.
- **Svaret på "blir Mira komplett":** JA — med detta steg lever Mira sig självt givet att korrekt grunddata (orgnr) matas in i Fortnox/Tengella vid kund-skapande. Nya kunder/dokument länkas automatiskt; historiska luckor fylls när källan rättas. Restpost som aldrig länkas (privatpersoner, utländska utan svenskt orgnr, "EJ FAKTURERA"-interna) är korrekt olänkad by design.

## 8. Fallgropar (lärda)
- Fortnox rate-limit: krävde retry+backoff (`fortnoxGetRetry`) + throttle (`throttleMs`, default 200, april behövde 350). Listing-fel mitt i paginering → kastar → 500 på hela requesten; idempotent så kör om.
- Render long-running: curl `--max-time` högt; idempotent så timeout ofarlig.
- `maxRecords` räknar FÖRSÖK (inte träffar) så scoped test stoppar även vid fel.
- Bubble 100-träffars-cap: använd `bubbleFindAll` (paginerar), inte rå `bubbleFind`.
