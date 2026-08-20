# OfferApproval — signering av offerter

> Full Render-cutover: skapa → OTP → signera → PDF-bevis → arkiv.
> Kod: `offer_approval_doc.js`, `approval-cert.template.html`, `mira-approval-*.html`.

---
## 0e. OfferApproval full Render-cutover — KODAT & VERIFIERAT 2026-06-24

**Beslut + leverans (2026-06-24):** allt signeringsflöde flyttat till Render. Bubble är databas + tre HTML-block för Carotte-UI. End-to-end smoke-testat: invite-mail → Mira-stilad landningssida → OTP → signering → mergad PDF + signeringsbevis → bekräftelsemail. Klart, live, fungerar.

### Granskar-roll + manuella påminnelser — KODAT 2026-06-24

**Nytt efter internt testande:**

**Granskar-roll:**
- OfferApproval har nytt fält `role` ("Signer" | "Reviewer", default "Signer") + `reviewed_at`
- OfferApprovalRequest har nytt `reviewers_count` + `reviewed_count`
- Skapande-UI: per-recipient dropdown ("Signerar" / "Granskar")
- Granskare får eget invite-mail (`approval_review_invite`-template), egen landningssida UTAN OTP — bara "Godkänn granskning"-knapp
- Ny route `POST /approval/review/:id` (token-grindad, ingen OTP) som loggar `reviewed_at` + IP/UA, bumpar parent.reviewed_count
- Signeringsbeviset visar separat sektion "Granskat av:" med alla reviewers + tidpunkt + IP
- Granskare räknas INTE i `recipients_count`/`signed_count` (separata fält) → signers kan sluta utan att vänta på reviewers (parallellt flöde)

**Completion-logik (uppdaterad 2026-06-26):**
- Process flaggas som klar (`parent.status="Approved"`) ENDAST när **alla signers signat OCH alla reviewers granskat** (om `reviewers_count > 0`)
- Bekräftelsemail (`approval_signed`) skickas batchat till **samtliga inblandade** (signers + reviewers) vid completion — INTE per signer-action
- Centralhanteras av `_checkAndCompleteRequest(requestId)` som anropas efter varje signer-`/confirm` och reviewer-`/review`
- Idempotent — hoppar över om parent redan = Approved (skydd mot dubbla mail)
- Reviewers länkas till första signers `signed_document` i mailet (samma originals, alla får juridiskt slutdok)
- Mail-template `approval_signed` är nu role-aware (samma slug, anpassar copy: "din signering"/"din granskning")

**Manuella påminnelser:**
- Ny route `POST /admin/approval/remind/:request_id` (x-admin-token) — köar `approval_reminder`-mail till alla barn där signers saknar `approved_at` eller reviewers saknar `reviewed_at`
- "Skicka påminnelse"-knapp i expand-detail i både arkiv-vyn och Deal-popupens historik (visas bara om någon är pending)
- Returnerar `{sent: N}` så UI kan visa "Skickade N påminnelser"

**Nya env vars (Render):**
| Namn | Värde |
|---|---|
| `APPROVAL_REVIEW_INVITE_TEMPLATE_ID` | Bubble unique_id för EmailTemplate slug=approval_review_invite |
| `APPROVAL_REMINDER_TEMPLATE_ID` | Bubble unique_id för EmailTemplate slug=approval_reminder |

**Nya Bubble-fält:**
- OfferApproval: `role` (text/option), `reviewed_at` (date)
- OfferApprovalRequest: `reviewers_count` (number), `reviewed_count` (number)

**Nya EmailTemplate-rader:** `approval_review_invite`, `approval_reminder`

---

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
