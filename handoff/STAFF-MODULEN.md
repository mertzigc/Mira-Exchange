# Staff-modulen (dashboard_crm → Service & People)

> Domänfil. Status: **BYGGD OCH TESTAD, EJ DEPLOYAD** (2026-08-28).
> Fyra vyer + tilldelning + rollsättning ligger i koden. `staff_smoke.mjs`: 156 gröna, mutationstestade.
> **Kvar innan skarp drift:** deploy + Bubble-triggern i §3 + rökkörning enligt §10.
> Mockup: https://claude.ai/code/artifact/1777300d-a9f6-43eb-8c7a-8873c91fee8f
> Källa: `prototypes/staff-mockup.html`
>
> Systerspår: [BESOKSHANTERING.md](BESOKSHANTERING.md) — besöksmodulen som denna styr.

---

## ✅ VAD SOM FAKTISKT BYGGDES (2026-08-28)

**Nya filer:** `staff_api.js` · `mira-staff.html` · `staff_smoke.mjs`
**Ändrade filer:** `index.js` (import + `openPrefixes` + registrering) ·
`companies_api.js` (tre lånade projektioner, se nedan)

| Endpoint | Ger |
|---|---|
| `GET /admin/staff/oversikt?dagar=7` | KPI:er + åtgärdslistan |
| `GET /admin/staff/receptionister?dagar=7` | rader + sessionsstatus + fastighetsväljare |
| `POST /admin/staff/receptionister/:id/fastigheter` | **skriver** `receptionist_fastigheter` + nollar `visitor_token` |
| `POST /admin/staff/receptionister/:id/roll` | **skriver** `User_role` + nollar `visitor_token` (se §14) |
| `GET /admin/staff/hus?dagar=7` | besöksuppsättningar per hus |
| `GET /admin/staff/notiser?dagar=7[&fastighet=]` | notisstatistik + felorsaker |
| `GET /admin/staff/kluster` | UI-genväg vid tilldelning (egen route med flit, se §11) |

Alla grindas av `x-admin-token` (`PLANNING_ADMIN_TOKEN`). `/admin/staff` ligger i
`openPrefixes`. `?dagar=` klampas till 1–90, `?fresh=1` förbigår cachen.
`?user_company=` (GET) / `user_company` i kroppen (POST) = den inloggades bolag, se §14.

**UI-manér:** samma som `mira-affar-samlad.html` — palett (`--base:#1e2235` …), DM Serif
Display-rubrik med orange separator, versal `.sub`, chip-flikar, `.st-grid`-tabeller,
pill med prick. ⚠️ Allt är namnrymdat under `.st`; affärsvyn skriver bara `.grid`/`.pill`/`.bar`
och två sådana block på samma sida krockar ([[reference-bubble-multiblock-collision]]).

**Åtgärdstyper i listan:** `receptionist_utan_hus` · `fastighet_saknas` ·
`kund_utan_kontaktlista` · `kund_utan_kontaktvag` · `vardar_utan_kontaktvag` ·
`notiser_fel` · `trunkerad`. Varje rad bär `verb`, `text` (konsekvensen) och `flik`.

---

## 🚀 PROMPT — historik (uppdraget är utfört)



```
ÄMNE: Staff-modulen — "Kan byggas nu"-lagret
MÅL:  Fyra vyer i dashboard_crm som går på BEFINTLIG data: åtgärdslista,
      receptionister (m. tilldelning av fastigheter), besöksuppsättningar per hus,
      och notisstatistik. Deployat + mutationstestat.

LÄS FÖRST, I DENNA ORDNING:
1. Mira-Exchange/HANDOFF.md — HELA filen. Ordlistan är obligatorisk.
2. Mira-Exchange/handoff/STAFF-MODULEN.md — DENNA fil, hela.
3. Mira-Exchange/handoff/BESOKSHANTERING.md §7.5 (auth/scope) + §7.6 (Staff-skissen).
4. Minnena: reference-bubble-button-hover-important · reference-bubble-wu-full-sweeps ·
   reference-bubble-sort-drops-empty · reference-bubble-id-truncation

KÖR HÄLSOKOLLEN innan du drar slutsatser om skarp data:
  curl -sS "$HOST/version" | python3 -m json.tool

⚠️ INGÅR INTE (bygg INTE detta):
  - Carotte Academy (kräver ny datamodell + beslut om certifiering)
  - Bemanning/Intelliplan (BLOCKERAT — källan saknar klockslag, se §4 nedan)
  - Lobbyskärmens hälsa (kräver att skärmen hör av sig — finns inte)
  - Lobbyskärmen som yta (eget spår, steg E i BESOKSHANTERING §8)

ARBETSREGLER:
- EN domän. Spårar vi ur: säg till och föreslå eget spår.
- Mät före slutsats. Verifiera fältnamn mot hur koden SKRIVER raden.
- Aldrig .catch(() => []) på en Bubble-fråga. Låt den braka.
- Mutationstesta varje ny svit — testerna MÅSTE falla mot gammal kod.
- Jag deployar själv. Ge curl-kommandon, committa inte utan att jag ber om det.
- Uppdatera handoff/STAFF-MODULEN.md när ni är klara.
```

---

## 1. Vad som ska byggas

**Ny modul `staff_api.js`** (DI-mönster som `companies_api.js`), block `mira-staff.html`.

| Vy | Innehåll | Datakälla |
|---|---|---|
| **Åtgärdslista** | Hyresgäster utan kontaktlista · värdar utan kontaktväg · receptionister utan fastighet · notiser som fallerat | `Visit`, `Coworker`, `User` |
| **Receptionister** | Lista + sessionsstatus + **tilldela fastigheter** (skriv `receptionist_fastigheter`) | `User` där `User_role = Receptionist` |
| **Besöksuppsättningar** | Per hus: anslutna hyresgäster, hur många som fyllt kontaktlista, notiser fram, andel via lobbyn | `Fastighet`, `ClientCompany`, `Coworker`, `Visit` |
| **Notisstatistik** | Andel `skickad` vs `fel`, per hus och hyresgäst, med felorsaker | `Visit.notis_status` / `notis_fel` |

**Auth:** `PLANNING_ADMIN_TOKEN` (`x-admin-token`) via `planningAuthed` — precis som
`companies_api`. ⚠️ **INTE** visitor-token. Detta är en CRM-yta för Carotte-personal.
Lägg `/admin/staff` i `openPrefixes` (index.js).

---

## 2. Verifierade fältnamn — gissa inte

**`Visit`** (skapad 2026-08-26, konstant `VISIT` i `visitor_api.js` — importera den, duplicera inte):
`fastighet`(Fastighet) · `hyresgast`(ClientCompany) · `vard`(Coworker) · `vard_namn`(text) ·
`besokare_namn`(text) · `besokare_bolag`(text) · `incheckad_at`/`utcheckad_at`(date) ·
`via`(text: reception|lobby) · `registrerad_av`(User) · `registrerad_av_namn`(text) ·
`notis_kanal`/`notis_status`/`notis_fel`(text) · `notis_at`(date)

**`User`:** `User_role`(option set, värdet `Receptionist`) · `receptionist_fastigheter`(List of Fastighet) ·
`visitor_token`(text) · `visitor_token_exp`(date) · `First Name` · `Surname` (INTE "Last Name")

**`Fastighet`:** namnet ligger i **`Titel`** — det finns INGET `Namn`-fält, och `Adress` är
ett geographic address-OBJEKT (`.address` för texten). Se [[reference-bubble-fastighet-titel]].

**Hyresgäster per fastighet:** `ClientCompany.Fastighet contains <id>`.
⚠️ **ANVÄND INTE `Fastighet.Hyresgäster`** — fältet finns i schemat men skrivs aldrig av vår
kod (`companies_api.js:285` skriver `ClientCompany.Fastighet`) → kan vara tomt/stale.

**Värdar per hyresgäst:** `Coworker` där `Kundföretag = <companyId>`.
Kontaktväg: `Telefon`(**number**) → SMS, `Email`(text) → mail. Saknas båda = kan inte nås.

---

## 3. ⚠️ MÅSTE FIXAS I SAMMA SVEP — trigger på User

**Utan denna släpar receptionistens behörighet upp till 12 timmar. Säkerhetsrelevant.**

```
Bubble database trigger:
  When User's receptionist_fastigheter changes  →  Make changes to User: visitor_token = ""
  When User's User_role changes                 →  Make changes to User: visitor_token = ""
```

**Varför:** `/visitor/context` läser fastigheterna ur **tokenens payload**, inte färskt ur
User (tokenen är sanningen om scope — annars kunde en klient påstå sig ha fler hus).
Page-load-villkoret mintar ingen ny token så länge den gamla är giltig. Skarpt fall
2026-08-28: en tillagd fastighet syntes inte trots omladdning.

Konsekvensen utan trigger: **en avaktiverad receptionist behåller sin åtkomst i 12 timmar.**

Eftersom Staff-modulen är stället där `receptionist_fastigheter` skrivs, ska
tilldelnings-endpointen dessutom **nolla `visitor_token`** direkt vid skrivning — då fungerar
det även om triggern skulle saknas. Bälte och hängslen, och detta är rätt ställe för det.

---

## 4. ⚠️ BEMANNING ÄR BLOCKERAD — bygg den inte

Intelliplan har **dagskornighet, inte klockslag**. Genomsökning av 53 rapportmallar efter
tid-på-dygnet gav **en enda träff** — och den var en timlön (INTELLIPLAN.md, rad ~285).
Allt som mäter tid är en mängd (`Hours1`), allt som daterar är en dag (`Date1`).

Vyn kan realistiskt visa *"Anna, Hötorget 3, 28 aug, 7,5 h"* — men **inte "07:00–15:30"**.
Vill vi ha pass med start/sluttid krävs en annan källa eller egen schemaläggning i Mira.
**Det är ett beslut, inte en implementationsdetalj.** Rita aldrig ett tidsschema mot en
källa som saknar tid.

---

## 5. ⚠️ "Snittid till värd" GÅR INTE ATT MÄTA

Måttet fanns i första mockupen och **togs bort 2026-08-28** — det var påhittat.

Vi registrerar `incheckad_at` och `notis_at` (när notisen skickades, oftast sekunder), men
**aldrig när värden faktiskt hämtade gästen**. "Snittid till värd" hade krävt ett nytt fält
och ett extra klick i receptionen.

**Mät i stället det som faktiskt finns:** andel notiser som gick fram, antal besök per
hus/hyresgäst, **andel via lobbyskärm vs reception** (bra hälsomätare för skärmen),
hyresgäster utan kontaktlista, värdar utan kontaktväg.

---

## 6. Designprincip: åtgärdslista, inte katalog

Modulen öppnar med **avvikelser**, inte med en lista på allt som finns.

- Varje rad har ett **verb** ("Kontakta kunden", "Tilldela hus"). En avvikelse utan
  handling är bara en notis man vänjer sig vid.
- Varje rad har en **konsekvens**: inte "3 värdar saknar kontakt" utan "14 besök gick utan
  notis; receptionisten har fått ringa varje gång".
- **Sessionsstatus visar backends egna felkoder** (`no_fastigheter_assigned`) så ingen
  behöver läsa serverloggar för att förstå varför någon inte kommer in.
- Skilj på **trasigt och inte installerat** ("Svarar inte" vs "Ingen skärm").

---

## 7. WU-disciplin

- **Ingen helsvep av `Visit`.** Filtrera per fastighet med constraints, som
  `visitor_api.js` gör. Åtgärdslistan får INTE hämta alla besök för att räkna.
- Hyresgästlistan per fastighet: **TTL-cache** (mönstret finns i `visitor_api.js`).
- `companyFullMap()` och `_users()` är redan förvärmda — använd dem, svep inte om.
- ⚠️ [[reference-bubble-wu-full-sweeps]]: ett `setInterval`-helsvep kostade en gång
  ~13 000 WU/dygn = 78 % av idle-golvet.

---

## 8. Frontend-fällor (alla brända en gång)

- **`!important` på knapparnas `:hover`** — Bubble-sidor har en global `button:hover` med
  `!important` som annars gör knappen helorange med osynlig text.
  [[reference-bubble-button-hover-important]]
- **Rendera aldrig om ett öppet formulär** vid bakgrundsladdning — det raderar det
  användaren skrivit. Uppdatera in-place (se `paintHosts()` i `mira-visitor.html`).
  Följt: `malaVal()` i `mira-staff.html` uppdaterar kryssrutor och sparknappens etikett
  in-place. (En full omritning fungerade i test — det här är disciplin, inte en buggfix.)
- **Breda tabeller** i egen `overflow-x`-container, annars klipps action-kolumnen.
- Konventioner: `.st`-namnrymd (förslag), BROOT-claim, IIFE, **ingen `?.`/`??`**,
  raka quotes.

---

## 9. Testkrav

Ny svit `staff_smoke.mjs`, DI-mockad som `visitor_api_smoke.mjs`.
**Mutationstesta** — testerna MÅSTE falla mot felaktig kod. Minst dessa:
1. Åtgärdslistan missar en hyresgäst utan kontaktlista
2. Tilldelning av fastighet nollar INTE `visitor_token`
3. Notisstatistiken räknar `fel` som `skickad`
4. Fastighetsnamn läses från `Namn` i st.f. `Titel` (den gamla `[object Object]`-buggen)
5. Hyresgäster hämtas via `Fastighet.Hyresgäster` i st.f. `ClientCompany.Fastighet`

Regression: samtliga sviter gröna innan deploy.
⚠️ `komm_blocks_smoke` kan vara röd av annan orsak (mail_theme-refaktorering) — verifiera
att det inte är ditt innan du felsöker det.

### 9b. Utfall (2026-08-28)

`staff_smoke.mjs`: **126 gröna**. Sviten kör den RIKTIGA kedjan fejkad Bubble-store →
`companies_api`-projektioner → `staff_api` — mockas projektionerna bort testas bara mocken,
och då hade §9-punkt 4 och 5 inte kunnat falla. Patch-mocken har `KNOWN_FIELDS` per verifierad
typ och avvisar HELA patchen vid okänt fält, precis som Bubble
([[reference-bubble-data-api-keys]]), och kan simulera **tyst fältdrop**
([[reference-bubble-tysta-faltdrop]]).

**Mutationer som verifierat FALLER** (alla utan att krascha sviten — en krasch mot gammal
kod dödar resten av mutationstestet):

| # | Mutation | Fallerade tester |
|---|---|---|
| 1 | Åtgärdslistan hoppar över hyresgäst utan kontaktlista | 2 |
| 2 | Tilldelningen nollar INTE `visitor_token` | 5 |
| 3 | Notisstatistiken räknar `fel` som `skickad` | 8 |
| 4 | Fastighetsnamn ur `Namn`/`Adress` före `Titel` | 4 |
| 5 | Hyresgäster via `Fastighet.Hyresgäster` | 11 |
| 6 | Admin-grinden öppen | 10 |
| 7 | Tilldelningen validerar inte fastighets-id (skriver död referens) | 2 |
| 8 | Ingen återläsning efter skrivning (tyst fältdrop passerar) | 1 |
| 9 | Roll-kontrollen borttagen | 1 |
| 10 | Helsvep av `Visit` (fastighets-constrainten borta) | 18 |
| 11 | Noll notisförsök blir "100 % gick fram" | 1 |
| 12 | Sessionsnyckeln bärs ut i svaret | 1 |
| 13 | Trasigt User-svep svarar tomt i stället för att braka | 2 |
| 14 | Litar blint på datum-constrainten (ingen JS-omfiltrering) | 1 |
| 15 | Misslyckat User-svep cachas i 60 min | 1 |
| 16 | Namnlös receptionist filtreras bort | 4 |
| 17 | Utgången token räknas som aktiv session | 1 |
| 18 | Token + hus i SAMMA patch | 5 |
| 19 | Vyerna delar inte ögonblicksbilden | 1 |
| 20 | Besök/receptionist ur fel fält | 1 |
| F1–F6 | HTML-blocket: hover-fix, poller, extra flik, 0 %, overflow-x, BROOT | 1 vardera |
| F7–F8 | Blocket anropar route som inte finns · route utan deps | 1 / 3 |

**Röktest av alla routes:** sviten loopar varje REGISTRERAD route och anropar den — med och
utan admin-token. Aritetstest räcker inte ([[feedback-testa-alla-routes]]); en route som
stavats fel eller aldrig fick sina deps syns bara så här. Blockets `/admin/staff/*`-sökvägar
matchas dessutom mot de faktiskt registrerade — samma klass av fel som `/mypage/me` 2026-08-27.

**Renderat och klickat på riktigt** (lokal harness med stubbad `fetch` + Bubbles fientliga
`button:hover{...!important}` injicerad): alla fyra flikarna, tilldelningspanelen,
klustergenvägen och sparflödet. Knapparnas hovertext förblev läsbar — [[reference-bubble-button-hover-important]]
verifierad med minnets egen metod, inte bara statiskt. Inga konsolfel; `body` scrollar
aldrig i sidled och den breda hustabellen scrollar i sin egen container.
⚠️ Läs inte en skärmbild tagen mitt i en klickserie — den kan visa läget FÖRE ompaintningen.
Det narrade mig en gång i den här sessionen till att tro att kryssrutorna var trasiga.
(Harnessen ligger i sessionens scratchpad, inte i repot.)

**Rollflödet mutationstestat separat** (R1–R10, alla faller): kundens users erbjuds rollen ·
skrivning utan bolagskontroll · ovaliderat rollvärde · rollbyte utan sessionsnollning ·
ingen återläsning · fail-open utan bolag · `Receptionist` saknas i väljaren (testas mot en
värld där INGEN bär rollen — annars biter mutationen inte) · befintliga receptionister som
kandidater · onödig nollning vid samma roll · `role` tappas ur projektionen.

**Regression 2026-08-28:** samtliga sviter gröna. `komm_blocks_smoke` är röd med
4 fel (`MAIL_PAL_DARK is not defined` i `emailer.js`) — **identiskt före och efter** detta
arbete, alltså mail_theme-refaktoreringen, inte Staff.

---

## 10. ⚠️ EJ VERIFIERAT MOT SKARP DATA — kör detta efter deploy

Hälsokollen kunde **inte** köras i byggsessionen (`$HOST/version` kräver `x-api-key`, som
Claudes shell saknar). Allt nedan är därför byggt mot koden, inte mot skarp data. **Kör
rökkörningen innan du drar slutsatser av siffrorna.**

```bash
curl -sS "$HOST/version" -H "x-api-key: $KEY" | python3 -m json.tool
```

```bash
curl -sS "$HOST/admin/staff/oversikt?dagar=7" -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | python3 -m json.tool
```

```bash
curl -sS "$HOST/admin/staff/receptionister" -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | python3 -m json.tool
```

```bash
curl -sS "$HOST/admin/staff/hus?dagar=7" -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | python3 -m json.tool
```

```bash
curl -sS "$HOST/admin/staff/notiser?dagar=7" -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | python3 -m json.tool
```

```bash
curl -sS "$HOST/admin/staff/kluster" -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | python3 -m json.tool
```

### 10.1 TVÅ ÖPPNA ANTAGANDEN som rökkörningen avgör

**A. Biter datum-constrainten på `Visit.incheckad_at`?**
Bubbles constraint-nycklar är **slugar**, inte display-namn, och date-fält får ofta
`_date`-suffix ([[reference-bubble-data-api-keys]]). Att `incheckad_at` fungerar som
constraint-nyckel är **inte verifierat** — bara att `fastighet` gör det (besöksloggen kör
skarpt på den). Koden gissar därför inte: den försöker med constraint, faller tillbaka
EN gång vid ett smalt 400 på just den nyckeln, och **filtrerar alltid om i JS**.
Siffrorna blir rätt oavsett — men fallbacken hämtar hela husets besökshistorik.

Svaret säger vilken väg som togs:
```bash
curl -sS "$HOST/admin/staff/hus?dagar=7" -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['meta'])"
```
`datumfilter_fallback: 0` → constrainten bet, allt är bra. **Är den > 0: sätt rätt slug**
(prova `incheckad_at_date`) i `staff_api.js` `besokFor()`. Det blir inte fel förrän `Visit`
växer, men då blir det dyrt.

**B. Heter tokenfältet `visitor_token` eller `Visitor_token`?**
BESOKSHANTERING.md skriver båda (§7.5.3 gement, §7.5.3c versalt) och Bubble är
case-sensitivt. Koden nollar tokenen i en **egen patch** (aldrig samma som fastigheterna —
Bubble avvisar HELA patchen vid ett okänt fält) och provar båda formerna. Vilken som bet
står i svaret:
```bash
curl -sS -X POST "$HOST/admin/staff/receptionister/<USER_ID>/fastigheter" \
  -H "x-admin-token: $PLANNING_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"fastigheter":["<FASTIGHET_ID>"]}' | python3 -m json.tool
```
Titta på `token_falt` och `token_rensad`. **`token_rensad: false` betyder att den gamla
tilldelningen gäller i upp till 12 h** — då är Bubble-triggern i §3 enda skyddet.
⚠️ Hämta `<USER_ID>` från Data API, **läs det aldrig ur en skärmbild** — id:t är 18 tecken
efter `x` och editorn klipper visningen ([[reference-bubble-id-truncation]]).

---

## 11. Designbeslut värda att känna till

**Husurvalet = unionen av receptionisternas `receptionist_fastigheter`.** Samma sanning som
backend scopar på. Ett hus utan tilldelad receptionist finns inte i besökshanteringen och
ska därför inte stå i tabellen som en rad nollor. Konsekvensen: **ett hus med bara lobbyskärm
och ingen receptionist syns inte** — relevant först när lobbyskärmen byggs (BESOKSHANTERING §8 steg E).

**En raderad fastighet i en tilldelning göms inte.** Den blir en åtgärdsrad
(`fastighet_saknas`) och märks i husväljaren. Sparar man om raden skrivs den döda
referensen inte tillbaka. Utan detta hade varje query mot huset 400:at MISSING_DATA
([[reference-bubble-wu-full-sweeps]] §"Delta-refreshens pris").

**Kluster har en EGEN endpoint.** `Cluster` rullas ut till fastigheter i UI:t och lagras
aldrig (BESOKSHANTERING §7.5.2) — annars hade en ny fastighet i klustret tyst gett åtkomst.
Egen route för att typen inte är verifierad mot Data API:t: fäller den, fäller den bara
genvägsknappen, inte hela tilldelningsvyn.

**`null` betyder "går inte att räkna".** `notis_fram_andel` och `lobby_andel` är `null` när
nämnaren är noll, och blocket ritar `—`. Noll notisförsök får aldrig bli "100 % gick fram".

**Sessionsnyckeln lämnar aldrig servern.** `receptionistDirectory()` bär `has_token` +
`token_exp`, aldrig tokenen. Ett regressionstest vaktar det.

---

## 12. WU-budget (mätbar, inte påstådd)

Per ögonblicksbild (TTL **5 min**, delas av alla fyra vyerna — en flikväxling kostar noll):

| Källa | Frågor | Kommentar |
|---|---|---|
| `User` | 0 | lånas ur `companies_api._users()` (redan förvärmd, 60 min TTL) |
| `Coworker` | 0 | lånas ur `companies_api._coworkersAll()` (samma) |
| `Fastighet` | 0 | lånas ur `companies_api._fastigheter()` (samma) |
| `ClientCompany` | 1 per hus | egen TTL-cache, 10 min |
| `Visit` | 1 paginerad per hus | fastighets-constraint + datumfönster |

Med 6 hus ≈ 12 anrop per 5 min **när någon tittar**. **Ingen `setInterval` någonstans** —
blocket läser aldrig om sig själv i bakgrunden; "Uppdatera" är ett klick.

**Sidtak: 40 sidor (4 000 besök) per hus och fönster.** Nås det säger svaret
`meta.trunkerade` och vyn skriver ut det. En tyst avhuggning läser man som "så här ser det ut".

**Tre nya accessorer i `companies_api.js`** (`receptionistDirectory` · `coworkerDirectory` ·
`fastighetDirectory`) — de ligger DÄR för att User- och Coworker-svepen redan görs och cachas
där. Egna svep i `staff_api` hade varit två helsvep av flera tusen rader per TTL.

⚠️ Samtidigt rättades att `_users()` **cachade ett misslyckat svep i 60 minuter** (`.catch(() => [])`).
Nu markeras `ok:false`, cachen skrivs inte, och `receptionistDirectory()` **kastar** —
"0 receptionister" och "svepet failade" får aldrig se likadana ut i en åtgärdslista.

---

## 14. Rollsättning — varför den ligger HÄR och inte på kundkortet

**Beslut 2026-08-28 (Christian frågade, valet motiverat här).** `User_role = Receptionist`
sätts i Staff-modulen, inte på Carottes eget kundkort.

1. **Roll och scope är ETT beslut.** Modulen är redan stället där `receptionist_fastigheter`
   skrivs. Sattes rollen någon annanstans garanterade man det halvkonfigurerade läget som
   modulen själv flaggar som fel ("Nekas · `no_fastigheter_assigned`"). UI:t öppnar därför
   tilldelningspanelen direkt efter att rollen satts.
2. **Kundkortet är en KUNDvy.** Carottes eget kort är ett specialfall av den. En
   rollsättare där måste gömmas bakom "är detta Carotte?" och renderas ändå för varje kund.
3. **Maskineriet fanns.** `?user_company=` + `CAROTTE_COMPANY_ID`-fallback är etablerat i
   `companies_api` (`_ourUsers`, onboarding-checken), och `_users()`-cachen bär redan
   `company_id` → kandidatlistan kostar **noll** extra WU.

Kundkortets "Skapa konto" behåller sin roll-väljare för **nya** konton (`createUserAccount`
tar redan `role`). Staff-vyn hanterar **befintliga** users.

### 14.1 Regler som INTE får brytas

- **Kandidatlistan = users där `Company === vårt bolag`** och rollen inte redan är
  Receptionist. ⚠️ `_users()` sveper HELA User-tabellen — där ligger även **kundernas egna
  inloggningar**. En kundanvändare som blir receptionist ser hyresgästernas kontaktlistor.
  Samma klass av fel som kundansvarig-buggen 2026-08-24.
- **Utan känt bolag skrivs INGEN roll** (400 `carotte_company_id_missing`). Fail-closed:
  en roll som öppnar besökssystemet får inte delas ut på måfå. Läsvägen filtrerar däremot
  inte tyst — den svarar `kandidater_ofiltrerade: true` och vyn säger det rakt ut.
- **Skrivningen kräver `user.Company === vårt bolag`** → annars 403 `not_our_user`.
- **Rollvärdet valideras** mot de värden som finns i datan. ⚠️ **PLUS `Receptionist`,
  alltid** — härledningen har ett moment 22 för värdet som ska sättas för FÖRSTA gången,
  och strängen är inget gissat: `/visitor/session` jämför hårt mot exakt den (index.js).
- **`visitor_token` nollas vid VARJE rollbyte**, åt båda hållen. Att ta bort rollen ska
  stänga sessionen samma sekund, inte om 12 h (§3). Samma roll igen = no-op, ingen
  onödig nollning.
- **Rollen läses tillbaka** efter skrivning (option-set som inte tar värdet kan skrivas
  "utan fel") → 500 `roll_ej_skriven` hellre än ett falskt "sparat".
- **Vyn varnar** när kandidaten redan har en roll: `dashboard_crm` har en page-load-guard
  som skickar Receptionist till `/visitor`, så personen tappar CRM-åtkomsten.

---

## 13. Kvar att göra

1. **Deploy** (Christian) → kör §10.
2. **Bubble database trigger** enligt §3 — fortfarande nödvändig. Endpointens nollning är
   bälte och hängslen och täcker bara ändringar som görs HÄR; en rollsändring i Bubble-editorn
   fångas bara av triggern.
3. **Klistra in `mira-staff.html`** i `dashboard_crm`, fyll i `planning_token` OCH bind
   `data-mira="user_company"` till `Current User's Company's unique id`.
   ⚠️ Aldrig på `/visitor` — blocket bär admin-token.
   ⚠️ Utan `user_company` (och utan `CAROTTE_COMPANY_ID` i env) går rollsättningen inte
   att använda, och kandidatlistan visar då även kundernas inloggningar (märkt i vyn).
4. **Verifiera §10.1 A och B** och skriv in svaren här.
5. Överväg **lobbyskärm-relevant husurval** när steg E i BESOKSHANTERING §8 byggs (se §11).
