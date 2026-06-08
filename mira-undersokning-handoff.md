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

---

## 4. Bubble-setup som KRÄVS (förutsättningar)

| Vad | Detalj | För |
|---|---|---|
| EmailTemplate-rad | `slug=survey_invitation`, `entity_type=invite`, `name=Undersökning`, `active=true`, `cta_label=Svara på undersökningen` | survey-mejl |
| Option-set `kind` | lägg till värdet `survey` | survey sparas |
| Fält på `Invitation` | `anonymous` (yes/no) | anonymisering |
| Ny datatyp `SurveyResponse` | fält: `invitation` (text), `response_json` (text), `anon_meta` (text). Inga personfält. | anonyma svar |

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

---

## 6. Deploy-checklista (senaste bunten)

1. Bubble: skapa `SurveyResponse`-datatyp + `anonymous`-fält + `survey`-option + EmailTemplate-rad (om ej redan gjort).
2. Render env-vars (åtminstone `PUBLIC_SURVEY_URL`; footer-vars valfritt).
3. `index-83.js` → `index.js`.
4. `emailer-11.js` → `emailer.js`.
5. `mira-kommunikation-admin.html` → Bubble dashboard_crm.
6. `mira-undersokning.html` → host (mira-fm.com/undersokning).

---

## 7. Kvar att göra

### Snabbt (timmar — nästa naturliga steg)
- **Taggar** på utskick (organisering + filter). Kräver `tags`-fält på Invitation.
- **Dubblettkoll mot befintliga** vid Excel-import (idag dedup inom utskicket; utöka mot redan importerade/Coworkers).
- **Mer filtrering** i deltagarlistan.

### Medel (≈ en dag styck)
- **Avregistrera-länk (unsubscribe)** — route + `unsubscribed`-fält + footer-länk. GDPR-relevant.
- **Bilduppladdning + pixelinstruktion** (idag bara URL). Kräver upload-endpoint. Hänger ihop med Mediaarkiv.
- **Dotterbolag-filter** i målgrupp — Christian bekräftade: filtrera på leverantör/företagsnamn (gör det enkelt).
- **Karta** på landningssida + mejl (mejl = statisk bild via Google Static Maps).
- **Video på landningssida** — Vimeo-länk räcker (bekräftat). Embed, enkelt.
- **Mobilanpassad avprickningsvy** för deltagare (event-incheckning via `arrived`).
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

---

## 9. Snabb startprompt för nästa session

> "Vi fortsätter på Mira FM:s kommunikations-/undersökningsmodul. Här är handoff-dokumentet [bifoga]. Senaste filer: index-83.js, emailer-11.js, mira-kommunikation-admin.html, mira-undersokning.html. Jag laddar upp min senaste index.js + emailer.js först om backend ska röras. Nästa steg: [taggar / dubblettkoll / annan punkt]."
