# Besökshantering (Vasakronan)

> Domänfil för besökshanteringsmodulen. Status: **UNDER BYGGE** (2026-08-26).
> ✅ **GO från Vasakronan via Frida 2026-08-26.** Finansiering hanteras av Christian parallellt.
>
> **Klart och verifierat skarpt:** auth + receptionist-session (steg A, §7.5).
> **Nästa:** besöksloggen (steg B, §8).
>
> **Kundunderlag (mockup, 7 vyer):** https://claude.ai/code/artifact/4bf9f49d-9c80-4f31-b0d3-924968b05609
> Källa i repot: `prototypes/besok-mockup.html`. Används mot kund vecka 36.

---

## 0.1 ⚠️ SCOPE ÄNDRAT — växel 1 OCH 2 byggs tillsammans

Vasakronan vill ha **både bemannad incheckning och självincheckning** direkt. Motivet är
driftmässigt, inte tekniskt: receptionisten tar emot personligen när det finns tid, gästen
checkar in själv när det är tryck i repan. **Två lägen av samma tjänst**, inte en reserv.

Det gör den tidigare växel-1/växel-2-uppdelningen (§2) **obsolet som leveransplan** — den
står kvar nedan som historik. Båda delar besökslogg, notismotor och kontaktlista, så att
dela upp dem hade kostat mer än det sparat.

**Beslutat i samma veva:**
- **Mail OCH SMS** ingår från start (inte SMS som senare tillval).
- **Varje ansluten hyresgäst får företagskonto + minst ett User-konto** i Mira.
- **Kunden äger sin egen kontaktlista** — laddar upp och redigerar den själv i en ny modul
  i `dashboard_company`, vid sidan om övriga kundmoduler.
- **Service & People blir ett eget block** (Service Academy, värdskapsutbildning) — besökets
  *administration* kan bo där, men den dagliga driften ligger i besöksmodulen.

---

## 0. Kontext

Förfrågan från **Vasakronan** (vår viktigaste kund) via **Frida Svedemar, Head of
Concierge**: kan Carotte hantera **besökssystem från servicehubbarna till
hyresgästerna** i bl.a. Hötorgsskraporna + ytterligare 5–6 hus. Skala: **hundratals
hyresgästbolag, tusentals medarbetare.** Dagens lösning = receptionen **ringer** vid
besök → ohanterbart i volym. Referens Frida nämnde: **Simply** (padda där besökaren
självregistrerar, används på bl.a. Agda).

Strategisk spänning: enorm utrullnings-acceleration (hundratals hyresgäster in i
Miras datamodell) MEN fokusförlust + omarbetning av höstplanen. Slutsats: **säg ja,
men bygg i växlar och lova bara växel 1 nu.**

---

## 1. Den korrigerade modellen (kärninsikten)

**Receptionisten är app-användaren. Värden är BARA notis-mottagare.**

- **Carotte-receptionist** i servicehubben = **Mira-app-användare** (finns redan, har
  push, hela workflow-väven, betald WU). Här bor funktionen + de WU-tunga stegen.
- **Värd** (hyresgäst-anställd som tar emot besök) = **endast mottagare**. Ingen app,
  inga vyer, inga beställningsrättigheter. Får bara notisen.

**⚠️ VARFÖR (Christians uttryckliga gräns, 2026-08-25):** vi vill INTE dra in
hyresgästernas medarbetare i appen. Inga slutkunds-vyer är byggda, vi vill inte att de
lägger ärenden/beställningar hejvilt, och **varje push + Notis + email kostar WU**. Att
jaga app-installationer multiplicerar största rörliga kostnaden mot noll betalning.
→ Den tidigare "app-distributionskil"-idén är **förkastad**. Se [[reference-bubble-wu-full-sweeps]].

### Notis-trappan (i prioritet)
1. **Push** — bara Carotte-personal (finns, WU redan betald).
2. **Mail till värd** — default, ~gratis, cross-org (går genom vår mailmotor, inte
   deras mailserver → ingen integration), ingen app. Mager gren: **ett**
   `email_queue_create` per ankomst, **ingen** push, **ingen** Notis-post för värden.
3. **SMS till värd** — prissatt premium-fallback när mail-latensen inte räcker
   ("reception, jag står här nu"). Se §4.

---

## 2. Växlar (grader av ambition)

| Växel | Innehåll | Tid |
|---|---|---|
| **1 — "Ringandet digitaliserat"** ← börja här | Receptionist-vy: registrera besök (hus→hyresgäst→värd→besökare), mager notis (mail/SMS), sökbar besökslogg per hus/hyresgäst. Ingen kiosk. | ~2–3 v |
| **2 — Riktig besökshantering** (om Vasakronan committar) | Förregistrering (värd förbokar → bekräftelse-QR), **självincheckning i lobbyn** (padda, motsvarar Simply), SMS-notis, per-hyresgäst-admin, GDPR-gallring | 4–8 v |
| **3 — Plattform** | Multi-tenant, Vasakronan-brandad, passer-/access-integration, utrymningslistor, analys | 3–6 mån |

Samma kod som växer — **förutsatt att växel 1 skrivs mot rätt datamodell**, inte en
kastbar besöks-silo. Det är så utrullnings-vinsten realiseras.

---

## 3. Återbruk (vad som redan finns i Mira)

| Behov | Finns idag | Not |
|---|---|---|
| Hyresvärd → fastigheter → hyresgäster | `Hyresvärd.Hyresgäster`, `ClientCompany.Fastighet` (List), Fastighet-typ | Vasakronan = Hyresvärd, husen = Fastighet, hyresgäster = ClientCompany. Se [[project-foretagslista-kundkort]] |
| Kontor + rum per hyresgäst | `Office`/`Kontor` + `_createDefaultRooms` | — |
| Värd/mottagare | `Coworker`/`User` per ClientCompany | `Coworker.Telefon` = number (SMS), se [[reference-user-profil-skrivnycklar]] |
| Incheckningsflöde + ankomstlista | `mira-deltagarhantering.html`, `/checkin/auth\|list\|toggle`, "anländ"-toggle | ~80 % av en besöks-MVP; iPad-vänligt |
| Aggregerad receptionist-vy | `mira-drift.html` (stå-alone, sök/filter/paginering, `.dr`-namnrymd) | **exakt mönstret att klona** |
| Mail till värd | `emailer.js` + SendGrid + `email_queue_create`-workflow | Bara e-post; SMS saknas → §4 |
| Notis-fabrik (Bubble) | `notify_associated_users_*` (Step: push→Notis→email_queue på lista) | Använd BARA den magra grenen för värd (mail), inte trippeln |
| Reception säljs redan | "Besökshantering & passerkort" i receptions-erbjudandet; `Besökshantering_funktion`-fält på förfrågan | Produktnarrativet finns |

---

## 4. SMS-gateway (beslut)

- **Leverantör: 46elks** — rekommendation låst 2026-08-26. Svenskt bolag (Stockholm),
  svensk faktura och support, **personuppgifterna stannar i EU**. Alfanumerisk avsändare
  "Carotte" fungerar direkt i Sverige utan registreringsprocess. API:et är en `fetch` med
  basic auth — ingen SDK, passar `emailer.js`-mönstret rakt av. Styckpris SE **~0,35 kr**.
- **⚠️ GDPR är det avgörande argumentet, inte priset.** SMS:et innehåller besökarens
  för- och efternamn samt var hen befinner sig → personuppgifter till tredjepart. En
  svensk/EU-leverantör gör personuppgiftsbiträdesavtalet trivialt. Twilio (US, ~0,55–0,60 kr)
  kräver hantering av tredjelandsöverföring för en tjänst som ändå är dyrare.
- **Bortvalt:** GatewayAPI (DK, ~0,25–0,30 kr) är billigare men skillnaden är ~0,07 kr/SMS
  ≈ 440 kr/mån i hög-scenariot — inte värt sämre supportnärhet. Sinch/LINK är rätt först
  vid **> ~50 000 SMS/mån**, då förhandlat pris slår allt annat. Twilio: nej.
- **Bygge:** ~halvdag. `sendSms({to, text})`-helper bredvid `sendViaSendGrid()` i
  `emailer.js` — `fetch` + basic auth, ingen SDK, env-vars för credentials.
  Alfanumerisk avsändare = enkelriktat (en ankomstnotis behöver inget svar).
- **⚠️ Håll SMS:et kort + emoji-fritt** → 160 tecken/segment (svenska å/ä/ö ligger i
  GSM-7-basen). Emoji tvingar 70 tecken → dubbel kostnad.
- **SMS är prissatt pass-through, inte default.** Markup ~1,00–1,50 kr/SMS mot
  Vasakronan. Fakturerad-innan-du-betalar-gatewayen → ren pass-through-risk.
- **⚠️ Kräver:** värdens mobilnr i katalogen (`Coworker.Telefon`) + dedupe/rate-limit
  (feltryckande receptionist) + GDPR-gallring (mobilnr = personuppgift).

---

## 5. WU-disciplin (rörlig kostnad)

**Designa WU-medvetet från rad ett** (samma lärdom som företagslistan —
[[reference-bubble-wu-full-sweeps]]):
- Mottagarnotis = **en** köad mail, aldrig fan-out på en User-lista.
- Ankomstloggen = **per-request-sök med constraints + paginering**, inget helsvep.
- **Ingen** Notis-post per besökare, **ingen** push till främlingar.

**Ankare:** ert baslager ≈ **~500 000 WU/mån** (härlett ur det borttagna
setInterval-svepet: ~13 000 WU/dygn = 78 % av idle-golvet).

---

## 6. Kostnadskalkyl (planering — antaganden öppna)

### Engång (bygga fas 1)
| Arbetspaket | Timmar |
|---|---|
| Bubble-schema (Besök-typ + fält, host-katalog-koppling) | 4–6 |
| Backend: create/list/sök/detalj/markera-anländ (companies_api-mönster) | 16–24 |
| Notis-gren: mail (återbruk) + SMS-helper + dedupe/rate-limit | 8–12 |
| Receptionist-block (klona `mira-drift.html`) | 20–28 |
| Host-katalog (admin per hyresgäst) | 8–12 |
| Smoke-svit (mutationstestad) | 8–12 |
| GDPR-gallringsjobb (TTL-mönster) | 3–5 |
| Deploy + pilot-härdning | 8–12 |
| **Summa** | **~75–110 h (mid ~90 h)** = ~2–3 v |

Kronsiffra (illustration, ~900 kr/dev-h): ~68–99k kr engång. Exkl. växel 2 (kiosk).

### Löpande (21 arbetsdagar/mån)
| Scenario | Besök/dag | SMS-andel | SMS-kostn./mån | WU/mån | WU-andel baslager |
|---|---|---|---|---|---|
| Konservativ | 150 | 40 % | 441 kr | ~31 500 | +6 % |
| Mid | 300 | 50 % | 1 103 kr | ~63 000 | +13 % |
| Hög | 500 | 60 % | 2 205 kr | ~157 500 | +31 % |

- **SMS** = pass-through med lätt markup, inte vinstmotorn.
- **WU** i kr är liten (~0,004 kr/WU antaget — **kalibrera mot faktisk Bubble-mätning**).
  Det viktiga: hög-scenariot lägger +31 % på baslagret → kan knuffa upp en Bubble-tier.

### Prisgolv mot Vasakronan
Amortera bygget (~90k) / 12 mån / ~8 hus ≈ **~940 kr/hus/mån** bara för bygget. +löpande
+marginal → **tjänsteavgift 2 000–4 000 kr/hus/mån täcker allt med god marginal**, SMS
faktureras separat (1–1,50 kr/st). Vid 8 hus ≈ 190–380k kr/år i tjänsteintäkt utöver SMS.

---

## 7. Öppna frågor / beslut som väntar

- **Vasakronan-åtagande** i proportion till fokusförlusten (antal hus, hyresgäster,
  tidslinje, vilka hyresgäster som tvingas in). Växel 1 = god vilja; växel 2/3 = beställning.
- **Roadmap-rebaselining:** vad pausas i höst? Kandidater att offra före kärnaffären:
  Drift Fas 2/3, Template/PDF Fas 5, Caspeco (redan Q1-27). **Rör inte** sync-kärnan/
  avtalsmotorn. Se [[project-mira-omtag]], [[project-tjanstegrid-prishjarna]].
- **Kalibrera kalkylen:** faktiska besöksvolymer/dag/hus (fråga Vasakronan), antal hus
  (antog 8), SMS-andel (antog 40–60 %), WU/besök (mät i pilot).
- **⚠️ Verifiera i Bubble innan löfte** (ej på minne — kolla skarpt):
  - `Coworker.Telefon` faktiskt satt/underhållbart per hyresgäst för SMS.
  - Bygg-vs-köp: vad kostar/kan Simply — vår edge = besök i SAMMA plattform som redan
    kör deras reception/drift/tjänster (vallgraven mot punktprodukt).

---

## 7.5 AUTH + SCOPE-MODELL — LÅST 2026-08-26

### 7.5.1 Beslut
**Receptionisten är en riktig Mira-användare med begränsad behörighet — inte en kiosk.**
Skälet: hon ska utöver besök även hantera **ärenden** och **boka åt kunder**. En delad
kod à la `kitchen_auth` (en scope, en yta) räcker då inte. Det tidigare "alternativ A"
för receptionisten är **förkastat**.

**Lobbyskärmen** är däremot fortsatt opersonlig → enhetstoken enligt `kitchen_auth`-mönstret.
⚠️ Den är **inte** låst till ett hus: en servicehub servar flera fastigheter (Sergelstan
= flera Hötorgsskrapor), så även kioskens token bär en fastighets-LISTA.

### 7.5.2 Datamodell (verifierad mot Bubble-editorn 2026-08-26, skärmbilder)

**`User_role`** (option set) — befintliga värden: `Ansvarig` · `Medarbetare` · `Konsult` ·
`Ansvarig konsult`. Christian: värdena är i praktiken obsoleta → **lägg till `Receptionist`
här** i stället för ett separat yes/no-fält. En sanning om vad en användare är.
- ⚠️ **`dashboard_crm` har en page-load-guard på `User_role is empty`.** Den måste ändras:
  `User_role = Receptionist` → redirect till `/visitor`, annars kommer receptionister in i CRM:et.

**`User.receptionist_fastigheter`** (List of Fastighet) — NYTT fält. Receptionistens scope.

**Kundlistan LAGRAS INTE — den härleds.** ⚠️ Kanonisk väg:
```
ClientCompany.Fastighet contains <fastighet_id>
```
**Verifierat i kod:** `companies_api.js:285` (`fastighet` = reflist på ClientCompany) och
`:1360`. **`Fastighet.Hyresgäster` (List of ClientCompany) finns i schemat men skrivs
ALDRIG av vår kod** — den kan vara tom eller stale. Scopar man via den blir kundlistan
tyst fel. Använd den inte. (`Hyresvärd.Hyresgäster` skrivs däremot, `:1897`, men är
hyresvärdens kundlista — en annan sak.)

**`Cluster`** (verifierad typ): `Titel` · `Fastighet` (List of Fastighets) · `Hyresvärd` ·
`Kontor` · `Leverantör` · `Address` · `Description` · `Image`.
→ Använd som **UI-genväg vid tilldelning** ("lägg till alla fastigheter i Sergelstan"),
men **rulla ut till fastigheter** i `receptionist_fastigheter`. Lagrar man klustret får en
ny fastighet i klustret automatiskt access — explicit lista är säkrare och lättare att resonera om.

### 7.5.3 Sessionsflöde — ✅ LIVE OCH VERIFIERAT 2026-08-26

**Skarpt testat:** testanvändare med `User_role = Receptionist` + 2 fastigheter loggar in,
stannar på `/visitor`, och får `Visitor_token` + `Visitor_token_exp` (12h fram) skrivna på
sin User. Hela kedjan Bubble → Render → Bubble fungerar.

**Bubble-sidan (byggd av Christian):**
1. **API Connector** `Mira Render` → call `visitor_session` (Action, POST,
   `{HOST}/visitor/session`). Header `x-visitor-secret` = **Private**. Body:
   `{"user_id": "<user_id>"}`. "Include errors in response" ikryssad.
   - ⚠️ **`exp_iso` måste sättas till typ `date`** i *Returned values* — Bubble lär sig
     den som text vid initialisering, och text går inte i ett date-fält. `exp` (number)
     lämnas orörd; den används av blocket, inte av Bubble.
   - ⚠️ Med "Include errors" lindas svaret → uttrycken heter **`Result of step 1's body's …`**.
2. **Backend workflow `visitor_session`** — *ej* exponerad, **inga parametrar**.
   - Step 1: `Mira Render - visitor_session` med `user_id = Current User's unique id`.
     ⚠️ Ingen user-parameter: uttrycket utvärderas server-side och kan inte manipuleras.
   - Step 2: `Make changes to Current User` →
     `visitor_token = …body's token`, `visitor_token_exp = …body's exp_iso`.
     **Only when `…body's token is not empty`** (inte `ok is yes` — vid HTTP-fel hamnar
     svaret i `error`-grenen och `body's ok` finns då inte).
   - **Inget steg som nollställer token vid fel** — en tillfällig Render-hicka får inte
     slå ut en fungerande session mitt i ett arbetspass.
3. **`/visitor` Page is loaded:**
   - Step 1 (FÖRST): `Go to page index` **Only when** `User_role is not Receptionist`
     **AND** `admin_crm is not yes`.
     ⚠️ **AND, aldrig OR.** Med OR kastas varje receptionist som inte också är admin ut —
     sidan går då aldrig att öppna. Använd `is not yes` framför `is no`: ett tomt yes/no
     är varken, och `is no` släpper då in den som saknar värde.
   - Step 2: `Schedule API Workflow visitor_session` **Only when**
     `visitor_token is empty` **or** `visitor_token_exp < Current date/time`
     → självförnyande, och ingen onödig WU vid varje sidladdning.
4. **User-fält:** `visitor_token` (text), `visitor_token_exp` (date),
   `receptionist_fastigheter` (List of Fastighet), `User_role = Receptionist`.

⚠️ **Timing:** `Schedule API Workflow` är asynkron — sidan renderar innan token finns.
Blocket måste vänta in fältet (Bubble uppdaterar det reaktivt, ~1 s) och visa ett
"startar session"-läge under tiden. Det är inte ett fel.

### 7.5.3b Ursprunglig skiss (historik)

Problemet: Render har ingen session mot Bubble, och `data-mira="current_user"` i ett
HTML-block kan användaren ändra till någon annans id. `PLANNING_ADMIN_TOKEN` får aldrig
ligga i `/visitor` (syns i sidkällan → hela admin-API:et).

```
1. Receptionist loggar in i Bubble (vanlig auth)
2. Page-load-guard: User_role = Receptionist  →  /visitor
3. /visitor-blocket triggar Bubble backend-wf `visitor_session`
4. Bubble-wf (SERVER-side, känner Current User) → POST Render /visitor/session
   header: x-visitor-secret: <VISITOR_SESSION_SECRET>     ← lämnar aldrig serversidan
   body:   { user_id: Current User's unique id }
5. Render: verifiera secret (timing-safe) → bubbleGet User →
   kräv User_role == "Receptionist" → läs receptionist_fastigheter →
   minta HMAC-token { scope:"visitor", uid, fast:[...], exp }
6. Token → blocket → localStorage, skickas som x-visitor-token
```
Browsern ser bara den mintade, scopade, tidsbegränsade tokenen. Bubble garanterar
identiteten eftersom workflowen kör server-side som Current User.

### 7.5.4 Scope-enforcement (regler som INTE får brytas)
- **Egen guard** för visitor-routes — koppla ALDRIG in `_visitorAuth.authed` i
  `planningAuthed` för andra moduler. (Jfr `_kitchenAuth`, som korrekt bara injiceras i
  `registerProduktionRoutes`, index.js:20817 — companies_api får ren `_planningAuthed`.)
- **Lita aldrig på fastighet/kund-id från klienten.** Alltid skärningen mot tokenens lista.
  Begärt hus utanför scope → 403, inte tom lista (tyst tomt döljer buggar).
- **En modul i taget.** Besök först. Ärenden och bokning släpps in först när scopet är
  bevisat skarpt — varje ny modul måste göras scope-medveten (drift-listan får inte visa
  alla kunders ärenden, bokningen inte alla kunders rum).

## 8. Nästa steg — bygget

⚠️ **Bryt ut till egen session.** Detta är ett eget spår med egen domänfil; blanda det inte
med företagslista/personer (regeln i HANDOFF.md §"SÅ HÄR JOBBAR VI").

**Innan en rad kod skrivs — verifiera i Bubble (gissa aldrig, jfr `Org_Number`/Fastighet):**
1. Finns någon befintlig besöks-/gästtyp? (`/checkin/*` + invite-modulen använder redan en
   gästmodell — återanvänd eller pensionera medvetet, skapa inte en tredje.)
2. `Fastighet`-typens fält (namnet ligger i **`Titel`**, `Adress` är ett geo-OBJEKT).
3. `Hyresvärd.Hyresgäster` ↔ `ClientCompany.Fastighet` — vilken riktning som faktiskt är ifylld
   för Vasakronans bestånd. Utan den kopplingen kan lobbyskärmen inte begränsa sökningen till huset.
4. `Coworker.Telefon` = **number** (inte text) — SMS-mottagare. `User.Phone_user` = text.
   Se [[reference-user-profil-skrivnycklar]].

**Byggordning:**
- **A. Auth-fundamentet — ✅ KLART, DEPLOYAT OCH VERIFIERAT SKARPT 2026-08-26.**
  - **`visitor_auth.js`** (NY) — HMAC-signerad, scopad session. Speglar `kitchen_auth.js`
    men `authed()` returnerar **payloaden** (anroparen behöver fastighetslistan), och det
    finns ingen delad kod. Scope-hjälpare: `hasFastighet()`, `resolveScope()`.
    ⚠️ **Tom fastighetslista = INGEN åtkomst, aldrig "alla".** Testat explicit.
  - **`POST /visitor/session`** (index.js, bredvid köks-loginen) — ✅ **LIVE**, se §7.5.3. Bubble-wf → Render.
    Verifierar `x-visitor-secret` (timing-safe) → `bubbleGet User` → kräver
    `User_role == "Receptionist"` → läser `receptionist_fastigheter` → mintar token.
    Nekar med **403 `no_fastigheter_assigned`** hellre än att minta en tom session.
  - **`/visitor` tillagt i `openPrefixes`** — annars kräver den globala x-api-key-middlewaren
    en nyckel som receptionistblocket aldrig kan bära.
  - **Env som måste sättas på Render: `VISITOR_SESSION_SECRET`.** Utan den svarar
    endpointen **503**, aldrig tyst genomsläpp.
  - **Verifierat:** `visitor_auth_smoke.mjs` **24/24**, **mutationstestat** — 5 mutationer,
    alla faller: (1) tom lista = "alla" → 1, (2) `resolveScope` släpper främmande hus → 1,
    (3) scope-kontroll borttagen → 1, (4) HMAC-verifiering överhoppad → 2,
    (5) okonfigurerad secret släpper igenom → 1. Regression: **24 sviter gröna**.

  **⚠️ KVAR I BUBBLE innan A fungerar skarpt (Christian):**
  1. Lägg **`Receptionist`** i option set `User_role`.
  2. Nytt fält **`User.receptionist_fastigheter`** (List of Fastighet).
  3. **Ändra page-load-guarden i `dashboard_crm`:** `User_role = Receptionist` → redirect
     till `/visitor`. Idag gate:ar den bara på "User_role is empty" → receptionister
     hamnar annars i CRM:et.
  4. Bygg backend-wf **`visitor_session`**: anropar `POST {HOST}/visitor/session` med
     header `x-visitor-secret` + body `{user_id: Current User's unique id}`, returnerar
     token till blocket. ⚠️ Hemligheten får ALDRIG exponeras i ett HTML-block.
- **B. Datamodell + besökslogg — ✅ BYGGT 2026-08-26 (EJ DEPLOYAT, Bubble-typ saknas).**

  **⚠️ Ny typ `Visit` — INTE återbruk av `InviteGuest`.** Den senare är *evenemangsbunden*
  (`guest.invitation == Invitation`, se `/checkin/toggle` i index.js) och används av
  RSVP/deltagarlistor. Ett besök hör till fastighet + hyresgäst + värd; att tvinga in det
  i en Invitation hade krävt en fejkad inbjudan per besök. Verifierat i kod, inte antaget.

  **Bubble-typ `Visit` — Christian måste skapa (fältnamn = `VISIT`-konstanten i visitor_api.js):**
  | Fält | Typ | Not |
  |---|---|---|
  | `fastighet` | Fastighet | **scope-nyckeln** |
  | `hyresgast` | ClientCompany | |
  | `vard` | Coworker | valfri |
  | `vard_namn` | text | fallback när värden inte är Coworker |
  | `besokare_namn` | text | **personuppgift → GDPR-gallring** |
  | `besokare_bolag` | text | |
  | `incheckad_at` / `utcheckad_at` | date | |
  | `via` | text | `reception` \| `lobby` |
  | `registrerad_av` | User | tom vid självincheckning |
  | `registrerad_av_namn` | text | signering (§7.5) |
  | `notis_kanal` / `notis_status` / `notis_fel` | text | `vantar` \| `skickad` \| `fel` |
  | `notis_at` | date | |

  ⚠️ **text, inte option sets** på `via`/`notis_*`. Vi kontrollerar värdena i koden, och
  slipper option-set-fällan (felstavning ger tyst 400 — [[reference-bubble-option-sets]]).

  **Endpoints (`visitor_api.js`, egen gate — INTE `planningAuthed`):**
  - `GET /visitor/context` — mina fastigheter + härledda hyresgäster + användarens namn
  - `GET /visitor/hosts?hyresgast=` — värdar + **kanaltillgänglighet** (`has_sms`/`has_mail`)
    så receptionisten ser direkt om personen går att nå
  - `GET /visitor/visits?fastighet=&datum=&q=&open=1` — dagens besök, scopat
  - `POST /visitor/visits` — registrera (reception eller lobby)
  - `POST /visitor/visits/:id/checkout` — idempotent

  **Scope-regler som INTE får brytas (alla mutationstestade):**
  - Hyresgäst utanför scope → **403**, aldrig tom lista.
  - Hyresgästen måste ligga i **den angivna fastigheten**, inte bara i mitt scope —
    annars hamnar besöket i fel hus och fel receptionists lista.
  - Utcheckning kollar besökets fastighet mot tokenen — annars kan ett gissat id
    checkas ut i andras hus.
  - `Fastighet`-namnet läses från **`Titel`**, med adressen som textfallback
    (`Adress` är ett geo-OBJEKT → annars "[object Object]").

  **WU:** hyresgästlistan per fastighet TTL-cachas (10 min). Bubble saknar OR → en fråga
  per fastighet; med 2–6 hus per receptionist är det bundet.

  **Notisen skickas INTE av create-routen** (egen route, steg C). Ett notisfel får aldrig
  hindra att besöket loggas — gästen står ju faktiskt i lobbyn.

  **Verifierat:** `visitor_api_smoke.mjs` **35/35**, **mutationstestat** — 7 mutationer,
  alla faller: (1) hosts utan scope-koll → kontaktuppgifter läcker, (2) hyresgäst-i-fastighet
  borttagen → 4 tester, (3) checkout utan scope-koll, (4) Fastighet-namn via `Namn`
  (gamla [object Object]-buggen) → 2, (5) listan utan scope-filter → 2, (6) TTL-cachen av,
  (7) lobby-incheckning signerad som person.
- **C. Notismotorn — ✅ BYGGT 2026-08-26 (EJ DEPLOYAT).**

  **`sms.js` (NY, egen fil — INTE i `emailer.js`).** Avsteg från den ursprungliga planen:
  `emailer.js` är 85k och stod under aktiv ombyggnad (mail_theme) → merge-konflikt. SMS är
  dessutom en egen kanal med egen felmodell och blir testbar isolerat, som `visitor_auth.js`.
  - `makeSms({username, password, from})` → 46elks. Env: **`ELKS_USERNAME`**,
    **`ELKS_PASSWORD`**, valfri `SMS_FROM` (default "Carotte", kapas till 11 tecken).
  - **`send()` KASTAR ALDRIG** — returnerar `{ok:false, error}`. En trasig gateway får inte
    välta besöksregistreringen.
  - **`smsSegments(text)`** — kostnadskontroll. ⚠️ Svenska å/ä/ö är gratis (GSM-7), men
    **EN emoji tvingar hela meddelandet till UCS-2 med 70 tecken/segment = dubbel kostnad**.
    Mallen är emoji-fri och testas mot 1 segment.
  - **`toE164()`** — ⚠️ `Coworker.Telefon` är ett **number**-fält, så inledande nolla är
    borta (`0701785977` → `701785977`). Utan normaliseringen går SMS:et till fel land.

  **`POST /visitor/visits/:id/notify`** — egen route, **medvetet skild från create**.
  Ett notisfel får aldrig hindra att besöket loggas; gästen står i lobbyn oavsett.
  - Kanalval: **SMS om värden har mobil, annars mail.** Kanalerna läses FÄRSKT ur
    `Coworker` — besöksraden bär ingen kopia som kan bli inaktuell.
  - **Dedupe:** redan `skickad` → `already:true` utan omsändning (varje SMS kostar, och
    värden ska inte spammas av en feltryckande receptionist). `{force:true}` skickar om.
  - **Ingen kontaktväg** → `422` + `notis_status="fel"` + orsak i `notis_fel`. Aldrig tystnad.
  - **Gatewayfel** → **HTTP 200** med `ok:false, status:"fel"`. Besöket ÄR registrerat;
    receptionisten ska se felet i listan och kunna trycka om, inte få ett rött API-fel.
  - **Okonfigurerad gateway** → `503`, aldrig tyst "skickat".

  **Verifierat:** `sms_smoke.mjs` **29/29** + `visitor_api_smoke.mjs` **46/46**.
  **Mutationstestat (11 totalt på visitor_api):** utöver B:s sju — (8) dedupe borttagen → 2,
  (9) gatewayfel skrivs som "skickad", (10) okonfigurerad gateway ger tyst OK,
  (11) notis utan scope-koll. Alla faller.
- **D. Receptionist-vyn — ✅ BYGGT 2026-08-26 (EJ DEPLOYAT).** `mira-visitor.html`
  (`.vi`-namnrymd), klistras på Bubble-sidan **`visitor`**.
  - **Bär ALDRIG `PLANNING_ADMIN_TOKEN`.** Enda credential är `x-visitor-token` som Bubble
    skriver till `Current User's visitor_token`. `data-mira`: `api_host` + `visitor_token`.
  - **Väntar in sessionen.** Backend-wf:en är asynkron → blocket startar utan token och
    pollar fältet (400 ms, ger upp efter 25 s med en begriplig instruktion). Visar
    "Startar session…" under tiden. Det är förväntat, inte ett fel.
  - Dagens besök + husväljare + sök + registreringsformulär + Notifiera/Notifiera igen +
    Checka ut. Notisen är ett **eget anrop efter** create — misslyckas den är besöket ändå loggat.
  - **Kanalen visas INNAN incheckning:** värdlistan skriver ut "— SMS" / "— endast mail" /
    "— ingen kontaktväg" per person, och vid val visas en pill ("Endast mail — kan dröja").
    Receptionisten ska veta om värden går att nå innan hon lovar gästen något.
  - `!important` på knapparnas hover ([[reference-bubble-button-hover-important]]).

  **⚠️ TVÅ BUGGAR SOM BARA HARNESSEN KUNDE FÅNGA** (smoke-testerna var gröna hela tiden):
  1. **Hyresgästlistan filtrerade på fel hus.** Formuläret visade "Hötorget 3" men listade
     bolag från alla hus, eftersom den filtrerade på *listfiltret* (tomt = alla) i stället
     för formulärets eget val. Receptionisten hade fått `403 tenant_not_in_fastighet` på en
     kombination UI:t själv erbjöd. → Eget `STATE.formHus`, skilt från `STATE.fastighet`.
  2. **`loadHosts()` anropade `render()` → formuläret tömdes.** Skriver receptionisten
     gästens namn och väljer hyresgäst sedan, raderades namnet. Samma fälla som
     deal-formuläret och autocompleten i personlistan. → `paintHosts()` uppdaterar bara
     värd-selecten **in-place**; `STATE.formHyresgast` överlever en verklig omritning.

  **Harness-verifierat i webbläsare:** lista, husväljare, hela registreringsflödet
  (hus → hyresgäst → värd → kanalindikator → spara → notis), utcheckning (knappen försvinner,
  "ut 15:23" visas), och att fälten överlever i rätt ordning.
- **E. Lobbyskärmen** (kioskläge, egen begränsad yta, sök scopad till huset).
- **F. Kundens kontaktlista** i `dashboard_company`.
- **G. CRM-vyn** + GDPR-gallringsjobb.

**Öppet mot Vasakronan (från mockupens frågelista):** pilothus + tidpunkt · besöksvolym per hus
· hur hyresgästerna introduceras · vem som äger surfplattorna i lobbyn · gallringstid · passerkort
(rekommenderat utanför scope).
