# Besökshantering (Vasakronan)

> Domänfil för besökshanteringsmodulen. Status: **STRATEGI / EJ BYGGD** (2026-08-25).
> Väntar på Frida-möte 2026-08-26 + åtagande från Vasakronan innan bygge.
> Detta är beslutsunderlag — inga endpoints/fält är byggda ännu.

---

## 0. Kontext

Förfrågan från **Vasakronan** (vår viktigaste kund) via **Frida Svedemar, Head of
Concierge**: kan Carotte hantera **besökssystem från servicehubbarna till
hyresgästerna** i bl.a. Hötorgsskraporna + ytterligare 5–6 hus. Skala: **hundratals
hyresgästbolag, tusentals medarbetare.** Dagens lösning = receptionen **ringer** vid
besök → ohanterbart i volym. Referens Frida nämnde: **Simply** (padda där besökaren
självregistrerar, används på bl.a. Agda).

Strategisk spänning: enorm utrullnings-acceleration (hundratals hyresgäster in i
Miras datamodell) MEN fokusförlust + omarbetning av höstplanen. Slutsats: **säg ja,
men bygg i växlar och lova bara växel 1 nu.**

---

## 1. Den korrigerade modellen (kärninsikten)

**Receptionisten är app-användaren. Värden är BARA notis-mottagare.**

- **Carotte-receptionist** i servicehubben = **Mira-app-användare** (finns redan, har
  push, hela workflow-väven, betald WU). Här bor funktionen + de WU-tunga stegen.
- **Värd** (hyresgäst-anställd som tar emot besök) = **endast mottagare**. Ingen app,
  inga vyer, inga beställningsrättigheter. Får bara notisen.

**⚠️ VARFÖR (Christians uttryckliga gräns, 2026-08-25):** vi vill INTE dra in
hyresgästernas medarbetare i appen. Inga slutkunds-vyer är byggda, vi vill inte att de
lägger ärenden/beställningar hejvilt, och **varje push + Notis + email kostar WU**. Att
jaga app-installationer multiplicerar största rörliga kostnaden mot noll betalning.
→ Den tidigare "app-distributionskil"-idén är **förkastad**. Se [[reference-bubble-wu-full-sweeps]].

### Notis-trappan (i prioritet)
1. **Push** — bara Carotte-personal (finns, WU redan betald).
2. **Mail till värd** — default, ~gratis, cross-org (går genom vår mailmotor, inte
   deras mailserver → ingen integration), ingen app. Mager gren: **ett**
   `email_queue_create` per ankomst, **ingen** push, **ingen** Notis-post för värden.
3. **SMS till värd** — prissatt premium-fallback när mail-latensen inte räcker
   ("reception, jag står här nu"). Se §4.

---

## 2. Växlar (grader av ambition)

| Växel | Innehåll | Tid |
|---|---|---|
| **1 — "Ringandet digitaliserat"** ← börja här | Receptionist-vy: registrera besök (hus→hyresgäst→värd→besökare), mager notis (mail/SMS), sökbar besökslogg per hus/hyresgäst. Ingen kiosk. | ~2–3 v |
| **2 — Riktig besökshantering** (om Vasakronan committar) | Förregistrering (värd förbokar → bekräftelse-QR), **självincheckning i lobbyn** (padda, motsvarar Simply), SMS-notis, per-hyresgäst-admin, GDPR-gallring | 4–8 v |
| **3 — Plattform** | Multi-tenant, Vasakronan-brandad, passer-/access-integration, utrymningslistor, analys | 3–6 mån |

Samma kod som växer — **förutsatt att växel 1 skrivs mot rätt datamodell**, inte en
kastbar besöks-silo. Det är så utrullnings-vinsten realiseras.

---

## 3. Återbruk (vad som redan finns i Mira)

| Behov | Finns idag | Not |
|---|---|---|
| Hyresvärd → fastigheter → hyresgäster | `Hyresvärd.Hyresgäster`, `ClientCompany.Fastighet` (List), Fastighet-typ | Vasakronan = Hyresvärd, husen = Fastighet, hyresgäster = ClientCompany. Se [[project-foretagslista-kundkort]] |
| Kontor + rum per hyresgäst | `Office`/`Kontor` + `_createDefaultRooms` | — |
| Värd/mottagare | `Coworker`/`User` per ClientCompany | `Coworker.Telefon` = number (SMS), se [[reference-user-profil-skrivnycklar]] |
| Incheckningsflöde + ankomstlista | `mira-deltagarhantering.html`, `/checkin/auth\|list\|toggle`, "anländ"-toggle | ~80 % av en besöks-MVP; iPad-vänligt |
| Aggregerad receptionist-vy | `mira-drift.html` (stå-alone, sök/filter/paginering, `.dr`-namnrymd) | **exakt mönstret att klona** |
| Mail till värd | `emailer.js` + SendGrid + `email_queue_create`-workflow | Bara e-post; SMS saknas → §4 |
| Notis-fabrik (Bubble) | `notify_associated_users_*` (Step: push→Notis→email_queue på lista) | Använd BARA den magra grenen för värd (mail), inte trippeln |
| Reception säljs redan | "Besökshantering & passerkort" i receptions-erbjudandet; `Besökshantering_funktion`-fält på förfrågan | Produktnarrativet finns |

---

## 4. SMS-gateway (beslut)

- **Leverantör:** 46elks (svenskt, alfanumerisk avsändare "Carotte" out-of-the-box,
  trivial REST). Alternativ: GatewayAPI (billigare), Twilio (dyrare). Styckpris SE
  **~0,35 kr** (46elks).
- **Bygge:** ~halvdag. `sendSms({to, text})`-helper bredvid `sendViaSendGrid()` i
  `emailer.js` — `fetch` + basic auth, ingen SDK, env-vars för credentials.
  Alfanumerisk avsändare = enkelriktat (en ankomstnotis behöver inget svar).
- **⚠️ Håll SMS:et kort + emoji-fritt** → 160 tecken/segment (svenska å/ä/ö ligger i
  GSM-7-basen). Emoji tvingar 70 tecken → dubbel kostnad.
- **SMS är prissatt pass-through, inte default.** Markup ~1,00–1,50 kr/SMS mot
  Vasakronan. Fakturerad-innan-du-betalar-gatewayen → ren pass-through-risk.
- **⚠️ Kräver:** värdens mobilnr i katalogen (`Coworker.Telefon`) + dedupe/rate-limit
  (feltryckande receptionist) + GDPR-gallring (mobilnr = personuppgift).

---

## 5. WU-disciplin (rörlig kostnad)

**Designa WU-medvetet från rad ett** (samma lärdom som företagslistan —
[[reference-bubble-wu-full-sweeps]]):
- Mottagarnotis = **en** köad mail, aldrig fan-out på en User-lista.
- Ankomstloggen = **per-request-sök med constraints + paginering**, inget helsvep.
- **Ingen** Notis-post per besökare, **ingen** push till främlingar.

**Ankare:** ert baslager ≈ **~500 000 WU/mån** (härlett ur det borttagna
setInterval-svepet: ~13 000 WU/dygn = 78 % av idle-golvet).

---

## 6. Kostnadskalkyl (planering — antaganden öppna)

### Engång (bygga fas 1)
| Arbetspaket | Timmar |
|---|---|
| Bubble-schema (Besök-typ + fält, host-katalog-koppling) | 4–6 |
| Backend: create/list/sök/detalj/markera-anländ (companies_api-mönster) | 16–24 |
| Notis-gren: mail (återbruk) + SMS-helper + dedupe/rate-limit | 8–12 |
| Receptionist-block (klona `mira-drift.html`) | 20–28 |
| Host-katalog (admin per hyresgäst) | 8–12 |
| Smoke-svit (mutationstestad) | 8–12 |
| GDPR-gallringsjobb (TTL-mönster) | 3–5 |
| Deploy + pilot-härdning | 8–12 |
| **Summa** | **~75–110 h (mid ~90 h)** = ~2–3 v |

Kronsiffra (illustration, ~900 kr/dev-h): ~68–99k kr engång. Exkl. växel 2 (kiosk).

### Löpande (21 arbetsdagar/mån)
| Scenario | Besök/dag | SMS-andel | SMS-kostn./mån | WU/mån | WU-andel baslager |
|---|---|---|---|---|---|
| Konservativ | 150 | 40 % | 441 kr | ~31 500 | +6 % |
| Mid | 300 | 50 % | 1 103 kr | ~63 000 | +13 % |
| Hög | 500 | 60 % | 2 205 kr | ~157 500 | +31 % |

- **SMS** = pass-through med lätt markup, inte vinstmotorn.
- **WU** i kr är liten (~0,004 kr/WU antaget — **kalibrera mot faktisk Bubble-mätning**).
  Det viktiga: hög-scenariot lägger +31 % på baslagret → kan knuffa upp en Bubble-tier.

### Prisgolv mot Vasakronan
Amortera bygget (~90k) / 12 mån / ~8 hus ≈ **~940 kr/hus/mån** bara för bygget. +löpande
+marginal → **tjänsteavgift 2 000–4 000 kr/hus/mån täcker allt med god marginal**, SMS
faktureras separat (1–1,50 kr/st). Vid 8 hus ≈ 190–380k kr/år i tjänsteintäkt utöver SMS.

---

## 7. Öppna frågor / beslut som väntar

- **Vasakronan-åtagande** i proportion till fokusförlusten (antal hus, hyresgäster,
  tidslinje, vilka hyresgäster som tvingas in). Växel 1 = god vilja; växel 2/3 = beställning.
- **Roadmap-rebaselining:** vad pausas i höst? Kandidater att offra före kärnaffären:
  Drift Fas 2/3, Template/PDF Fas 5, Caspeco (redan Q1-27). **Rör inte** sync-kärnan/
  avtalsmotorn. Se [[project-mira-omtag]], [[project-tjanstegrid-prishjarna]].
- **Kalibrera kalkylen:** faktiska besöksvolymer/dag/hus (fråga Vasakronan), antal hus
  (antog 8), SMS-andel (antog 40–60 %), WU/besök (mät i pilot).
- **⚠️ Verifiera i Bubble innan löfte** (ej på minne — kolla skarpt):
  - `Coworker.Telefon` faktiskt satt/underhållbart per hyresgäst för SMS.
  - Bygg-vs-köp: vad kostar/kan Simply — vår edge = besök i SAMMA plattform som redan
    kör deras reception/drift/tjänster (vallgraven mot punktprodukt).

---

## 8. Nästa steg
1. Frida-möte 2026-08-26 → klargör Vasakronans faktiska scope + volymer.
2. Om grönt: ta fram one-pager (upplevelse + växlar + pris) till Vasakronan.
3. Vid beställning: bryt ut växel-1-bygget till egen session (mät WU i pilot).
