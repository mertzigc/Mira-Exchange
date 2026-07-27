# mira-kalender på CRM-kundkort (pinned-läge)

> Detta är **setup-guide** för att embedda `mira-kalender.html` på ett specifikt
> kundkort i CRM-delen av Mira. Samma HTML-fil som kund-dashboarden — endast
> hidden-input-värdena skiljer sig. Ändra ALDRIG kalender-koden separat "för
> kundkortet"; alla lägen ska stödjas av samma fil.

## Vad "pinned" betyder
Kalendern har tre lägen (se toppkommentaren i `mira-kalender.html`):
- **A) Kund-dashboard** — inloggad kund ser sin egen planering
- **B) CRM-fri kundsök** — Carotte-admin söker fram valfri kund uppe till höger
- **C) CRM-pinned kundkort** — DETTA LÄGE. Carotte-admin på ett kundkort;
  kunden är redan vald via kortet, ingen sökruta behövs.

## Instruktion — embed på kundkort i Bubble

1. Öppna kundkortet (t.ex. `dashboard_crm/[ClientCompany_id]`) i Bubble-editorn.
2. Se till att sidans/gruppens **Content type = ClientCompany** OCH att kortet
   ligger inne i en Group vars *Data source* är den aktuella ClientCompany
   (`Group ClientC…` i sidebar). Detta gör att "Parent group's ClientCompany"
   pekar rätt.
3. Lägg ett HTML-element på kortet. Klistra in hela innehållet från
   `mira-kalender.html`.
4. Sätt hidden-inputs i det HTML-elementet till EXAKT dessa värden:

    | Hidden input | Värde |
    |---|---|
    | `#mira_company_id` | Parent group's ClientCompany's **unique id** |
    | `#mira_company_name` | Parent group's ClientCompany's **Name_company** |
    | `#mira_user_name` | Current User's First Name |
    | `#mira_admin_crm` | Current User's admin_crm is yes  *(räknas ut i Bubble → "yes"/"no")* |
    | `#mira_api_host` | (redan ifyllt) |
    | `#mira_planning_token` | PLANNING_ADMIN_TOKEN (annars CASPECO_ADMIN_TOKEN) |

5. **VIKTIGT:** villkora HTML-elementets synlighet på
   `Parent group's ClientCompany's unique id is not empty`. Annars renderar
   Bubble innan databinding hunnit landa → tomt company_id → kalendern går i
   demoläge/tom och det ser ut som att den tuggar.

## Så vet kalendern att den ska vara pinned
Logiken i `mira-kalender.html`:
```js
var CRM_FREE_PICK = ADMIN && !COMPANY;
```
Är `admin_crm=yes` OCH `company_id` är satt → **pinned**. Sökrutan döljs, titeln
visar kundens namn, backend anropas direkt med `company=<pinned_id>&crm=1`.
Backend behåller CRM-todo-filtret (kollar `creator_company` för Carotte-todos).

## Felsökning
- **Tuggar/laddar oändligt:** kolla att `#mira_company_id` faktiskt fylls (öppna
  konsolen på kundkortet, kör `document.getElementById('mira_company_id').value`).
  Tomt → Parent group är inte satt, se punkt 2+5 ovan.
- **Sökruta syns fortfarande:** något värde i `#mira_company_id` är trimbart
  whitespace, eller så pekar Parent group's binding fel.
- **Kalendern visar 0 händelser men fetch är OK:** kunden har helt enkelt ingen
  Activity i tidsspannet — kolla i planning-endpointen direkt med curl.

## Relaterat
- Samma mönster för wizarden: `mira-forfragan-kundkort.md`
- Huvud-handoff: `FORFRAGAN_KALENDER_HANDOFF.md`
