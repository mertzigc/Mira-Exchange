# Fastighetsägarvyn — Mira Fastighet

> **Skiss, inte en logg.** Första utkast 2026-09-03. Ingen kod byggd, inget deployat.
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

## 5. AUTH + SCOPE — SPEGLAR /visitor

`landlord_auth.js` (ny) speglar `visitor_auth.js` rakt av. Samma HMAC, samma
timing-safe jämförelse, samma server-till-server-mint.

| | `/visitor` | `/fastighet` |
|---|---|---|
| Roll | `User_role = Receptionist` | `User_role = Hyresvärd` **(nytt OS-värde)** |
| Header | `x-visitor-token` | `x-landlord-token` |
| Scope i payload | `fast: [fastighet-id]` | `fast: [fastighet-id]` + `hv: <hyresvärd-id>` |
| TTL | 12 h (täcker ett pass) | 8 h (en arbetsdag) |
| Env | `VISITOR_SESSION_SECRET` | `LANDLORD_SESSION_SECRET` |

**Scopet expanderas server-side.** `POST /landlord/session` läser `User.hyresvard`
(ref till `Hyresvärd`), slår upp hyresvärdens fastigheter och skriver in en
**explicit lista** i tokenen. Två skäl:
1. Regeln **tom lista = ingen åtkomst, aldrig "alla"** överlever oförändrad från
   `/visitor`. Den är mutationstestad där och ska inte omtolkas här.
2. En ägares förvaltare kan ha ett smalare scope än hela beståndet
   (`User.hyresvard_fastigheter`, valfri) utan att endpointlogiken ändras.

Nekar med **403 `no_fastigheter_assigned`** hellre än att minta en tom session.

⚠️ **BÄR ALDRIG `PLANNING_ADMIN_TOKEN` i blocket.** `guard()` i `companies_api.js` är
en token för hela modulen — läcker den ligger 5 499 företag och all personal öppna.
Samma regel som `/visitor` och Min sida.

⚠️ **Tokenen är en ögonblicksbild.** Samma fälla som slog 2026-08-28 på receptionisten:
ändras scopet i Bubble-editorn syns det inte förrän tokenen går ut. Database
trigger på `User` behövs: `hyresvard` eller `User_role` ändras → `landlord_token = ""`.

### Kvar i Bubble innan något fungerar skarpt (Christian)
1. Lägg **`Hyresvärd`** i option set `User_role`.
2. Nytt fält **`User.hyresvard`** (ref till `Hyresvärd`).
3. Valfritt: **`User.hyresvard_fastigheter`** (List of Fastighet) för smalare scope.
4. Sida `fastighet` + page-load-guard. **`dashboard_crm`-guarden måste utökas** —
   den skickar idag bara `Receptionist` vidare till `/visitor`; utan en gren för
   `Hyresvärd` hamnar en fastighetsägare i vårt CRM.
5. Backend-wf `landlord_session` → `POST {HOST}/landlord/session`, header
   `x-landlord-secret`, body `{user_id}`. Hemligheten aldrig i ett HTML-block.
6. Database trigger enligt ovan.

---

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

### ⚠️ Måste verifieras i Bubble innan kod skrivs
1. **`Fastighet.Ägare`** — schemat listar fältet (`Adress·Bild·Bildspel·Coworker·
   Hyresgäster·Kluster·Kontor·Leverantör·Medarbetare·Region·Titel·Ägare`), men det är
   **inte verifierat** att det pekar på `Hyresvärd`, och det är inte verifierat att det
   är ifyllt. Utan den kopplingen finns ingen väg hyresvärd → fastigheter, och hela
   scope-modellen i §5 faller. **Detta är den enda blockerande frågan.**
   Fallback om fältet är tomt: härled beståndet ur `Hyresvärd.Hyresgäster` →
   `ClientCompany.Fastighet`. Fungerar, men fastigheter utan hyresgäst i Mira syns då inte.
2. **`Hyresvärd`-typens fulla fältlista.** Vi känner bara till `Namn` och `Hyresgäster`
   ur mocken i `companies_smoke.mjs`.
3. **Hur `Matter` skiljer gemensam yta från hyresgästyta.** Idag går kopplingen via
   `Matter.Kontor` → `Office`. Ägarens egna ytor är ägarens egna Office-rader — men
   det behöver bekräftas mot hur Vasakronans rader faktiskt ser ut.

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

| Steg | Vad | Beroende |
|---|---|---|
| 0 | **Verifiera `Fastighet.Ägare` i Bubble-editorn** | blockerar allt |
| 1 | `landlord_auth.js` + `POST /landlord/session` + `landlord_auth_smoke.mjs`, mutationstestat | steg 0 |
| 2 | Bubble: OS-värde, `User.hyresvard`, sida, guard, backend-wf, trigger | steg 1 |
| 3 | `landlord_api.js`: `/landlord/context` + `/landlord/bestand` (vy 3.1 + 3.2) | steg 1 |
| 4 | `mira-fastighet.html` mot skarp data — beståndsvyn ensam | steg 3 |
| 5 | Ärenden + Kvalitet (återanvänder drift-endpointernas läslager) | steg 4 |
| 6 | **Hyresgästpuls** — trenddefinitionen skriven och testad först, vyn sedan | steg 5 |
| 7 | Tjänstekartan + Källtäckning | steg 6 |

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
