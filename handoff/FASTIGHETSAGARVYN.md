# Fastighetsägarvyn — Mira Fastighet

> **Skiss + auth-fundament.** Första utkast 2026-09-03. Auth BYGGT och mutationstestat
> samma dag — **ej deployat**. Vyn själv är fortfarande mockdata.
> Klickbar prototyp med mockdata: `mira-fastighet-skiss.html` (öppna lokalt i webbläsare).
> Systerdokument: [GRANSSNITTSSTRATEGI.md](GRANSSNITTSSTRATEGI.md) — **läs §3 och §4 där först.**
> Speglar auth-mönstret i [BESOKSHANTERING.md §7.5](BESOKSHANTERING.md).

---

## 0. VARFÖR DEN HÄR VYN, OCH VARFÖR NU

Gränssnittsstrategin listar tre saker vi aldrig släpper. Den tredje är
**leverans- och kvalitetsdatan** — och beskrivningen där är ordagrant
*"underlaget för ägarvyn, och det enda vi har som ingen annan kan producera"*.

Det här dokumentet är den ägarvyn.

Poängen är inte att bygga en app som konkurrerar med Flowpass eller Spaceflow.
De vänder sig till **hyresgästen**. Den här vyn vänder sig till **ägaren**, och den
visar något ingen plattformsleverantör kan visa: vad som faktiskt händer i huset,
mätt av den som utför arbetet.

**Konsekvensen är strategisk, inte kosmetisk.** Låt ägaren äga skyltfönstret mot
hyresgästen. Så länge ägaren också läser *vår* vy för att förstå sitt eget bestånd
är vi inte en utbytbar underleverantör — vi är ögonen. En ägare som kopplar bort oss
förlorar då inte en leverantör utan sin enda insyn i servicelivet i sina hus.

⚠️ **Blanda inte ihop den här vyn med beställnings-API:et.** GRANSSNITTSSTRATEGI §4
punkt 3 säger *"exponera ordrar in och leveransstatus ut, aldrig kvalitetsdatan"*.
Den regeln gäller **maskin-till-maskin mot en främmande plattform**. Den här vyn är
vår egen front, mot en namngiven inloggad person hos ägaren, med vårt varumärke i
huvudet. Kvalitetsdatan får synas här — den får inte flöda ut i ett API.

---

## 1. NAMN OCH ROUTE

| Kandidat | För | Emot |
|---|---|---|
| **`/fastighet`** ← rekommenderad | Samma ord som Bubble-typen och som kunden själv säger. Ingen översättning i huvudet. | Låter singular fast vyn är beståndsvid |
| `/bestand` | Branschordet ("fastighetsbestånd"), unikt | Otydligt för en ny läsare; å:et faller bort i URL:en |
| `/realestate` | Christians förslag | Engelska i en svensk produkt; generiskt — kunde vara vad som helst |

**Rekommendation: `/fastighet`, modulnamn "Mira Fastighet".** Sidan i Bubble heter
`fastighet`, blocket `mira-fastighet.html`, backend-prefixet `/landlord`
(engelskt prefix som `/visitor` — det är kod, inte kundtext).

---

## 2. LÖFTET, I EN MENING

> **Allt som händer i era hus från ett serviceperspektiv — utan en enda krona.**

Inga belopp. Aldrig. Priser hör hemma i avtalet mellan oss och hyresgästen, och
GRANSSNITTSSTRATEGI §3 punkt 1 säger att prislogiken aldrig lämnar prismotorn.
Att visa hyresgästens kostnader för hyresvärden är dessutom en förtroendefråga vi
inte har råd att svara fel på.

**Drömmen — inblicken de aldrig haft:** en fastighetsägare vet vad hyresgästen
betalar, hur många kvadratmeter de har och när avtalet löper ut. De vet ingenting om
hur hyresgästen *mår*. Serviceaktivitet är den tidigaste signal som finns i ett hus:
en hyresgäst som slutar beställa lunch, drar ner städfrekvensen och slutar ta in
extrapersonal har ofta bestämt sig långt innan uppsägningen kommer. Passagestatistik
säger att folk går in genom dörren. Den säger inte att de har slutat tro på huset.

Det är den siffran vi kan ge, och ingen annan.

---

## 3. VAD ÄGAREN SER — SEX VYER

Alla siffror nedan finns eller är härledbara ur data vi redan har. Källorna står
per vy. Se §6 för vad som saknas.

### 3.1 Pulsremsan (alltid synlig)
Fem kort: **Städpass · Mat & event · Bemanning · Öppna ärenden · Kvalitet**.

⚠️ **Ingen totalsumma över de tre affärsområdena.** BOKNINGSLAGE-regeln gäller här
precis som i bokningslägesvyn: tre bolag, tre mått, ingen gemensam summa. Ett pass,
en leverans och ett månadsuppdrag är inte samma enhet — en hopslagen siffra hade
varit ett tal utan innebörd, och första gången någon frågade vad det betydde hade
vi inte kunnat svara.

*Källa:* `Activity` (Tengella HK) · `FortnoxOrder(FE)` · `IntelliplanOrderMonth` ·
`Matter` · `QualityControl` + `Grade.Värde`.

### 3.2 Bestånd
En rad per `Fastighet`: hyresgäster, kvm i service, arbetsplatser, sex månaders
aktivitet i tre spår, öppna ärenden, medeltid till stängning, kvalitetssnitt,
tjänstetäckning. Klick filtrerar hela vyn till huset.

*Källa:* `Office.Fastighet` + `Office.Yta` + `Office.Arbetsplatser` ·
`ClientCompany.Fastighet` (list).

### 3.3 Hyresgästpuls ← **vyns själva poäng**
En rad per hyresgäst, sorterad med störst risk överst. Trendetiketterna
**Växande / Stabil / Avtagande / Tyst** räknas per affärsområde: avtagande när minst
två av tre spår faller mot föregående kvartal, tyst vid noll registrerad aktivitet
på över 60 dagar.

⚠️ **Definitionen är hela produkten.** Görs den på magkänsla blir vyn en gissning i
tabellform. Den måste vara skriven, testad och likadan varje gång — och den måste
tåla att en ägare säger *"varför står det avtagande på min bästa hyresgäst?"*.

*Källa:* samma tre aktivitetsspår + `Contract` (aktiva tjänster) + QC-snitt.

### 3.4 Ärenden — **delad i två, av princip**
- **Era egna ytor** (entréer, hisshallar, lounger, garage, lastkajer): full detalj,
  rubrik, prioritet, avvikelseflagga, ålder. Det är ägarens egna `Matter`-rader.
- **Hyresgästernas ärenden**: bara aggregat per hus — volym, avvikelsegrad,
  kategori, medeltid till stängning. Aldrig rubrik, beskrivning eller person.

Se §4.

### 3.5 Kvalitet
Kontrollsnitt per hus **och per ytatyp** (toaletter, pentry, reception, korridor,
mötesrum, städförråd). Ytatyps-nedbrytningen är den som gör något: ett hussnitt på
4,2 döljer att toaletterna ligger på 3,1 i ett av husen.

*Källa:* `QualityControl` + `Kommentar - Comment` (typnamn med mellanslag och
bindestreck) där `kvalitetskontroll` == QC → `Grade.Värde`. **Snittbetyg är medel av
`Grade.Värde`** — samma sanning som kundkortet visar. `Betyg_lev` är inte verifierat
mot skarp data, använd det inte.

### 3.6 Tjänstekartan
Matris hyresgäst × tjänst, plus "vitt utrymme" per tjänst. Ramas in som
**attraktivitet**, inte försäljning: vad huset erbjuder sina hyresgäster idag mot vad
det skulle kunna erbjuda. Det är ägarens språk — attraktivitetsaffären — och det är
sant, inte bara säljvänligt.

*Källa:* `Contract.Kundföretag` + `Contract.erbjudande` (lower e) · `ServiceCatalog`.

### 3.7 Källtäckning ← **den som bygger förtroendet**
Vad vyn bygger på, vilken källa, hur stor täckning, senast uppdaterad, status.

**Det här är sidan ingen annan visar.** En tom kolumn ser ut som "inget händer" när
den i själva verket betyder "vi mäter inte här än". Att vi skriver ut det själva är
skillnaden mellan en vy som håller vid första invändningen och en som inte gör det.
Det är också haverilistan i GRANSSNITTSSTRATEGI §5 tillämpad på oss själva.

---

## 4. ⚠️ INTEGRITETSREGELN — LÄS INNAN EN RAD KOD SKRIVS

**Ägaren ser HUSET. Hyresgästen äger sitt eget innehåll.**

Ett `Matter` innehåller vad som gick fel hos en namngiven hyresgäst och vem som
anmälde det. Hyresgästen är **vår** kund — GRANSSNITTSSTRATEGI §3 punkt 2 säger att
den direkta kundrelationen aldrig lämnar oss. Att skicka den relationens innehåll
vidare till hyresvärden är att sälja den.

| Nivå | Ägaren ser | Regel |
|---|---|---|
| Husaggregat | volym, avvikelsegrad, kategori, lösttid, kvalitetssnitt | alltid |
| Ägarens egna ärenden | allt | `Matter.Kundföretag` == ägarens egen `ClientCompany` |
| Hyresgästens ärenden | bara aggregat | rubrik/beskrivning/person **aldrig** |
| Hyresgästens egna QC-betyg | bara aggregat | opt-in per kund, fas 2 |

**Startregeln kräver inget nytt fält:** ägaren är själv en `ClientCompany` (de köper
reception och lokalvård av oss till sina egna ytor). Deras egna `Matter`-rader visas
i sin helhet, alla andras aggregeras. Opt-in per hyresgäst (`ClientCompany`-flagga
"dela driftdata med fastighetsägaren") är fas 2, inte en förutsättning.

⚠️ **Det finns ett kommersiellt skäl utöver det principiella.** En ägare som ser varje
hyresgästs enskilda kvalitetsbetyg har fått ett slagträ inför nästa upphandling.
Aggregerat är samma data ett leveransbevis. Skillnaden är vem siffran tillhör.

---

## 5. AUTH + SCOPE — BYGGT 2026-09-03, EJ DEPLOYAT

`landlord_auth.js` speglar `visitor_auth.js` rakt av. Samma HMAC, samma timing-safe
jämförelse, samma server-till-server-mint.

| | `/visitor` | `/fastighet` |
|---|---|---|
| Roll | `User_role = Receptionist` | `User_role = Hyresvärd` ✅ finns |
| Header | `x-visitor-token` | `x-landlord-token` |
| Payload | `{uid, fast[], name}` | `{uid, hv, fast[], name}` — `hv` = Hyresvärd-id |
| TTL | 12 h (ett pass) | 8 h (en arbetsdag) |
| Env på Render | `VISITOR_SESSION_SECRET` | **`LANDLORD_SESSION_SECRET`** |

**Filer:** `landlord_auth.js` · `landlord_auth_smoke.mjs` (38 gröna, **8 mutationer,
8 faller**) · `POST /landlord/session` i `index.js` · `landlord_session_smoke.mjs`
(27 gröna, **11 mutationer, 11 faller, 0 kraschar**) · `/landlord` i `openPrefixes`.

### 5.1 ⚠️ OPTION-SET-FÄLLAN PÅ `User`

På `User` finns **två fält som båda ser rätt ut**:

| Fält | Typ | Använd? |
|---|---|---|
| **`Hyresvärd`** (versalt H, med ä) | ref → `Hyresvärd` | ✅ **DEN HÄR** |
| `hyresvard` | option set `User_role` | ❌ raderas — den skapades av misstag |

Läser man fel fält får man tillbaka **strängen `"Hyresvärd"`**. Den är truthy, passerar
varje enkel sanningskoll och slår sedan mot `bubbleGet("Hyresvärd", "Hyresvärd")` → 404
som ser ut som *"hyresvärden finns inte"* i stället för *"vi läste fel fält"*.

Därför finns `bubbleRefId()` i `landlord_auth.js`: den kräver Bubble-id-formen
`<epoch-ms>x<siffror>` och förkastar allt annat. Ett eget test bevakar exakt den strängen.

### 5.2 Beståndet — TVÅ riktningar, ingen skriven av vår kod

Schemat har både `Hyresvärd.Fastighet` (List of Fastighets) och `Fastighet.Ägare`
(ref → Hyresvärd). **Ingen av dem skrivs av vår kod** — båda kan vara tomma eller stale.

Endpointen läser dem i ordning och **rapporterar vilken som bar datan** i svarets `kalla`:

1. `Hyresvärd.Fastighet` → `kalla: "hyresvard_lista"` (1 anrop, normalfallet)
2. tom lista → svep `Fastighet` och filtrera `Ägare` **i minnet** → `kalla: "fastighet_agare_svep"`

⚠️ **Ägare-riktningen går medvetet INTE som Bubble-constraint.** Constraint-nycklar är
slugar, inte visningsnamn ([[reference-bubble-data-api-keys]]), och `Ägare`s slug är
inte verifierad. En felgissad slug ger tyst noll träffar — vilket här hade blivit
"ägaren har inga fastigheter". Ett svep + minnesfilter kan inte ljuga på det sättet.

⚠️ **`kalla: "fastighet_agare_svep"` i loggen betyder att `Hyresvärd.Fastighet` behöver
backfillas.** Svepet är en fallback, inte en driftform.

### 5.3 Fyra distinkta felkoder — inte ett gemensamt "tomt"

| Kod | Betyder |
|---|---|
| `not_landlord` | rollen är inte Hyresvärd (svaret bär den faktiska rollen) |
| `no_landlord_linked` | `User.Hyresvärd` tom, eller innehåller ett option-set-värde |
| `no_fastigheter_assigned` | hyresvärden har inget bestånd i någon riktning |
| `fastigheter_outside_landlord` | `hyresvard_fastigheter` pekar på hus som inte är ägarens |

Den sista är poängen: att svara `no_fastigheter_assigned` där hade sagt "ingen tilldelning"
när sanningen är "tilldelningen pekar fel". Ett test vaktar skillnaden.

`User.hyresvard_fastigheter` **snittas** mot beståndet — den ersätter det aldrig. En
tilldelning kan smalna av, aldrig vidga.

### 5.4 Kvar i Bubble (Christian)

| # | Vad | Status |
|---|---|---|
| 1 | `Hyresvärd` i option set `User_role` | ✅ klart |
| 2 | `User.hyresvard_fastigheter` (List of Fastighet) | ✅ klart |
| 3 | Sidan `fastighet` | ✅ klart |
| 4 | **Radera fältet `User.hyresvard`** (option set, skapat av misstag) | ⏳ |
| 5 | Sätt `User_role = Hyresvärd` + `User.Hyresvärd` på testanvändaren | ⏳ |
| 6 | Fyll `Hyresvärd.Fastighet` **eller** `Fastighet.Ägare` för Vasakronan | ⏳ |
| 7 | API Connector-call + backend-wf `landlord_session` (§5.5) | ⏳ |
| 8 | Page-load-guard på `fastighet` ✅ · `dashboard_crm`-guarden utökad med båda rollerna ✅ | ✅ |
| 9 | Database trigger: `Hyresvärd`/`User_role` ändras → `landlord_token = ""` | ⏳ |
| 10 | Env på Render: `LANDLORD_SESSION_SECRET` | ⏳ |

⚠️ **Punkt 9 är säkerhetsrelevant och glöms lätt.** Tokenen är en ögonblicksbild —
samma fälla som slog på receptionisten 2026-08-28. Utan triggern släpar ett ändrat
scope i upp till 8 timmar.

### 5.5 Bubble-uppsättningen, steg för steg

**A. Nya User-fält (Data → User):**
- `landlord_token` — **text**
- `landlord_token_exp` — **date**

**B. API Connector → `Mira Render` → ny call `landlord_session`:**

| Inställning | Värde |
|---|---|
| Use as | **Action** |
| Data type | JSON |
| Method | POST |
| URL | `https://mira-exchange.onrender.com/landlord/session` |
| Header | `x-landlord-secret` = hemligheten, **Private** ikryssad |
| Header | `Content-Type` = `application/json` |
| Body type | JSON |
| Body | `{"user_id": "<user_id>"}` — `user_id` som parameter, **ej** Private |
| Include errors in response | ✅ ikryssad |

⚠️ **`exp_iso` måste sättas till typ `date` i Returned values.** Bubble lär sig fältet
som *text* vid initialiseringen, och text går inte i ett date-fält. Samma fälla som
`visitor_session` gick i.

Initiera calln med ett riktigt user_id så Bubble kan lära sig svaret. Får du 403
`no_landlord_linked` är punkt 5 i tabellen ovan inte gjord — initiera igen efteråt.

**C. Backend workflow `landlord_session`** — byggt 2026-09-03, speglar `visitor_session`:
- **Inga parametrar.** Workflowen läser `Current User` direkt. Ett schemalagt
  backend-workflow ärver användarkontexten från den som schemalade det — det är så
  `visitor_session` fungerar skarpt, och därför mönstret att kopiera.
- Steg 1: **Mira Render – landlord_session**, `(body) user_id = Current User's unique id`
- Steg 2: **Make changes to current user**, *only when `Result of step 1's body's ok is yes`*
  - `landlord_token` = `Result of step 1's body's token`
  - `landlord_token_exp` = `Result of step 1's body's exp_iso`
- "Expose as a public API workflow" = **NEJ**.
- ⚠️ Villkoret på steg 2 är det som gör att ett 403 aldrig skriver en tom token.

**D. Page load på sidan `fastighet`:**
- Villkor: `Current User is logged in` **och**
  `Current User's landlord_token is empty or Current User's landlord_token_exp < Current date/time`
- Action: **Schedule API Workflow** `landlord_session`, Scheduled date = `Current date/time`
  (inga parametrar — se C)
- ⚠️ Sessionen är **asynkron** — workflowen hinner inte klart innan sidan renderar.
  Blocket startar utan token och väntar in den. Det är inte ett fel.
- Steg FÖRE det: `Go to page index` *only when `Current User's User_role is not Hyresvärd`*
  — täcker även utloggad, eftersom tomt inte är Hyresvärd.
⚠️ **Loopvarning:** misslyckas sessionen (403) förblir `landlord_token` tom, och villkoret
schemalägger om vid varje sidladdning. Blocket måste visa felet, annars ser det ut som att
sidan bara laddar för evigt.

**E. `dashboard_crm`-guarden — ✅ redan täckt (verifierat 2026-09-03).** Guarden gattar
på **`admin_crm`**, inte på `User_role`: `admin_crm is no` → `Go to page index`. En
hyresvärd har inte `admin_crm`, så hen släpps aldrig in. Ingen ny gren behövs.

**Utökat 2026-09-03** till `admin_crm is no OR User_role is Receptionist OR User_role is
Hyresvärd`, så hyresvärden redirectas på rollen och inte på ett fält hen ändå inte har.

⚠️ `is not yes` finns inte som operator för yes/no i Bubble — det förslaget var fel.
Om `is no` inte matchar ett osatt `admin_crm` står en vanlig kundanvändare kvar på
`dashboard_crm`. **Det är i så fall ett äldre CRM-problem, inte den här modulens** — mät
det separat innan något byggs om.

*Valfri putsning:* guarden dumpar alla på `index`. En hyresvärd som klickar en gammal
CRM-länk hamnar då i ingenmansland. `User_role is Hyresvärd → fastighet` respektive
`Receptionist → visitor` före index-steget är trevligare, men är UX, inte säkerhet.

**F. Database trigger på `User`:**
```
When User's Hyresvärd changes  OR  User's User_role changes
  → Make changes to this User: landlord_token = ""
```

**G. Blocket** klistras på sidan `fastighet` med två `data-mira`-fält:
`api_host` = `https://mira-exchange.onrender.com` och
`landlord_token` = `Current User's landlord_token`.
⚠️ **Aldrig `planning_token` på den här sidan.**

### 5.6 Rökkör efter deploy

```bash
curl -sS -X POST "$HOST/landlord/session" \
  -H "x-landlord-secret: $LANDLORD_SESSION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<test-user-id>"}' | python3 -m json.tool
```
Kolla `kalla` i svaret: står det `fastighet_agare_svep` bär `Hyresvärd.Fastighet` ingen
data och bör backfillas. Kolla `antal_fastigheter` mot vad du faktiskt förväntar dig.

## 6. DATAINVENTERING — VAD FINNS, VAD SAKNAS

### Finns och är verifierat
| Behov | Var | Not |
|---|---|---|
| Hyresvärd → hyresgäster | `Hyresvärd.Hyresgäster` (List of ClientCompany) | **skrivs av vår kod** (`companies_api.js:2470`) |
| Hyresgäster per hus | `ClientCompany.Fastighet contains <id>` | kanonisk väg |
| Kontor per hus + yta | `Office.Fastighet` · `Office.Yta` · `Office.Arbetsplatser` | `_officeWrite` skriver `Fastighet` |
| Husnamn | `Fastighet.Titel` | ⚠️ **inte** `Namn`; `Adress` är ett geo-OBJEKT |
| Ärenden | `Matter` (`Kundföretag`, `Kontor`, `Prioritet`, `status`, `Avvikelse`) | drift-endpoints finns redan |
| Kvalitet | `QualityControl` + `Grade.Värde` | snitt = medel av `Grade.Värde` |
| Aktiva tjänster | `Contract` (`Kundföretag`, `erbjudande`, `Kontor`) | ⚠️ `erbjudande` med litet e |
| Tjänstekatalog | `ServiceCatalog` + `Erbjudande` | live sedan 2026-06-28 |
| HK-pass | `Activity` (`ActivityType = Housekeeping`, `Clientcompany`) | cron finns i `sync_v2_cron.sh` |
| F&E-leveranser | `FortnoxOrder(FE)` på `ft_delivery_date` | |
| S&P-uppdrag | `IntelliplanOrderMonth` | månadsnivå |

### ✅ Verifierat mot Bubble-editorn 2026-09-03 (skärmbilder)

**`Fastighet`:** `Adress`(geo) · `Bild` · `Bildspel` · `Coworker` · `Hyresgäster`(List of
ClientCompanies) · `Kluster` · `Kontor`(List of Offices) · `Leverantör` · `Medarbetare` ·
`Region` · `Titel`(text) · **`Ägare` → `Hyresvärd`** ✅

**`Hyresvärd`:** `Adress`(geo) · `Avtal`(List of Contracts) · `Email` ·
**`Fastighet`(List of Fastighets)** ✅ · **`Fastighetsägare - (1) för` → ClientCompany** ·
`Hyresgäster`(List of ClientCompanies) · `Kluster` · `Leverantör - supplier` · `Logo` ·
`Namn`(text) · `Order`(→ raderad typ) · `Org nummer`(number) · `Produkter` ·
`Telefon`(number) · `User`(List of Users)

**`User`** (relevanta): **`Hyresvärd` → `Hyresvärd`** ✅ · `hyresvard` → **option set
`User_role`** ⚠️ *fel fält, ska raderas* · **`hyresvard_fastigheter`(List of Fastighets)** ✅

**`User_role`** (option set): `Ansvarig` · `Konsult` · `Medarbetare` · `Ansvarig konsult` ·
`Receptionist` · **`Hyresvärd`** ✅

**Blockeraren från första utkastet är därmed borta** — `Fastighet.Ägare` pekar på
`Hyresvärd`, och dessutom finns listriktningen `Hyresvärd.Fastighet`. Se §5.2 för hur
båda hanteras.

### ⚠️ Kvar att verifiera

1. **Vilken riktning som faktiskt är IFYLLD för Vasakronans bestånd.** Båda fälten finns;
   ingen skrivs av vår kod. `kalla` i `/landlord/session`-svaret mäter det åt oss.
2. **`Hyresvärd.Fastighetsägare - (1) för` (→ ClientCompany).** Fältnamnet är **avklippt
   i editorns inmatningsruta** — samma klass som [[reference-bubble-id-truncation]], fast
   på ett fältnamn. Det ser ut att vara precis den koppling §4 behöver (hyresvärdens egen
   ClientCompany → ägarens egna ärenden), men **namnet får inte hårdkodas utan att läsas
   av från API:t**. Kör `?debug=1`-mönstret eller `all_field_names` först.
3. **Hur `Matter` skiljer gemensam yta från hyresgästyta.** Kopplingen går via
   `Matter.Kontor` → `Office` → `Office.Fastighet`. Att ägarens egna ytor ligger som
   ägarens egna Office-rader är rimligt men **inte mätt** mot Vasakronans data.
4. **`Hyresvärd.User` (List of Users)** är en tredje väg till kopplingen ägare↔inloggning.
   Vi använder `User.Hyresvärd` (enkelriktat, en user hör till en ägare). Skulle listan
   vara den som underhålls i praktiken behöver §5 en fallback åt det hållet också.

### Saknas helt
- **`Visit`-typen finns inte i Bubble än** (BESOKSHANTERING §8 steg B). Besöksflödet
  blir en tom kolumn tills receptionsmodulen rullar — därav raden i Källtäckning.
- **Pass per dag för S&P.** Intelliplan ger månadsnivå; pass/schema är fortfarande ett
  öppet spår.

---

## 7. FALLGROPAR

1. **⚠️ Tyst bortfall blir en anklagelse mot vår kund.** `syncTengella` hoppar tyst
   över varje Tengella-kund utan `company`-koppling — den kundens pass skapas aldrig.
   I kundkortet ser det ut som "inga inbokade pass". **I ägarvyn ser det ut som att
   hyresgästen inte får någon service.** Samma klass av fel finns i Intelliplan
   (1058 av 1081 konton mappade). Källtäckningsfliken är inte en trevlig extrafunktion
   — den är det som gör att det här felet inte kan sägas som ett påstående.
2. **⚠️ WU.** Ett bestånd med 40 hyresgäster × 6 månader × 3 källor blir ett helsvep
   per sidladdning om det byggs naivt. Bygg en **cachad aggregatrad per hyresvärd**
   (SWR, `AUX_TTL`-mönstret). **Lägg aldrig tillbaka en `setInterval` på ett helsvep**
   — den fällan kostade ~13 000 WU/dygn i augusti.
3. **`bubbleFindAll` med `sort_field` utelämnar poster som saknar värde i fältet.**
   Ett hus utan `Titel` försvinner tyst ur beståndslistan. Sortera i minnet.
4. **`Fastighet.Hyresgäster` och `Fastighet.Kontor` skrivs aldrig av vår kod** — de
   finns i schemat men kan vara tomma eller stale. Scopa via `ClientCompany.Fastighet`
   och `Office.Fastighet`.
5. **Bubble-fällorna gäller som vanligt:** `button:hover` med `!important`,
   `word-break: break-all`, case-sensitiva fältnamn, `safeCreate` som droppar okända
   fält tyst.

---

## 8. BYGGORDNING

| Steg | Vad | Status |
|---|---|---|
| 0 | Verifiera `Fastighet.Ägare` i Bubble-editorn | ✅ **klart 2026-09-03** |
| 1 | `landlord_auth.js` + `POST /landlord/session` + två svit­er, mutationstestade | ✅ **byggt, ej deployat** |
| 2 | Bubble: OS-värde, fält, sida, guard, backend-wf, trigger (§5.4) | 🟠 delvis — se tabellen |
| 3 | `landlord_api.js`: `/landlord/context` + `/landlord/bestand` (vy 3.1 + 3.2) | 🔴 |
| 4 | `mira-fastighet.html` mot skarp data — beståndsvyn ensam | 🔴 |
| 5 | Ärenden + Kvalitet (återanvänder drift-endpointernas läslager) | 🔴 |
| 6 | **Hyresgästpuls** — trenddefinitionen skriven och testad först, vyn sedan | 🔴 |
| 7 | Tjänstekartan + Källtäckning | 🔴 |

Steg 1–4 är en demonstrerbar produkt: ett bestånd, riktiga siffror, ingen krona.
Det räcker för att visa Vasakronan och Fabege medan tajmingsfönstret i
GRANSSNITTSSTRATEGI §6 fortfarande är öppet.

---

## 9. ÖPPNA FRÅGOR TILL CHRISTIAN

1. **Är ägaren en `ClientCompany` hos oss?** Integritetsregeln i §4 vilar på att
   Vasakronans egna ytor ligger som deras egna `Matter`-rader. Stämmer det?
2. **Vem loggar in?** En förvaltare per hus, en transaktionschef för hela beståndet,
   eller båda? Avgör om `hyresvard_fastigheter` behövs i steg 1 eller kan vänta.
3. **Ska ägaren kunna skapa ärenden i sina egna ytor**, eller är vyn helt läsande i
   version 1? Läsande är snabbare och räcker för att sälja in.
4. **Månadsrapport på mejl?** Samma innehåll som vyn, som ett utskick. `emailer.js`
   och mallmotorn finns redan. Det är ofta det som gör att en vy faktiskt används.
5. **Ska hyresgästpulsen visas för ägaren i version 1?** Den är produktens starkaste
   argument och samtidigt den känsligaste — den säger indirekt något om en
   namngiven hyresgästs framtid i huset. Går att hålla på husnivå först.
