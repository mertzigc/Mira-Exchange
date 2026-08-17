# HANDOFF — Mira-Exchange sync-omtag

> Senast uppdaterad 2026-08-14. Läs detta + `ARKITEKTUR_OCH_OMTAG.md` (§1–9) för full kontext.
> Syfte: ny session ska kunna ta vid exakt här. Djupdesign finns i ARKITEKTUR_OCH_OMTAG.md.
>
> ⭐ **AKTIVT SPÅR (2026-08-13→): Företagslista + Kundkort-omtag** — se §0k nedan + minnet `project-foretagslista-kundkort.md`. Allt LIVE, testat, grönt.
> ⚠️ **Offert/Affär/Avtal-modulen** lever i `OFFERT_PRODUKTION_HANDOFF.md` (⭐ STATUS överst) + minnet `project-offert-produktion-fe.md`. Denna sync-doc är fortsatt referens för faktura/order/workorder-synken. Relevant där: §9d workorder→FortnoxOrder(connection=TENGELLA), §4 connection-IDs, Fortnox-auth (`fortnoxGetBinary` global client_secret), Bubble-gotchas.

---

## 0k. FÖRETAGSLISTA + KUNDKORT + DRIFT (render-omtag av Bubble-native företagsvyn) — byggt 2026-08-13→16

**Mål:** ersätta Bubbles native företagslista + expanderat kundkort (+ Drift-modul) med render-baserade HTML-block (samma DI-mönster som affär/sälj/produktion). Ingen Bubble-popup/workflow för kortet — allt är vy-växling i samma block. **Deploy-läge blandat:** Christian deployar per feature (git→Render + klistrar om HTML-block). De flesta sektioner nedan är "ej deployat" när de skrevs men Christian har deployat kontinuerligt — fråga vid osäkerhet vad som är live.

### Filer
- **`companies_api.js`** (NY, ~70k) — hela backend-modulen (`registerCompaniesRoutes(app, deps)`). Alla endpoints x-admin-token-grindade (utom `reset-password/exchange` som är token-grindad publik).
- **`mira-foretag-lista.html`** (NY, ~90k) — Bubble-blocket för lista + kort + ALLA flikar (inkl Drift-fliken). `.fl`/`.fk`-namnrymd, BROOT-claim, SWR, INGEN `?.`/`??`. data-mira: `api_host` + `planning_token` + `user_company` (Leverantörer/personal) + `user_name` (Drift-kommentarer).
- **`mira-drift.html`** (NY, ~14k) — stå-alone Drift-modul (aggregerat över alla kunder + sök/filter). `.dr`-namnrymd. data-mira: `api_host` + `planning_token` + `user_name`. Återanvänder detalj-endpoints.
- **`companies_smoke.mjs`** — 176/176 gröna. **`cc_cache_smoke.mjs`** (NY) — 26/26, testar den delade CC-cachen i index.js genom att klippa ut blocket ur källkoden och räkna Bubble-sidhämtningar (se WU-städningen). `index.js` — wiring + delade cachar + Bubble-wf-callers + openPrefixes (`/admin/companies`, `/admin/drift`, `/admin/reset-password`). `emailer.js` — mallar `password_reset` + `user_welcome`.

### Backend-arkitektur (companies_api.js)
- **Delade cachar (index.js):** `sharedCompanyFullMap` (CC-list-projektion ur EN 55-sidorsladdning) + `sharedCompanyRevenueMapWarm` (FortnoxInvoice.ft_net/år, **lat** — ingen boot-prewarm, WU-medveten). Listan gör NOLL Bubble-anrop (allt ur cacharna); bara PATCH/skapa skriver.
- **Lista:** `GET /admin/companies/list` (filter/sök/sort/paginering + meta) · `GET /admin/companies/meta` · `PATCH /admin/companies/:id` (inline-edit, option-set validerad mot facetter). `revenue_ready`-flagga → frontend visar "beräknar omsättning…" + auto-omhämtning.
- **Kort:** `GET /admin/companies/:id/card` (kunddata + KPI + counts per flik) · `GET /admin/companies/:id/chain?type=deals|leads|offerter|ordrar|fakturor|avtal|signeringar` (reverse-lookup per typ) · `GET /admin/companies/:id/coworkers` (+offices+departments) · `GET /admin/companies/coworker/:id/activities`.
- **Skapa/redigera:** `POST /admin/companies/:id/coworker/create` · `PATCH /admin/companies/coworker/:id` (CO_EDITABLE) · `POST /admin/companies/coworker/:id/create-account` (Bubble-wf + välkomstmail).
- **Lösenord/onboarding (eget token-flöde via vår SendGrid-motor):** `POST /admin/companies/coworker/:id/send-password` · `POST /admin/reset-password/send {email}` (nya users) · `POST /admin/reset-password/exchange {token}` (reset_pw-sidan). `__INIT__`-läge för API Connector-init utan sidoeffekt.

### Företagsfält per typ (VERIFIERAT — kritiskt vid reverse-lookup)
deal=`kundföretag` · Lead=`client_company` · Mira Offert/MiraOrder=`kundforetag` · Fortnox(FortnoxOffer/Order/Invoice)=`linked_company` · Contract=`kundföretag` · OfferApprovalRequest(signering)=`clientcompany` · **activitet_crm=`company`** (ClientCompany — ENDA kund-fältet; INGET clientcompany finns! Schema-verifierat 2026-08-14, se [[reference-activitet-crm-company-fields]]) + `taggade_personer`(List of Coworker, tagg — FINNS nu) + `writer`/`mötesanteckning_writer`(User) · Coworker→företag=`Kundföretag`, has_user=User vars **`Company`**(singular)==företaget matchar coworker-mail · Office→företag=`Kundföretag`.

### Kortets flikar — status
Hem ✅ (kunddata läs/redigera + KPI + snabbåtgärder: "+ Ny aktivitet"→Historik-flik+form, "+ Ny kontakt"→Personer-flik+form) · Personer ✅ (lista m. avatarer + skapa person + skapa konto + person-detalj m. **Profilfoto**[upload/byt/ta bort] + Profil-redigering[Förnamn/Efternamn/Titel/Email/Telefon/crm_info/Avdelning/Kontor] + Aktivitet-flik) · Historik ✅ (activity_crm-feed för hela företaget, timeline) · Deals/Leads/Offerter/Ordrar/Fakturor ✅ (reverse-lookup) · Avtal ✅ (Abonnemang+Signeringar, READ) · **Drift ✅ (Fas 1 LÄS)** (ärenden+kvalitetskontroller för kunden, se nedan) · **Inställningar 🚧** (setup-hub: **Kontor ✅** [lista+skapa m. auto-rum+redigera+rum-hantering] · **Logo ✅** [ClientCompany.logotyp upload/byt/ta bort] · **Leverantörer ✅** [dotterbolag + Carotte-personal, add/remove] · Fastighetsägare ✅ (knyt hyresgäst→Hyresvärd.Hyresgäster) · Medarbetarportal ⏳; Avtal skippas — egen lista).

### Inställningar → Logo + Leverantörer — KLAR + verifierat 2026-08-16 (ej deployat)
- **Logo:** `POST /admin/companies/:id/logo` (multipart `file`, `clear=1`; original-fil, behåller transparens) → `ClientCompany.logotyp`. Frontend `logoBody` (Logo-subtab): förhandsvisning + Ladda upp/Byt/Ta bort. Kort-headern speglar direkt (`STATE.card.company.logotyp`).
- **Leverantörer — kopplingar bekräftade via native RG-filter (skärmdump):** (1) **Dotterbolag** = `Leverantör - Supplier` där `Kundföretag`(List of ClientCompany) contains företaget → add/remove = patcha **leverantörens** Kundföretag-lista. (2) **Personal** = `User` där `Associated_company`(List of ClientCompany) contains företaget → add/remove = patcha **Userns** Associated_company (styr notiser). Pool för personal-dropdown = Users vars `Company` == inloggad Carotte-users company → skickas som `?user_company=` (nytt `data-mira="user_company"`-hidden-input, bind Current User's Company i Bubble).
- **Backend:** `GET /admin/companies/:id/leverantorer?user_company=` (suppliers+available+personnel+personnel_available) · `POST .../leverantor {supplier_id}` · `DELETE .../leverantor/:sid` · `POST .../personal {user_id}` · `DELETE .../personal/:uid`. Frontend `leverantorerBody`/`levSection` (2 sektioner, dropdown-add + Ta bort), `fetchLeverantorer`/`addLev`/`delLev`, STATE.setupLev.
- Verifierat: smoke (logo set/clear/404 + suppliers add/remove + personal add/remove via Associated_company + pool via Company==user_company) + harness (Logo upload→header uppdaterad; dotterbolag+personal add/remove). Deploy: index.js oförändrad; companies_api.js + klistra om mira-foretag-lista.html + **bind data-mira user_company** i Bubble.
- **Fastighetsägare:** knyt företaget som hyresgäst till en/flera **`Hyresvärd`** via dess `Hyresgäster`(List of ClientCompany)-lista (samma mönster som dotterbolag). `GET/POST /admin/companies/:id/fastighetsagare` + `DELETE .../:hid`. Frontend återanvänder `levSection`("landlord") via generaliserad `LEV_EP`-map (supplier/staff/landlord → path/key/state). Kund-nivå-notiser: styr t.ex. vilka erbjudanden som visas för en fastighetsägares hyresgäster.
- **Logo i kort-huvudet:** rektangulär logga visas i full bredd (vit pill, `.fk-herologo` fast höjd 56px + auto bredd, `object-fit:contain`) uppe till HÖGER; initial-ruta som fallback när logga saknas.

### Inställningar → Kontor (Office) — KLAR + verifierat 2026-08-15 (ej deployat)
Underflikar (`STATE.setupSub`): Kontor · Leverantörer · Logo · Fastighetsägare · Medarbetarportal (Avtal skippat). Kontor byggd; övriga = placeholder.
- **Office-schema (verifierat 2026-08-15):** `Office_title`(text), `Kundföretag`(ClientCompany), `Fastighet`(ref), **`Kontorsansvarig`(List of Coworker)**, `office_address`(geo), **`Yta`(number)**, `Arbetsplatser`(number), `Budget`(number), `Mötesrum`(List of MeetingRoom), `intern_lokal`(List of Internal_local), + Kontrollobjekt/Kvalitetskontroll/Nyckel/Konsult/leverantör/Medarbetare/Department/Status_kontor/plan_översikt(image)/hemsida/Grundat_år/Närvaro/Ärende.
- **Backend (`companies_api.js`):** `GET /admin/companies/:id/offices` (rader + dropdown-data fastigheter+coworkers) · `POST /admin/companies/:id/office/create` (Office + **auto-rumsuppsättning**) · `PATCH /admin/companies/office/:id`. `_officeWrite`-mappning; `nOffice`-normaliserare. **Auto-rum (`_createDefaultRooms`):** vid nytt kontor skapas 1 `MeetingRoom` (Name/office/Company) + 8 `Internal_local` (Namn/kontor/kundföretag): Toaletter, Kopieringsutrymme/Förråd, Pentry, Reception/Lounge, Korridor, Dusch, Städförråd, Kontorsrum — behövs för kvalitetskontroller; rummen appendas även till Office-listorna. Adress (geo) hanteras EJ än (läs-only). Kontorsansvarig = single-select i UI (skrivs som List med en) — kan bli multi senare.
- **Frontend (`mira-foretag-lista.html`):** `installningarBody` (subtab-bar) → `kontorBody` (kontors-tiles: namn/fastighet/adress · ansvarig · yta · arbetsplatser · rum-antal + Redigera) + `officeForm` (skapa/redigera, `.fk-owrap` 1080px). `fetchOffices`/`createOffice`/`saveOffice`. STATE: setupSub/offices/officeMeta/officeNew/officeEdit (nollas i openCard).
- **Kontor 1b — rum-hantering (KLAR 2026-08-15):** i redigera-vyn två sektioner (Mötesrum + Interna lokaler). `GET /admin/companies/office/:id/rooms` · `POST /admin/companies/office/:id/room {type:meeting|internal, name}` (skapa + append till Office-lista) · `DELETE /admin/companies/office/:oid/room/:rid?type=` (radera + ta bort ur Office-lista). `bubbleDelete` tillagd i companies-wiringen (index.js). Frontend: `roomsSection`/`roomList` (fk-rooms 2-kol) + fetchOfficeRooms/addRoom/delRoom, STATE.officeRooms. Rum-antal i tile uppdateras optimistiskt.
- **⚠️ RUMS-TYPNAMN = `Internal_room` (INTE `Internal_local`!) — fix 2026-08-15 efter deploy.** App data + Bubble-wf visar att den LIVE-aktiva typen native skapar (och Office.intern_lokal pekar på) heter **`Internal_room`**; Data-types-editorn visade "Internal_local" (stale/legacy). Fel typnamn → 0 träffar → interna lokaler visades tomma. Fix: `Internal_room` överallt (create/get/find). **Fält på Internal_room:** `Namn`(text), `kontor`(Office), `kundföretag`(ClientCompany), `Lokaltyp`(OS — Christian sätter den native tills vidare, vi avvaktar). MeetingRoom var rätt. `_officeRooms(office, oid)` hämtar via BÅDA vägar (per-id ur Office-listan `Mötesrum`/`intern_lokal` + ref-query `office`/`kontor`) union+dedup — robust oavsett hur rummet kopplades.
- Verifierat: smoke 128/128 (rooms union list-väg[i2 utan ref]+ref-väg[i1] + create/DELETE + 404/felfall) + harness. Deploy: index.js (bubbleDelete-wiring) + companies_api.js + klistra om mira-foretag-lista.html.

### Historik-fliken (activity_crm för hela företaget) — expanderbar + redigerbar + skapa ny — KLAR + verifierat 2026-08-14 (ej deployat)
Historik = `activitet_crm` där **`company==id`** via `_companyActivityRows(id)` (hoistad; används av BÅDE chain-historik OCH card `counts.historik`) → `nActivity(r, um)` (`um`=user-map för `ansvarig` via writer/Created By; full edit-prefill: beskrivning/motesanteckning/motesdatum_iso/created/genomfort). **⚠️ FÄLTET ÄR `company` (ClientCompany), INTE clientcompany** — som inte finns på typen (schema-verifierat 2026-08-14). Tidig version constraintade fel fält → Sveriges Läkarförbund visade tomt trots historik i native. Frontend: `historikBody`-timeline-feed (`.fk-feed`); **klick på rad → expanderar** (STATE.histOpen) → detaljgrid (`.fk-hmetagrid`: typ/fas/mötesdatum/registrerad/ansvarig/status) + mötesanteckning + inline **redigera**-form. **"+ Ny historik"** (STATE.histNew) → skapa-form. Kundmöte-typen visar villkorliga fält via `.fk-konly`/`.fk-notewrap`-DOM-toggle (change-listener, ingen re-render mitt i edit). Egen gren i `cardBody` (ej CHAIN_TABS). Innehållet kapas till läsbar kolumn (`.fk-hwrap` max 900px, vänsterjust) så text/form ej sprids över hela bredden.
- **Skriv-endpoints (lånade affär-mönstret, affar_api.js):** `POST /admin/companies/:id/historik/create` (sätter `company=id`) + `POST /admin/companies/historik/:id/patch`. Delad `_aktWrite`-mappning, SKRIVNYCKLAR=display-namn: `activity_type`/`beskrivning`/`Kundmöte`(fas)/`Datum_bokning`/`genomfört`/`mötesantecking`. Option-set: AKT_TYPES (Säljsamtal/Kommentar/Kundmöte/…) + AKT_FASER (Fas 1–4/Övrigt). `bubbleCreate`/`bubblePatch` redan wire:ade.
- Verifierat: smoke 106/106 (chain historik company-fältet + rätt företag-filtrering + create/patch + 400/404) + harness (expandera→detalj+form, redigera→spara→rad uppdateras, skapa→ny rad överst+badge++). Deploy: companies_api.js + klistra om mira-foretag-lista.html (index.js oförändrad).

### Profilfoto (Coworker.Foto) — KLAR + verifierat 2026-08-14 (ej deployat)
`POST /admin/companies/coworker/:id/photo` (multipart, fält `file`; rensa m. `clear=1`) → laddar upp till Bubble file storage via `bubbleUploadFile` → sätter `Coworker.Foto` (image-fält = URL-sträng). Coworkers-GET returnerar `foto` (https-normaliserat). Frontend: `.fk-avatar` (rund) i person-huvud + personlista; foto-rad i Profil (Ladda upp/Byt/Ta bort). Klienten komprimerar bilden client-side (canvas, max 512px, jpeg 0.82) → FormData. **Deps tillagda i wiringen:** `bubbleUploadFile` + `photoUpload: _approvalUpload` (multer memory 25MB). **Ingen Bubble-schemaändring** (Foto-fältet finns). Verifierat: smoke 96/96 + browser-harness (avatar i lista/profil, upload→img, ta bort→initialer). Deploy: index.js + companies_api.js (Render) + klistra om mira-foretag-lista.html.

### Drift-fliken (Fas 1 = LÄS) på kundkortet — KLAR + verifierat 2026-08-16 (ej deployat)
Ärenden (`Matter`) + kvalitetskontroller (`QualityControl`), båda `Kundföretag`(ClientCompany)==kunden. Undertabbar: **Ärenden** (status-pill Pågående/Avslutad) · **Avvikelser** (Avvikelse=yes) · **Kvalitetskontroller**. `counts.drift` = öppna (Pågående) ärenden.
- **Ärende:** `Rubrik`/`Beskrivning`/`Bild`/`Kontor`(Office)/`Referens`(User)/`Prioritet`(OS)/`status`(Status Ärende, "Pågående"=öppen)/`Avvikelse`(yes/no)/`Team åtgärd intern`(Coworkers)/`Team åtgärd extern`(Konsult)/`Tråd`(List text)/`Feedback`/`Förbättring`. Detalj: beskrivning+bild, meta, team-namn, tråd, uppföljning.
- **QC:** varje yta = en **`Kommentar - Comment`** (typnamn m. mellanslag+bindestreck!) där `kvalitetskontroll`==QC, m. `Intern_lokal`(Internal_room)/`Mötesrum`(MeetingRoom)-ref, `Betyg`(→`Grade`), `Bild`, `Beskrivning`. **Snittbetyg = medel av `Grade.Värde` där `kvalitetskontroll`==QC.** QC-fält: `Avtal`(Contract Housekeeping)/`Kontor`/`kontrolldatum`/`Kontrollant`(User)/`Leverantör`/`Kundreferens`(Coworkers)/arbetskläder/servicekort/städförråd/`Meddelande`/betyg_client/feedback_client.
- **Backend (`companies_api.js`):** `GET /admin/companies/:id/matters` · `GET /admin/companies/matter/:id` · `GET /admin/companies/:id/qc` · `GET /admin/companies/qc/:id`. Ref-namn resolvas via `_officeNameMap`/`_contractNameMap`/`_supplierNameMap`/`_roomNameMap`/`_users`/`_companyCoworkerMap`. counts.drift via `bubbleCount Matter [Kundföretag,status=Pågående]`.
- **Frontend (`mira-foretag-lista.html`):** `driftBody`(subtabs)→`matterListBody`/`qcListBody` + `matterDetailBody`/`qcDetailBody`(`.fk-qgrid`-ytkort). fetch: matters/qc/matterDetail/qcDetail. STATE driftSub/matters/qcList/matterOpen/matterDetail/qcOpen/qcDetail.
- Verifierat: smoke 152/152 + harness. 

### Drift stå-alone (Fas 4) — eget block `mira-drift.html` — KLAR + verifierat 2026-08-16 (ej deployat)
Aggregerar ärenden + kvalitetskontroller över ALLA kunder m. sök/filter/paginering; detalj återanvänder samma endpoints som kortet.
- **Backend:** `GET /admin/drift/list?type=matters|qc&scope=open|closed|avvikelser&q=&company=&prio=&page=&limit=`. Per-request Bubble-sök m. constraints (scope-default Pågående → WU-bundet). Företagsnamn via delad `companyFullMap`, kontor via `_officeNamesByIds`(bubbleGet sidans Kontor-ids), övriga namn via befintliga mappar. `q`=Rubrik/Titel text-contains; `company`=företagsnamn→id-set (in-memory filter). Prefix `/admin/drift` tillagt i openPrefixes (index.js). Detalj: `/admin/companies/matter/:id` + `/qc/:id` (företags-agnostiska).
- **Frontend (`mira-drift.html`, NYTT block):** `.dr`-namnrymd, egen CSS (kopierar kortets Drift-look). Flikar Pågående/Avslutade/Avvikelser/Kvalitetskontroller + sök-rubrik + sök-företag + prioritet-facet + paginering. Lista m. Företag-kolumn + samma detalj-vyer (ärende + QC). SWR ej nödvändig (per-request).
- Verifierat: smoke 159/159 (drift/list open/closed/avvikelser + rubrik-sök[text contains] + företagsfilter + qc + facet) + harness (aggregerad lista över EA/Planhat/Scania, sök, QC-flik, båda detaljvyerna). Deploy: index.js (openPrefix) + companies_api.js + **nytt Bubble-block `mira-drift.html`** på Drift-sidan (data-mira api_host+planning_token).
### Drift Fas 2 (delvis): status + kommentera + tråd-datumtvätt — KLAR + verifierat 2026-08-16 (ej deployat, BÅDA blocken)
- **Status-uppdatering:** `POST /admin/companies/matter/:id/status {status}` (sätter status + closed_date vid ≠Pågående). Status-dropdown-värden hämtas ur datan via `_matterStatuses()` (cachad `bubbleFind` första-sida → distinkta `status`-värden → `status_options` i matter-detaljsvaret; INGEN OS-gissning). Status-pill visar nu **faktiska statusvärdet** (färg efter open/closed) — inte bara Pågående/Avslutad — så mellanstatusar (t.ex. Pausad) visas rätt.
- **Kommentera:** `POST /admin/companies/matter/:id/comment {text, author}` → appendar rad till `Matter.Tråd` (List of texts) m. `author · <ren stämpel>: text`. Author = `data-mira="user_name"` (bind Current User's namn i Bubble; fallback "Carotte").
- **Tråd-datumtvätt:** matter-detaljen kör `_cleanTrad` → hanterar **två native-format**: (A) namn-först `"Namn, Bolag, YYMMDD,HH:MM: text"` → YYMMDD-token blir "D mmm YYYY · HH:MM" inline; (B) datum-först m. snedstreck `"YY/MM/DD, HH:MM:SS / Namn: text"` → reparsas HELT till uniform `"Namn · D mmm YYYY · HH:MM: text"`. Nya kommentarer stämplas i Europe/Stockholm-tid (`_nowStampSV`). Kommentar-inputen (`.fk-roomadd input`) fick mörk tema-styling (var ostylad/vit).
- Frontend: status-select+Ändra + kommentera-fält i matter-detaljen i **både** `mira-foretag-lista.html` (Drift-fliken) och `mira-drift.html` (stå-alone). Nytt `data-mira="user_name"` i båda blocken.
- Verifierat: smoke 165/165 (status set+closed_date, comment append+ren stämpel, tråd-tvätt 260810→"10 aug 2026 · 09:15", status_options ur datan, 400/404) + harness (status→Pausad visas i pill, kommentera→ny rad, tråd unison). Deploy: companies_api.js + klistra om BÅDA blocken + bind data-mira user_name.
- **Kvar Drift: Fas 2 forts. (skapa ärende + ärendekategorier + team) · Fas 3 (QC SKRIV).**

### ⚠️ WU-STÄDNING 2026-08-17 (P0–P2) — idle-golvet halverat, deploy-straffet borta
**Symptom:** Bubble-WU gick från ~1,5–3,5k/dygn (idle, juli) till 26–49k/dygn — även på helger då bara Christian var igång. Diagnos ur App Metrics → Workload by activity + timgrafen:
- **16 aug (söndag):** 34 891 WU totalt, varav `Data: clientcompany` **23 474 WU (68,8 %) på 14 221 runs ≈ 1,65 WU per 100-radssida.** Timgrafen visade ett platt **idle-golv ~700 WU/h** som INTE fanns i juli.
- **Roten:** `setInterval(_loadSharedCC, 10 min)` (införd 13 aug i commit `7cdd28a` "snabbare laddning") svepte hela ClientCompany (5413 poster = 55 sidor) **144 ggr/dygn dygnet runt** = ~7 900 sidhämtningar ≈ **13 000 WU/dygn = 78 % av idle-golvet**, oavsett om någon var inloggad.
- **Varför extra när Christian jobbade:** (1) varje Render-deploy startar om processen → **boot-prewarm = nytt 55-sidorssvep** (+ intervallklockan nollställdes → fler än 6 svep/h vid täta deploys); (2) `/admin/planning/companies` och `/admin/clientcompany/all` gjorde **egna helsvep per anrop** (~89 WU per sidladdning).

**Fixar:**
- **P0 (`index.js`):** `setInterval` BORTTAGEN. `CC_SHARED_TTL` 15→**60 min**, nytt `CC_FULL_TTL` **12 h**, `CC_DELTA_MARGIN` 5 min. SWR räcker (stale serveras direkt, refresh i bg). **Lägg ALDRIG tillbaka en setInterval på ett helsvep** — blockkommentaren ovanför cachen dokumenterar fällan.
- **P0c delta-refresh (`index.js`):** helsvep bara vid boot + var `CC_FULL_TTL` (enda sättet att se **raderade** poster). Däremellan `bubbleFindAll ClientCompany [Modified Date > senast sedda − marginal]` → **1 sida i st.f. 55**. `_ccApply` skriver in poster, `_ccBumpMod` flyttar fönstret — **bara från riktiga svep, aldrig från `sharedCompanyPatchEntry`** (annars kan våra egna PATCH:ar hoppa förbi externa native-ändringar). Delta-fel → fallback till helsvep (aldrig tyst gammal kunddata).
- **P0b (`index.js`):** `/admin/planning/companies` + `/admin/clientcompany/all` läser nu `sharedCompanyMap()` → **noll** Bubble-anrop. OBS: namn kommer ur `Name_company || name` (de gamla fallbacken `Name`/`company_name`/`Företagsnamn` m.fl. var döda — listan renderar redan på samma två fält).
- **P1 (`companies_api.js`):** `AUX_TTL` 5→**60 min** (`_users()` är ett HELSVEP av User — flera tusen rader — och anropas av drift-list/matter-detalj/historik/QC; färskhetskritiska frågor som `has_user` kör egna constraintade queries). Nya cachade `_allSuppliers()` (delas av `_suppliers` + `_supplierNameMap` — sveptes förut TVÅ ggr per anrop) och `_allLandlords()`. **`/admin/drift/list`:** filtrera/sortera/paginera på **rådatan**, resolva kontorsnamn först för sidan som faktiskt returneras (dolt N+1: gamla koden gjorde **91 `bubbleGet` för att rendera 40 rader**). QC-sökningen går nu ner som Bubble-constraint `Titel text contains` i st.f. helsvep + filter i minnet. Prioritet-facetten räknas fortfarande på HELA träffmängden (`raw`), inte sidan.
- **P2 (`emailer.js`):** `error_message is_empty` BORTTAGEN ur pollerns query — `is_empty` kan inte indexeras → heltabellsskanning av emailqueue **720 ggr/dygn**. Nu bara indexerbart `email_sent=false` + bortsortering i minnet, med bounded framåtbläddring (3 sidor × 60) så kön inte fastnar bakom gamla failade rader.

**Verifierat:** `companies_smoke.mjs` **176/176** (33 nya rader: paginering/total/pages, facet över hela mängden, N+1-mätning via `getCalls`, QC-constraint via `findAllCalls`, prio-filter, QC-företagsfilter). **Mutationstest:** med gamla `companies_api.js` faller exakt de två WU-testerna (`91 bubbleGet` + saknad Titel-constraint) → testerna bevisar fixen, inte bara att koden kör. Nytt fristående `cc_cache_smoke.mjs`-mönster (26/26) klipper ut cache-blocket ur `index.js` och **räknar sidhämtningar** (kall=helsvep, varm=0 anrop, stale=1 delta-sida, `CC_FULL_TTL`→helsvep som rensar raderade, delta-fel→fallback, in-flight-dedup, regressionsvakt mot setInterval). Browser-harness körde **riktiga** routes bakom `mira-drift.html`: 92 ärenden → sida 1/2/3, facetten visade `1 - låg` trots att raden låg på sida 3, **131 Office-`bubbleGet` totalt = exakt en per visad rad** (gamla: ~91 per sidladdning), QC-flik + sök + ärendedetalj intakta.

**P3 + P4 (gjorda 2026-08-17, Christians beslut) — de två gamla punkterna från WU-fällorna nedan:**
- **P3 — Sales-KPI-megascanen: `SALES_TTL` 4h → 24h** (`index.js` ~10829). `computeSalesKpi` sveper **hela FortnoxInvoice** (~10k rader inkl `ft_raw_json`, ~100+ sidhämtningar, 20–60 s). Med 4h TTL kunde den gå upp till **6 ggr/dygn** så fort någon öppnade dashboard/portal dagtid — nu max 1. KPI:t är ett årsvärde som inte rör sig inom ett dygn. Färska siffror vid behov: `POST /kpi/sales/flush` eller `?force=1`. Cachen är lat (ingen prewarm). **Kvarstående nackdel:** första anropet efter att TTL:n gått ut blockerar 20–60 s — samma som idag, bara mer sällan. Vill man bort från det helt: gör `fetchSalesKpi` stale-while-revalidate (servera stale + refresh i bg), som CC-cachen.
- **P4 — `MODIFIED_DAYS_BACK` default 3 → 2** (`sync_v2_cron.sh`, både `CUST_DAYS` rad 39 och nightly `DB` rad 212 + doc-raden). Cronen kör nattligt → 2 dygn ger fortfarande ett dygns överlapp om en körning missas. ⚠️ **Om `MODIFIED_DAYS_BACK` är satt som env i Render vinner den över defaulten — kolla/ta bort den där.** (Rör INTE `fortnox_cron_v1.sh` som har sin egen `MODIFIED_DAYS_BACK` default 30 för saldo-svepet — annan sak.)

**Förväntad effekt:** idle-golv ~700 → ~150 WU/h; CC-cachen ~13 000 → ≤200 WU/dygn; Sales-KPI från upp till 6 → 1 helsvep av FortnoxInvoice per dygn. **Deploy:** `index.js` + `companies_api.js` + `emailer.js` + `sync_v2_cron.sh` (bara Render — inga HTML-block ändrade, inget att klistra om). Följ upp i App Metrics: golvet på lugna timmar ska falla direkt efter deploy.

### Onboarding/lösenord (LIVE, funkar från start till mål)
Nyckelknapp/skapa-konto → vår endpoint skapar token (PasswordReset-typ) + mailar länk (SendGrid: `password_reset`-mall vid reset, `user_welcome`-mall m. USP-sektioner vid ny user) → reset_pw-sidan: **API Connector → exchange** (byter token mot engångs-temp via Bubble-wf `assign_temp_password`) → **Log the user in** + **Update password** (valt lösenord). Ny user: Bubble-wf `create_user_account` (Create an account for someone else + sätt Company/Coworker/namn). **Render kan EJ skapa User el. sätta valfritt lösenord via Data API → allt sådant via Bubble-wf** (auth ägs av Bubble).

### Bubble-delar (byggda av Christian, LIVE): typer `PasswordReset`{email,coworker,token_hash,expires_at,used} · wf `assign_temp_password`(email→temp) · wf `create_user_account`(email/password/firstname/surname/company/coworker_id→user_id) · API Connector-calls (exchange/send/create) · reset_pw-sidan. **Env (Render):** `PW_RESET_TEMPLATE_ID`, `WELCOME_TEMPLATE_ID`, `BUBBLE_ASSIGN_TEMP_WF=assign_temp_password`, `BUBBLE_CREATE_USER_WF=create_user_account`, `APP_BASE_URL=https://mira-fm.com`, `BUBBLE_PW_RESET_WF` (gammal, utgår).
### Status Ärende-OS (verifierat i bild 2026-08-16): **Pågående · Avslutat · Utkast**. Drift closed-flik = exakt `status=="Avslutat"` (Utkast hamnar i varken öppet/avslutat). counts.drift + open = "Pågående". Status-dropdown härleds ur datan (visar de som finns).
### KVAR ATT SKAPA I BUBBLE: **`taggade_personer` (List of Coworker) på activitet_crm** — Aktivitet-fliken hämtar mot det; tom lista tills fältet finns + aktiviteter taggas.

### Gotchas (nya i detta spår)
- **⚠️ ALDRIG `setInterval` på ett helsvep.** En bakgrundsloop som sveper en hel Bubble-typ kostar dygnet runt även när appen är tom. Bubble tar ~**1,65 WU per 100-radssida** → 5 400 rader = ~89 WU per svep. Var 10:e min = ~13k WU/dygn. Använd stale-while-revalidate (lat) + delta på `Modified Date`. Se WU-städningen 2026-08-17 ovan.
- **Deploy = boot-prewarm.** Varje Render-omstart kör om prewarm-svepen. Många deploys på en kväll ⇒ många helsvep. Håll prewarm billig.
- **`is_empty`/`is_not_empty` kan inte indexeras** av Bubble → heltabellsskanning. Aldrig i en återkommande poller (se `emailer.js`).
- **Namnresolvning ≠ gratis.** `_users()`/leverantörslistor är helsvep av hela typen. Cacha länge (60 min) och håll färskhetskritiska frågor i egna constraintade queries.
- **Global-grind:** nya `/admin/*`-endpoints MÅSTE i `openPrefixes` (index.js ~443) annars `Unauthorized (bad x-api-key)` FÖRE route-auth. Prefix `/admin/companies` + `/admin/reset-password` tillagda.
- **`fl-edit`-klass (display:inline-block) på `<td>` bryter tabell-layout** → egen `fl-ecell`. Aldrig inline-block på table-celler.
- **Lat-laddade underflikar:** `fetchChain` re-renderar bara om synlig → `chainVisible()` (direkt flik ELLER Avtal-underflik).
- **Return data from API (Bubble-wf):** Plain text funkade bäst; Render läser `r.text()` med JSON-fallback.
- Se även: [[reference-bubble-sort-drops-empty]], [[reference-bubble-option-sets]], yes/no→"ja".

**Djupdetaljer:** minnet `project-foretagslista-kundkort.md` (steg 1–7, alla beslut + verifieringar).

---

## 0i. Tjänste-grid PRISHJÄRNA (Fas 0–5) + order→lead→pris — LIVE & VERIFIERAT 2026-08-12

Session-mål: göra kund-dashboardens tjänste-grid smart/anpassad med **EN prissanning**, förenkla erbjudande-adminen, paketera för merförsäljning, och låta "Beställ" bli lead→avtal. Hela kedjan LIVE + verifierad på testkund CMIAB (Frukt/Växter beställda → Comission i planering + mail + Lead med pris). Detaljplan i minnet `project-tjanstegrid-prishjarna.md`.

**Arkitektur (single source of truth):** Erbjudande äger pris+innehåll, `pricing_engine.js` räknar, kundens **Office (`Yta`+`Arbetsplatser`)** anpassar. Samma motor (`window.MiraPricing`, `HOST/pricing_engine.js`) driver kalkylator, kund-grid, förfrågan-wizard och admin-preview.

**PRISLÅST: Vasakronan v10** (`~/Downloads/vasakronan-calculator-v10.html`) = kanoniska priser:
- Housekeeping (formel): `((kvm/avverk)×dagar/mån×322 + 1000 + 37×kvm/12) × 1,15`; avverk=200 (≤500 kvm) annars 220; dagar/mån 5→21, 4→16,8, 3→12,6, 2→8,4.
- Kaffe Jura Giga X8c 3190/st · Jura X10 1650/st · Vatten 1210/st · Växter kvm×14 · Frukt(korg) 115/arbetsplats · Skrivare 1950 · Entrématta 130 · Förbrukning kaffe/mjölk/te 330/aplats · Hygien 58/aplats · Förbrukningsmtrl 17/aplats · Reception 69990/79990 (behålls, ej i Vasakronan). Engångstjänster UT. Wording: **Arbetsplatser** (ej Medarbetare) överallt; drivar-id `arbetsplatser`.

**Ny/ändrad kod:**
- `pricing_engine.js`: regeltyp **`housekeeping`** (parametriserad Vasakronan-formel, verifierad exakt mot `calcHK`).
- `mira-kommunikation-admin.html` (Erbjudanden): förenklad **pris-typ-väljare** (5 typer → genererar `custom_form_json`+`pricing_formula_json`; dagens byggare flyttad till "Avancerat läge"); standardiserade drivar-id `yta`/`arbetsplatser`/`antal`/`dagar`; live-preview; **"Uppdatera priser"**-inline-lista (merge-upsert, bara priset).
- `index.js /services/dashboard`: `assumptions`{yta,arbetsplatser}=`SUM(offices)` matas in i `_servicesPriceOf` → anpassade priser; returnerar `assumptions`+`packages` (config `SERVICE_PACKAGES`, Fas 3).
- `mira-kund-dashboard-tjanster.html`: laddar `window.MiraPricing`; `adaptedUnitPrice` räknar per **VALT kontor**; aktiv tile visar **AVTALSPRIS** (`Contract.monthly_cost`), ej prelpris; paketkort (live per-kontor-pris + besparing, "Beställ paketet", ~480px bredd); skickar `office_id` + `contact_email/name`.
- `index.js /services/request-activation` (Fas 4): office-antaganden → förseglar SAMMA pris som grid:en; skapar **Comission** (`C_OFFICE`/`C_OFFER`/`C_PRICE_BREAKDOWN`) OCH **Lead** (`Source="Mira"`, `estimated_service_cost_monthly`=priset). Self-healing lead-create `_createLeadDroppingBadFields`.
- `affar_api.js` (`nLeadFull`) + `mira-affar-samlad.html`: lead-listan har **"Prel. värde"**-kolumn (`belopp`=`estimated_service_cost_monthly`).

**Bubble-gotchas (nya — viktiga för framtida spår):**
- **Erbjudande.Leverantör ≠ Comission.Leverantör** (olika Bubble-typer). `SUPPLIER_BY_CATEGORY`-id:na gäller Comission → gav "object does not exist" på Erbjudande. Lösning: sätt **ALDRIG auto-Leverantör på erbjudandet**; leverantör sätts på Comission via `_supplierIdForCategory` (dynamisk namn-uppslag mot typ `leverantör-supplier`, ersatte hårdkodade stale id:n i offers/upsert + request-activation + forfragan/create).
- **Category option set = "Service & People"** (INTE "Staff"). Admin-dropdown rättad.
- **lead_source option set:** giltiga = Formulär/Telefonsamtal/Email/Möte/**Mira**/info@carotte.se/Kalkylator/Internservice. Order-lead använder "Mira". `safeCreate` självläker EJ ogiltiga option-set-värden → `_createLeadDroppingBadFields` droppar fältet och kör om.
- **Rate-limiter delade EN IP-hink** över alla publika endpoints → dashboard-laddningar fyllde hinken → **tysta 429** på request-activation (visade sig som "Delvis skickat", tom logg). Lösning: `_publicRateLimited(ip, max, windowMs, bucket)` — separata hinkar (activation 120/h, dashboard 300/h) + logga 429.
- **Office.Yta + Office.Arbetsplatser** (båda number, redan API-exponerade) MÅSTE vara ifyllda per kontor, annars blir storleksbaserade priser 0 ("Ingår") i grid:en.

**Datakrav i Bubble:** Office.Yta+Arbetsplatser per kontor · Erbjudanden med `pricing_formula_json` (upplagda via nya adminen) · ServiceCatalog-slugs matchar paket-config (`housekeeping`/`kaffe`/`frukt`/`vaxter`) · hidden inputs `mira_user_email`/`mira_user_name` bundna (Current User) i dashboard-blocket.

**Deploy/workflow:** commit rakt på `main`; **push via GitHub Desktop** (inte terminalen — GitHub tog bort lösenords-auth och `gh`/PAT saknas lokalt; keychain-cred kan behöva rensas). Build-markör verifieras på `GET HOST/version` (senast `2026-08-12-lead-value-col`). Bubble-block (admin + kund-grid + affär-vy) MÅSTE re-pastas manuellt vid frontend-ändringar — Render deployar bara backend.

**KVAR/nästa:** paket-config → egen Bubble-typ (så personal styr paket/rabatt själv, som erbjudandena) · ev. Lead↔ClientCompany-**referens** för tightare affärsvy-koppling (idag textfält `Company`) · Housekeeping-frekvensval i grid · cross-sell-nudgar · "kunden saknar kontorsyta"-prompt · nicer paket-bekräftelse-UX.

---

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

## 0g. Tjänste-grid admin-modul + avtals-lifecycle — BYGGE PÅBÖRJAT 2026-06-28

Bygger den admin-modul som 0f föreslog, plus två större tilläggsfeatures:
PDF-import av befintliga avtal (LLM-parsning) och PDF-generering från
avtalsmall som auto-skickas in i OfferApproval-flödet. Beslut LÅSTA
2026-06-28 efter genomgång av Carotte-avtal i `Avtal från Carotte/`.

### Beslut (2026-06-28)
1. **Full scope, inte MVP.** Subscription + RateCard + Hybrid + F&E (offert-baserad).
2. **Contract-typen utökas** med ~17 nya fält + 3 nya Option Sets (se Fas 1 nedan).
3. **Bilagor som separata Dokument-rader** (Floor Plan, KPI/SLA, Onboarding…), list på Contract — redigerbara separat utan ny signering.
4. **F&E-tile är "aktiv"** om senaste FortnoxOrder.delivery_date ≤ 6 mån. Ingen Contract krävs för F&E (i nuläget — ändras när F&E-abonnemang lanseras).
5. **PDF-import** via Anthropic Haiku 4.5 + structured output (tool-use). Carotte granskar parsed JSON innan Contract skapas. Originalet sparas som `signed_pdf`.
6. **ContractTemplate** = ny Bubble-typ (Fas 5). Default-mallar extraheras från `Avtal från Carotte/` (EA HK-avtalet är 99% färdigt som template).
7. **Auto-Contract vid Approved** körs i `_checkAndCompleteRequest`, bara om `kontraktstyp=Subscription` och `auto_create_contract != no`. RateCard/Hybrid kräver manuell skapande (säkerhetsmarginal).

### Konceptuella avtalstyper (från avtalsgenomgång)
| Typ | Exempel | Pricing-modell | Auto-Contract? |
|---|---|---|---|
| **Subscription** | HK x EA (188 282/mån + Cleaning Index) | Fast månad + index | JA (auto vid signering) |
| **RateCard** | Staff x Scandic Bemanning | Roller × kr/h, OB-tillägg, ingen månad | NEJ (manuellt skapas) |
| **Hybrid** | T.ex. Reception med fast bas + tilläggsdebitering | Båda | Beroende på flagga |
| **One-off Offer** | F&E offerter idag | Per uppdrag, ingen subscription | NEJ (lever som Erbjudande + OfferApproval) |

### 5 faser (sekventiellt, varje testbar isolerat)

1. **Fundament — PÅGÅR.** Bubble-schema-utbyggnad (Christian), `_createContractsFromApprovalRequest`-hook i `_checkAndCompleteRequest` (Render), status-härledning i `_buildServicesDashboard`. 2-3 dgr kod, ½-1 dag Bubble-schema, ½ dag test.
2. **Admin-block.** Kundkort-flik "Abonnemang" + global "Alla abonnemang"-vy. Manuell create/edit/end + bilagor (List of Dokument). 3-5 dgr.
3. **RateCard + Hybrid + F&E.** Kontraktstyp-väljare i admin, RateCard-formulär, F&E-tile-logik (senaste FortnoxOrder.delivery_date ≤6 mån). 3-4 dgr.
4. **PDF-import + LLM-parsning.** Drag-drop befintligt avtal → `pdf-parse` → Anthropic Haiku 4.5 (structured tool-use) → review-form → Contract skapas direkt (skipping OfferApproval, det är redan signerat). 4-5 dgr.
5. **Template + PDF-generering.** Ny Bubble-typ `ContractTemplate` (version-aware). Bygg 3 default-mallar från befintliga avtal. Flöde: välj mall → fyll spec → HTML-preview → puppeteer-PDF → POST `/approval/create`. 5-7 dgr.

**Total:** ~17-24 kod-dagar + 3 dgr Bubble-schema + 6-9 dgr Carotte-test ≈ 4-6 veckor kalendertid.

### Fas 1 — Bubble-fält att skapa (Christian)

**Contract — utöka befintlig typ.** Lowercase + underscore för alla nya fält (befintliga `Kundföretag`/`erbjudande`/`Kontor`/`Månadskostnad`/`Slutdatum`/`Produktantal`/`kategori` lämnas orörda):

| Fält | Typ |
|---|---|
| `startdatum` | date |
| `contract_type` | option set `contract_type` |
| `binding_months` | number |
| `notice_months` | number |
| `auto_renew_months` | number |
| `price_regulation_type` | option set `price_regulation_type` |
| `price_regulation_next` | date |
| `rate_card_json` | text (long) |
| `volume_json` | text |
| `attachments` | List of Dokument |
| `signed_pdf` | file |
| `signed_at` | date |
| `offer_approval` | OfferApprovalRequest |
| `commission` | Comission |
| `master_contract` | Contract |
| `status_override` | option set `contract_status_override` |
| `parsed_confidence_json` | text |

**OfferApprovalRequest — utöka befintlig typ:**

| Fält | Typ |
|---|---|
| `contract_template_json` | text (long) |
| `auto_create_contract` | yes/no (default `yes`) |

**Nya Option Sets:**

1. `contract_type` — `Subscription`, `RateCard`, `Hybrid`
2. `price_regulation_type` — `index_cleaning`, `index_kpi`, `lon_kollektiv`, `fast`, `ingen`
3. `contract_status_override` — `Pausat`, `Tvistig`, `Vilande`

**Verifiera:** `curl "$HOST/services/dashboard?company_id=<någon-kund>&debug=1"` → kolla att de nya fältnamnen finns i `contracts_raw[].all_field_names`.

### Fas 1 — Render-kod (kodat 2026-06-28, ej deployat)

**Tillagt i `index.js`:**
- `SERVICES`-konstanten utökad med nya Contract-fält-namn (CT_START, CT_TYPE, CT_BINDING, …).
- `_deriveContractStatus(contract, now)` → returnerar `aktiv` / `utgar_snart` / `avslutad` / `pausat` / `vilande` / `tvistig`. 30-dagars-gräns för utgår_snart.
- `_createContractsFromApprovalRequest(parent)` → idempotent (skippar om Contract redan finns med `offer_approval == parent._id`). Läser `contract_template_json` array, hoppar över specs där `contract_type != Subscription` (manuella). Auto-Contract-skapande safety-valve via `parent.auto_create_contract != "no"`.
- Hookad i `_checkAndCompleteRequest` direkt efter `status=Approved`-patchen, före bekräftelsemail. Fel är non-fatal (loggar warning).
- `_buildServicesDashboard`s tile-entries fick `status`, `contract_id`, `contract_type` så framtida kund-block kan visa "Utgår 30 nov"-pill direkt utan extra fetch.

**Spec-formatet i `contract_template_json` (förväntat av auto-hook):**
```json
[
  {
    "service_slug": "housekeeping",
    "offer_id": "<Erbjudande _id>",
    "office_id": "<Office _id>",
    "contract_type": "Subscription",
    "monthly_cost": 188282,
    "qty": 1,
    "startdatum": "2025-12-01",
    "slutdatum": "2028-11-30",
    "binding_months": 36,
    "notice_months": 3,
    "auto_renew_months": null,
    "price_regulation_type": "index_cleaning",
    "price_regulation_next": "2026-06-01",
    "volume_json": {"kvm": 12600, "housekeepers": 7, "hours_mf": 25, "hours_sun": 4},
    "category": "Housekeeping",
    "commission_id": "<Comission _id, valfri>"
  }
]
```

RateCard/Hybrid-specs i samma array skapar inget auto — väntar på manuell granskning i admin-blocket (Fas 2-3).

### Öppna beslut Fas 1
- (sätts allteftersom)

### Pågående filer/datatyper
- `ServiceCatalog` (live, 0f)
- `Contract` (utökas Fas 1)
- `OfferApprovalRequest` (utökas Fas 1)
- `ContractTemplate` (ny — skapas Fas 5)
- `Office` (oförändrad)

---

## 0f. Tjänste-grid på kund-dashboard — LIVE 2026-06-28, admin-spår PLANERAS

**Vad finns idag (live):**
- Kund ser ett tjänste-grid överst på sin Mira-dashboard. Mira-abonnemang (account-scope) + facility-tiles (office-scope) per kontor.
- Aktiva tiles: grön border + grön "AKTIV"-pill. Inaktiva: "Förslag" + "Läs mer →".
- Klick → 3-kolumns popup (visuell / info / actions). Bildspel-thumbnails (Erbjudande.Bildspel) växlar hero-bild. Fakta-chips (Målgrupp/Logistik/Capacity). Sociala bevis + onboarding-block per katalogpost. Sekundär CTA "Prata med rådgivare först →" (mailto).
- Office-dropdown vid 2+ kontor (filtrerar tile-griden per Kontor). Mira-tilen visas oavsett valt kontor.
- "Aktivera" POST:ar till `/services/request-activation` som återanvänder samma kärna som `/admin/forfragan/create` (skapar Comission + notify-mail + iOS-push).

**Status:**

| Komponent | Status |
|---|---|
| `mira-kund-dashboard-tjanster.html` (live fetch + 3-kol popup + office-dropdown) | ✅ Live |
| Render endpoints `/services/dashboard` + `/services/request-activation` + `?debug=1` | ✅ Live, rate-limit 300/h |
| ServiceCatalog-datatyp i Bubble (slug/name/icon/icon_color/offers/has_qty/qty_*/rating/testimonial_*/onboarding_json/category/display_order) | ✅ Live, posterna för mira/reception/catering/housekeeping inlagda |
| Office-grouping (active_account vs active_by_office) | ✅ Live |
| Pricing från kvm × rate (kalkylator-modellen) | ⏳ Steg 2 — kräver `Arbetsplatser` (number) på Office + `pricing_formula_json` på Erbjudande |
| Admin-modul för Carotte (skapa/redigera abonnemang) | ⏳ Nästa spår — se "Nästa spår" nedan |
| Lifecycle-koppling: aktivera → lead/förfrågan → OfferApproval → Contract | ⏳ Nästa spår |

### Filer
- `mira-kund-dashboard-tjanster.html` — kund-facing block, embeddat överst på dashboard_company_utkast
- `index.js` — `SERVICES`-konstanten + `_buildServicesDashboard()` + GET/POST endpoints
- `pricing_engine.js` — återanvändbar formelmotor (samma som forfragan-wizard) för per_kvm/per_person/fixed/addon_per_unit

### Datamodell — Bubble-fältnamn (case-sensitive, verifierat via debug)

**ServiceCatalog**: `slug` (text, lowercase ASCII), `name`, `subtitle`, `category` (`platform`|`facility`), `display_order` (number), `icon` (list/sparkle/cup/droplet/user/leaf/printer/fruit), `icon_color` (hex), `image` (fallback), `offers` (List of Erbjudande), `has_qty` (yes/no), `qty_label`, `qty_min`, `qty_max`, `from_price`, `from_unit`, `rating` (0-5), `rating_count`, `testimonial_quote`, `testimonial_author`, `testimonial_role`, `onboarding_json` (JSON-array `[{week,title,desc},…]`).

**Erbjudande** (extra fält vi använder utöver forfragan): `Unit` (option set: mån/person/kg/timme/dygn), `Bildspel` (List of images), `Image`, `Description_long`, `Produktinnehåll`, `Villkor`, `Målgrupp`, `Logistik`, `Capacity`, `PrisPerPerson`, `pricing_formula_json`.

**Contract** (case-sensitive — verifierat 2026-06-25): `Kundföretag` (cap K), `erbjudande` (lower e — LÄTT att råka anta cap E), `Kontor` (cap K), `Produktantal`, `Månadskostnad`, `Slutdatum`, `kategori` (lower k). Bubble-editorn versaliserar visningsnamnet → kör `?debug=1` för att se all_field_names från API:t innan du mappar.

**Office**: `Office_title`, `Kundföretag`, `office_address` (object med .address), `KontorsID` (text "01"/"02"/…), `Yta` (TEXT idag — bör bli number), `Arbetsplatser` (saknas, behövs för pricing-steg 2).

### Endpoints (live)
- `GET /services/dashboard?company_id=X[&debug=1]` — returnerar `{catalog, offices, active_account, active_by_office}`. CORS-allowlist KUND_KPI_ALLOWED, rate-limit 300/h, `Cache-Control: no-store`. Debug-läge returnerar contracts + offices raw + all_field_names för felsökning.
- `POST /services/request-activation` — body `{company_id, service_slug, service_name, option_id, qty, category_hint}` → skapar Comission via samma fältmappning som /admin/forfragan/create. Notify-mail + iOS-push återanvänds.

### Nästa spår: admin-modul + lifecycle-koppling (PLANERAS)

**Mål från Christian (2026-06-28):**
> "Vi behöver kunna administrera kundernas generella abonnemang på vår egna dashboard-backend. När de klickar aktivera skapas en lead och förfrågan. Sen ska vi offerera på detta. Jag vill dels nyttja den nya offerapproval-motorn, dels koppla till ett påskrivet contract som sen visas som aktiverat hos kund och oss."

**Två nya HTML-block att bygga:**

1. **Kundkort-flik "Abonnemang"** (per kund) — visar valda kundens alla Contracts grupperade per Office. Popup för skapa/redigera/avsluta. Bäddas in i kundkortet (se screenshot 2026-06-28 — flikraden EA/Dice / Personer / Historik / Affärer / Leads / Offerter / Ordrar / Fakturor / Avtal / Drift / Planering / Inställningar).

2. **Global översikt "Alla abonnemang"** — alla Contracts oavsett kund, kolumnsorterbar + filter per kund/status/kategori/slutdatum-range. Popup för skapa/redigera. Egen sida i Carotte-backend.

**Lifecycle-flödet ska se ut så här (nytt):**

```
Kund klickar "Aktivera" på tile
   ↓
Comission skapas (redan implementerat)
   ↓ NYTT
Lead skapas och kopplas till Deal/Affär
   ↓ NYTT
Carotte-admin bygger offert (existerande Deal-flöde)
   ↓ NYTT
OfferApprovalRequest skickas till kund (existerande, sektion 0e)
   ↓ NYTT
Kund signerar via befintlig landningssida
   ↓ NYTT
Contract skapas automatiskt vid `status=Approved`:
   Contract.erbjudande = OfferApproval.dokument-relaterat erbjudande
   Contract.Kontor     = Comission.Office (eller fråga vid signering)
   Contract.Månadskostnad = från signerad offert
   Contract.Startdatum = signeringsdatum
   ↓
Kundens tile blir AKTIV (befintlig logik tar över)
   ↓
Carottes admin-vy visar Contract som live
```

**Datakopplingar som saknas idag:**
- `Comission.lead` (skapas redan i `/admin/forfragan/create`) → Deal (manuellt idag, kan auto-kopplas via `Comission.lead.Deal`?)
- `OfferApprovalRequest.deal` → Deal (finns)
- `OfferApprovalRequest.contract_to_create` → ServiceCatalog/Erbjudande (NYTT — så vi vet vilket Contract som ska skapas vid godkännande)
- `Contract.offer_approval` → OfferApprovalRequest (NYTT — bakåtspårning)

**Förslag på förbättringar att överväga i nästa session:**

*Dataeffektivitet:*
- Subscription-history: ny Contract per ändring (vs editing in-place) — för att kunna visa "ni hade Receptionist sedan 2024, Concierge sedan 2026" i kundens dashboard.
- Pris ska bara komma från ETT ställe: Erbjudande.pricing_formula_json räknar pris med kontorets Yta/Arbetsplatser som answers. När Contract skapas frys priset i `Månadskostnad`. Dashboarden visar Månadskostnad om aktiv, annars beräknat "från-pris" från katalog.
- Stoppa duplicering av kategori — använd Erbjudande.Category som single source. Contract.kategori kan tas bort eller härledas.

*UX:*
- Lifecycle-status-badge på Contracts: `förslag` → `förfrågan skickad` → `offert väntar` → `signerad` → `aktiv` → `utgår om X dagar` → `avslutad`.
- Renewal-flow: 90 dagar före Slutdatum → auto-mail till kund + uppgift hos Carotte.
- "Uppgradera"-flöde direkt i kundens popup: byt nivå (Receptionist → Concierge) → ny förfrågan med kategori "uppgradering".
- Audit-loggen: lägg till Comission/OfferApproval-trail på Contract så Carotte ser hela kedjan.

**Öppna frågor till nästa session:**
1. Ska Contract skapas automatiskt vid signering, eller manuellt av Carotte-admin för säkerhetsmarginal?
2. Hur hanteras "uppgradering" — nytt Contract som ersätter, eller patch på befintligt?
3. Var visas pågående förfrågningar/offerter i kundens dashboard — egen sektion under tiles, eller status-pill på inaktiva tiles ("Förfrågan skickad, väntar")?
4. Behöver vi `ContractTemplate` så Carotte kan skapa snabb-Contracts från ServiceCatalog utan fullt förfrågan-flöde? (för "vi tar bara fakturan, allt övrigt är klart")

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
