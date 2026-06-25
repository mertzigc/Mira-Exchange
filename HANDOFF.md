# HANDOFF — Mira-Exchange sync-omtag

> Senast uppdaterad 2026-06-24. Läs detta + `ARKITEKTUR_OCH_OMTAG.md` (§1–9) för full kontext.
> Syfte: ny session ska kunna ta vid exakt här. Djupdesign finns i ARKITEKTUR_OCH_OMTAG.md.

---

## 0e. OfferApproval full Render-cutover — KODAT & VERIFIERAT 2026-06-24

**Beslut + leverans (2026-06-24):** allt signeringsflöde flyttat till Render. Bubble är databas + tre HTML-block för Carotte-UI. End-to-end smoke-testat: invite-mail → Mira-stilad landningssida → OTP → signering → mergad PDF + signeringsbevis → bekräftelsemail. Klart, live, fungerar.

### BankID-beslut 2026-06-24 (omprövas ej före 2027 om volymen inte ändras)

**Scope-uppdelning bekräftad:**
- **Anställningsavtal** stannar i Intelliplan / Caspeco / Tengella (befintlig BankID-integration via deras egna signering — HR-spår, BankID krävs).
- **Allt kommersiellt** (kundavtal, offerter, tilläggsavtal, dokumentutbyte) körs i Mira med nuvarande OTP-flöde.

**Varför ingen BankID i Mira:**
- SES (Enkel Elektronisk Signatur) är juridiskt bindande för avtal mellan parter under svensk avtalsfrihet — räcker för Carottes kommersiella vardag.
- Egen BankID-integration via aggregator (ZignSec / GrandID / Scrive eID Hub) skulle kosta ~35-60k SEK utveckling + 2-3 veckor onboarding + ~500-1500 SEK/mån i drift utan motsvarande affärsnytta vid nuvarande volym.
- HR-spårets behov av AES-bevisvärde är redan löst i Intelliplan/Caspeco/Tengella.

**Tröskel för omprövning:** om Mira får >50 BankID-krävande signeringar/månad (t.ex. vid större kundavtal som motpart explicit kräver BankID på) → bygg om till ZignSec eller GrandID som primärval (deep-research-transcript: wf_a2157593, 2026-06-24).

---

### Status

| Komponent | Status |
|---|---|
| Datamodell (OfferApprovalRequest + `request`-länk på OfferApproval) | ✅ Live i Bubble |
| EmailTemplate-rader (approval_invite/otp/signed) | ✅ Live i Bubble, kopplade via env vars |
| Render env vars (APPROVAL_*_TEMPLATE_ID, PUPPETEER deps) | ✅ Satta |
| Backend routes (skapa/view/request-otp/confirm/docs/admin-list/admin-request-detail/clientcompany) | ✅ Live, smoke-testade |
| Email-templates i emailer.js (3 nya tmpl-funktioner, invite+otp i Carotte-orange) | ✅ Live |
| Landningssida (/approval/view/:id) i mörk Mira-stil med auto-OTP | ✅ Live |
| Carotte-block #1: `mira-approval-create.html` (Deal-aware / CC-aware / Standalone) | ✅ Inbäddat i Deal-popup |
| Carotte-block #2: `mira-approval-archive.html` (global tabell + inline create + cc-picker) | ✅ Skapat — väntar inbäddning |
| Cutover Bubble → Render | ⏳ Gammal /offerapproval/[id]-sida + dess workflows kan rivas när Carotte vant sig |

### Filer

| Fil | Roll |
|---|---|
| `offer_approval_doc.js` | DI-engine: bygg HTML-bevis → puppeteer-core + @sparticuz/chromium PDF → pdf-lib merge med originalen → bubbleUploadFile → PATCH signed_document. Läser parent (Request) först, fallback till child. |
| `approval-cert.template.html` | A4-mall för signeringsbeviset (Carotte-brandad, ljus). |
| `mira-approval-create.html` | Carotte-init-block, **tre lägen** auto-detekteras från config: **Deal-aware** (Deal-popup), **CC-aware** (Company-popup), **Standalone** (fristående). Multi-instance-safe (data-attribute scoping, claim-mekanism). Inbäddningsbart flera ggr i samma DOM. |
| `mira-approval-archive.html` | Global admin-vy: filtrerad tabell över ALLA signeringsprocesser (sök på rubrik/företag/avsändare client-side; status + datum-range server-side), expand-rad med per-recipient-detaljer, inline create-panel (ingen modal pga Bubble z-index-krockar) med ClientCompany-picker som återanvänder `/admin/planning/companies`. |
| `emailer.js` | 3 nya template-funktioner (`tmplApprovalInvite/Otp/Signed`) + switch-cases. Invite+OTP i Carotte-orange (#df6f39), Signed i grön (#047857). |
| `index.js` | Routes + helpers (token-hash, OTP-gen, CORS, fail-fast på env, claim-baserade Bubble-helpers). |
| `package.json` | `puppeteer-core ^23` + `@sparticuz/chromium ^131` + `pdf-lib ^1.17` + `multer ^1.4.5-lts.1`. |

### Datamodell

**`OfferApprovalRequest`** (moder)
| Fält | Typ |
|---|---|
| `rubrik` | text |
| `meddelande` | text |
| `dokument` | List of Dokument |
| `clientcompany` | ClientCompany (optional) |
| `deal` | Deal (optional) |
| `sender_email`, `sender_name` | text |
| `status` | option set `offer_approval_status` (Draft/Sent/Viewed/OTP_Sent/Approved/Expired/Revoked) |
| `recipients_count`, `signed_count` | number |
| `expires_at` | date (optional) |

**`OfferApproval`** (barn) — befintliga fält + nytt:
| Fält | Typ |
|---|---|
| `request` | OfferApprovalRequest (NYTT — länk till moder) |
| `signed_document` | file |
| `signed_document_generated_at` | text |

Gamla speglade fält (`rubrik`/`meddelande`/`dokument` etc) lever vidare på barn-typen för bakåtkomp; nya flödet skriver parent-första.

**ClientCompany — namnfält:** Carotte använder `Name_company` (varieras NÅNTING annat lockas). Alla namn-resolvers i Render-koden faller tillbaka via 8 varianter, men `Name_company` är prio.

### Endpoints

**Mottagar-flöde (publika, token-grindade):**
| Method + Path | Auth | Beskrivning |
|---|---|---|
| `GET /approval/view/:id?t=...` | token i query (SHA-256-hash-jämförelse) | Server-renderad landningssida i mörk Mira-stil. Auto-skickar OTP vid pageload, OTP-input + Signera-knapp. Visar bekräftelsevy om redan signerat (idempotent). |
| `POST /approval/request-otp/:id` | token i body | Genererar 6-siffrig OTP, SHA-256 + 10 min exp, köar OTP-mail. Status → OTP_Sent. Rate-limit 30/h/IP. |
| `POST /approval/confirm/:id` | token + otp i body | 5-stegs: PATCH approved_at/ip/ua + token_email_verify → doc-gen → status=Approved + bränn OTP → parent-rollup (signed_count++, status=Approved när alla klar) → bekräftelsemail. Idempotent på `signed_document` (inte status, så halvfärdiga retry funkar). Rate-limit 20/h/IP. |

**Carotte-UI (x-admin-token = PLANNING_ADMIN_TOKEN):**
| Method + Path | Beskrivning |
|---|---|
| `POST /approval/create` | multipart: filer + payload-JSON. Skapar Dokument + Request + N OfferApproval + N invite-mail. Fail-fast om template-IDs saknas. |
| `GET /admin/approval/list` | Lista Requests. Query: `?status=`, `?deal=`, `?clientcompany=`, `?from=ISO`, `?to=ISO`, `?enrich=1` (resolvar `clientcompany_name`), `?limit=` (1-500). |
| `GET /admin/approval/request/:id` | Full detail: parent + alla barn-approvals (status/IP/UA/signed_document) + dokument. För expand-vyn. |
| `GET /admin/clientcompany/all` | Hela ClientCompany-listan, `{id, name}`-par sorterade på namn (för Carotte-UI:s autocomplete). Använder `Name_company` som primär fält. |
| `GET /admin/clientcompany/search?q=` | Sökrouten via Bubbles `text contains` — sliten av frontends client-side filtering, behållen för API-kompletthet. |
| `GET /admin/planning/companies` | (befintlig från förfrågan-modulen) — samma syfte som /all ovan; arkiv-vyn återanvänder denna eftersom den redan är beprövad och känner till Name_company. |

**Intern (x-sync-secret):**
| Method + Path | Beskrivning |
|---|---|
| `POST /docs/offer-approval/:id` | Bara doc-gen (för manuell omgenerering om något behöver re-renderas). |

### Env vars (Render)

| Namn | Värde |
|---|---|
| `APPROVAL_INVITE_TEMPLATE_ID` | Bubble unique_id för EmailTemplate slug=approval_invite |
| `APPROVAL_OTP_TEMPLATE_ID` | Bubble unique_id för EmailTemplate slug=approval_otp |
| `APPROVAL_SIGNED_TEMPLATE_ID` | Bubble unique_id för EmailTemplate slug=approval_signed |
| `PLANNING_ADMIN_TOKEN` | Återanvänder befintlig (samma som /admin/forfragan/*) |

**Notera:** vi pivoterade från `puppeteer` (full Chrome) → `puppeteer-core` + `@sparticuz/chromium` (slim Chrome) pga Render's bygg-cache. INGEN `PUPPETEER_CACHE_DIR` behövs nu — chromium ligger inuti node_modules.

### Bubble-inbäddning av HTML-blocken

Båda blocken (`mira-approval-create.html` och `mira-approval-archive.html`) är **multi-instance-safe** — kan bäddas in flera ggr i samma DOM utan kollision. Tekniken: data-attribute-baserade query-hooks + claim-mekanism (varje IIFE tar nästa otagga `.ac-wrap`/`.aa-wrap`).

**Hidden inputs styrs av Bubble dynamic data** — sätt `value="..."` med Bubbles tokens direkt på HTML-attributen:

**`mira-approval-create.html`** (Deal-popup + Company-popup):
```html
<input type="hidden" data-mira="api_host"       value="https://mira-exchange.onrender.com">
<input type="hidden" data-mira="planning_token" value="<Site's PLANNING_ADMIN_TOKEN>">
<input type="hidden" data-mira="sender_email"   value="<Current User's email>">
<input type="hidden" data-mira="sender_name"    value="<Current User's full name>">
<input type="hidden" data-mira="clientcompany"  value="<Current Deal's ClientCompany unique id>">
<input type="hidden" data-mira="deal"           value="<Current Deal's unique id>">
```

Lägen detekteras automatiskt:
- `deal` satt → **Deal-aware**: listar bara signeringar för Deal:en
- bara `clientcompany` satt → **CC-aware**: listar alla signeringar för bolaget (oavsett Deal)
- inget satt → **Standalone**: bara create-formuläret

**`mira-approval-archive.html`** (admin-sida):
```html
<input type="hidden" data-mira="api_host"       value="https://mira-exchange.onrender.com">
<input type="hidden" data-mira="planning_token" value="<Site's PLANNING_ADMIN_TOKEN>">
<input type="hidden" data-mira="sender_email"   value="<Current User's email>">
<input type="hidden" data-mira="sender_name"    value="<Current User's full name>">
```
(inga deal/clientcompany — vyn är global. Carotte väljer bolag i create-panel:en via autocomplete.)

### Cutover-checklista — Bubble-städning

När de tre HTML-blocken är inbäddade och Carotte använt dem live i några dagar:

1. **Riv Bubble-sidan `/offerapproval/[id]`** — landningssidan lever nu på Render. URL:erna i nya invite-mailen pekar redan dit.
2. **Riv Bubble-workflows kring OfferApproval-skapande:**
   - "Button Skapa länk is clicked" (skapade approval_link manuellt)
   - "Button Skicka är clicked" → emailqueue-create (Render gör det nu)
   - Alla Make changes to OfferApproval på godkännande-sidan
3. **Riv gamla Offerter-fliken i Deal-popupen** — ersätts av embedded `mira-approval-create.html`.
4. **Behåll i Bubble:**
   - Datatyperna (OfferApproval, OfferApprovalRequest, Dokument, ClientCompany) — Render läser/skriver direkt
   - EmailTemplate-rader och emailqueue-pollern (oförändrad)
   - Sidorna där HTML-blocken bor (dashboard_crm för Deal/Company-popups, en admin-sida för arkivet)
5. **Övergångsperiod:** gamla OfferApproval-poster (token-format som inte är SHA-256-hex) signeras vidare på Bubble-sidan tills den rivs. Hård cutoff på datum X — du sätter X när du känner dig trygg.
6. **OPTIONAL: switch URL från onrender.com till api.mira-fm.com** — när du har custom domän mappad mot Render, uppdatera `data-mira="api_host"` i blocken. Befintliga view_url:er fortsätter funka eftersom Render serverar båda.

### Säkerhet

- **Tokens:** raw 32-byte hex i URL, SHA-256-hash i DB. Constant-time `timingSafeEqual`.
- **OTP:** 6-siffrig, SHA-256-hash i DB, 10 min exp, brännbar (sätts tom efter användning).
- **Rate-limit:** 20 confirm-anrop / 30 OTP-anrop per IP per timme.
- **CORS:** explicit allowlist (carotteconcierge.bubbleapps.io, mira-fm.com, www.mira-fm.com).
- **Master-Bubble-nyckeln** stannar serverside hela tiden. Carotte-UI grindas av PLANNING_ADMIN_TOKEN (samma som forfragan/planning).
- **PDF-integritet:** varje original SHA-256-hashas, hashen visas i signeringsbeviset (juridiskt bevis om PDF ändrats).

### Smoke-test

```bash
# 1. Skapa via API
curl -X POST "https://mira-exchange.onrender.com/approval/create" \
  -H "x-admin-token: $PLANNING_ADMIN_TOKEN" \
  -F 'payload={"rubrik":"Test","meddelande":"...","sender_email":"christian@carotte.se","sender_name":"Carotte","recipients":[{"email":"x@y.se","name":"X"}]}' \
  -F 'files=@/tmp/test.pdf'

# 2. Öppna view_url i browser → OTP-mail anländer → signera → bekräftelsemail

# 3. Lista pending
curl "https://mira-exchange.onrender.com/admin/approval/list?status=Sent&limit=10" \
  -H "x-admin-token: $PLANNING_ADMIN_TOKEN"

# 4. Filtrera arkiv på Deal + datum
curl "https://mira-exchange.onrender.com/admin/approval/list?deal=<DEAL_ID>&enrich=1" \
  -H "x-admin-token: $PLANNING_ADMIN_TOKEN"

# 5. Detail-vy (för Carotte expand)
curl "https://mira-exchange.onrender.com/admin/approval/request/<REQUEST_ID>" \
  -H "x-admin-token: $PLANNING_ADMIN_TOKEN"
```

### Lärda lektioner (för framtida Render+Bubble-integrationer)

- **Render + Puppeteer = pivot till `puppeteer-core` + `@sparticuz/chromium` direkt.** Spar 2-3 deploys av PUPPETEER_CACHE_DIR-felsökning.
- **emailqueue-fältet är `template_id`** (Bubble-relation till EmailTemplate-rad), inte `template_slug`. emailer.js stödjer slug-fallback i läsning men Bubble's schema avvisar okända fält vid write.
- **PATCH-status FÖRST efter doc-gen** (eller annan riskoperation), annars triggar "redan klar"-idempotens på halvfärdigt state vid retry. Mönster: skriv "ofarliga" fält först, riskoperation, sen finalisera. Idempotens-checken ska titta på *resultat*-fältet (`signed_document`), inte *flag*-fältet (`status`).
- **OfferApproval-fält i Bubble är lowercase-slug** (`approval_link`, inte `Approval_link`). Visningen i datatyper-vyn använder display-namnet, API:t använder slug.
- **ClientCompany.name-fältet är `Name_company`** hos Carotte. Inte `name`/`Name`/`company_name`. Alltid testa befintliga endpoints (t.ex. `/admin/planning/companies`) innan man bygger en ny — chansen är stor att fältnamnet redan är dokumenterat i kod.
- **Multi-instance HTML-block i Bubble:** två popups med samma block = duplicate IDs i DOM = `getElementById` returnerar bara första. Använd `data-*`-attribut + claim-mekanism (`querySelectorAll` + `dataset` flag) istället. Kritiskt för Deal+Company-popups som båda har samma block.
- **Modal med `position: fixed` krockar med Bubbles z-index/popup-stack.** Inline-expand-paneler inuti själva HTML-blocket undviker konflikten helt och fungerar lika bra UX-mässigt.
- **CC-search via `text contains` är bräckligt** — Bubble's constraint kan vara case-sensitive eller kräva specifik fälttyp. Säkrare: fetcha hela listan en gång (~hundratals records är trivialt) och filtrera client-side via `.toLowerCase().includes()`.

---

## 0e-archive. Mellan-steg dokumenterade under bygget — KAN IGNORERAS

### Datamodell — KRAV INNAN COMMIT 1 KAN ANVÄNDAS

**Ny Bubble-typ: `OfferApprovalRequest`** (moder; håller dokument + meddelande, en per signeringsutskick)
| Fält | Typ | Notering |
|---|---|---|
| `rubrik` | text | Visas i mail + landningssida |
| `meddelande` | text | Personligt meddelande från Carotte |
| `dokument` | List of Dokument | Filerna som ska signeras |
| `clientcompany` | ClientCompany | Optional |
| `deal` | Deal | Optional |
| `sender_email` | text | Carotte-personalen som initierade |
| `sender_name` | text | Visningsnamn i mail |
| `status` | text *(eller Option Set)* | "pending" / "completed" / "expired". Sätts av Render. Sätt som text om du vill slippa Option Set |
| `recipients_count` | number | N st OfferApproval skapade |
| `signed_count` | number | Antal som hittills signerat (rollup) |
| `expires_at` | date | Optional deadline |

**Modifiera befintlig `OfferApproval`** — lägg till:
| Fält | Typ | Notering |
|---|---|---|
| `request` | OfferApprovalRequest | Länk till moder. Sätts vid skapande, ändras aldrig |

`OfferApproval`-fält som blir **avvecklade** (de fyllda nu överlever men nya fyller dem inte): `rubrik`, `meddelande`, `dokument`, `clientcompany`, `deal`, `fortnoxoffer`, `approval_link`, `expires_at`. Dessa läses från `request` istället. Vi rör inte fälten i Bubble (datamigrering = utanför scope), läser bara från parent när tillgängligt och faller tillbaka på child-fältet för bakåtkompabilitet.

**EmailQueue** — befintlig typ används. Inga nya fält. Vi sätter `template_slug` till en av tre nya slugs:
- `approval_invite` — mottagaren får länk + token
- `approval_otp` — engångskod
- `approval_signed` — bekräftelse med länk till signed_document

### Bestäm innan commit 2: var ska landningssidan ligga?

`/approval/view/:id` serverar HTML direkt från Render (likt `mira-kalender.html`-mönstret). URL i invite-mailet pekar dit. Bubble behöver INGEN `/offerapproval/[id]`-sida längre.

---

## 0c. OfferApproval-dokument (signeringsbevis) — KODAT 2026-06-24, ej deployad

**Vad:** Ny modul + route som genererar ett brandat signeringsbevis från `OfferApproval`, mergar in det SIST i originaldokumentens PDF:er (SHA-256-hashade per dokument för integritetsbevis), laddar upp den sammanslagna filen till Bubble och skriver tillbaka URL:en på `OfferApproval.signed_document`.

**Filer:**
- `offer_approval_doc.js` — `createApprovalDocEngine({ bubbleGet, bubblePatch, bubbleUploadFile })`. Puppeteer-singleton (lazy), pdf-lib för merge, två-fas mall-rendering (rå-slots `DOCS_HTML`/`MESSAGE_BLOCK`, övrigt HTML-escapas).
- `approval-cert.template.html` — A4, Carotte-brandad, sektioner: agreement-summary, godkännande, verifiering, meddelande, dokumentlista m. SHA-256.
- `package.json` — la till `puppeteer ^23` + `pdf-lib ^1.17`.
- `index.js` — import överst, `approvalDocEngine`-instans + `POST /docs/offer-approval/:id` (requireSyncSecret) precis efter `/sync/activities/:source`. Body `{ writeBack: true|false }` (default true).

**KRAV INNAN DEPLOY:**
1. **Skapa Bubble-fält på OfferApproval:**
   - `signed_document` (file)
   - `signed_document_generated_at` (text — ISO-tidsstämpel)
   - Utan dessa fält droppas patch-fälten tyst (Bubble-konvention).
2. **`npm install` på Render** för att dra ner `puppeteer` (~300 MB med Chromium) + `pdf-lib`. Render's Node-bygge installerar systembiblioteken Chromium behöver automatiskt — om Chromium ändå faller, byt till `puppeteer-core` + `@sparticuz/chromium`.
3. **Triggning (steg 1):** Bubble-workflowet `Button Skapa länk is clicked` byts från native "Make changes to OfferApproval" → ett enda API Connector-anrop `POST {RENDER_HOST}/docs/offer-approval/{approval_id}` med headers `x-api-key: $MIRA_RENDER_API_KEY` + `x-sync-secret: $SYNC_SECRET`. Routen returnerar `{ ok, signed_document_url, bytes, original_docs:[...], cert_bytes }`.

**Test-flöde (utan att röra Bubble):**
```
curl -X POST "$HOST/docs/offer-approval/1781784640216x3346460440369561" \
  -H "x-api-key: $MIRA_RENDER_API_KEY" \
  -H "x-sync-secret: $SYNC_SECRET" \
  -H "content-type: application/json" \
  -d '{"writeBack": false}'
```
Returnerar `signed_document_url` (Bubble file-URL) utan att patcha approval.

**Steg 2 (när offertmotorn flyttar till Render):** anropa `approvalDocEngine.generateAndStore(approvalId)` direkt i offer-engine-koden. Modulen är redan paketerad för det — ingen HTTP-hop behövs.

**Fält-mappning (bekräftad 2026-06-24):** alla OfferApproval-fält är lowercase i Bubble Data Types-vyn (`approval_link`, `approved_at`, `clientcompany`, `deal`, `dokument`, `meddelande`, `recipient_email`, `rubrik`, `status`, `token_email_verify`, `token_hash` etc.). `status` är Option Set `offer_approval_status` (returneras som sträng via Data API). Listfält `dokument` är array av Dokument-IDs; bubbleGet-typnamn är `Dokument` (capital D — befintlig konvention i index.js, fungerar). ClientCompany/Deal-schemat ej verifierat → behåller pick()-fallback för namn-fältet.

---

## 0d. OfferApproval-godkännande direkt mot Render — KODAT 2026-06-24, ej deployad

**Vad:** Browser-callable route `POST /approval/confirm/:id` som tar över själva godkännande-akten från Bubble. Lägger på server-side IP + user-agent (kundens, eftersom anropet kommer direkt från browsern) + status="Approved" + approved_at, och triggar `approvalDocEngine.generateAndStore` internt i samma anrop.

**Filer:**
- `index.js`:
  - `/approval/confirm/` tillagd i `requireApiKey`-openPrefixes (browsers anropar utan x-api-key — grindas av token-jämförelse mot `token_hash` istället).
  - Route + CORS-helper + OPTIONS-preflight, direkt efter `/docs/offer-approval/:id`.

**Auth-modell:**
1. Mottagaren får tokenet via mail-länk → landar på Bubbles approval-sida.
2. Bubble validerar OTP (det jobbet stannar i Bubble tills vidare).
3. Bubbles sida POSTar `{ token }` till `/approval/confirm/:id` från KLIENT (HTML/JS block, ej API Connector — anledning: API Connector kör server-side och skulle ge Bubbles IP istället för kundens).
4. Render gör constant-time `crypto.timingSafeEqual` mot `OfferApproval.token_hash`. Inga API-nycklar exponeras client-side.

**Bubble-flöde-cutover:**
- GAMLA "Make changes to OfferApproval" (sätter status, approved_at) → **bort**.
- I stället: HTML-block på approval-sidan som vid Approve-klick gör:
  ```js
  fetch("https://api.mira-fm.com/approval/confirm/" + APPROVAL_ID, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: APPROVAL_TOKEN })
  }).then(r => r.json()).then(({ signed_document_url }) => { /* visa knapp/länk */ })
  ```
- Bubbles workflow på sidan ska sedan bara `Reload data` på OfferApproval för att hämta nya `signed_document` + statusen.

**CORS-allowlist:** `carotteconcierge.bubbleapps.io`, `mira-fm.com`, `www.mira-fm.com`. Lägg till fler domäner i `_approvalConfirmCors` om du har white-label-domän.

**Rate-limit:** 20 godkännandeanrop per IP per timme (`_publicRateLimited`).

**Edge cases:**
- Redan godkänd (status=Approved + approved_at satt) → hoppar över PATCH, kör bara generateAndStore på nytt (idempotent). Originaldata (IP/UA) bevaras.
- `otp_expires_at` passerat → 410.
- Tomt `token_hash` på approval → 403 (fail closed).
- Token-mismatch → 401.

**KRAV INNAN DEPLOY:**
1. ✅ Bubble-fält `signed_document` + `signed_document_generated_at` skapade (verifierat 2026-06-24).
2. Verifiera att `token_hash` på OfferApproval faktiskt innehåller det Bubble-sidan kan skicka in (klartext eller hash — beroende på hur Bubble lagrar). Om mismatch: justera klient-side att skicka rätt form, ELLER ändra serverside-jämförelsen till att SHA-256-hasha input innan compare.
3. Bygg om HTML-blocket på Bubbles approval-sida att POSTa till `/approval/confirm/:id` (se exemplet ovan).
4. Behåll Bubbles OTP-validering oförändrad — vi flyttar bara approval-akten + dokumentgenerering.

**Steg 3 (framtida):** flytta även OTP-utskick + verifiering till Render när offertmotorn migreras. Då stannar i Bubble bara visningssidan (eller den ersätts av en Render-renderad HTML).

---

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
- **Backfill (2026-06-11) VERIFIERAT KLAR:** drän via enrich-routerna → `count: 0` aktiva (icke-makulerade) FortnoxInvoice utan ft_pdf, över alla connections (auktoritativ Data-API `results`-hämtning; Bubbles `remaining`-räknare ligger efter/cachad → lita på `count`/`results`, inte `remaining`). Makulerade fakturor saknar ft_pdf medvetet (behövs ej). Steady-state: `sync_v2_cron.sh pdf` (*/30) håller det fyllt.
- **HK/Tengella-enrich-routen är tung** (global svep alla kunder×fakturor) → kan timeouta i cron men slutför server-side; resilient `post` tolererar. Om nya HK-fakturor framöver inte får ft_pdf i tid: bygg lätt variant (query FortnoxInvoice connection=TENGELLA + ft_pdf is_empty, hämta från `ft_url`/raw) i stället för helsvepet.

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
- **`sync_v2_cron.sh` delar upp arbetet (WU-OPTIMERAT 2026-06-15):** `sync_customers()` = inkrementell Fortnox-kundsynk F&E+Staff (`days_back=$CUST_DAYS` default 3, `max_pages=$CUST_PAGES` default 3) + Tengella-kundsynk (119 kunder). Den sätter `linked_company`/`company` PÅ KUNDPOSTEN vid upsert. **Körs NATTLIGT + full, FÖRE dokumentsynken** → nya dokument får sin linked_company redan vid create. `reconcile_links()` = `/sync/v2-linkcustomer` (both) + `/sync/v2-linkcompany/all` write — **bara i `full` (veckovis)**. Kunde EJ återaktivera gamla cronen: den drar order/offer-synk som krockar med v2.
- **⚠️ WU-FÄLLA (löst 2026-06-15):** första versionen körde `reconcile_links` (helskanning av ~20k dokument inkl `ft_raw_json` + ~7,7k kunder) NATTLIGT → drog enorma Bubble-WU (FortnoxInvoice-synken blev ~75% av API-WU). Flyttat till weekly. Nattligt = bara inkrementell kund-synk + modified-sweep (bundet). Nya/ändrade docs länkas ändå vid create/update; reconcile fångar bara historiska noop-docs + efterhands-städade kunder → veckovis räcker. Nästa WU-knapp om det fortf. är högt: sänk `MODIFIED_DAYS_BACK` (3→2).
- **Render-status:** gamla kund-cronen (Mira-Exchange-CronJob, TengellaNightlySync) suspenderade — behövs ej, sync_customers ersätter dem. Aktiva cron: Nightly/Weekly fakturasync (= sync_v2_cron), sync_v2_pdf.
- **Svaret på "blir Mira komplett":** JA — Mira lever sig självt givet att korrekt orgnr matas in i Fortnox/Tengella vid kund-skapande. Nya kunder/dokument länkas vid create (nattligt); historiska luckor fylls av weekly-reconcile när källan rättas. Restpost som aldrig länkas (privatpersoner, utländska utan svenskt orgnr, "EJ FAKTURERA"-interna) är korrekt olänkad by design.

## 8. Fallgropar (lärda)
- Fortnox rate-limit: krävde retry+backoff (`fortnoxGetRetry`) + throttle (`throttleMs`, default 200, april behövde 350). Listing-fel mitt i paginering → kastar → 500 på hela requesten; idempotent så kör om.
- Render long-running: curl `--max-time` högt; idempotent så timeout ofarlig.
- `maxRecords` räknar FÖRSÖK (inte träffar) så scoped test stoppar även vid fel.
- Bubble 100-träffars-cap: använd `bubbleFindAll` (paginerar), inte rå `bubbleFind`.
- **WU-FÄLLA: `ft_pdf is_empty`-sökning i PDF-enrich (löst delvis 2026-06-22).** `/fortnox/enrich/invoice-pdfs` söker `ft_pdf is_empty` över hela FortnoxInvoice (~10k rader) — `is_empty` kan ej indexeras → heltabellsskanning, mycket dyrt i Bubble-WU. `sync_v2_pdf`-cronen körde det i blind `for i in 1..6` × 3 conn = 18 skanningar/körning var 30:e min, dygnet runt → ~1000 WU/h konstant (FortnoxInvoice = ~75% av API-WU). **Fix nivå 2:** loopen är nu självterminerande (`enrich_invoice_pdfs`, bryter när found<40) → steady state 1 sökning/conn. **Nivå 1 (Christians Render-åtgärd):** sänk sync_v2_pdf-frekvens */30 → 1/h eller 4/h. **Nivå 3 (permanent, ej gjord):** flagg-baserad invoice-PDF som order (sätt `needs_pdf_sync=true` i invoice-buildPayload + engångsbackfill + sök `needs_pdf_sync==true` istället för is_empty → billig equality, ingen heltabellsskanning). `fetchAndStoreInvoicePdf` sätter redan `needs_pdf_sync:false`.
