# mira-forfragan-skapa (wizard) på CRM-kundkort (pinned-läge)

> Detta är **setup-guide** för att embedda `mira-forfragan-skapa.html` på ett
> specifikt kundkort i CRM-delen av Mira. Samma HTML-fil som kund-portalen —
> endast hidden-input-värdena skiljer sig. Ändra ALDRIG wizard-koden separat
> "för kundkortet"; alla lägen ska stödjas av samma fil.

## Vad "pinned" betyder
Wizarden har tre lägen (se toppkommentaren i `mira-forfragan-skapa.html`):
- **A) Kund-portal** — inloggad kund skapar egen förfrågan
- **B) CRM-fri kundsök** — Carotte-admin väljer kund via sökruta innan bokning
- **C) CRM-pinned kundkort** — DETTA LÄGE. Carotte-admin på ett kundkort;
  bokningen skapas åt kortets kund direkt, ingen sökruta.

## Instruktion — embed på kundkort i Bubble

1. Öppna kundkortet (t.ex. `dashboard_crm/[ClientCompany_id]`) i Bubble-editorn.
2. Se till att kortet ligger inne i en Group vars *Data source* är den aktuella
   ClientCompany (`Group ClientC…` i sidebar). Det gör att "Parent group's
   ClientCompany" pekar rätt.
3. Wizarden triggas oftast från en knapp ("Skapa bokning åt kund") som öppnar
   en popup — HTML-elementet med wizarden ligger i popupen. Se till att
   popupens *Content type = ClientCompany* och att den öppnas med kunden som
   data source, ELLER lägg HTML-elementet inuti en Group på popupen som ärver
   Parent group's ClientCompany.
4. Sätt hidden-inputs i wizard-HTML-elementet till EXAKT dessa värden:

    | Hidden input | Värde |
    |---|---|
    | `#mira_company_id` | Parent group's ClientCompany's **unique id** |
    | `#mira_company_name` | Parent group's ClientCompany's **Name_company** |
    | `#mira_admin_crm` | Current User's admin_crm is yes  *(räknas ut i Bubble → "yes"/"no")* |
    | `#mira_api_host` | (redan ifyllt) |
    | `#mira_planning_token` | PLANNING_ADMIN_TOKEN (annars CASPECO_ADMIN_TOKEN) |

5. **VIKTIGT:** villkora HTML-elementets synlighet på
   `Parent group's ClientCompany's unique id is not empty`. Annars renderar
   Bubble innan databinding hunnit landa → tomt company_id → wizarden går i
   DEMO-läge (skriver inget) och du får ingen bokning även fast du "sparar".

## Så vet wizarden att den ska vara pinned
Logiken i `mira-forfragan-skapa.html`:
```js
// CRM-pinned = ADMIN + COMPANY samtidigt → ingen sökruta, ingen kundlista
if(ADMIN && !COMPANY){ document.getElementById('ffCSearch').classList.add('on'); loadCompanies(); }
```
Är `admin_crm=yes` OCH `company_id` är satt → **pinned**. Sökrutan syns inte.
Bootstrap/offers/users laddas för kortets kund direkt. Bokningen skapas mot
den kunden när admin klickar "Skicka förfrågan".

## Bra att veta i pinned-läge
- **Beställare-sök** listar kundens Coworkers (deras `Email` + `Förnamn`/`Efternamn`).
  Det är kortets kund, alltså rätt.
- **Leverantören** bestäms som vanligt av kategori (Food & Event → Food-bolaget osv).
- **Notify (commission_new-mailet)** går till kortets kunds users
  (`Associated_company contains` kundens ClientCompany-id). Din Carotte-user får
  alltså inte mailet automatiskt — det är kundens interna notifiering.

## Felsökning
- **Wizarden visar "demo · mock-data":** `#mira_company_id` är tomt → Parent
  group är inte satt eller villkoret på punkt 5 är inte lagt.
- **"Skapa åt kund – sök företag…" syns fortfarande:** både ADMIN och COMPANY
  krävs för pinned. Kolla att båda inputs har värden i konsolen.
- **Bokningen skapades men mot fel kund:** kontrollera att Parent group
  faktiskt är rätt ClientCompany, inte ett grupp längre upp i trädet.

## Relaterat
- Samma mönster för kalendern: `mira-kalender-kundkort.md`
- Huvud-handoff: `FORFRAGAN_KALENDER_HANDOFF.md`
