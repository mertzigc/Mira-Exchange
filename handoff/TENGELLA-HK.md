# Tengella / Housekeeping

> ⚠️ **`TengellaWorkorder` är PENSIONERAD** (fryst 2026-06-04 av §9-cutovern).
> HK-ordrar bor i **`FortnoxOrder`, `connection = TENGELLA`**, daterade på
> **`ft_order_date`** — v2-adaptern sätter ALDRIG `ft_delivery_date`.
>
> **Tengella-PASS** (Housekeeping-scheman) är en HELT annan väg:
> `/v2/TimeTableEvent` → `activity_sync.js` → Bubble `Activity`
> (`ActivityType = Housekeeping`) → planeringsvyn. Inte att förväxla med
> Intelliplan-pass (Service & People).
>
> Minne: `reference-tengella-sync-kedjan`

---
### 🔴 UTREDNING 2026-08-20: HOUSEKEEPING-DATAN — VAD SOM FAKTISKT HÄNDE

**Symtom:** bokningsläget gav HK `antal: 1, belopp: 2880` för augusti. Christian: *"vi har inte skapat TengellaWorkorders sedan 4 juni."* Render: **cron-jobbet `TengellaNightlySync` (kör `tengella_cron.sh`) är manuellt suspended, sista lyckade körning 4 juni 2026.**

**⚠️ SLUTSATSEN "SYNKEN ÄR DÖD" VAR FEL.** Kedjan, verifierad i kod och git:

1. **`fb99584` 2026-06-04 17:09 — "Sync v2: cron-cutover".** §9-omtaget flyttade workordrar från den egna typen `TengellaWorkorder` till **unified `FortnoxOrder`** med `connection=TENGELLA` och `source="tengella-workorder"` (adapter i `invoice_sync.js`, `bubbleType: "FortnoxOrder"`).
2. **`TengellaNightlySync` suspenderades samma dag — MED FLIT.** Runbooken (§9e, HANDOFF rad 1574) föreskriver exakt det: *"STÄNG AV gamla order/offer/workorder-cron … `tengella_cron.sh` (workorder-delen)"* innan `SYNC_V2_ORDERS=1`.
3. **Cutovern gick LIVE 2026-06-08** (HANDOFF rad 1452): *"`SYNC_V2_ORDERS=1` aktiv. Nightly grön med order/offer/workorder."*

**`TengellaWorkorder` är alltså PENSIONERAD, inte trasig.** Frusen 4 juni by design. Att den inte får nya rader är korrekt beteende.

#### 🔴 DE TVÅ VERKLIGA FELEN

**FEL A — `affar_api.js` läser den pensionerade typen.** Rad 140/304, daterat **2026-08-07**: *"HK/Tengella-order = raw TengellaWorkorder (kanonisk källa, Fas 1 2026-08-07 — **färsk sync**, syns oavsett affär). FortnoxOrder(connection=TENGELLA) exkluderas i display … för att undvika dubbel mot ev. sync_v2-spegel."*

Kommentaren **påstår att synken var färsk** — den hade då varit avstängd i två månader. Och det som kallas "ev. sync_v2-spegel" är i själva verket den **kanoniska** källan efter cutovern. Följden: **affärsvyn/kundkortet har visat frusen juni-data för Housekeeping sedan 7 augusti**, och exkluderat den levande källan. ⚠️ **EJ ÅTGÄRDAT — eget spår, se nedan.**

**FEL B — mitt eget: `ft_delivery_date` på HK.** Bokningslägets första HK-fråga gick mot `FortnoxOrder(TENGELLA)` på `ft_delivery_date` → **0 rader**. Jag tolkade nollan som "fel tabell" och bytte till `TengellaWorkorder` — vilket gav 1 rad från juni, som färskhetskontrollen sedan (korrekt) flaggade som 77 dagar gammal. Två fel som pekade åt samma håll och bekräftade varandra.

**Sanningen:** `tengellaWorkorderAdapter` sätter `ft_order_date` + `ft_order_ts` men **ALDRIG `ft_delivery_date`** — workordern har bara `OrderDate`. Nollan berodde på ett fält som aldrig skrivs.

**Rättat:** HK = `FortnoxOrder`, `connection = TENGELLA`, fönster på **`ft_order_date`**. F&E ligger kvar på `ft_delivery_date`. **Olika datumfält i samma tabell** — därav de olika mått-etiketterna.

#### ⚠️ FÄRSKHETSKONTROLLEN MÅSTE VARA CONSTRAINTAD
HK och F&E bor i **samma tabell**. En okonstraintad `kallaFarskhet("FortnoxOrder")` hade gjort HK "färsk" enbart för att F&E synkas — falsk trygghet av exakt den sort kontrollen finns för att förhindra. Mäts nu per connection: `FortnoxOrder(TENGELLA)` resp. `FortnoxOrder(FE)`.

#### ✅ RÄTTELSE: SCHEMALÄGGNING/PASS FINNS — via en HELT ANNAN väg
Jag skrev först att ingen pass-integration fanns. **Fel** — jag greppade bara `index.js`. Den ligger i **`activity_sync.js`**:

```
POST /sync/activities/tengella      (requireSyncSecret)
  → activityEngine.syncForSource("tengella")
  → Tengella /v2/TimeTableEvent          ← FEMTE endpointen, utöver login/Customers/Invoices/WorkOrders
  → mapTimeTableEvent() → Bubble `Activity`
       ActivityType = "Housekeeping" · Category = "Housekeeping"
       Startdatum/Slutdatum ← ev.StartDateTime / EndDateTime
       tengella_employee_id/-name · project_id/-name · region_id/-name
       supervisor_id/-name · item_name · event_id · tengella_last_synced
  upsert-nyckel: Activity.source_id = "tengella:<EventId>"
```
Planeringsvyn (`mira-kalender.html`) läser `Activity` via `/admin/planning/activities` och renderar `tengella_employee_name` / `region` / `project` / `supervisor`. **Det är därifrån pass, person och tider kommer.**

#### 🔴 MEN: `/sync/activities/*` HAR INGEN CRON
Verifierat 2026-08-20: **inget script i repot anropar `/sync/activities/`** (genomsökt samtliga `*.sh`). Skrivvägen finns bara som *write-through* för Miras egna typer (`upsertActivityForComission` / `ForTodo`, anropade från förfrågan/popup). **Pull-vägen från Tengella körs alltså bara manuellt.** Tengella-passen i planeringsvyn är därmed frusna vid senaste manuella körningen — kontrollera `tengella_last_synced` via källhälsan nedan.


### ⭐ NYTT FOKUS: PASS PER KUND I PLANERINGSVYN
Största värdet enligt Christian: datum/tider/scheman per kund, med namn. **Det mesta finns redan:**
| Del | Status |
|---|---|
| Pass-data (`/v2/TimeTableEvent` → `Activity`) | ✅ finns |
| Start/sluttid | ✅ `Startdatum` / `Slutdatum` |
| **Namn på utföraren** | ✅ `tengella_employee_name` → renderas som **"Utförare"** (mira-kalender.html rad 351) |
| Region / projekt / arbetsledare | ✅ finns, sökbara (rad 235) |
| **Per kund** | ✅ `/admin/planning/activities?company=` filtrerar redan — *"kalendern visar alltid en kund i taget"* |
| Färsk data | 🟡 cron tillagd i `sync_v2_cron.sh`, väntar på första nattliga körningen |

**Alltså krävs ingen ny integration och ingen ny vy — bara att synken körs.**

### 🔴 MEN: TYST BORTFALL SOM AVGÖR VILKA KUNDER SOM FÅR PASS
`syncTengella` (activity_sync.js) itererar över `TengellaCustomer` och hoppade **tyst** över varje kund utan `company` (ClientCompany):
```js
if (!ccId || !customerId) continue;   // utan ClientCompany hamnar passet ingenstans
```
Konsekvens: den kundens pass skapas **aldrig** i Bubble. Kalendern filtrerar på `Clientcompany` → i UI:t ser det ut som **"inga inbokade pass"**, inte som "kopplingen saknas". Samma klass som Intelliplans omappade konton — och omöjligt att upptäcka utifrån.

**Åtgärdat på två ställen:**
1. `syncTengella` returnerar nu `skipped_customers: [{ tengella_customer_id, namn, orsak, bubble_id }]` — i rapportens **grundform**, så den är stabil även vid tidig retur (`scan_error`/`login_error`). Annars måste anroparen gissa om tomt betyder "inga överhoppade" eller "kom aldrig så långt".
2. **`kallhalsa` bär `pass_tackning`**: `kunder_totalt` · `kunder_med_clientcompany` · `kunder_utan_clientcompany` · `exempel_utan[]` (namngivna, så mappningen går att laga) · `betydelse` i klartext. Okopplade kunder gör `allt_ok: false`. Mätfel → *"behandla den som okänd, inte som fullständig"*. Filtreras i JS — Bubbles `is_empty` är opålitlig för ref-fält och kan inte indexeras (123 rader = försumbart).

**Verifierat:** `bokningslage_smoke.mjs` **196/196**. **Mutationstestat:** återinförd totalsumma fäller 2 · återinförd uppräkning fäller 2 · tyst `continue` tillbaka fäller 1 · okopplade kunder utan effekt på `allt_ok` fäller 1. Samtliga 20 sviter gröna.

**Nästa:** deploya → `curl .../admin/bokningslage/kallhalsa` och läs **`pass_tackning`** → koppla ev. okopplade `TengellaCustomer.company` i Bubble → kör `POST /sync/activities/tengella {"mode":"write"}` (eller vänta på nattliga) → passen syns per kund i planeringsvyn med namn.


### ✅ AFFÄRSVYN + KUNDKORTET RÄTTADE (2026-08-20)
Källhälsan bevisade att bytet var säkert: **`FortnoxOrder(TENGELLA)` = 765 rader, rörda samma dag** mot `TengellaWorkorder` = 583 rader frysta 4 juni. Data fanns alltså hela tiden — i rätt tabell.

**Backend `affar_api.js`:**
- `nOrderF` grenar på connection: HK dateras på **`ft_order_date`** (F&E på `ft_delivery_date`), får `source: "tengella"`, och den neutrala statusen **`Workorder`** i stället för en gissad `Levererad` — vi har inget leveransdatum att grunda den på.
- Order-listan gör **två frågor mot samma tabell**: F&E m.fl. med `connection not in [TENGELLA]` på `ft_delivery_date`, HK med `connection equals TENGELLA` på `ft_order_date`. Ett gemensamt datumfönster hade tappat HK helt så fort ett datumfilter var aktivt. **`not in`-exkluderingen är inte kosmetisk** — utan den kommer HK tillbaka i båda frågorna och listas dubbelt.
- `fyllHkRader()` hämtar HK-rader ur **`FortnoxOrderRow`** i EN batchfråga **efter paginering** (tidigare låg de inbäddade i `workorder_rows_json` → ingen N+1; nu är det en egen typ och N+1-risken är verklig).
- Feed, deal-kortet, doc-search och `LINK_MAP.order` uppdaterade. `LINK_MAP` pekade HK-kopplingar på `TengellaWorkorder` — deal-kopplingen skrevs alltså på en rad vyn inte längre läser.
- `_woRows` / `nWorkorder` / `_liveWO` **borttagna**, inte utkommenterade. Död kod som ser levande ut var precis felet.

**⚠️ FÄLLA VID BORTTAGNING UR `Promise.all` — TVÅ STEG, INTE ETT:**
1. Att ta bort en post utan att ta bort motsvarande namn ur destruktureringen **förskjuter alla efterföljande variabler** — tyst. Hände i både feed och deal-kortet. Fångat med ett aritetstest (19 vs 19, 12 vs 12).
2. **🔴 MEN ARITETSTESTET RÄCKTE INTE.** Affärsvyn **kraschade skarpt** med `cWO is not defined`: jag tog bort `cWO` (TengellaWorkorder-räknaren) ur destruktureringen men den användes fortfarande längre ner, i svarets `funnel.order` och `counts_detail.order_tengella`. Aritet säger ingenting om **användningar**. Rättat: HK ingår i `cOrdF`, så en separat räknare hade dessutom dubbelräknat dem.

**⚠️ ORSAKEN TILL ATT DET NÅDDE PRODUKTION: ingen svit anropade `/admin/affar/feed`.** 20 gröna sviter, och den mest trafikerade endpointen i vyn testades inte alls. Åtgärdat med ett **röktest över SAMTLIGA registrerade GET-routes** i `affar_ansvarig_smoke.mjs`: varje route anropas med minimala argument (`:param` → dummy-id) och måste svara utan 5xx och utan `is not defined`. Billigt, brett, och fångar hela klassen "borttagen variabel som fortfarande används". Plus riktade assertioner på feed:ens funnel. **Mutationstestat:** återinförd `cWO` fäller 4 · återinförd `order_tengella`-räknare fäller 1.

**Backend `companies_api.js` (kundkortet):** samma bugg fanns i `nOrdF` — HK saknar `ft_delivery_date` och daterades därför på **Created Date (synkdatum, inte affärsdatum)** och märktes `fortnox`/`Levererad`. Rättat likadant. Kräver `TENGELLA_CONNECTION_ID` i deps (injicerat från index.js).

**Frontend — genomgången källa för källa (inte antagen):**
- `mira-affar-samlad.html` ✅ **oförändrad rendering.** Källfiltret är client-side på `r.source` (rad 794/810) → Tengella-chippet fungerar direkt. `.src.tengella` har redan CSS (rad 41). Backend behöll kontraktet (`r.wo = 1` + `r.rows[{art,name,qty,price,sum}]`), och `r.id` är nu ett FortnoxOrder-id — exakt vad koppla-widgeten ska patcha. Bara kommentaren som pekade ut TengellaWorkorder rättad.
- 🔴 **`mira-foretag-lista.html` (kundkortet) — VERKLIG BUGG, orsakad av backend-ändringen.** Källetiketten var **binär**: `esc(r.source==="fortnox" ? "Fortnox" : "Mira")`. HK-ordrar kommer nu tillbaka med `source: "tengella"` och hade märkts **"Mira"** — fel bolag OCH fel system. Rättat med en uppslagstabell `SRC_ETIKETT = { fortnox, mira, tengella: "Tengella (HK)" }` + fallback. **En binär mappning tål inte en tredje källa** — och den fanns bara på ETT ställe, hittat genom att greppa `==="fortnox"` i samtliga frontends.

**⚠️ KÄLLETIKETTEN ÄR INTE KOSMETIK.** `viewCell` (mira-affar-samlad rad 347) visar "Visa ↗" bara när `r.source === "fortnox"` — knappen hämtar dokumentet ur Fortnox API. HK-ordrar har ingen Fortnox-motsvarighet, och §5 varnar uttryckligen: *"TENGELLA-connectionen får ALDRIG skickas till Fortnox-routerna (404 Kan inte hitta fakturan)"*. Hade jag märkt HK som `"fortnox"` i stället för `"tengella"` hade varje HK-rad fått en knapp som 404:ar. Distinktionen skyddar mot det.

**Verifierat med BETEENDETESTER (inte grep):** `affar_ansvarig_smoke.mjs` **50/50** (från 27) kör riktiga routes mot mock-DB med både en F&E- och en HK-order: HK syns, märks `tengella`, dateras på `ft_order_date` (**inte** Created Date), får `Workorder`-status, bär sina två rader sorterade på radindex, listas **exakt en gång**, och följer både kategori- och datumfiltret. `affar_richcard_smoke.mjs` **29/29** — fixturerna skrevs om från `TengellaWorkorder` till `FortnoxOrder`+`FortnoxOrderRow`.

**Mutationstestat:** HK på `ft_delivery_date` fäller 2 · borttagen HK-fråga fäller 5 · uteblivna HK-rader fäller 4 · borttagen `not in` (dubblett) fäller 2 · gissad leveransstatus fäller 1.
