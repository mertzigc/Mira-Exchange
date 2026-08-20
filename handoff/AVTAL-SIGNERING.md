# Avtal + signering

> Avtalsmodulen Fas 1–5b + import/signering/stämpling av inlästa avtal.
> Kod: `contract_render.js`, `contract_templates/`, `merge_avtal.mjs`.
> Minne: `reference-avtal-signering-flode` · `reference-scanned-pdf-vision-ocr`

---
### Inläst OSIGNERAT avtal → signering → stämpling — BYGGT 2026-08-19, EJ DEPLOYAT
**Utlösare:** en kollega läste in ett osignerat avtal via PDF-importen på kundkortet, la till en bilaga, och ville få det signerat. Tre luckor gjorde det omöjligt att göra rätt:

1. **Importen antog ALLTID att PDF:en var påskriven.** `/admin/contracts/import/commit` satte `signed_pdf = filen` och `signed_at = signed_at || startdatum || NU`. Ett osignerat avtal hamnade alltså i Bubble som signerat samma dag. **Detta var den faktiska databuggen** — inte bilagan.
2. **Signeringsformuläret kunde bara ladda upp NYA filer.** Men `OfferApprovalRequest.dokument` är en **List of Dokument** och `_createApprovalRequestInternal` tar redan emot `dokumentIds`. `Contract.attachments` ÄR Dokument-rader → de kan skickas rakt in med sina id:n. Luckan satt i UI:t, inte i modellen.
3. **Ingen koppling avtal → signering.** `Contract.offer_approval` fanns men sattes bara av auto-Contract-vägen, så ett fristående utskick gav två öar: avtalet fick aldrig `signed_at` eller signeringsbevis.

**Lösning i tre delar:**
- **`is_signed`-flagga i importen** (default `true` = oförändrat för gamla anropare). Vid `false`: `signed_at`/`signed_pdf` lämnas tomma, PDF:en blir bilaga. Frontend: kryssruta "Avtalet är redan signerat" i granskningsmodalen, synlig BARA i import-läge.
- **`POST /admin/contracts/:id/send-for-signing`** — bygger signeringsbegäran av avtalets EGNA bilagor (Dokument-id:n, ingen omuppladdning), ärver kund + affär, och sätter `Contract.offer_approval` efter att requesten skapats. Spärrar: `409 already_signed` · `409 signing_already_started` (båda forcerbara) · `400 inga_dokument`. En delmängd `dokument_ids` filtreras mot avtalets egna bilagor — annars kan man skicka ett främmande dokument för signering.
- **`_markContractSignedFromApproval(parent)`** i `_checkAndCompleteRequest` — stämplar `signed_at` + senaste signeringsbeviset (`OfferApproval.signed_document`) på det BEFINTLIGA avtalet. Idempotent, mjuk-felar.

**⚠️ Duplikatskyddet är gratis och måste förstås:** `_createContractsFromApprovalRequest` hoppar redan över requests som har ett Contract med `offer_approval == request._id`. Eftersom vi sätter kopplingen FÖRE utskicket skapas inget nytt avtal vid Approved — det befintliga stämplas i stället. Endpointen skickar dessutom `auto_create_contract:"no"` och ALDRIG `contract_template_json` (bälte + hängslen). Ordningen i `_checkAndCompleteRequest` är därför inte kosmetisk: auto-contract måste få titta först.

**⚠️ Statussignalen är MEDVETET SMAL.** Ny status `vantar_signering` = `offer_approval` satt **OCH** `signed_at` tom. "signed_at tom" ENSAMT hade flaggat halva listan som osignerad — manuella `/admin/contracts/create` sätter `signed_at` bara om anroparen skickar det, så massor av äldre avtal saknar det. Manuell `status_override` vinner fortfarande; väntar-status går före datum-härledningen (ett avtal som väntar på påskrift ska inte visas "Aktiv" bara för att startdatum passerat).

**⚠️ Bugg som harnessen fångade:** `loadLive()`s `mapCt` skriver över `c.attachments` med placeholders **utan Dokument-id** (de finns bara för antalsvisningen). Signeringsformuläret hämtar därför bilagorna från `/admin/contracts/:id/attachments` i stället för från raden — annars hade en tom dokumentlista skickats.
- **Frontend:** inline-formulär i avtalsraden (INTE modal → ingen z-index/stacking-fälla, jfr Avtal-portens tre buggar). Rubrik förifylld från avtalet, dokument-kryssrutor, mottagare ur kundens kontaktpersoner + fritextfält. "Signering pågår"-ruta när `awaiting_signature`.
- **Verifierat:** `avtal_signering_smoke.mjs` **50/50**, **mutationstestat på logiken**: återinförd signed_at-stämpling i importen fäller 1 · bred statussignal fäller 2 · borttagen `auto_create_contract:"no"` fäller 1 · ofiltrerad `dokument_ids` fäller 1. Regression: samtliga 17 sviter gröna. **Browser-harness** genom hela kedjan: knappen syns på osignerat avtal → formuläret hämtar riktiga Dokument-id:n + kontaktpersoner (den utan e-post filtreras bort) → validering av tomt dokument/mottagare → utskick med rätt payload → statuspill "Väntar på signering" och knappen borta → efter stämpling "Aktiv" + "Signerat <datum> · <bevis-URL>".
- **Kvar att veta:** avtalspanelen hämtar inte om vid flikbyte för samma kund (`syncAvtalCompany` triggar bara vid kundbyte — WU-medvetet, befintligt beteende). En signering som blir klar syns alltså efter omladdning av sidan.
- **Deploy:** `index.js` (Render) + klistra om `mira-foretag-lista.html`. Inga Bubble-schemaändringar — `offer_approval`, `attachments`, `signed_at`, `signed_pdf` finns redan.

### ⚠️ OTP-BOMBNINGEN vid signering — SKARP BUGG, löst 2026-08-19
**Symptom (kund, i mail):** *"Mira verkar strula lite och bombarderar mig med länkar, den 7e funkade."* Render-loggen visar inbjudan + **sex** `"Din kod för att signera: …"` till samma mottagare innan signeringen gick igenom.

**Rotorsak:** sista raden i signeringssidans inline-script var `requestOtp();` — **ovillkorligt vid varje sidladdning**. Och `POST /approval/request-otp/:id` skrev alltid en NY `otp_hash`, vilket **dödar den kod mottagaren redan har i inkorgen**. Loopen: öppna länk → kod #1 → växla till mailen → tillbaka via länken (eller ladda om) → kod #2, **#1 nu ogiltig** → "Fel kod" → "Skicka koden igen" → #3 … Först när hon skrev in den SENASTE koden utan att ladda om däremellan gick det igenom (kod #6 = mail nr 7).

Inget bromsade: `startCooldown(60)` sitter **bara i klienten** och nollställs av varje omladdning, och serverns rate limit är 30/timme/IP — byggd mot missbruk, inte mot det här.

⚠️ **Detta infördes INTE av avtalskopplingen** (§ ovan). Flödet har använts för offertsigneringar där mottagaren typiskt stannar i samma flik; `send-for-signing` gjorde bara att fler kunder mötte samma sida.

**Fix:**
1. **Återanvänd en levande kod.** Finns `otp_hash` och `otp_expires_at` i framtiden → skicka INGET mail, svara `{reused:true, expires_at}`. Koden i inkorgen fortsätter gälla hur många gånger sidan än laddas om.
2. **`force:true` är enda vägen till en ny kod** — bara knappen "Skicka koden igen" skickar det. Sidladdning frågar utan force.
3. **Serverside-kylning** (`OTP_RESEND_COOLDOWN_MS` 60 s) på omsändning → `429 resend_too_soon` + `retry_after`. Klientkylan kunde inte bära ansvaret.
4. **`OTP_MINUTES` 10 → 15.** Sedan klockan inte längre nollställs av omladdningar är det här den FAKTISKA tiden från första mailet till inskriven kod, inklusive att byta till mailappen och leta.
5. Sidan visar utgångstiden (`clockOf`) och säger explicit att koden "fungerar även om du laddat om sidan".

**Verifierat:** `otp_smoke.mjs` **29/29** — kör den RIKTIGA route-handlern mot mockad Bubble och räknar **köade mail** (den enhet kunden drabbades av): fem omladdningar → noll extra mail, hashen orörd; utgången kod → ny skickas; force före kylan → 429 utan mail och gamla koden lever; efter kylan → ny kod; fel/saknad token → inget mail; redan signerat → ingen kod ens med force. **Mutationstestat:** tas återanvändningen bort faller 7 assertions (buggen reproduceras exakt), sidladdning med `force:true` faller 1, borttagen serverkyla faller 3.

**Lärdom att ta med:** en engångskod som roteras vid varje sidladdning är en tävling mellan användarens inkorg och användarens webbläsare. Rotera bara på explicit begäran — och lägg kylan på servern, klientens nollställs av F5.

**Deploy:** `index.js` (Render). Inget HTML-block att klistra om — signeringssidan renderas av servern. Inga Bubble-ändringar.


## 0h. Fas 1-5 LIVE + verifierat 2026-07-14, Fas 5 delvis skarp

**Status per fas (kolla mot 0g för full plan):**

| Fas | Status | Verifierat |
|---|---|---|
| 1. Fundament (Bubble-schema + auto-Contract-hook + status-härledning) | ✅ LIVE | 2026-06-29 · CMIAB testad |
| 2a. Read-endpoints (`/admin/contracts/by-company`, `/admin/contracts/all`) | ✅ LIVE | 2026-06-29 |
| 2b. Create-endpoint + okand-härdning för legacy Contracts | ✅ LIVE | 2026-06-29 |
| 2c-1. PATCH-endpoint + frontend pause/resume/end/reopen-actions | ✅ LIVE | 2026-06-29 |
| 2c-2. Create + Edit modal med live-dropdowns (Erbjudande/Office från `/services/dashboard`) | ✅ LIVE | 2026-06-30 · Skapa+Redigera funkar |
| 2d. Bilagor — upload/list/delete via `Contract.attachments` (Dokument-rader) | ✅ LIVE | 2026-06-30 |
| 3a. RateCard-builder + Hybrid-toggle i modal | ✅ LIVE | 2026-07-01 |
| 3b. F&E-tile soft-active (senaste FortnoxOrder ≤6 mån från F&E-connection) | ✅ LIVE | 2026-07-01 |
| 4. PDF-import + LLM-parsning (Anthropic Haiku 4.5 structured tool-use) | ✅ LIVE + verifierat | 2026-07-02 · EA HK-avtal 8/8 fält korrekt, Exeger multi-location 9/9 fält |
| 5. Template + PDF-generering (ContractTemplate + puppeteer + `/approval/create`) | ✅ LIVE (admin-block) + 5 mallar seedade | 2026-07-14 · end-to-end signering testad |
| 5b. Wizard på kundkortet, bilage-upload, wording-polish, "pågående interngranskningar"-vy | ⏳ NÄSTA SPÅR | — |

### Refaktoreringar under vägen (viktigt att komma ihåg)

1. **CT_*-konstanter är LOWERCASE + diakritik** (verifierat via `/services/dashboard?debug=1` 2026-06-29): `kundföretag`/`kontor`/`produktantal`/`månadskostnad`/`slutdatum` (INTE PascalCase som jag först gissade). Bubble FIND är case-insensitive men JS object-access är case-sensitive — måste matcha slugen exakt.
2. **Kategori-härledning i backend** (`POST /create` + `PATCH /:id`): frontend kan skicka `"platform"`/`"facility"` från ServiceCatalog eller giltig option-set-värde. Backend har `VALID_CATEGORIES`-guard som härleder från `offer.Category` om ogiltigt.
3. **HTML-block följer approval-mönstret**: `.ab-wrap` / `.aa-wrap` + `data-mira` på hidden inputs + claim-mekanism + scoped queries via `root.querySelector('[data-ab="..."]')`. INGEN `document.getElementById`, INGEN `?.`/`??` (Bubbles parser krashar). Fixat efter kaskad-bug där approval-blockens `?.` stoppade Bubble från att injicera abonnemang-blockets script.
4. **`_deriveContractStatus` returnerar `okand`** när både startdatum OCH slutdatum saknas — döljer 183 legacy-Contracts som default i admin-vyn (filter-chip AV).
5. **`_createContractsFromApprovalRequest` skapar BARA Subscription auto** vid OfferApproval.Approved. RateCard + Hybrid kräver manuell skapande i admin-blocket.

### Fas 4 — verifierat vid två avtal (2026-07-02)

**Test 1 — EA/DICE HK-avtal (188 282 kr/mån):** 8/8 fält korrekt parsade (contract_type, monthly_cost, datum, bindning, uppsägning, prisreglering, customer_name).

**Test 2 — Exeger multi-location HK-avtal:** 9/9 fält korrekt inkl komplex volume_json med två lokaler + prisändring över tid (`{"locations":["Brinellvägen 60","Brinellvägen 32"],"brinellvagen_60_monthly":23570,"brinellvagen_32_monthly_aug_sep":48600,"brinellvagen_32_monthly_oct_onwards":64000}`).

**F&E-avtal (Wistrand STHLM):** Fångade 6/8 fält. Månadskostnad tom, volume tom. Rotorsak: F&E-avtal är strukturellt annorlunda (prislista-baserat, inte fast månadsavgift). **Beslut: F&E-import parkerad** — Christian sa "vi avvaktar med FE" 2026-07-02. F&E-avtal förblir manuell skapande i admin-blocket tills ett bättre F&E-abonnemang-koncept definierats.

**Kostnad per import:** ~0,09 SEK (7 114 input + 451 output tokens på Haiku 4.5). Hela befintlig kundbas ~5-10 SEK.

**Två prompt-fixar 2026-07-02** (efter Exeger-analys):
- Nytt `setup_cost`-fält i schemat för engångskostnader (uppstartskostnader typ 15 000 kr för utrustning)
- Prompt uppdaterad: föreslå **Hybrid** när avtalet har både fast månadsavgift OCH pris-per-tillfälle/timme (t.ex. HK med månadsstädning 20 000/tillfälle, höjdstädning, extra städ med OB-tillägg). Tilläggstjänster i `rate_card` med `unit`-fält: `"per timme"`, `"per tillfälle"`, `"engång"`.

### Fas 5 — LIVE i admin-blocket 2026-07-14 (delvis skarpt)

**Vad som är byggt och verifierat end-to-end:**

**Backend (`index.js`):**
- `pdf_utils.js` (ny modul) — delad puppeteer-browser-singleton + `renderHtmlToPdf` + `mergePdfs` + `detectKind` + `imageToPdfBuffer` + `normalizeFileUrl` + `fetchBinary` + `sha256`. Både `offer_approval_doc.js` och `contract_render.js` importerar från denna → EN Chromium-process per Render-instans.
- `contract_render.js` (ny modul, DI-mönster) — `renderPreview({templateId, spec, attachmentDokumentIds})` skapar temp-Dokument med `deletable_after=now+2h`. `renderAndPersist(...)` skapar permanent Dokument. Använder samma `{{a.b.c}}`-substitution som approval-cert. Bilagor mergas via `pdf-lib`.
- `_createApprovalRequestInternal({req, files, dokumentIds, payload})` — extraherad helper från `/approval/create` (rad 16755). Accepterar `contract_template_json` + `auto_create_contract` i payload → auto-Contract-hooken (§0g Fas 1) picks up.
- `SERVICES.CTPL_*` + `DOK_DELETABLE_AFTER` — nya konstanter (rad ~19653).
- `contractRenderEngine` init:eras efter SERVICES-blocket (TDZ-safe).
- **Nya endpoints:**
  - `POST /admin/contracts/render-preview` — iframe-preview i 2h (temp-Dokument)
  - `GET /admin/contract-templates` (?category=&contract_type=&language=&include_superseded=)
  - `GET /admin/contract-templates/:id`
  - `POST /admin/contract-templates` — skapar v1, is_active=yes
  - `PATCH /admin/contract-templates/:id` — skapar NY rad med `version++`, sätter `superseded_by=new_id` på gamla (delta-patch: bara skickade fält ändras, resten kopieras)
  - `POST /admin/contracts/render-and-send` — full pipeline: hämtar mall → render → permanent Dokument → in i `_createApprovalRequestInternal`. Pinnar `template_id + template_version` i varje `contract_spec` för audit.
  - `GET /admin/clientcompany/:id/details` — org.nr + adress pre-fyll i kund-picker (använder `detectClientCompanyOrgKey` för dynamiskt fält-namn)
  - `GET /prototyp/avtal-wizard` + `/prototyp/avtal-oversikt` (public, ingen auth) — serverar statisk HTML från `./prototypes/` för externa testare
- `openPrefixes`-tillägg i `requireApiKey`-middleware: `/admin/contract-templates`, `/prototyp/`.

**Bubble-schema (Christian byggt 2026-07-14):**
- Ny typ `ContractTemplate` — 11 fält: `name` (text), `subtitle` (text), `description` (text), `category` (option set Category), `contract_type` (option set contract_type), `language` (option set language), `template_html` (text long), `default_spec_json` (text long), `default_attachments` (List of Dokument), `version` (number), `superseded_by` (ContractTemplate self-ref), `is_active` (yes/no).
- Nytt Option Set `language` med värden `sv` + `en` (ISO 639-1, lowercase).
- `Dokument` fick ett nytt fält: `deletable_after` (date) för TTL-städ av temp-preview-Dokument.

**Frontend (`mira-abonnemang-admin.html`, ~2200 rader):**
- Wizard inbäddad som modal-overlay (`.aa-wiz-mask` + `.aa-wiz-modal`). `.wt-*`-prefix isolerat från `.aa-*`-namespace.
- Ny knapp **"+ Avtal från mall"** bredvid `+ Nytt abonnemang` i header (`data-aa="wiz-btn"`).
- Öppna/stäng via event-delegation på `document` (INTE `.aa-wrap`-scope — Bubble injicerar HTML async).
- Wizardens JS **IIFE-wrappad** med explicit `window`-exports (`goNext`, `goBack`, `toggleHelp`, `showPreview`, `addRcp`, `removeRcp`, `submitFinal`, `resetWizard`, `wtCloseModal`, `wtClearClient`). Kritiskt: ORAN IIFE bryter Bubbles jQuery (`$.ajax`) → hela sidan låstes. Se punkt 6 i "gotchas" nedan.
- 5-stegs wizard med intern granskning-läge (Signer/Reviewer-workflow byggd på befintlig OAR-motor).
- **LIVE-mode** (om `[data-mira="api_host"]` + `[data-mira="planning_token"]` finns): fetch mallar från API, POST preview + skicka. **MOCK-mode** fallback (hardkodade mallar + alert) för prototypen på `/prototyp/*`.
- **Steg 1 — mall-lista:** `GET /admin/contract-templates` → dynamisk rendering. Kategori + språk-pills.
- **Steg 2 — kund-picker:** autocomplete på `GET /admin/planning/companies` → vid val fetchas `GET /admin/clientcompany/:id/details` → auto-fyller org.nr + adress. `CLIENT.id` sparas i state → skickas som `clientcompany`-ref i submit.
- **Steg 3 — schema-driven formulär:** renderas från mallens `default_spec_json.form_schema`. Sektioner + fält med `path` (dot-notation) som mappas direkt till spec-strukturen. Stödjer `text`/`number`/`date`/`textarea`/`select`-typer. Layouts: `stack`/`grid-2`/`grid-3`. Sektions-nivå `help` visas som 💡-callout. Fältnivå `help` = klickbar (?)-cirkel. Validering av `required`-fält vid `goNext(3)` — röd border + auto-scroll till första fel. Fallback-schema om mall saknar `form_schema`.
- **Steg 4 — preview:** `POST /admin/contracts/render-preview` → iframe med riktig PDF. Bilagor mockade (checkboxes utan riktig upload).
- **Steg 5 — skicka:** `POST /admin/contracts/render-and-send`. Två val-kort: "Skicka till kunden" (auto_create_contract=yes) vs "Dela internt först" (auto_create_contract=no). Sammanfattnings-panel innan skicka.
- **Done-vy:** grön ✓ för kund-signering, blå 👥 för intern granskning. Knappar stänger modalen (INTE alert som tidigare).

**5 mallar seedade och LIVE (2026-07-14):**

| Mall | Kategori | Typ | Språk | Källa | Bubble-ID |
|---|---|---|---|---|---|
| HK Hybrid Timpris (SV) | Housekeeping | Hybrid | sv | Carotte Housekeeping x KUNDNAMN.docx | v3+ |
| HK Månadsavgift (EN) | Housekeeping | Subscription | en | EA/DICE HK-avtalet (Sept 2025) | v1 |
| Staff Bemanning (SV) | Service & People | RateCard | sv | Inhyrning längre uppdrag.docx | v1 |
| Rekrytering (SV) | Service & People | RateCard | sv | Rekrytering.docx | v1 |
| Food & Event ramavtal (SV) | Food & Event | RateCard | sv | ALLMÄNNA VILLKOR CATERING.pdf | v1 |

Alla med `form_schema` för dynamisk Steg 3-rendering. Seed via `bash contract_templates/seed.sh` (idempotent — PATCH:ar existerande, POST:ar nya). Varje seed-fil har `template_html` med `{{}}`-slots + `default_spec_json.spec` + `default_spec_json.contract_specs` (för auto-Contract-hook) + `default_spec_json.form_schema` (för wizarden).

**Verifierat end-to-end 2026-07-14:**
- Wizarden i Bubble-preview: klicka mall → fyll kund + spec → generera förhandsgranskning → skicka till egen mail → signera → **Contract skapades auto med rätt värden** (för HK Månadsavgift-testet, Subscription-typ).
- 5 mallar synliga i wizarden-listan.
- Intern granskning-mail landar och kan klickas godkänna — men "skicka vidare till kund"-flöde är INTE byggt än (nästa spår).

**Prototyp för test utan Bubble-inloggning:**
- `/prototyp/avtal-oversikt` — översikt-dokument för alla Carotte-kollegor (även utan Claude-konto)
- `/prototyp/avtal-wizard` — klickbar wizard (MOCK-mode, inga riktiga avtal)
- PDF `mira-avtalsmodulen-oversikt.pdf` (5 sidor, 692 KB) i repo-root för Teams-delning

**Fas 5b — status per spår:**
1. ✅ **KLART 2026-07-18** — "Väntar på utskick"-vy + "Skicka nu till kund" (se detaljsektion nedan).
2. ✅ **KLART 2026-07-19** — bilage-upload i Steg 4 (`POST /admin/dokument/upload`).
3. ✅ **KLART 2026-07-19** — wizarden på kundkortet + 2-blocks-samexistens (se nedan).
4. ⏳ **Wording-polish** efter testfeedback från Fatih/Shahbaz/Anette. Kända trådar: pending-räknaren säger "…abonnemang" (borde "väntar på utskick"); kundkortets create-modal ("+ Nytt abonnemang") har kvar engelska typ-etiketter (Subscription/RateCard/Hybrid) — inkonsekvent med wizarden.
5. ✅ **KLART + LIVE-verifierat 2026-07-27** — TTL-städ av temp-preview-Dokument (se detaljsektion nedan).
6. ⏳ **Multi-Office signering** (§10.12 öppen fråga) — en signering kan ge N Contracts (Scandic ramavtals-mönster).
7. ⏳ **Långsiktig: flytta API-nycklar till Bubbles Site properties** istället för hardcoded HTML — undviker hidden-input-strip-buggen (se gotcha 5).

**Filer som är NYA denna omgång:**
- `pdf_utils.js` — delade PDF/HTML/binär-helpers
- `contract_render.js` — DI-motor för Contract-mall-rendering
- `contract_templates/hk-hybrid-timpris-sv.json`
- `contract_templates/hk-manadsavgift-en.json`
- `contract_templates/staff-bemanning-sv.json`
- `contract_templates/staff-rekrytering-sv.json`
- `contract_templates/fe-ramavtal-sv.json`
- `contract_templates/seed.sh` — idempotent POST/PATCH-script
- `prototypes/avtal-wizard.html` — public prototyp för externa testare
- `prototypes/avtal-oversikt.html` — översikt-dokument
- `mira-avtalsmodulen-oversikt.pdf` — 5-sidig PDF genererad från översikten (för Teams)

**Filer MODIFIERADE denna omgång:**
- `index.js` — nya endpoints, `_createApprovalRequestInternal`, `contractRenderEngine`, `openPrefixes`-tillägg
- `offer_approval_doc.js` — importar från `pdf_utils.js` istället för inline (bakåt-kompatibelt)
- `mira-abonnemang-admin.html` — wizard inbäddad + IIFE-fix + JS-fix + schema-renderer + kund-picker
- `mira-kommunikation-admin.html` — API-nyckel via JS + hardcoded fallback (fix på Bubble hidden-input-strip-bugg)

**Gotchas som biter (dokumenterade):**
1. **CT_*-konstanter LOWERCASE + diakritik** (från Fas 1) — oförändrat.
2. **Bubble Option Set-värden är case-sensitive** — `Category` har fyra värden: `Food & Event`, `Housekeeping`, `Service & People`, `Other facility services`. **INTE `Staff`** (vanligt fel — kastar `bubbleCreate failed` utan tydligt felmeddelande). Se `memory/reference-bubble-option-sets.md`.
3. **HTML-block följer approval-mönstret** — oförändrat.
4. **`_deriveContractStatus` returnerar `okand`** — oförändrat.
5. **Bubble strippar `value`-attribut på hidden inputs UTAN `data-*`-attribut** (bekräftat 2026-07-14 — bröt hela kommunikations-modulen). Fix: sätt värdet via JS efter DOM-ready + fallback i getter-funktionen. Se `memory/reference-bubble-hidden-input-strip.md`. Ex fix i `mira-kommunikation-admin.html` rad ~1048.
6. **Wizardens JS MÅSTE vara IIFE-wrappad** eftersom den deklarerar `$` och `$$` som lokala helpers. Om de läcker globalt överskriver de Bubbles jQuery `$` → `$.ajax` failar → hela sidan låstes när vi först deployade wizarden. Explicit `window.<fnname>` exponerar bara onclick-targets. Se `mira-abonnemang-admin.html` script-block 2.
7. **Wizard-modalens click-handler MÅSTE vara event-delegation på `document`** — INTE `.aa-wrap.querySelector(...)`. Bubble kan injicera HTML async efter script-körning, då finns inte elementet vid tidpunkten som IIFE:n kör.
8. **PATCH på `ContractTemplate` skapar ny rad** — inte in-place-mutation. Bakåt-referens via `superseded_by`. Filter "aktiva mallar" = `is_active=yes AND superseded_by is empty`.
9. **⚠️ Generiska CSS-klassnamn krockar med Bubbles globala CSS** (grundorsak, bekräftat live 2026-07-18 — kostade en lång felsökning). Bubbles kompilerade `run.css` har globala regler på generiska klasser, konkret **`.warn { padding-top: 12px }`**. Ett element med `class="... warn"` ärver då 12px och ser fel ut (chip blev 33px istället för 25px) — och din egen `.aa-chip`-padding vinner INTE (samma specificitet, Bubbles regel senare i kaskaden). **Regel: namnrymda ALLA modifier-klasser i HTML-blocken** — aldrig bara `warn`/`ok`/`on`/`right`/`muted` etc., använd `aa-warn`/`aa-ok`. Fixat på chip + KPI + "dagar kvar"-text i `mira-abonnemang-admin.html` 2026-07-18. Diagnos: kör Claude-i-Chrome mot live-sidan, `getComputedStyle(el)` + enumerera `document.styleSheets` med `el.matches(rule.selectorText)` för att se vilken regel som vinner. Isolerad render (harness) visar INTE detta — bara live-Bubble har globalerna. Se `memory/reference-bubble-word-break.md`.
10. **Bubbles flex-lager stretchar/bryter chips** (2026-07-18) — en förälder kan påtvinga `align-items:stretch`+höjd → chips med `height:auto` blir höga. Och `display:inline-flex` på ett flerords-chip gör texten till ett krympbart flex-item som Bubbles ärvda `word-break` kan bryta ("Utgår snart" på två rader). Fix: `align-self:center` + `flex-shrink:0` (ej inline-flex) + `white-space:nowrap` på chip-klassen. Se `memory/reference-bubble-word-break.md`.
11. **⚠️ Två HTML-block på samma Bubble-sida krockar** (2026-07-19) — admin "Alla avtal" + kundkortet ligger på samma sida (kundkorts-popup ovanpå admin-vyn) → två wizardar med delade element-ID:n, `window`-funktioner och `data-aa`-attribut. Symptom: fel modal öppnas, scroll låses (`body.overflow=hidden` utan matchande close), mallval registreras inte (delad `$$('.wt-card')`-bindning). Fix: scopa ALL DOM-åtkomst till block-roten (`BROOT`+`byId()` överst i wizard-IIFE, `document.getElementById/querySelector`→scopade; BROOT MÅSTE definieras före data-mira-läsningen) + namnrymda det ena blockets `window`-fn/`data-aa`. Se `memory/reference-bubble-multiblock-collision.md`.

### Fas 5b Spår 1–3 — KLART + verifierat 2026-07-18/19

**Spår 1 — "Väntar på utskick" + "Skicka nu till kund" (LIVE-verifierat 2026-07-18):**
- **Backend (`index.js`):** konstanter `CT_INTERNAL_REVIEW`=`internal_review_json`, `OAR_FORWARDED_AT`=`forwarded_at`. `_createContractsFromApprovalRequest` skriver `spec.internal_review_json` → Contract. Endpoints: `GET /admin/approval/pending-customer-send` (filter: `auto_create_contract=no` AND `status=Approved` AND `forwarded_at` tom AND `reviewers_count>0`) + `POST /admin/approval/:id/send-to-customer` (klonar review-OAR → kund-signer-OAR, återanvänder samma Dokument, injicerar gransknings-trail, stämplar `forwarded_at`). `_enrichContract` returnerar `internal_review_json`.
- **Bubble-schema (Christian byggt):** `OfferApprovalRequest.forwarded_at` (date) + `Contract.internal_review_json` (text long).
- **Frontend (`mira-abonnemang-admin.html`):** vy-toggle "Avtal / Väntar på utskick (N)" ovanför filtren, pending-vy med "Skicka nu till kund"-ruta, gransknings-trail i contracts-expanden. Filter delat på 3 rader.

**Spår 2 — bilage-upload i Steg 4 (2026-07-19):**
- **Backend:** `POST /admin/dokument/upload` (multer `file`, x-admin-token, CORS) — bara PDF+bild (415 annars), max 15 MB, skapar Dokument-rad → `doc_id`. `/admin/dokument/` tillagt i `openPrefixes`. `render-preview` + `render-and-send` tog redan `attachment_dokument_ids`.
- **Frontend:** riktig filväljare i Steg 4 (dold `<input type=file>`), dynamisk lista med ✕-borttag, `attachment_dokument_ids` skickas till preview + send. Backend mergar bilagorna sist i PDF-paketet + mallens `default_attachments`.

**Spår 3 — wizarden på kundkortet (`mira-abonnemang-kund.html`, 2026-07-19):**
- Wizarden (CSS+modal+script) porterad. Val (b): Steg 2 är en **läsrad** "förvald kund" (ingen picker) — `CLIENT` init:eras från `data-mira="clientcompany"`/`clientcompany_nm`, `prefillFixedClient()` fyller namn/org/adress vid init + efter reset. "+ Avtal från mall" i headern.
- **⚠️ Samexistens-krav:** admin-blocket + kundkortet ligger på SAMMA Bubble-sida → två wizardar. Löst genom att **scopa all DOM-åtkomst till block-roten** (kund→`.ab-wrap`, admin→`.aa-wrap`, via `BROOT` + `byId()` överst i varje wizard-IIFE) OCH **namnrymda kundkortets** `window`-fn→`*_k` + `data-aa`→`wiz-*-k`. Se gotcha 11 + `memory/reference-bubble-multiblock-collision.md`. **OBS: både admin- OCH kund-HTML:en ändrades** — deploya båda.

**Övriga fixar denna omgång (2026-07-18/19):**
- Adress-hämtning: `/admin/clientcompany/:id/details` plockar `.address` ur Bubble geografisk-adress-objekt (var buggigt — returnerade objektet).
- Kundbyte i wizarden rensar+skriver över namn/org/adress (fastnade förut).
- Avtalstyper översatta i UI: Subscription→Abonnemang, RateCard→Prislista (chips + `typeLabel()`; `data-val` kvar engelska). Kategorier kvar engelska (beslut).
- Ny mall `contract_templates/hk-manadsavgift-sv.json` (svensk HK månadsavgift, grundad i Planhat-avtalet). **Kör `bash contract_templates/seed.sh` för att seeda.** OBS: `monthly_cost` läses från `spec.pricing.monthly_fee_sek` i readForm — mallens fält måste heta det.
- Staff-kategorichippets `data-val` rättat till `Service & People` (matchar Option Set).

**Kvarstår Fas 5b:** spår 4 (wording), 6 (multi-office), 7 (API-nycklar → Site properties).

### Fas 5b Spår 5 — KLART + LIVE-verifierat 2026-07-27

**TTL-städ av temp-preview-Dokument (backend-only, `index.js`):**
- Ny helper `_sweepExpiredPreviewDokument({cap=20})` (direkt efter `contractRenderEngine`-init, ~rad 19739): `bubbleFind("Dokument", {constraint: deletable_after "less than" nowIso, sort_field: deletable_after, descending:false, limit:20})` → **JS-refilter** (`Date.parse(row.deletable_after) < now`) → `bubbleDelete` per rad, non-fatal per rad.
- Anropas **fire-and-forget + non-fatal** i `POST /admin/contracts/render-preview` (~rad 21257) EFTER att result finns, UTAN `await`, med `.catch` → fördröjer aldrig svaret, bryter aldrig previewen. (Render = långlivad Node-process → promisen körs klart efter `res.json`.)
- **⚠️ Gotcha-skäl för JS-refiltret:** Bubbles date-constraint (`less than`/`greater than` på date-fält med string-värde) är opålitlig (se kommentar vid FortnoxInvoice-hämtningen ~rad 14731). Constraint:en används bara som grov-filter + sort; JS-refiltret garanterar att en preview vars `deletable_after` ligger i framtiden ALDRIG raderas (skydd mot att radera en preview som en admin tittar på just nu).
- **Avvikelse från ursprungsförslaget:** `bubbleFind` (limit 20) INTE `bubbleFindAll` (som paginerar allt → motverkar cap:en).
- **Ingen Bubble-schema-ändring.** Enda ändrade fil: `index.js`.
- Verifierat: `node --check` OK · JS-refilter testat isolerat · skarpt curl mot `$HOST/admin/contracts/render-preview` → `{"ok":true,"preview":{…}}`, preview funkar som förut.

**Sidofix 2026-07-27 — `Staff` → `Service & People` i avtals-import/create (blockerare för avtals-import):**
- Fyra ställen använde det icke-existerande Option Set-värdet `"Staff"` istället för kanoniska `"Service & People"` (gotcha 2) → import/create av bemanning/rekrytering-avtal kraschade (`bubbleCreate failed`) ELLER tappade kategorin (null). Fixade: LLM extract-tool `category`-enum (`index.js` ~20983) + `VALID_CATEGORIES` i `/create` (~20610), `PATCH /:id` (~20725), `import/commit` (~21197). Plus mock-data i `mira-abonnemang-kund.html` (~1379).
- Ingen Bubble-schema-ändring, ingen migration (inga Contracts kunde ha `Category="Staff"` sparad — Bubble hade avvisat). Deploya `index.js` (+ kund-HTML för mock-konsekvens).
- **OBS medvetet EJ ändrat:** `"Staff"` finns kvar som intern JS-objektnyckel i förfrågan/leads-domänen (`SUPPLIER_BY_CATEGORY`, `SUBCAT_FIELDS`→`SubCategorySP`, leads-statistik ~10589/18749/18806/18840) — separat fungerande system, inte Contract.Category Option Set.

### Fas 4-utökning 2026-07-27 — Vision-OCR-fallback för skannade avtal (KODAT, ej deployat)

**Problem:** Många befintliga signerade avtal (+ inskannade bilagor) är **bild-PDF:er utan textlager** — `pdf-parse` läser bara inbäddad text och får tomt (Drift: 41 tecken) eller bara signaturskräp (signerad: 2117 tecken "Transaktion…Signerat"). `/import/parse` skickade den skräpen till Haiku → tomt resultat utan felmeddelande.

**Verifierat först (isolerat curl mot Anthropic-API, giltig nyckel):** native PDF **document-block** (base64) till `claude-haiku-4-5` OCR:ar de skannade OX2-avtalen perfekt — Drift 7 s/0,18 kr, signerad 28 sidor 10 s/0,26 kr, alla fält med confidence 0,85–0,99. **Streaming är obligatoriskt** — icke-streamad request 502:ar på gateway-timeout vid tung scan. Inline base64 räcker (ingen Files API); Haiku 4.5 = 100-sidorsgräns.

**Lösning (`index.js`, `/import/parse`):**
- Nya helpers efter `CONTRACT_EXTRACT_SYSTEM` (~rad 21064): `_isDegenerateContractParse()`, `_runContractTextExtraction()`, `_runContractVisionExtraction()` (streaming via `anthropic.messages.stream().finalMessage()`).
- **Text-först, vision-fallback:** kör `pdfParse`. Skannad identifieras på **texttäthet (tecken/sida)**, INTE total längd: `fullText.length < 500 || (fullText.length / numPages) < 800` → **vision**. Signerad OX2 = 192 tecken/sida (skräp), Drift = 6, äkta text-avtal (Planhat) = 2311 → tröskeln 800 separerar rent. **⚠️ En total-längdgräns ensam MISSAR signerade scans** — de har ~2112 tecken signaturskräp och passerar `< 500` (bevisat: första deploy-testet gick `method=text` på signerad OX2 → skräp i UI). `_isDegenerateContractParse` (ingen `customer_name`/`monthly_cost`/`rate_card`/`contract_type`) är sekundärt skyddsnät — **opålitligt ensamt** eftersom forcerad `tool_choice` tvingar Haiku att gissa ihop icke-tomma fält. Bias mot vision: falsk-positiv (text→vision) ofarlig, falsk-negativ (scan→text) ger skräp.
- Ersatte gamla `fullText.length < 100 → "pdf_no_text"`-guarden (felaktig logik nu). Sid-guard: `numpages > 100 → 400`.
- Svaret returnerar nytt fält `method: "text" | "vision"` så Carotte ser i UI:t hur avtalet lästes.
- **Ändrad fil:** endast `index.js`. Ingen Bubble-schema-ändring. Kostnad: vision ~0,2–0,3 kr/avtal vs ~0,09 kr text (sidor blir bild-tokens); trivialt.
- Verifierat: `node --check` OK · degenererings-logik testad isolerat (8 fall) · vision-mekaniken bevisad via fristående streamande curl.
- **KVAR:** deploya `index.js`, sedan skarpt test av **båda** vägarna — dra in en scan (OX2 signerad → `method:"vision"`) OCH en text-PDF (Planhat → `method:"text"`) via kundkortets drag-drop, bekräfta rätt väg väljs + fälten stämmer.
- Testskript i scratchpad: `ocr_test.mjs` (streamande vision-test mot valfri PDF+modell), `ping.mjs` (auth-sanity). Kräver `ANTHROPIC_API_KEY` i shell.

### Bugfix 2026-07-29 — admin "Alla avtal" tappade slutdatum-lösa avtal (KODAT, ej deployat)

**Symptom:** importerat OX2-avtal (Hybrid, utan slutdatum) syntes på kundkortet men INTE i admin "Alla avtal". Admin visade bara OX2:s gamla 0 kr-Subscription (som har slutdatum).

**Rotorsak:** `/all` ([index.js:20488](Mira-Exchange/index.js:20488)) hämtade `bubbleFindAll(Contract, {sort_field: CT_END})`. **Bubble Data API fäller poster som saknar sort-fältets värde** — avtal utan slutdatum försvann tyst ur hämtningen. `/by-company` (kundkort) hämtar OSORTERAT (bara company-constraint) → fick med dem. Alltså inte ett renderingsproblem — de två blocken anropar olika endpoints med olika hämtning.

**Fix:** tog bort `sort_field: CT_END` från `/all`s hämtning → `bubbleFindAll(Contract, {})`. Admin-frontenden sorterar redan om client-side (`rows.sort`, default `sort_by:'end'`), så backend-sorteringen fyllde ingen funktion. Endast `index.js`, ingen schema-/frontend-ändring. Se `memory/reference-bubble-sort-drops-empty`.
- Verifierat: `node --check` OK.
- **KVAR:** deploya + skarpt: `curl "$HOST/admin/contracts/all" -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | grep -c '"slutdatum":null'` → ska bli > 0 (idag 0), och OX2-Hybriden ska synas i admin-listan.

### Fas 5b — contract_title + leverantör + admin-edit-modal (2026-07-29, KODAT, ej deployat)

**Två nya Contract-fält (Christian byggt i Bubble):** `contract_title` (text, gemener), `leverantör` (referens → typen `Leverantör - Supplier`, Data API-slug `leverantör-supplier`, namnfält `Företagsnamn`). Nycklarna verifierade via round-trip PATCH.

**Backend (`index.js`):**
- Konstanter `CT_TITLE`/`CT_SUPPLIER`. Namn-baserad kategori→leverantör-resolver (`_loadSuppliers`, `_supplierIdForCategory`, `SUPPLIER_NAME_BY_CATEGORY`): Housekeeping→Carotte Housekeeping AB, Service & People→Carotte Staff AB, Food & Event→Carotte Food & Event AB, Other facility services→Carotte Group AB. (Resolvar på namn, inte hårdkodat ID — men `SUPPLIER_BY_CATEGORY`-ID:na råkade redan matcha.)
- `_enrichContract` exponerar `contract_title`, `leverantör` (ref-id), `leverantör_name`. `/all`+`/by-company`+patch/create-retur laddar `supplierById` i ctx.
- `/create` + `/import/commit` skriver båda fälten med **kategoristyrd default-leverantör** (om tomt). `PATCH` som delta.
- `CONTRACT_EXTRACT_TOOL` föreslår `contract_title` (LLM) vid PDF-import.
- Ny endpoint `GET /admin/suppliers` (lista + `default_by_category`) + i `openPrefixes`. Skarpt verifierad.

**Kundkort (`mira-abonnemang-kund.html`):** `Avtalstitel` + `Leverantör`-dropdown i create/edit/import-modalen (`f-title`/`f-supplier`). Leverantör förvald från kategori (överskrivbar), prefill i edit, LLM-titel + kategori-default vid import. **Bonusfix:** import skickar nu `category` (saknades → importerade avtal kunde bli utan kategori).

**Admin (`mira-abonnemang-admin.html`) — #2 Redigera från stora listan:** admin hade INGEN contract-modal (bara stub-alerts). Byggde en **fokuserad edit-modal** (`aa-cm-*`-namnrymd, `data-aa="cm-*"`, egen CSS) porterad från kundkortet. Redigera-knappen → `openContractEdit(id)` (prefill från SAMPLE). Direkt **kategori-select** (admin har ingen katalog → inte via offer) + leverantör-dropdown (default från kategori). Rate-card/volym som JSON-textareas (admin power-user). PATCH-delta lämnar offer/office orörda. SAMPLE-mappningen utökad med `contract_title`/`leverantör`/`rate_card_json`/`volume_json`/`qty`. `+ Nytt avtal` i admin är fortf. stub (create kräver företagskontext — utanför scope).
- Verifierat: `node --check` (index.js) + isolerad script-block-syntaxkontroll (båda HTML). Fältnycklar round-trip-verifierade.
- **KVAR att deploya:** `index.js` + BÅDA HTML-filerna. Sedan skarpt: kundkort create/edit/import + admin Redigera på ett avtal, bekräfta title+leverantör persisterar och att admin-modalen inte krockar med kundkorts-modalen (gotcha 11).
- **Wizarden (2026-07-29, KODAT):** `_createContractsFromApprovalRequest` (auto-create-vid-signering, `index.js` ~16540) sätter nu `CT_TITLE` + `CT_SUPPLIER` på auto-skapade contracts. **Auto-härledda** (ingen wizard-UI): leverantör från `spec.category` (via `_supplierIdForCategory`), titel = `spec.contract_title` ELLER `"<kategori> <kundnamn>"` gemener (kundnamn hämtas en gång från ClientCompany). Spec kan överskriva båda. OBS: auto-create gäller BARA Subscription-specs (RateCard/Hybrid hoppas → manuell). Beroende: templatens `contract_specs` måste ha `category` för leverantör-auto. `node --check` OK.
- **Valfritt kvar:** manuellt title-fält i wizardens Steg 3 (schema-driven) om Christian vill namnge före utskick — annars räcker auto + redigering i efterhand via edit-modalen.

### Aktiva filer (uppdaterat 2026-07-14)

- `index.js` (~21 500 rader) — SERVICES-konstanter (rad ~19653, inkl. CTPL_*+DOK_DELETABLE_AFTER), `_createContractsFromApprovalRequest` + `_deriveContractStatus` (rad ~16460), `_createApprovalRequestInternal` (rad ~16770), `_enrichContract` + admin/contracts-endpoints (rad ~19960+), Fas 4 CONTRACT_EXTRACT_TOOL + parse/commit (rad ~20974), Fas 5 CRUD + render-preview + render-and-send + clientcompany/:id/details + prototyp-routes (rad ~21200-slutet)
- `pdf_utils.js` (NY, ~150 rader) — delade PDF/HTML-helpers (Fas 5)
- `contract_render.js` (NY, ~230 rader) — DI-motor för mall-rendering (Fas 5)
- `offer_approval_doc.js` — refaktorerad att importera från pdf_utils
- `mira-abonnemang-kund.html` (~3160 rader) — kundkort-flik i Företag-popupen. **Wizarden nu porterad hit (Fas 5b spår 3, 2026-07-19)** — namnrymd + BROOT-scopad för samexistens med admin-blocket. Se gotcha 11.
- `mira-abonnemang-admin.html` (~2200 rader efter Fas 5) — global "Alla abonnemang"-sida MED inbäddad wizard-modal
- `mira-kommunikation-admin.html` — API-nyckel fixad via JS (Bubble hidden-input-strip-bugg)
- `contract_templates/*.json` (NY mapp) — 5 seedade mallar + seed.sh
- `prototypes/*.html` (NY mapp) — public prototyper på /prototyp/*
- `mira-avtalsmodulen-oversikt.pdf` (NY, 692 KB, 5 sidor) — översikt för Teams-delning
- `ARKITEKTUR_OCH_OMTAG.md` §10 — djupdesign för hela tjänste-grid-spåret
- `package.json` — dependencies `@anthropic-ai/sdk@^0.88.0` + `pdf-parse@^1.1.1` + `puppeteer-core@^23` + `@sparticuz/chromium@^131` + `pdf-lib@^1.17`

### Env vars på Render (bekräftat)

- `PLANNING_ADMIN_TOKEN` — auth för `/admin/contracts/*` + `/admin/approval/*` + `/admin/forfragan/*`
- `ANTHROPIC_API_KEY` — Fas 4 LLM-parsning (Haiku 4.5)
- `SYNC_V2_ORDERS=1` — nightly cron (0f-status, oförändrat)

---
