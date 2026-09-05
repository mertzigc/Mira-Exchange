# HTML-blocken — vad de är och var de sitter

> Blocken **är** produktens gränssnitt. Det finns ingen byggkedja: varje fil är
> fristående HTML + CSS + vanilla JS som klistras in i ett HTML-element på en
> Bubble-sida, eller serveras direkt från Render.
>
> Den här filen är kartan mellan filnamn och verklighet. Härledd ur
> dokumentationen i `handoff/` 2026-09-05 — **`?` betyder att dokumentationen
> inte säger det, inte att svaret saknas.** Christian fyller i dem.
>
> Djupet per modul ligger i domänfilen, inte här. Se [HANDOFF.md](HANDOFF.md).

## Så funkar ett block

- Bubble injicerar kontext via dolda element: `data-mira="api_host"`,
  `planning_token`, `user_company`, `current_user`.
  ⚠️ Bubble strippar `value` på hidden inputs **utan** `data-*`-attribut — sätt
  värdet via JS efter DOM-ready och ha en fallback i gettern.
- Varje block har en egen **CSS-namnrymd** på två–tre bokstäver så att två block
  på samma sida inte krockar. Namnrymden får inte vara ett biblioteksprefix:
  `fa` (Font Awesome), `fas`/`far`/`fab`, `md`, `btn`, `col`, `row`, `nav`, `ui`
  är upptagna. `.fa` kostade en skarp bugg 2026-09-03.
- Nya block ska claima sin rot med formkoll:
  `querySelector('[data-XX="…"]')`. Inget av de befintliga blocken gör det ännu.
- **Affärslogik ligger aldrig i blocket.** Pris, avtal, ledtid och behörighet
  avgörs i Render-tjänsten. Se `handoff/GRANSSNITTSSTRATEGI.md` §4.

---

## Skarpa block i Bubble

| Fil | Vad | Bubble-sida | Namnrymd | Status | Domänfil |
|---|---|---|---|---|---|
| `mira-foretag-lista.html` | Företagslista + kundkort + avtalsflik | Företag | `.fk` | 🟢 LIVE | FORETAG-KUNDKORT-DRIFT |
| `mira-affar-samlad.html` | Affärsvyn: lead → affär → offert → order → faktura | Affär | `.af` | 🟢 LIVE | FORETAG-KUNDKORT-DRIFT |
| `mira-abonnemang-admin.html` | Stora avtalsvyn, global tabell över alla kunder | egen sida (blocket **är** sidan) | `.aa` | 🟢 LIVE | TJANSTEGRID-PRIS |
| `mira-offert-admin.html` | Offertbyggaren, modal-API | Affär (vid sidan av affärsvyn) | `.ao` | 🟢 LIVE | OFFERT_PRODUKTION_HANDOFF |
| `mira-kommunikation-admin.html` | Kommunikationsmodulen: utskick, mallar, block | `dashboard_crm` | `.ck` | 🟢 LIVE | mira-undersokning-handoff |
| `mira-drift.html` | Driftvy stå-alone, sök/filter/paginering | Drift | `.dr` | 🟢 LIVE | FORETAG-KUNDKORT-DRIFT |
| `mira-kalender.html` | Planeringsvyn, läser `Activity` (pass, utförare, tider) | ? | `.mk` | 🟢 LIVE | INTELLIPLAN · TENGELLA-HK |
| `mira-kund-dashboard-kpi.html` | Kundens KPI-vy | kundportalen | `.mc` | 🟢 LIVE | FORETAG-KUNDKORT-DRIFT |
| `mira-kund-dashboard-tjanster.html` | Kundens tjänste-grid med paket och avtalspris | kundportalen | `.mt` | 🟢 LIVE | TJANSTEGRID-PRIS |
| `mira-min-sida.html` | Min sida (User-profil), ersätter popupen `PopupMyPage` | ? | `.ms` | 🟢 LIVE | FORETAG-KUNDKORT-DRIFT |
| `mira-motesbokning.html` | Mötestratten | startsidan i CRM | `.mb` | 🟢 LIVE | FORETAG-KUNDKORT-DRIFT |
| `mira-fastighet.html` | Mira Fastighet, ägarens vy | `fastighet` | `.mfast` (bytt från `.fa` 09-03) | 🟢 LIVE 09-03 | FASTIGHETSAGARVYN |
| `mira-forfragan-skapa.html` | Förfrågan-wizard, 4 steg | ? | `.ff` | 🟢 ? | FORFRAGAN_KALENDER_HANDOFF |
| `mira-anvandarvillkor-mira-fm.html` | Villkorstext som panel i Min sidas consent-flik | via `mira-min-sida.html` | `.ms` | 🟢 LIVE | — |

## Byggda, inte inklistrade

| Fil | Vad | Vad som återstår | Domänfil |
|---|---|---|---|
| `mira-staff.html` (`.st`) | Service & People: åtgärdslista, receptionister, tilldelning | Klistras i `dashboard_crm`, fyll i `planning_token`, bind `user_company`. ⚠️ **Aldrig på `/visitor`** — blocket bär admin-token | STAFF-MODULEN |
| `mira-visitor.html` (`.vi`) | Receptionistvyn i besökshanteringen | Auth/session är live sedan 08-26, blocket ej deployat | BESOKSHANTERING |
| `mira-personer.html` (`.pe`) | Global personlista, ersätter native tabellen | Klistras på Personer-sidan | FORETAG-KUNDKORT-DRIFT |
| `mira-produktion.html` | Produktionsvyn med order-PDF och batchexport | Ej deployat sedan 08-10 | OFFERT_PRODUKTION_HANDOFF |
| `mira-produktion-ipad.html` | Köks-iPad med kodgrind | Tänkt på `mira-fm.com/produktion` | OFFERT_PRODUKTION_HANDOFF |
| `mira-approval-archive.html` | Global admin-vy över alla signeringsprocesser | "Skapat — väntar inbäddning" | OFFERAPPROVAL |
| `mira-deltagarhantering.html` | Incheckning + ankomstlista, iPad-vänlig | Tänkt på `mira-fm.com/deltagarhantering` | BESOKSHANTERING |

## Publika sidor (hostas utanför CRM:et)

| Fil | Vad | Var |
|---|---|---|
| `invite.html` | Landningssida för inbjudan/event, RSVP | mira-fm.com |
| `mira-undersokning.html` | Landningssida för undersökning, 10 frågetyper | mira-fm.com |
| `workplace-strategy-navy__9_.html` | Kalkylator som skapar leads via `/leads/create-from-calculator` | ? ⚠️ filnamnet är en nedladdning — döp om |
| `startsida/index-live.html` | Publika startsidan (**genererad** — klistra aldrig in källfilen) | mira-fm.com |

## Serveras direkt av Render

| Fil | Route | Not |
|---|---|---|
| `prototypes/avtal-wizard.html` | `GET /prototyp/avtal-wizard` | ⚠️ **Live-route.** Arkivera inte mappen |
| `prototypes/avtal-oversikt.html` | `GET /prototyp/avtal-oversikt` | ⚠️ Samma |
| `prototypes/besok-mockup.html` · `prototypes/staff-mockup.html` | — | Mockuppar, ingen route |
| `approval-cert.template.html` | renderas av `offer_approval_doc.js` | A4-mall för signeringsbeviset, ej ett Bubble-block |

## Demo och pitch — visa aldrig det skarpa blocket

| Fil | Not |
|---|---|
| `mira-fastighet-demo.html` | Mockdata, ingen backend. ⚠️ Namnen är Vasakronans faktiska bestånd med riktiga hyresgäster — bra i ett rum, **aldrig publikt** |
| `startsida/rendera_fastighet.py` | Renderar skärmbilder med neutraliserade namn för startsidan |

## Kandidater för arkiv — ingen dokumentation refererar dem

| Fil | Storlek | Bedömning |
|---|---|---|
| `carotte_ai_original_internal_test.html` | 736 kB | Nämns inte någonstans. Sannolikt ett internt test från juni |
| `mira-faktura.html` | 24 kB | Nämns inte. Rörd senast 2026-06-11 |
| `mira-min-sida-kund.html` | 32 kB | Nämns inte. Trolig kundvariant, ersatt av `mira-min-sida.html`? |
| `mira-affar-samlad-skiss.html` | 16 kB | Skiss, ersatt av `mira-affar-samlad.html` |
| `mira-forfragan-skapa-prototyp.html` | 24 kB | Prototyp, ersatt av produktionsmodulen |
| `mira-kalender-prototyp.html` | 24 kB | Prototyp |
| `mira-bokningsoversikt.html` | 32 kB | Designreferens för kalendern, inte i drift |

⚠️ Ta inte bort något av dessa förrän Christian bekräftat. Flytta till `_arkiv/`.

## Upptagna namnrymder

Verifierade mot filerna 2026-09-05. Välj en ny som inte står här och inte är ett
biblioteksprefix:

`.aa` `.af` `.ao` `.ck` `.dr` `.ff` `.fk` `.mb` `.mc` `.mfast` `.mk` `.ms` `.mt` `.pe` `.st` `.vi`

⚠️ `mira-affar-samlad.html` bär både `.af` och `.ao` — offertblocket lever inuti
affärsvyn. Rör man `.ao` påverkas båda.

## Filer som dokumentationen refererar men som inte finns i repot

`mira-abonnemang-deal.html` · `mira-abonnemang-kund.html` · `mira-approval-create.html` ·
`mira-fastighet-skiss.html` · `mira-invite.html` · `vasakronan-calculator-v10.html`

De ligger antingen bara i Bubble, är omdöpta, eller har aldrig checkats in.
**Ett block som bara finns inklistrat i Bubble har ingen historik och ingen
backup** — det är den allvarligaste av posterna på den här sidan.
