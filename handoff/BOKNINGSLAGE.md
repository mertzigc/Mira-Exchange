# Bokningsläget — tre affärsområden bredvid varandra

> Ställer S&P, Housekeeping och Food & Event bredvid varandra. **Talen är INTE
> samma sort** — S&P = intjänat för utfört arbete, HK/F&E = ordervärde.
>
> 🔻 **BESLUT 2026-08-20: ingen totalsumma, ingen uppräkning.** F&E saknar ~30 %
> till Caspeco-migreringen (Q1-27). Historik bakåt tas ur bokföringen i Fortnox.
>
> Kod: `bokningslage.js` · endpoints `/admin/bokningslage/{summary,fe-overlap,kallhalsa}`
> Minne: `project-bokningslage-tackning` · `reference-fortnox-moms-bas`

---
### BOKNINGSLÄGE — samlat orderläge över de tre affärsområdena (påbörjat 2026-08-19)
**⚠️ Intelliplan är BARA Service & People.** Att behandla dess intäkt som koncernens är fel — Christians rättelse. De tre affärsområdena finns alla i Bubble men i olika former:

| Affärsområde | Källa |
|---|---|
| Service & People | `IntelliplanOrderMonth` (nytt) |
| Housekeeping | `FortnoxOrder` där `connection_id` = TENGELLA `1771579481117x119544302020443410` (via §9d workorder-synken) |
| Food & Event | `FortnoxOrder` där `connection_id` = FE `1771579463578x385222043661358460` **+** `MiraOrder` (Miras egen offertväg) |

**Vald inriktning:** *bokningsläge just nu per affärsområde*, jämfört mot **samma dag i tidigare månader** — inte mot deras slutsummor.

**⚠️ TRE SAKER SOM AVGÖR OM VYN BLIR SANN:**
1. **Talen är inte samma sort.** Intelliplan = intjänat för arbete utfört i månaden. FortnoxOrder = helt ordervärde daterat på leverans. Summera aldrig utan att säga vad summan betyder.
2. **Innevarande månad är ofullständig i Intelliplan** (juli mitt i månaden: 1 024 rader mot junis 2 315). Bokningsläget växer under månaden → jämför mot samma dag bakåt, annars ser varje pågående månad ut som ett ras. Dagsupplösning finns för S&P via 1081 och via orderdatum för de andra.
3. **Dubbelräkningsrisk i F&E** — en Mira-offert kan bli `MiraOrder` och samma affär senare en `FortnoxOrder`.

**`bokningslage.js` (NY) + `GET /admin/bokningslage/fe-overlap?from=&to=`** mäter punkt 3 i stället för att anta den. Fortnox sätter egna dokumentnummer, så tre strategier provas i fallande säkerhet: `exact_no` (ordernr === ft_document_number, normaliserat) → `company_date_total` → `company_total` (inom 31 dagar). Redovisar antal per strategi, `overlap_value` (beloppet som skulle dubbelräknas), omatchade på båda sidor, exempel att stickprova, och ett **verdict** som säger om dedupen är tillförlitlig eller en gissning. En FortnoxOrder konsumeras bara EN gång; makulerade räknas bort. `MiraOrder` periodiseras på **leveransdatum**, inte orderdatum — en order lagd i maj för ett event i juni hör till juni. Läser bara.

**⚠️ FYRA FEL I FÖRSTA SKARPA KÖRNINGEN (rättade 2026-08-19, EJ deployade).** Endpointen svarade `mira_count: 0, fortnox_count: 0` och verdicten påstod ändå *"källorna verkar beskriva olika ordrar, båda kan summeras"* — en slutsats dragen ur ingenting.
1. **`.catch(() => [])` på båda Bubble-frågorna.** En failande fråga blev tom lista → tolkades som resultat. Borttaget: frågan får braka.
2. **Fel fältnamn: `connection_id` → `connection`.** `index.js` skriver `connection: connection_id` på FortnoxOrder (rad 2164/2400/8357). Fel constraint-nyckel ⇒ Bubble avvisar HELA frågan. **Detta var orsaken till nollan.**
3. **MiraOrder hämtades bara på `leveransdatum`**, men fältet är valfritt (`offert.leveransdatum || null`, offert_api.js rad 315). Ordrar utan leveransdatum var osynliga trots att `normMiraOrder` faller tillbaka på `orderdatum`. Nu: två frågor (leveransdatum + orderdatum), union deduppad på id, och svaret bär `mira_by_leveransdatum` / `mira_by_orderdatum`.
4. **Verdict drog slutsats ur tom data.** Nu tre lägen: `INGET ATT JÄMFÖRA` (0 på båda) · `BARA EN KÄLLA HAR DATA` · riktig slutsats. Makulerade redovisas separat i råantalet — annars ser "alla makulerade" ut som "inga ordrar".

**⚠️ LÄRDOM: mitt eget test bekräftade buggen.** Assertionen kontrollerade att koden constraintade på `connection_id` — samma gissning som koden. Testet var GRÖNT medan endpointen gav noll rader skarpt. **Ett grep-test är aldrig bättre än faktumet man kodar in.** Fältnamn ska verifieras mot hur kodbasen SKRIVER raden, inte mot vad man tror. Se [[reference-bubble-tysta-faltdrop]].

**Verifierat:** `bokningslage_smoke.mjs` **47/47** (från 31), mutationstestat: `connection_id` tillbaka fäller 4 · borttagen orderdatum-väg 2 · slutsats ur tom data 10 · återinförd `.catch` 1 · flerfaldig konsumtion av samma Fortnox-order 1 · makulerade medräknade 1 · periodisering på orderdatum 6. Samtliga 20 sviter gröna.

**Nästa:** deploya (`index.js` + `bokningslage.js` + `bokningslage_smoke.mjs` — OINCHECKADE) → kör `/admin/bokningslage/fe-overlap` för några månader → avgör F&E-räkningen → bygg själva bokningslägesvyn.

**✅ DEPLOYAT + KÖRT 2026-08-20.** Första svaret efter "deployen" var fortfarande gammal kod — `verdict` saknade `INGET ATT JÄMFÖRA`-grenen och svaret saknade `mira_by_leveransdatum`. Slutsatsen "0/0 är ett datafaktum" hade alltså dragits ur kod som aldrig kördes. **Lärdom: `/version` var en handskriven sträng (`2026-08-12-lead-value-col`) och kunde inte avslöja det.** Nu läser den `RENDER_GIT_COMMIT` → `{commit, commit_short, branch, booted_at}`. **Verifiera ALLTID `/version` innan ett skarpt svar tolkas.**

**Skarpt utfall juni 2026 (rätt kod):** `FortnoxOrder(FE)` **540 icke-makulerade av 608** (68 makulerade), **8 096 472 kr**. `MiraOrder` **0** — på BÅDA datumvägarna. Verdict: `BARA EN KÄLLA HAR DATA`.

**⚠️ MEN 0 MiraOrder ÄR ÄNNU INTE AVGJORT.** Det kan betyda tre olika saker, och skillnaden avgör om F&E får summeras ur två källor: (a) typen är tom överhuvudtaget · (b) typen har rader men datumfältet/formatet är fel → **bugg** · (c) rader finns men inga i juni → **datafaktum**. Endpointen svarar nu själv på det: `describeEmptySide` (bokningslage.js) + probning i rutten kör BARA när en sida är tom, mäter typens total och träffar per datumfält i ett ±3-årsfönster, och svarar `tom_sida_diagnos: [{status, text}]` med status `typen_tom` · `datumfält_misstänkt` · `period_tom` · `okänt`.

**⚠️ `bubbleCount` duger INTE som mätinstrument här** — den returnerar `0` på varje fel (`if (!r.ok) continue` → `return 0`). Att diagnostisera en nolla med ett instrument som självt hittar på nollor är cirkulärt. Ny **`bubbleCountStrict`** (index.js, bredvid `bubbleCount`) kastar i stället, och vägrar gissa `0` när Bubble inte skickar `remaining`. Probefel → `null` = **omätt**, aldrig `0`, och loggas.

**Verifierat:** `bokningslage_smoke.mjs` **70/70** (från 47). **Mutationstestat:** `bubbleCountStrict` som returnerar 0 fäller 2 · `null` behandlat som mätt fäller 3 · endpointen som mäter med `bubbleCount` fäller 2 · borttagen `datumfält_misstänkt`-gren fäller 2. Samtliga 20 sviter gröna.

**✅ F&E-FRÅGAN AVGJORD 2026-08-20 (Christian, Bubble App data):** `MiraOrder` har **1 rad totalt — en testorder**. Mira-native offert/orderflödet är **inte i drift**. Alltså: **F&E = FortnoxOrder(FE) ensamt idag, inget överlapp att deduppa.**

**⚠️ MEN DET ÄR ETT SVAR MED UTGÅNGSDATUM.** Den dagen mira-native tas i drift blir dubbelräkningsrisken verklig utan att någon rör koden. Vyn får därför **inte** hårdkoda "F&E = bara Fortnox" — överlappskontrollen ska köras per period och flagga när `MiraOrder` slutar vara trivial. `describeEmptySide` säger det numera själv: vid `typeTotal <= 5` bär `period_tom`-texten *"⚠️ N rader TOTALT betyder att typen knappt är i drift — behandla nollan som 'ännu inte i bruk', inte som 'affärsområdet omsatte inget'."*

### ⚠️⚠️ MOMSFÄLLAN — `ft_total` är INKL moms (upptäckt 2026-08-20, innan vyn byggdes)
Att ställa junis **8 096 472 kr** (F&E) bredvid Intelliplans **6 850 058,36 kr** (S&P) hade överdrivit F&E med momssatsen. Bevis, inte gissning:
- `ft_total` = Fortnox `Total` = Net + TotalVAT → **inkl moms** (index.js 8393).
- `ft_net` = `order.Net` → **exkl moms**. Kodbasens egen avstämning mot bokföringen summerar `ft_net`: `/kpi/sales/reconcile` → *"net_sum_active: summa ft_net"*.
- `MiraOrder.total` = `summa + moms_belopp` → **inkl moms** (affar_api.js `recomputeOrderTotals`). Därför är total↔total rätt par för MATCHNINGEN — den ska inte byta bas.
- Intelliplans intäkt är exkl moms. **⚠️ Bekräfta med Christian innan vyn publiceras.**

**⚠️ `ft_net` skrivs BARA vid detail-fetch** — *"List-svar saknar dessa"* (index.js 8576). Rader som bara list-synkats saknar fältet. `normFortnoxOrder` ger dem därför `net: null`, **inte 0** — ett saknat värde som blir en nolla drar ner summan tyst. `feOverlap` returnerar nu `moms_bas: { fortnox_total_inkl_moms, fortnox_net_exkl_moms, fortnox_utan_net, fortnox_utan_net_varde_inkl_moms, note }`, där `note` säger rakt ut om net-summan är OFULLSTÄNDIG. **Presentera aldrig en ofullständig net-summa som en total.**

**Verifierat:** `bokningslage_smoke.mjs` **83/83**. **Mutationstestat (moms + drift):** `ft_net || 0` fäller 3 · net-summa ur `ft_total` fäller 3 · tyst OFULLSTÄNDIG-flagga fäller 1 · borttagen "knappt i drift"-varning fäller 2.

**✅ SKARPT UTFALL JUNI 2026 (verifierat 2026-08-20, ny kod):**
- `fortnox_utan_net: 0` → **`ft_net` finns på samtliga 540 F&E-ordrar**, net-summan är fullständig.
- F&E juni: **7 158 290,45 kr exkl moms** (8 096 472 inkl). Implicit momssats **13,1 %** — konsekvent med F&E:s mix av 12 % (livsmedel) och 25 %.
- `tom_sida_diagnos` gav `period_tom` + "knappt i drift"-varningen, precis som avsett.
- **Christian bekräftar: Intelliplans intäkt är EXKL moms.** Baserna är alltså jämförbara efter bytet till `ft_net`.

**⚠️ RÄTTAT: "1 rad totalt och 2 träffar"** — `wideTotal` summerar över FÄLT, inte rader, så en order med både leveransdatum och orderdatum räknades två gånger och lästes som två rader. Träffarna redovisas nu per fält (`leveransdatum: 1, orderdatum: 1`) med utskriven brasklapp.

### BOKNINGSLÄGESVYN — datalagret (byggt 2026-08-20, EJ deployat)
**`bokningslageSummary()` (bokningslage.js) + `GET /admin/bokningslage/summary?from=&to=`.** Ställer de tre affärsområdena bredvid varandra. Läser bara.

**⚠️ VARJE POST BÄR SIN EGEN `matt`-ETIKETT** — det är hela poängen, inte dekoration:
| Område | Källa | Mått |
|---|---|---|
| Service & People | `IntelliplanOrderMonth.revenue` | **Intjänat** för arbete utfört i perioden |
| Housekeeping | `FortnoxOrder(TENGELLA).ft_net` | **Ordervärde**, hela ordern på leveransdatum |
| Food & Event | `FortnoxOrder(FE).ft_net` | **Ordervärde**, hela ordern på leveransdatum |

En Fortnox-order på 500 kkr med leverans 3 juni ligger med fullt värde i juni så fort den lagts — även om den lades i mars. Intelliplans junisiffra fylls på under och efter juni. `summa` finns men är märkt **"BLANDADE MÅTT — … en storleksordning, inte en koncernintäkt"**.

**Fyra saker den vägrar dölja:**
1. **Pågående period** (`to >= idag`) → varning om att S&P växer i efterhand + "jämför mot SAMMA DAG bakåt". `summa.fullstandig` blir aldrig `true`.
2. **Saknat `ft_net`** → beloppet flaggas `ofullstandig` med gapets storlek i kr; blir aldrig en tyst för låg summa.
3. **MiraOrder > 0 i perioden** → varning om dubbelräkning + hänvisning till `/fe-overlap`. Utlöses automatiskt den dagen mira-native går i drift.
4. **Delspann mot månadskornighet** — `ip_period` är HELA månader. Ett spann som inte är hela månader gör S&P-talet för stort; då sätts `sp_tacker_perioden: false` och S&P märks `ofullstandig`.

**Verifierat:** `bokningslage_smoke.mjs` **115/115** (från 83). **Mutationstestat:** summering på `ft_total` fäller 2 · S&P märkt som ordervärde fäller 2 · summan kallad "Total omsättning" fäller 1 · borttagen pågående-varning fäller 2 · borttagen MiraOrder-varning fäller 2 · `connection_id` tillbaka fäller 1. Samtliga 20 sviter gröna.

**✅ VYNS FRÅGA FASTSTÄLLD (Christian, 2026-08-20):** *"Vad är innevarande månads totala leveranser värda i intäkt ex moms, per bolag?"* Alltså **hela månadens leveransvärde**, inte "bokat per dag X jämfört bakåt" — det senare spåret (som hade krävt `ft_order_date`-filtrering) är därmed **inte** aktuellt. `summary` defaultar nu till **innevarande månad** när `from`/`to` utelämnas.

### ⚠️⚠️ KÄND TÄCKNINGSLUCKA — F&E saknar ca 30 % (Christian, 2026-08-20)
Samtliga enheter på Food & Event har ännu inte gått över till **Caspeco**. Tills migreringen är klar saknas **ca 30 % av bolagets intäkter** i våra källor. **Migreringen startar Q1 2027.**

**Det här är den farligaste sortens fel: talet SER komplett ut.** Inget failar, ingen rad är tom, ingen varning utlöses av sig själv — F&E är bara systematiskt ~30 % för lågt. Den som jämför F&E mot S&P drar fel slutsats om vilket bolag som går bäst.

Hanteras i `TACKNING`-konstanten (bokningslage.js):
- `omraden[].tackning` = `0.70` för F&E, `1` för de andra.
- **`belopp` är ALLTID det UPPMÄTTA.** Uppräkningen ligger i ett eget fält, `uppskattad_full_belopp`, med `uppskattad: true`. En linjär uppräkning ur ett antagande är inte en mätning — blanda dem aldrig.
- Varning med både uppmätt och uppräknat belopp, uttalat *"ANTAGANDE, inte en mätning"*, plus `tackning_ses_over: "2027-Q1"`.
- `summa.fullstandig` kan **aldrig** bli `true` medan luckan finns, och `summa.matt` bär *"⚠️ Dessutom för LÅGT"*.

**🔁 TA BORT när migreringen är klar.** Sätt `tackning: 1` och radera noten — en kvarglömd uppräkning som lever vidare efter Q1-27 blir ett tyst 43 %-fel åt andra hållet.

**⚠️ ETT TEST FICK RÄTTAS, INTE BARA UTÖKAS:** `"avslutad period med full täckning får vara fullständig"` kodade in antagandet att en avslutad period ÄR fullständig. Det föll när täckningsluckan blev känd — så länge något bolag har `tackning < 1` får ingen period kallas fullständig. Testet påstår nu motsatsen och verifierar att orsaken är täckningen, inte perioden.

**Verifierat:** `bokningslage_smoke.mjs` **133/133** (från 115). **Mutationstestat:** uppräkning inskriven i `belopp` fäller 4 · tystad täckningsvarning fäller 3 · täckning utan effekt på `fullstandig` fäller 2 · påhittad lucka på HK fäller 1 · borttagen månadsdefault fäller 1. Samtliga 20 sviter gröna.

### ⚠️ TRE FEL I FÖRSTA SKARPA SUMMARY-KÖRNINGEN (rättade 2026-08-20)
Aug 2026 gav S&P 5 833 564,90 (177 rader) · **HK 0 kr / 0 rader** · F&E 3 035 401,33 (297 av 304).

**1. HK frågade FEL TABELL.** Jag kodade HANDOFF-tabellens `FortnoxOrder(connection=TENGELLA)` — men den kanoniska HK-källan är **`TengellaWorkorder`**. `affar_api.js` säger det rakt ut: *"HK/Tengella-order = raw TengellaWorkorder (kanonisk källa, Fas 1 2026-08-07). FortnoxOrder med connection=TENGELLA exkluderas i display … för att undvika dubbel mot ev. sync_v2-spegel."* **Nollan var korrekt — frågan var ställd till fel tabell.** Rättat: `bubbleFindAll("TengellaWorkorder", dateWin("order_date"))`. `order_date` är bevisat constraint-fält (affar_api.js `dateC("order_date")` i live-affärslistan).

**⚠️ HK ÄR ETT TREDJE MÅTT.** `TengellaWorkorder` har **inget leveransdatum** — enda datumet är `order_date` (verifierat mot `upsertWorkorderToBubble`: fälten är workorder_id/workorder_no/order_date/is_deleted/workorder_rows_json, och raderna bär bara item/quantity/price, inga datum). HK svarar alltså på *"workordrar DATERADE i månaden"*, inte *"levererat i månaden"*. Etiketten säger det: *"…på ORDERDATUM i perioden (Tengella saknar leveransdatum — INTE samma sak som levererat i perioden)"*. Belopp = Σ `Quantity × Price` ur `workorder_rows_json`, exkl moms; `is_deleted` räknas bort. **En workorder utan rader blir 0 kr utan att något failar** → flaggas som `ofullstandig` med egen varning.

**2. `summary` SAKNADE tom-sida-diagnosen** som `fe-overlap` hade. HK svarade `belopp: 0, ofullstandig: false` — en tyst nolla presenterad som ett faktum. Nu körs `describeEmptySide` + `bubbleCountStrict`-probning för varje område med 0 rader, området sätts `ofullstandig: true` och `summa.fullstandig` nollas.

**3. MiraOrder-varningen ÖVERDREV.** Vid 1 rad (testordern, leveransdatum i augusti) påstod den *"Mira-native flödet är i drift"* — falskt. Nu: `≤ 5` rader → *"Så få tyder på TESTDATA, inte att flödet tagits i drift"*; fler → drift-formuleringen. Varnar fortfarande alltid.

**⚠️ ETT TEST TOGS BORT, INTE UTÖKAT:** `"HK constraintas på TENGELLA_CONNECTION_ID"` bevakade FEL källa — det hade skyddat buggen. Och `"tomma områden diagnostiseras"` greppade bara `describeEmptySide(`, vilket **inte föll** när urvalet dödades (`tomma = []` gav grönt). Assertionen träffar nu själva urvalet (`result.omraden.filter((o) => o.antal === 0)`) och per-område-anropet. **Tredje gången denna session som ett grep-test visat sig vaktlöst — greppa alltid det som FAKTISKT styr beteendet, inte en symbol i närheten.**

**Verifierat:** `bokningslage_smoke.mjs` **151/151** (från 133). **Mutationstestat:** HK tillbaka på FortnoxOrder fäller 3 · HK märkt med leveransdatum fäller 3 · oflaggad radlös workorder fäller 2 · borttagna workordrar medräknade fäller 3 · drift-formulering vid 1 rad fäller 1 · `tomma = []` fäller 1 · diagnos utan per-område-anrop fäller 1. Samtliga 20 sviter gröna.


### 🔻 BESLUT 2026-08-20 (Christian): INGET FIKTIVT TOTALT ORDERVÄRDE
F&E blir inte komplett förrän Caspeco är fullt implementerat **Q1-27**. Därför:
- **`uppskattad_full_belopp` BORTTAGET.** Vi vet att F&E-talet är för lågt — vi vet inte hur mycket. En uppräkning `uppmätt / 0,70` ser ut som ett facit.
- **`summa` BORTTAGEN** (`summa: null` + `summa_saknas_varfor`). S&P mäter *intjänat*, HK och F&E mäter *ordervärde* — ett hopslaget tal var meningslöst även med etiketten "BLANDADE MÅTT". **En etikett gör inte ett meningslöst tal meningsfullt.**
- `tackning: 0.70` + noten är **kvar** — läsaren ska veta att talet är för lågt.
- `summa.fullstandig` → **`underlag_fullstandigt`** (per-område-beloppen finns kvar och är uppmätta).
- **Historik bakåt tas ur bokföringen i Fortnox** — behöver inte visas i Mira.


### KÄLLHÄLSA — `GET /admin/bokningslage/kallhalsa` (NY)
Elva veckors tyst dataförlust berodde på att **en pensionerad typ och en död synk ser identiska ut utifrån**. Endpointen gör skillnaden mätbar: varje källa **deklarerar** `status: "aktiv" | "pensionerad"` plus vad som matar den, och mäts likadant (antal + max `Created Date` + max `Modified Date` + `kallaFarskhet`).

- En **pensionerad** källa som är gammal → `OK (pensionerad)`. Att larma på den vore brus som får riktiga larm att ignoreras.
- En **pensionerad** källa som plötsligt får nya rader → `⚠️ OVÄNTAT: någon skriver till den.`
- En **aktiv** källa som inte är färsk → `🔴` + färskhetstexten.

Källor som mäts: `FortnoxOrder(F&E)` · `FortnoxOrder(TENGELLA/HK)` · `TengellaWorkorder` (pensionerad) · `TengellaCustomer` · **`Activity` med `ActivityType=Housekeeping` (Tengella-passen, mäts även på `tengella_last_synced`)** · `IntelliplanOrderMonth` · `MiraOrder`. Alla frågor `limit 1` + constraintade — inga svep. `bubbleCountStrict`, aldrig `bubbleCount`. Mätfel bärs som `fel`, aldrig som `0`.

#### ⚠️ FJÄRDE VAKTLÖSA GREP-TESTET DENNA SESSION
`"en pensionerad källa flaggas inte som problem"` greppade `kEp` (**med** kommentarer) — mutationen som dödade hela `bedomning`-grenen gav **grönt**, eftersom orden fanns kvar i kommentaren. Assertionerna greppar nu `kCode` (kommentarer strippade) och själva grenen `k.status === "pensionerad"`. **Regel: greppa alltid den strippade koden, aldrig råtexten — en kommentar som beskriver beteendet gör testet till en tautologi.**

#### VARFÖR DET INTE UPPTÄCKTES PÅ 11 VECKOR
- Cutovern var **korrekt utförd och dokumenterad** — inget larm skulle utlösts.
- Den ENDA felaktiga länken var en kommentar i `affar_api.js` som **antog** färsk sync utan att mäta.
- Ingen källa hade en färskhetskontroll. En pensionerad typ och en död synk ser exakt likadana ut utifrån.
- `TengellaWorkorder` gav fortfarande *plausibla* tal i affärsvyn — bara gamla.

#### ⏭️ ÅTGÄRDER
| # | Åtgärd | Status |
|---|---|---|
| 1 | HK i bokningsläget → `FortnoxOrder(TENGELLA)` på `ft_order_date` | ✅ rättat |
| 2 | Färskhetskontroll per connection, inte per typ | ✅ rättat |
| 3 | `affar_api.js` + `companies_api.js` + frontend → HK ur `FortnoxOrder(TENGELLA)` | ✅ **GJORT** |
| 4 | Färskhetskontroll på alla källor → `GET /admin/bokningslage/kallhalsa` | ✅ byggt |
| 5 | **Cron för `/sync/activities/tengella`** (passen finns redan via `/v2/TimeTableEvent` → Activity, men körs bara manuellt) | 🔴 ej gjort |
| 6 | Avveckla `TengellaWorkorder` när inget läser den | 🟡 inget läser den i affärsvyn längre; kvar i länk-/reconcile-listor (index.js 16591/16609/16625) |
| 7 | Cron för `/sync/activities/tengella` (Tengella-passen) | ✅ tillagd i `sync_v2_cron.sh` |

**⚠️ Åtgärd 3 är inte en ren omskrivning.** `affar_api.js` exkluderar `FortnoxOrder(TENGELLA)` för att undvika dubbelräkning mot `TengellaWorkorder`. Byter man källa måste exkluderingen bort SAMTIDIGT, annars försvinner HK helt ur affärsvyn. Historiska `TengellaWorkorder`-rader (t.o.m. 4 juni) finns dessutom sannolikt ÄVEN som `FortnoxOrder` från §9-backfillen (HANDOFF rad 1443: *"backfillat 2026 (workorder 2025+2026)"*) — kontrollera överlappet innan bytet, precis som för F&E.


### ⚠️ ALARM FATIGUE — rättat samma dag
Källhälsans första skarpa körning gav **4 🔴 av 7 källor** när bara EN var en verklig incident. Orsak: jag kollapsade de två färskhetssignalerna till en allvarlighetsgrad. Nu:
- `inaktuell` (inget **rörs**) → 🔴 incident — synken kör inte.
- `inga_nya` (rörs, inget nytt) → ℹ️ upplysning — synken **kör**; att TengellaCustomer inte fått en ny kund på 14 dagar är inte ett fel.
- `okänt` (omätt) → ⚠️.

Bara 🔴 och ⚠️ hamnar i `problem`. **Om allt är rött är inget rött.**

**Verifierat:** `bokningslage_smoke.mjs` **185/185**.

**Verifierat (HK-utredningen):** `bokningslage_smoke.mjs` **171/171**. **Mutationstestat:** HK på `ft_delivery_date` fäller 2 · okonstraintad HK-färskhet fäller 1 · constraints ej vidarebefordrade fäller 1 · HK med F&E:s etikett fäller 3. Samtliga 20 sviter gröna.

**Nästa:** deploya → kör om `summary` och kontrollera att HK nu ger rader → bygg HTML-vyn ovanpå. Datalagret är klart; presentationen ska bära `matt`-etiketterna och `varningar` **synligt**, inte i en tooltip — de tre bolagen mäts på tre olika sätt och det får inte gå att missa.
