# Mira FM — Kommunikationsmodul & Undersökningar: Handoff

*Sammanfattning för att ta arbetet vidare i en ny session. Ladda upp eller klistra in detta som kontext.*

---

## 1. System & arkitektur (kort)

- **Backend:** Render Express-server "mira-exchange" (`https://mira-exchange.onrender.com`). Huvudfil `index.js` (ES-modul — `import`, aldrig `require`; alla route-block före `app.listen`). E-postlogik i `emailer.js` (templates + EmailQueue-poller + SendGrid-anrop).
- **Data:** Bubble.io håller all data. Render håller logiken.
- **Frontend:** Admin-dashboarden (`mira-kommunikation-admin.html`) bor i Bubble (`dashboard_crm`). Publika landningssidor (`mira-invite.html`, `mira-undersokning.html`) hostas separat (mira-fm.com).
- **E-post:** 100% kodbaserad. Varje mejl = en `tmpl*`-funktion. `buildEmail(item)` switchar på `slug` → rätt template. Alla bygger på `wrapLayout({...})`. Skickas via EmailQueue-poller som läser Bubble och anropar SendGrid.

### Kritiska konventioner (måste respekteras)
- **ES-moduler** överallt i backend.
- **Versionsdrift är största risken.** Christians GitHub-numrering ≠ assistentens numrering. Christian arbetar parallellt på `index.js` (bl.a. fakturasynk). **Innan backend-arbete: be Christian ladda upp senaste `index.js` + `emailer.js`.** Bygg alltid på den uppladdade filen, aldrig på en gammal output.
- `kind`-fältet på `Invitation` är ett **Bubble Option Set** med värden `invite`, `news`, `survey`. Nya kinds kräver nytt option-värde i Bubble.
- `safeCreate` självläker på "Unrecognized field" (droppar tyst) men INTE på ogiltiga option-set-värden (kastar).
- **🔑 Vanligaste fallgropen (grundorsak till 3 buggar): ny datatyp/fält i Bubble måste (a) finnas med exakt rätt namn OCH (b) vara "modifierbar via API".** Saknas datatypen → `bubbleCreate failed` / `Type not found`. Saknas ett *fält* → `safeCreate` droppar det **tyst** → data tappas utan fel. Checklista vid nya fält: skapa fältet, exponera typen via API, och verifiera att en rad faktiskt skapas/innehåller fältet. Drabbade hittills: `SurveyResponse`, `EmailOptout`, `AudienceSegment.members`.
- Admin-HTML/landningssidor ändras via assistenten; backend ändras av båda → därav driftrisken.

---

## 2. Aktuella filversioner (assistentens numrering)

| Fil | Senaste | Innehåll |
|---|---|---|
| Backend | `index-83.js` | byggd på Christians `index-80` (som har fakturasynk v2). + deadline/påminnelse, anonymisering, footer/avsändarnamn |
| Emailer | `emailer-11.js` | = Christians `emailer-7` + footer-boilerplate. Verifierat ren superset. |
| Admin | `mira-kommunikation-admin.html` | survey-flik, deltagarverktyg, livscykel, anonymisering |
| Survey-landning | `mira-undersokning.html` | publik svarssida, 10 frågetyper, anonymitet, footer |
| Invite-landning | `mira-invite.html` | **EJ uppdaterad med footer** — Christians live-version kan vara nyare; väntar på uppladdning |

**Numrerings-mappning som bekräftats:**
- Christians `index-80` ≈ assistentens `index-85` funktionellt, MEN Christians är nyare (har `/sync/v2/:source` + `/sync/v2-pdf/:source`, saknar gamla `/fortnox/enrich/*`). Bygg på Christians.
- Christians `emailer-7` = assistentens `emailer-10` (pre-footer). `emailer-11` = + footer.

---

## 3. Vad som är byggt

### 3a. Undersökningsmodul v1.0
Tredje fliken i kommunikationsmodulen, byggd genom återanvändning: `kind="survey"` på befintlig `Invitation`, `InviteGuest` för mottagare/svar, samma `/invite/config` + `/invite/rsvp`-endpoints (kind-medvetna).
- **10 frågetyper:** kort text, lång text, e-post, siffra, datum, dropdown, flerval (checkboxes), stjärnbetyg, NPS (0–10), skala, ja/nej. (+ sektion/rubrik, se nedan.)
- Form-byggare med drag (↑↓), obligatorisk, ta bort.
- Mottagarpanel (totalt/skickade/att skicka/svarat).
- Skicka-flöde via EmailQueue + poller.
- **Analysvy:** svarsfrekvens, per-fråga-aggregat (snitt/min/max för siffror, NPS-score med promoters/passives/detractors, stapeldiagram för select/yesno/multiselect, listor för text), rådatatabell, CSV-export (BOM för Excel).
- Publik landningssida `mira-undersokning.html` (mörk Mira-stil, mobilresponsiv, "redan svarat"- och "stängd"-lägen).

### 3b. Deltagarverktyg (alla tre flikar: event/nyhet/undersökning)
Återanvändbar `attachAudienceTools(cfg)` monterad i varje deltagarpanel:
- **Välj sparad målgrupp** (segment) → bygger deltagarlista. Två sorters segment:
  - **filter** (regions/fastigheter/company) → `/guests/build` (dynamiskt mot Coworkers).
  - **lista** (statisk ögonblicksbild av namn+mejl) → körs genom `/guests/import`. Dropdownen visar antal, t.ex. "Sthlm-lista (486)".
- **Excel/CSV-import** direkt i panelen via `/guests/import` (kolumner: `namn`, `epost`, valfritt `foretag`/`region`; dubbletter hoppas över).
- **💾 Spara nuvarande lista som målgrupp** — sparar den laddade mottagarlistans namn+mejl som ett **list-segment** (`POST /admin/audience/segments` med `members`). Hämtas via `GET /admin/audience/segments/:id`. Skyddat mot tyst fel: saknas `members`-fältet i Bubble returneras `members_field_missing` istället för en tom "sparad" målgrupp.
Segment kan fortfarande skapas under Målgrupp-fliken; dropdownen speglar dem.

### 3c. Survey-livscykel (snabbt-paketet, del 1)
- **Auto-stängning efter slutdatum** — survey respekterar `rsvp_deadline`; landningssidan visar stängt-läge. Deadline parsas via robust `_deadlinePassed()`/`_deadlineMs()` (klarar ISO, ms-tal, **ms-sträng**, sekund-tal) i *både* config och rsvp. Tidigare bugg: `new Date("<ms-sträng>")` gav Invalid Date → stängde aldrig. Sen submit visar nu snyggt stängt-läge.
- **Datum + tid** på sista anmälan (invite + survey) via `datetime-local` (tidszon hanteras av `toISO`/`fromISOLocalDT`).
- **Förhandsgranska** — knapp öppnar landningssidan med invitations-token.
- **Påminnelser** — "🔔 Påminn (N)" skickar bara till dem som fått men ej svarat (backend `reminder:true`-flagga, egen cache-nyckel, ommarkerar inte `invite_sent`).
- **Rubriker/sektioner** — frågetyp "section" delar upp undersökningen i kategorier; hoppas i validering/aggregering/CSV.

### 3d. Anonymisering
- **Undersökningsnivå (stark, data-nivå):** toggle "Anonyma svar". Svar lagras i egen datatyp `SurveyResponse` **utan personkoppling**. Gästen får bara en "har svarat"-bock (`arrived=yes`), aldrig vad. Analysvyn visar "Anonymt svar #N". Ny endpoint `GET /admin/invite/:id/responses`.
- **Frågenivå (UX-nivå):** "Dölj per person" på enskild fråga → aggregat visas men per-person maskeras med 🔒 i tabell + CSV.
- **Påminnelser funkar ändå** (bocken spårar *att*, inte *vad*).
- Fail-safe: om `anonymous`-fältet saknas i Bubble behandlas undersökningen som icke-anonym (inget falskt löfte).
- Landningssidan visar "🔒 Dina svar är anonyma"-notis.
- **Härdat:** misslyckas `SurveyResponse`-skapandet (t.ex. datatyp ej API-exponerad) loggas Bubbles exakta fel och respondenten får `survey_save_failed` — gästen markeras **inte** som svarad (svaret tappas inte tyst). `SurveyResponse` MÅSTE vara API-modify-bar (annars `bubbleCreate failed`).

### 3e. Footer-boilerplate + tailored avsändarnamn
- **Footer** i alla utgående mejl (invite/news/survey/RSVP-bekräftelse) + survey-landning: kontaktrad (hemsida · e-post · telefon), adress, `© år bolag, alla rättigheter förbehållna` + integritetspolicy-länk. Tomma fält renderas inte.
- **Avsändarnamn** — fältet "Avsändarnamn i mail" styr nu From-namnet i inkorgen (ifyllt → används; annars ClientCompany; annars Carotte). Tomt fält läcker aldrig (gammal bugg åtgärdad).

### 3f. Taggar på utskick
- **Fritext, kommaseparerat** `tags`-fält på `Invitation` (text, *inte* option-set/list-of-texts → `safeCreate` kastar aldrig; `_normTags`/`_tagsArr` hanterar sträng↔array). Finns på alla tre flikar (event/nyhet/undersökning).
- Skrivs i create/update, returneras i list/get; `?tag=`-filter i list-endpointen.
- Admin: tagg-input i formuläret, tagg-chips på listobjekt + klickbar filterrad ovanför varje lista (`buildTagFilter`).
- **Dotterbolags-sortering (steg 1):** tagga utskick med dotterbolagets namn och filtrera på taggen. Ersätter tills vidare det dedikerade leverantörs-/företagsfiltret i Målgrupp (parkerat).

### 3g. Dubblettkoll vid import (global, opt-in)
- Import-panelen har checkbox **"Hoppa över kontakter som redan finns (andra utskick + medarbetare)"**. Default **av** → dagens beteende ändras inte tyst.
- På: dedup-setet utökas med alla `InviteGuest`-mejl (tvärs utskick) + alla `Coworker`-mejl (`_buildExistingEmailSet`, cachad 60s). Rapporteras separat som `skipped_existing` ("fanns i systemet"). Finns i både invite-panelen och den återanvändbara `attachAudienceTools` (alla tre flikar).

### 3h. Avregistrering / unsubscribe (GDPR)
- Global opt-out per mejladress (egen datatyp `EmailOptout`, fält `email`). Ett mejl = bort från **allt**.
- Send-flödet filtrerar bort opt-outade innan kö (`_loadOptoutSet`, cachad 60s). Per-mottagare unsub-länk (via `guest_token`) injiceras i mejlfoten; `buildFooterBlock` renderar "Avregistrera dig från utskick" när länk finns.
- Route `GET /unsubscribe?g=<token>` (tvåstegs-bekräftelse mot mejl-skannrar), i `openPaths`. Ny env `PUBLIC_API_BASE`.
- **Härdat:** `_addOptout` sväljer inte längre fel — failar skapandet (t.ex. datatyp saknas/ej API-exponerad) loggas Bubbles svar och `/unsubscribe` visar "Något gick fel" istället för en falsk "avregistrerad". `EmailOptout` måste finnas + vara API-modify-bar.

### 3i. Avprickning (mobil event-incheckning) — TVÅ vägar
Backend delar logik: `_buildGuestList(invId)` (gästlista) + `PATCH .../guest/:id {arrived}`.

**a) Inbyggd i admin (för dig själv):** "📋 Avprickning"-knapp i deltagar-kortet → fullskärms mobil-overlay (live-räknare, sök, "visa bara ej incheckade", stora tappbara rader). Kräver admin-inlogg. Stänger man synkas desktop-tabellen om.

**b) Fristående kod-skyddad sida (för betrodd personal utan Bubble-konto):** ny fil `mira-deltagarhantering.html` hostad på `mira-fm.com/deltagarhantering`.
- **Säkerhet:** hemlig länk `?e=<checkin_token>` + tillfällig **kod** (`checkin_code`) = grind. Länken ensam ger inget. Mejl loggas (spårbarhet, ingen allowlist). Kod auto-genereras, slutar gälla ~12h efter eventets slut (`end_date`/`start_date` + grace), kan regenereras. Rate-limit 10 kodförsök/min/IP. Kortlivad in-memory-session (8h) efter inloggning → vid Render-omstart loggar man in igen.
- **Endpoints (publika, i `openPaths`):** `POST /checkin/auth {e,email,code}` → `{session,event,guests}`; `POST /checkin/list {session}`; `POST /checkin/toggle {session,gid,arrived}`. Admin genererar/visar länk+kod via `POST /admin/invite/:id/checkin/share {regenerate?}` (knapp "🔗 Dela länk" i deltagar-kortet).
- **Flöde:** admin → 🔗 Dela länk → skicka länk + kod (helst olika kanaler) → personal öppnar länken på valfri mobil, anger mejl + kod → listan → tryck rad i dörren. Flera enheter samtidigt funkar (↻ uppdaterar).

### 3j. Mediaarkiv + bilduppladdning
- Bild-fälten (event/nyhet/undersökning) har "📤 Arkiv"-knapp → modal med **uppladdning** + **återanvändning** av tidigare bilder + radering.
- Uppladdning: klienten komprimerar (canvas, max 1600px, JPEG ~0.82) → base64 → `POST /admin/media/upload` → laddar upp via **Bubble file storage** (`bubbleUploadFile`, samma som Fortnox-PDF:er, ingen ny infra) → sparar `MediaAsset`-rad → fyller fältets URL. `GET /admin/media/list`, `DELETE /admin/media/:id`. Tak 6 MB efter komprimering.

### 3k. Karta + video på landningssidor
- Nytt fält `video_url` på `Invitation`. Vimeo/YouTube-länk → responsiv 16:9-embed på landningssidan (`mira-undersokning.html` + `invite.html`). Video-fält i event- + survey-formuläret (nyhet saknar landningssida).
- **Karta:** nyckel-fri Google Maps-embed via eventets `event_address` (ingen API-nyckel). Endast landningssida — *inte* i mejl (skulle kräva Google Static Maps-nyckel; medvetet bortvalt för v1.0).

---

## 4. Bubble-setup som KRÄVS (förutsättningar)

| Vad | Detalj | För |
|---|---|---|
| EmailTemplate-rad | `slug=survey_invitation`, `entity_type=invite`, `name=Undersökning`, `active=true`, `cta_label=Svara på undersökningen` | survey-mejl |
| Option-set `kind` | lägg till värdet `survey` | survey sparas |
| Fält på `Invitation` | `anonymous` (yes/no) | anonymisering |
| Ny datatyp `SurveyResponse` | fält: `invitation` (text), `response_json` (text), `anon_meta` (text). Inga personfält. | anonyma svar |
| Fält på `Invitation` | `tags` (**text** — inte list-of-texts) | taggar/dotterbolags-sortering |
| Ny datatyp `EmailOptout` | fält: `email` (text). En rad per avregistrerad adress. | unsubscribe (GDPR) |
| Fält på `Invitation` | `checkin_token` (text), `checkin_code` (text) | fristående avprickningssida (3i b) |
| Fält på `Invitation` | `video_url` (text) | video på landningssida (3k) |
| Ny datatyp `MediaAsset` | fält: `url` (text), `name` (text), `content_type` (text) | mediaarkiv (3j) |
| Fält på `AudienceSegment` | `members` (text — JSON-array med {name,email,company,region}) | statiska list-målgrupper (3b) |

> Den **inbyggda** avprickningen (3i a) kräver ingen Bubble-setup. Den **fristående** sidan (3i b) kräver `checkin_token` + `checkin_code` ovan.
>
> ⚠️ **Alla nya datatyper måste vara API-modify-bara** (datatypens inställning "modifierbar via API"). Detta var grundorsaken till buggarna i `SurveyResponse` (`bubbleCreate failed`) och `EmailOptout` (`Type not found`). Se kritisk konvention i §1.

---

## 5. Render env-vars

| Var | Syfte | Default om tom |
|---|---|---|
| `PUBLIC_SURVEY_URL` | survey-landningssidans URL i mejllänkar | `https://mira-fm.com/undersokning` |
| `COMPANY_NAME` | footer org-namn | `Carotte Group AB` |
| `COMPANY_WEBSITE` | footer hemsida | (döljs) |
| `COMPANY_EMAIL` | footer e-post | (döljs) |
| `COMPANY_PHONE` | footer telefon | (döljs) |
| `COMPANY_ADDRESS` | footer adress | (döljs) |
| `COMPANY_PRIVACY_URL` | footer policy-länk | (döljs) |
| `PUBLIC_API_BASE` | bas-URL för unsubscribe-länk i mejlfoten (Render-servern, inte Bubble) | `https://mira-exchange.onrender.com` |
| `PUBLIC_CHECKIN_URL` | bas-URL till fristående avprickningssidan (i delningslänken) | `https://mira-fm.com/deltagarhantering` |

---

## 6. Deploy-checklista

**Bunt 1 (survey-modulen) — tidigare:**
1. Bubble: `SurveyResponse`-datatyp + `anonymous`-fält + `survey`-option + EmailTemplate-rad.
2. Render env-vars (`PUBLIC_SURVEY_URL`; footer-vars valfritt).
3. `index.js`, `emailer.js`, `mira-kommunikation-admin.html`, `mira-undersokning.html`.

**Bunt 2 (taggar / dubblettkoll / unsubscribe) — committad `bc5124b "komms"`:**
1. Bubble: fält `tags` (text) på `Invitation` + ny datatyp `EmailOptout` (fält `email`, text).
2. Render env (valfritt): `PUBLIC_API_BASE`.
3. Push `index.js` + `emailer.js`; klistra in `mira-kommunikation-admin.html` i `dashboard_crm`.

**Bunt 3 (avprickning: inbyggd + fristående kod-sida) — oncommittad i working tree:**
1. Bubble: fält `checkin_token` (text) + `checkin_code` (text) på `Invitation`.
2. Render env (valfritt): `PUBLIC_CHECKIN_URL` om sidan inte ligger på `mira-fm.com/deltagarhantering`.
3. Push `index.js` (nya `/checkin/*`-endpoints + share).
4. Klistra in `mira-kommunikation-admin.html` i `dashboard_crm` (📋 Avprickning + 🔗 Dela länk).
5. Hosta `mira-deltagarhantering.html` på `mira-fm.com/deltagarhantering`.

**Bunt 4 (mediaarkiv + karta/video) — oncommittad i working tree:**
1. Bubble: ny datatyp `MediaAsset` (`url`, `name`, `content_type` — text) + fält `video_url` (text) på `Invitation`.
2. Push `index.js` (media-endpoints + `video_url`).
3. Klistra in `mira-kommunikation-admin.html` i `dashboard_crm` (📤 Arkiv-knapp + video-fält).
4. Hosta uppdaterade `mira-undersokning.html` + `invite.html` (karta + video-embed).

**Bunt 5 (buggfixar + statiska list-målgrupper) — deployat 2026-06-23:**
1. Bubble: fält `members` (text) på `AudienceSegment`. (Säkerställ även att `EmailOptout` + `SurveyResponse` är **API-modify-bara**.)
2. Push `index.js` (robust deadline, härdade anon/optout-fel, segment-`members`-endpoints).
3. Klistra in `mira-kommunikation-admin.html` (💾 Spara som målgrupp) + `mira-undersokning.html` (snyggt stängt-läge vid sen submit).

---

## 7. Kvar att göra

> 🎉 **v1.0 av kommunikations-/undersökningsmodulen klar 2026-06-08, driftsatt och skarp-testad (taggar/dubblettkoll/unsubscribe/avprickning/mediaarkiv/karta+video).**
> ✅ Byggt: Taggar (3f), dubblettkoll (3g), unsubscribe (3h), avprickning inbyggd + fristående kod-sida (3i), mediaarkiv + bilduppladdning (3j), karta + video på landningssidor (3k), statiska list-målgrupper (3b).
> 🐛 **Buggfixar efter skarp drift (2026-06-23):** deadline parsade fel format → stängde aldrig (3c, fixat robust); anonyma svar + unsubscribe failade tyst pga icke-API-exponerade datatyper (härdade till tydliga fel + loggning, se §1-fallgropen).

### Snabbt (timmar)
- **Mer filtrering** i deltagarlistan.

### Medel (≈ en dag styck)
- **Karta i mejl** — statisk bild via Google Static Maps (kräver API-nyckel). Bortvalt i v1.0; landningssida har redan karta.
- **Dotterbolag-filter** i målgrupp (leverantör/företagsnamn) — **parkerat**: löses via taggar (3f). Bygg dedikerat filter om taggar inte räcker.
- **Importera Excel direkt till Coworker** (permanenta poster, inte bara deltagarlista) + komplettera målgrupp.

### Stort (eget projekt vardera)
- **Undersökningar i projekt:** gruppera flera undersökningar, aggregera över tid, **jämför föregående period**. Ny datatyp (t.ex. `SurveyProject`) + ny analysvy. Största posten.
- **Benchmarksiffra per fråga** — inputfält per fråga med målsiffra; sammanställning jämförs mot den. (Relaterar till projekt om benchmark = föregående period.) Bekräftat: manuellt inmatad målsiffra.
- **WYSIWYG-editor** — enkel rich-text på beskrivningsfält (landningssidor för undersökning/invite). Bekräftat scope: bara där man skriver löptext.
- **Nyhetsbrev med block** (bild/text/CTA-sektioner). Besläktat med WYSIWYG.
- ~~Mediaarkiv + bildkomprimering~~ ✅ klart (3j).

### Öppna trådar
- **Footer på `mira-invite.html`:** väntar på att Christian laddar upp sin live-version (för att undvika drift). Data finns redan i `/invite/config` (`cfg.footer`).
- **anon_meta-integritet:** lagrar grov region för segmentering. Små regiongrupper kan bli avidentifierbara — överväg att utelämna för känsliga undersökningar.
- **Anonym öppen länk (`?t=` utan `?g=`):** ingen "har svarat"-bock skapas (sällsynt för survey).

---

## 8. Bekräftade designbeslut
- Anonymitet: **stark** på undersökningsnivå (egen datatyp), **UX-nivå** på frågenivå.
- Avsändarnamn: ifyllt fält > ClientCompany > "Carotte". Tomt läcker aldrig.
- Footer: global via env-vars (boilerplate till alla), ej per-dotterbolag i v1.
- Datum/tid: lagras ISO (UTC), visas/redigeras lokal svensk tid.
- Taggar: fritext-`text` (kommaseparerat), inte option-set/list-of-texts. Dotterbolags-sortering görs via taggar i steg 1.
- Dubblettkoll mot befintliga: opt-in, default av (tvångsskippa befintliga vore fel — man vill ofta bjuda in en medarbetare till ny undersökning).
- Unsubscribe: global per mejladress (egen datatyp), inte per utskick.
- Avprickning: två vägar — inbyggd i admin (Bubble-auth) + fristående sida på mira-fm.com med kod-grind. Kod = enda grinden (mejl loggas, ingen allowlist), auto-genererad + auto-utgång efter eventet. Sessioner in-memory (8h).
- Sparad målgrupp: kan vara **dynamiskt filter** ELLER **statisk lista** (ögonblicksbild av mejl). Listan är en snapshot — uppdateras inte om källistan ändras.
- "Hoppa över befintliga" vid import: avsett för listbygge, **inte** kampanjutskick till egna kontakter (skippar då alla → 0 mottagare). Lämna av för utskick.

---

## 9. Snabb startprompt för nästa session

> "Vi fortsätter på Mira FM:s kommunikations-/undersökningsmodul. Du finner handoff-dokumentet plus alla filer i repo (`Mira-Exchange/`). Senaste filer: index.js, emailer.js, mira-kommunikation-admin.html, mira-undersokning.html. Backend ändras av båda → kolla versionsdrift först. v1.0 är klar — nästa steg: [mer filtrering i deltagarlistan / WYSIWYG / nyhetsbrev med block / annan punkt]."

*Senast uppdaterad 2026-06-23: v1.0 driftsatt + skarp-testad. Tillägg: statiska list-målgrupper (3b). Buggfixar: deadline-parsning (3c), tysta API-fel på SurveyResponse/EmailOptout (§1, 3d, 3h).*
