# Tjänste-grid + prishjärna

> Kund-dashboard, prissättning (Vasakronan v10 = priskälla), avtals-lifecycle.
> Kod: `pricing_engine.js`, `mira-kund-dashboard-tjanster.html`.
> Minne: `project-tjanstegrid-prishjarna`

---
## Ny regeltyp `tiered_qty` — stegad tidsåtgång (EA/Dice eventstäd) — 2026-08-28

**Utlösare:** EA/Dice har ett **kundunikt** housekeeping-erbjudande där antalet gäster styr både tidsåtgången OCH rabatten. Det låg hårdkodat i gamla kundportalen.

**Kundens lathund (avstämd med kund — procenttalen ska INTE avrundas snyggare):**

| Gäster | Tid | Multiplikator | = rabattsats |
|---|---|---|---|
| <100 | 3,5 h | ×0,9873 | 1,27 % |
| <200 | 5 h | ×0,97 | 3,00 % |
| <300 | 6 h | ×0,9634 | 3,66 % |
| <400 | 7,5 h | ×0,9563 | 4,37 % |
| 400+ | 8,5 h | ×0,9533 | 4,67 % |

**Vad som redan fanns:** `tiered_discount` klarade multiplikatorerna exakt (verifierat mot lathunden, avvikelse ≤1 kr av öresavrundning). `Erbjudande.Kundföretag` (list) gör erbjudandet kundunikt — **tom = allmän, ifylld = unik**.

**Vad som saknades:** ingen regel kunde **härleda** en kvantitet. `_qty()` läser bara ett kundsvar, så timmarna måste kunden fylla i själv — och lathunden blev en rekommendation i stället för en uträkning.

**Ny regeltyp `tiered_qty`** i `pricing_engine.js`: drivaren (antal gäster) väljer nivå, nivån ger kvantiteten (timmar), beloppet blir `qty × price`. Samma nivålogik som `_tierRate` — högsta nivå vars `min` drivaren når upp till.

⚠️ **Faller tillbaka på LÄGSTA nivån** när drivaren är under alla `min`. Annars hade "0 gäster" gett 0 timmar och priset tyst blivit noll i stället för grundnivån.

**Ny pris-typ i erbjudande-adminen: "Stegad efter antal".** Genererar två regler ur EN drivare — `tiered_qty` för timmarna och `tiered_discount` för rabatten, båda på `antal`. Trappan redigeras rad för rad (från / timmar / rabatt-%), förifylld med EA/Dice-lathunden.

⚠️ **Enda pris-typen med TVÅ regler.** `ofDetectPt()` returnerade `null` för allt med `OF_RULES.length !== 1` → erbjudandet hade alltid öppnats i Avancerat läge. Tvåregels-kontrollen ligger nu FÖRE enregels-kontrollen, och ett test vaktar ordningen.

⚠️ **Procent lagras som sats** (4,67 % → `rate: 0.0467`). Motorn drar av satsen; lagras procenttalet rått blir rabatten 467 %.

⚠️ **Förhandsvisningen säger "kr/tillfälle"** för den här typen. Eventstäd prissätts per tillfälle — "kr/mån" på ett engångsuppdrag är direkt missvisande för den som lägger upp erbjudandet.

**Så lägger du upp EA/Dice-erbjudandet:** nytt erbjudande → pris-typ "Stegad efter antal" → timpris + frågetext → trappan är förifylld → sätt EA/Dice i `Kundföretag` så det bara syns för dem.

**Verifierat:** `pris_tiered_smoke.mjs` **47/47**, **13 mutationer, 13 faller, 0 kraschar.** Testar BÅDA sidor av varje nivågräns (1/99/100/199/200/299/300/399/400/5000) mot lathundens kronor — en off-by-one i nivåvalet syns bara där.

**Deploy:** `pricing_engine.js` (Render, serveras som statisk fil till blocken) + klistra om `mira-kommunikation-admin.html`.

---
## Paketkorten visar RABATTSATS, inga kronor — 2026-08-27

**Utlösare (Christian):** *"de 3 paketerbjudandena är jäkligt svåra att få vettiga… det strular om man plötsligt ska få kaffet gratis + rabatt om man råkar ha alla tjänsterna."*

**Vad som var fel:** korten räknade paketpriset i KLIENTEN — summa styckpriser × (1 − rabatt) — och visade struket pris + paketpris + "Spara X kr/mån". Två sätt att spricka:
1. En kund som redan hade hela paketet fick ändå en prislapp, som om paketet kunde köpas igen.
2. Med bara EN tjänst kvar blev rabatten (räknad på HELA paketets styckpris) större än den kvarvarande tjänstens pris. Planhat hade 3 av 4 → kortet såg ut att lova kaffet gratis PLUS avdrag.

**Beslut:** inga kronor alls på paketkorten. Kortet kommunicerar **rabattsatsen**; kronorna sätts i offert/avtal där de hör hemma.

| Paket | Rabatt |
|---|---|
| Kontoret Runt | **7 %** |
| Trivselpaket | **5 %** |
| Fräscht & grönt | **5 %** |

**Tre lägen, verifierade visuellt:**
- **Delvis aktivt** → `−7 %` + "på hela paketet", och statusraden *"Ni har 3 av 4 — lägg till Kaffe"* (ersätter prisraden: säger var kunden står utan att lova kronor). Beställningsknapp kvar.
- **Inget aktivt** → rabattsats + *"Allt i ett — vi räknar fram priset för era ytor."*
- **Har hela paketet** → varken rabattsats eller knapp, bara "Ni har hela paketet ✓". ⚠️ En rabatt kunden inte kan hämta ut ska inte lockas med.

**Kod:** `packageCompute()` räknar inte längre några priser alls — buggen bodde där, så den togs bort vid roten (returnerar `parts`/`newParts`/`have`/`total`). `SERVICE_PACKAGES` i `index.js` bär satserna; demo-fallbacken i blocket speglar dem och vaktas av ett test så de inte glider isär. `rabatt_pct` är nu ren kommunikation — `/services/request-activation` prissätter per tjänst och är opåverkad.

**Layoutfix på vägen:** rabattblocket hoppade ned under texten så fort beskrivningen var lite längre (Kontoret Runt vs Trivselpaket blev olika). `.mt-pkg-top > div:first-child { flex:1 1 180px; min-width:0 }`.

**Verifierat:** `avtal_split_smoke.mjs` **200/200**, **69 mutationer, 69 faller, 0 kraschar** — bl.a. återinförd prismatematik fäller 4, rabatt visad för kund som har allt fäller 2, borttagen statusrad fäller 2, gamla satsen i konfigen fäller 1, demo-fallback ur synk fäller 1. Renderat och ögongranskat i alla tre lägen.

**Deploy:** `index.js` (Render) + klistra om `mira-kund-dashboard-tjanster.html`.

---
## 0i. Tjänste-grid PRISHJÄRNA (Fas 0–5) + order→lead→pris — LIVE & VERIFIERAT 2026-08-12

Session-mål: göra kund-dashboardens tjänste-grid smart/anpassad med **EN prissanning**, förenkla erbjudande-adminen, paketera för merförsäljning, och låta "Beställ" bli lead→avtal. Hela kedjan LIVE + verifierad på testkund CMIAB (Frukt/Växter beställda → Comission i planering + mail + Lead med pris). Detaljplan i minnet `project-tjanstegrid-prishjarna.md`.

**Arkitektur (single source of truth):** Erbjudande äger pris+innehåll, `pricing_engine.js` räknar, kundens **Office (`Yta`+`Arbetsplatser`)** anpassar. Samma motor (`window.MiraPricing`, `HOST/pricing_engine.js`) driver kalkylator, kund-grid, förfrågan-wizard och admin-preview.

**PRISLÅST: Vasakronan v10** (`~/Downloads/vasakronan-calculator-v10.html`) = kanoniska priser:
- Housekeeping (formel): `((kvm/avverk)×dagar/mån×322 + 1000 + 37×kvm/12) × 1,15`; avverk=200 (≤500 kvm) annars 220; dagar/mån 5→21, 4→16,8, 3→12,6, 2→8,4.
- Kaffe Jura Giga X8c 3190/st · Jura X10 1650/st · Vatten 1210/st · Växter kvm×14 · Frukt(korg) 115/arbetsplats · Skrivare 1950 · Entrématta 130 · Förbrukning kaffe/mjölk/te 330/aplats · Hygien 58/aplats · Förbrukningsmtrl 17/aplats · Reception 69990/79990 (behålls, ej i Vasakronan). Engångstjänster UT. Wording: **Arbetsplatser** (ej Medarbetare) överallt; drivar-id `arbetsplatser`.

**Ny/ändrad kod:**
- `pricing_engine.js`: regeltyp **`housekeeping`** (parametriserad Vasakronan-formel, verifierad exakt mot `calcHK`).
- `mira-kommunikation-admin.html` (Erbjudanden): förenklad **pris-typ-väljare** (5 typer → genererar `custom_form_json`+`pricing_formula_json`; dagens byggare flyttad till "Avancerat läge"); standardiserade drivar-id `yta`/`arbetsplatser`/`antal`/`dagar`; live-preview; **"Uppdatera priser"**-inline-lista (merge-upsert, bara priset).
- `index.js /services/dashboard`: `assumptions`{yta,arbetsplatser}=`SUM(offices)` matas in i `_servicesPriceOf` → anpassade priser; returnerar `assumptions`+`packages` (config `SERVICE_PACKAGES`, Fas 3).
- `mira-kund-dashboard-tjanster.html`: laddar `window.MiraPricing`; `adaptedUnitPrice` räknar per **VALT kontor**; aktiv tile visar **AVTALSPRIS** (`Contract.monthly_cost`), ej prelpris; paketkort (live per-kontor-pris + besparing, "Beställ paketet", ~480px bredd); skickar `office_id` + `contact_email/name`.
- `index.js /services/request-activation` (Fas 4): office-antaganden → förseglar SAMMA pris som grid:en; skapar **Comission** (`C_OFFICE`/`C_OFFER`/`C_PRICE_BREAKDOWN`) OCH **Lead** (`Source="Mira"`, `estimated_service_cost_monthly`=priset). Self-healing lead-create `_createLeadDroppingBadFields`.
- `affar_api.js` (`nLeadFull`) + `mira-affar-samlad.html`: lead-listan har **"Prel. värde"**-kolumn (`belopp`=`estimated_service_cost_monthly`).

**Bubble-gotchas (nya — viktiga för framtida spår):**
- **Erbjudande.Leverantör ≠ Comission.Leverantör** (olika Bubble-typer). `SUPPLIER_BY_CATEGORY`-id:na gäller Comission → gav "object does not exist" på Erbjudande. Lösning: sätt **ALDRIG auto-Leverantör på erbjudandet**; leverantör sätts på Comission via `_supplierIdForCategory` (dynamisk namn-uppslag mot typ `leverantör-supplier`, ersatte hårdkodade stale id:n i offers/upsert + request-activation + forfragan/create).
- **Category option set = "Service & People"** (INTE "Staff"). Admin-dropdown rättad.
- **lead_source option set:** giltiga = Formulär/Telefonsamtal/Email/Möte/**Mira**/info@carotte.se/Kalkylator/Internservice. Order-lead använder "Mira". `safeCreate` självläker EJ ogiltiga option-set-värden → `_createLeadDroppingBadFields` droppar fältet och kör om.
- **Rate-limiter delade EN IP-hink** över alla publika endpoints → dashboard-laddningar fyllde hinken → **tysta 429** på request-activation (visade sig som "Delvis skickat", tom logg). Lösning: `_publicRateLimited(ip, max, windowMs, bucket)` — separata hinkar (activation 120/h, dashboard 300/h) + logga 429.
- **Office.Yta + Office.Arbetsplatser** (båda number, redan API-exponerade) MÅSTE vara ifyllda per kontor, annars blir storleksbaserade priser 0 ("Ingår") i grid:en.

**Datakrav i Bubble:** Office.Yta+Arbetsplatser per kontor · Erbjudanden med `pricing_formula_json` (upplagda via nya adminen) · ServiceCatalog-slugs matchar paket-config (`housekeeping`/`kaffe`/`frukt`/`vaxter`) · hidden inputs `mira_user_email`/`mira_user_name` bundna (Current User) i dashboard-blocket.

**Deploy/workflow:** commit rakt på `main`; **push via GitHub Desktop** (inte terminalen — GitHub tog bort lösenords-auth och `gh`/PAT saknas lokalt; keychain-cred kan behöva rensas). Build-markör verifieras på `GET HOST/version` (senast `2026-08-12-lead-value-col`). Bubble-block (admin + kund-grid + affär-vy) MÅSTE re-pastas manuellt vid frontend-ändringar — Render deployar bara backend.

**KVAR/nästa:** paket-config → egen Bubble-typ (så personal styr paket/rabatt själv, som erbjudandena) · ev. Lead↔ClientCompany-**referens** för tightare affärsvy-koppling (idag textfält `Company`) · Housekeeping-frekvensval i grid · cross-sell-nudgar · "kunden saknar kontorsyta"-prompt · nicer paket-bekräftelse-UX.

---


## 0g. Tjänste-grid admin-modul + avtals-lifecycle — BYGGE PÅBÖRJAT 2026-06-28

Bygger den admin-modul som 0f föreslog, plus två större tilläggsfeatures:
PDF-import av befintliga avtal (LLM-parsning) och PDF-generering från
avtalsmall som auto-skickas in i OfferApproval-flödet. Beslut LÅSTA
2026-06-28 efter genomgång av Carotte-avtal i `Avtal från Carotte/`.

### Beslut (2026-06-28)
1. **Full scope, inte MVP.** Subscription + RateCard + Hybrid + F&E (offert-baserad).
2. **Contract-typen utökas** med ~17 nya fält + 3 nya Option Sets (se Fas 1 nedan).
3. **Bilagor som separata Dokument-rader** (Floor Plan, KPI/SLA, Onboarding…), list på Contract — redigerbara separat utan ny signering.
4. **F&E-tile är "aktiv"** om senaste FortnoxOrder.delivery_date ≤ 6 mån. Ingen Contract krävs för F&E (i nuläget — ändras när F&E-abonnemang lanseras).
5. **PDF-import** via Anthropic Haiku 4.5 + structured output (tool-use). Carotte granskar parsed JSON innan Contract skapas. Originalet sparas som `signed_pdf`.
6. **ContractTemplate** = ny Bubble-typ (Fas 5). Default-mallar extraheras från `Avtal från Carotte/` (EA HK-avtalet är 99% färdigt som template).
7. **Auto-Contract vid Approved** körs i `_checkAndCompleteRequest`, bara om `kontraktstyp=Subscription` och `auto_create_contract != no`. RateCard/Hybrid kräver manuell skapande (säkerhetsmarginal).

### Konceptuella avtalstyper (från avtalsgenomgång)
| Typ | Exempel | Pricing-modell | Auto-Contract? |
|---|---|---|---|
| **Subscription** | HK x EA (188 282/mån + Cleaning Index) | Fast månad + index | JA (auto vid signering) |
| **RateCard** | Staff x Scandic Bemanning | Roller × kr/h, OB-tillägg, ingen månad | NEJ (manuellt skapas) |
| **Hybrid** | T.ex. Reception med fast bas + tilläggsdebitering | Båda | Beroende på flagga |
| **One-off Offer** | F&E offerter idag | Per uppdrag, ingen subscription | NEJ (lever som Erbjudande + OfferApproval) |

### 5 faser (sekventiellt, varje testbar isolerat)

1. **Fundament — PÅGÅR.** Bubble-schema-utbyggnad (Christian), `_createContractsFromApprovalRequest`-hook i `_checkAndCompleteRequest` (Render), status-härledning i `_buildServicesDashboard`. 2-3 dgr kod, ½-1 dag Bubble-schema, ½ dag test.
2. **Admin-block.** Kundkort-flik "Abonnemang" + global "Alla abonnemang"-vy. Manuell create/edit/end + bilagor (List of Dokument). 3-5 dgr.
3. **RateCard + Hybrid + F&E.** Kontraktstyp-väljare i admin, RateCard-formulär, F&E-tile-logik (senaste FortnoxOrder.delivery_date ≤6 mån). 3-4 dgr.
4. **PDF-import + LLM-parsning.** Drag-drop befintligt avtal → `pdf-parse` → Anthropic Haiku 4.5 (structured tool-use) → review-form → Contract skapas direkt (skipping OfferApproval, det är redan signerat). 4-5 dgr.
5. **Template + PDF-generering.** Ny Bubble-typ `ContractTemplate` (version-aware). Bygg 3 default-mallar från befintliga avtal. Flöde: välj mall → fyll spec → HTML-preview → puppeteer-PDF → POST `/approval/create`. 5-7 dgr.

**Total:** ~17-24 kod-dagar + 3 dgr Bubble-schema + 6-9 dgr Carotte-test ≈ 4-6 veckor kalendertid.

### Fas 1 — Bubble-fält att skapa (Christian)

**Contract — utöka befintlig typ.** Lowercase + underscore för alla nya fält (befintliga `Kundföretag`/`erbjudande`/`Kontor`/`Månadskostnad`/`Slutdatum`/`Produktantal`/`kategori` lämnas orörda):

| Fält | Typ |
|---|---|
| `startdatum` | date |
| `contract_type` | option set `contract_type` |
| `binding_months` | number |
| `notice_months` | number |
| `auto_renew_months` | number |
| `price_regulation_type` | option set `price_regulation_type` |
| `price_regulation_next` | date |
| `rate_card_json` | text (long) |
| `volume_json` | text |
| `attachments` | List of Dokument |
| `signed_pdf` | file |
| `signed_at` | date |
| `offer_approval` | OfferApprovalRequest |
| `commission` | Comission |
| `master_contract` | Contract |
| `status_override` | option set `contract_status_override` |
| `parsed_confidence_json` | text |

**OfferApprovalRequest — utöka befintlig typ:**

| Fält | Typ |
|---|---|
| `contract_template_json` | text (long) |
| `auto_create_contract` | yes/no (default `yes`) |

**Nya Option Sets:**

1. `contract_type` — `Subscription`, `RateCard`, `Hybrid`
2. `price_regulation_type` — `index_cleaning`, `index_kpi`, `lon_kollektiv`, `fast`, `ingen`
3. `contract_status_override` — `Pausat`, `Tvistig`, `Vilande`

**Verifiera:** `curl "$HOST/services/dashboard?company_id=<någon-kund>&debug=1"` → kolla att de nya fältnamnen finns i `contracts_raw[].all_field_names`.

### Fas 1 — Render-kod (kodat 2026-06-28, ej deployat)

**Tillagt i `index.js`:**
- `SERVICES`-konstanten utökad med nya Contract-fält-namn (CT_START, CT_TYPE, CT_BINDING, …).
- `_deriveContractStatus(contract, now)` → returnerar `aktiv` / `utgar_snart` / `avslutad` / `pausat` / `vilande` / `tvistig`. 30-dagars-gräns för utgår_snart.
- `_createContractsFromApprovalRequest(parent)` → idempotent (skippar om Contract redan finns med `offer_approval == parent._id`). Läser `contract_template_json` array, hoppar över specs där `contract_type != Subscription` (manuella). Auto-Contract-skapande safety-valve via `parent.auto_create_contract != "no"`.
- Hookad i `_checkAndCompleteRequest` direkt efter `status=Approved`-patchen, före bekräftelsemail. Fel är non-fatal (loggar warning).
- `_buildServicesDashboard`s tile-entries fick `status`, `contract_id`, `contract_type` så framtida kund-block kan visa "Utgår 30 nov"-pill direkt utan extra fetch.

**Spec-formatet i `contract_template_json` (förväntat av auto-hook):**
```json
[
  {
    "service_slug": "housekeeping",
    "offer_id": "<Erbjudande _id>",
    "office_id": "<Office _id>",
    "contract_type": "Subscription",
    "monthly_cost": 188282,
    "qty": 1,
    "startdatum": "2025-12-01",
    "slutdatum": "2028-11-30",
    "binding_months": 36,
    "notice_months": 3,
    "auto_renew_months": null,
    "price_regulation_type": "index_cleaning",
    "price_regulation_next": "2026-06-01",
    "volume_json": {"kvm": 12600, "housekeepers": 7, "hours_mf": 25, "hours_sun": 4},
    "category": "Housekeeping",
    "commission_id": "<Comission _id, valfri>"
  }
]
```

RateCard/Hybrid-specs i samma array skapar inget auto — väntar på manuell granskning i admin-blocket (Fas 2-3).

### Öppna beslut Fas 1
- (sätts allteftersom)

### Pågående filer/datatyper
- `ServiceCatalog` (live, 0f)
- `Contract` (utökas Fas 1)
- `OfferApprovalRequest` (utökas Fas 1)
- `ContractTemplate` (ny — skapas Fas 5)
- `Office` (oförändrad)

---

## 0f. Tjänste-grid på kund-dashboard — LIVE 2026-06-28, admin-spår PLANERAS

**Vad finns idag (live):**
- Kund ser ett tjänste-grid överst på sin Mira-dashboard. Mira-abonnemang (account-scope) + facility-tiles (office-scope) per kontor.
- Aktiva tiles: grön border + grön "AKTIV"-pill. Inaktiva: "Förslag" + "Läs mer →".
- Klick → 3-kolumns popup (visuell / info / actions). Bildspel-thumbnails (Erbjudande.Bildspel) växlar hero-bild. Fakta-chips (Målgrupp/Logistik/Capacity). Sociala bevis + onboarding-block per katalogpost. Sekundär CTA "Prata med rådgivare först →" (mailto).
- Office-dropdown vid 2+ kontor (filtrerar tile-griden per Kontor). Mira-tilen visas oavsett valt kontor.
- "Aktivera" POST:ar till `/services/request-activation` som återanvänder samma kärna som `/admin/forfragan/create` (skapar Comission + notify-mail + iOS-push).

**Status:**

| Komponent | Status |
|---|---|
| `mira-kund-dashboard-tjanster.html` (live fetch + 3-kol popup + office-dropdown) | ✅ Live |
| Render endpoints `/services/dashboard` + `/services/request-activation` + `?debug=1` | ✅ Live, rate-limit 300/h |
| ServiceCatalog-datatyp i Bubble (slug/name/icon/icon_color/offers/has_qty/qty_*/rating/testimonial_*/onboarding_json/category/display_order) | ✅ Live, posterna för mira/reception/catering/housekeeping inlagda |
| Office-grouping (active_account vs active_by_office) | ✅ Live |
| Pricing från kvm × rate (kalkylator-modellen) | ⏳ Steg 2 — kräver `Arbetsplatser` (number) på Office + `pricing_formula_json` på Erbjudande |
| Admin-modul för Carotte (skapa/redigera abonnemang) | ⏳ Nästa spår — se "Nästa spår" nedan |
| Lifecycle-koppling: aktivera → lead/förfrågan → OfferApproval → Contract | ⏳ Nästa spår |

### Filer
- `mira-kund-dashboard-tjanster.html` — kund-facing block, embeddat överst på dashboard_company_utkast
- `index.js` — `SERVICES`-konstanten + `_buildServicesDashboard()` + GET/POST endpoints
- `pricing_engine.js` — återanvändbar formelmotor (samma som forfragan-wizard) för per_kvm/per_person/fixed/addon_per_unit

### Datamodell — Bubble-fältnamn (case-sensitive, verifierat via debug)

**ServiceCatalog**: `slug` (text, lowercase ASCII), `name`, `subtitle`, `category` (`platform`|`facility`), `display_order` (number), `icon` (list/sparkle/cup/droplet/user/leaf/printer/fruit), `icon_color` (hex), `image` (fallback), `offers` (List of Erbjudande), `has_qty` (yes/no), `qty_label`, `qty_min`, `qty_max`, `from_price`, `from_unit`, `rating` (0-5), `rating_count`, `testimonial_quote`, `testimonial_author`, `testimonial_role`, `onboarding_json` (JSON-array `[{week,title,desc},…]`).

**Erbjudande** (extra fält vi använder utöver forfragan): `Unit` (option set: mån/person/kg/timme/dygn), `Bildspel` (List of images), `Image`, `Description_long`, `Produktinnehåll`, `Villkor`, `Målgrupp`, `Logistik`, `Capacity`, `PrisPerPerson`, `pricing_formula_json`.

**Contract** (case-sensitive — verifierat 2026-06-25): `Kundföretag` (cap K), `erbjudande` (lower e — LÄTT att råka anta cap E), `Kontor` (cap K), `Produktantal`, `Månadskostnad`, `Slutdatum`, `kategori` (lower k). Bubble-editorn versaliserar visningsnamnet → kör `?debug=1` för att se all_field_names från API:t innan du mappar.

**Office**: `Office_title`, `Kundföretag`, `office_address` (object med .address), `KontorsID` (text "01"/"02"/…), `Yta` (TEXT idag — bör bli number), `Arbetsplatser` (saknas, behövs för pricing-steg 2).

### Endpoints (live)
- `GET /services/dashboard?company_id=X[&debug=1]` — returnerar `{catalog, offices, active_account, active_by_office}`. CORS-allowlist KUND_KPI_ALLOWED, rate-limit 300/h, `Cache-Control: no-store`. Debug-läge returnerar contracts + offices raw + all_field_names för felsökning.
- `POST /services/request-activation` — body `{company_id, service_slug, service_name, option_id, qty, category_hint}` → skapar Comission via samma fältmappning som /admin/forfragan/create. Notify-mail + iOS-push återanvänds.

### Nästa spår: admin-modul + lifecycle-koppling (PLANERAS)

**Mål från Christian (2026-06-28):**
> "Vi behöver kunna administrera kundernas generella abonnemang på vår egna dashboard-backend. När de klickar aktivera skapas en lead och förfrågan. Sen ska vi offerera på detta. Jag vill dels nyttja den nya offerapproval-motorn, dels koppla till ett påskrivet contract som sen visas som aktiverat hos kund och oss."

**Två nya HTML-block att bygga:**

1. **Kundkort-flik "Abonnemang"** (per kund) — visar valda kundens alla Contracts grupperade per Office. Popup för skapa/redigera/avsluta. Bäddas in i kundkortet (se screenshot 2026-06-28 — flikraden EA/Dice / Personer / Historik / Affärer / Leads / Offerter / Ordrar / Fakturor / Avtal / Drift / Planering / Inställningar).

2. **Global översikt "Alla abonnemang"** — alla Contracts oavsett kund, kolumnsorterbar + filter per kund/status/kategori/slutdatum-range. Popup för skapa/redigera. Egen sida i Carotte-backend.

**Lifecycle-flödet ska se ut så här (nytt):**

```
Kund klickar "Aktivera" på tile
   ↓
Comission skapas (redan implementerat)
   ↓ NYTT
Lead skapas och kopplas till Deal/Affär
   ↓ NYTT
Carotte-admin bygger offert (existerande Deal-flöde)
   ↓ NYTT
OfferApprovalRequest skickas till kund (existerande, sektion 0e)
   ↓ NYTT
Kund signerar via befintlig landningssida
   ↓ NYTT
Contract skapas automatiskt vid `status=Approved`:
   Contract.erbjudande = OfferApproval.dokument-relaterat erbjudande
   Contract.Kontor     = Comission.Office (eller fråga vid signering)
   Contract.Månadskostnad = från signerad offert
   Contract.Startdatum = signeringsdatum
   ↓
Kundens tile blir AKTIV (befintlig logik tar över)
   ↓
Carottes admin-vy visar Contract som live
```

**Datakopplingar som saknas idag:**
- `Comission.lead` (skapas redan i `/admin/forfragan/create`) → Deal (manuellt idag, kan auto-kopplas via `Comission.lead.Deal`?)
- `OfferApprovalRequest.deal` → Deal (finns)
- `OfferApprovalRequest.contract_to_create` → ServiceCatalog/Erbjudande (NYTT — så vi vet vilket Contract som ska skapas vid godkännande)
- `Contract.offer_approval` → OfferApprovalRequest (NYTT — bakåtspårning)

**Förslag på förbättringar att överväga i nästa session:**

*Dataeffektivitet:*
- Subscription-history: ny Contract per ändring (vs editing in-place) — för att kunna visa "ni hade Receptionist sedan 2024, Concierge sedan 2026" i kundens dashboard.
- Pris ska bara komma från ETT ställe: Erbjudande.pricing_formula_json räknar pris med kontorets Yta/Arbetsplatser som answers. När Contract skapas frys priset i `Månadskostnad`. Dashboarden visar Månadskostnad om aktiv, annars beräknat "från-pris" från katalog.
- Stoppa duplicering av kategori — använd Erbjudande.Category som single source. Contract.kategori kan tas bort eller härledas.

*UX:*
- Lifecycle-status-badge på Contracts: `förslag` → `förfrågan skickad` → `offert väntar` → `signerad` → `aktiv` → `utgår om X dagar` → `avslutad`.
- Renewal-flow: 90 dagar före Slutdatum → auto-mail till kund + uppgift hos Carotte.
- "Uppgradera"-flöde direkt i kundens popup: byt nivå (Receptionist → Concierge) → ny förfrågan med kategori "uppgradering".
- Audit-loggen: lägg till Comission/OfferApproval-trail på Contract så Carotte ser hela kedjan.

**Öppna frågor till nästa session:**
1. Ska Contract skapas automatiskt vid signering, eller manuellt av Carotte-admin för säkerhetsmarginal?
2. Hur hanteras "uppgradering" — nytt Contract som ersätter, eller patch på befintligt?
3. Var visas pågående förfrågningar/offerter i kundens dashboard — egen sektion under tiles, eller status-pill på inaktiva tiles ("Förfrågan skickad, väntar")?
4. Behöver vi `ContractTemplate` så Carotte kan skapa snabb-Contracts från ServiceCatalog utan fullt förfrågan-flöde? (för "vi tar bara fakturan, allt övrigt är klart")

---
