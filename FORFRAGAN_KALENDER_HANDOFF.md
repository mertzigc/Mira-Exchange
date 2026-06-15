# Handoff – Förfrågan + Kalender (Mira)

**Startad 2026-06-11.** Separat spår från sync-omtaget (se `HANDOFF.md` / `ARKITEKTUR_OCH_OMTAG.md`). Detta rör kund-facing UI: hur kunder skapar en bokningsförfrågan (commission → Lead → offert) och en ny kalender/planeringsmodul.

## Mål
Bygga två moduler i samma mönster som `mira-kommunikation-admin.html`: **all intelligens i HTML-fil i repot + CRUD-proxy i `index.js`, Bubble som databas/lagring.** Design enligt `mira-bokningsoversikt.html` (mörkt #1e2235, orange #F47B30, Arial Black-rubriker).

## Beslut låsta 2026-06-11
1. **Skapa-flödet = EN gemensam wizard.** De två gamla popup-vägarna ("Lägg till ny" / scratch + "Skapa från mall" / erbjudande) slås ihop. Start: *Välj erbjudande* (paketerat, förifyller stegen) ELLER *Bygg fritt* (tomma fält). Båda går genom samma steg och landar i samma slutsteg/commission-objekt. "Scratch" = "erbjudande = inget".
2. **Wizardsteg:** Välj väg → Eventdata → Detaljer → Granska & skicka. Höger: levande sammanställnings/kostnadspanel (priser för erbjudande, ren sammanställning för fritt).
3. **Kalendern:** utbyggnad av `mira-bokningsoversikt.html`. Zoom År → Kvartal → Månad → Vecka → Dag. Lager (egen färg + på/av-toggle): Bokningar (orange), Scheman/Tengella (blå), Ärenden (gul), Todos (grön). Filter: status, kontor, leverantör, kund.
4. **Återanvändbar modul, två lägen:** Kund-läge (låst till en kund) och CRM-läge (Carotte, med kundsök överst som sätter samma filter). En kodbas + `mode`-flagga, inte två.
5. **Datakällor bekräftade redan i Bubble:** Ärende och Todo är egna Bubble-datatyper; Tengella-arbetsscheman synkas redan till Bubble. Allt läses via proxyn — ingen ny live-Tengella-adapter behövs för kalendern.

## Levererat hittills (prototyper, mock-data, ingen Bubble-koppling)
- `mira-forfragan-skapa-prototyp.html` – klickbar wizard (steg 1). Christian gillar flödet som grund; har detaljfeedback som ej är inarbetad än.
- `mira-kalender-prototyp.html` – klickbar kalender (steg 2) med alla 5 zoomnivåer, lager-toggles, filter, kund/CRM-läge.

## Nästa steg
1. Christians detaljfeedback på skapa-flödet → inarbeta.
2. Feedback på kalender-mockupen.
3. När UX är låst: koppla mot Bubble.
   - **Läs:** `GET /admin/offers/list`, `/admin/kontor`, `/admin/leverantorer`, `/admin/medarbetare`, `/admin/planning/events` (boknings/schema/ärende/todo i ett spann, paginerat server-side förbi Bubbles 100-cap, likt `/caspeco/admin/bookings`).
   - **Skriv:** `POST /admin/commission/create` + `PATCH …/update` (utkast vs skicka). Gated av `x-admin-token`, backend håller Bubble-master-nyckeln.
   - Ersätt mock-arrayer (`OFFERS`/`KONTOR`/`LEVERANTORER`/`EVENTS`) med fetch.
4. Verifiera exakta Bubble-fältnamn för Erbjudande/Commission/Ärende/Todo/Schema innan skrivläge (case-sensitivt).

## UPPDATERING 2026-06-15 — Christians detaljfeedback inarbetad, gaps lösta

**Current-user-kontext LÖST:** följ KPI-blocket (`mira-kund-dashboard-kpi.html`, "A-spåret"). Bubble injicerar i HTML-elementet: `#mira_company_id` (value=""), `#mira_api_host`, och JSON som textarea-innehåll (ej value=, citationstecken bryter). Läsning = rendera direkt från injicerad data (privacy rules isolerar). Skrivning/refresh = POST company_id till Render-endpoint som räknar + skriver tillbaka till Bubble, sen reload. Preview-fallback = DEMO_DATA när company_id tomt.

**Tengella timetable FINNS (väg a vald):** hämtas idag i Bubble via API Connector "Tengella – Get TimeTableEvent" + backend-wf `tengella_sync_timetable_for_company` (Login → Get TimeTableEvent → Make changes ClientCompany.Tengella_project_list → Schedule `tengella_upsert_timetable_activity` on list → rekursiv paginering på ExistsMoreData). Rika fält: EventId, EmployeeId/Name, ProjectId/Name, RegionId/Name, SupervisorId/Name, ItemName, StartDateTime, EndDateTime, raw_json. Params: limit, fromDate, toDate, cursor, customerId (company.tengella_customer_id), projectId (company.Tengella_project_list). **Ska portas till Render** bredvid workorder (`listTengellaTimeTableEvents` + upsert + in i `sync_v2_cron.sh`, iterera företag med tengella_customer_id). SAKNAS: exakt Tengella API-path+metod + Bubble-datatypens namn (finns i API Connector-config).

**Kategorier (Kategorier.xlsx, 4 toppkategorier → varsin subset):**
- Food & Event → SubCategoryFE (Frukost, Lunch, Middag, After work, Kundevent, Internt event, Sommarfest, Julfest, Kickoff, Konferens, Fika, FYI)
- Housekeeping → SubCategoryHK (Storstäd, Städ höga höjder, Trapphus, Desinficering, Eventstäd, Extrastäd, Fönster, Golvvård, Mattvätt, Möbeltvätt, Sanering, Övrigt städ, Ångtvätt, FYI)
- Staff (=Service & People) → SubCategorySP (Hyra personal, Rekrytera personal, Executive search, FYI)
- Other facility services → SubCategoryFM (Fastighetsteknik, "Teknisk supprt"=stavfel, Kontorsmaterial, Handyman, Kaffe & baristalösningar, Vattentorn, Blommor & dekor, Frukt på jobbet, Matkylar, FYI)

**Färgmodell (beslutad): tvåaxlig.** Färg = Kategori (FE orange #F47B30, HK blå #4C9AFF, Staff lila #9F77DD, OtherFM grön #4CAF7D), form/ikon = objekttyp (bokning/Tengella-pass/ärende/kom-ihåg).

**Nya datafält (minimalt, mestadels på Comission):**
- Recurrence: `recurrence_rule` (optionset Veckovis/Varannan vecka/Månadsvis/Kvartalsvis/Årsvis), `recurrence_group_id` (text), `recurrence_is_master` (yes/no), `recurrence_until` (date). notify/lead/coworker körs BARA på master → en notis/lead, inte 52.
- Matter: `closed_date` (date) + Bubble DB-trigger som sätter den när status→Avslutat. Kalender-span = created_date → (closed_date ?? idag).

**Övriga beslut från Christian:** Beställare = LISTA → en lead + en coworker-uppdatering per beställare. Capacity = MAX (validera antal ≤ Capacity). Extern lokal begränsar Plats-valet. Internservice = NO alltid. Statusfält: Comission.commission_status, Matter.status, Todo.Status. Tråd = list of texts per typ (append + statusuppdatering i klick-popup). Kopiera-objekt-till-nytt-datum behålls.

## Kvarstående småbeslut
- Tengella TimeTableEvent: exakt API-path/metod + Bubble-datatypnamn (från API Connector).
- Auth för nya moduler: återanvänd CASPECO_ADMIN_TOKEN-mönstret (ny token-env) — lutar åt ja.
- Kalenderdata via Render läs-endpoint `/admin/planning/events?company=…` (ej JSON-injektion; volym för stor).
- Non-service-färg: alla 4 toppkategorier täcker allt (event-typer ligger som SubCategoryFE) → inget extra behov.

## UPPDATERING 2026-06-15 (kväll) — Activity = enhetlig kalendertyp, Tengella-path klar

**Tengella TimeTableEvent path:** `GET https://api.tengella.se/public/v2/TimeTableEvent` (params: limit, fromDate, toDate, cursor, customerId, projectId; Bearer-token från /v2/login). Returnerar Data[] + ExistsMoreData + cursor.

**Datatyp = `Activity`** (INTE en ny smal typ). Activity är Miras ENHETLIGA kalender-/planeringstyp: har MS_*-fält (Outlook-sync, görs redan i Bubble), tengella_*-fält, `Comission` (list), `Ärende` (list of Matters), `Category` (optionset), `color_hex` (text), `ActivityType` (optionset), `plats` (geographic address), `Deltagare` (list User), `Startdatum`/`Slutdatum` (date), `Kommentar` (list of Comment), `Office`, `Supplier` (list), `tengella_employee` (Konsult-Thing). Company-fält = `clientcompany` (bekräftat i index.js CC_FIELD_OVERRIDES). Ingen Activity-skrivning finns i Render idag → Tengella→Activity är greenfield.

**Render-port mappning (upsert key = tengella_event_id):** EventId→tengella_event_id; EmployeeId/Name→tengella_employee_id/_name; ProjectId/Name→tengella_project_id/_name; RegionId/Name→tengella_region_id(**text**)/_name; SupervisorId/Name→tengella_supervisor_id(**text**)/_name; ItemName→tengella_item_name; StartDateTime→Startdatum; EndDateTime→Slutdatum; raw→tengella_raw_json; resolve ClientCompany från tengella_customer_id (TengellaCustomer.company-bryggan)→tengella_company + clientcompany; tengella_last_synced=now. Login+cursor-paginering speglar befintlig Tengella-kod; per företag m. tengella_customer_id, datumfönster, in i sync_v2_cron.sh.

**BESLUT (Christian 2026-06-15):**
- **Kalenderns datalager = ALLT SOM ACTIVITY.** Kalendern läser BARA Activity. Comission/Matter/Todo materialiseras som Activity-rader (ActivityType diskriminerar, länk tillbaka till källobjekt för Tråd/status i klick-popup). → Konsekvens: varje Comission/Matter/Todo måste skapa en Activity (nya via skapa-flödet vid spar; befintliga via backfill).
- **Render stämplar ActivityType + Category(=Housekeeping) + color_hex** på Tengella-rader. Frontend renderar bara.

**KVAR att få av Christian innan bygge:**
1. ActivityType optionset — fullständiga värden (vilket = Tengella/Housekeeping, bokning, ärende, kom-ihåg).
2. color_hex-konvention: finns Category→färg redan? Annars förslag FE #F47B30 / HK #4C9AFF / Staff #9F77DD / OtherFM #4CAF7D.
3. Materialisering: skapas Activity redan automatiskt vid Comission/Matter/Todo (Bubble-wf), eller nytt arbete + backfill?

## UPPDATERING 2026-06-15 (sen kväll) — INGA Bubble-workflows, allt i Render

Christian: A (option sets ActivityType + Recurrence), B (Activity +status +source_id), C/D/E (Comission recurrence-fält + specialkost, Matter closed_date, Todo verifierad) är KLART i Bubble. **F (Bubble backend-workflows) görs INTE** — all materialisering/logik flyttar till Render.

**Materialisering i Render = write-through + modified-sweep** (Render kan ej trigga på Bubble-ändringar):
- Write-through: varje skrivning via Render (skapa förfrågan; popup status/Tråd/kopiera) upsertar/uppdaterar Activity i samma anrop (instant).
- Modified-sweep: nattlig `POST /sync/activities/:source` (source=comission|matter|todo|tengella|all, mode diff|write, diff default) läser källor med Modified Date ≥ senaste körning → upsert Activity. Samma mönster som faktura-synkens modifiedDaysBack. Backfill = sweep med fullt fönster (engång).
- Upsert-nyckel = `source_id` (källans unique id). Render sätter ActivityType/Title/Startdatum/Slutdatum/Category/status/color_hex/clientcompany enl. mappningstabell (color_hex: FE #F47B30, HK #4C9AFF, Staff #9F77DD, OtherFM #4CAF7D, fallback #888888).
- Matter closed_date: sweepen sätter = Matter's Modified Date när status=Avslutat & closed_date tomt → speglas till Activity.Slutdatum.
- Caveat: kräver Comission/Matter/Todo exponerade i Data API + filtrerbar Modified Date. Om datum-constraint opålitlig (jfr fakturornas numeriska ts) → full nattlig resync (liten volym).

**Skapa-förfrågan-kedjan helt i Render** (notify flyttad från Bubble-wf): 1) skapa Comission (Internservice=no) 2) recurrence-serie i Render-loop (master=första) 3) upsert Activity 4) notify = Render mail (emailer.js) + ev Notis, BARA master 5) skapa Lead per beställare (Data API) 6) patcha Coworker.Bokningar per beställare (Data API).

**KVAR att få av Christian innan kodning:**
1. Exakta option set-värden (case-sensitivt): ActivityType + Recurrence.
2. Exakta fältnamn: Comissions "ev slutdatum", Remembers start-/slut-tid.
3. Bekräfta Comission/Matter/Todo exponerade i Bubble Data API.

## BYGGT 2026-06-15 — activity_sync.js (materialiseringskärna)

Ny fil `activity_sync.js` (DI-modul som invoice_sync.js). Inkopplad i index.js: import överst + `createActivityEngine(...)` + route `POST /sync/activities/:source` (requireSyncSecret) bredvid /sync/v2. Båda node --check OK.
- Mappers: Comission→Bokning, Matter→Ärende, Todo→Kom ihåg, Tengella TimeTableEvent→Housekeeping. Sätter ActivityType/Title/Startdatum/Slutdatum/Category/color_hex/status/clientcompany/source_id.
- Upsert-nyckel = Activity.source_id (källans id, eller "tengella:<EventId>"). Diff-läge default (skriver inget), mode:"write" krävs. noop-detektering via COMPARE-fält.
- Matter closed_date sätts i sweepen (status=Avslutat & tomt → Modified Date).
- Tengella: login en gång, paginerar /v2/TimeTableEvent per TengellaCustomer m. tengella_customer_id, fönster default −31d…+92d.
- Write-through-exports: upsertActivityForComission/Matter/Todo (för create-chain + popup senare).
- **⚠️ Config-konstanter att verifiera överst i activity_sync.js (ACTIVITY_CONFIG):** REMEMBER_TYPE (typnamn för Kom ihåg), C_END (Comissions ev-slutdatum, default "delivery_date_end"), M_TITLE (default "Rubrik"), R_*-fälten (Todo). Bekräftade: Comission (commission_title/delivery_date/Category/commission_status/Company/Description), Matter (status/Kundföretag/Beskrivning), Activity.clientcompany.

**Validera (diff-läge skriver INGET; kräver x-api-key + x-sync-secret):**
`POST $HOST/sync/activities/comission {"mode":"diff","modifiedDaysBack":3650}` → scanned/create/update/noop. Likadant matter|todo|tengella|all. Todo rapporterar "skipped" om REMEMBER_TYPE fel. Tengella visar companies/events. Efter grön diff → mode:"write", sen in i sync_v2_cron.sh (ej tillagt än).

## FIX 2026-06-15 (efter första diff-körning som 500:ade)
Första körning: per-rad "bubbleFind failed" (source_id) + topp-500 (Tengella "is not empty"-constraint). Bubble-deploy löste fält-existensen men felet kvarstod → omdesign:
- **Index-baserad upsert:** loadActivityIndex() läser alla Activity en gång → Map(source_id→rad). upsertViaIndex() ersätter per-rad bubbleFindOne (N+1 + det felande source_id-anropet borta). "all" delar ett index.
- Tengella-kundfilter i JS (ej "is not empty"-constraint). Alla scans/källor try/catch:ade → svar alltid {ok:true, report} med scan_error/last_error/fatal för Bubbles riktiga felmeddelande.
- Tog bort `plats` ur mapComission (Activity.plats = geographic address → 400 vid textskrivning; hanteras separat senare).
- node --check OK. Christian pushar activity_sync.js + index.js → Render redeploy → rerun diff.

## DIFF GRÖN 2026-06-15: comission 100, matter 110 (closed_set 103), tengella 119 företag/4937 events. Todo = 404 "Type not found Todo" → REMEMBER_TYPE fel, väntar exakt typnamn + R_*-fältnamn. Lagt till throttleMs (default 120ms write / 0 diff) inför ~5150-raders backfill. Write körs stegvis: comission+matter först (verifiera i Bubble), sen tengella (--max-time 1800).

## STATUS 2026-06-15 (kväll 2) — write live för 3 källor + Todo-rename

**WRITE validerat & kört:**
- comission: create 100 (efter A_COMPANY-fix `clientcompany`→`Clientcompany`).
- matter: materialiserad; update 39/noop 26 efter att Christian la till 4-familjs-`Category` på Matter. Okategoriserade ärenden = grå (#888) tills de kategoriseras (väntat).
- Datumfilter: default `sinceDate` = innevarande år (filtrerar källans egna datum: delivery_date/Created Date/Todo-start), så `modifiedDaysBack` aldrig drar 10 år historik igen. Ny `purge`-källa städar materialiserade rader < sinceDate.
- Tengella full-year diff (fromDate 2026-01-01 → toDate 2026-12-31): **119 företag, 6759 events (5164 create / 1595 noop)**. Write kvar att köra (--max-time 1800, idempotent re-run).

**RENAME:** datatypen "Kom ihåg - Remember" → **`Todo`** (Christian, för enkelhet). Genomfört genomgående i activity_sync.js (TODO_TYPE="Todo", syncTodos, mapTodo, upsertActivityForTodo, TODO_*-fält, källparam `todo`, case `todo`) + handoff + minne. **OBS:** ActivityType-OPTION SET-värdet är fortfarande `"Kom ihåg"` (AT_TODO) — oförändrat i Bubble. Vill Christian ha det till "Todo" → byt option set-värdet + säg till.

**TENGELLA KLAR 2026-06-15:** chunkad write (Q1-Q4, en del i månadschunkar pga curl-timeout vid ~1800s — write är idempotent). Full-year konsistensdiff: create:0, noop:6759. Alla Housekeeping-pass materialiserade, inga dubbletter (index-baserad upsert höll). comission + matter + tengella = KLARA.

**TODO BLOCKERAD på fältnamn:** typen `Todo` hittas nu, men diff gav `Field not found Startdatum for type Todo` → mina gissade TODO_*-fält stämmer inte. Väntar exakta Bubble-fältnamn för Todo: titel, start, slut, Category, Status, ClientCompany-fält. Sen rätta ACTIVITY_CONFIG + todo diff→write.

## Nästa steg
1. Kör tengella write (full-year) + todo diff→write.
2. Render: läs-endpoint för kalendern (`/admin/planning/activities?company=`, spegla caspeco-läsproxyn) + popup-skriv (status/Tråd/kopiera, anropar write-through) + skapa-förfrågan-kedjan (commission+recurrence+notify via emailer+lead+coworker).
3. Lägg /sync/activities i nattliga cron.
4. Bygg om prototyperna: kalendern läser Activity-feed (Category=färg, ActivityType=ikon), klick-popup, recurrence-serie i skapa-flödet.
