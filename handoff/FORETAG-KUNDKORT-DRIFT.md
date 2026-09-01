# Företagslista + Kundkort + Drift

> Render-omtag av Bubble-native företagsvyn. Kod: `companies_api.js`,
> `mira-foretag-lista.html`, `mira-drift.html`.
> Minne: `project-foretagslista-kundkort`

---

## 🔢 ORGANISATIONSNUMMER — en kanonisk form ut, alla former in (2026-09-01)

**Regeln (Christian):** org.nr **visas alltid som `xxxxxx-xxxx`**, men **läses både
med och utan bindestreck**.

**Ny delad modul: `orgnr.js`** — `orgDigits` · `orgCore` · `formatOrgNo` · `isOrgNo`
· `sameOrgNo` · `orgVariants`. Delad med flit: funktionerna behövs i både `index.js`
(cache-projektionen) och `companies_api.js` (skapa/redigera/sök). En kopia i vardera
hade drivit isär, och orgnr är **dubblettnyckeln för hela kundregistret**.

| Var | Vad som händer |
|---|---|
| **`index.js` cache-projektionen** (`orgnr: formatOrgNo(...)`) | Kanoniserar EN gång, för alla vyer — lista, kundkort, koncernöversikt |
| **Sök** (`/admin/companies/list?q=`) | Träffar båda skrivsätten oavsett hur numret är lagrat |
| **Skapa** (`/create`) | Läser båda formerna, **lagrar kanoniskt** (tidigare: siffror bara) |
| **Inline-edit** (`PATCH`) | Kanoniserar + validerar + dubblettspärrar |

⚠️ **Sekelprefix hanteras:** `16`+tio (org) och `19`/`20`+tio (personnummer, enskild
firma) blir samma tio siffror som den korta formen. Utan det matchar inte
`165560001111` mot `556000-1111` och **en kund blir två**. Andra tolvsiffriga
strängar lämnas orörda.

⚠️ **Vi hittar ALDRIG på ett orgnr.** Går ett värde inte att kanonisera returneras
råvärdet oförändrat — ett halvt nummer ska synas som det är, inte formateras till
något som ser giltigt ut.

⚠️ **Lagrad data mass-skrivs INTE om.** Formateringen sker i projektionen, så
befintliga rader ser rätt ut direkt; nya skrivningar blir kanoniska och datan
konvergerar. En migrering är ett eget, opt-in-beslut.

⚠️ **`normalizeOrgNo` i index.js är ORÖRD.** Den används av synkvägarna
(Fortnox/Tengella-matchning, `findClientCompanyByOrgNo` som redan provar
raw/digits/hyphen) och är siffror-bara. Att lägga sekelhantering där hade ändrat
matchningsbeteende i en kedja det här uppdraget inte gäller.

### ⚠️ Fällan som cc_cache_smoke fångade
Cache-projektionen extraheras som **text** ur `index.js` och körs i en `new Function`
utan modulscope. Ett nytt cross-modul-anrop där kraschar sviten tills beroendet
injiceras i fabrikens signatur — precis som `bubbleFind`/`bubbleId`. Injiceras den
RIKTIGA `formatOrgNo` testas dessutom formateringen i sin skarpa kontext.

**Verifierat:** `companies_smoke.mjs` **543 gröna** · `cc_cache_smoke.mjs` **76**.
**Mutationstestat (14, alla faller):** påhittat nummer av ofullständig indata ·
sekelprefix ej strippat · `sameOrgNo("","")` sant · projektionen formaterar inte (2 sviter) ·
sökningen tappar sifferformen · skapa lagrar siffror · dubblettspärren jämför
råsträngar · tolvsiffrigt utan känt prefix strippas ändå · editen kanoniserar inte ·
editens dubblettspärr borta · editen validerar inte · tomt orgnr går inte att rensa.

⚠️ **Ärlig notering:** dubblettspärren i `/create` använder `sameOrgNo` men skulle
råka fungera med `===` idag, eftersom projektionen garanterar kanonisk form på båda
sidor. Djupet finns kvar för att det bara håller så länge projektionen gör det.

---
## 0k. FÖRETAGSLISTA + KUNDKORT + DRIFT (render-omtag av Bubble-native företagsvyn) — byggt 2026-08-13→18, ALLT LIVE

**Mål:** ersätta Bubbles native företagslista + expanderat kundkort (+ Drift-modul) med render-baserade HTML-block (samma DI-mönster som affär/sälj/produktion). Ingen Bubble-popup/workflow för kortet — allt är vy-växling i samma block. **Deploy-läge (2026-08-18): ALLT I DETTA AVSNITT ÄR DEPLOYAT OCH LIVE.** Christian deployar per feature (git→Render + klistrar om HTML-block). Enskilda sektioner nedan kan stå "(ej deployat)" — det var sant när de skrevs, men gäller inte längre. Senaste commit i sviten: `938a18b fix user`.

### SESSION 2026-08-17→18 — sammanfattning (allt LIVE)
Sessionen började som feature-arbete, blev en WU-jakt, och slutade i tre produktionsbuggar.
1. **WU-städning (P0–P4).** Ett `setInterval` svepte hela ClientCompany var 10:e minut dygnet runt ≈ **13 000 WU/dygn**, 78 % av idle-golvet. Borttaget + delta-refresh på `Modified Date`. Plus: två ocachade helsvep-endpoints, `_users()`-TTL, dolt N+1 i drift-listan (91 `bubbleGet` för 40 rader), oindexerbart `is_empty` i e-postpollern, Sales-KPI 4h→24h, `MODIFIED_DAYS_BACK` 3→2.
2. **Avtal-fliken:** `mira-abonnemang-kund.html` + `mira-approval-create.html` (~4 700 rader) inflyttade i kundkortet. Full CRUD: skapa / mall-wizard / PDF-import / redigera / pausa / avsluta + signeringar.
3. **Tre följdbuggar i porten:** CSS-läcka (82 oscopade selektorer — `.hidden` släckte hela Bubble-sidan) · modal-stacking (tre separata z-index-fel) · panel-flytt-arkitekturen som håller formulär vid liv genom kortets re-render.
4. **Företagslistan:** sortering på "senast ändrad" (aggregat över sex typer) + hantering av döda företags-id efter en 400-storm i Render.
5. **Kundkortet:** skapa affär av lead/aktivitet.
6. **Tre produktionsbuggar:** `writer` sattes aldrig på nya aktiviteter · `used_at` sprängde token-bränningen (reset-länkar återanvändbara) · `User_role` saknades på nya konton (utkastad från dashboard_crm).

**Verifieringsläge:** 14 smoke-sviter, **531 assertions, alla gröna**. Nya tester är genomgående **mutationstestade** (`git stash push <fil>` → testerna MÅSTE falla mot gammal kod, annars bevisar de inget).

### Mass-sättning av Region utifrån Kundansvarig — BYGGT 2026-08-19, EJ DEPLOYAT
Regionsindelningen är gles på ClientCompany men kundansvarig är satt — ansvarig → region är därför en tillräckligt bra härledning för att fylla luckorna. `POST /admin/companies/region-bulk` (companies_api.js) + `region_bulk.sh`.

- **Anrop:** `{ mapping: {"andriette@carotte.se":"Öst", …} | [{email,region}], dry_run, force, limit }`. Mappningen är **indata**, inte hårdkodad — kör om när ansvarsfördelningen ändras.
- **⚠️ FYLLER BARA TOMMA (Christians beslut).** Bolag som redan har ett regionvärde rörs ALDRIG. De rapporteras ändå som `conflicts` med namn + nuvarande värde, så avvikelserna går att titta på separat. Omkörning är en no-op.
- **⚠️ Regionvärdet valideras mot de värden som FAKTISKT förekommer i datan** (samma `_facets`-härledning som inline-editen) → felstavning ger `400 unknown_region_value` + `known_regions`, inte 300 företag med skräp i. Nytt värde kräver `force:true`. **Obs:** målgruppsfliken har fortfarande hårdkodade region-chips (`Öst/Väst/Syd/Nord` i `mira-kommunikation-admin.html`) — de är INTE härledda och kan drifta från option-setet.
- **`dry_run:true` är default** — man måste be om att skriva. Torrkörningen redovisar per ansvarig: antal bolag · skulle sättas · redan rätt · avvikelser, med exempelnamn.
- **WU:** läser ur `sharedCompanyFullMap()` (`ansvarig_id` + `region` finns redan i `_projectCompany`) → **noll nya helsvep**. Skriver i klumpar om 5 och uppdaterar `companyPatchEntry` så listan/kortet visar nya regionen direkt. `limit` (default 2000) kapar och redovisar `remaining` — ingen tyst avkortning.
- **Fel på enskild rad stoppar inte resten** (rapporteras i `failed` med företagsnamn).
- **Kör:** `PLANNING_ADMIN_TOKEN=… ./region_bulk.sh region_map.json` (torrkörning) → `--apply` (frågar "ja"). `/admin/companies` ligger redan i openPrefixes.
- **Verifierat:** `malgrupp_smoke.mjs` 68/68, **mutationstestat på logiken** (inte bara filborttagning): görs "fyll bara tomma" om till "skriv över allt" faller 8 assertions inkl. "cc3 rördes ALDRIG"; tas regionvalideringen bort faller 2; görs torrkörning icke-default faller 4. Regression: samtliga 16 sviter gröna.
- **Deploy:** `companies_api.js` + `index.js` (Render). Inga Bubble-ändringar.


### Bransch-filter + kolumnerna Fastighet/Region — BYGGT 2026-08-21, EJ DEPLOYAT

Filterraden fick **Bransch**, tabellen fick **Region** och **Fastighet**, båda redigerbara inline.

- **⚠️ MOMENT 22 I `_facets` — det var den egentliga buggen.** `_facets()` härleder
  option-set-värden UR DATAN, och `PATCH /admin/companies/:id` validerar mot samma
  facetter. Ett fält som är **tomt på alla företag har därför inga giltiga värden** →
  det går varken att filtrera på **eller att skriva i**, för alltid. `Bransch` var
  precis så i produktion. Ett filter byggt på facetterna hade blivit tomt, och en
  redigerbar kolumn hade svarat `unknown_optionset_value` på varje värde.
- **Fix: `OPTIONSET_SEED` i companies_api.js** — de 14 värdena ur Bubbles option-set
  `Bransch` (skärmdump 2026-08-21: Bank · Investmentbolag · Fastigheter · Mat & dryck ·
  Fordon · Bygg · Tillverkning · Konsumentvaror · IT-tjänster · Digitala program ·
  Offentlig verksamhet · Konsulttjänster · Hotell · Övriga tjänster). Seeden är
  **UNION med datan** — ett värde som finns i Bubble men inte i seeden faller aldrig
  ur (t.ex. gamla `IT`). Sorteras på svenska som övriga facetter.
- **⚠️ Detta är ett medvetet avsteg från "härled aldrig, hårdkoda aldrig option-set".**
  Regeln finns för att vi inte ska GISSA värden ([[reference-bubble-option-sets]]) —
  här är de avlästa, och alternativet är ett fält som aldrig kan fyllas. **Priset:
  ändras option-setet i Bubble måste `OPTIONSET_SEED` uppdateras**, annars går det nya
  värdet inte att sätta förrän något företag redan har det. Seeden gäller BARA
  `bransch`; `region` m.fl. härleds som förut (regressionstestat).
- **Fastighet är ett LIST-fält** (`ClientCompany.Fastighet`, List of Fastighet) — ny
  edit-typ **`reflist`** i `EDITABLE`/PATCH som skriver hela arrayen (samma mönster som
  `Leverantör.Kundföretag` / `Hyresvärd.Hyresgäster`). Dedupar, tom lista rensar,
  accepterar array eller kommaseparerad sträng. **Okänt fastighets-id → `400
  unknown_ref_id`** i st.f. att låta Bubble braka med 400 MISSING_DATA (jfr `_deadRefId`).
- **⚠️ Varför inte en vanlig dropdown:** en select hade ERSATT hela listan — ett bolag
  med två fastigheter tappar den ena tyst så fort någon redigerar. Cellen visar därför
  en chip per fastighet med ×, plus en "lägg till"-dropdown. Varje add/remove är en egen
  PATCH med hela nya listan; editorn står kvar öppen så man kan lägga till flera.
- **⚠️ Klick-ordning (samma fälla som deal-formuläret):** `data-flrm` (chip-×) och
  `data-flclose` ("Klar") ligger INNE i den redigerbara cellen och måste hanteras
  **före** den generella `data-flcell`-grenen, plus en `data-editing`-vakt på
  cell-grenen. Utan det faller varje klick i editorn igenom till `beginEdit`.
- **`SORT_GETTERS.fastighet`** sorterar på den sammanslagna etiketten (tomma sist).
  ⚠️ Saknas den faller servern TYST tillbaka på `sort=name` — testet måste därför ge en
  ordning som skiljer sig från namnsorteringen, annars är det grönt utan att bevisa något.
- **Region krävde ingen backend** — låg redan i `EDITABLE`. Ren kolumn + cell.
- **WU: noll nya anrop.** Allt (`bransch`, `region`, `fastighet_ids`) ligger redan i
  `_projectCompany`; `_fastigheter()`-cachen hämtas bara om ett reflist-fält skrivs.
  `min-width` på tabellen 1050 → 1290 px för de två kolumnerna.
- **Verifierat:** companies_smoke **226/226** (+25), **mutationstestat** — mot gammal kod
  faller 21 av dem (`git stash push companies_api.js mira-foretag-lista.html`). Frontend-
  assertionerna greppar **strippad** kod (kommentarsrader bortfiltrerade). Regression:
  samtliga 20 sviter gröna. Browser-harness (mockad fetch, localhost): editorn öppnas med
  rätt chips och en dropdown utan redan valda värden · add skickar HELA listan (f1 bevaras)
  · × tar bort · tomt läge → "—" och går att fylla igen · klick på chippen mitt i
  editering faller INTE igenom · Bransch-filtret ger 15 värden + "Alla branscher",
  filtrerar och rensas · Region/Bransch inline-edit på ett tomt bolag.
- **Deploy:** `companies_api.js` (Render) + klistra om `mira-foretag-lista.html`.
  Ingen Bubble-ändring, ingen ny bindning.

### Fastighet på kundkortet + "Vilka av VÅRA bolag fakturerar kunden" — BYGGT 2026-08-21, EJ DEPLOYAT

Två saker: (1) fastighetsredigeringen från listan finns nu även på kundkortet,
(2) ny märkning av vilka av Staff / Food & Event / Housekeeping / Group som
fakturerar kunden — badges på kortet + filter i listan.

**Fastighet på kortet**
- Läsvyn visar **alltid** Fastighet-raden (även tom → `—`). Förut doldes den när
  listan var tom, så det gick inte att se att fältet fanns.
- Redigeringsformuläret fick ett chips-fält, samma modell som listcellen.
- **⚠️ Skillnad mot listan: här STAGEAS ändringarna** (`STATE.cardFast`) och skickas
  först vid Spara. Listan patchar per chip; kortet får inte göra det, för kortet har
  en **Avbryt**-knapp och en redan skriven chip hade inte gått att ångra. Avbryt måste
  betyda avbryt. Staging nollställs vid Spara/Avbryt/flikbyte/nytt kort.
- **⚠️ Chip-ändring anropar ALDRIG `renderCard()`** — bara `redrawCardFast()`, som
  punktuppdaterar fältets egen DOM. `renderCard()` ritar om hela kortet och hade
  raderat text man skrivit i de andra formulärfälten (samma fälla som deal-formuläret).
  Harness-verifierat: text i Web-fältet ligger kvar genom både add och remove.

**Våra bolag (Staff / F&E / Housekeeping / Group)**
- **Källa: `FortnoxInvoice`, härlett ur SAMMA faktura-scan som omsättningen** →
  **noll nya Bubble-anrop**. `_loadCompanyRevenue` bygger nu även
  `bolag`: Map(companyId → { bolagsnamn: senaste fakturadatum }).
  Getter: `sharedCompanyBolagMapWarm()`.
- **⚠️ FÄLTNAMN: `FortnoxInvoice.connection_id` — men `FortnoxOrder`/`FortnoxOffer`
  använder `connection`.** Se backfill-tabellen i `invoice_sync.js` (~1061). Fel av de
  två ger TYST noll, inte fel. Smoke-testat mot den riktiga koden: en faktura med
  `connection` i stället för `connection_id` märker inget bolag.
- **⚠️ GROUP RÄKNAS MED HÄR, men fortsätter exkluderas ur omsättningen.** Frågan "vem
  fakturerar kunden" är en annan än "vad ska mätas". Bolaget registreras därför
  **FÖRE** `if (cid === GROUP_CONNECTION_ID) continue` — flyttas raden ned försvinner
  Group-badgen tyst medan omsättningssiffrorna ser helt korrekta ut. Regressionsvakt
  i `cc_cache_smoke`: Group-fakturan (9999) får aldrig hamna i omsättningssumman.
- **⚠️ `TENGELLA_CONNECTION_ID` är env-överskrivbar, `CONNECTION_NAMES` är hårdkodad.**
  `_bolagName` matchar därför env-värdet FÖRE tabellen — annars tappas Housekeeping
  tyst om env-varen någonsin ändras. Okänd anslutning får namnet
  `Connection <6 sista>` och syns i filtret; den döljs aldrig.
- **Fönstret: rullande 12 mån** (Christians beslut 2026-08-21) = `BOLAG_WINDOW_MS` i
  companies_api. Kartan bär **datum, inte flaggor**, så gränsen kan ändras på ett ställe
  utan att något behöver byggas om. Kalenderår valdes bort: då nollställs alla badgar
  vid årsskiftet och en kund fakturerad i november ser passiv ut i januari.
- **Kortet:** badge-rad "FAKTURERAS AV" under företagsnamnet, bredvid kundstatus-pillret.
  Aktiv = fylld färg per bolag; bolag som fakturerat **tidigare** visas som nedtonad
  kontur med senaste fakturadatum i `title`. Fakturerar ingen: "Ingen fakturering".
- **Listan:** filter "Alla våra bolag". ⚠️ Bolagsfiltret kan inte ligga i list-loopens
  continue-kedja — `bolag` finns inte i cache-projektionen utan härleds ur faktura-kartan
  + fönstret, så det filtreras på den färdiga raden.
- **⚠️ TOM DATA ÄR ALDRIG ETT SVAR — det farligaste i hela funktionen.** Faktura-cachen
  värms LAT. Är den kall ger bolagsfiltret 0 rader, och "Inga företag matchar" hade lästs
  som "ingen kund faktureras av Staff". Därför bär svaret **`bolag_ready`** (= samma
  readiness som omsättningen, samma svep) och frontenden säger "Beräknar vilka bolag som
  fakturerar…" i stället. Samma sak på kortet: badgen visar "beräknar bolag…", aldrig
  "Ingen fakturering". Filtrets värdelista innehåller alltid de fyra bolagen, även kall.
- **Ingen Bolag-kolumn i listan** (raden bär `bolag`/`bolag_all` redan — kolumnen är
  ~5 rader om den önskas). Filter + kortbadges var det som beställdes.
- **Verifierat:** companies_smoke **250/250** (+24) · cc_cache_smoke **71/71** (+10,
  kör RIKTIG index.js-källa mot fakturafixturer) · **mutationstestat: 23 faller** mot
  `9a6f514`. Samtliga 20 sviter gröna. Browser-harness: filter (Staff→1 träff,
  HK→0 eftersom 700 dagar sedan), kall karta→"Beräknar…", kortbadges för alla tre
  fallen (aktiv / tidigare / ingen), och fastighets-staging (0 PATCH under redigering,
  Avbryt återställer, Spara skickar exakt en PATCH med hela listan, text i andra fält
  överlever). Inga konsolfel.
- **⚠️ Testlärdom (igen):** första versionen av bolagstesterna **kraschade** mot gammal
  kod i st.f. att falla, och dolde då 20 andra fel. Assertions mot fält som kan saknas
  måste skrivas defensivt (`(x || [])`). Samma sak i cc_cache: `slice()` som inte hittar
  blocket rapporteras nu som ett FEL i st.f. att kasta och döda hela sviten.
- **Deploy:** `index.js` + `companies_api.js` (Render) + klistra om
  `mira-foretag-lista.html`. Ingen Bubble-ändring, ingen ny bindning.

### ⚠️ "[object Object]" i fastighetslistan — löst 2026-08-21

**Symptom (skarpt, Christians skärmdump):** filtret "Alla fastigheter" listade rad efter
rad med `[object Object]`. Samma sak i den nya Fastighet-kolumnen och i kortets chips —
alla tre delar samma namnkarta.

- **Rotorsak:** `_fastigheter()` hämtade namnet med
  `_str(f.Namn || f.name || f.Name || f.Adress || f.address || f.title || f.Titel)`.
  **Fastighet har inget `Namn`-fält — namnet ligger i `Titel`** — och **`Adress` är ett
  geographic address-OBJEKT**. Kedjan träffade alltså `Adress` FÖRE `Titel`, och
  `String({address:…})` blir `"[object Object]"`.
  Schema verifierat mot Bubble-editorn: `Adress`(geo) · `Bild` · `Bildspel` ·
  `Coworker` · `Hyresgäster` · `Kluster` · `Kontor` · `Leverantör` · `Medarbetare` ·
  `Region` · **`Titel`(text)** · `Ägare`.
- **Fix:** `_fastighetName()` — **Titel först**, adressen bara som **textfallback**
  (`a.address` plockas ut explicit), och `_cleanName()` som vägrar göra ett objekt till
  ett namn (förkastar även en redan stringifierad `"[object Object]"`). Namnlösa
  fastigheter utelämnas men **loggas** (`[fastigheter] N av M saknar namn`) — tyst
  bortfall är hur felet kunde leva vidare.
- **Frontend-bälte:** `selOpts` renderade `it.name` rakt av. Nu faller den tillbaka på
  **värdet (id:t)** om namnet saknas eller är ett objekt. Ett rått id säger "något är
  fel"; `"[object Object]"` ser ut som data. Dölj det aldrig med tom sträng.
- **⚠️ VARFÖR TESTERNA VAR GRÖNA HELA TIDEN:** fixturen i `companies_smoke` skrev
  `Fastighet: [{_id:"f1", Namn:"Kungsgatan 1"}]` — **ett fält som inte finns i Bubble**.
  Mocken var alltså mer förlåtande än verkligheten, exakt samma klass som `used_at`-buggen
  (2026-08-18) och samma lärdom: **fixturer ska spegla det VERIFIERADE schemat**, annars
  testar de en påhittad värld. Fixturen bär nu `Titel` + `Adress:{address}`, plus en
  fastighet med bara adress och en helt namnlös.
- **Verifierat:** companies_smoke **256/256** (+6). **Mutationstestat: 8 faller** — och
  tre av dem är BEFINTLIGA tester (`list resolvar fastigheter`, office-normaliseraren,
  `patch fastighet`) som var tyst gröna med den påhittade fixturen. Samtliga 20 sviter gröna.
- **Deploy:** `companies_api.js` + klistra om `mira-foretag-lista.html`.

#### Följdfel: filtret visade skräp ÄVEN efter att backend rättats (löst samma dag)
Backend svarade rätt (`/meta` gav 13 fastigheter, 0 trasiga namn) men dropdownen i
listan visade fortfarande `[object Object]` — medan **kundkortet var rätt**. Den
skillnaden var ledtråden: kortet hämtar sitt eget `/card`, listan ritar filterraden.

- **Rotorsak:** filterraden ritas **BARA en gång** (`if(!$("filters").innerHTML)
  renderFilters()`) — ett medvetet val, för annars tappar sökfältet fokus/caret vid
  varje debounce-reload. Priset var att dropdownarnas INNEHÅLL frystes vid sessionens
  **första** svar, och det kom ur `sessionStorage` (TTL 15 min), skrivet **före**
  deployen. **Inte ens Uppdatera-knappen hjälpte** — den kör `cacheClearAll()+reload()`,
  men vakten satt på `innerHTML`, inte på cachen, så raden ritades aldrig om.
- **Fix i två lager:**
  1. **`CACHE_VER`** i `ckey()`/`cardKey()` → payloads skrivna av en äldre blockversion
     matchar aldrig. **⚠️ Bumpa den när svarets form eller meta-innehåll ändras.**
  2. **`syncFilterOptions()`** — skelettet ritas fortfarande en gång, men OPTIONS
     synkas vid varje färskt svar. Rör bara `[data-flf]`-selecten (**aldrig** sökfältet
     — det var hela skälet till render-once), hoppar över en select som är
     `document.activeElement` (rycker inte undan en öppen dropdown) och återställer
     valt värde efteråt.
- **Verifierat i harness som reproducerar felet:** en filterrad manuellt satt till
  `[object Object]` självläker vid nästa svar · en fokuserad dropdown lämnas orörd ·
  valt värde överlever en reload · sökfältet behåller fokus OCH text medan synken kör.
  companies_smoke **261/261**, **mutationstestat: 5 faller**.
- **Lärdom:** en render-once-optimering fryser inte bara layouten utan **datan i den**.
  Ritas något en gång måste innehållet ha en egen synkväg — annars överlever ett
  rättat serverfel i klienten, och symtomet ser ut som att fixen inte gick fram.

### Nästa steg-grinden + levande aktivitet/todo — BYGGT 2026-08-21, EJ DEPLOYAT

Två saker: (1) en genomförd aktivitet får inte lämnas utan beslut, (2) kundkortet
visar om något faktiskt är planerat framåt.

#### Bubble-fältet — SKAPAT 2026-08-21 ✅
**`aktivitet_nasta_steg` på `activitet_crm`** — ett **Option Set** med samma namn.
Värden: `aktivitet` · `todo` · `avslutat`. (Verifierat mot Bubble-editorn.)

**⚠️ Två avvikelser mot första antagandet, båda hade brutit TYST:**
1. Fältet heter **`aktivitet_nasta_steg`**, inte `nasta_steg`. Fel nyckel → 400 på hela
   skrivningen, eller (med nedgraderingen) ett tyst tappat val vid varje sparning.
   Regressionsvakt: `companies_smoke` kräver att nyckeln `nasta_steg` **aldrig** skrivs.
2. Det är ett **Option Set, inte text** → läses tillbaka som sträng **eller** som
   `{display}`-objekt. `String(objekt)` ger `"[object Object]"`, vilket hade fått
   läs-tillbaka-verifieringen att flagga fältet som saknat fast allt sparats rätt —
   alltså **falsklarm** till användaren. Löst med `_osStr()` i båda modulerna, och
   testat med en mock som svarar i objektform. Se [[reference-bubble-option-sets]].
Modulerna får **RÅ `bubbleCreate`/`bubblePatch`** (inte `safeCreate`) → ett okänt fält
ger 400 och **hela skrivningen avvisas**. Utan skyddsnätet nedan hade en Render-deploy
före fältet fanns **blockerat användarna från att spara sina möten**.
- **Mjuk nedgradering:** skrivningen försöks med fältet; svarar Bubble exakt
  `Unrecognized field: nasta_steg` skrivs den om **utan** fältet och svaret bär
  `nasta_steg_field_missing:true`. Matchningen är **SMAL** (400 + exakt fältnamnet) —
  andra okända fält och 5xx måste fortsätta braka, jfr `_deadRefId`.
- **Läs-tillbaka:** fältet verifieras mot den sparade raden; `null` = kunde inte
  verifieras, aldrig "saknas" ([[reference-bubble-tysta-faltdrop]]).
- **UI:t säger det rakt ut** i en banner ovanför historikflödet.

#### Grinden — REGELN SKÄRPT 2026-08-21 (andra iterationen)
**Första versionen grindade bara ÖVERGÅNGEN ej→genomförd.** Christian öppnade en redan
genomförd aktivitet i affärsvyn och såg ingen grind — helt enligt den regeln, men fel
mot intentionen: de **348 redan avbockade aktiviteterna** hade då aldrig omfattats av
kravet. Regeln är nu:

> Grinda om sparningen rör **avklarandet** (`genomfört` eller `mötesantecking`),
> resultatet är **genomfört**, och **inget beslut finns** — varken inkommande eller
> redan lagrat i `aktivitet_nasta_steg`.

- **Gammalt genomfört möte utan beslut → grindas** när någon rör anteckningen/bocken.
  Så betas backloggen av i takt med att man arbetar med mötena.
- **Rad som redan har ett beslut → frågas aldrig igen.**
- **Sparningar som inte rör avklarandet blockeras INTE** (`fas`, `beskrivning`,
  affärskoppling). Att kräva ett uppföljningsbeslut för att rätta ett stavfel vore
  ren friktion — och hade blockerat "Koppla till affär" i affärsvyn.
- ⚠️ Kontrollen av lagrat beslut läser **OS-medvetet** (`_osStr`). Ett `{display}`-objekt
  hade annars alltid sett ut som ett värde och **tyst avaktiverat grinden** för rader
  som saknar beslut.
- Kortets detaljvy visar nu raden **"Nästa steg"** på genomförda aktiviteter
  (`Ny aktivitet bokad` / `Att-göra skapad` / `Spåret avslutat` / `— ej beslutat —`).
- Servern grindar (`400 nasta_steg_krävs` / `okänt_nasta_steg` + `allowed`), frontenden
  är UX-lagret. Båda vyerna: **kundkortets Historik** (`mira-foretag-lista.html`) och
  **affärsvyns aktivitet** (`mira-affar-samlad.html`, både redigera och skapa).
- **⚠️ ORDNING: uppföljaren skapas FÖRE aktiviteten sparas.** Faller den sparas
  ingenting. Motsatt ordning kan lämna mötet genomfört med `nasta_steg="aktivitet"`
  utan att någon aktivitet finns — en lögn i datan. En föräldralös todo är i jämförelse
  ofarlig (den syns och kan tas bort).
- Uppföljaren ärver kund (och i affärsvyn även affär). Todo skapas via
  `POST /admin/affar/todo/create` — företags-agnostisk, återanvänds från kortet.
- **Todo-formuläret har BÅDE `Startdatum` och `Klart senast`** (2026-08-21). En
  uppföljning kan planeras långt fram — "ta detta om 12 månader" — och då är
  **starttiden** det som betyder något, inte deadline. Backend stödde `starttid`
  redan; det var bara formulären som saknade fältet. Gäller alla tre vyerna plus
  den fristående todo-formen på kortets Hem-flik.
- **⚠️ Minst ETT av datumen krävs.** En todo utan `Starttid` och `Sluttid` dyker
  aldrig upp i kortets levande-panel (som räknar framtida start **eller** slut) →
  man hade skapat en osynlig uppföljning och trott att kunden var täckt. Valideras
  i alla fyra formulären.
- **✅ ALLA TRE SKRIVARNA GRINDAR NU** (stängt 2026-08-21): `companies_api`
  (kundkortet), `affar_api` (affärsvyn) och **`salj_api`** (`/admin/salj/mote/:id/patch`,
  mötesbokningsvyn `mira-motesbokning.html`). Samma regel, samma fält, samma felkoder.
- **Mötesbokningsvyn skapar uppföljaren fullt ut** — precis som de andra två.
  ⚠️ Jag påstod först att den saknade kundkontext; **det var fel**. `activitet_crm`
  har `company` (enda kund-fältet) och `nMote` resolvade redan företagsNAMNET — det
  som saknades var bara **id:t** i radens payload. `nMote` bär nu `company_id`, och
  uppföljaren ärver **både företag och affär** (`deal_id` fanns redan). Ingen gissning
  någonstans. Lärdom: kontrollera vad raden FAKTISKT bär innan man drar en
  begränsning ur att ett fält inte syns i normaliseraren.
- Formuläret visar vilket företag (och ev. affär) uppföljaren knyts till, och säger
  **"Mötet saknar kundkoppling"** rakt ut om `company_id` är tomt — i st.f. att tyst
  skapa en lös aktivitet.

#### Levande aktivitet/todo (kundkortets Hem-flik)
- **Definition (Christians beslut):** datum framåt **OCH** inte avklarat.
  Aktivitet: `Datum_bokning` > nu och `genomfört` !== true.
  Todo: `Starttid` **eller** `Sluttid` > nu och `Status` !== `Avslutad`.
- **Todo-fälten är verifierade** (skärmdump 2026-08-07,
  [[reference-bubble-todo-fields]]): `Företag` · `Starttid`/`Sluttid` · `Status` · `Titel`.
  Gissa aldrig här — fel fältnamn ger tyst noll, och noll läses som "inget bokat",
  raka motsatsen till sanningen.
- **WU: +1 anrop per kortöppning.** Aktivitetsraderna hämtades redan för `histCount`
  och återanvänds; bara Todo är en ny fråga.
- **⚠️ `nasta.ok:false` = OKÄNT, inte "inget planerat".** Faller Todo-frågan säger
  kortet det rakt ut i st.f. att visa skapa-knappar för en kund som har fullt upp.
- Utan levande poster: tydliga **+ Boka aktivitet** / **+ Skapa att-göra** intill
  Snabbåtgärder. Todo-formuläret ligger direkt på Hem.

#### Verifierat
- companies_smoke **299/299** · affar_create_smoke **46/46** · salj_smoke **65/65**.
  Samtliga 20 sviter gröna.
- **Mutationstestat mot `3c83b3d`:** 6 · 4 · 20 faller.
- Harness: todo med **bara startdatum 12 mån fram** går igenom och skickar
  `starttid` (tom `sluttid`); todo helt utan datum blockeras i både grinden och
  Hem-formuläret.
- **⚠️ Browser-harnessen fångade en tredje bugg som smoken inte kunde se:** i
  mötesbokningsvyn hamnade `nsSelect`/`nsPick`/`nsCreateFollow` **inuti**
  render-funktionens scope i st.f. på IIFE-nivå. Grinden RENDERADES (grep-testerna
  var gröna) men klickhanteraren fick `nsSelect is not defined` → knapparna gjorde
  ingenting och funktionen var oanvändbar. Regressionsvakt: greppet kräver nu
  deklaration med **två blankstegs indrag** (IIFE-nivå), inte fyra.
  **Lärdom: en grep som bara bevisar att koden FINNS bevisar inte att den är NÅBAR.**
- Harness i mötesbokningsvyn: grinden dold tills Genomfört bockas · blockerad utan val ·
  blockerad utan datum/titel · uppföljaren skapas FÖRE mötet och knyts till rätt
  företag (`cc2`) resp. rätt företag + affär (`cc1`/`d1`) · redan beslutad rad visar
  ingen grind alls.
- **Browser-harness fångade två buggar som smoken aldrig hade sett:**
  1. `STATE.chain.historik=null` → `historikBody(null)` kraschade på `rows.length`.
     Chain-cachens "hämta om"-sentinel är **`undefined`**, inte null. Regressionsvakt
     finns nu (`delete STATE.chain.historik`).
  2. "Fältet saknas"-varningen skrevs i formuläret som revs av re-rendern direkt
     efteråt → ingen hann läsa den. Ligger nu i `STATE.nsWarn` som en stängbar banner.
- Harness i övrigt: grinden dold tills Kundmöte+Genomfört · blockerad utan val ·
  blockerad utan datum/titel · anteckningstexten överlever segmentklicket · alla tre
  vägarna skickar rätt anrop i rätt ordning · redan genomförd rad sparas utan fråga ·
  levande-panelen i alla tre lägen (poster / inget / okänt).
- **⚠️ Testlärdom, TREDJE gången:** `tf.body.nasta.ok` **kraschade** mot gammal kod i
  st.f. att falla och dolde 20 andra fel. Assertions mot fält som kan saknas måste
  skrivas `(x || {})`. Samma fälla: roles 2026-08-18, bolag 2026-08-21.

#### Deploy
1. ✅ Bubble-fältet finns redan (`aktivitet_nasta_steg`, Option Set).
2. `index.js` oförändrad. Deploya `companies_api.js` + `affar_api.js` + **`salj_api.js`**.
3. Klistra om **`mira-foretag-lista.html`**, **`mira-affar-samlad.html`** OCH
   **`mira-motesbokning.html`**.

**Gör steg 2 och 3 tillsammans.** Backend med gammal frontend 400:ar för den som
bockar "Genomfört" (gamla frontenden skickar inget `nasta_steg`).

### ⚠️ "Vår personal" visade även KUNDENS users — löst 2026-08-22

Inställningar → Leverantörer → "Vår personal" listade både Carottare och kundens egna
användare. Den ska bara visa **våra**; kundens folk finns under Personer-fliken.

- **Rotorsak:** `_personnel` hämtade `User` där `Associated_company contains <företag>`.
  Det matchar **alla** som har företaget i sin lista — inklusive kundens egna users, som
  naturligt har sitt eget bolag där. Add-**poolen** var redan filtrerad på
  `Company == user_company`, men den visade **listan** var det inte.
- **Fix:** listan filtreras nu också på `Company === user_company` (den inloggade
  Carotte-userns bolag). Dedup mot add-poolen sker fortfarande mot **alla** kopplade,
  så en kund-user inte råkar dyka upp som "tillgänglig".
- **⚠️ Utan `user_company`-bindningen går de inte att skilja åt.** Då filtreras inget
  bort och svaret bär `personnel_unfiltered:true` — kortet säger rakt ut att listan kan
  innehålla kundens användare. Ett tyst fel filter vore värre än en synlig varning.
- **⚠️ `.catch(() => [])` borttaget** på båda User-frågorna (bröt arbetsregeln). En
  fallen fråga hade lästs som "ingen personal kopplad". Nu: `personnel_ok:false` och
  kortet säger "Det betyder inte att ingen är kopplad".
- **⚠️ Fixturen testade en värld där skillnaden inte fanns:** `u1` (Company `cc1`) var
  kundens EGEN user och stod som "Vår personal" — och testet var grönt. Fixturen har nu
  både sorterna kopplade till samma kund: `u1` (kundens) och `u3` (Carotte, Company
  `cc2`). Samma lärdom som Fastighet-schemat: **en fixtur som inte kan uttrycka felet
  kan inte fånga det.**
- **Verifierat:** companies_smoke **311/311**, mutationstestat (6 faller). Deploy:
  `companies_api.js` + klistra om `mira-foretag-lista.html`.

### Mötestratten: filter på skapad-datum + total i rubriken — 2026-08-22

Tratten filtrerade bara på **mötesdatum** (`Datum_bokning`). Nu finns även ett
oberoende filter på **skapad-datum** (`Created Date`), så man kan svara på "hur många
möten bokades i augusti" — en annan fråga än "hur många möten hålls i augusti".

- `GET /admin/salj/moten?cfrom=&cto=` — kombineras fritt med `from`/`to`.
  `nMote` bär nu `skapad`/`skapad_ts`.
- **⚠️ Ett möte utan skapad-datum passerar INTE ett skapad-filter.** Annars hade
  "möten skapade i augusti" innehållit rader vi inget vet om. Eget test.
- **Totalen visas i trattens rubrik** (`.fas-total`, samma form som fas-räknarna).
  **⚠️ Etiketten följer vilket filter som är på** — "Möten skapade i perioden" vs
  "Möten med mötesdatum i perioden" vs "Alla möten i tratten". Svaret bär
  `filter:{motesdatum,skapad}` just för det: samma siffra får inte påstå två olika
  frågor. Filterraden är rubricerad i två par (Mötesdatum / Skapade).
- **Verifierat:** salj_smoke **76/76**, mutationstestat (9 faller). Det avgörande
  testet: `cm3` hålls i juni men bokades i augusti — den skiljer filtren åt.
  **⚠️ Testlärdom (fjärde gången):** `x.body.filter.skapad` kraschade mot gammal kod
  i st.f. att falla och dolde 7 fel. Assertions mot fält som kan saknas: `(x || {})`.
- **Deploy:** `salj_api.js` + klistra om `mira-motesbokning.html`.

### Onboarding — kundresans status (sign → leveransklar) — LIVE 2026-08-24

Ny strip både på **kundkortets Hem-flik** och **affärsvyns utfällda affärskort**.
Fem-stegs-modell — steg 1 (avtal) och steg 2 (Mira teknisk setup) + steg 4
(utbildning) är SKARPA; steg 3 (kick-off) och steg 5 (leveransklar) är MOCKAR
tydligt märkta "Ej live" tills organisationen bestämt hur de ska mätas.

- **Ny endpoint:** `GET /admin/companies/:id/onboarding` (companies_api.js). Fem
  parallella delkrav-frågor. **⚠️ Ingen check får svara "tyst 0" när Bubble-frågan
  faller** — varje check bär eget `ok:false` + `mira.uncertain:true` (samma regel
  som `revenue_ready`/`bolag_ready`/`personnel_ok`). Score/total tar INTE med
  osäkra checks → en fungerande setup ser inte ofullständig ut bara för att
  Bubble knuffar en 500:a.
- **De fem Mira-delkraven (fältnamn verifierade mot koden 2026-08-24):**
  - `office` = `Office where Kundföretag == id` (count)
  - `logo` = `ClientCompany.logotyp` icke-tom
  - `user` = `User where Company == id` (kundens EGNA users; singular-fält)
  - `supplier` = `Leverantör - Supplier where Kundföretag contains id`
  - `staff` = `User where Associated_company contains id AND Company == CAROTTE_COMPANY_ID`
- **⚠️ `CAROTTE_COMPANY_ID` env krävs för staff-checken.** Utan den kan vi inte
  skilja Carotte-users från kundens egna → svaret bär `staff.ok:false` + hint
  `carotte_company_id_missing`. Aldrig ett tyst 0. Env satt i Render
  (`1726738549743x453535655154064800`, verifierat skarpt).
- **⚠️ LOGOTYPEN LIGGER INTE I LIST-PROJEKTIONEN — fälla vid första deploy.**
  Första versionen läste `proj.logotyp` ur `sharedCompanyFullMap`; `_projectCompany`
  (index.js ~20400) bär bara filter-/sorterings-fält. `proj.logotyp` var alltid
  `undefined` → Carotte som HAR en logga visade "logo saknas". Fix: separat
  `bubbleGet("ClientCompany", id)` (samma som `/card`-endpointen redan gör).
  Regressionsvakt: onboarding_smoke:s fixtur speglar nu produktionen —
  `companyFullMap` returnerar projektion UTAN logotyp, `bubbleGet` returnerar raw
  MED logotyp. Går man tillbaka till `proj.logotyp` faller 4 tester.
- **Utbildning = `activitet_crm` med `activity_type="Utbildning"` + `genomfört=true`.**
  Christian har lagt värdet i Option Set `activity_crm_type` 2026-08-24. `AKT_TYPES`
  i `companies_api.js` utökad så samma grind- och nästa-steg-mekanik gäller
  (writer/todo/uppföljning) — inget nytt fält, ingen egen mekanik.
- **Frontend:**
  - Kundkortet (`mira-foretag-lista.html`, Hem-fliken): stor strip mellan hero
    och tabs. Fem stegs-kort + delkrav-chips undertill. Klick på chip/steg
    hoppar till rätt inställnings-subflik (t.ex. logo-checken → Inställningar →
    Logo). Mock-steg (kickoff/leverans) navigerar ingenstans.
  - Affärsvyn (`mira-affar-samlad.html`): kompakt strip precis under `deal-h` i
    den utfällda affärskortet. **Cachad per företag** (SWR): upprepade
    expand/kollaps triggar en fetch, fler affärer på samma kund delar cachen.
    Uppdaterar strippen in-place när svaret kommer (ingen re-render av hela
    affären → text i formulär överlever, samma fälla som deal-formuläret).
- **Verifierat skarpt 2026-08-24** mot Carotte (`1726738549743x…4800`):
  5/5 klart, avtal.count=10, utbildning.count=0 (rimligt — värdet har just tagits
  in), staff.count=40, user.count=72, supplier.count=4, office.count=5.
- **Smoke:** `onboarding_smoke.mjs` **36/36**, **mutationstestat**:
  1. tar bort `Company==CAROTTE`-filtret på staff → 2 tester faller (impostor räknas)
  2. utbildning-constraintet ändras till `genomfört=false` → 1 test faller
  3. office-frågan alltid tom → 6 tester faller
  4. gå tillbaka till `proj.logotyp` (buggen som Christian såg live) → 4 tester faller
  Regression: samtliga **21 sviter gröna (1598 assertions)**.
- **Deploy:** `companies_api.js` + `index.js` (env `CAROTTE_COMPANY_ID`) + klistra
  om `mira-foretag-lista.html` OCH `mira-affar-samlad.html`. Ingen ny `data-mira`.

**Steg 3–5 (mockar) — nästa organisatoriska beslut:**
- **Kick-off:** kan mappas till `activitet_crm` `activity_type="Kundmöte"` +
  `Kundmöte="Fas 1"` (fasnamn finns) — inget nytt fält, kan aktiveras utan
  endpoint-ändring.
- **Leveransklar:** kandidater = nytt yes/no-fält `leveransklar` på ClientCompany
  (manuell grön-flagga från Kundansvarig), eller härlett (alla föregående steg).
  Kräver beslut om VEM som får sätta det.

### Skapa företag i listvyn + Offert i affärsvyn — BYGGT 2026-08-24

Ersätter delar av den Bubble-native genvägsgruppen i headern. **Signering skippades**
— den finns redan på kundkortets Avtal-flik.

#### Skapa företag (`POST /admin/companies/create`)
Knapp **+ Nytt företag** i listvyns header, panel ovanför filterraden.
**Fältomfång medvetet smalt** (Christians mandat): **namn\* + org.nr\*** + kundansvarig
+ kundstatus. Resten fylls på kundkortet där fälten redan är redigerbara — samma
fältlogik ska inte underhållas på två ställen. Efter skapande **öppnas kortet direkt**.

- **⚠️ ORG.NR ÄR OBLIGATORISKT OCH DUBBLETTSPÄRRAT.** Med 5 499 rader och manuell
  inmatning är dubbletter en tidsfråga, och dyra att städa i efterhand.
  Jämförelsen sker på **SIFFROR** — datan bär både `5569748378` och `516409-6348`,
  så en strängjämförelse hade missat halva fallen. Verifierat i harness: `556974-8378`
  fångas mot befintliga `5569748378`.
- **Spärren nekar inte bara** — den pekar ut det befintliga företaget med
  **Öppna företaget** (det man nästan alltid ville) och **Skapa ändå** (`force:true`,
  för filial/legitima undantag). Längd valideras till 10 siffror.
- **Namnlikhet VARNAR men spärrar aldrig** — två bolag kan legitimt heta nästan lika.
- Kundstatus valideras mot facetterna, som inline-editen. **Dubblettkollen läser den
  delade cachen → noll nya Bubble-anrop.**
- **⚠️ Nya raden läses tillbaka och läggs in i `companyPatchEntry`** — annars syns
  företaget inte i listan förrän nästa helsvep (upp till 12 h). `verified:false`
  rapporteras till användaren.

#### Offert i affärsvyn — INGEN inflyttning behövdes
**+ Offert** både i Skapa nytt-raden (utan kontext) och i affärskortets actions-rad
(ärver kund + affär).

- **⚠️ Offertbyggaren (`mira-offert-admin.html`, 52k) hade REDAN ett modal-API:**
  `window.miraOffertModal.open({clientcompany, clientcompany_nm, deal, comission})`.
  Blockets egen kommentar sa rakt ut att *"affär-blocket öppnar via
  window.miraOffertModal"* — kontraktet fanns byggt, men affärsvyn ringde aldrig.
  **Därför ingen inflyttning, ingen dubblering, inget nytt eventkontrakt.**
  Lärdom: leta efter ett befintligt kontrakt innan man designar ett nytt.
- **⚠️ KRÄVER att offertblocket ligger på affärsvy-sidan med
  `data-mira="as_modal"` = `1`.** Bara as_modal-instansen registrerar globalen
  (blocket hanterar multi-instans själv). Saknas den säger knappen det RAKT UT —
  en knapp som tyst inte gör något är värre än ett felmeddelande.
- Offert är **Food & Event-specifik** (offert_api är F&E-modulen). Knappen är generell;
  det är värt att veta innan den erbjuds för HK/S&P-affärer.

#### Verifierat
- companies_smoke **325/325** · affar_create_smoke **82/82** · alla 20 sviter gröna ·
  **mutationstestat: 14 resp. 5 faller.**
- Harness: skapa-formuläret blockerar utan namn/org.nr, servern nekar fel längd,
  dubbletten fångas trots bindestreck och visar båda knapparna, "Skapa ändå" postar
  `force:true` och öppnar kortet. Generella **+ Offert** öppnar modalen med tom
  kontext och lämnar ingen tom inline-panel.
- **⚠️ Per-affär-knappen är verifierad via kodtest + mutation, INTE klickad i
  harness** — mock-feeden renderade inga affärsrader och att jaga rätt radform var
  inte värt tiden. Kontextärvningen (`kundforetag_id` + `deal`) är grep-testad och
  faller mot gammal kod.
- **⚠️ Testramens `call()` KASTADE på saknad route** → hela sviten dog på första
  anropet vid mutationstest och dolde 13 andra fel. Svarar nu `404 no_route` så
  testet FALLER begripligt. Samma klass av tyst missvisning som en assertion som
  kraschar i st.f. att falla — fjärde varianten i det här repot.
- **⚠️ Mocken var inkonsekvent med sig själv:** `bubbleCreate("ClientCompany")` skrev
  till `STORE` medan `bubbleGet` läser `CC` → en nyskapad rad var osynlig för
  läs-tillbaka och cache-insert. Rättad.

#### Deploy
`companies_api.js` → Render · klistra om `mira-foretag-lista.html` +
`mira-affar-samlad.html` · **lägg `mira-offert-admin.html` på affärsvy-sidan med
`as_modal=1`** · ta bort den native genvägsgruppen när båda är verifierade.

### Tre buggar rättade 2026-08-24 (efter offert-porten)

**1. Offertblocket i affärsvyn 401:ade på allt — såg ut som "Inga företag".**
Den inflyttade kopian bar **sin egen** `planning_token`-input med repo-filens
placeholder. Två inputs med samma `data-mira` i samma DOM → offertkoden läste sin
(placeholder), inte värdblockets riktiga.
- **Fix:** de dubblerade `api_host`/`planning_token`-inputsen är BORTA ur den
  inflyttade kopian, och `cfg` faller tillbaka på `document`-nivå → **en bindning,
  en plats**. Vaktat av test som räknar att det finns exakt EN token-bindning.
- **⚠️ `.catch(() => [])` i `loadCompanies` gjorde 401 till en tom lista** — alltså
  ett SVAR i st.f. ett fel, och användaren fick "Inga företag" på en söksträng som
  matchar 5 000 rader. Felet bärs nu vidare: *"Kunde inte hämta företagslistan:
  401 — fel eller saknad token"*. **Samma förbjudna mönster som arbetsreglerna
  varnar för — det överlevde inflyttningen för att jag kopierade blocket rakt av.**

**2. "Per månad" i avtalsrubriken visade 0 kr.**
Summeringen filtrerade på `contract_type === 'Subscription'` och uteslöt därmed
**HYBRID**-avtal, som per definition har en fast månadsdel. Sambla: rubriken sa
`0 kr`, raden under sa `124 560 kr/mån`, och kortets KPI sa `124 560 kr` — **tre tal,
samma vy.**
- **Fix:** inget typfilter. Summera månadskostnaden för allt **aktivt**, exakt som
  backend redan gör (`companies_api`: `if (isActive) mrr += månadskostnad`).
  RateCard har normalt 0 och faller bort av sig själv. Vaktat av test som kräver att
  frontend och backend har samma regel.
- **⚠️ KVAR (eget beslut, ej rättat):** "Aktiva **2 st**" i rubriken mot "Aktiva avtal
  **3**" på kortet. Frontend räknar `status ∈ {aktiv, utgar_snart}`, backend räknar
  "har inget passerat slutdatum". Sambla har ett avtal med status **OKÄND** som
  backend räknar som aktivt och frontend inte. Vilken definition som är rätt är en
  verksamhetsfråga — därför orörd.

**3. Mötestrattens "nästa steg" saknade fas.**
Ett Kundmöte utan fas hamnar i **Övrigt** i tratten — och tratten är hela poängen med
vyn. Fas-väljare tillagd, visas bara för Kundmöte (som i övriga formulär), **krävs**
för Kundmöte och skickas med till `aktivitet/create`.
- **⚠️ Samma lucka finns i kundkortets och affärsvyns nästa steg-formulär** — de
  skapar också Kundmöten utan fas. Ej rättat (Christian scopade till mötestratten).

**4. Skapa företag 400:ade: `Org_Number` skrevs som TAL.**
Bubble svarade `INVALID_DATA: Expected a string, but got a number`. **`Org_Number` är
ett TEXT-fält** (bekräftat i `index.js` ~1291 och av `EDITABLE.orgnr` som redan hade
`type:"text"`) — bara min create-endpoint skrev tal. Org.numret normaliseras
fortfarande till siffror för dubblettjämförelsen, men **skrivs som sträng**.

- **⚠️ VARFÖR TESTET INTE FÅNGADE DET:** smoke-mockens `bubbleCreate` svalde vad som
  helst — den var **mer tillåtande än Bubble**. Exakt samma klass som `used_at`
  (2026-08-18) och `Namn`-fixturen på Fastighet. Mocken validerar nu typerna för
  verifierade fält (`ClientCompany.Org_Number`/`Name_company` = string) och kastar
  samma 400 som Bubble. **Bevisat:** återinförs `Number(org)` faller 4 tester.
  Utöka `TYPES` när fler fälttyper verifierats — billigaste skyddet mot den här klassen.
- **⚠️ Felet nådde inte användaren:** UI:t visade `✗ bubbleCreate failed`, eftersom
  `e.message` alltid är just det. Bubbles faktiska orsak ligger i `detail.body` och
  plockas nu fram som `hint` — frontenden visade redan `hint || error`, så
  meddelandet går hela vägen fram utan ändring där.

**5. Kundansvarig knyts nu som "Vår personal" på det nya företaget.**
Väljer man en kundansvarig vid skapandet appendas företaget till Userns
`Associated_company` — samma skrivning som `POST /:id/personal`. Annars stod ansvaret
i ett fält medan personallistan var tom, och notiser som hänger på
`Associated_company` nådde aldrig fram.

- **⚠️ BEST-EFFORT:** företaget är redan skapat när kopplingen görs. Faller den
  rapporteras `ansvarig_kopplad:false` — vi kastar aldrig bort ett företag som finns
  i Bubble. Vaktat av test.
- Listan **appendas**, aldrig skrivs över — befintliga kopplingar på användaren
  bevaras (eget test).
- **Gäller BÅDE skapande och byte** (utökat 2026-08-24). Byter man kundansvarig via
  inline-editen i listan eller på kortets Hem-flik knyts den nya personen på samma
  sätt — annars hade kopplingen bara gällt företag som råkade få rätt ansvarig från
  början. Båda vägarna går genom `PATCH /admin/companies/:id`, så en fix täcker båda.
- **⚠️ Den TIDIGARE ansvariga kopplas medvetet INTE bort** (Christians beslut):
  hen kan mycket väl fortfarande vara involverad i kunden. Eget test som bevisar att
  den gamla listan är oförändrad.
- Logiken ligger i **en** hjälpare (`_linkAnsvarig`) som create och patch delar —
  en plats att ändra på. Är användaren redan knuten görs **ingen skrivning alls**
  (noll WU), vaktat av ett test som räknar User-patchar.
- Rensad ansvarig (`""`) knyter ingen, och en patch som inte rör ansvarig lämnar
  kopplingen ifred — båda testade.

**Verifierat:** companies_smoke **340/340**, salj_smoke **79/79**, alla 21 sviter
gröna, mutationstestat (8 + 3 mot `6ebde34`, 4 för ansvarig-kopplingen mot `019dbc8`).

### ⚠️ "Carottare" hade TRE olika definitioner — enad 2026-08-24

Tre ytor svarade på samma fråga med olika källor, och därför olika svar:

| Yta | Källa före | Följd |
|---|---|---|
| Kundansvarig-dropdown | **ingen** — hela User-tabellen | Kundernas egna inloggningar gick att välja som kundansvarig |
| "Vår personal" | `?user_company=` (inloggades Company) | — |
| Onboarding-chippet "Carotte-medarbetare" | env `CAROTTE_COMPANY_ID` | Sa "ingen Carotte-medarbetare" medan personallistan visade Anette |

**Alla tre läser nu `user_company`** (den inloggades Company), med env som fallback för
anrop utan kontext (curl/cron).

- **Dropdownen** filtreras i `_ourUsers()`. `_users()` bär nu `company_id` per rad.
  Gäller `/meta`, list-metan och kortets meta — alla tre tar `?user_company=`.
- **⚠️ De två buggarna var samma bugg.** Kunde man välja en kundanvändare som
  kundansvarig blev hen dessutom osynlig under "Vår personal", eftersom den listan
  filtrerar på samma company. Ansvaret fanns men personen syntes ingenstans.
- **⚠️ Utan `user_company` filtreras INGET bort** — men svaret bär
  `users_unfiltered:true` och kortet säger det rakt ut. Tyst fel filter vore värre än
  en synlig varning. Samma princip som personallistan.
- **Onboarding-checken** tar nu `?user_company=` före env-varen. Frontenden skickar
  den via `ucq()` till både `/card` och `/onboarding`.

**Verifierat:** companies_smoke **353/353**, alla 21 sviter gröna,
mutationstestat (7 + 3 faller) + harness-bevis för vy-invalideringen. Testerna vaktar bl.a. att kundens egen user (`u1`,
Company `cc1`) aldrig kan väljas, och att onboarding hittar samma person som
personallistan.

⚠️ **Kvar:** `CAROTTE_COMPANY_ID` i Render bör peka på samma bolag som de inloggade
Carotte-usernas `Company`. Gör den inte det skiljer sig fallback-vägen (curl/cron)
från vad UI:t visar.

#### ⚠️ ROTORSAKEN VAR VY-CACHEN, inte kopplingen (2026-08-24)
"Den nya kundansvariga hamnar inte i personallistan" såg ut som en datafel men var en
**ren vy-uppdateringsbugg**. Christians hypotes, inte min — jag gissade först på
utebliven deploy och sedan på company-filtret. Båda fel.

`STATE.setupLev` ("Vår personal") och `STATE.onboarding` cachas i kortet och nollställs
**bara när man klickar in på under-fliken** (`data-fk="setupsub"`). Ett vanligt
**flikbyte** gör det inte. Klickvägen som fäller det:

> Inställningar → Leverantörer *(hämtar listan)* → Hem → byt kundansvarig →
> Inställningar *(setupSub är kvar på "leverantorer")* → **gammal lista renderas**

- **Fix:** `invalideraAnsvarigVyer()` nollställer båda och hämtar om onboarding.
  Anropas från **båda** editvägarna när `ansvarig_kopplad` finns i svaret.
- **Bevisat i harness** (samma klickväg, med och utan fixen): utan den har servern
  två kopplade personer medan vyn visar en. Med den visas båda.
- **Lärdom:** när "datan sparas inte" ska man kontrollera vad vyn LÄSER innan man
  misstänker skrivningen. Två av mina tre hypoteser gällde skrivvägen, som var
  korrekt hela tiden.

#### Kopplingen kan ändå LYCKAS utan att personen syns — också synligt
Byter man kundansvarig till någon som **inte** tillhör vårt bolag skrivs kopplingen
(företaget hamnar i hens `Associated_company`) — men "Vår personal" filtrerar på
`Company === user_company` och visar hen ändå inte. Resultatet blir en **tyst
motsägelse**: ansvaret satt, personen osynlig. Det var precis vad som såg ut som
"kopplingen fungerar inte" 2026-08-24.

- `_linkAnsvarig` returnerar nu `{ kopplad, utanfor_bolaget, namn }`. Svaret bär
  `ansvarig_utanfor_bolaget` (personens namn) och **båda editvägarna visar det**:
  kortets Spara som banner, listans inline-edit som cellmeddelande.
- `apiPatch` skickar `user_company` i bodyn — utan den kan servern inte avgöra saken.
- **⚠️ Grundorsaken stängs av dropdown-filtret** (samma leverans): kan man bara välja
  Carottare uppstår läget inte. Varningen är nätet under, för data som redan finns
  och för anrop via curl.
- Vaktat av tre tester: person utanför bolaget knyts men flaggas (med namn), person
  inom bolaget flaggas inte, och båda editvägarna visar varningen.

### Personer stå-alone — global personlista (render-omtag av Bubble-native vyn) — BYGGT 2026-08-26, EJ DEPLOYAT

Ersätter den Bubble-native `Personer`-tabellen på `dashboard_crm` med ett render-block,
aggregerat över ALLA företag. Samma upplägg som Drift stå-alone: **bara list-endpointen
är ny** — detalj, profil-PATCH, foto, aktiviteter, skapa konto och nytt lösenord
återanvänds oförändrade eftersom `coworker/:id`-endpointsen redan är företags-agnostiska.

**Design:** följer **affärsvyns** språk (`mira-affar-samlad.html`) — samma tokens
(`--base/--panel/--card/--deep/--input/--orange/--w70/--w40/--border`), DM Serif-rubrik
med orange separator + `.sub`-underrubrik, `.grid`-tabell, `.pill`-badges, `.erow/.el/.ein`
-formulär, orange `.ebtn` och `.sugg`-autocomplete. ⚠️ **Allt är scopat under `.pe`** —
affärsvyn har många oprefixade klasser (`.grid`, `.pill`, `.search`, `.bar`), och två block
på samma sida skulle annars krocka ([[reference-bubble-multiblock-collision]]).

**Backend: `GET /admin/persons/list` (companies_api.js)**
- Params: `q`(namn) · `email` · `company`(namn→id-set via `companyFullMap`) ·
  **`company_id`**(exakt scope) · `avdelning` · `konto`(yes/no) · `page` · `limit` · `fresh=1`.
- Svar: `{ok,total,pages,page,rows,departments,roles,facets:{avdelningar}}`. Rad bär
  `company`/`ansvarig`/`kontor`/`has_user` färdigresolvade.
- Prefix `/admin/persons` tillagt i `openPrefixes` (index.js).

**Backend: `GET /admin/persons/companies?q=&limit=` — företagsval för "+ Ny person"**
- Kundkortet vet bolaget (man står på kortet); den globala vyn gör det inte → create
  kräver ett val. Söker i **`companyFullMap`** (förvärmd cache) = **noll Bubble-anrop**.
- ⚠️ Använd INTE `/admin/clientcompany/search` här — den gör **fyra parallella Bubble-svep
  per anrop**, och fältet är debouncat (ett anrop per ~250 ms medan man skriver).
- `total` bär hela träffmängden, `items` är kapad till `limit` (golv 1 — en autocomplete
  ska få be om få förslag; listorna har golv 10).

**⚠️ TRE fällor som styrde designen — ändra inte utan att läsa dessa:**
1. **`sort_field` fäller tomma.** Personer UTAN Efternamn finns skarpt (Christians
   skärmbild 2026-08-26: Kajsas i Parken "Elaine"/"Melissa", Mariebo "Dennis"). Sorterar
   man i Bubble på Efternamn försvinner de **tyst**. Därför sorteras listan **alltid i
   minnet** (tomma sist, aldrig bortfiltrerade). Se [[reference-bubble-sort-drops-empty]].
2. **WU: sökfältet är debouncat** → ett anrop per tangenttryck. Ginge filtret ner som
   Bubble-constraint blev det ett helsvep per tangenttryck. Därför **ETT Coworker-svep
   per TTL** (`_coworkersAll`, AUX_TTL 1 h) + all filtrering i minnet — samma filosofi som
   `companyFullMap`. Cachen **invalideras** (`_coworkersForget()`) i coworker-create,
   coworker-PATCH, foto (sätt+rensa) och Min sida-speglingen; utan det visar listan gammal
   data i upp till en timme ([[reference-bubble-vy-cache-slapar]]).
3. **`has_user`** matchas mot `_users().byEmail` (redan TTL-cachad och delad) → noll extra
   WU. Kundkortets variant hämtar Users per företag, vilket inte skalar globalt.
   Kontorsnamn cachas per office-id (`_officeNameCache`, bara vid TRÄFF) → första sidan
   betalar ≤ limit `bubbleGet`, därefter gratis.

**Frontend: `mira-personer.html`** (NYTT block, `.pe`-namnrymd, BROOT-claim, IIFE, ingen `?.`/`??`)
- Kolumner: Företag · Ansvarig · Förnamn · Efternamn · Titel · E-post · Telefon · Avdelning
  · Konto · action. Sök namn/e-post/företag + avdelnings- och konto-filter + paginering.
- Person-detalj med Profil/Aktivitet-flikar, profilfoto, hela profilformuläret, skapa
  konto (roll-väljare) och nytt lösenord — allt mot befintliga endpoints.
- **"+ Ny person"** (speglar kundkortets formulär: Förnamn/Efternamn/E-post/Telefon/Titel)
  **plus en företagsväljare** med autocomplete — den enda skillnaden mot kortet, se ovan.
  Spara är låst tills ett bolag är valt (utan `:id` finns ingen endpoint att posta till),
  och valet **nollställs om texten ändras** så man aldrig sparar mot ett bolag som inte
  längre står i fältet. ⚠️ Förslagslistan renderas **in-place** (`renderSuggs`), aldrig via
  `render()` — en full omritning hade tömt fälten användaren redan fyllt i (samma fälla som
  deal-formuläret). Dropdownen ankras mot `.suggwrap` runt inputen, inte mot fältgruppen.
- **Kontors-dropdownen** lat-laddas per bolag (`/admin/companies/:id/offices`) och cachas
  i STATE → öppnar man flera personer på samma kund blir det ETT anrop.
- ⚠️ **`.tablewrap` + `min-width` bara på listtabellen.** Med 10 kolumner klipptes
  action-kolumnen (Skapa konto/Nytt lösenord) bort och blev OÅTKOMLIG på smal skärm.
  Aktivitetstabellen (4 kolumner) ligger medvetet UTANFÖR den regeln.
- ⚠️⚠️ **`!important` KRÄVS på knapparnas `:hover`** — se [[reference-bubble-button-hover-important]].
  `dashboard_crm` har en global `button:hover{background;color}` med **!important**. Utan
  matchande !important blev "+ Ny person", "Nytt lösenord" och "Skapa konto" **helorange
  med osynlig text** (Christians skärmbild 2026-08-26). Specificitet hjälper INTE mot
  !important. Verifierat genom att injicera samma regel i harnessen: utan fixen försvinner
  texten, med fixen står knappen emot. Gäller alla `<button>`: `.btn`, `.ebtn`,
  `.pager button`, `.back` — `.subtab`/`.si` är span/div och träffas inte.
- data-mira: `api_host` + `planning_token`.

**Roll-kedjan: ✅ BEKRÄFTAD av Christian 2026-08-26** — Bubble-wf `create_user_account`
tar emot `role` och sätter `User_role`. Render skickade redan `role`. Kedjan är hel, så
"Skapa konto" kan tryggt ligga på varje rad i den globala listan.

**Verifierat:** `companies_smoke.mjs` **401/401**, **mutationstestat** — 9 mutationer, alla
faller: (1) droppa tomma efternamn (sort_field-fällan simulerad) → 7 tester faller inkl.
kärntestet, (2) ta bort tomma-sist-logiken → 1, (3) stäng av TTL-cachen → 2, (4) ta bort
`_coworkersForget()` i PATCH → 1, (5) `has_user` alltid null → 3, (6) ignorera
`company_id`-scopet → 1, (7) företagssök ignorerar `q` → 2, (8) `total` = slice-längden i
st.f. hela träffmängden → 1, (9) create invaliderar inte cachen → 1.
Regression: **22 sviter gröna (1733 assertions)**.
Fixturen utökad med co3 (utan efternamn), co4 (Avdelning+User via u3), co5, co6 (utan
Kundföretag). ⚠️ co4 använder **u3:s** e-post, inte u2:s — mypage-sviten bevisar att en
User utan kopplad Coworker inte kraschar och använder u2.
Dessutom harness-verifierat i webbläsare (lista, sortering med tom-efternamn sist,
konto-filter, person-detalj, kontors-dropdown, Aktivitet-fliken, och hela "+ Ny
person"-flödet: företagssök → välj förslag → spara, med redan ifyllda fält bevarade).
Harnessen fångade två fel som testerna inte kunde se: den avklippta action-kolumnen
och den felankrade dropdownen.

**Deploy:** `companies_api.js` + `index.js` (openPrefix) + **nytt Bubble-block
`mira-personer.html`** på Personer-sidan (ersätter den native tabellen).

### Mötestratten: motivering vid avslut · defaultvy · anteckningstodo — BYGGT 2026-08-26, EJ DEPLOYAT

Tre saker i mötestratten (`salj_api.js` / `mira-motesbokning.html`). Mål 1 spred sig
med flit till alla tre skrivarna av `genomfört`.

#### ⚠️ TVÅ NYA BUBBLE-FÄLT KRÄVS FÖRE DEPLOY (Christian)

Båda på `activitet_crm`:

| Fält | Typ | Används av |
|---|---|---|
| `nasta_steg_kommentar` | **text** | Motiveringen vid avslutat spår (mål 1) |
| `anteckning_todo` | **Todo** (ref, single) | Idempotensmarkör för cronen (mål 3) |

Fältnamnen är konstanter (`KOMM_FIELD`, `TODO_FIELD`) överst i respektive modul →
en omdöpning är en rad per fil.

#### Mål 1 — obligatorisk motivering när spåret avslutas

**Varför:** `avslutat` är det enda av de tre besluten som INTE lämnar något spår efter
sig i systemet — ingen aktivitet, ingen todo. Utan motivering försvinner varför:et med
personen som fattade beslutet.

- Servern grindar: `400 avslut_kommentar_krävs` (+ `min:3`) så fort `avslutat` **skrivs**.
- **⚠️ Kravet hänger på att `avslutat` SKRIVS, inte på om sparningen råkar röra
  avklarandet.** Låg kontrollen efter `NASTA_TRIGGERS`-utgången hade en patch som BARA
  sätter `nasta_steg=avslutat` (ingen `genomfört`, ingen anteckning) sluppit igenom
  utan motivering. Eget test i alla tre sviterna.
- `aktivitet` och `todo` kräver INGEN motivering — de lämnar ett spår efter sig.
- **ALLA TRE SKRIVARNA grindar** (Christians beslut): `salj_api` (tratten),
  `companies_api` (kortets Historik) och `affar_api` (affärsvyn). Samma fält, samma
  felkod, samma minimilängd. Grindades bara tratten hade man kunnat avsluta spåret
  utan motivering från de två andra vyerna — exakt felet som stängdes 2026-08-21.
- **⚠️ `_writeOptional` hanterar nu FLERA valfria fält.** Bubble avvisar HELA
  skrivningen vid ETT okänt fält; droppas de inte **ett i taget** hade ett saknat
  kommentarsfält tagit med sig beslutet, anteckningen och allt annat i fallet.
  `missing` är nu ett objekt (`{ <fält>: true }`), inte en boolean.
- **⚠️ Egen saknat-flagga:** `avslut_kommentar_field_missing` vid sidan av
  `nasta_steg_field_missing`. Slås de ihop säger UI:t "beslutet sparades inte" när
  beslutet faktiskt sparades. Testat åt båda hållen (fält A saknas / fält B saknas).
- **⚠️ Motiveringen är TEXT, inte option set** → läses med `_str`, aldrig `_osStr`.
  Med `_osStr` hade en sparad sträng jämförts som objekt och verifieringen ljugit.
- Fattat beslut + motivering visas nu **read-only** i mötestrattens detaljvy (`nsDone`),
  i båda behörighetslägena. Lagras den men syns aldrig är den lika bra som borta.
- **Backloggen omfattas INTE retroaktivt.** Rader som redan står som `avslutat` utan
  motivering frågas inte igen — till skillnad från nästa steg-grinden, som betar av
  backloggen. Motivet: ett varför för ett spår som avslutades för månader sedan är
  ofta bortglömt, och att kräva det för att rätta ett stavfel är ren friktion.
  Ändras med en rad i `_nastaStegError` om det visar sig fel.

#### Mål 2 — vyn öppnar på "mina möten den här veckan"

- Vid boot: `person = current_user`, mötesdatum `idag −7` → `idag +7`. Skapad-datum-
  filtret lämnas tomt (annars hade möten som bokades tidigare men hålls den här veckan
  fallit ur). Sparas **avsiktligt inte** mellan sessioner — poängen är att alltid landa
  i sitt eget just nu.
- **"Min vecka"-knapp** återställer defaulten och markeras när den är aktiv;
  **"Rensa"** nollställer allt (= visa allt).
- **⚠️ BUGG SOM DEFAULTEN HADE GJORT AKUT (rättad):** `personer` byggdes ur den
  **filtrerade** mängden. Så fort man valde en person kollapsade dropdownen till just
  den personen och enda vägen till en kollega var "Rensa". Med defaultfiltret hade vyn
  **öppnat inlåst på användaren själv utan synlig väg ut.** Listan härleds nu ur HELA
  Kundmöte-datasetet, före både datum- och personfiltret. Noll extra WU (samma rader).
- **⚠️ Utan `current_user` sätts inget personfilter** — och blocket säger det rakt ut
  ("Kunde inte identifiera dig … visar ALLA kundansvariga"). En tom tratt hade annars
  lästs som "inga möten".

#### Mål 3 — automatisk "lägg in mötesanteckning"-todo

`POST /salj/anteckning-todo/cron` + `salj_anteckning_cron.sh` (Render Cron Job, morgon).
Ett Kundmöte vars mötesdatum passerat, som **inte är avbockat** och **saknar
mötesanteckning**, får en Todo tilldelad mötets ägare (`writer`).

- **⚠️ ROUTEN LIGGER MEDVETET UTANFÖR `/admin/salj`.** Det prefixet är undantaget från
  index.js globala `requireApiKey` och grindas bara av `PLANNING_ADMIN_TOKEN` — som
  ligger i **klartext i Bubble-HTML-blocket**. En skrivande massjobbs-endpoint bakom den
  token hade kunnat triggas från vilken webbläsare som helst. Här gäller `x-api-key`,
  samma grind som `/fortnox/cron/v1`. Egen regressionsvakt i sviten, plus en som kräver
  att routen saknar CORS-preflight.
- **⚠️ IDEMPOTENSEN HÄNGER HELT PÅ `anteckning_todo`.** Går markören inte att skriva
  **rullas todon tillbaka (`bubbleDelete`) och hela körningen avbryts med 500** — med
  flit. Utan markören hade samma todo skapats om igen VARJE natt, i allas listor.
  `bubbleDelete` skickas nu in i `registerSaljRoutes` (en rad i `index.js`).
- **⚠️ MARKÖREN LÄSES TILLBAKA — 400-vakten räckte inte.** `bubblePatch` avvisar hela
  patchen vid okänt fält (400) **men kan också ignorera en okänd nyckel TYST** — båda
  beteendena står i [[reference-bubble-data-api-keys]] / [[reference-bubble-tysta-faltdrop]].
  Den tysta droppen hade gått rakt igenom fail-closed-kontrollen och gett samma todo
  varje natt, med en logg som sa "lyckades". Nu läses raden tillbaka efter varje
  markör-skrivning. Kostnad: en läsning per SKAPAD rad — en gång per möte, aldrig igen.
  Tre distinkta felkoder:
  | Läge | Felkod | Rollback? |
  |---|---|---|
  | Bubble svarar 400 | `anteckning_todo_markor_misslyckades` | ja |
  | Skrivningen "lyckas" men markören finns inte på raden | `anteckning_todo_markor_ej_verifierad` | ja |
  | Läs-tillbaka går inte att göra | `anteckning_todo_verifiering_misslyckades` | **nej** |
  **⚠️ Sista raden är avsiktlig.** Okänt är inte samma sak som saknat: markören KAN ha
  fastnat, och raderas todon då pekar aktiviteten på en död rad — mötet får aldrig mer
  en påminnelse. Bättre en synlig kvarlämnad todo än en tyst tappad påminnelse.
- **⚠️ Fönstret är ett BACKFILL-SKYDD, inte en optimering.** `DAYS=14` bakåt +
  `GRACE=1` dygn framåt. Utan bakre gräns hade första körningen skapat en todo för
  varje gammalt oavbockat möte i basen. Kör `DAYS=90 DRY=1` först och läs
  `skulle_skapas` innan du höjer.
- **Taket (`LIMIT=50`) rapporteras** som `capped` + `kvar`. Ingen tyst avhuggning.
- **Rader utan `writer` hoppas över och RAPPORTERAS** (`utan_agare` + ids). "Created By"
  är API-nyckelns user — en todo tilldelad den når ingen. Ett tyst bortfall hade sett
  ut som "inga eftersläpande möten".
- Todon får `Status: Pågående`, `Företag`, `user` = ägaren, och **ett framtida
  `Sluttid`** (+2 dygn) — utan framtida datum syns den aldrig som planerad på
  kundkortets levande-panel. **`Kategori` gissas INTE**: den går inte att härleda ur
  mötet och ett gissat Category-värde avvisas av Bubble eller ljuger i datan.
- Constraints i slug-form (`datum_bokning_date`) med `greater than` / `less than` —
  Bubble saknar `>=`/`<=`.

#### Städat på vägen (samma spår)
- **`.catch(() => [])` borttaget på alla fem Bubble-frågor i `salj_api.js`**
  (`User`, `ClientCompany`, `deal`, `activitet_crm`, `SalesBudget`). Bröt arbetsregeln.
  **⚠️ Beteendeändring:** en fallen Bubble-fråga ger nu 500 i st.f. en tom tratt. Det
  är avsikten — tom data får aldrig bli ett svar — men det är en synlig skillnad.
- **`salj_smoke.mjs` `call()` kastade på okänd route** → svarar nu `404 no_route`.
  Med den kvar hade mutationstestet dött på första anropet mot cron-routen och
  rapporterat en påhittad siffra (samma fälla som 2026-08-24, dolde då 13 fel).
- **Mocken skärpt** (`salj_smoke`): `KNOWN_FIELDS` för `activitet_crm` + `Todo` kastar
  Bubbles 400 `Unrecognized field`; constraint-nycklar måste vara **slug-form** (okänd
  nyckel kastar) och `constraint_type` valideras mot Bubbles faktiska lista.

#### Verifierat
- **Alla 22 sviter gröna.** salj_smoke **127/127** · companies_smoke **411/411** ·
  affar_create_smoke **96/96**.
- **Mutationstestat mot `1b9d015`: 41 · 10 · 10 faller.** Inga krascher —
  utfallet lästes rad för rad.
  **⚠️ Tre fällor fångades i just den läsningen:**
  1. `todo1._id` **kraschade** mot gammal kod och dödade sviten (sjätte gången samma
     fälla). Hårdnad till `!!todo1 && …`.
  2. Tre assertions var **vacuöst gröna** mot gammal kod: negativa påståenden
     ("skriver ingenting", "faller bort") är sanna när ingenting kördes. Bundna till
     `dry.body.ok === true`. **En grön negativ assertion bevisar ingenting om routen
     inte ens finns.**
  3. Test-hjälparen `freshApp` (egen dep-override för nedgraderingsfallen) **kastade**
     på saknad route och dödade sviten — sjunde gången samma fälla, och den här gången
     i en hjälpare, inte i en assertion. Svarar nu `404 no_route`, precis som `call()`.
     **Regeln gäller varje testhjälpare som slår upp en route, inte bara ramen.**
- Route-inventarium i sviten (exakt lista på GET/POST) — en omdöpt route faller nu.

#### Skarp körning 2026-08-26 (commit `94852d7`)
Första skarpa cron-körningen: `lasta 36 · kandidater 15 · skapade 15 · utan_agare 0 ·
capped false`, fördelat på **sex** säljare (max fem på en). **15 av 36 möten (42 %) i
ett tvåveckorsfönster saknade anteckning och var inte avbockade** — backloggen är alltså
normalläget, inte ett hörnfall. `utan_agare: 0` betyder att alla möten har `writer`, så
varje todo når rätt person.
**Idempotensen bevisad skarpt tre minuter senare:** en andra körning gav
`lasta 36 · kandidater 0 · skapade 0`. Samma 36 rader lästes, ingen blev kandidat —
markören hade alltså fastnat på alla 15. Fältet `anteckning_todo` beter sig som
förväntat i Bubble (lagrar värdet), inte som en tyst dropp.
⚠️ Båda körningarna gjordes **innan** läs-tillbaka-härdningen ovan fanns i koden — den
är alltså inte det som räddade oss här, utan skyddet mot att fältet någon gång i
framtiden börjar bete sig som en tyst dropp (t.ex. efter en omdöpning i Bubble).

#### Deploy
1. **Skapa de två Bubble-fälten först** (tabellen överst i avsnittet).
2. Deploya `salj_api.js` + `companies_api.js` + `affar_api.js` + `index.js`
   (`bubbleDelete` in i salj-deps).
3. Klistra om **`mira-motesbokning.html`**, **`mira-foretag-lista.html`** OCH
   **`mira-affar-samlad.html`**.
4. Torrkör cronen, läs `skulle_skapas`, sätt sedan upp Render Cron Job på
   `salj_anteckning_cron.sh` (morgon svensk tid).

**Gör steg 2 och 3 tillsammans.** Backend med gammal frontend 400:ar för den som väljer
"Avsluta spåret" (gamla frontenden skickar ingen motivering).

### ⏭️ NÄSTA STEG (välj vid ny session)

#### Min sida (User-profil) som Render-block — BYGGT 2026-08-25, EJ DEPLOYAT
Bubble-popupen `PopupMyPage` på `dashboard_crm` gick inte längre att koppla input-fält
i (auto-bind omarkerad, workflow-värdet tomt; sidan har 752 workflows med dubbletter).
Ersatt med nytt fristående block **`mira-min-sida.html`** (`.ms`-namnrymd) som klistras
in i popupen/ytan bredvid användarnamnet. Två flikar: **Mina uppgifter** + **Användarvillkor**.

**Verifierat User-schema (skärmdump + Christian 2026-08-25 — gissa aldrig, se `Org_Number`-buggen):**
- `First Name`(text) · `Surname`(text, INTE "Last Name") · `Title_user`(text) ·
  **`Phone_user`(TEXT)** · `email`(auth) · `Consent`(ref → typ `consent`).
- **User saknar bildfält** — profilbild bor bara på Coworker.

**⚠️ TELEFON-TYPEN SKILJER SIG (Org_Number-fällan i ny form):** `User.Phone_user` är
**text**, `Coworker.Telefon` är **number**. Speglingen skriver strängen till User
(behåller inledande 0/`+`/mellanslag) och `Number(siffror)` till Coworker. Fel typ åt
något håll ger skarpt 400.

**Speglad skrivning (Christians beslut):** en "Spara" patchar BÅDE Current User OCH den
kopplade Coworkern. Kopplingen sker på **e-post** (`Coworker.Email == User.email`), samma
matchning som Personer-fliken (`has_user`). Saknas coworker skrivs bara User, och svaret
bär `coworker_linked:false` — UI:t säger det rakt ut (tyst halv-skrivning vore en lögn).

**⚠️ `email` är LÄS-ONLY** (mitt beslut, flaggat): den är Bubbles auth-login (auth ägs av
Bubble, samma regel som lösenord) OCH join-nyckeln mot Coworker — en skrivning kunde bryta
både inlogg och kopplingen. Popupen visade den redigerbar; det är fällan, inte funktionen.
Byte av inloggningsmail behöver en egen admin-väg om det ska in.

**Profilbild:** återanvänder den LIVE-deployade `POST /admin/companies/coworker/:cid/photo`
(→ `Coworker.Foto`). Frontenden client-komprimerar (canvas 512px, jpeg 0.82). Kräver
kopplad coworker; annars döljs bild-knapparna med förklaring.

**Consent-fliken (Christians beslut: "bara Godkänt-flagga, ingen fil"):**
`POST /admin/companies/mypage/:userId/consent {agree:true}` → skapar en **ny** `consent`-post
`{Godkänt:"Ja", User:<uid>}` (revisionslogg per godkännande) + patchar `User.Consent` → nya id:t.
**⚠️ `Godkänt` är option set `Godkänd`, värden `Ja`/`Nej`** (verifierat 2026-08-25) — läses
tillbaka OS-medvetet (`_osStr`). Created Date = tidsstämpel. Användarvillkor-filen skrivs inte.

**Villkoren bäddas in i fliken** (Christian 2026-08-25) — hela v1.0-texten från
`mira-anvandarvillkor-mira-fm.html` ligger som en scrollbar `.ms-terms`-panel i consent-fliken
(`termsHtml()`), så användaren aldrig skickas bort. Samma designspråk (DM Serif-rubriker,
numrerade sektioner, clause-grid). ⚠️ **Statisk text — uppdatera `termsHtml()` när villkoren
revideras.** `data-mira="terms_url"` finns kvar som frivillig "Öppna i egen flik ↗"-länk.

**⚠️ Render kan INTE skapa User/sätta lösenord** (auth ägs av Bubble) — endpointen *patchar*
bara befintliga fält (som `Associated_company`-skrivningen redan gör).

**Microsoft-koppling:** medvetet UTELÄMNAD — Christian bygger om hela den API-integrationen
separat. Blocket har bara en gråtonad placeholder-ruta, ingen logik.

- **Backend (`companies_api.js`):** `GET /admin/companies/mypage/:userId` (user+coworker+consent)
  · `PATCH /admin/companies/mypage/:userId` (speglad skrivning, whitelist `first/last/title/phone`,
  RÅ bubblePatch → okänt fält 400:ar) · `POST /admin/companies/mypage/:userId/consent`.
  Under `/admin/companies`-prefixet → **ingen index.js-ändring**. Foto återanvänds.
- **Verifierat:** companies_smoke **372/372** (+61), **mutationstestat: 17 av 20 nya faller**
  mot gammal companies_api.js (sviten kraschar INTE — call() svarar 404, assertions faller).
  De 3 som inte faller är regressionsvakter (email rörs aldrig; consent-id trivialt mot 404).
  Mocken skärptes: `KNOWN_FIELDS` för User/Coworker/consent + typvalidering på PATCH
  (`Phone_user`=string, `Telefon`=number) + option-set-check (`Godkänt`∈Ja/Nej) — avvisar
  precis som Bubble. Regression: alla 22 sviter gröna.
- **⚠️ EJ browser-testat mot skarp data** (ingen env/token i Claudes shell). Blocket är en
  nära klon av `mira-drift.html`-mönstret (BROOT-claim, IIFE, ingen `?.`/`??`, alla handler-
  funktioner på IIFE-nivå — verifierat), syntax-checkat. **Christian måste röktesta i browsern
  efter inklistring.**
- **Deploy:** `companies_api.js` (Render) + klistra in **nytt block `mira-min-sida.html`** på
  dashboard_crm-popupen. Bind `data-mira`: `api_host` · `planning_token` · `current_user`
  (= Current User's unique id). Ingen Bubble-schemaändring (`consent`-typen + fält finns).

#### Backlog från sessionen 2026-08-24→25
- **Affärsvyns EGNA oscopade CSS-selektorer** (`.pill` rad 51, `.funnel`, `.fstep`,
  `.bar`, `.chip`, `.row`, `.edit`). Läcker på dashboard_crm och träffar konkret
  3 element i företagslistan, 3 i mötestratten. Samma städning som offertblocket fick.
- **Fas-väljare i nästa steg-formuläret** finns bara i mötestratten. Kundkortets och
  affärsvyns formulär skapar fortfarande Kundmöten utan fas → de hamnar i "Övrigt".
- **"Aktiva 2 st" vs "Aktiva avtal 3"** — frontend räknar `status ∈ {aktiv,
  utgar_snart}`, backend räknar "inget passerat slutdatum". Verksamhetsfråga.
- **Person i affärsvyn** — native-genvägsgruppen har den, affärsvyn saknar den.
  Behövs innan gruppen kan tas bort helt.
- **`CAROTTE_COMPANY_ID` i Render** bör peka på samma bolag som Carotte-usernas
  `Company`, annars skiljer sig curl/cron-vägen från UI:t.

- **⚠️ Håll `OPTIONSET_SEED.bransch` i takt med Bubbles option-set.** Värden som läggs
  till i Bubble går inte att sätta från listan förrän de finns i seeden.
- **Drift Fas 2 forts.** — skapa nytt ärende + ärendekategorier (Inställningar-flik i `mira-drift.html`) + team-redigering + avvikelse-toggle. ⚠️ Kräver skärmbild på hur ärendekategorier lagras (egen typ vs option set) innan kategoridelen byggs.
- **Drift Fas 3 (QC SKRIV)** — skapa kvalitetskontroll från Housekeeping-Contract → kontrollobjekt per yta (Mötesrum + Internal_room) → betyg/bild/kommentar → slutför.
- **Avtal-fliken: inline-vyer i st.f. modaler** — Christians förslag. Tar bort hela z-index/stacking-buggklassen permanent. Panelerna ligger redan utanför kortets re-render, så inline-formulär är säkra state-mässigt. Omarbetning av tre ytor (skapa/redigera, 5-stegs-wizard, import-granskning).
- **Medarbetarportal-fliken** (setup-hub, störst) — sidinställningar + erbjudanden/menyer.
- **Småfix:** roll-väljare även i "Ny person" · fler person-fält (Anställningsdatum/Födelsedag/Allergener/Kontorsansvarig/Adress) · geo-adress skrivbar på kontor · multi-select kontorsansvarig · 5xx-backoff i e-postpollern · Sales-KPI som SWR (första anropet efter TTL blockerar 20–60 s).
- **Porta z-index-fixarna till `mira-abonnemang-admin.html`** om det blocket någonsin hamnar på en sida med Bubble-chrome (bugg 1 och 3 finns kvar där — ofarliga idag eftersom blocket ÄR hela sidan).


### Filer
- **`companies_api.js`** (NY, ~70k) — hela backend-modulen (`registerCompaniesRoutes(app, deps)`). Alla endpoints x-admin-token-grindade (utom `reset-password/exchange` som är token-grindad publik).
- **`mira-foretag-lista.html`** (**~400k** 2026-08-25) — Bubble-blocket för lista + kort + ALLA flikar (inkl Drift + full Avtal-CRUD). `.fl`/`.fk`-namnrymd (+ inflyttade `.ab-`/`.wt-`/`.aa-`/`.ac-`), BROOT-claim, SWR, INGEN `?.`/`??`. data-mira: `api_host` · `planning_token` · `user_company` · `user_name` · `sender_email` · `sender_name` · `current_user` (User-id → `writer` + roll).
- **`mira-personer.html`** (NY 2026-08-26, ~24k) — stå-alone global personlista över alla
  Coworkers. `.pe`-namnrymd. Återanvänder samtliga `coworker/:id`-endpoints; bara
  `/admin/persons/list` + `/admin/persons/companies` är nya. Design: affärsvyns språk,
  allt scopat under `.pe`. data-mira: `api_host` + `planning_token`.
- **`mira-drift.html`** (NY, ~14k) — stå-alone Drift-modul (aggregerat över alla kunder + sök/filter). `.dr`-namnrymd. data-mira: `api_host` + `planning_token` + `user_name`. Återanvänder detalj-endpoints.
- **`mira-min-sida.html`** (NY, 2026-08-25) — Min sida (User-profil), ersätter Bubble-popupen `PopupMyPage`. `.ms`-namnrymd. data-mira: `api_host` + `planning_token` + `current_user`. Flikar: Mina uppgifter (speglad User+Coworker-skrivning) + Användarvillkor (consent). Foto återanvänder `/coworker/:id/photo`.
- **`companies_smoke.mjs`** — 201/201 gröna. **`cc_cache_smoke.mjs`** (NY) — 61/61, testar den delade CC-cachen i index.js genom att klippa ut blocket ur källkoden och räkna Bubble-sidhämtningar (se WU-städningen). `index.js` — wiring + delade cachar + Bubble-wf-callers + openPrefixes (`/admin/companies`, `/admin/drift`, `/admin/reset-password`). `emailer.js` — mallar `password_reset` + `user_welcome`.

### Backend-arkitektur (companies_api.js)
- **Delade cachar (index.js):** `sharedCompanyFullMap` (CC-list-projektion ur EN 55-sidorsladdning) + `sharedCompanyRevenueMapWarm` (FortnoxInvoice.ft_net/år, **lat** — ingen boot-prewarm, WU-medveten). Listan gör NOLL Bubble-anrop (allt ur cacharna); bara PATCH/skapa skriver.
- **Lista:** `GET /admin/companies/list` (filter/sök/sort/paginering + meta) · `GET /admin/companies/meta` · `PATCH /admin/companies/:id` (inline-edit, option-set validerad mot facetter). `revenue_ready`-flagga → frontend visar "beräknar omsättning…" + auto-omhämtning.
- **Kort:** `GET /admin/companies/:id/card` (kunddata + KPI + counts per flik) · `GET /admin/companies/:id/chain?type=deals|leads|offerter|ordrar|fakturor|avtal|signeringar` (reverse-lookup per typ) · `GET /admin/companies/:id/coworkers` (+offices+departments) · `GET /admin/companies/coworker/:id/activities`.
- **Skapa/redigera:** `POST /admin/companies/:id/coworker/create` · `PATCH /admin/companies/coworker/:id` (CO_EDITABLE) · `POST /admin/companies/coworker/:id/create-account` (Bubble-wf + välkomstmail).
- **Lösenord/onboarding (eget token-flöde via vår SendGrid-motor):** `POST /admin/companies/coworker/:id/send-password` · `POST /admin/reset-password/send {email}` (nya users) · `POST /admin/reset-password/exchange {token}` (reset_pw-sidan). `__INIT__`-läge för API Connector-init utan sidoeffekt.
- **Onboarding (kundresans status):** `GET /admin/companies/:id/onboarding` — 5 Mira-delkrav (office/logo/user/supplier/staff) + steg-status (avtal/mira/utbildning) + två mockar (kickoff/leverans). Kräver `CAROTTE_COMPANY_ID` env. Se avsnittet "Onboarding — kundresans status" ovan.

### Företagsfält per typ (VERIFIERAT — kritiskt vid reverse-lookup)
deal=`kundföretag` · Lead=`client_company` · Mira Offert/MiraOrder=`kundforetag` · Fortnox(FortnoxOffer/Order/Invoice)=`linked_company` · Contract=`kundföretag` · OfferApprovalRequest(signering)=`clientcompany` · **activitet_crm=`company`** (ClientCompany — ENDA kund-fältet; INGET clientcompany finns! Schema-verifierat 2026-08-14, se [[reference-activitet-crm-company-fields]]) + `taggade_personer`(List of Coworker, tagg — FINNS nu) + `writer`/`mötesanteckning_writer`(User) · Coworker→företag=`Kundföretag`, has_user=User vars **`Company`**(singular)==företaget matchar coworker-mail · Office→företag=`Kundföretag`.

### Kortets flikar — status
Hem ✅ (kunddata läs/redigera + KPI + snabbåtgärder: "+ Ny aktivitet"→Historik-flik+form, "+ Ny kontakt"→Personer-flik+form) · Personer ✅ (lista m. avatarer + skapa person + skapa konto + person-detalj m. **Profilfoto**[upload/byt/ta bort] + Profil-redigering[Förnamn/Efternamn/Titel/Email/Telefon/crm_info/Avdelning/Kontor] + Aktivitet-flik) · Historik ✅ (activity_crm-feed för hela företaget, timeline) · Deals/Leads/Offerter/Ordrar/Fakturor ✅ (reverse-lookup) · Avtal ✅ (Abonnemang+Signeringar, READ) · **Drift ✅ (Fas 1 LÄS)** (ärenden+kvalitetskontroller för kunden, se nedan) · **Inställningar 🚧** (setup-hub: **Kontor ✅** [lista+skapa m. auto-rum+redigera+rum-hantering] · **Logo ✅** [ClientCompany.logotyp upload/byt/ta bort] · **Leverantörer ✅** [dotterbolag + Carotte-personal, add/remove] · Fastighetsägare ✅ (knyt hyresgäst→Hyresvärd.Hyresgäster) · Medarbetarportal ⏳; Avtal skippas — egen lista).

### Inställningar → Logo + Leverantörer — KLAR + LIVE 2026-08-16
- **Logo:** `POST /admin/companies/:id/logo` (multipart `file`, `clear=1`; original-fil, behåller transparens) → `ClientCompany.logotyp`. Frontend `logoBody` (Logo-subtab): förhandsvisning + Ladda upp/Byt/Ta bort. Kort-headern speglar direkt (`STATE.card.company.logotyp`).
- **Leverantörer — kopplingar bekräftade via native RG-filter (skärmdump):** (1) **Dotterbolag** = `Leverantör - Supplier` där `Kundföretag`(List of ClientCompany) contains företaget → add/remove = patcha **leverantörens** Kundföretag-lista. (2) **Personal** = `User` där `Associated_company`(List of ClientCompany) contains företaget → add/remove = patcha **Userns** Associated_company (styr notiser). Pool för personal-dropdown = Users vars `Company` == inloggad Carotte-users company → skickas som `?user_company=` (nytt `data-mira="user_company"`-hidden-input, bind Current User's Company i Bubble).
- **Backend:** `GET /admin/companies/:id/leverantorer?user_company=` (suppliers+available+personnel+personnel_available) · `POST .../leverantor {supplier_id}` · `DELETE .../leverantor/:sid` · `POST .../personal {user_id}` · `DELETE .../personal/:uid`. Frontend `leverantorerBody`/`levSection` (2 sektioner, dropdown-add + Ta bort), `fetchLeverantorer`/`addLev`/`delLev`, STATE.setupLev.
- Verifierat: smoke (logo set/clear/404 + suppliers add/remove + personal add/remove via Associated_company + pool via Company==user_company) + harness (Logo upload→header uppdaterad; dotterbolag+personal add/remove). Deploy: index.js oförändrad; companies_api.js + klistra om mira-foretag-lista.html + **bind data-mira user_company** i Bubble.
- **Fastighetsägare:** knyt företaget som hyresgäst till en/flera **`Hyresvärd`** via dess `Hyresgäster`(List of ClientCompany)-lista (samma mönster som dotterbolag). `GET/POST /admin/companies/:id/fastighetsagare` + `DELETE .../:hid`. Frontend återanvänder `levSection`("landlord") via generaliserad `LEV_EP`-map (supplier/staff/landlord → path/key/state). Kund-nivå-notiser: styr t.ex. vilka erbjudanden som visas för en fastighetsägares hyresgäster.
- **Logo i kort-huvudet:** rektangulär logga visas i full bredd (vit pill, `.fk-herologo` fast höjd 56px + auto bredd, `object-fit:contain`) uppe till HÖGER; initial-ruta som fallback när logga saknas.

### Inställningar → Kontor (Office) — KLAR + LIVE 2026-08-15
Underflikar (`STATE.setupSub`): Kontor · Leverantörer · Logo · Fastighetsägare · Medarbetarportal (Avtal skippat). Kontor byggd; övriga = placeholder.
- **Office-schema (verifierat 2026-08-15):** `Office_title`(text), `Kundföretag`(ClientCompany), `Fastighet`(ref), **`Kontorsansvarig`(List of Coworker)**, `office_address`(geo), **`Yta`(number)**, `Arbetsplatser`(number), `Budget`(number), `Mötesrum`(List of MeetingRoom), `intern_lokal`(List of Internal_local), + Kontrollobjekt/Kvalitetskontroll/Nyckel/Konsult/leverantör/Medarbetare/Department/Status_kontor/plan_översikt(image)/hemsida/Grundat_år/Närvaro/Ärende.
- **Backend (`companies_api.js`):** `GET /admin/companies/:id/offices` (rader + dropdown-data fastigheter+coworkers) · `POST /admin/companies/:id/office/create` (Office + **auto-rumsuppsättning**) · `PATCH /admin/companies/office/:id`. `_officeWrite`-mappning; `nOffice`-normaliserare. **Auto-rum (`_createDefaultRooms`):** vid nytt kontor skapas 1 `MeetingRoom` (Name/office/Company) + 8 `Internal_local` (Namn/kontor/kundföretag): Toaletter, Kopieringsutrymme/Förråd, Pentry, Reception/Lounge, Korridor, Dusch, Städförråd, Kontorsrum — behövs för kvalitetskontroller; rummen appendas även till Office-listorna. Adress (geo) hanteras EJ än (läs-only). Kontorsansvarig = single-select i UI (skrivs som List med en) — kan bli multi senare.
- **Frontend (`mira-foretag-lista.html`):** `installningarBody` (subtab-bar) → `kontorBody` (kontors-tiles: namn/fastighet/adress · ansvarig · yta · arbetsplatser · rum-antal + Redigera) + `officeForm` (skapa/redigera, `.fk-owrap` 1080px). `fetchOffices`/`createOffice`/`saveOffice`. STATE: setupSub/offices/officeMeta/officeNew/officeEdit (nollas i openCard).
- **Kontor 1b — rum-hantering (KLAR 2026-08-15):** i redigera-vyn två sektioner (Mötesrum + Interna lokaler). `GET /admin/companies/office/:id/rooms` · `POST /admin/companies/office/:id/room {type:meeting|internal, name}` (skapa + append till Office-lista) · `DELETE /admin/companies/office/:oid/room/:rid?type=` (radera + ta bort ur Office-lista). `bubbleDelete` tillagd i companies-wiringen (index.js). Frontend: `roomsSection`/`roomList` (fk-rooms 2-kol) + fetchOfficeRooms/addRoom/delRoom, STATE.officeRooms. Rum-antal i tile uppdateras optimistiskt.
- **⚠️ RUMS-TYPNAMN = `Internal_room` (INTE `Internal_local`!) — fix 2026-08-15 efter deploy.** App data + Bubble-wf visar att den LIVE-aktiva typen native skapar (och Office.intern_lokal pekar på) heter **`Internal_room`**; Data-types-editorn visade "Internal_local" (stale/legacy). Fel typnamn → 0 träffar → interna lokaler visades tomma. Fix: `Internal_room` överallt (create/get/find). **Fält på Internal_room:** `Namn`(text), `kontor`(Office), `kundföretag`(ClientCompany), `Lokaltyp`(OS — Christian sätter den native tills vidare, vi avvaktar). MeetingRoom var rätt. `_officeRooms(office, oid)` hämtar via BÅDA vägar (per-id ur Office-listan `Mötesrum`/`intern_lokal` + ref-query `office`/`kontor`) union+dedup — robust oavsett hur rummet kopplades.
- Verifierat: smoke 128/128 (rooms union list-väg[i2 utan ref]+ref-väg[i1] + create/DELETE + 404/felfall) + harness. Deploy: index.js (bubbleDelete-wiring) + companies_api.js + klistra om mira-foretag-lista.html.

### Historik-fliken (activity_crm för hela företaget) — expanderbar + redigerbar + skapa ny — KLAR + LIVE 2026-08-14
Historik = `activitet_crm` där **`company==id`** via `_companyActivityRows(id)` (hoistad; används av BÅDE chain-historik OCH card `counts.historik`) → `nActivity(r, um)` (`um`=user-map för `ansvarig` via writer/Created By; full edit-prefill: beskrivning/motesanteckning/motesdatum_iso/created/genomfort). **⚠️ FÄLTET ÄR `company` (ClientCompany), INTE clientcompany** — som inte finns på typen (schema-verifierat 2026-08-14). Tidig version constraintade fel fält → Sveriges Läkarförbund visade tomt trots historik i native. Frontend: `historikBody`-timeline-feed (`.fk-feed`); **klick på rad → expanderar** (STATE.histOpen) → detaljgrid (`.fk-hmetagrid`: typ/fas/mötesdatum/registrerad/ansvarig/status) + mötesanteckning + inline **redigera**-form. **"+ Ny historik"** (STATE.histNew) → skapa-form. Kundmöte-typen visar villkorliga fält via `.fk-konly`/`.fk-notewrap`-DOM-toggle (change-listener, ingen re-render mitt i edit). Egen gren i `cardBody` (ej CHAIN_TABS). Innehållet kapas till läsbar kolumn (`.fk-hwrap` max 900px, vänsterjust) så text/form ej sprids över hela bredden.
- **Skriv-endpoints (lånade affär-mönstret, affar_api.js):** `POST /admin/companies/:id/historik/create` (sätter `company=id`) + `POST /admin/companies/historik/:id/patch`. Delad `_aktWrite`-mappning, SKRIVNYCKLAR=display-namn: `activity_type`/`beskrivning`/`Kundmöte`(fas)/`Datum_bokning`/`genomfört`/`mötesantecking`. Option-set: AKT_TYPES (Säljsamtal/Kommentar/Kundmöte/…) + AKT_FASER (Fas 1–4/Övrigt). `bubbleCreate`/`bubblePatch` redan wire:ade.
- Verifierat: smoke 106/106 (chain historik company-fältet + rätt företag-filtrering + create/patch + 400/404) + harness (expandera→detalj+form, redigera→spara→rad uppdateras, skapa→ny rad överst+badge++). Deploy: companies_api.js + klistra om mira-foretag-lista.html (index.js oförändrad).

### Profilfoto (Coworker.Foto) — KLAR + LIVE 2026-08-14
`POST /admin/companies/coworker/:id/photo` (multipart, fält `file`; rensa m. `clear=1`) → laddar upp till Bubble file storage via `bubbleUploadFile` → sätter `Coworker.Foto` (image-fält = URL-sträng). Coworkers-GET returnerar `foto` (https-normaliserat). Frontend: `.fk-avatar` (rund) i person-huvud + personlista; foto-rad i Profil (Ladda upp/Byt/Ta bort). Klienten komprimerar bilden client-side (canvas, max 512px, jpeg 0.82) → FormData. **Deps tillagda i wiringen:** `bubbleUploadFile` + `photoUpload: _approvalUpload` (multer memory 25MB). **Ingen Bubble-schemaändring** (Foto-fältet finns). Verifierat: smoke 96/96 + browser-harness (avatar i lista/profil, upload→img, ta bort→initialer). Deploy: index.js + companies_api.js (Render) + klistra om mira-foretag-lista.html.

### Drift-fliken (Fas 1 = LÄS) på kundkortet — KLAR + LIVE 2026-08-16
Ärenden (`Matter`) + kvalitetskontroller (`QualityControl`), båda `Kundföretag`(ClientCompany)==kunden. Undertabbar: **Ärenden** (status-pill Pågående/Avslutad) · **Avvikelser** (Avvikelse=yes) · **Kvalitetskontroller**. `counts.drift` = öppna (Pågående) ärenden.
- **Ärende:** `Rubrik`/`Beskrivning`/`Bild`/`Kontor`(Office)/`Referens`(User)/`Prioritet`(OS)/`status`(Status Ärende, "Pågående"=öppen)/`Avvikelse`(yes/no)/`Team åtgärd intern`(Coworkers)/`Team åtgärd extern`(Konsult)/`Tråd`(List text)/`Feedback`/`Förbättring`. Detalj: beskrivning+bild, meta, team-namn, tråd, uppföljning.
- **QC:** varje yta = en **`Kommentar - Comment`** (typnamn m. mellanslag+bindestreck!) där `kvalitetskontroll`==QC, m. `Intern_lokal`(Internal_room)/`Mötesrum`(MeetingRoom)-ref, `Betyg`(→`Grade`), `Bild`, `Beskrivning`. **Snittbetyg = medel av `Grade.Värde` där `kvalitetskontroll`==QC.** QC-fält: `Avtal`(Contract Housekeeping)/`Kontor`/`kontrolldatum`/`Kontrollant`(User)/`Leverantör`/`Kundreferens`(Coworkers)/arbetskläder/servicekort/städförråd/`Meddelande`/betyg_client/feedback_client.
- **Backend (`companies_api.js`):** `GET /admin/companies/:id/matters` · `GET /admin/companies/matter/:id` · `GET /admin/companies/:id/qc` · `GET /admin/companies/qc/:id`. Ref-namn resolvas via `_officeNameMap`/`_contractNameMap`/`_supplierNameMap`/`_roomNameMap`/`_users`/`_companyCoworkerMap`. counts.drift via `bubbleCount Matter [Kundföretag,status=Pågående]`.
- **Frontend (`mira-foretag-lista.html`):** `driftBody`(subtabs)→`matterListBody`/`qcListBody` + `matterDetailBody`/`qcDetailBody`(`.fk-qgrid`-ytkort). fetch: matters/qc/matterDetail/qcDetail. STATE driftSub/matters/qcList/matterOpen/matterDetail/qcOpen/qcDetail.
- **QC-mejlets betyg (rättat 2026-08-31).** `qc_new`-mejlet visade **0 stjärnor + "0/5"** på kontroller som hade fullt betyg. Orsak: `starRating()` i `emailer.js` gjorde `Math.round(Number(v) || 0)` — allt som inte är ett rent heltal blev NaN → 0. Reproducerat mot gammal kod: `"4,5"`, `"4 av 5"`, `"Nivå 3"` och ett Bubble-referens-id gav **alla** `0/5`; bara `"4"` fungerade.
  - `parseBetyg()` tolkar nu tal, decimalkomma (`"4,5"`), `"4/5"` och `"4 av 5"` (normaliseras till 5-skala). **Bubble-referens-id:n avvisas explicit** — plockar man "första talet" ur `1760448796514x…` får man 1760448796514 → klampat till 5 → mejlet påstår full pott. Fel åt det hållet är värre än fel åt det andra.
  - Går värdet inte att tolka faller mallen tillbaka på **medel av `Grade.Värde`** för kontrollen — samma sanning som kundkortet visar. Går inte det heller renderas **råtexten**, aldrig falska stjärnor: ett tyst "0/5" är ett felaktigt påstående om leveransen, inte ett tomt fält.
  - ⚠️ **`Betyg_lev` finns inte i fältlistan ovan.** Det förekommer bara som fallback i `companies_api.js` och som `"Betyg_lev": 4` i `companies_smoke.mjs`-mocken. Mocken kan alltså vara mer tillåtande än Bubble — verifiera mot skarp data innan någon litar på fältet. `Grade.Värde` är den dokumenterade sanningen.
  - ⚠️ `extra_data` på `emailqueue` skrivs av ett **Bubble-workflow** och syns inte i repot. Vilken form `betyg` faktiskt har går bara att mäta, inte läsa sig till.
- Verifierat: smoke 152/152 + harness. 

### Drift stå-alone (Fas 4) — eget block `mira-drift.html` — KLAR + LIVE 2026-08-16
Aggregerar ärenden + kvalitetskontroller över ALLA kunder m. sök/filter/paginering; detalj återanvänder samma endpoints som kortet.
- **Backend:** `GET /admin/drift/list?type=matters|qc&scope=open|closed|avvikelser&q=&company=&prio=&page=&limit=`. Per-request Bubble-sök m. constraints (scope-default Pågående → WU-bundet). Företagsnamn via delad `companyFullMap`, kontor via `_officeNamesByIds`(bubbleGet sidans Kontor-ids), övriga namn via befintliga mappar. `q`=Rubrik/Titel text-contains; `company`=företagsnamn→id-set (in-memory filter). Prefix `/admin/drift` tillagt i openPrefixes (index.js). Detalj: `/admin/companies/matter/:id` + `/qc/:id` (företags-agnostiska).
- **Frontend (`mira-drift.html`, NYTT block):** `.dr`-namnrymd, egen CSS (kopierar kortets Drift-look). Flikar Pågående/Avslutade/Avvikelser/Kvalitetskontroller + sök-rubrik + sök-företag + prioritet-facet + paginering. Lista m. Företag-kolumn + samma detalj-vyer (ärende + QC). SWR ej nödvändig (per-request).
- Verifierat: smoke 159/159 (drift/list open/closed/avvikelser + rubrik-sök[text contains] + företagsfilter + qc + facet) + harness (aggregerad lista över EA/Planhat/Scania, sök, QC-flik, båda detaljvyerna). Deploy: index.js (openPrefix) + companies_api.js + **nytt Bubble-block `mira-drift.html`** på Drift-sidan (data-mira api_host+planning_token).
### Drift Fas 2 (delvis): status + kommentera + tråd-datumtvätt — KLAR + LIVE 2026-08-16 (BÅDA blocken)
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

### Avtal-fliken: full CRUD inflyttad i kortet — KLAR + LIVE 2026-08-17
Kortets Avtal-flik var READ-vy; native-fliken hade två separata block. Nu är **båda blocken inflyttade** i `mira-foretag-lista.html` — native Avtal-fliken, `mira-abonnemang-kund.html` och `mira-approval-create.html` kan pensioneras för kundkortet. **✅ GENOMFÖRT 2026-08-27:** native-kortet är dött och `mira-abonnemang-kund.html` är raderad — allt går genom det här blocket. Se AVTAL-SIGNERING.md §'NATIVE KUNDKORTET ÄR PENSIONERAT'. **Ingen ny backend, ingen Bubble-schemaändring** — alla endpoints fanns redan.
- **Abonnemang** (ur `mira-abonnemang-kund.html`): per-kontor + Account-scope-sektioner, expanderbara rader m. bilagor/rate-card, **+ Nytt abonnemang**, **+ Avtal från mall** (5-stegs-wizard), **+ Importera avtal** (PDF → LLM-parse → granska → commit), redigera/pausa/återuppta/avsluta/återöppna. Endpoints: `/admin/contracts/by-company` · `/admin/contracts/:id` (PATCH) · `/create` · `/import/parse` · `/import/commit` · `/admin/contract-templates` · `/admin/suppliers` · `/services/dashboard`.
- **Signeringar** (ur `mira-approval-create.html`): historik + skicka ny signering (dokument/mottagare/meddelande) + påminn. Endpoints: `/admin/approval/list` · `/users-by-company` · `/approval/create` · `/request/:id` · `/remind/:id`.
- **⚠️ ARKITEKTUR — panel-flytt (viktigast att förstå):** `renderCard()` gör `innerHTML=` på hela `cardview` vid VARJE state-ändring. Formulär, wizard och halvfärdiga uppladdningar skulle raderas mitt i inmatning. Lösning: `.ab-wrap` och `.ac-wrap` ligger i `<div data-fl="panes">` **utanför cardview** och flyttas in i `[data-fk="avtalmount"]` med `appendChild` (flytt bevarar både lyssnare och DOM-state), och stashas tillbaka av `stashPanes()` FÖRE varje re-render + i `closeCard`. `syncAvtalCompany()` triggar omhämtning bara när kund-id faktiskt bytts (`_avtalFor`-map). Modalerna är `position:fixed` med hög z-index → följer med flytten utan layoutproblem.
- **Kodstruktur:** modulerna ligger INNE i kortets IIFE (ser `root`/`FLROOT`/`FKAVTAL` utan window-globaler → ingen [[reference-bubble-multiblock-collision]]), var och en i egen IIFE så deras lokala `$`/`esc`/`cfg` skuggar kortets. Bara bootstrap-raderna (claim + `data-mira`-config + auto-init) är omskrivna, allt annat är verbatim ur källblocken. Monterat av **`merge_avtal.mjs`** (i repot för spårbarhet) — **inte idempotent**: en andra körning failar på sina assertions. Filen är nu källan; redigera där, inte i skriptet.
- **⚠️ Två buggar som harnessen fångade:** (1) `loadCatalog()` är **företags-scopad** (`/services/dashboard?company_id=`) och fyller BÅDE erbjudande- och **kontorsdropdownen** i skapa-formen — körs den vid init (utan kund) blir kontorsvalet tomt. Därför kör `FKAVTAL.ab.reload()` både `loadCatalog()` och `loadLive()`. (2) Min första kund-sanering strippade `&` → "Fröberg & Lundholm" blev "Fröberg  Lundholm"; nu `escapeHtml`.
- **Bra att veta:** abonnemangsmodulen har en **prod-fallback** när `api_host` är tom (`cfg('api_host') || 'https://mira-exchange.onrender.com'`) — glöms bindningen hämtar den från Render i stället för att fela tyst lokalt. Ärvt från källblocket, inte infört här.
- **Verifierat** (browser-harness: kortets endpoints mot RIKTIGA `companies_api.js`, contract-/approval-endpoints handmockade eftersom de bor i index.js-monoliten): lista per kontor + Account-scope · skapa abonnemang → rad + summa 143 975→156 475 kr · pausa → "Pausat"/aktiva 2→1 · återuppta → tillbaka · mall-wizard öppnas m. mallar från API + kunden förifylld · PDF-import → parse → granskningsmodal m. alla LLM-fält → commit → ny rad · signeringshistorik · kontaktväljare · skicka signering → ny rad överst · **panel-överlevnad**: flikbyte Hem↔Avtal och tillbaka-till-listan stashar/återmonterar utan att tappa innehåll. Regression: companies_smoke 176/176 + cc_cache_smoke 26/26. Syntax: ett script-block (3 788 rader) parsar rent, div-balans 0.
- **Deploy:** klistra om `mira-foretag-lista.html` (nu ~302 kB) + **bind två nya `data-mira`: `sender_email` + `sender_name`** (Current User) för signeringarnas avsändare. Backend oförändrad. Ta bort de gamla Avtal-blocken från Företag-sidan när du verifierat.
- **⚠️ CSS-LÄCKA EFTER FÖRSTA DEPLOYEN (löst 2026-08-17, `scope_avtal_css.mjs`):** Christian deployade och **alla Bubble-element runt blocket släcktes**. Orsak: källblocken körde ensamma på egna sidor/popups och har **82 helt generiska, oscopade selektorer** — `.field`, `.pill`, `.drop`, `.row2`, `.btn-primary`, `.btn-secondary`, `.err`, `.ok-block`, `.hist-*`, `.rcp-*`, `ul.files`, `li.file`, `.doc-row` … och värst **`.hidden{display:none !important}`**, som släcker VARJE Bubble-element med den klassen. Inne på Företag-sidan läcker de ut över hela appen. Detta är samma lärdom som [[reference-bubble-multiblock-collision]] ("när du klonar ett block, byt HELA namnrymden — annars läcker CSS"), fast för CSS i st.f. JS.
  - **Fix:** varje selektor utan egen namnrymd prefixas med panelens rot (`.ac-wrap .hidden`, `.ac-wrap .pill`, `.ab-wrap .wt` …). **Klassnamn i markup/JS är orörda** → minimal risk. Redan namnrymdade `.ab-*`/`.ac-*`/`.wt-*` lämnas OSCOPADE med flit så att specificiteten (och därmed cascade-ordningen) inom panelerna är oförändrad. 89 selektorer scopade, 0 oscopade kvar.
  - **Mutationsverifierat:** mot den deployade (oscopade) versionen får ett fejkat Bubble-element med `class="hidden"` **`display:none`**, `.pill` blir `inline-flex` + padding, `.drop` får padding 24px. Efter fixen är alla sju simulerade Bubble-element opåverkade (default-styling) — samtidigt som `.hidden` fortfarande fungerar INUTI panelen (form-view döljs korrekt). Harnessen har nu fejkade Bubble-element runt blocket just för att fånga det här.
  - **Lärdom att ta med:** en portad CSS-fil är inte "scopad" bara för att den har ett namnrymdat rot-element — kontrollera varje selektor. Snabbtest: extrahera alla selektorer ur `<style>` och lista dem som inte börjar med en känd namnrymd.
- **⚠️ MODAL-STACKING: tre buggar till efter CSS-fixen (lösta 2026-08-17).** Efter CSS-scopingen låg Bubble-chromen kvar — men försvann igen så fort en modal öppnats. Rotorsak: modalerna är `position:fixed` INUTI Bubbles positionerade Group-kedja, så de stackas inom den contexten (se stacking-avsnittet i [[reference-bubble-multiblock-collision]]). Wizarden löser det med `raiseAncestors()` (lyft alla positionerade föräldrar medan modalen är öppen, återställ vid stängning) — men:
  1. **`wtCloseModal_k` återställde aldrig.** Wizardens EGNA knappar ("Avbryt", "Klar — stäng") anropar den, inte `closeWiz()`. Alltså: stäng via wizardens knapp → blockets container ligger kvar på `z-index:2147483000` och täcker sidomenyn tills sidan laddas om. **Fix:** `wtCloseModal_k` wrappas i glue-scriptet och kedjar in `restoreAncestors` → EN stäng-väg.
  2. **`raiseAncestors` saknade dubbel-skydd.** Andra öppningen sparade det REDAN höjda värdet som "original" → även X-knappen "återställde" sedan till 2147483000. Permanent. **Fix:** `if (m._raised) return;`.
  3. **Skapa/redigera/import-modalen (`.ab-mask`) lyfte aldrig alls.** Den är `z-index:9000` men fastnar i blockets stacking-context → Bubbles sidomeny (lägre z-index men egen context) målas ovanpå och äter klicken. **Fix:** `MutationObserver` på maskens `.on`-klass som kör raise/restore — täcker alla öppna/stäng-vägar (skapa/redigera/import/spara/avbryt/kryss) utan att patcha varje anropsställe.
  - **⚠️ Samma defekt (1) och (3) finns i `mira-abonnemang-admin.html`** — den syns bara inte där, för på stora avtalsvyn ÄR blocket hela sidan och det finns ingen chrome att täcka. Christian trodde rimligt nog att det var uppsatt annorlunda där; det är det inte. **Porta fixarna dit om admin-blocket någonsin hamnar på en sida med Bubble-chrome.**
  - **Verifierat i harness** med simulerad Bubble-chrome (sidomeny i positionerad container, `z-index:10`): föräldrarnas inline z-index går 5/1 → 2147483000 vid öppning och tillbaka till 5/1 vid stängning — för wizardens egen knapp, X-knappen, Escape OCH skapa-modalens Avbryt/kryss, över upprepade cykler utan drift. `body.overflow` nollas.
  - **Öppen designfråga:** modalerna täcker fortfarande hela appen medan de är öppna, och hela mönstret vilar på att manipulera främmande föräldrars z-index. Christians förslag — expanderade vyer INNE i blocket i st.f. overlays — skulle ta bort hela buggklassen. Genomförbart: panelerna ligger redan utanför kortets re-render, så inline-formulär är säkra state-mässigt. Kräver omarbetning av tre ytor (skapa/redigera-modal, 5-stegs-wizard, import-granskning). Ej gjord — beslut kvar.
- **Ej testat skarpt:** contract-/approval-endpointsen kördes mot handmockade svar (formerna tagna ur källblockens egen kod, som kör mot dem i produktion) — själva backend-beteendet är alltså inte verifierat av harnessen. Bilaguppladdning per avtal och wizardens steg 2–5 (inkl. render-and-send) är inte genomklickade.

### ⚠️ ÄGARSKAP på nya aktiviteter: `writer` sattes aldrig (löst 2026-08-17)
**Symptom:** möten som kollegor skapade saknade ansvarig i mötestratten (`mira-motesbokning.html`) — man tappade vem aktiviteten tillhörde. I App data syns det som tomma `writer`-celler på just de raderna.
- **Rotorsak:** `writer` (User) LÄSTES på fyra ställen (`salj_api` aktRep, `companies_api` nActivity, `affar_api` nAktFull, affär-filter) men **SKREVS aldrig**. Båda våra create-endpoints — `POST /admin/companies/:id/historik/create` och `POST /admin/affar/aktivitet/create` — skapade `activitet_crm` utan ägare. Rader med writer i databasen kommer från Bubble-native formulär.
- **Varför inte "Created By":** allt vi skapar via Data API får API-nyckelns user som Created By → oanvändbart som ägare. Därför är `writer` enda vägen, och fallbacken `writer || Created By` i normaliserarna hjälper inte.
- **Fix:** båda endpoints tar emot `by_user` (User unique id) → sätter `writer`. **Bara vid create** — patch flyttar aldrig ägarskapet (smoke-testat). Skickas ej `by_user` skrivs ingen tom writer.
- **Frontend:** nytt `data-mira="current_user"` (Current User's unique id) i **`mira-foretag-lista.html`** (kortets Historik + snabbåtgärd "+ Ny aktivitet") och **`mira-affar-samlad.html`** (Ny aktivitet). Samma bindningsnamn som `mira-motesbokning.html` redan använder.
- **OBS `mira-motesbokning.html` skapar inga möten** — den bara läser tratten och patchar befintliga (`/admin/salj/moten`, `/admin/salj/mote/:id/patch`). Skapandet sker i kortet/affärsvyn. Om något möte ändå skapas via en **Bubble-native workflow** måste den sätta `writer = Current User` på Bubble-sidan; det når vi inte från Render.
- **Ej gjort:** backfill av befintliga rader utan writer. Går att göra men kräver att man vet vem som skapade dem — Created By pekar på API-nyckeln, så informationen finns inte kvar. Fråga Christian om de ska tilldelas manuellt.
- **Verifierat:** companies_smoke 180/180 + affar_create_smoke 26/26, båda **mutationstestade** (mot gammal kod faller exakt writer-testerna: 3 resp. 1). Övriga sviter gröna (salj 40/40, cc_cache 26/26, affar_ansvarig 27/27).
- **Deploy:** `companies_api.js` + `affar_api.js` (Render) + klistra om `mira-foretag-lista.html` och `mira-affar-samlad.html` + **bind `data-mira="current_user"` till Current User's unique id i båda blocken**. Utan bindningen fungerar allt som förut (ingen writer sätts) — ingen krasch.

### Företagslistan: sortering på "senast ändrad" (KLAR + verifierat 2026-08-17)
Listan sorterade bara på bokstav/kolumn. Nu finns en **fristående växlare "A–Ö / Senast ändrad"** i filterraden (högerställd, accentfärgad när aktiv) + en **"Ändrad"-kolumn** som visar relativ tid ("idag", "3 dagar sedan") plus **VAD** som rörde företaget.
- **"Senast ändrad" = MAX** av företagets egen `Modified Date` OCH senaste raden i sex relaterade typer. **Företagsfälten är verifierade** (HANDOFF "Företagsfält per typ" + [[reference-bubble-todo-fields]]) — gissa aldrig här, fel fältnamn ger tysta nollresultat: `activitet_crm`→`company` · `Coworker`→`Kundföretag` · `Matter`→`Kundföretag` · `Lead`→`client_company` · `deal`→`kundföretag` · `Todo`→`Företag`. `modified_src` säger vilken (`aktivitet`/`person`/`ärende`/`lead`/`affär`/`todo`/`grunddata`).
- **`index.js`:** `_projectCompany` bär nu `modified` (gratis — redan hämtad). Ny lat cache **`sharedCompanyTouchMapWarm()`** → Map(companyId → {ts, src}). **⚠️ WU: INGEN boot-prewarm/setInterval** och icke-blockerande som omsättningen (`touch_ready`-flagga; listan väntar aldrig på svepen).
- **⚠️ Varför delta är säkert här:** aggregatet är ett **MAX**, så nyare rader kan bara flytta värdet FRAMÅT — en delta på `Modified Date` kan aldrig ge ett för gammalt svar. Därför: helsvep en gång per typ, sedan bara `Modified Date > senast sedda` (0–1 sidor i steady state). Raderade rader kan lämna en för ny stämpel kvar; harmlöst för "senast rörd". Misslyckas en typs svep rörs INTE dess `since` → nytt försök nästa varv.
- **`companies_api.js`:** `_ctx` bär `touch`/`touchReady`; `_rowOf` returnerar `modified`/`modified_ts`/`modified_src`; `SORT_GETTERS.modified` + `NUMERIC_SORT`; ny **`DEFAULT_DESC`** så `sort=modified` utan `dir` ger nyast först (bokstav fortsätter defaulta asc). Svaret bär `touch_ready`.
- **Fungerar oavsett filter** — sorteringen körs EFTER filtreringen i minnet, så växeln gäller alltid hela träffmängden. Verifierat: filter kvar när man växlar sortering, sortering kvar när man byter filter.
- **Frontend:** `.fl-sortbar`/`.fl-sortbtn` + `modifiedCell`/`agoText` + `scheduleTouchRefetch` (samma SWR-mönster som omsättningen — viktigt här eftersom **ORDNINGEN** ändras när svepen blir klara, inte bara cellinnehållet). Klick på redan aktiv knapp vänder riktningen (kommer åt "äldst först"). **Gotcha:** filterraden renderas BARA en gång (annars tappar sökfältet fokus/caret vid debounce-reload) → växlarens aktiv-markering uppdateras separat via `syncSortBar()` från `renderTable()`. Första versionen missade det: sorteringen bytte men markeringen satt kvar på A–Ö.
- **Verifierat:** companies_smoke **189/189** (+9: default-desc, MAX-semantik, `grunddata` när egen tid vinner, fallback utan relaterad rörelse, explicit asc, sortering+filter i båda riktningar, kall cache→`touch_ready:false`) · cc_cache_smoke **42/42** (+16: helsvep=6 typer, varm=0 anrop, stale=DELTA per typ, MAX flyttar framåt men aldrig bakåt, källan följer nyaste raden, regressionsvakt mot prewarm/interval) · **mutationstestat** (7 resp. flera faller mot gammal kod) · browser-harness (växling, filter-interaktion, aktiv-markering, relativa tider "idag/igår/4 v sedan" + källa).
- **WU-modell (räkna själv med loggen):** kostnad = sidor × ~1,65 WU. Sidor ≈ Σ ceil(rader/100)+1 per typ. `[cc-touch]`-raden i Render loggar **rader per typ** vid varje varv → läs av verklig kostnad i st.f. att uppskatta. Kall/helsvep: en gång per Render-start + var 12:e h aktiv användning. Delta: **6 anrop ≈ 10 WU** per refresh, och bara när någon laddar listan och cachen är >15 min gammal → aktiv arbetsdag ~40 WU/h, idle **noll**.
- **⚠️ CC_TOUCH_FULL_TTL = 12 h (tillagt när WU-kompromissen skrevs ned).** Delta läser aldrig om gamla rader → **raderingar upptäcks aldrig**, och en raderad nyaste-rad skulle hålla företaget för högt i sorteringen för alltid på en långkörande instans. Helsvepet nollställer kartan + `since`. Drift från raderingar är därmed max 12 h (och nollas vid varje deploy, eftersom Render startar om). Smoke-testat: delta ser INTE raderingen, helsvepet rensar den.
- **Färskhets-kompromiss:** `CC_TOUCH_TTL` 15 min + stale-while-revalidate → en ny aktivitet kan ta upp till ~15 min + en extra sidladdning innan ordningen ändras (första requesten efter utgången TTL servar gammal data och refreshar i bakgrunden). Höj TTL:n → billigare men tröttare; sänk → dyrare. 60 min skulle ge ~100 WU/dygn i st.f. ~400.
- **Semantik att känna till:** aggregatet bygger på **Modified Date** (fallback Created Date). Alltså "senast rörd", inte "senaste händelse i tiden" — redigerar man en två år gammal aktivitet hamnar företaget högst. Och **bara** de sex typerna + ClientCompany räknas: offert, order, faktura, avtal/Contract, kvalitetskontroll och Office bumpar INTE (per Christians spec).
- **Deploy:** `index.js` + `companies_api.js` + klistra om `mira-foretag-lista.html`. Ingen Bubble-bindning behövs. Första gången någon sorterar på "Senast ändrad" görs sex helsvep (lat) — därefter delta.

### ⚠️ DÖTT FÖRETAGS-ID: Bubble-400-storm i Render (löst 2026-08-17)
**Symptom (Render-logg 17 aug, ~1,5 h):** upprepade `[/admin/approval/list] failed` och `[/admin/approval/users-by-company] failed` med Bubble **400 MISSING_DATA**: `"Invalid data for endpoint OfferApprovalRequest, key clientcompany: object with this id does not exist: 1786973695006x…"` (och samma för `User.Associated_company`). Två olika id:n, båda skapade samma dag.
- **Rotorsak:** Bubble svarar 400 när man constraintar ett **referensfält** med ett id som inte finns. Företaget var raderat i Bubble men låg kvar i den delade CC-cachen → syntes i listan → klick öppnade kortet → varje referens-query på id:t 400:ade.
- **⚠️ Detta är en följdeffekt av delta-refreshen (samma dag):** förut svepte cachen om HELA ClientCompany var 10:e minut, så ett raderat företag försvann inom 10 min. Med delta ser vi bara ÄNDRADE rader → raderade ligger kvar till nästa helsvep (`CC_FULL_TTL` 12 h). Det nya kortets Avtal-flik gjorde bara problemet synligt som hårda fel.
- **Fixar:**
  1. **`_deadRefId(e)`** (index.js, vid `bubbleFind`) — plockar ut id:t ur Bubbles felkropp. **Matchar SMALT** (`status 400` + `object with this id does not exist: <id>`): fel FÄLTNAMN, fel typnamn och 5xx måste fortsätta braka, annars döljer vi äkta bugs (jfr `Internal_room`-fällan).
  2. **`sharedCompanyForget(id)`** — kastar företaget ur alla tre CC-kartorna direkt, så listan slutar erbjuda det utan att man behöver vänta ut de 12 timmarna. Loggar `[cc-cache] glömde raderat/okänt företag <id>`.
  3. **De två approval-endpointsen** svarar nu `{ok:true, items:[], stale_ref:<id>}` i st.f. 500 vid dött id, och evictar.
  4. **`/admin/companies/:id/card`** verifierar företaget mot Bubble (`bubbleGet`) innan kortet byggs → `404 {error:"company_not_found", stale_cache:true}` + evictering, i st.f. ett tomt skal där varje flik tyst returnerar noll.
- **Verifierat:** companies_smoke **193/193** (+4: 404+stale_cache, evictering, andra anropet 404 direkt ur cachen, levande företag opåverkat) · cc_cache_smoke **61/61** (+13: `_deadRefId` mot Christians VERKLIGA felkroppar + att fältnamnsfel/404/5xx INTE matchas, plus evictering ur alla tre kartorna och no-op-fallen).
- **Kvar att välja:** om fler fantomföretag dyker upp kan `CC_FULL_TTL` sänkas 12 h → t.ex. 4 h (kostar ~90 WU per helsvep). Evicteringen gör det troligen onödigt.

### Skapa affär av lead/aktivitet på kundkortet (KLAR + verifierat 2026-08-18)
Affärsvyns "skapa affär av lead/aktivitet" finns nu även på kortets **Leads**- och **Historik**-avsnitt. **Ingen ny backend** — `POST /admin/affar/deal/create` (affar_api) är redan företags-agnostisk, tar `source_type: lead|aktivitet` + `source_id`, sätter källradens `deal`-fält och lead→`Delegerad`. `/admin/affar` ligger redan i openPrefixes.
- **`companies_api.js`:** `nLead` och `nActivity` returnerar nu **`deal_id`** — kortet ska bara erbjuda "skapa affär" på rader som INTE redan är kopplade.
- **Leads-fliken:** ny **Affär-kolumn** (bara för `tab==="leads"`) — `✓ Affär` om kopplad, annars `+ Skapa affär` som fäller ut formuläret i en rad under.
- **Historik:** samma knapp i den expanderade rad-detaljen (`histDetail`), eller `✓ Kopplad till affär`.
- **Formuläret** (`dealFormHtml`) är avskalat mot affärsvyns: Titel*/Kategori/Prel. värde/Ägare/Beskrivning. **Ingen företagssökning** — kunden är redan känd, och headern visar vilken. Titel + belopp förifylls från källraden. Återanvänder kortets `.fk-form`/`.fk-fld`/`.fk-formbtns`-konvention.
- **⚠️ Klick-ordning:** `cdopen`/`cdsave`/`cdcancel` hanteras FÖRE `histrow` i den delegerade klick-hanteraren + `stopPropagation`, plus en `if (t.closest(".fk-cd")) return;`-vakt. Utan det bubblar klick i formuläret upp till rad-toggeln och **kollapsar raden man just öppnade formuläret i**. Verifierat i harness att raden förblir öppen och att text man skrivit ligger kvar (ingen re-render mitt i inmatning — bara öppna/spara är committade övergångar).
- **Efter sparning:** källraden markeras kopplad lokalt, `counts.deals++`, `STATE.chain.deals` nollas så Deals-fliken hämtas om, list-cachen rensas (`listDirty`) eftersom nya affären påverkar företagets "senast ändrad".
- **Verifierat:** companies_smoke **197/197** (+4 `deal_id` på båda källtyperna, kopplad vs okopplad; **mutationstestat** — alla fyra faller mot gammal kod) + harness: Affär-kolumnen skiljer kopplat/okopplat, lead→affär (prefill titel+belopp, ägarlista ur meta, Deals-badge 1→2), aktivitet→affär (raden förblir öppen, text kvar, badge→3), båda affärerna syns i Deals-fliken.
- **Deploy:** `companies_api.js` + klistra om `mira-foretag-lista.html`. Ingen Bubble-bindning.

### ⚠️ `used_at` sprängde token-bränningen — reset-länkar återanvändbara (löst 2026-08-18)
**Symptom (Render):** `[bubblePatch] failed ... 400 {"status":"ERROR","message":"Unrecognized field: used_at"}` på `PATCH /obj/PasswordReset/<id>`, upprepat.
- **Rotorsak:** exchange patchade `{ used: true, used_at: … }`. **`used_at` finns inte** på typen — `PasswordReset` har bara `{email, coworker, token_hash, expires_at, used}`. **Bubble avvisar HELA patchen när ett fält är okänt**, så `used` sattes heller aldrig → **token brändes aldrig** → reset-länken gick att återanvända tills den gick ut (24 h). Felet doldes dessutom av ett `.catch(() => {})`.
- **Fixar:** (1) patchar nu bara `{ used: true }`; (2) **fail-closed** — kan token inte brännas returneras `500 burn_failed` och INGET temp-lösenord lämnas ut (tidigare svaldes felet och flödet fortsatte); (3) `assign_temp_password` och `create_user_account` **loggar nu Bubbles faktiska felkropp** (`[assign_temp_password] <base> HTTP <status>: <body>`) i st.f. att svälja den — förut blev varje fel bara `workflow_failed` utan diagnostik; `hint` skickas vidare till klienten.
- **⚠️ Varför smoken inte fångade det:** mockens `bubblePatch` gjorde `Object.assign` rakt av och var alltså **mer tillåtande än Bubble**. Nu validerar mocken mot `KNOWN_FIELDS` (verifierade scheman) och kastar samma 400 som Bubble. **Mutationstestat:** sätter man tillbaka `used_at` faller 3 tester (exchange ok, "brände token", replay→400). Utöka `KNOWN_FIELDS` när fler typer verifierats — det är billigaste skyddet mot precis den här klassen av fel.
- **OBS för felsökningen:** patch-felet var *caught*, så exchange fortsatte och returnerade 200. Det är därför sannolikt **inte** det som blockerade själva användarskapandet — den blockeringen ligger troligen i Bubble-wf:en `assign_temp_password` eller på `reset_pw`-sidan. Nästa försök visar orsaken i Render-loggen tack vare (3).

### ⚠️ User_role saknades på nya konton → utkastad från dashboard_crm (löst 2026-08-18)
**Symptom:** ny användare (skapad via kortets "Skapa konto") kunde sätta lösenord och logga in, men kastades direkt ut till `/index` — såg ut som en utloggning.
- **Diagnos via Bubbles debugger:** inloggningen var oskyldig — `Go to page dashboard_crm` KÖRDE (`admin_crm is yes` läses korrekt). Utkastningen sker på **dashboard_crm**, som har tre "Page is loaded"-guards (`RE: Redirect - Standard`) som alla gör `Go to page index`: `Current User is logged out` · **`Current User's User_role is empty`** · `Current User's Company is empty`. Company var satt, hon var inloggad → **User_role tom** var boven.
- **Rotorsak:** `POST /admin/companies/coworker/:id/create-account` skickade `{email, password, firstname, surname, company, coworker_id}` — **ingen roll**. HANDOFF sa att wf:en `create_user_account` skulle sätta "Company + Coworker + **roll**", men rolldelen fanns inte. Alltså föddes VARJE konto skapat från kortet utan `User_role` och blev utkastat.
- **Fix:** endpointen tar nu `role` och skickar det vidare till Bubble-wf:en (parametern `role` måste läggas till i wf:en `create_user_account` → "Set User_role"). Frontend: klick på "+ Skapa konto" fäller ut en **roll-väljare** i personraden; utan vald roll vägrar den skapa ("Välj roll först"). Bekräftelsedialogen namnger rollen.
- **⚠️ Rollerna HÅRDKODAS INTE** — de härleds ur datan (distinkta `User_role` bland Users) i samma `_users()`-svep som redan görs för namnen, alltså noll extra WU. Samma princip som `_matterStatuses`; vi gissar aldrig option-set-värden (jfr `Avslutad`→`Avslutat`, `Internal_local`→`Internal_room`). Option-set läses både som sträng och som `{display}`-objekt. Är rollistan tom (ingen User har roll) döljs kravet så flödet inte blockeras.
- **Verifierat:** companies_smoke **201/201** (+4: roles härledda och sorterade, objekt-formen, `role` når wf:en, tomt `role` när inget valts) — **mutationstestat**, alla fyra faller mot gammal kod. Harness: väljaren fylls med Ansvarig/Medarbetare ur datan, "Välj roll först" blockerar, bekräftelsen säger "som Ansvarig", väljaren stängs efter lyckat anrop.
- **⚠️ Testlärdom:** första versionen av testet gjorde `body.roles.indexOf(...)` → **kraschade** i st.f. att falla mot gammal kod, vilket dolde tre andra fel i mutationstestet. Assertions som rör fält som kan saknas måste skrivas defensivt (`(x || [])`), annars blir mutationstestet tyst missvisande.
- **Kvar i Bubble (Christian):** lägg till parametern `role` i wf:en `create_user_account` + steget "Set User_role = role". Sätt även `User_role` manuellt på Sofias befintliga User.

### Onboarding/lösenord (LIVE, funkar från start till mål)
Nyckelknapp/skapa-konto → vår endpoint skapar token (PasswordReset-typ) + mailar länk (SendGrid: `password_reset`-mall vid reset, `user_welcome`-mall m. USP-sektioner vid ny user) → reset_pw-sidan: **API Connector → exchange** (byter token mot engångs-temp via Bubble-wf `assign_temp_password`) → **Log the user in** + **Update password** (valt lösenord). Ny user: Bubble-wf `create_user_account` (Create an account for someone else + sätt Company/Coworker/namn). **Render kan EJ skapa User el. sätta valfritt lösenord via Data API → allt sådant via Bubble-wf** (auth ägs av Bubble).

### Bubble-delar (byggda av Christian, LIVE): typer `PasswordReset`{email,coworker,token_hash,expires_at,used} · wf `assign_temp_password`(email→temp) · wf `create_user_account`(email/password/firstname/surname/company/coworker_id→user_id) · API Connector-calls (exchange/send/create) · reset_pw-sidan. **Env (Render):** `PW_RESET_TEMPLATE_ID`, `WELCOME_TEMPLATE_ID`, `BUBBLE_ASSIGN_TEMP_WF=assign_temp_password`, `BUBBLE_CREATE_USER_WF=create_user_account`, `APP_BASE_URL=https://mira-fm.com`, `BUBBLE_PW_RESET_WF` (gammal, utgår).
### Status Ärende-OS (verifierat i bild 2026-08-16): **Pågående · Avslutat · Utkast**. Drift closed-flik = exakt `status=="Avslutat"` (Utkast hamnar i varken öppet/avslutat). counts.drift + open = "Pågående". Status-dropdown härleds ur datan (visar de som finns).
### KVAR ATT SKAPA I BUBBLE
- **`taggade_personer`** (List of Coworker) på `activitet_crm` — Aktivitet-fliken hämtar mot det; tom lista tills fältet finns + aktiviteter taggas.
- **`nasta_steg_kommentar`** (**text**) på `activitet_crm` — motiveringen vid avslutat spår (2026-08-26). Utan fältet sparas beslutet men motiveringen tappas; svaret bär `avslut_kommentar_field_missing:true` och UI:t säger det rakt ut.
- **`anteckning_todo`** (**Todo**, ref) på `activitet_crm` — idempotensmarkör för anteckningstodo-cronen (2026-08-26). **Utan fältet avbryter cronen med 500 och rullar tillbaka todon — med flit.**

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
