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

## BYGGT 2026-06-15 (kväll 3) — kalendern live mot Activity

Alla 4 källor materialiserade (todo-fält fixade: Titel/Starttid/Sluttid/Kategori/Status/Företag; knownCat-guard mot ogiltiga Category-värden).

**Render-endpoints (i index.js, openPaths + PLANNING_ADMIN_TOKEN m. fallback CASPECO_ADMIN_TOKEN):**
- `GET /admin/planning/activities?company=&from=&to=` — läs-proxy, paginerar Activity, default-fönster innevarande år, filtrerar på Clientcompany. company utelämnat = CRM (alla).
- `POST /admin/planning/activity/action` — `load` (källans Tråd+status), `status` (patch källa + Activity-spegel), `comment` (append källans Tråd-lista), `copy` (klona källa m. nytt datum + write-through-materialisera). Källtyp-karta PLANNING_SRC per ActivityType.

**`mira-kalender.html`** (ny produktionsmodul, prototyp kvar som referens): KPI-injektionsmönster (#mira_company_id/#mira_admin_crm/#mira_api_host/#mira_planning_token). Läser feeden, färg=color_hex, ikon=ActivityType, zoom År→Dag, lager-toggles per ActivityType, statusfilter, kund/CRM via admin_crm, klick-popup (Tråd+status+kommentar+kopiera). Demo-fallback utan company_id.

**Att testa:** sätt token i HTML + env, curl /admin/planning/activities, embedda i Bubble. node --check grön.

**Öppet:** CRM-lägets kundsök filtrerar client-side (saknar company-namn → ev. egen /admin/planning/companies senare). Status i popup är fritext (status-optionvärden ej enumererade). Per-kund-isolering = samma trade-off som caspeco (token i HTML).

## ITERATIONER 2026-06-15 (kväll 4) — kalendern i drift, finslipning

- **CRM-läge:** laddar EN kund i taget (aldrig alla). Default = admins eget company. Sökrutan = företagsväljare via nya `GET /admin/planning/companies` (id+namn, cachas klientsidan). `&crm=1` skickas i läs-anropet.
- **Rubrik:** faktura-blockets stil (DM Serif Display, vit + orange #db6923 kundnamn) = "Planering för KUNDNAMN". Bubble injicerar `#mira_company_name` = Name_company. id-guard så rått unique-id aldrig visas; CRM hämtar namn från företagslistan.
- **Legend** (färg=kategori / ikon=typ) ovanför kalendern.
- **Status-dropdowns** per typ: Bokning Ny/Hanterad/Utkast/Levererad (commission_status), Ärende Pågående/Avslutat/Utkast (status), Todo Pågående/Avslutat/Försenad/Planerad (Status). Housekeeping: ingen status/redigering.
- **Todo-fältnamn** (bekräftade): Titel/Starttid/Sluttid/Kategori/Status/Företag/Beskrivning/Tråd. Saknad tid → faller tillbaka till Created Date.
- **Todo-företagslogik:** kund-läge + Carotte Group (id 1726738549743x453535655154064800 hårdkodat i index.js) → filtrera på `creator_company` (Todo-skaparens User.Company, materialiserat via nytt Activity-textfält `creator_company`). CRM mot kund → `Clientcompany` (=Todo.Företag). Läs-endpointen kör två queries (non-todo via Clientcompany + todo via rätt nyckel) och mergar.
- **Todo-popup extra:** Beskrivning (materialiserad), Skapad av (Created By→User-label) + Delegerad till (User-fältet) resolvas i `load`-action via `_planningUserLabel`.
- **Bubble-fält tillagda av Christian:** Activity.`source_id`, `status`, `creator_company` (text).

## BYGGT 2026-06-15 (kväll 5) — förfrågan-wizardens Render-backend (drop 1, dry-run-säker)

Inline-block i `index.js` FÖRE `app.listen` (mönster som `LANDING`/`public/request/create`). Config-objekt `FORFRAGAN` + `FORFRAGAN_KATEGORIER` överst i blocket — **rätta fältnamn DÄR**. Gated av `_ffGuard` (PLANNING_ADMIN_TOKEN, x-admin-token, CORS som planning). Paths i requireApiKey openPaths. node --check OK.

**Endpoints:**
- `GET /admin/forfragan/schema?company=` — **EN curl låser alla fältnamn.** Provar kandidat-typnamn (Erbjudande/Office), dumpar `field_keys`+`sample` för offer/office/clientcompany/comission/lead/coworker. Jämför mot FORFRAGAN-configen, rätta kandidat-arrayerna.
- `GET /admin/forfragan/bootstrap?company=` — leverantör (resolvas från ClientCompany via kandidat-fält), kontor (id/namn/office_address, filtrerat på company i JS), kategorier+underkategorier (hårdkodat Kategorier.xlsx), recurrence_rules.
- `GET /admin/forfragan/offers?company=&q=` — alla Erbjudande, filtrerat i JS på Status=Publicerat + giltighetsfönster (Start/Slut), uppdelat `general` (client_company tom) / `unique` (= company). Full rikedom (Image/Bildspel/Description_long/Capacity/Extern lokal/PrisPerPerson/Produktinnehåll/Produkttillägg/Villkor/Logistik/Målgrupp).
- `GET /admin/forfragan/users?company=&q=` — beställar-sök (getCompanyUsers → id/email/förnamn/efternamn).
- `POST /admin/forfragan/create` — **DRY-RUN DEFAULT** (mode:"write" krävs). Kedja: Comission (Internservice=NO) → recurrence-serie via `_ffRecurrenceDates` (master=första, max 1 år) → `activityEngine.upsertActivityForComission` per rad → notify (EmailQueue/commission_new, BARA master) → Lead per beställare (Source="Mira") → Coworker.Bokningar += master per beställare. Validerar antal ≤ capacity. Allt på `safeCreate` (självläker fältnamn) + title hedgas (`commission_title` OCH `"Commission title"`) + underkategori hedgas (Subcategory/SubCategory-casing). Diff-svar = full plan utan skrivning.
- `POST /admin/forfragan/update` — patchar master-commission (utkast) + Activity write-through, self-heal på Unrecognized field.

**LÖST (Christian 2026-06-15):**
- **Comission title-fältet = `Commission_title`** (stor C, underscore). C_TITLE_KEYS=["Commission_title"], safeCreate hedgar bort fel casing.
- **Notify-mottagare = Users där `associated_company` CONTAINS commissionens Company** (ClientCompany). Listfält, kopplar även Carotte (medvetet). Implementerat via `_ffNotifyUsers()` (ersätter getCompanyUsers i notify-vägen).

**FÄLTNAMN LÅSTA mot /schema 2026-06-15 (Comission + offer/office/cc/lead/coworker dumpat):**
- Comission: `Commission_title`, `delivery_date`, **`Slutdatum`** (ev-slut, EJ delivery_date_end), `Category`, `commission_status`, `Company`, `Description`, `commission_message` (råmeddelande), **`Leverantör`** (sätts från CC.leverantör), `budget`, `Office`, `Beställare`, **`SubCategoryFE/HK/SP/FM`** (stor C). recurrence/Internservice/specialkost saknades i sample (tomma→utelämnade).
- **activity_sync.js C_END rättat `delivery_date_end`→`Slutdatum`** (var latent bugg: commission-Activities fick noll-längd). Kör om sweepen (`/sync/activities/comission` mode:write) för att uppdatera befintliga rader.
- Office (typ `Office`): namn=`Office_title`, adress=`office_address`, company=`Kundföretag`.
- Erbjudande (typ `Erbjudande`): status=`Status`, start/slut=`startdatum`/`slutdatum` (lowercase), client_company=`client_company` (lowercase, tom på allmänna). Rikedom: Title/Image/Bildspel/Description/Description_long/Capacity/Extern lokal/Logistik/Målgrupp/PrisPerPerson/Produktinnehåll/Produkttillägg/Villkor.
- ClientCompany.leverantör=`leverantör` (lowercase ö). Lead: `Name`(ej Title)/`client_company`/`Email`/`Source`. Coworker: `Email` + `Bokningar` (tom→utelämnad, litar på spec).
- Comission saknar dedikerade fält för antal/plats/po/specialkost → vikt in i `Description` (strukturerad), råmeddelande i `commission_message`.

**ÖPPNA PUNKTER (drop 1):**
1. **recurrence-fältnamnen ej verifierbara via /schema** (tomma på sample). Mina gissningar: `recurrence_rule`/`recurrence_group_id`/`recurrence_is_master`/`recurrence_until`. Funktionellt OK även om de droppas (master-logiken sitter i Render-koden i===0, inte i fältet) — men bekräfta för Bubble-sidans gruppering. Christian la till dem → kan ge exakta namn.
2. **commission_new-mallens copy** matchar inte spec-bodyn exakt än — extra_data skickas (title/subcategory/description/delivery_date/bestallare/subject_override) men `tmplCommissionNew` läser `e.commission_title` (lowercase) → hittar ej `Commission_title`-fältet, faller tillbaka på `extra.title` (skickas nu). Aligna mall mot spec-texten = följdjobb.

**Curl-ordning (Christian):** `/schema` först (rätta config) → `/bootstrap` + `/offers` + `/users` (verifiera läs-shapes) → `/create` med `mode:"diff"` (granska plan) → `mode:"write"` på en testförfrågan.

**BYGGT drop 2 — `mira-forfragan-skapa.html` (produktionsmodul):** KPI-injektionsmönster (#mira_company_id/#mira_company_name/#mira_api_host/#mira_planning_token). Carotte mörkt tema + DM Serif-rubrik (vit + orange #db6923 kundnamn). 4-stegs wizard (Välj väg→Eventdata→Detaljer→Granska) + levande kostnadspanel höger. Erbjudande-väg: två flikar (För er/Allmänna) från offers-endpointen, full rikedom, Capacity-validering (antal≤capacity blockerar Nästa+submit), Extern lokal → plats blir select av lokalerna. Fritt-väg: kontor-select (fyller office_address i plats), kategori→conditional underkategori (FYI filtreras bort), budget-slider, Upprepa (recurrence + "till"-datum). Specialkost = allergen-chips med antal (lånat från invite.html, ALLERGENS-lista) när effektiv kategori=Food & Event → skickas som [{name,count}]. Beställare = multiselect via /users-sök (chips, en lead+coworker per st). Submit→POST /create mode:write (Skicka=sent/Utkast=draft). DEMO-fallback utan company_id. JS-syntax verifierad (node --check på extraherat script).

**Att testa wizarden:** sätt #mira_planning_token i HTML + embedda i Bubble (kund med company_id). Eller curl:a /create direkt (se nedan). Verifiera mot riktig kund: erbjudanden laddar i rätt flik, kontor fyller adress, specialkost-chips, beställar-sök, recurrence-serie i granska, submit skapar commission+serie+lead+coworker+notify.

## ITERATION 2026-06-16 — efter Christians första livetest (CMIAB)

Screenshots av Comission-editorn avslöjade riktiga fältnamn + buggar. Fixat:
- **Mappat till egna fält** (låg i Description): `Location` (adress), `Guest` (antal), `Po_number`, `Allergens_json` (specialkost-JSON). Description = nu bara kundens råtext.
- **Underkategori inkonsekvent stavning** (screenshot): FE=`SubkategoriFE` (svenska!), HK=`SubCategoryHK`, SP=`SubCategorySP`, FM=`SubcategoryFM`. Mina engelska namn var fel → droppades. Nu rätta (hedgas för första-char).
- **Beställare = lista av Coworker** (ej User). `/users` söker nu Coworker (Kundföretag=company), returnerar coworker-id. Wizarden lagrar coworker_id → Beställare + coworker-kedjan får rätt id. Det fixar "sök beställare funkar ej" + 0 leads (kom av tomt beställare-fält).
- **Bekräftade fält → `exact`** (inget safeCreate-hedge-brus i loggen). recurrence lowercase = bekräftat (Recurrence_* avvisas, recurrence_* landar — felen i loggen var självläkning, ej fel). Bara underkategori + produkttillägg hedgas kvar.
- **Tidszon +2h**: wizarden skickar nu ISO beräknad i webbläsaren (`localIso()`, svensk tid/sommartid) ist. för naiv sträng → UTC-server.
- **Dubbel-submit**: `setBusy()` låser Skicka/Utkast-knapparna under anropet.

**DATA-SIDAN att verifiera (Christian, inte kod):**
- Lead: typen saknar ev. Category/Delivery_date/Comission (tomma i /schema-sample) → kolla efter omtest att leaden länkas rätt (annars Comission.LeadID_lime?).
- Internservice visades tomt i editorn — skickas nu som `false` i exact; verifiera att den landar som "nej".

## ✅ ALLA FÄLTNAMN LÅSTA av Christian 2026-06-16 — KANONISK TABELL (gissa aldrig om)
All hedging/kandidat-arrayer borttagna ur koden (FORFRAGAN-config = en sträng per fält). Bubble-editorn versaliserar första bokstaven visuellt → casing nedan är API-sanningen (Data API/reject-logg).

**Comission:** `Commission_title` · `delivery_date` · `Slutdatum` (ev-slut) · `Category` · `commission_status` (Ny/Utkast) · `source` (optionset **lead_source**, värde "Mira") · `Company` · `Description` · `commission_message` · `Leverantör` (list) · `budget` · `Office` · `location` · `guest` · `po_number` · `allergens_json` · `internservice` (yes/no→false) · `Beställare` (list of Coworker) · `Produkttillägg` (list of Products) · `recurrence_rule`/`recurrence_group_id`/`recurrence_is_master`/`recurrence_until`
**Underkategori (Comission):** FE=`SubkategoriFE` · HK=`SubCategoryHK` · SP=`SubCategorySP` · FM=`SubcategoryFM`. Värden = exakt Bubbles dropdown-optionset (FM har stavfelet `Teknisk supprt`).
**Office:** typ `Office` · namn `Office_title` · adress `office_address` (geografisk objekt) · företag `Kundföretag`
**Erbjudande:** typ `Erbjudande` · `Status` (optionset Status erbjudande: Utkast/Publicerat/Utgånget) · `startdatum`/`slutdatum` · företag `Kundföretag` (**list** — tom=allmän, innehåller company=unik)
**ClientCompany:** `leverantör` (list) · `Name_company` · Coworker→`Kundföretag`
**Lead:** `Source` (="Mira") · `Name` · `titel` (lowercase) · `Description` · `Category` · `client_company` · `Comission` · `Email`
**Leverantör:** typ `Leverantör - Supplier` · namn `Företagsnamn`. Comission.Leverantör = [id per kategori]: Food & Event `1731411052569x831010598495453200` · Staff `1732782758356x272951352004444160` · Housekeeping `1732782847141x739655205427609600` · Other facility services `1746511649924x692607212964806700`
**Coworker:** typ `Coworker` · `Email` · `Förnamn`/`Efternamn` · `Bokningar` (list of Comissions) · `Kundföretag`
**User (notify):** typ `User` · `Associated_company` (list) · `email` (inbyggt)
**EmailQueue:** typ `emailqueue` · `template_id`/`entity_id`/`entity_type`/`to_email`/`to_name`/`email_sent`/`extra_data` (alla lowercase)

**Christians regel (minne: [[feedback-communication-style]]): gissa ALDRIG fältnamn — fråga, hedga inte i koden.**

## ITERATION 3 2026-06-16 — Comission-fältens EXAKTA casing (från reject-loggen)
Bubble-editorn versaliserar första bokstaven visuellt → API-sanningen syns bara i reject-loggen. Bekräftat:
- **Capital (landade):** `Commission_title`, `Category`, `Company`, `Office`, `Description`, `Leverantör` (list), `Beställare` (list), `SubkategoriFE`.
- **lowercase (Capital avvisades):** `internservice`, `location`, `guest`, `po_number`, `allergens_json`, `source`, `budget`, `delivery_date`, `commission_status`, `commission_message`, `recurrence_*`.
- **Comission.source** sätts nu = `"Mira"` (optionset Lead_source) — default var "Internservice".
- **location** = text (lowercase) — INTE geografisk. MEN **Office.office_address ÄR geografisk** (objekt) → bootstrap extraherar `.address`-strängen (gav "[object Object]" innan).
- **Lead-typen** har bara `Source`/`Name`/`client_company`(lowercase)/`Comission`/`Email` → Lead görs minimal (saknar Category/Delivery_date/Description/Title; nås via Comission-länken). Lead + coworker-patch BEKRÄFTAT funkar (1 lead, 1 coworker i testet).
- Subcat: FE=`SubkategoriFE` bekräftat (Capital S). HK/SP/FM gissad Capital S — rättas när de testas.
- Tidszon-fix BEKRÄFTAD: 12:00 lokal → 10:00Z (sommartid +2) korrekt.
- Kvar: notify 0 mail → kolla `notify_debug`/`notify_recipients` i create-svaret (JSON, ej Render-logg). Verifiera att test-User har `associated_company` som innehåller företaget.

## ITERATION 2 2026-06-16 — efter andra livetest-screenshots
- **Leverantör är en LISTA** (CMIAB har Carotte Food&Event/Staff/Housekeeping). `_ffIdOf` på array gav null → landade aldrig. Ny `_ffIdsOf()` → bootstrap returnerar `supplier_ids[]`, Comission.Leverantör sätts som lista. (Ev. framtida förfining: filtrera leverantör på kategori, idag sätts hela listan.)
- **Notify**: EmailTemplate `commission_new` finns + funkar (bekräftat). 0 mail kom alltså av att `associated_company contains`-queryn hittade 0 users. `_ffNotifyUsers` testar nu både `User`/`user`-casing + create-svaret returnerar `notify_recipients`/`notify_debug`/`notify_template_id` så nästa test visar exakt vilka som matchar. (Verifiera: har test-usern `associated_company` som innehåller CMIAB?)
- Office_address saknades på testkontoret (data, ej kod) → omtest.
- Google Places: avvaktar (Christians beslut).

**EJ GJORT (kräver beslut/nyckel):**
- **Google Places autocomplete** på adressfältet — kräver Maps JS API-nyckel + script. Adressen förifylls från kontoret idag. Säg till om du vill ha det + ge nyckel.
- Kontor-autofyll: koden sätter plats=office.address vid val; verifiera att CMIAB-kontorets `office_address` är ifyllt (annars inget att fylla).

**KVAR/följdjobb:**
- **Produkttillägg**: offers-endpointen returnerar råa product-ids (inga namn/priser) → wizarden renderar dem inte som valbara än. Behöver ev. /admin/forfragan/products-resolve (id→namn/pris) för tillvals-UI + korrekt kostnadspanel. Idag: kostnad = PrisPerPerson × antal.
- **commission_new-mallens copy** aligna mot spec-body (emailer.js tmplCommissionNew, läser e.commission_title lowercase → faller på extra.title som nu skickas).
- recurrence-fältnamnen (Bubble-gruppering) bekräfta.
- Lägg /sync/activities i nattliga cron (separat spår).

## Nästa steg
1. Testa kalendern (deploy + curl + Bubble-embed).
2. **Bygg förfrågan-wizarden** (HTML 2) + endpoints: offers/kontor/leverantör/underkategori-läsning, spar-kedja (commission+recurrence-serie+Activity-write-through+notify via emailer+lead per beställare+coworker per beställare), specialkost.
3. Lägg /sync/activities i nattliga cron.
4. (tidigare) Kör tengella write (full-year) + todo diff→write. KLART.
2. Render: läs-endpoint för kalendern (`/admin/planning/activities?company=`, spegla caspeco-läsproxyn) + popup-skriv (status/Tråd/kopiera, anropar write-through) + skapa-förfrågan-kedjan (commission+recurrence+notify via emailer+lead+coworker).
3. Lägg /sync/activities i nattliga cron.
4. Bygg om prototyperna: kalendern läser Activity-feed (Category=färg, ActivityType=ikon), klick-popup, recurrence-serie i skapa-flödet.
