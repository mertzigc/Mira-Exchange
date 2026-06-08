# HANDOFF — Mira-Exchange sync-omtag

> Senast uppdaterad 2026-06-05. Läs detta + `ARKITEKTUR_OCH_OMTAG.md` (§1–9) för full kontext.
> Syfte: ny session ska kunna ta vid exakt här. Djupdesign finns i ARKITEKTUR_OCH_OMTAG.md.

---

## 0. TL;DR — var vi står
- **Fakturaspåret är KLART, validerat krona-för-krona och självgående** (cron live). F&E/Staff/HK 2026 stämmer exakt mot Fortnox/facit.
- **Steg 9a (kärn-utbyggnad för rader) är KODAT + lokalt testat (2026-06-05).** Generaliserad upsert (adapter.bubbleType/keyFields), ny `upsertDocWithRows` med delete-reconciliation (städar spökrader), `bubbleDelete` injicerad. Faktura-adaptrar har tomt rows-config → enkel-dokument-vägen, oförändrad. **Väntar: Christian pushar → diff-revalidering av HK/F&E/Staff (måste vara noop-dominerat) innan vi går vidare.**
- **Steg 9b är KODAT + lokalt e2e-testat (2026-06-05).** `fortnox-order` + `fortnox-offer`-adaptrar (huvud + rader) på 9a-kärnan, registrerade → nåbara via `POST /sync/v2/fortnox-order|fortnox-offer` direkt efter deploy. **Väntar: (1) skapa nya number-fält `ft_order_ts`/`ft_offer_ts` i Bubble, (2) diff-revalidering mot Fortnox order/offer-totaler innან write.**
- **Steg 9c är KODAT (2026-06-05).** Sync flaggar `needs_pdf_sync=true` på order/offer (create+update); generisk `fetchAndStoreOrderPdf` (index.js, `/orders/{n}/preview`, ingen Offert-wrapper); separat PDF-cron `POST /sync/v2-pdf/:source` (token cacheat per connection, bundet av `maxRecords`).
- **Steg 9d är KODAT + lokalt e2e-testat (2026-06-05).** `tengella-workorder`-adapter → unified `FortnoxOrder`/`FortnoxOrderRow` (connection=TENGELLA, `source="tengella-workorder"`). Global discovery `/v2/WorkOrders` (cursor, inbäddade rader, pass-through fetchComplete), härled `ft_total`=Σ(pris×antal) + net via 25%. `listWorkOrders` injicerad.
- **Steg 9e FÖRBEREDD i kod (2026-06-05), EJ aktiverad.** `sync_v2_cron.sh` har order/offer/workorder + `pdf`-läge bakom env-flagga `SYNC_V2_ORDERS` (default 0). Aktivering = operativ cutover (stäng av gamla cron FÖRST), se §5 9e runbook.
- **CUTOVER LIVE 2026-06-08 ✅.** `SYNC_V2_ORDERS=1` aktiv. Nightly grön med order/offer/workorder (nya docs create, allt annat noop, err 0). PDF-cron (`sync_v2_pdf`, */30) drar 50/run, betar av ~2600 flaggade order. Weekly safety-net (`full`) hängde på helårs-invoice → härdat: resilient `post` (fel→fortsätt, ej abort), max-time 30min, invoices kvartalsvis. Gamla order/offer/workorder-cron avstängda.
- **LIVE-STATUS 2026-06-07: BACKFILL KLAR + idempotent för alla tre källor.** order F&E (2026, maj veckodelad), offer F&E (2026, feb+maj veckodelade), workorder→FortnoxOrder (2025+2026) — alla kör nu rent noop på omkörning (heads u=0, rows u=0/del=0, err=0). Bubble-fält skapade. **ENDA som återstår = 9e operativ cutover** (stäng gamla cron → `SYNC_V2_ORDERS=1` → pdf-cron). Buggar lösta under backfill: linked_company-fält saknades, 401-token-refresh, tunga månader måste chunkas, FortnoxOrderRow ft_discount/ft_vat är NUMBER (ej ""), härledda belopp måste round2.
- Efter order/offer/workorder: **ClientGroup-fasen** (kundkort-bundling).

### 📌 SCOPE-FAKTA (2026-06-05): order/offer = BARA F&E
- **Staff har endast faktura i Fortnox.** Staffs order/offert skapas i **Intelliplan** (separat system) → `/orders` på Staff-kontot ger `400` (modulen finns ej). Kör därför `fortnox-order`/`fortnox-offer` **enbart för F&E** (`1771579463578x385222043661358460`). Cron uppdaterad därefter.
- **Intelliplan order/offert = framtida egen källa** (egen adapter → samma unified FortnoxOrder/FortnoxOffer, connection=Staff eller egen). Ej i scope nu.

### ⚠️ ÖPPET före 9b/9c-write (läs!)
1. **Skapa i Bubble:** `ft_order_ts` (number) på FortnoxOrder, `ft_offer_ts` (number) på FortnoxOffer. Annars ignoreras fältet vid write (Bubble droppar okända fält tyst) → datumfilter saknar pålitlig nyckel.
1b. **Skapa på FortnoxOrder i Bubble (9c):** `needs_pdf_sync` (yes/no), `ft_pdf` (file), `ft_pdf_fetched_at` (text). FortnoxOffer har dem redan. Utan dessa nollar PDF-cronen aldrig flaggan → samma dokument hämtas om och om.
1c. **Skapa på FortnoxOrder i Bubble (9d):** `source` (text). Sätts till `"fortnox"` (fortnox-order) resp `"tengella-workorder"` (workorder) för spårbarhet i unified-modellen. Skrivs additivt vid varje write, ej i compareFields (ingen diff-brus). Utan fältet droppas det tyst.
2. **Coexistence-krig:** gamla cron (`fortnox_cron_v1.sh` m.fl.) skriver fortfarande FortnoxOrder/Offer + rader. Nya adaptern speglar EXAKT befintliga fältnamn, beloppstyper (order-rad=STRÄNG, offer-rad=NUMBER) och `ft_unique_key`-format just för att undvika create/delete-krig — men kör INTE nya order/offer-write i cron parallellt med gamla på samma dokument. Manuell scoped write OK för validering. Full cron-cutover = 9e (stäng av gamla först). Nyckel-standardisering medvetet uppskjuten till dess.

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
- `linked_company` sätts EJ på order/offer idag (men resolvbart via FortnoxCustomer-bryggan som faktura).
- Workorder: `upsertTengellaWorkorderToBubble` (~7259), rader `upsertTengellaWorkorderRowToBubble` (~7362). Ekonomi bara på rad (price/cost_price, ingen moms). Blir EJ faktura automatiskt (indirekt via rad-`invoiced`).
- **Ingen av de tre städar borttagna rader idag** = luckan 9a fixar.
- **Ingen Bubble fil-GC** finns → PDF-omskrivning läcker gamla filer.

---

## 6. Senare faser
- **ClientGroup (kundkort-bundling) — PÅGÅR (CG-1 kodat 2026-06-08):** rörig kunddata — samma företag har flera orgnr/Fortnox-ID/Tengella-ID. Org 556718-6654 (Alecta Fastigheter) har 3 FortnoxCustomers med olika namn (Alfab Göteborg 3/4, Ullevi Park) → org-matchning konflaterar fastigheter. Plan: ClientCompany = faktureringsenhet (källidentitet, ej org); ClientGroup (Bubble-typ: companies[], primary_company, name, logo, slug — lägg till org_numbers[], aliases[]) = kundkort som buntar. **Beslut 2026-06-08: orgnr = HINT (ej facit), conflate-fall flaggas för människa, källidentitet bevaras.**
  - **Datamodell (kartlagd):** ClientCompany nycklas på `Org_Number`+`ft_customer_number`. Bryggor: `FortnoxCustomer.linked_company` + `TengellaCustomer.company` → ClientCompany. Org-helpers: `normalizeOrgNo` (~6671), `findClientCompanyByOrgNo` (~6725). Gammal destruktiv dedup: `/customer/diag-by-org` + DEDUP-APPLY (mergar+raderar CCs) — ClientGroup ERSÄTTER den med icke-destruktiv buntning.
  - **CG-1 ✅ KODAT + lokalt testat:** `clientgroup.js` (DI) + `POST /clientgroup/suggest` (read-only). Föreslår `clusters` (union på identiskt normaliserat namn ELLER orgnr; namn+orgnr→high, samma-namn/olika-org=split→high, samma-org/olika-namn=conflate→low+flagga), `conflate_by_source` (CC vars käll-kunder har olika namn), `stats`. Skriver INGET. **Väntar: deploy + kör mot live, granska skala → designa CG-2.**
  - **CG-2 (nästa):** ClientGroup-skrivning från BEKRÄFTADE kluster (companies[], primary_company, org_numbers[], aliases[]). Durabelt — synken river aldrig bekräftad gruppering. **CG-3:** sync-integration (nya kunder auto-föreslås in i grupper, flaggas).
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
- **`linked_company` måste finnas på FortnoxOrder + FortnoxOffer** (skapat). Saknas fältet → Bubble 400 `Unrecognized field` → HELA skrivningen failar. Skrivs bara på create/update (noop backfillar EJ) → historisk backfill görs i ClientGroup-fasen. Bubble case-sensitive: fältet heter exakt `linked_company` (som FortnoxInvoice).
- **FortnoxOrderRow `ft_discount`/`ft_vat` är NUMBER-fält i Bubble** (inte text, trots tidigare audit). Skicka ALDRIG `""` → Bubble 400 `INVALID_DATA: Expected a number, but got a string (original data: "")` → bubbleCreate kastar → rad-create failar tyst som `rows.error`. Workorder-rader (saknar rabatt/moms) sänkte hela rad-persisteringen pga detta → fixat: skicka `null` för tomma number-fält. Order-rader härdade likadant (Number/null, ej String/""). Lärdom: empty-string-fallback funkar bara för TEXT-fält; number-fält kräver null. (ft_price/ft_total är text-fält → "" OK där.)
- **Härledda belopp måste avrundas (2 dec) för idempotens.** Workorder härleder `ft_total`/`ft_net`/`ft_totalvat` (huvud) och rad-`ft_total` = qty×price → float-artefakter (`950.4000000000001`) → `eqLoose` ser ≠ lagrat `950.4` → evig `update`-churn. Fix: `Math.round(n*100)/100` på alla härledda belopp. Order/offer opåverkade (använder Fortnox råa belopp). Efter deploy: en sista städ-update per workorder, sen konvergerar allt till noop.
- **Token-utgång mid-svep (401):** fixat med `fortnoxGetAuthed`-wrapper i invoice_sync.js — force-refreshar (`ensureFortnoxAccessToken(id, true)`) och kör om vid 401. `ensureFortnoxAccessToken` har nu `force`-param. Gäller faktura+order+offer, list+detail.
- **Order F&E 2026-backfill KLAR + idempotent (2026-06-07):** Jan–Jun noop, Jul–Dec tomt, err=0 hela vägen. Maj (~712 ordrar/~8266 rader) var för tung för en request → delades i veckor.
- **TUNGA MÅNADER måste delas vid full-resync:** en enskild månad-request kan timeouta (>25 min). Maj F&E behövde veckofönster (`fromdate`/`todate` per vecka). Cron `full` kör helår i ett svep per source → kan timeouta på tunga konton; överväg månads-/vecko-chunkning i cron `full` om det smäller. Nightly (`modifiedDaysBack`) är litet och opåverkat.
- **F&E orderволym: ~500–600/månad.** `sinceYM` (utan övre gräns) listar månad→årsslut = O(n²) sidor + långa requests → använd `fromdate`+`todate` (riktiga månadsfönster) vid manuell backfill. Detail-anrop sker per dok även vid noop (Bug 1-design) → backfill är tung men engångs; nightly använder `modifiedDaysBack`.
- **Order/offer = BARA F&E** (Staff = faktura only; order/offert i Intelliplan → /orders 400 på Staff).

## 8. Fallgropar (lärda)
- Fortnox rate-limit: krävde retry+backoff (`fortnoxGetRetry`) + throttle (`throttleMs`, default 200, april behövde 350). Listing-fel mitt i paginering → kastar → 500 på hela requesten; idempotent så kör om.
- Render long-running: curl `--max-time` högt; idempotent så timeout ofarlig.
- `maxRecords` räknar FÖRSÖK (inte träffar) så scoped test stoppar även vid fel.
- Bubble 100-träffars-cap: använd `bubbleFindAll` (paginerar), inte rå `bubbleFind`.
