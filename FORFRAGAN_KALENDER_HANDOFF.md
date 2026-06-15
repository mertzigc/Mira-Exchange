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

## Öppna frågor / ej beslutat
- Exakt stegindelning kan justeras efter Christians detaljfeedback.
- Hur Tengella-scheman ska kopplas till en enskild kund (skift är resurs/kontor-baserade, inte kund-baserade) – behöver tänkas igenom för kund-läget.
