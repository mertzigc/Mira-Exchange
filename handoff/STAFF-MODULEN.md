# Staff-modulen (dashboard_crm → Service & People)

> Domänfil. Status: **SPECAD, EJ BYGGD** (2026-08-28).
> Mockup: https://claude.ai/code/artifact/1777300d-a9f6-43eb-8c7a-8873c91fee8f
> Källa: `prototypes/staff-mockup.html`
>
> Systerspår: [BESOKSHANTERING.md](BESOKSHANTERING.md) — besöksmodulen som denna styr.

---

## 🚀 PROMPT — kopiera in vid ny session

```
ÄMNE: Staff-modulen — "Kan byggas nu"-lagret
MÅL:  Fyra vyer i dashboard_crm som går på BEFINTLIG data: åtgärdslista,
      receptionister (m. tilldelning av fastigheter), besöksuppsättningar per hus,
      och notisstatistik. Deployat + mutationstestat.

LÄS FÖRST, I DENNA ORDNING:
1. Mira-Exchange/HANDOFF.md — HELA filen. Ordlistan är obligatorisk.
2. Mira-Exchange/handoff/STAFF-MODULEN.md — DENNA fil, hela.
3. Mira-Exchange/handoff/BESOKSHANTERING.md §7.5 (auth/scope) + §7.6 (Staff-skissen).
4. Minnena: reference-bubble-button-hover-important · reference-bubble-wu-full-sweeps ·
   reference-bubble-sort-drops-empty · reference-bubble-id-truncation

KÖR HÄLSOKOLLEN innan du drar slutsatser om skarp data:
  curl -sS "$HOST/version" | python3 -m json.tool

⚠️ INGÅR INTE (bygg INTE detta):
  - Carotte Academy (kräver ny datamodell + beslut om certifiering)
  - Bemanning/Intelliplan (BLOCKERAT — källan saknar klockslag, se §4 nedan)
  - Lobbyskärmens hälsa (kräver att skärmen hör av sig — finns inte)
  - Lobbyskärmen som yta (eget spår, steg E i BESOKSHANTERING §8)

ARBETSREGLER:
- EN domän. Spårar vi ur: säg till och föreslå eget spår.
- Mät före slutsats. Verifiera fältnamn mot hur koden SKRIVER raden.
- Aldrig .catch(() => []) på en Bubble-fråga. Låt den braka.
- Mutationstesta varje ny svit — testerna MÅSTE falla mot gammal kod.
- Jag deployar själv. Ge curl-kommandon, committa inte utan att jag ber om det.
- Uppdatera handoff/STAFF-MODULEN.md när ni är klara.
```

---

## 1. Vad som ska byggas

**Ny modul `staff_api.js`** (DI-mönster som `companies_api.js`), block `mira-staff.html`.

| Vy | Innehåll | Datakälla |
|---|---|---|
| **Åtgärdslista** | Hyresgäster utan kontaktlista · värdar utan kontaktväg · receptionister utan fastighet · notiser som fallerat | `Visit`, `Coworker`, `User` |
| **Receptionister** | Lista + sessionsstatus + **tilldela fastigheter** (skriv `receptionist_fastigheter`) | `User` där `User_role = Receptionist` |
| **Besöksuppsättningar** | Per hus: anslutna hyresgäster, hur många som fyllt kontaktlista, notiser fram, andel via lobbyn | `Fastighet`, `ClientCompany`, `Coworker`, `Visit` |
| **Notisstatistik** | Andel `skickad` vs `fel`, per hus och hyresgäst, med felorsaker | `Visit.notis_status` / `notis_fel` |

**Auth:** `PLANNING_ADMIN_TOKEN` (`x-admin-token`) via `planningAuthed` — precis som
`companies_api`. ⚠️ **INTE** visitor-token. Detta är en CRM-yta för Carotte-personal.
Lägg `/admin/staff` i `openPrefixes` (index.js).

---

## 2. Verifierade fältnamn — gissa inte

**`Visit`** (skapad 2026-08-26, konstant `VISIT` i `visitor_api.js` — importera den, duplicera inte):
`fastighet`(Fastighet) · `hyresgast`(ClientCompany) · `vard`(Coworker) · `vard_namn`(text) ·
`besokare_namn`(text) · `besokare_bolag`(text) · `incheckad_at`/`utcheckad_at`(date) ·
`via`(text: reception|lobby) · `registrerad_av`(User) · `registrerad_av_namn`(text) ·
`notis_kanal`/`notis_status`/`notis_fel`(text) · `notis_at`(date)

**`User`:** `User_role`(option set, värdet `Receptionist`) · `receptionist_fastigheter`(List of Fastighet) ·
`visitor_token`(text) · `visitor_token_exp`(date) · `First Name` · `Surname` (INTE "Last Name")

**`Fastighet`:** namnet ligger i **`Titel`** — det finns INGET `Namn`-fält, och `Adress` är
ett geographic address-OBJEKT (`.address` för texten). Se [[reference-bubble-fastighet-titel]].

**Hyresgäster per fastighet:** `ClientCompany.Fastighet contains <id>`.
⚠️ **ANVÄND INTE `Fastighet.Hyresgäster`** — fältet finns i schemat men skrivs aldrig av vår
kod (`companies_api.js:285` skriver `ClientCompany.Fastighet`) → kan vara tomt/stale.

**Värdar per hyresgäst:** `Coworker` där `Kundföretag = <companyId>`.
Kontaktväg: `Telefon`(**number**) → SMS, `Email`(text) → mail. Saknas båda = kan inte nås.

---

## 3. ⚠️ MÅSTE FIXAS I SAMMA SVEP — trigger på User

**Utan denna släpar receptionistens behörighet upp till 12 timmar. Säkerhetsrelevant.**

```
Bubble database trigger:
  When User's receptionist_fastigheter changes  →  Make changes to User: visitor_token = ""
  When User's User_role changes                 →  Make changes to User: visitor_token = ""
```

**Varför:** `/visitor/context` läser fastigheterna ur **tokenens payload**, inte färskt ur
User (tokenen är sanningen om scope — annars kunde en klient påstå sig ha fler hus).
Page-load-villkoret mintar ingen ny token så länge den gamla är giltig. Skarpt fall
2026-08-28: en tillagd fastighet syntes inte trots omladdning.

Konsekvensen utan trigger: **en avaktiverad receptionist behåller sin åtkomst i 12 timmar.**

Eftersom Staff-modulen är stället där `receptionist_fastigheter` skrivs, ska
tilldelnings-endpointen dessutom **nolla `visitor_token`** direkt vid skrivning — då fungerar
det även om triggern skulle saknas. Bälte och hängslen, och detta är rätt ställe för det.

---

## 4. ⚠️ BEMANNING ÄR BLOCKERAD — bygg den inte

Intelliplan har **dagskornighet, inte klockslag**. Genomsökning av 53 rapportmallar efter
tid-på-dygnet gav **en enda träff** — och den var en timlön (INTELLIPLAN.md, rad ~285).
Allt som mäter tid är en mängd (`Hours1`), allt som daterar är en dag (`Date1`).

Vyn kan realistiskt visa *"Anna, Hötorget 3, 28 aug, 7,5 h"* — men **inte "07:00–15:30"**.
Vill vi ha pass med start/sluttid krävs en annan källa eller egen schemaläggning i Mira.
**Det är ett beslut, inte en implementationsdetalj.** Rita aldrig ett tidsschema mot en
källa som saknar tid.

---

## 5. ⚠️ "Snittid till värd" GÅR INTE ATT MÄTA

Måttet fanns i första mockupen och **togs bort 2026-08-28** — det var påhittat.

Vi registrerar `incheckad_at` och `notis_at` (när notisen skickades, oftast sekunder), men
**aldrig när värden faktiskt hämtade gästen**. "Snittid till värd" hade krävt ett nytt fält
och ett extra klick i receptionen.

**Mät i stället det som faktiskt finns:** andel notiser som gick fram, antal besök per
hus/hyresgäst, **andel via lobbyskärm vs reception** (bra hälsomätare för skärmen),
hyresgäster utan kontaktlista, värdar utan kontaktväg.

---

## 6. Designprincip: åtgärdslista, inte katalog

Modulen öppnar med **avvikelser**, inte med en lista på allt som finns.

- Varje rad har ett **verb** ("Kontakta kunden", "Tilldela hus"). En avvikelse utan
  handling är bara en notis man vänjer sig vid.
- Varje rad har en **konsekvens**: inte "3 värdar saknar kontakt" utan "14 besök gick utan
  notis; receptionisten har fått ringa varje gång".
- **Sessionsstatus visar backends egna felkoder** (`no_fastigheter_assigned`) så ingen
  behöver läsa serverloggar för att förstå varför någon inte kommer in.
- Skilj på **trasigt och inte installerat** ("Svarar inte" vs "Ingen skärm").

---

## 7. WU-disciplin

- **Ingen helsvep av `Visit`.** Filtrera per fastighet med constraints, som
  `visitor_api.js` gör. Åtgärdslistan får INTE hämta alla besök för att räkna.
- Hyresgästlistan per fastighet: **TTL-cache** (mönstret finns i `visitor_api.js`).
- `companyFullMap()` och `_users()` är redan förvärmda — använd dem, svep inte om.
- ⚠️ [[reference-bubble-wu-full-sweeps]]: ett `setInterval`-helsvep kostade en gång
  ~13 000 WU/dygn = 78 % av idle-golvet.

---

## 8. Frontend-fällor (alla brända en gång)

- **`!important` på knapparnas `:hover`** — Bubble-sidor har en global `button:hover` med
  `!important` som annars gör knappen helorange med osynlig text.
  [[reference-bubble-button-hover-important]]
- **Rendera aldrig om ett öppet formulär** vid bakgrundsladdning — det raderar det
  användaren skrivit. Uppdatera in-place (se `paintHosts()` i `mira-visitor.html`).
- **Breda tabeller** i egen `overflow-x`-container, annars klipps action-kolumnen.
- Konventioner: `.st`-namnrymd (förslag), BROOT-claim, IIFE, **ingen `?.`/`??`**,
  raka quotes.

---

## 9. Testkrav

Ny svit `staff_smoke.mjs`, DI-mockad som `visitor_api_smoke.mjs`.
**Mutationstesta** — testerna MÅSTE falla mot felaktig kod. Minst dessa:
1. Åtgärdslistan missar en hyresgäst utan kontaktlista
2. Tilldelning av fastighet nollar INTE `visitor_token`
3. Notisstatistiken räknar `fel` som `skickad`
4. Fastighetsnamn läses från `Namn` i st.f. `Titel` (den gamla `[object Object]`-buggen)
5. Hyresgäster hämtas via `Fastighet.Hyresgäster` i st.f. `ClientCompany.Fastighet`

Regression: samtliga sviter gröna innan deploy.
⚠️ `komm_blocks_smoke` kan vara röd av annan orsak (mail_theme-refaktorering) — verifiera
att det inte är ditt innan du felsöker det.
