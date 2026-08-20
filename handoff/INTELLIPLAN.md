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
> **Kör `./intelliplan_scan.sh` för att hitta resten** (se nedan).
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

---

## 🔎 MALL-SPANING — `intelliplan_scan.sh` (byggt 2026-08-20)

Christian hittar inga mall-id:n i Intelliplans UI och det finns ingen
dokumentation. Intelliplan har heller **ingen endpoint som listar mallar**
(åtta kandidatvägar testade, alla 404 — inte 401/403, alltså finns vägarna inte).

**Men intervallet är känt: 23 mallar mellan 1027 och 1080 = 54 kandidater.**
Den tidigare noteringen *"blind skanning är meningslös"* gällde hela
heltalsrymden. Med känt spann är skanning tvärtom den enda vägen.

```bash
API_KEY=... ./intelliplan_scan.sh              # 1020-1100 (default)
API_KEY=... ./intelliplan_scan.sh 900 1200     # ännu bredare
```

**⚠️ "23 mallar, id 1027–1080" ÄR INTE EN GRÄNS.** Siffran kom från en avläsning
av Reporting-vyn — men vi använder **1081** (`IP_REVENUE_DAY_REPORT`), som ligger
utanför. Ett avläst intervall är en indikation. Default-svepet är därför
medvetet bredare; ett tomt id kostar 300 ms.

**Hur det fungerar:** `GET /admin/intelliplan/probe?from_id=&to_id=&from=&to=`
knackar på varje id med **en dags** datumfönster (rubrikraden räcker; en hel
månad ur 23 rapporter är megabyte i onödan). 300 ms paus mellan anropen, tak
120 id per anrop — skriptet delar upp automatiskt.

**⚠️ PERSONDATA:** skanningen läser BARA kolumnnamn. `describeReportPayload`
anropas utan `sample`, så datarader utelämnas. Rapporterna bär konsultnamn och
lönekostnader (1063). Grinden är testtäckt och mutationstestad.

**⚠️ TOMT ID ≠ FEL.** Ett obefintligt id svarar `503` +
`"Could not find GridReportTemplateDto"` — Intelliplans felinpackning, inte att
tjänsten är nere. `malFinnsInte()` skiljer dem åt. Failar ett anrop av ANNAN
orsak flaggas hela skanningen som **OFULLSTÄNDIG** — annars ser "vi hittade
inget" likadant ut som "vi kom inte fram".

**Kandidatpoäng** (`scoreScheduleColumns`, ren funktion): datum · tid · konsult ·
kund. `kandidat` kräver **datum + tid + konsult** — datum utan tid är en
dagsrapport (1081), och `Hours1` i 1058 är en **summa**, inte tidsupplösning.
Utan det kravet hade varje intäktsrapport sett ut som ett schema.

| Rapport | score | varför inte |
|---|---|---|
| 1058 | 2/4 | saknar datumkolumn (`Hours1` är en summa) |
| 1081 | 2/4 | datum men ingen tid → dagsrapport |
| 1063 | 2/4 | konsult men varken datum eller tid |

**Om skanningen inte hittar någon kandidat** är svaret att pass-kornighet inte
finns i någon befintlig mall → bygg en via **"Add columns"** i Reporting-vyn
(datum, starttid, sluttid, konsult, kund). Mallarna är användarredigerbara.

**⚠️ `bash -n` RÄCKER INTE FÖR SHELLSKRIPT.** Första versionen dog skarpt med
`FROM_ID?: unbound variable`: `$FROM_ID–$TO_ID` innehöll en **en dash** (U+2013),
och skalet läste multibyte-tecknet som del av variabelnamnet. Det är ett
EXPANSIONSFEL, inte ett syntaxfel — `bash -n` säger grönt. Regel: inga
typografiska tecken (en dash, ellips) direkt efter en variabel i kodrader, och
`${KLAMMER}` när text möter variabel. Verifierat med en genomsökning av samtliga
`*.sh`.

**Verifierat:** `intelliplan_smoke.mjs` **216/216**. Mutationstestat: öppnad
persondata-grind fäller 3 · tomt id räknat som fel fäller 1.
**Kört end-to-end mot en fejkad server** i två lägen: normalfall (hittar och
rankar kandidaten) och failande anrop mitt i svepet (flaggar skanningen som
OFULLSTÄNDIG). Det testet var det som avslöjade att 1081 låg utanför default-spannet.

---

## 📊 SKARPT SKANNINGSRESULTAT 2026-08-20

**53 mallar funna** i spannet 1020–1100 (28 tomma id). ⚠️ **Inte 23** — den
siffran kom från en avläsning av Reporting-vyn och var fel. Fliken var
sannolikt scopad (Organisation / User / Both).

**Ingen bedömd mall har datum + tid.** Bara `1081` har datumkolumn alls
(`Date1/Date2`), och den saknar tid → dagsrapport.

**⚠️ 14 mallar gick INTE att bedöma** — de svarade 200 OK men utan rubrikrad:
`1022, 1026, 1036, 1047, 1052, 1054, 1064, 1067, 1070, 1071, 1073, 1077, 1078,
1080`. Troligen ingen data på sonderingsdagen (en dags fönster var min
optimering — den blindade alltså 14 mallar). **De har inte förkastats, de har
inte lästs.** Kör om dem innan slutsatsen "mallen finns inte" står fast:

```bash
API_KEY=... ./intelliplan_probe_ids.sh 1022,1026,1036,1047,1052,1054,1064,1067,1070,1071,1073,1077,1078,1080
```

### ~~⭐ REKOMMENDERAD BASMALL: 1075~~ — ERSATT, se nedan

```
ConsultantNo1, Consultant1, Consultant2, Account1, Account2,
Order1, Order2, Hours1, AbsenceHours1          (95 rader)
```

**Enda mallen med konsult + kund + order + timmar samtidigt** (verifierat
programmatiskt över alla 53). Den har redan exakt den join en passlista behöver
— det som saknas är bara tidsupplösningen. Lägg till via **"Add columns"**:
datum (dag), starttid, sluttid. Behåll `Account`/`Order` för kundkopplingen och
`ConsultantNo1` som stabil nyckel (namn är inte unikt).

`AbsenceHours1` är en bonus: frånvaro syns direkt i samma vy.

**Andrahandsval: `1076`** — `ConsultantNo1, Consultant1/2, IsConsultantConfirmed1,
IsManagerConfirmed1, CountRegularWorkdays1` (82 rader). Ser ut som en
attest-/närvarorapport. `CountRegularWorkdays1` antyder att **dagsupplösning
finns i datamodellen** — men mallen saknar kund. Ta den om 1075:s kolumnväljare
inte exponerar tid.

**⭐ Att klona är normal praxis hos er.** Fem grupper har identiska
kolumnuppsättningar med olika radantal — samma mall, olika sparat filter:
`[1057, 1058, 1060, 1066]` · `[1053, 1055, 1056, 1074]` · `[1034, 1046, 1049]` ·
`[1020, 1021, 1051]` · `[1038, 1048]`. **Klona 1075 i stället för att ändra
den** — 1075 kan användas av något annat.

### ⚠️ VERKTYGSFEL SOM RÄTTADES AV DET SKARPA RESULTATET
`scoreScheduleColumns([])` rapporterade tidigare `score 0, "saknar datumkolumn"`
— alltså exakt som en mall vi läst och förkastat. Nu returneras
`bedombar: false` med *"OBEDÖMBAR — svarade utan rubrikrad"*, kandidater söks
bara bland bedömda, och slutsatsen räknar upp de obedömda id:na. **En obedömd
mall som ser förkastad ut gör "hittade inget" till ett falskt negativt.**

**Verifierat:** `intelliplan_smoke.mjs` **225/225**. Mutationstestat: tom
kolumnlista bedömd som vanligt fäller 4 · kandidater sökta bland obedömda fäller 1.

---

## 🔄 REKOMMENDATIONEN REVIDERAD efter om-probningen (2026-08-20)

Om-probningen av de 14 obedömda gav tre nya mallar som ändrar bilden. **1075 var
fel rekommendation** — den saknar datum och det finns bättre utgångspunkter.

### 🔴 VIKTIGAST: ingen mall i hela beståndet har KLOCKSLAG

Genomsökning av samtliga kolumner i 53 mallar efter tid-på-dygnet-mönster
(`time`, `start`, `end`, `klock`, `shift`, `minute`) gav **en enda träff:
`EmploymentHourlySalary1`** — en timlön, inte ett klockslag.

Allt som mäter tid är en **mängd**: `Hours1` · `AbsenceHours1` · `InvoiceHours1`.
Allt som daterar är en **dag**: `Date1/Date2` · `SalaryDate1/2`.

**Slutsats:** Intelliplans rapportmodell ser ut att ha **dagskornighet med timmar
som kvantitet — inte pass med start- och sluttid.** Det betyder att
planeringsvyn realistiskt kan visa *"Anna, kund X, 14 aug, 7,5 h"* men troligen
inte *"07:00–15:30"*.

⚠️ Detta är **evidens, inte bevis**: vilka kolumner som råkar användas i
befintliga mallar säger inte allt om vad kolumnväljaren erbjuder. Men med 53
mallar och noll klockslag är signalen stark.

### Dagsgrain FINNS — på två sidor som ännu inte mötts

| Mall | Dimensioner | Rader |
|---|---|---|
| **1052** | Article · Consultant · **Date** · BaseCost · Revenue | 199 |
| 1036 | AbsenceCode · Consultant · **Date** · AbsenceHours | 185 |
| **1063** | Article · Consultant · **Order** · FinancialItemNote · SalaryCost | 181 |
| **1078** | Account · Order · Consultant · ConsultantAge · Hours | 108 |
| 1075 | ConsultantNo · Consultant · Account · Order · Hours · AbsenceHours | 95 |

**1052 och 1063 delar `Article + Consultant` och har snarlika radantal (199/181)
över olika fönster** — de är sannolikt byggda på SAMMA faktatabell
(financial item / tidstransaktion). Om det stämmer kan `Date` och `Order`
samexistera, och unionen blir exakt det vi vill ha:

`Article · Consultant · Date · Order · Revenue · BaseCost`

### ⭐ GÖR DETTA FÖRST — ett tvåminuterstest som avgör allt

Öppna kolumnväljaren ("Add columns") i **1052** och titta efter:
1. **`Order` eller `Account`** → finns de, är hypotesen bekräftad. Klona 1052,
   lägg till kundkopplingen, och du har passrapporten på dagsnivå.
2. **Något klockslag** (start/slut/tid) → finns det, kan vi bygga riktiga pass.

Gör samma sak från andra hållet i **1078** (Account · Order · Consultant · Hours)
och leta efter `Date`. Det är samma fråga ställd från kundsidan, och 1078 har
redan hela kundkopplingen.

**Klona, ändra inte** — fem grupper i beståndet har identiska kolumnuppsättningar
med olika radantal, så mallar återanvänds med sparade filter.

### Kvarstår obedömd
`1067` gav ingen rubrikrad ens med sex månaders fönster.

**Verifierat:** analysen är körd programmatiskt över samtliga kolumnlistor, inte
ögnad.

---

## ✅ MALL 1082 `mira-pass-1` — KLAR, kolumner verifierade mot skarp CSV (2026-08-20)

**Juli 2026: 3 420 rader, 20 kolumner.** Exakt rubrikrad:

```
Date1,Date2,Consultant1,Consultant2,ConsultantNo1,Account1,Account2,
FinancialItemId1,OrderDescription1,OrderNo1,WorkdayBookedToTime1,
PunchInTimeRounded1,PunchOutTimeRounded1,FinancialItemNote1,
MannedBy1,MannedBy2,WorkdayBookedFromTime1,PlacementHours1,LostHours1,AbsenceHours1
```

**⚠️ MIN SLUTSATS ATT INTELLIPLAN SAKNAR KLOCKSLAG VAR FEL.** Den byggde på att
ingen av de 53 befintliga mallarna hade tidskolumner — men de är allihop
ekonomi-/lönerapporter. **Frånvaro av en kolumn i befintliga mallar säger
ingenting om datamodellen, bara om vad folk hittills rapporterat på.**
`WorkdayBookedFromTime1` / `WorkdayBookedToTime1` finns och är ifyllda.

### 🔑 Nyckel: `FinancialItemId1` — 3 420 distinkta av 3 420 rader
Perfekt upsert-nyckel. Idempotent omläsning utan sammansatt nyckel.

### ⭐ TRE RADTYPER — bevisade, inte gissade (ingen överlappar)

| Typ | Antal | Kännetecken | Timmar |
|---|---|---|---|
| **Genomfört pass** | 1 202 | har `WorkdayBookedFrom/ToTime` · alltid Account + OrderNo | `PlacementHours` **9 267** |
| **Inställt pass** | 1 146 | **bara** `LostHours`, ingen tid | `LostHours` **8 972** |
| **Frånvaro** | 1 072 | `PlacementHours` **+** `AbsenceHours`, ingen tid | `AbsenceHours` **8 398** |

**Semantiken är därmed bevisad:** `PlacementHours` totalt 17 663 = 9 267 (utfört)
+ 8 396 (frånvarande men schemalagt). **`PlacementHours` är SCHEMALAGD tid,
oavsett om den utfördes.** Faktiskt arbetad tid = de 1 202 raderna med tid = **9 267 h**.

Det förklarar också anomalin i UI:t (en rad med Placement 8 / Lost 16): de är
olika radtyper, och `LostHours` blandas aldrig med `PlacementHours`.

**Normaliseraren ska klassificera radtypen** — planeringsvyn visar bokat pass,
inställt och frånvaro olika.

### 🔴 TVÅ KOLUMNER ÄR HELT TOMMA — ta bort dem
`PunchInTimeRounded1` och `PunchOutTimeRounded1`: **0 av 3 420 ifyllda.**
Stämpelklocka används inte (eller fylls inte i). Vi kan alltså inte visa faktisk
kontra bokad tid — bara bokad.

`MannedBy1/2` (11 distinkta) = den som bemannat/planerat, inte utföraren.
Behåll bara om vyn ska visa det — annars är det persondata utan syfte.

### ⚠️ VERKSAMHETSFYND SOM MÅSTE BEKRÄFTAS FÖRE VISNING
**8 972 h inställt mot 9 267 h genomfört** — nästan 1:1. Plus 8 398 h frånvaro.
Datan är kategoriskt ren, men det säger inte att TOLKNINGEN är rätt: räknas ett
pass som ställs in och bemannas om som "lost" på båda konsulterna? Bekräfta med
Intelliplan innan talet visas för någon som fattar beslut på det.

### Volym
3 420 rader/månad → ~41 000/år. Synka ett **rullande fönster** för
planeringsvyn, inte all historik.

---

## ✅ PASSYNK 1082 → `Activity` (byggt 2026-08-20, EJ deployat)

Speglar Tengella-passvägen så S&P och Housekeeping hamnar i **samma kalender**:
`source_id = "intelliplan:<FinancialItemId>"` (mot Tengellas `"tengella:<EventId>"`).

**`normalizePass(csv)` (intelliplan.js)** — verifierad mot skarp CSV:
`placement 17 662,54` · `lost 8 972,33` · `absence 8 397,83` — stämmer exakt mot
UI:t (17 663 / 8 972 / 8 398). 3 420 rader, **0 okända radtyper**.

**`POST /admin/intelliplan/sync/pass {from,to,dry_run}`** — torrkörning default.

### ⚠️ TRE MÅTT SOM INTE FÅR SLÅS IHOP
`placement_total` (17 663) **inkluderar frånvaro**. `utfort_total` (9 267) räknar
bara rader med bokad tid. Att summera placement som "arbetade timmar" vore fel
med nästan en faktor två. Båda redovisas, aldrig hopslagna.

### ⚠️ KLOCKTID ≠ BETALD TID — skillnaden är RAST
`(slut − start) − PlacementHours`: **1,0 h på 704 pass · 0,5 h på 163 · 0 h på
272**. Kalenderblocket är start→slut (inkl rast), betald tid är PlacementHours.
Härled aldrig det ena ur det andra. 37 rader har negativ rast → varning, inte stopp.

**36 pass passerar midnatt** → slutdatum +1 dygn, annars slutar passet före det börjat.

### 🔧 KRÄVS I BUBBLE INNAN SKARP KÖRNING
**Nytt `ActivityType`-OS-värde: `Service & People`** (bredvid `Housekeeping`).

**Nya fält på `Activity`:** `intelliplan_item_id`(number) · `intelliplan_radtyp`(text)
· `intelliplan_consultant_no`(number) · `intelliplan_consultant_name`(text)
· `intelliplan_account_id`(number) · `intelliplan_order_no`(text)
· `intelliplan_order_desc`(text) · `intelliplan_hours`(number)
· `intelliplan_rast_hours`(number) · `intelliplan_last_synced`(date)

Saknas något droppas det **tyst** — därför läses en rad tillbaka efter första
create och synken svarar `502 fields_missing_on_type` i stället för `ok:true`.
Probe-raden väljs med FLEST ifyllda värden (Bubble lagrar inte null → en gles
rad ger falska larm).

### WU
Befintliga rader läses **constraintat på `Startdatum`**, aldrig helsvep.
`loadActivityIndex()` i activity_sync läser hela `Activity` (18 862 rader ≈ 310
WU/körning) — den vägen används medvetet INTE här. Patchar bara vid faktisk
ändring av ett mätvärde.

Kundkoppling via befintliga `_ipAccountMap()` (IntelliplanAccount → ClientCompany)
— inga nya mappningar. Omappade konton redovisas som `konton_utan_clientcompany`.

### 🔴 EGET SPÅR UPPTÄCKT: Category-nyckeln "Staff"
`CATEGORY_COLORS` och `SUBCAT_FIELDS` (activity_sync.js) samt tre tabeller i
index.js är Category-nycklade men använder **`"Staff"`** — option set-värdet är
`Service & People`. Matchar de aldrig får S&P-poster grå fallback-färg och
saknar underkategori. **Ej ändrat** — `"Staff"` är korrekt på andra ställen
(Fortnox connection-namn), så det kräver en egen genomgång. Passynken använder
det verifierade värdet.

**Verifierat:** `intelliplan_smoke.mjs` **257/257**. **Mutationstestat:** inställda
pass felklassade fäller 2 · `utfort_total` över alla rader fäller 2 · midnatt
ohanterat fäller 3 · Category tillbaka till "Staff" fäller 2 · helsvep i stället
för datumfönster fäller 1. Samtliga 20 sviter gröna.

### ⚠️ CHUNKAD SKRIVNING — `_bulkCreate` duger inte rakt av
`_bulkCreate` skickar **alla** rader i EN request (3 420 ≈ 1,4 MB body) och
returnerar `created: ok || rows.length` — alltså **antalet skickade** när svaret
inte går att tolka. En partiellt misslyckad skrivning hade sett ut som full
framgång. Passynken chunkar därför 200 rader i taget, räknar skickat mot skapat,
och svarar `502 ofullstandig_skrivning` vid diskrepans i stället för `ok:true`.
Omkörning är säker — upserten är idempotent på `source_id`.

**⚠️ `_bulkCreate` har samma optimism för ALLA anropare** (gäst-import m.fl.).
Ej ändrat här — eget spår.

**Nästa:** skapa OS-värdet + de tio fälten i Bubble → torrkör
`POST /admin/intelliplan/sync/pass {"from":"2026-07-01","to":"2026-07-31"}` →
jämför mot 3 420 rader → `dry_run:false` → lägg i `intelliplan_cron.sh`.

### ✅ TORRKÖRNING JULI 2026 (2026-08-20, efter kontomappning)
`3 420 rader · pass 1 202 · inställt 1 146 · frånvaro 1 072 · okänd 0`
`placement 17 662,54 · utfört 9 266,54 · lost 8 972,33 · absence 8 397,83`
— identiskt med CSV-exporten. `to_create: 3420`, `orphans: 0`.

**Kontomappning:** 7 → **1** omappat (`1305` Scandinavian Hospitality Rentals,
4 rader). Tre av de sju var Gothia-anläggningar → samma ClientCompany som de fem
befintliga. `Clientcompany` ligger i jämförelsefälten, så när 1305 mappas
patchas raderna vid nästa körning.

**37 negativa raster = ÖVERTID utöver bokat fönster**, inte kodfel. 22 av 37 ≤ 0,5 h,
totalt 34 h av 17 663 (0,2 %). Klustrat på Ellery Beach House, Gothia Restaurang,
Brofästet, DS Resort — restaurang/event där pass drar över. Kalendern visar det
BOKADE passet, vilket är rätt.

**⚠️ 80 rader saknar `Account1` helt** (frånvaro utan kund) → `Clientcompany: null`
→ osynliga i den kundfiltrerade kalendern. Öppet designbeslut: en vy per KONSULT
i stället för per kund vore rätt hem för dem.

---

## ✅ SKARP KÖRNING KLAR + IDEMPOTENS BEVISAD (2026-08-20)

Körning 1: `created 3242 · unchanged 178 · orphans 0` (178 från ett avbrutet
tidigare försök). Körning 2: **`to_create 0 · unchanged 3420 · created 0`** —
idempotensen är bevisad, inte antagen. **`fields_missing_on_type` uteblev** →
alla tio Bubble-fält finns och fastnade.

### 🔴 3 420 RADER SOM KALENDERN GÖMDE
`mira-kalender.html` filtrerar via `visible()`: `if(!st.on[ev.type]) return false`.
`TYPES` och `st.on` var **hårdkodade** med fyra lager — `Service & People` fanns
i ingendera. Passen skrevs korrekt och var **helt osynliga**.

Rättat: lagret tillagt i BÅDA listorna (rad 194 + 217). **⚠️ Lägger du till en ny
ActivityType måste båda uppdateras** — annars försvinner datan utan ett spår.
Blocket måste klistras om i Bubble.

Ännu ett exempel på dagens genomgående mönster: **skrivningen lyckades, vyn
visade ingenting, och inget larmade.**

---

## ⏭️ NÄSTA SESSION — Intelliplan pass

**Kör hälsokollen först** (`/version` + `/admin/bokningslage/kallhalsa`).

### 1. 🔴 AVGÖR FÖRST: returnerar 1082 FRAMTIDA pass?
Allt vi laddat är **juli — dåtid**. Planeringsvyn handlar om *inbokade* pass,
alltså framtid. Rapporten bygger på `FinancialItem`, vilket kan betyda att rader
uppstår först när passet ekonomiskt registrerats.

```bash
curl -sS -X POST ".../admin/intelliplan/sync/pass" -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" -d '{"from":"2026-08-21","to":"2026-10-31"}'
```
Torrkörning. **Noll rader ⇒ hela premissen måste tänkas om** — då kan vyn bara
visa historik, och "inbokade pass" kräver en annan källa. Allt nedan hänger på
det här svaret.

### 2. Nya konton skapas INTE av passynken
`sync/order-month` registrerar okända konton i `IntelliplanAccount`
(`accounts_created`). **`sync/pass` gör det inte** — den läser bara
`_ipAccountMap()`. Ett konto som bara förekommer i pass hamnar aldrig i
mappningstabellen, syns aldrig i `/accounts?unmapped=1`, och dess pass blir
osynliga i kalendern för alltid. Spegla order-months kontoskapande.

### 3. Cron med rullande fönster
Fönstret beror på svaret i (1). Förslag om framtid finns: **−1 månad → +3 månader**
i `intelliplan_cron.sh`. ~3 400 rader/månad; patchar bara vid faktisk ändring.

### 4. Orphan-policy — ej beslutad
Ett pass som RADERAS i Intelliplan lämnar en Activity kvar. Synken rapporterar
`orphans` men tar aldrig bort dem. I en kalender är ett spökpass fel. Radera,
markera, eller lämna?

### 5. Kvarvarande
- `1305` Scandinavian Hospitality Rentals omappat (4 rader) — patchas vid nästa körning
- **80 rader utan kund** (frånvaro utan uppdrag) → `Clientcompany: null` → osynliga i
  den kundfiltrerade kalendern. Behöver en vy per KONSULT.
- 37 negativa raster = övertid utöver bokat fönster (0,2 % av tiden) — inget att göra
