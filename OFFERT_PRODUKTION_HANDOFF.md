# HANDOFF — Offert- & Produktionsmodul (Food & Event)

> Startad 2026-07-29. Läs detta + `ARKITEKTUR_OCH_OMTAG.md` (§1 arkitektur, §4 scaling, §10 lifecycle) + `HANDOFF.md` (gotchas 1–11, Bubble-mönster).
> Syfte: ny session ska kunna ta vid exakt här. Designfas klar, byggfas ej påbörjad.
>
> **Scope:** Mira blir *system of record* för Food & Event-offerter och -ordrar. Fortnox flyttas nedströms till enbart fakturaunderlag. Plus en produktionsmodul för köken som läser orderläget och genererar dagliga produktionslistor per kök/site.

---

## ⭐ STATUS 2026-08-06 — läget nu (LÄS FÖRST)

> Detaljerad, färsk logg finns i minnet `project-offert-produktion-fe.md` (läs den + denna). Denna sektion = snabb överblick.

**Byggt, verifierat skarpt, i drift:**
- **Fas 2 — Offert-modul (F&E):** `offert_api.js` + `mira-offert-admin.html`. Skapa/redigera (obegränsad radtext), Mira-PDF, skapa kund (företag/privat), artikel-autocomplete, inbäddad preview. Samlad offert-modul med `kind` (strukturerad/uppladdad/fortnox); uppladdad-signering använder uppladdat dok direkt.
- **Fas 3 — Signering + auto-convert:** `send-for-signing`→OfferApproval, auto-convert offert→`MiraOrder` vid Approved.
- **Affär = ryggrad (KLART + skarpt verifierat):** Både Offert och Avtal skapas inifrån affären. `Contract.deal` sätts vid auto-create (från OAR.deal); affärskortet visar Avtal-steg; kund-wizarden läser `data-mira="deal"`. **Avtal-grenen = deal-variant** `mira-abonnemang-deal.html` (egen namnrymd `.ad-wrap`/`wiz-*-d` pga multi-instans-krock; kund=`.ab-wrap`, admin=`.aa-wrap`). Auto-Contract skapar nu **ALLA typer** (Subscription/RateCard/Hybrid — vakterna borttagna) med deal+leverantör+titel.
- **Bubble value-strip-bugg löst:** Bubble strippar `value` på hidden inputs → alla wizard-block bär värdet i `data-val` + bootstrap kopierar till `.value`. Bind Bubble dynamic i `data-val`, ALDRIG `value`. Se `reference-bubble-hidden-input-strip`.
- **Komplett sökbar affär-liggare (KLART + skarpt):** `GET /admin/affar/list?type=&q=&page=&limit=` — server-paginerad + sökbar (inkl ref-företagsnamn) per typ. Per-typ native-kolumner: **Lead** (namn/email/telefon/företag/meddelande/region/källa/formulär/kundansvarig/**tilldela**-dropdown→`POST /admin/affar/lead/:id/assign`), **Aktivitet** (leverantör/typ/fas/mötesdatum/företag/affär/meddelande/vår användare), dok-typer (unified). Tratt via `bubbleCount`. `Avtal` egen rad-typ + tratt-steg. "Alla"=feed-översikt med affärskort.
- **Visa-knapp på offert/order/faktura:** öppnar PDF i ny flik. Har dok `ft_pdf` → direktlänk; annars **lazy on-demand** `GET /admin/affar/doc-url` (hämtar från Fortnox `/preview`, cachar). ⚠️ `ft_url` = Fortnox API-URL (JSON, EJ PDF) — används aldrig som PDF-länk (bara Tengella-fakturans ft_url är PDF). **Verifierat skarpt: order F&E, faktura, offert funkar; Tengella-order utan knapp (ingen Fortnox-PDF).**
- **Tengella order-dedup:** HK-order kommer via sammanslagna `FortnoxOrder(connection=TENGELLA)` (taggas källa via `connSource`), raw `TengellaWorkorder` borttagen ur liggaren (frusen sedan 9e-cutover). Löser även Tengella-belopp-null (unified härleder `ft_total`).

**Bubble-typer byggda av Christian:** Offert (+kind), OffertRad, Kok, MiraOrder (ordernr=TEXT, `kundforetag` UTAN ö), MiraOrderRad, ClientCompany (+customer_type/faktura_email/faktura_referens/Kundansvarig=User), OfferApprovalRequest (+offert), Product (+default_kok), **Contract.deal (ref→Deal)**. Lead: `tilldelad`(User)+`Kundansvarig`(User) fanns redan. Deal-listfält offert/order/invoice/lead/historik finns.

**✅ INLINE EDIT lead+aktivitet KLART 2026-08-07 (browser-verifierat, ej deployat):** Lead- och Aktivitet-rader i samlade vyn är nu **expanderbara + redigerbara inline** (ersätter native-popuparna). Aktivitet: typ-select; vid **Kundmöte** visas Fas/Mötesdatum/Genomfört, vid Genomfört visas Mötesanteckning (villkorlig toggle verifierad båda håll). Lead: koppla Kundföretag (sök) + Kundansvarig (User-dropdown/kollegor) + Todo (titelsök) — manuell koppling då auto ofta felar. **Skrivnycklar skarpt bekräftade via round-trip:** display-namn = skriv-nyckel (`Datum_bokning`, `Kundmöte`, `genomfört`, `mötesantecking`, `beskrivning`, `activity_type`; Lead: `client_company`, `Kundansvarig`, `todo`). **Bonus-fix:** `nAktFull` läste fel nycklar (`datum_bokning_date`/`kundm_te_option_kundm_te`) → Fas/Mötesdatum-kolumnerna var tomma; nu `Datum_bokning`/`Kundmöte`. Backend: 3 nya routes i `affar_api.js` (`POST /admin/affar/aktivitet/:id/patch`, `POST /admin/affar/lead/:id/link`, `GET /admin/affar/todos?q=`). 33 smoke-assertions gröna + browser-verifierat med mockad fetch. **Deploy: `affar_api.js` (Render) + `mira-affar-samlad.html` (Bubble).**

**⚠️ ÖPPNA PUNKTER / NÄSTA:**
1. **Deploya senaste (Render):** `index.js` + `affar_api.js` + `offert_api.js`. **Bubble (klistra om + bind data-val):** `mira-affar-samlad.html`, `mira-abonnemang-kund.html`, `mira-abonnemang-admin.html`, `mira-abonnemang-deal.html`, `mira-offert-admin.html`.
2. **Bubble-uppsättning kvar:** (a) `data-mira="current_user_company"` i affär-blocket (=Current User's Associated_company) → fyller tilldela-dropdownen; (b) affärs-popupens Avtal-flik = BARA deal-blocket (`.ad-wrap`); (c) admin "+ Nytt avtal" create-modal (byggd, kräver data-val planning_token).
3. ~~Bekräfta inferens-fält skarpt~~ **✅ STÄNGT 2026-08-07 (skarptest mot live Bubble):** lead-meddelande `prospect_message`||`Description` → `prospect_message` NULL på 8/8, `Description` bär alltid texten (fallback gör jobbet, korrekt). akt-meddelande `beskrivning`||`mötesantecking` → `beskrivning` ifyllt 8/8 (kort sammanfattning=rätt primär), `mötesantecking` bara 1/8 (lång not, korrekt fallback). vår användare `writer`||`Created By` (EJ `Creator`) → `writer` ifyllt 8/8 = riktiga säljare. **Inga kodändringar krävdes.** (Frontend klipper meddelande till 90 tecken + tooltip.)
4. **Connection-auth-hälsa:** lazy-PDF funkar för anslutningar med giltig Fortnox-auth. Icke-F&E-anslutningar kan ge 2000311/2001101 (Tengella=ingen order-licens; andra=token/refresh). Grävs vid behov. Ni har flera Fortnox-anslutningar (F&E `1771579463578x385222043661358460`, Tengella `1771579481117x119544302020443410`, +t.ex. `1766270051813x1533036407163797`).
5. **doc-typ-paginering approximativ** för offert/order (multi-källa: per-källa cursor+merge+slice). Enkla typer (lead/aktivitet/faktura/avtal/affär) har ren cursor-paginering.
6. **P3:** manuell koppla-knapp legacy deal-lösa avtal/Fortnox-dok → affär. **Lead/Aktivitet "Visa"→native popup** via URL-param-mönster (ej byggt, `window.location=?open_lead=id`+page-load-workflow).
7. **"Mina offerter"-lista** placering; uppladdad offert saknar strukturerat belopp (total=0).
8. **🔴 SÄKERHET:** `ANTHROPIC_API_KEY` + `PLANNING_ADMIN_TOKEN` exponerade i klartext flera ggr — ej roterade. Påminn om rotering.

**Nyckelfiler:** `offert_api.js` (offert+signering+convert), `affar_api.js` (feed+kedja+`/list`+assign, cache-lager userMap/dealMap/supplierMap/companyOwnerMap, normaliserare n*), `index.js` (`_createContractsFromApprovalRequest` ~16500, `_createApprovalRequestInternal` ~16850, SERVICES-konstanter+CT_DEAL ~19720, affar-registrering + `/admin/affar/doc-url` ~19833, fetchAndStore*Pdf 3637/3716/14849, `fortnoxGetBinary` 3467 global client_secret, `ensureFortnoxAccessToken` 1621), `contract_render.js`/`pdf_utils.js`. HTML: `mira-offert-admin.html`, `mira-affar-samlad.html`, `mira-abonnemang-kund/-admin/-deal.html` (deal=namnrymds-klon, portas manuellt vid ändringar), `mira-approval-create.html`. Smoke-tester i scratchpad.

**Arbetssätt:** Christian bygger Bubble-typer + deployar (git push→Render; Bubble version-test→live). Claude bygger backend/HTML. Gissa ALDRIG fältnamn/Option Set-värden (be om skärmdump). Inga `?.`/`??` i Bubble-HTML (parser-krasch). Bind Bubble dynamic i `data-val` ej `value`. Smoke-testa isolerat med mockad Bubble före deploy.

---

## 0. Kontext & avgränsning

### 0.1 Varför Food & Event först
Carotte har tre affärsben med **helt olika produktions- och systemvägar**. Vi bygger bara F&E nu:

| Affärsben | Produktionsväg idag | System of record framåt | Denna modul? |
|---|---|---|---|
| **Food & Event** | Offert skapas i **Fortnox**, produceras i egna kök | **Mira** (detta projekt) | ✅ JA |
| **Housekeeping** | **Workorder i Tengella** | Tengella | ❌ Separat projekt |
| **Staff** | Bemanning — **ny Intelliplan-integration** (API-förhandling pågår) | Intelliplan | ❌ Separat, blockerat på API |

F&E är avgränsat och självständigt: en specifik produktion (matlagning i egna kök) och offerter som idag bara lever löst i Fortnox. Det gör det till rätt startpunkt — ingen extern produktions-motor i vägen.

### 0.2 Kärnproblem vi löser
1. **Offert idag = Fortnox**, med hård radbegränsning (en rad / ~30 tecken beskrivning). Carotte vill ha rik, obegränsad beskrivningstext per rad.
2. **Ingen produktionsplanering.** Köken saknar verktyg för att se aggregerat vad som ska tillagas per dag, fördela produktion mellan flera kök/sites, och få ut dagliga PM (prep-listor + per-order-speglingar).
3. På sikt: **AI-genererade offertutkast** från en fritextbeskrivning.

### 0.3 Nuläge i koden (verifierat 2026-07-29)
- **All Fortnox-integration är läsande** (`GET api.fortnox.se/3`). Ingen skrivväg finns. Offert/order-skapande i Mira är greenfield.
- Fortnox-artiklar importeras redan → Bubble-typen **`Product`** (`ft_article_number` unik nyckel, `Produkttitel`, `Beskrivning`, `ft_sales_price`, `ft_unit`, `ft_type`, `ft_vat`, `ft_supplier_name`, `FortnoxConnection`, `ft_raw_json`). Se `POST /fortnox/upsert/articles` (`index.js` ~11413). `Product` delas redan med förfrågan (`Produkttillägg`) och `Erbjudande`.
- Lässpeglingar `FortnoxOffer` / `FortnoxOrder` / `FortnoxOrderRow` finns — **rör inte dessa**, de är Fortnox→Bubble-spegel. Native-typerna heter medvetet annorlunda (se namn-varning §2.0).
- Förfrågan-domänen (`Comission`) fångar redan F&E-request: `guest`, `allergens_json`, `delivery_date`, `Office`/`location`, `Beställare`, `Produkttillägg`. Offerten länkar tillbaka hit.

---

## 1. Låsta beslut (2026-07-29, Christian)

| # | Beslut | Val | Konsekvens |
|---|---|---|---|
| 1 | Kundvänd offert-PDF | **Mira genererar PDF:en** | Obegränsad text löst gratis. Återanvänder `contract_render.js` + `pdf_utils.js`. Fortnox får aldrig kund-PDF. |
| 2 | Fortnox-export | **Order-push, konverteras till faktura i Fortnox** | Mira skickar ordern → `POST /3/orders` → Fortnox importerar → Carotte konverterar order→faktura *inne i Fortnox*. Enda skrivvägen. Mira äger offert+order-livscykeln fram till pushen. |
| 3 | Kök-tilldelning | **Artikel→standardkök + manuell omfördelning** | `Product.default_kok` (valfri) sätter standard; **fördelningen sker främst manuellt i produktionsvyn** (radens `kok`-override), eftersom titlar EJ är site-prefixade (§10.1). `default_kok` fylls på över tid som minnesfunktion. |
| 4 | Artikelregister | **Finns i Fortnox, import klar** | Aggregeringsnyckel = `Product.ft_article_number`. F&E-filter = `FortnoxConnection == FE_CONNECTION_ID` (§10.1). |
| 5 | Order-objekt | **Separat `MiraOrder`.** Accept av offert konverterar → order. | Ordern är redigerbar **utan cutoff-datum** (ändras sent, även nära/efter leverans). Produktion läser bara order och måste spegla *aktuellt* läge. |
| 6 | Kök/site-register | **Ny `Kok`-typ** | Eget register (namn, adress, aktiv). |
| 7 | Leveranstid | **Huvudnivå v1** | En leveranstid/plats per offert/order. Per-rad kan läggas till senare. |
| 8 | Accept-mekanism | **Återanvänd OfferApproval** | F&E-offert accepteras via befintlig OTP/signer/granskare-motor. Ingen egen accept-väg. |
| 9 | Offertnummer | **Mira-eget** | Löpserie `FE-{år}-{seq}` (t.ex. `FE-2026-0001`). Matchar ingen Fortnox-serie. |
| 10 | prep-kategori-fält | **Återanvänd befintligt `Product category`** | Gammalt/oanvänt fält, fritt att återanvända. Sätt om Option Set-värdena (§10.5). Inget nytt `prep_kategori`-fält. |
| 11 | Offert-typ | **Utöka befintlig `Offert`, skapa ej ny** | `Offert` finns redan (CRM-wrapper + signeringslivscykel via `offer_approval_status`). F&E-offerten går SÖMLÖST in i befintligt dok-upload + signeringsflöde. Livscykel = `offer_approval_status` (inget `StatusOffert`). `source`-fält skiljer native F&E från sync-wrapper. `OffertRad` = ny radtyp. |

---

## 2. Datamodell (Bubble-schema — Christians kritiska väg)

### 2.0 ⚠️ Namn-varning
`FortnoxOrder`/`FortnoxOrderRow` är redan tagna (lässpegel). Native-order heter **`MiraOrder`/`MiraOrderRad`**. Blanda aldrig ihop dem i kod/queries.

### 2.1 Nya typer

**`Kok`** (Kök/Site)
| Fält | Typ | Not |
|---|---|---|
| `namn` | text | |
| `adress` | geografisk adress | plocka `.address` (samma mönster som Office) |
| `aktiv` | yes/no | |
| `kapacitet_note` | text (valfri) | fritext om kapacitet/utrustning v1 |

**`Offert`** — ⚠️ ÅTERANVÄND BEFINTLIG TYP (korrigering 2026-07-29). `Offert` finns redan som CRM-offert-wrapper (Deal-länkad, auto-skapad av Fortnox-PDF-synk `ensureOffertWrapperForDeal` `index.js:3525`) OCH bär redan signeringslivscykeln via `status` = Option Set `offer_approval_status`. **F&E-offerten ska SÖMLÖST in i det befintliga offert+signeringsflödet** (dokument-upload + skicka för signering via OfferApproval). Skapa INTE en ny typ — utöka denna. Radera den råkade dubbletten `Offert` (Publicly visible).

Befintliga fält (rör ej): `deal`, `dokument` (List of Dokument — Mira-PDF + bilagor hamnar här), `recipient` (List of Coworker = **beställare**), `sender` (List of User), `status` (offer_approval_status = livscykel+signering), `giltig_till` (date), `beskrivning` (text = offert-intro), `titel` (text), `FortnoxOffer`/`Invoice`/`lead`/`offer_status`/`total_amount` (legacy sync-fält, lämna).

Nya fält att lägga till:
| Fält | Typ | Not |
|---|---|---|
| `kundforetag` | ClientCompany | kund |
| `office` | Office | valfri |
| `offertnr` | text | Mira-genererat `FE-{år}-{seq}` (§4.3) |
| `offertdatum` | date | (`giltig_till` finns redan för giltig t.o.m.) |
| `leveransdatum` | date | |
| `leveranstid` | text | v1: fritext/tid |
| `leveransadress` | geografisk adress | ✅ klar (Christian valde geo) |
| `betalningsvillkor` | text | default "10 dagar" |
| `momstyp` | text | |
| `valuta` | text | default SEK |
| `summa` / `moms_belopp` / `total` | **number** | cachead från raderna (`total_amount` är text-legacy → använd EJ) |
| `comission` | Comission | länk till förfrågan (valfri) |
| `villkor_text` | text (long) | fri villkorstext för PDF-foten |
| **`source`** | text/Option Set | diskriminator: `mira_fe` (native) vs `fortnox_sync` (auto-wrapper). Skiljer native F&E-offert från sync-skapad wrapper |

**Livscykel = befintligt `offer_approval_status`** (Draft·Sent·Viewed·OTP_Sent·Approved·Expired·Revoked). Inget nytt `StatusOffert`. `Approved` = trigger för offert→`MiraOrder`-konvertering (§3).

**`OffertRad`**
| Fält | Typ | Not |
|---|---|---|
| `offert` | Offert | |
| `radnr` | number | |
| `product` | Product | aggregeringsnyckel via `ft_article_number` |
| `artikelnr` | text | kopia av `Product.ft_article_number` (snabb aggregering utan join) |
| `benamning` | text | kort rubrik |
| **`beskrivning_long`** | **text (long)** | **obegränsad — hela poängen** |
| `antal` | number | |
| `enhet` | text | |
| `apris` | number | |
| `rabatt` | number | |
| `moms` | number | |
| `radsumma` | number | |
| `konto` | text | |
| `ks` | text | kostnadsställe |

**`MiraOrder`** — ✅ BYGGD 2026-07-30. Huvudfält kopierade från `Offert` (`kundforetag`, `office`, `leveransdatum`, `leveranstid`, `leveransadress`, `betalningsvillkor`, `momstyp`, `valuta`, `summa`, `moms_belopp`, `total`, `villkor_text`, `comission`, `source`) PLUS:
| Fält | Typ | Not |
|---|---|---|
| `offert` | Offert | backlink till källofferten (full spårbarhet — offertnr/datum nås härigenom) |
| `ordernr` | **text** | ⚠️ döpt om från `offertnr` (var number → **ändra till text** för `FE-2026-0001`-lineage) |
| `orderdatum` | date | ⚠️ döpt om från `offertdatum` — värde = accept/bekräftelse-datum (EJ offertdatum) |
| `orderstatus` | Option Set **StatusMiraOrder** | Bekräftad / I produktion / Levererad / Fakturerad |
| **`leverans_ts`** | **number** | **epoch ms — för date-bounded produktionsquery (§5.2)** |
| `fortnox_faktura_ref` | text | Fortnox order-DocumentNumber efter push (§6). Byt ev. namn `fortnox_order_docno` |

**`MiraOrderRad`** — ✅ BYGGD 2026-07-30 (samma fält som `OffertRad` PLUS:)
| Fält | Typ | Not |
|---|---|---|
| `order` | MiraOrder | |
| `kok` | Kok | default från `Product.default_kok`, override-bar i produktionsvyn |
| `prep_kategori` | text | härledd från `Product`s `Product category`-fält, override-bar |
| `leverans_ts` | number | kopieras från order (per-rad-tid framtida) |
| `offert` | Offert | ⚠️ REDUNDANT (raden når offert via `order → offert`). Harmlöst; kan tas bort. Låg prio |

### 2.2 Fält på befintlig `Product`
| Fält | Typ | Not |
|---|---|---|
| `default_kok` | Kok (NYTT) | standardkök, **valfri** — fylls på över tid (titlar ej prefixade → ingen auto-seed) |
| `Product category` | ÅTERANVÄNDS | befintligt oanvänt fält → prep-kategori. Sätt om Option Set-värden (§10.5) |
| `ar_matratt` | yes/no (NYTT, valfri) | sekundärt: filtrera bort frakt/serviceartiklar *inom* F&E-connection. Primärfiltret är `FortnoxConnection` (§10.1) |

**OBS:** F&E-filtret vilar på `FortnoxConnection`, INTE på nya fält. `Product category`/`Systemprodukt-Mira`/`Mira Shop` är gammalt oanvänt (0 backend-träffar) — `Product category` återanvänds för prep-kategori.

### 2.3 Option Sets
- **`offer_approval_status`** — ÅTERANVÄND BEFINTLIG (redan på `Offert.status`). Värden: `Draft·Sent·Viewed·OTP_Sent·Approved·Expired·Revoked`. Täcker offertlivscykeln — inget nytt `StatusOffert`. `Approved` triggar offert→order.
- **`StatusMiraOrder`** (NY): `Bekräftad` · `I produktion` · `Levererad` · `Fakturerad`
- `prep_kategori` (om Option Set hellre än fritext) — värden bekräftas med köken.

---

## 3. Livscykel-flöde

```
Förfrågan (Comission — finns)
   │  Carotte bygger offert (manuellt, eller AI-utkast §7)
   ▼
Offert (offer_approval_status=Draft) — SÖMLÖST i befintligt offertflöde
   │  Mira renderar kund-PDF (contract_render.js) → sparas i Offert.dokument.
   │  Skickas för signering via BEFINTLIG OfferApproval-motor (dok-upload + OTP).
   │  status: Draft → Sent → Viewed → OTP_Sent
   ▼
Kund signerar → offer_approval_status=Approved
   │  convertOfferToOrder(): deep-copy OffertRad → MiraOrderRad,
   │  sätt kok per rad från Product.default_kok, beräkna leverans_ts.
   │  (samma completion-path som avtals-auto-hooken §10.5, grenad för F&E via source=mira_fe)
   ▼
MiraOrder (StatusMiraOrder=Bekräftad) — REDIGERBAR UTAN CUTOFF
   │  Planeraren fördelar produktion mellan kök (radens kok-override).
   ▼
Produktionsmodul (läser MiraOrder date-bounded på leverans_ts)
   │  Daglig export: (a) aggregerad prep-lista/kök  (b) per-order-spegling
   ▼
Leverans → orderstatus=Levererad
   ▼
Order-push → Fortnox (POST /3/orders) → konverteras till faktura i Fortnox
```

**Kritiskt (beslut #5):** ordern ändras sent. Produktionslistorna cachas aldrig som sanning — de **regenereras** från aktuellt orderläge varje morgon / på begäran. Överväg delta-markering ("ändrad sedan gårdagens PM").

---

## 4. Offert-modul

### 4.1 UI (efterliknar Fortnox-offertvyn, bilden 2026-07-29)
Huvudsektioner: Kund · Offertuppgifter (betalningsvillkor, referenser, valuta, momstyp) · Kunduppgifter · Leveransuppgifter · **Radtabell** (Artikelnr, Benämning, Antal, Enhet, À-pris, Rabatt, Summa, Moms, Konto, KS). **Enda funktionella skillnaden:** benämning/beskrivning är en **rik, obegränsad `beskrivning_long`** — inte Fortnox en-rad/30-tecken.

Radpicker autocompletar mot F&E-`Product` (filtrerat, §10.1). Val fyller artikelnr/enhet/à-pris/moms; planeraren skriver fri `beskrivning_long`.

### 4.2 Endpoints — ✅ BYGGDA + SMOKE-TESTADE 2026-07-30 (`offert_api.js`, ny modul)
Ny fristående modul `offert_api.js` (DI-mönster som `contract_render.js`) → `registerOffertRoutes(app, deps)` anropas i `index.js` direkt efter `contractRenderEngine`-init. Auth: `_planningAuthed` (x-admin-token = PLANNING_ADMIN_TOKEN). `/admin/offert` tillagd i `openPrefixes`. Alla totaler beräknas **server-side** (litar aldrig på klientens `radsumma`).
- `GET  /admin/offert/products?q=` — F&E-artikel-autocomplete, constrainar `FortnoxConnection == FE_CONNECTION_ID`. Titel-sök + numerisk artikelnr-sök. Returnerar {id, artikelnr, titel, apris, enhet, moms, prep_kategori, default_kok}.
- `POST /admin/offert/create` — skapar `Offert` (source=mira_fe, status=Draft, genererar `offertnr` `FE-{år}-{seq}`) + `OffertRad`-rader, cachar summa/moms_belopp/total.
- `PATCH /admin/offert/:id` — uppdaterar huvud; om `rows` skickas ERSÄTTS alla rader (delete+recreate) + totaler räknas om.
- `GET  /admin/offert/:id` (offert + rader sorterade på radnr) · `GET /admin/offert/list` (source=mira_fe).
- `POST /admin/offert/:id/render-pdf` — Mira-genererad kund-PDF via `contractRenderEngine.renderAndPersist` (full HTML byggs i modulen, obegränsad `beskrivning_long`), länkas in i `Offert.dokument`. **Kirurgisk ersättning:** matchar tidigare auto-renders på titel `Offert {offertnr}` → tar bort dem (+ Dokument-rad), **rör aldrig uppladdade bilagor**. Adress plockas ur geo-objekt (`_pickAddr`). Saknade fält renderas som röd `"saknas"`-markör (granskningssignal före utskick).
- `POST /admin/offert/:id/convert-to-order` — ⚠️ **kräver MiraOrder-rename `ordernr`/`orderdatum`** (§2.1). Deep-copyar rader → `MiraOrderRad`, ärver `kok`+`prep_kategori` från Product, sätter `leverans_ts`, idempotent (skippar om order redan finns). Fas 3 kopplar denna till `offer_approval_status=Approved` auto; nu manuell/testbar.

**UI-block BYGGT 2026-07-30:** `mira-offert-admin.html` (ny fil) — ärver `mira-approval-create.html`:s designsystem (`.ao-`-namespace, DM Serif + orange #F47B30, data-mira-wiring, IIFE + BROOT-scoping, inga `?.`/`??`). Två lägen: `data-mira="clientcompany"` satt → förvald/ärvd kund (+ `comission` + source=deal); inget satt → CC-sökfält (`/admin/planning/companies` + `/admin/clientcompany/:id/details`-prefill). Radeditor med artikel-autocomplete (`/admin/offert/products`), live-totaler, spara (create/PATCH), förhandsgranska PDF (`render-pdf` → öppnar file_url), "Mina offerter"-lista (`/admin/offert/list` → öppna/redigera). Visuellt verifierat i browser-pane. **Ej i v1:** "Skicka för signering" (Fas 3 — hookar in i befintliga OfferApproval-blocket). Interaktivitet (autocomplete/totaler/spara) testas skarpt i Bubble med riktig token.

### 4.3 Offertnummer — ✅ `FE-{år}-{seq}` (t.ex. `FE-2026-0001`), best-effort löpnr (scannar source=mira_fe, max+1).

### 4.4 Skapa kund + privatkund — ✅ BYGGT 2026-07-30
**Beslut:** `ClientCompany` + `customer_type`-flagga (Option Set **Företag/Privat**), INGET personnummer (namn+adress räcker för F&E). Reuse `Adress`/`Telefon`; ny `faktura_email` (text).
- **Bubble (Christian):** `ClientCompany` → `customer_type` (Option Set Företag/Privat), `faktura_email` (text), `faktura_referens` (text).
- **Endpoint:** `POST /admin/offert/client/create` — skapar ClientCompany (Org_Number bara för Företag, digits) + ev. `Coworker` (beställare: Förnamn/Efternamn/Email/Kundföretag). Beställaren blir `Offert.recipient`.
- **UI:** "+ Skapa ny kund"-form i offert-blocket (segment Företag/Privat, org.nr döljs för privat), verifierad interaktiv.
- **PDF:** privatkund visar "Privatperson" i st.f. org.nr.
- **⚠️ Skriv-varningar:** `Adress` är geo-fält → skriv-via-Data-API opålitligt (om create failar → byt till `faktura_adress` text; `buildOffertHtml` läser redan `faktura_adress` som fallback). `Telefon` = number → konverteras till siffror.
- **Beskrivning-autofill:** `Product.Beskrivning` populerar radens `beskrivning_long` vid artikelval **om raden är tom** (redigerbart, skriver aldrig över).

---

## 4.5 Affär — samlad CRM-vy + Fortnox→Mira-brygga (NYTT SPÅR, design låst 2026-08-01)

**Kontext:** CRM:ets "Affär"-flik har idag 6 Bubble-native-tabeller (Aktivitet, Leads, Affär/Deal, Offerter, Ordrar, Fakturor) från blandade källor. Process: `Lead/Aktivitet → Affär(Deal) → Offert → Order → Faktura`. Skiss: `mira-affar-samlad-skiss.html`.

**Beslut låsta 2026-08-01:**
1. **Lämna Bubble-native** → bygg EN samlad fristående HTML-sida (utanför Bubble): processtratt + samlad sökbar liggare + affärskort som visar kedjan. Källbadges Mira/Fortnox/Tengella.
2. **Alla F&E-offerter/ordrar SKA skapas i Mira** → Fortnox offert/order-synk för F&E kan **fasas ut** när adoption=100% (Fortnox = renodlat faktura-lager för F&E). Tengella (HK) + faktura-synk oförändrade.
3. **Legacy Fortnox-dokument utan deal-koppling** → visas okopplade + **manuell koppla-knapp** (nytt: fält för att fästa FortnoxOffer/Order på Deal).

**Bryggan = samexistens med proveniens, INGEN cutover:**
- Migrera aldrig historik — gamla Fortnox-offerter/ordrar förblir läskopior, badge:ade.
- `source`-fält på varje post driver badge + dedup.
- ⚠️ **Eko-dedup MÅSTE lösas före order-push i skala:** Mira→Fortnox-order läses tillbaka som FortnoxOrder → dubbelräkning om ej länkad. Nyckel: spara Fortnox-docno på MiraOrder; synken känner igen Mira-födda ordrar (hoppa/länka spegeln).
- Faktura-avstämning: pushad Fortnox-order bär referens (ordernr) → följer till faktura → faktura-synk länkar FortnoxInvoice→MiraOrder→Deal.
- Adoption (% nya F&E-offerter i Mira) driver takten, inte ett datum. Faktura-hämtning oförändrad oavsett offert/order-migreringens läge.

**Fasad byggordning:**
- **P1** — ✅ **BYGGT + smoke-testat 2026-08-01.** Ny modul `affar_api.js` (`GET /admin/affar/feed` → tratt-counts + normaliserad liggare över Lead/activitet_crm/deal/Offert(mira)/FortnoxOffer/MiraOrder/FortnoxOrder/FortnoxInvoice). Fortnox via `ft_customer_name`, CRM/Mira via ClientCompany-namncache (`CC_FIELD_OVERRIDES`: deal.kundföretag, Lead.Company, activitet_crm.clientcompany). Status→pill-mappning + källbadge (HK-connection-faktura→tengella). Modul-`bubbleCount` tillagd i index.js. UI: `mira-affar-samlad.html` (live, client-side filter/sök, funnel-klick=typfilter). 18 smoke-tester gröna. **Kända P1-luckor:** TengellaWorkorder i order-count men EJ i liggaren (fältmappning ej bekräftad); ägare/deal-namn best-effort; sortering på Created Date (sync-tid för Fortnox). read-only samlad liggare + tratt över befintlig data (bevisar värdet, noll risk).
- **P2** — ✅ **BYGGT + smoke-testat 2026-08-02.** `GET /admin/affar/deal/:id` läser Deals list-fält direkt (lead, historik=activitet_crm, offert=Offert(Mira), order=FortnoxOrder, invoice=FortnoxInvoice) + reverse-lookup MiraOrder per offert. Returnerar normaliserad kedja {lead, aktivitet, offert, order, faktura} med items + status. UI: klick på Affär-rad expanderar affärskort inline (kedje-stepper Lead→Aktivitet→Offert→Order→Faktura, done/active-states + status-pills). `bubbleGet` tillagd som affar-dep. Ingen heuristik behövs — Deal länkar redan hela kedjan. (Tengella-belopp: fallback ft_totalvat/total_price/ft_net/total_cost — bekräfta rätt fält.) affärskort/kedja per Deal.
- **P3** — manuell koppling av legacy Fortnox-dokument till Deal.
- **P4** — live-actions (skapa offert från Deal, pusha order, faktura-länkning) + fasa ut F&E Fortnox offert/order-synk.

**Öppet:** normaliserad statusmodell per steg (varje källa har eget statusspråk). Faktura→order-referens: bär Fortnox-fakturan orderreferensen? (verifiera i Fortnox-API vid P4).

## 5. Produktionsmodul

### 5.1 Vad den läser
`MiraOrderRad` för ett givet `leveransdatum`, joinat på `kok` (rad-override ∨ `Product.default_kok`) och `prep_kategori`/artikel. Endast `orderstatus ∈ {Bekräftad, I produktion}`.

### 5.2 ⚠️ Scaling — undvik 100-cap:en (ARKITEKTUR §4)
Daglig läsning av alla ordrar × rader × sites är exakt det scenario §4 flaggar. **Query på numeriskt `leverans_ts >= dagStart AND < dagSlut`** — Bubbles numeriska constraints är pålitliga (till skillnad från string-datum, gotcha i HANDOFF §Spår 5). Aldrig `bubbleFindAll` över alla ordrar + lokal filtrering.

### 5.3 Kök-fördelningsvy
Dagsvy grupperad per `Kok`. Planeraren drar/flyttar rader mellan kök (sätter radens `kok`). Visar aggregerad last per kök (antal per prep_kategori) för balansering.

### 5.4 Dagliga exporter (återanvänder befintlig infra)
- **(a) Aggregerad prep-lista per kök** — `SUM(antal)` per artikel/`prep_kategori` för datum D, ett dokument per kök. PDF (puppeteer via `pdf_utils.js`) + Excel (`build_xlsx.py`).
- **(b) Per-order plocklistor** — rak spegling av kundordern (per order, per kök). Samma render-infra.
- Endpoints: `GET /admin/produktion/dag?date=&kok=` (data) + `POST /admin/produktion/export` (`format=pdf|xlsx`, `type=aggregat|order`).

---

## 6. Fortnox order-push (enda skrivvägen)

**Beslut #2:** Mira skickar **ordern** till Fortnox (`POST api.fortnox.se/3/orders`). Fortnox importerar den; Carotte konverterar sedan order→faktura *inne i Fortnox*. Mira genererar aldrig fakturan.

**Trigger:** manuell "Skicka till Fortnox"-knapp, eller auto vid `orderstatus=Levererad` (bekräfta med Carotte). Kräver:
- **OAuth-scope `order`** (Fortnox delar inte read/write — `order`-scopet ger full CRUD). ✅ VERIFIERAT 2026-07-29 att koden redan begär det: authorize-default = `"customer order offer invoice article"` (`index.js:1737`), overridbar via env `FORTNOX_SCOPE`. Beviljad scope persisteras på `FortnoxConnection.scope` (`:1827`), bevaras vid refresh (`:1644`). **Sanningen om levande token = `scope`-fältet på F&E-connection-raden** (`1771579463578x385222043661358460`). ⚠️ Fortnox låser scope vid auktoriseringstillfället → om connectionen auktoriserades innan `order` fanns i strängen saknar token:en det. Fix: engångs-omauktorisering via `https://api.mira-fm.com/fortnox/authorize?c=1771579463578x385222043661358460` (öppen endpoint, ingen API-nyckel). Rekommendation: om-auktorisera en gång innan Fas 5 för att eliminera risken.
- **Idempotens:** skapa aldrig dubbla Fortnox-ordrar. Nyckel `MiraOrder._id` → spara Fortnox DocumentNumber i `fortnox_faktura_ref` (byt ev. namn till `fortnox_order_docno`). Skicka aldrig igen om satt.
- **⚠️ Eko-hantering:** den pushade ordern läses TILLBAKA in via order-syncen (`/fortnox/upsert/orders` → `FortnoxOrder`). Måste taggas/länkas (t.ex. `MiraOrder.fortnox_order_docno` ↔ `FortnoxOrder.ft_document_number`) så vi inte dubbelbehandlar eller skapar en produktionsdubblett. `FortnoxOrder` förblir ren lässpegel; `MiraOrder` är sanningen.
- Radbeskrivning trunkeras medvetet till Fortnox-gränsen (kund-PDF:en är redan Mira-genererad → spelar ingen roll för kunden).

---

## 7. AI-offert (senare fas)

NL-beskrivning → Anthropic structured tool-use → offert-utkast (rader ur F&E-`Product`-katalogen + prissättning via `pricing_engine.js`). Återanvänder mönstret från avtals-importen (`index.js` `/import/parse`, streaming, tvingad tool_choice). Grounding = artikelkatalogen. Byggs efter att manuell offert + produktion är i drift.

---

## 8. Återanvändbar infra (bygg inte om)
| Behov | Finns | Fil |
|---|---|---|
| HTML-mall → PDF | `renderPreview`/`renderAndPersist`, `{{a.b.c}}`-substitution | `contract_render.js` |
| PDF-singleton + merge | puppeteer-browser-singleton, `mergePdfs`, `imageToPdfBuffer` | `pdf_utils.js` |
| Excel-generering | | `build_xlsx.py` |
| Prissättning | `evalPricing` (per_person/per_hour/fixed/tiers…) | `pricing_engine.js` |
| AI structured extraction | streaming tool-use-mönster | `index.js` `/import/parse` |
| Accept/signering | OfferApproval-motor (OTP, signers, reviewers) | `index.js` `_createApprovalRequestInternal` m.fl. |

---

## 9. Byggordning

| Fas | Innehåll | Ägare |
|---|---|---|
| **1** | ✅ **KLART + DEPLOYAT 2026-07-30.** `Kok`, `MiraOrder`, `MiraOrderRad` skapade · `Offert` utökad (30 fält) · `OffertRad` definierad (14 fält) · dubblett raderad · `StatusMiraOrder` skapad · `offer_approval_status` återanvänd på `Offert.status`. **Kvar (små):** döp MiraOrder `offertnr`→`ordernr` (number→text) + `offertdatum`→`orderdatum`; sätt `Product.default_kok` + sätt om `Product category`-värden (löpande) | Christian (Bubble) |
| **2** | ✅ **Backend KLART + VERIFIERAT MOT SKARP DATA 2026-07-30** (`offert_api.js`): products/create/patch/get/list/render-pdf/convert. Curl-testat live: create→totaler, render-pdf→snygg Fortnox-lik PDF (adress ur geo, saknas-markörer, kirurgisk dokument-städ). Kvar: UI-block (separat) + design-polish (logga) | Claude (backend klar) |
| **3** | ✅ **BYGGT + smoke-testat 2026-07-30.** `POST /admin/offert/:id/send-for-signing` (renderar PDF → skapar OfferApproval-request via `_createApprovalRequestInternal`, länkar `OfferApprovalRequest.offert`, mottagare från `Offert.recipient`/Coworker, status→Sent). `_checkAndCompleteRequest` auto-convertar offert→`MiraOrder` vid Approved (hook efter Contract-hooken, mjuk-felar). `convertOffertToOrder` exporterad från `offert_api.js`, `offertEngine` fångas i index.js. "Skicka för signering"-knapp i UI. **Bubble Christian:** `OfferApprovalRequest.offert` (ref Offert) + MiraOrder-rename `ordernr`(text)/`orderdatum`. | Claude (klar) + Christian (schema) |
| **4** | Produktionsmodul: dagsvy + kök-fördelning + export (a)+(b) | Claude + Christian |
| **5** | Fortnox order-push (`POST /3/orders`, OAuth-scope + idempotens + eko-hantering) | Claude |
| **6** | AI-offert | senare |

---

## 10. Öppna trådar / frågor

### 10.1 F&E-filter i `Product` — ✅ LÖST 2026-07-29
F&E-maträtter identifieras på **`Product.FortnoxConnection == FE_CONNECTION_ID`**.
Kanonisk konstant finns redan i koden: `FE_CONNECTION_ID = "1771579463578x385222043661358460"` (`index.js:19995`), `CONNECTION_NAMES[...] = "Food & Event"` (`index.js:10761`). Återanvänd konstanten — hårdkoda aldrig ett nytt ID. Offert-pickern (`GET /admin/offert/products`) constrainar på detta. `ar_matratt`-flaggan blir sekundär/valfri (t.ex. filtrera bort frakt/serviceartiklar inom F&E-connection).

**Bekräftat 2026-07-29:**
- `Product category` = gammalt oanvänt fält, fritt att återanvända för prep-kategori (beslut #10). Backend rör det inte.
- Artikeltitlar är **INTE konsekvent site-prefixade** → ingen auto-seed av `default_kok`. `default_kok` blir valfri + fylls på över tid; fördelningen sker i produktionsvyn (§5.3).

### 10.2 Accept/signering — ✅ LÖST 2026-07-29
Återanvänder **OfferApproval-motorn** (OTP, signers, reviewers) — beslut #8. Ingen egen accept-väg.

### 10.3 Fortnox-objekt — ✅ LÖST 2026-07-29
**Order-push:** Mira `POST /3/orders` → Fortnox → Carotte konverterar order→faktura i Fortnox (beslut #2). Se §6 (eko-hantering + scope + idempotens).

### 10.4 Offertnummer — ✅ LÖST 2026-07-29
Mira-eget: `FE-{år}-{seq}` (beslut #9). Matchar ingen Fortnox-serie.

### 10.5 Prep-kategorier (KVARSTÅR)
Kanoniska värden för `Product category` (Kallskänk/Varmkök/Bageri/Dryck…?) — bekräftas med köken innan Option Set sätts om. Enda kvarvarande innehållsberoende innan produktionsaggregering kan grupperas meningsfullt.

### 10.7 Order-push-trigger (KVARSTÅR, mindre)
Manuell "Skicka till Fortnox"-knapp eller auto vid `orderstatus=Levererad`? Bekräfta med Carottes fakturarutin.

### 10.6 Produktionsläsning i Bubble vs egen store (framtid)
`leverans_ts`-mönstret håller det i Bubble för v1. Om volymen växer: flytta till egen läsmodell (linje med "bort från Bubble"-beslut 2026-07-27, FORFRAGAN §BESLUT). Inte v1.

---

## 11. Gotchas att ärva (från HANDOFF.md — gäller alla Bubble-HTML-block)
1. **Bubble Option Set-värden case-sensitiva** — verifiera exakt stavning innan kod (gotcha 2). Gissa aldrig fältnamn/casing (Christians regel, `feedback-communication-style`).
2. **Hidden-input `value`-strip** utan `data-*` (gotcha 5) — sätt värden via JS + fallback.
3. **Namnrymda ALLA CSS-modifier-klasser** (gotcha 9) — aldrig bara `.warn`/`.ok`, använd prefix.
4. **Flera HTML-block på samma sida krockar** (gotcha 11) — scopa DOM till block-roten (BROOT), namnrymda `window`-fn/`data-*`.
5. **IIFE-wrappa script + explicit `window`-exports** (gotcha 6) — läck aldrig `$`/`$$` globalt (bryter Bubbles jQuery).
6. **`bubbleFind` default `limit:1` + sväljer fel tyst** (ARKITEKTUR Fynd C) — sätt alltid explicit limit.
7. **Numeriska constraints pålitliga, string-datum-constraints inte** (Spår 5) — därför `leverans_ts` som number.
