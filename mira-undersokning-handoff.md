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
- **Välj sparad målgrupp** (segment) → bygger deltagarlista via `/guests/build`.
- **Excel/CSV-import** direkt i panelen via `/guests/import` (kolumner: `namn`, `epost`, valfritt `foretag`/`region`; dubbletter hoppas över).
Segment skapas fortfarande under Målgrupp-fliken; dropdownen speglar dem.

### 3c. Survey-livscykel (snabbt-paketet, del 1)
- **Auto-stängning efter slutdatum** — survey respekterar `rsvp_deadline`; landningssidan visar stängt-läge.
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
- **Soft-fail:** saknas `EmailOptout` i Bubble visar sidan ändå "avregistrerad" men persisteras inte → verifiera att en rad faktiskt skapas vid första testet.

### 3i. Avprickning (mobil event-incheckning) — TVÅ vägar
Backend delar logik: `_buildGuestList(invId)` (gästlista) + `PATCH .../guest/:id {arrived}`.

**a) Inbyggd i admin (för dig själv):** "📋 Avprickning"-knapp i deltagar-kortet → fullskärms mobil-overlay (live-räknare, sök, "visa bara ej incheckade", stora tappbara rader). Kräver admin-inlogg. Stänger man synkas desktop-tabellen om.

**b) Fristående kod-skyddad sida (för betrodd personal utan Bubble-konto):** ny fil `mira-deltagarhantering.html` hostad på `mira-fm.com/deltagarhantering`.
- **Säkerhet:** hemlig länk `?e=<checkin_token>` + tillfällig **kod** (`checkin_code`) = grind. Länken ensam ger inget. Mejl loggas (spårbarhet, ingen allowlist). Kod auto-genereras, slutar gälla ~12h efter eventets slut (`end_date`/`start_date` + grace), kan regenereras. Rate-limit 10 kodförsök/min/IP. Kortlivad in-memory-session (8h) efter inloggning → vid Render-omstart loggar man in igen.
- **Endpoints (publika, i `openPaths`):** `POST /checkin/auth {e,email,code}` → `{session,event,guests}`; `POST /checkin/list {session}`; `POST /checkin/toggle {session,gid,arrived}`. Admin genererar/visar länk+kod via `POST /admin/invite/:id/checkin/share {regenerate?}` (knapp "🔗 Dela länk" i deltagar-kortet).
- **Flöde:** admin → 🔗 Dela länk → skicka länk + kod (helst olika kanaler) → personal öppnar länken på valfri mobil, anger mejl + kod → listan → tryck rad i dörren. Flera enheter samtidigt funkar (↻ uppdaterar).

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

> Den **inbyggda** avprickningen (3i a) kräver ingen Bubble-setup. Den **fristående** sidan (3i b) kräver `checkin_token` + `checkin_code` ovan.

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

---

## 7. Kvar att göra

> ✅ **Klart 2026-06-08:** Taggar (3f), dubblettkoll mot befintliga (3g), unsubscribe (3h), avprickning både inbyggd och fristående kod-skyddad sida (3i). Se sektion 3.

### Snabbt (timmar — nästa naturliga steg)
- **Mer filtrering** i deltagarlistan.

### Medel (≈ en dag styck)
- **Bilduppladdning + pixelinstruktion** (idag bara URL). Kräver upload-endpoint. Hänger ihop med Mediaarkiv.
- **Dotterbolag-filter** i målgrupp (leverantör/företagsnamn) — **parkerat**: löses i steg 1 via taggar (3f). Bygg det dedikerade filtret om taggar inte räcker.
- **Karta** på landningssida + mejl (mejl = statisk bild via Google Static Maps).
- **Video på landningssida** — Vimeo-länk räcker (bekräftat). Embed, enkelt.
- **Importera Excel direkt till Coworker** (permanenta poster, inte bara deltagarlista) + komplettera målgrupp.

### Stort (eget projekt vardera)
- **Undersökningar i projekt:** gruppera flera undersökningar, aggregera över tid, **jämför föregående period**. Ny datatyp (t.ex. `SurveyProject`) + ny analysvy. Största posten.
- **Benchmarksiffra per fråga** — inputfält per fråga med målsiffra; sammanställning jämförs mot den. (Relaterar till projekt om benchmark = föregående period.) Bekräftat: manuellt inmatad målsiffra.
- **WYSIWYG-editor** — enkel rich-text på beskrivningsfält (landningssidor för undersökning/invite). Bekräftat scope: bara där man skriver löptext.
- **Nyhetsbrev med block** (bild/text/CTA-sektioner). Besläktat med WYSIWYG.
- **Mediaarkiv + bildkomprimering.**

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

---

## 9. Snabb startprompt för nästa session

> "Vi fortsätter på Mira FM:s kommunikations-/undersökningsmodul. Du finner handoff-dokumentet plus alla filer i repo (`Mira-Exchange/`). Senaste filer: index.js, emailer.js, mira-kommunikation-admin.html, mira-undersokning.html. Backend ändras av båda → kolla versionsdrift först. Nästa steg: [mer filtrering i deltagarlistan / bilduppladdning / annan punkt]."

*Senast uppdaterad 2026-06-08: taggar, dubblettkoll, unsubscribe, avprickningsvy tillagda.*
