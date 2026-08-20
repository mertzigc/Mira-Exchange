# Intelliplan — Service & People (Carotte Staff)

> **SCOPE: Intelliplan är BARA Carotte Staff (Service & People).** Inte koncernen.
> Housekeeping ligger i Tengella, Food & Event i Fortnox+Mira. Se `../HANDOFF.md`.
>
> **API-ytan är BARA `/gridreport/{id}/{lang}`.** Ingen schema-endpoint, ingen
> endpoint som listar mallar (8 kandidatvägar testade 2026-08-19, alla 404).
> Rapport-id måste läsas ur Intelliplans UI.
>
> **Kända rapporter:** `1058` intäkt per kund+order/månad · `1081` intäkt per
> dag+kontor · `1063` lönekostnad (bär `Consultant1/2` — persondata) · `1039`
> delmängd av 1058. Carotte har 23 mallar, id 1027–1080.
>
> 🔍 **ÖPPET SPÅR (2026-08-20):** pass/schemaläggning per kund med konsultnamn.
> Kräver en rapportmall med tid/pass-kornighet — ingen av de fyra kända har det.
> Mallarna är användarredigerbara ("Add columns"), så Carotte kan bygga en själva.
>
> Kod: `intelliplan.js` · `intelliplan_sync.sh` · `intelliplan_cron.sh`
> Minne: `reference-intelliplan-api`

---
### INTELLIPLAN — Rapport-API (steg 1–2 byggt 2026-08-19, EJ deployat)
Fjärde datakällan jämte Fortnox/Tengella/Caspeco. Förhandlingen klar; nu läsning av gridreports, **skrivendpoints kommer i vinter** och växer in i samma modul.

**⚠️ Integrationsguiden (PDF) är i praktiken tom på text** — titel + tre skärmbilder. Innehållet fick extraheras genom att plocka ut de inbäddade bilderna ur PDF:en och läsa dem som bilder (`pdftoppm`/poppler saknas på maskinen, så Read-verktygets PDF-väg gick inte). Allt guiden säger:
- **Token:** `POST https://{tenant}.idp.intelliplan.eu/connect/token`, `x-www-form-urlencoded`, `grant_type=client_credentials` + client_id/secret + `scope=processengine` → `{access_token, expires_in:3600, token_type:"Bearer", scope}`.
- **Rapport:** `GET https://integrations-{tenant}.api.intelliplan.eu/gridreport/{id}/{lang}?overrideDatePeriodFilter=true&dateFrom=&dateTo=` med `Authorization: Bearer` + en `Cookie:`-header.
- **TVÅ olika värdmönster** (`{tenant}.idp` vs `integrations-{tenant}.api`) — med tenant `carotte-se` blir det `carotte-se.idp.intelliplan.eu` resp. `integrations-carotte-se.api.intelliplan.eu`.

**Guiden svarar INTE på:** vilka rapport-id som finns (exemplet visar bara `1`), svarsformatet, paginering, rate limits. Därför är steg 2 ren rekognosering innan någon datamodell designas.

**`intelliplan.js` (NY modul):** `createIntelliplanClient({...})` → `config()` · `ensureAccessToken()` · `tokenInfo()` · `request()` · `getGridReport()`. Plus `describeReportPayload()` som beskriver ett okänt svar (form, radantal, kolumnnamn, exempelrad) i stället för att dumpa allt.
- **Token-cache med marginal:** förnyar vid 90 % av `expires_in` (3600 s → 3240 s), aldrig ett anrop med död token. In-flight-dedup så samtidiga anrop ger EN hämtning. 401 mitt i ett anrop → tvinga ny token och gör om EN gång.
- **⚠️ COOKIES hårdkodas ALDRIG.** Guidens curl-exempel innehåller konkreta `ARRAffinity`-värden — det är Azure App Services instans-stickiness, bunden till EN instans hos Intelliplan. Kopierat värde fungerar tills instansen byts, sen blir det svårfelsökta fel. Klienten fångar i stället `set-cookie` från svaren och skickar tillbaka dem, som en webbläsare. Smoke-testet vaktar att guidens värde inte finns i koden.
- **⚠️ `overrideDatePeriodFilter=true` sätts BARA när datum skickas.** Utan den flaggan använder rapporten sin egen sparade period och inskickade datum blir tysta no-ops. Utan datum ska vi inte tvinga override.
- **⚠️ Hemligheten läcker aldrig.** `config()` (som går ut över HTTP i `/debug-env`) visar närvaro + ett sha256-fingeravtryck på 8 tecken — nog för att verifiera att RÄTT secret är deployad, aldrig värdet. Saknad env → `503` som namnger exakt vilka variabler som fattas.

**Endpoints (`index.js`, x-api-key-grindade — INTE i openPrefixes, den listan är för x-admin-token-block):**
`GET /admin/intelliplan/debug-env` · `/auth/test?force=1` · `/report/:id?lang=sv&from=&to=&raw=1` · `/probe?ids=1,2,3` (knackar på flera rapport-id sekventiellt med 300 ms paus — vi vet inget om deras rate limits). **Ingen av dem skriver till Bubble.**

**Env (Render, inlagda 2026-08-19):** `INTELLIPLAN_TENANT=carotte-se` · `INTELLIPLAN_CLIENT_ID` · `INTELLIPLAN_CLIENT_SECRET`. Valfria: `INTELLIPLAN_SCOPE` (default `processengine`), `INTELLIPLAN_IDP_BASE`, `INTELLIPLAN_API_BASE` (om värdarna flyttar).

**Verifierat:** `intelliplan_smoke.mjs` **80/80** med mockad fetch (URL-mönster, token-cache/marginal/dedup, 401-retry, 500 utan retry, cookie-fångst, datumfilter, felkroppar bevarade, hemligheten aldrig i svar eller fel). **Mutationstestat:** secret i klartext i config fäller 2 · borttagen förnyelsemarginal 1 · borttagen `overrideDatePeriodFilter` 1 · cookies som inte skickas vidare 2 · persondata-grinden alltid öppen 5 · naiv `split(",")` i st.f. CSV-parser 1 · ingen avgränsar-sniffning 1.

**Steg 1–2 KÖRDA SKARPT 2026-08-19 — auth verifierad.** `/debug-env` + `/auth/test` gröna mot live: tenant `carotte-se`, båda värdmönstren stämmer, `client_credentials` + `scope=processengine` beviljas, `refresh_in_seconds: 3240` (marginalen fungerar). Secret-fingeravtryck: `289ef8f0`.

**⚠️ RAPPORT-ID ÄR FYRSIFFRIGA, INTE 1–8.** Probe över 1–8 gav 503 på alla:
`Shuffler error -> GET /grid-report/v2/download -> "sv[Failed to read GridReport2Template.]. Data kunde inte hittas"` / `developerMessage: "Could not find GridReportTemplateDto"`.
Guidens `gridreport/1/sv` är alltså ett EXEMPEL, precis som `tenant-name` och `{YOUR_CLIENT_ID}`. **Carottes första kända rapport-id: `1063`** (ur Intelliplans egen Postman-samling "Carotte BI-access"). Blind skanning är meningslös — id:n måste komma från Intelliplan. Att felet blir `503` och inte `404` är deras felinpackning; tolka det inte som att tjänsten är nere.

**⚠️ SVARET ÄR CSV, INTE JSON.** Bekräftat mot 1063 (81 kB, 200 OK): rubrikrad `FinancialItemNote1,Article1,Article2,Consultant1,Consultant2,Order1,Order2,SalaryCost1` + kommaseparerade rader. `describeReportPayload` har därför en CSV-gren med **riktig parser** (citerade fält, inbäddade kommatecken, `""`-escape) — en `split(",")` hade tyst förskjutit alla kolumner efter ett textfält med komma i. Avgränsare sniffas (komma/semikolon/tab). `rows_with_other_column_count` rapporteras: avviker radernas kolumnantal är det ett tecken på feltolkad citering eller grupperade sektioner, och det ska synas.

**⚠️ PERSONDATA.** Rapporten bär konsultnamn och lönekostnader (`SalaryCost1`). Därför: `describeReportPayload` returnerar **aldrig** en datarad utan `sample:true`, endpointen kräver `?sample=1` (eller `raw=1`), probe-läget visar aldrig rader, och **loggen skriver bara form/volym/kolumnantal — aldrig radinnehåll**. Kolumnnamn + antal räcker för att designa datamodellen.

### ⭐ RÄTT RAPPORT ÄR 1058 (kartlagt 2026-08-19)
Carotte har **23 rapportmallar**, id 1027–1080, synliga i Intelliplans Reporting-vy. `1063` (SalaryCost) var fel startpunkt — den saknar kund, nyckel och användbar kornighet.

**`1058` "Intäkt totalt (ink kund och uppdrag)" är källan.** 13 kolumner, 232 rader för juni 2026:
`DeliveryOffice1/2` (id+namn, 4 kontor) · `Account1/2` (**id+namn, 84 kunder — KUNDNYCKELN**) · `Order1/2` (id+namn, `"999 - Ordernamn"`) · `SalesPerson1/2` · `Revenue1` · `Cost1` · `Hours1` · `GrossMargin1` · `GrossMarginPercentage1`.

- **⭐ KORNIGHETEN ÄR EN RAD PER ORDER OCH PERIOD.** `Order1` har `distinct_ratio: 1.0` (231 distinkta av 231 ifyllda). Naturlig nyckel = **`(period, order_id)`** → periodomläsning blir idempotent utan rad-id. Det löser luckan jag flaggade mot 1063.
- **⭐ `Account1` är ett numeriskt kund-id** (3–1302, 84 distinkta), inte ett namn. Kopplingen till `ClientCompany` kan alltså gå på ett stabilt id som överlever namnbyten — men mappningen Account→ClientCompany måste byggas en gång (84 kunder).
- **⚠️ `GrossMarginPercentage1` är en ANDEL, inte procent.** max = 1, min = -56,16. UI:t visar 27 % där CSV:n har 0,27. Multiplicera inte två gånger.
- **⚠️ En rad saknar Account/Order/DeliveryOffice** (231 av 232 ifyllda) — "No connection"-raden i UI:t. Bär ändå Revenue. Ska mappas som "utan order", inte tyst droppas.
- **⚠️ `SalesPerson1/2` är i praktiken tom** (2 av 232). UI:t visar "No connection" på varje rad. Räkna inte med säljarkopplingen.
- Summorna stämmer exakt mot UI:t: Revenue 6 850 058,36 · Hours 17 641,77 · GrossMargin 1 742 484,14 · Cost 5 107 574,22.

**`1039` "Timmar och intäkter" är en delmängd av 1058** — identisk kornighet (232 rader, 84 konton, 231 ordrar, samma Revenue-summa) med bara `Account/Order/Revenue/InvoiceHours1/Hours1`. Enda mervärdet är **`InvoiceHours1`** (17 637,77 mot Hours 17 641,77 — debiterbart vs totalt). Bäst: lägg till InvoiceHours som kolumn i 1058 via **"Add columns"** och kör EN rapport.

**⭐ Mallarna är användarredigerbara** ("Add columns"-knappen i Reporting-vyn) — frågan om att utöka behöver inte gå via Intelliplans support.

**Volym:** 232 rader/månad ≈ 2 800/år. Fullt hanterbart i Bubble, till skillnad från 1063:s 28 000.

### STEG 4 — synk av rapport 1081 → Bubble. **LIVE och verifierat 2026-08-19**
**Skarp körning bekräftar allt:** juni 2026 → 121 rader i Bubble, `revenue_total 6 850 058,36` (identisk med 1058 OCH 1039 — tre rapporter, tre kornigheter, samma krona). Omkörning gav `created:0, updated:0, unchanged:121` → **idempotensen håller** och synken skriver INTE om rader i onödan (WU-fällan verifierad skarpt, inte bara i test). Att alla 121 var `unchanged` bevisar dessutom att `ip_office`/`ip_office_id` lagrades korrekt — hade de varit tomma i Bubble hade de 98 kontorsraderna hamnat i `to_update`.

**`1081` "mira-rapport-1"** (skapad av Christian): `Date1` · `Date2` · `ConsultantOffice1` · `ConsultantOffice2` · `Revenue1`. 121 rader för juni 2026. **En rad per (datum, kontor).**
- **⭐ Ingen persondata alls** — bara datum, kontor, belopp. Därför får den här synken logga fritt, till skillnad från 1058/1063.
- **⭐ Revenue1 summerar till 6 850 058,36 — EXAKT samma som 1058.** Två olika rapporter, olika kornighet, identisk total. Bekräftar auth, CSV-parsern och Intelliplans aggregering på en gång.
- **`Date2`** är ISO och den vi använder. **`Date1` är dagar sedan 1970-01-01** (verifierat: 20605 = 2026-06-01, 20634 = 2026-06-30) och används som **korskontroll** — spretar de har vi läst fel kolumn och normaliseraren KASTAR.
- Kontor kan saknas ("No connection", 23 av 121 rader) → nyckeln får `none`. **Utan det hade alla kontorslösa rader kolliderat på samma nyckel** och skrivit över varandra, en per dag.

**`normalizeRevenueDay(csv)` (intelliplan.js):** rader `{key, date, office_id, office, revenue}` + `revenue_total`, `dates`, `offices`, `warnings`. **Stannar** vid ändrade kolumnnamn (felet listar vad som faktiskt kom), datumspret och dubbel nyckel — det sista betyder att kornighetsantagandet inte håller och ska aldrig tystas. `strict:false` varnar i stället för att kasta.

**`POST /admin/intelliplan/sync/revenue-day {from,to,dry_run}`:** **torrkörning är default.** Upsert på `ip_key` = `"<ISO-datum>|<kontor-id|none>"` → periodomläsning är idempotent. Patchar BARA när ett mätvärde faktiskt ändrats (annars skrivs 120 rader varje natt bara för att `synced_at` rört sig). Befintliga rader läses **constraintat på datum**, inte helsvep. Rader i Bubble som inte längre finns i rapporten rapporteras som `orphans`. Efter första create läses en rad tillbaka och fälten verifieras → `502 fields_missing_on_type` om Bubble droppat något tyst (se [[reference-bubble-tysta-faltdrop]]).

**⚠️ BUBBLE-DATATYP SOM MÅSTE SKAPAS: `IntelliplanRevenueDay`** — fält (exakta namn): `ip_key` (text) · `ip_date` (date) · `ip_office_id` (number) · `ip_office` (text) · `revenue` (number) · `ip_report_id` (number) · `synced_at` (date). Typen måste vara API-modify-bar.

**`intelliplan_sync.sh`:** torrkörning som default, `--apply` för skarpt, senaste `MONTHS` (default 3) hela månader eller explicit period. Nattlig cron: utan datum + `--apply`.

**⚠️ Varför periodomläsning och inte delta:** en månad VÄXER efter månadsskiftet. Juli mitt i månaden hade 1 024 rader/1,56 Mkr mot junis 2 315/3,2 Mkr. En engångsläsning skulle frysa halva sanningen.

**⚠️ Volymvarning inför 1058:** frestelsen är att lägga `Date` på 1058 och få kund + dag på en gång. Men Date **exploderar** rapporten: 232 ordrar × ~22 arbetsdagar ≈ 5 000 rader/mån = 60 000/år. Månadsgrain per kund/order (232/mån ≈ 2 800/år) räcker för kundkortet. Gör inte det tillägget i förbifarten.

**Verifierat:** `intelliplan_smoke.mjs` **125/125**. **Mutationstestat:** borttagen `none`-nyckel fäller 1 · ingen kolumnkontroll 2 · ingen datum-korskontroll 2 · synk som skriver by default 1. Regression: samtliga 19 sviter gröna.

**⚠️ BUBBLE-CONSTRAINTS: "greater than or equal" FINNS INTE.** Första skarpa körningen gav `bubbleFind failed.` utan orsak. Datatypen var korrekt skapad och API-exponerad — felet var att jag constraintade `ip_date` med `greater than or equal`/`less than or equal`. **Bubbles Data API stöder bara** `equals · not equal · greater than · less than · in · not in · contains · not contains · text contains · is_empty · is_not_empty · geographic_search`. En ogiltig `constraint_type` avvisar HELA frågan. Dessa två rader var de enda i hela kodbasen som använde varianterna — resten har alltid kört `greater than`/`less than`. Inklusivt intervall görs nu med exklusiva gränser (dagen före / dagen efter). Smoke-testet vaktar att inga "or equal"-constraints smyger in igen, någonstans i `index.js`. Dessutom bär 502-svaret nu Bubbles egen felkropp — utan den blev `bubbleFind failed.` en återvändsgränd.

**⚠️ FALSK POSITIV i läs-tillbaka-kontrollen (löst 2026-08-19).** Första skarpa `--apply` gav `502 fields_missing_on_type: ip_office_id, ip_office` — men fälten fanns, korrekt skapade. **Bubble lagrar inte null:** ett fält vi skickar som `null` sätts inte alls och kommer tillbaka `undefined`. Kontrollen tog blint `toCreate[0]`, och rapportens FÖRSTA rad är "No connection" (kontor = null, 23 av 121 rader). Fix: probe-raden väljs efter FLEST ifyllda värden, och bara fält vi faktiskt skickade ett värde för jämförs. **OBS: raderna SKAPADES trots felsvaret** — `_bulkCreate` kör före kontrollen. Idempotensen räddade det: omkörning gav `unchanged`, inga dubbletter. Lärdom: en läs-tillbaka-verifiering måste skilja på "fältet saknas" och "värdet var tomt".

**Deploy:** (1) **Bubble: skapa `IntelliplanRevenueDay`** enligt fältlistan. (2) `index.js` + `intelliplan.js` till Render. (3) Torrkör `./intelliplan_sync.sh 2026-06-01 2026-06-30`, jämför `revenue_total` mot 6 850 058,36. (4) `--apply`. (5) Cron.

### STEG 5 — kundnivå: rapport 1058 → Bubble. BYGGT 2026-08-19, EJ deployat
**⚠️ KUNDENS ORGNR FINNS INTE ATT HÄMTA.** Kolumnen `AccountCompanyOrgNo1` ("Legal Company - OrgNr (Customer)") lades till och gav **ett enda distinkt värde på 231 rader** — `556858-0392`, alltså **Carottes eget** organisationsnummer. Intelliplan modellerar "Legal Company" som den EGNA juridiska personen i alla dimensioner, oavsett vad parentesen anger. Genomsökning av `org`- och `customer`-träffarna (35 resp. 54 kolumner) gav inget kund-orgnr. **Kolumnprofileringen fångade det direkt via `distinct: 1`** — utan den hade vi byggt kundmappningen på en konstant och upptäckt det när alla 84 kunder pekade på samma `ClientCompany`. Normaliseraren läser därför kolumnen medvetet INTE.

**Mappningen är manuell — och det är rätt beslut.** `Account1` är ett stabilt numeriskt kund-id (84 distinkta). Engångsmappning med namnförslag slår en automatisk namnmatchning som tyst kan gå fel.

**TVÅ Bubble-datatyper (måste skapas):**
- **`IntelliplanOrderMonth`** — faktarader, en per (period, order): `ip_key`(text) · `ip_period`(text) · `ip_order_id`(number) · `ip_order_name`(text) · `ip_account_id`(number) · `ip_account_name`(text) · `ip_office_id`(number) · `ip_office`(text) · `revenue`(number) · `cost`(number) · `hours`(number) · `gross_margin`(number) · `gross_margin_ratio`(number) · `client_company`(ClientCompany) · `ip_report_id`(number) · `synced_at`(date)
- **`IntelliplanAccount`** — mappningen: `ip_account_id`(number) · `ip_account_name`(text) · `client_company`(ClientCompany) · `last_seen`(date)

**⚠️ Varför EGEN mappningstyp och inte ett fält på ClientCompany:** omappade konton måste SYNAS. Ligger kopplingen bara på ClientCompany blir ett okänt konto osynligt — och dess omsättning försvinner tyst ur kundvyn.

**`normalizeOrderMonth(csv, {periodKey})`:** nyckel `"<YYYY-MM>|<order_id|none>"`. Ordernamnet strippas från id-prefixet (`"53 - Serveringspersonal"` → `"Serveringspersonal"`), råa etiketten bevaras. Raden utan order behålls (bär omsättning — droppas den stämmer inte totalen). Stannar vid ändrade kolumnnamn, dubbel order i samma period och felaktig `periodKey`.

**Endpoints:** `POST /admin/intelliplan/sync/order-month {from,to,dry_run}` (torrkörning default) · `GET /admin/intelliplan/accounts?unmapped=1` (konton + matchningsförslag; företagsnamn ur **delade CC-cachen** → noll Bubble-anrop) · `POST /admin/intelliplan/accounts/map {mappings[], apply_confident}`.

**⚠️ MÅNADSGRIND:** kornigheten är kalendermånad. Ett spann över flera månader klumpas ihop av Intelliplan och `period_key` skulle ljuga. `_ipMonthGuard` kräver månadens första till sista dag (klarar februari och skottår).

**⚠️ KONTONA ÄR ANLÄGGNINGAR, INTE BOLAG** (upptäckt i skarp data 2026-08-19). Kontonamnen är `Gothia Towers- Seasons` · `Gothia Towers - Imagine` · `Gothia Towers - Mässan` · `Gothia Towers - Heaven 23` · `Gothia-Bankett` · `Läppstiftet Reception` · `Fastighetsreception Vikingsgatan`. **Mappningen är många-till-en** — Gothia Towers ensamt har fem konton. Designen bär det (flera `IntelliplanAccount` → samma `ClientCompany`), men namnmatchningen behövde hjälp: `suggestAccountMatches` poängsätter nu både hela namnet OCH prefixet före separatorn (` - ` eller `- `), och redovisar `via: "namn" | "prefix"`.

**⚠️ `confident` kräver EXAKT träff på HELA namnet** och att tvåan inte ligger nära. **En prefixträff (0,95) föreslås men blir ALDRIG confident** — den säger "kontot hör till den kundens grupp", inte "kontot ÄR kunden". Det ska en människa avgöra. `apply_confident:true` kopplar bara entydiga helnamnsträffar.

**⚠️ Faktaraderna bär `client_company` från SYNKTILLFÄLLET** — efter en mappningsrunda måste berörda perioder köras om, annars pekar gamla rader fortfarande på ingenting. Svaret från `/accounts/map` påminner om det.

**Verifierat:** `intelliplan_smoke.mjs` **194/194**. Torrkörning mot juni 2026 stämmer på alla fyra måtten: omsättning 6 850 058,36 · kostnad 5 107 574,22 · timmar 17 641,77 · TB 1 742 484,14 · 232 rader · 84 konton. **Mutationstestat:** confident vid tvetydig match fäller 1 · dubbel order oupptäckt 1 · ostrippat ordernamn 1 · månadsgrinden ej anropad 1 · flermånadersspann tillåtet 1 · halv månad tillåten 1 · ingen prefixmatchning 3 · prefixträff som confident 1. Regression: samtliga 19 sviter gröna.

**⚠️ `sharedCompanyFullMap` är ASYNC.** Glömt `await` i `/accounts` gav det kryptiska `"full.values is not a function"` (ett Promise har ingen `.values`) — tillräckligt otydligt för att man börjar leta på fel ställe. Kodbasen awaitar den överallt annars. Smoke-testet vaktar nu att INGET anropsställe i hela `index.js` saknar `await` (lookbehind utesluter deklarationen).

**Ordning vid uppsättning:** (1) skapa båda datatyperna · (2) deploya · (3) `REPORT=order ./intelliplan_sync.sh 2026-06-01 2026-06-30` (torrkörning — jämför `revenue_total` mot 6 850 058,36) · (4) `--apply` → kontona skapas omappade · (5) `GET /accounts` → mappa · (6) kör om perioden så faktaraderna får kundkopplingen.

**Nästa steg:** `./intelliplan_probe.sh 1063 2026-07-01 2026-07-31` → kolumnkarta → be Intelliplan om ÖVRIGA rapport-id (och om det finns en endpoint som listar dem) → **steg 4:** normaliserare + Bubble-datatyp, där kundmatchningen mot `ClientCompany` är den svåra biten (samma problem som `resolveInvoiceCustomer` löser för Tengella). Kolumnnamnens `1`/`2`-suffix antyder grupperade kolumner — behöver förstås innan mappning → **steg 5:** cron med nattligt delta + `_bulkCreate`.

**Deploy:** `index.js` + nya `intelliplan.js` till Render. Inga Bubble-ändringar, inga HTML-block.


### INTELLIPLAN steg 5 — NATTLIG CRON (byggt 2026-08-20, EJ deployat)
**`intelliplan_cron.sh` (NY).** Preflight `/version` (vilken commit kör?) → preflight `/admin/intelliplan/auth/test?force=1` (utgånget secret ska bli ett auth-fel överst, inte "0 rader" långt ner) → `intelliplan_sync.sh --apply`, `MONTHS=3` rullande. `MONTHS=12` för engångs-backfill, `DRY=1` för torrkörning.

**⚠️ VARFÖR HELA PERIODER, INTE DELTA:** en månad VÄXER efter månadsskiftet (juli mitt i månaden hade 1 024 rader mot junis 2 315). Upserten är idempotent på `ip_key` och patchar bara när ett mätvärde ändrats — en oförändrad månad läser men skriver inget. Höj inte `MONTHS` "för säkerhets skull"; backfill är en engångskörning.

**⚠️ `post_sync` i `intelliplan_sync.sh` var tyst.** Den pipeade `curl -sS` rakt in i `json.tool` — utan `--fail`, utan statuskoll. `curl -sS` returnerar **0 även på HTTP 500**, så en nattlig körning som failade hade sett lyckad ut i cron-loggen. Samma klass av tystnad som `.catch(() => [])`. Nu: HTTP-status + `ok:true` krävs, misslyckade perioder räknas, exitkod 1. Varningar och antal omappade konton lyfts ur JSON:en så de inte drunknar.

**⚠️ INTE `--fail-with-body`** i preflighten — flaggan kräver curl ≥ 7.76 och Renders image är inte verifierad. En okänd flagga hade gett "auth misslyckades" fast auth var frisk. Manuell statuskoll i stället.

**Verifierat mot en fejkad Mira-server** (fyra lägen): `ok` → exit 0 + varningar synliga · `HTTP 500` → exit 1 · `ok:false` med HTTP 200 → exit 1 · `authfail` → ABORT innan synken, exit 1. **Mutationstestat:** med den URSPRUNGLIGA `post_sync` ger HTTP 500 **exit 0** — buggen var verklig, inte hypotetisk.

**Deploy:** `index.js` + `bokningslage.js` + `intelliplan_sync.sh` + `intelliplan_cron.sh` → Render. Registrera `intelliplan_cron.sh` som Render Cron Job efter midnatt svensk tid och **efter** fortnox/tengella-jobben (så ClientCompany-mappningen är färsk när kontona matchas). Inga Bubble-ändringar.

**⚠️ SCOPE-KORRIGERING (Christian, 2026-08-19):** Intelliplan är **bara Carotte Staff (Service & People)** — inte koncernen. Lönsamhet per kund för hela Carotte går INTE att härleda ur 1058 ensamt. Bokningsläget ska i stället ställa de tre affärsområdena bredvid varandra: **S&P = Intelliplan · Housekeeping = FortnoxOrder(connection=TENGELLA, workorder) · F&E = FortnoxOrder(connection=FE) + MiraOrder**. Det är därför `bokningslage.js` finns, och därför F&E-överlappet måste mätas innan något summeras.
