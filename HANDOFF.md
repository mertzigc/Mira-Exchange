# MIRA-EXCHANGE — START HÄR

> **Den här filen är en NAVIGATOR, inte en logg.** Djupet ligger i `handoff/`.
> Håll den under ~200 rader. Blir en domän tung → egen fil, inte mer text här.
> Senast omstrukturerad 2026-08-20.

---

## ⚠️ ORDLISTA — läs denna FÖRST

Flera ord betyder olika saker i olika affärsområden. Att blanda ihop dem har
kostat oss riktig tid (2026-08-20: "pass" tolkades som Tengella när Intelliplan
avsågs — och ordet fanns då på exakt ett ställe i dokumentationen).

| Ord | Betyder | Var |
|---|---|---|
| **Pass (S&P)** | Konsultpass/bemanning, Carotte Staff | **Intelliplan** — rapport-API. ⚠️ *ej byggt* |
| **Pass (HK)** | Städuppdrag med tid + utförare | **Tengella** `/v2/TimeTableEvent` → `Activity` |
| **Order (S&P)** | Uppdrag/intäkt per månad | `IntelliplanOrderMonth` |
| **Order (HK)** | Workorder | `FortnoxOrder`, `connection=TENGELLA`, **`ft_order_date`** |
| **Order (F&E)** | Fortnox-order | `FortnoxOrder`, `connection=FE`, **`ft_delivery_date`** |
| **Order (Mira)** | Miras egen offertväg | `MiraOrder` — *ej i drift, 1 testrad* |
| **Kund** | Bolag | `ClientCompany` — allt mappas hit |
| **Konto** | Intelliplans *anläggning* (ej bolag) | `IntelliplanAccount` → många-till-en mot ClientCompany |

**Tre affärsområden, tre system:**
`Service & People` = Intelliplan · `Housekeeping` = Tengella · `Food & Event` = Fortnox + Mira (+ Caspeco fr.o.m. Q1-27)

---

## 🚀 NY SESSION?
Kopiera prompten i **[SESSION-START.md](SESSION-START.md)**, fyll i ämne + mål.
Den ger maximal kontext på tre filer och stänger de tre fel som kostat oss mest.

---

## 📚 DOMÄNER

| Fil | Innehåll | Status |
|---|---|---|
| [handoff/INTELLIPLAN.md](handoff/INTELLIPLAN.md) | Rapport-API, 1058/1081, kundmappning, cron | 🟢 LIVE · 🔍 pass/schema öppet |
| [handoff/BOKNINGSLAGE.md](handoff/BOKNINGSLAGE.md) | Tre affärsområden, moms, täckning, källhälsa | 🟢 datalager klart |
| [handoff/TENGELLA-HK.md](handoff/TENGELLA-HK.md) | HK-ordrar, pass, §9-cutovern | 🟢 rättat 2026-08-20 |
| [handoff/FORETAG-KUNDKORT-DRIFT.md](handoff/FORETAG-KUNDKORT-DRIFT.md) | Företagslista, kundkort, drift | 🟢 LIVE |
| [handoff/AVTAL-SIGNERING.md](handoff/AVTAL-SIGNERING.md) | Avtalsmodulen Fas 1–5b, import/signering | 🟢 LIVE |
| [handoff/TJANSTEGRID-PRIS.md](handoff/TJANSTEGRID-PRIS.md) | Tjänste-grid, prishjärna, avtals-lifecycle | 🟢 LIVE |
| [handoff/OFFERAPPROVAL.md](handoff/OFFERAPPROVAL.md) | Offertsignering med OTP + PDF-bevis | 🟢 LIVE |
| [handoff/SYNC-KARNAN.md](handoff/SYNC-KARNAN.md) | NIR-kärnan, §4 connection-ID:n, §8 fallgropar | 🟢 LIVE |
| [handoff/BESOKSHANTERING.md](handoff/BESOKSHANTERING.md) | Vasakronan-besökssystem: bemannad + självincheckning, SMS/mail, kundens kontaktlista | 🟠 UNDER BYGGE · auth/session LIVE |
| [handoff/STAFF-MODULEN.md](handoff/STAFF-MODULEN.md) | Service & People i dashboard_crm: åtgärdslista, receptionister, besöksuppsättningar, notiser | 🟠 BYGGD + testad · **ej deployad** |
| [handoff/APP-FRIKOPPLING.md](handoff/APP-FRIKOPPLING.md) | iOS-app bort från Bubble: Capacitor-paket + push-utredning | 🟡 STRATEGI · ej byggd |

**Egna handoff-filer utanför `handoff/`:**
`OFFERT_PRODUKTION_HANDOFF.md` (F&E offert/order) · `FORFRAGAN_KALENDER_HANDOFF.md`
(kund-UI) · `mira-undersokning-handoff.md` (kommunikation) · `ARKITEKTUR_OCH_OMTAG.md` (djupdesign)

---

## 🔍 HÄLSOKOLL — kör denna först varje session

```bash
curl -sS "$HOST/version" | python3 -m json.tool
curl -sS "$HOST/admin/bokningslage/kallhalsa" -H "x-api-key: $API_KEY" | python3 -m json.tool
```

`/version` säger vilken commit som faktiskt kör — **tolka aldrig ett skarpt svar
utan att ha kollat den** (2026-08-20 drogs en slutsats ur kod som aldrig
deployats). `kallhalsa` säger vilka källor som lever, vilka som är pensionerade,
och hur många kunder som kan visa pass.

---

## ⏭️ AKTIVA SPÅR

| Spår | Nästa steg | Vem |
|---|---|---|
| **Intelliplan pass/schema** | Hitta/bygga rapportmall med tid + konsult + kund | Christian |
| Bokningslägesvyn (UI) | Datalagret klart — vyn ej byggd | — |
| Drift Fas 2/3 | Se FORETAG-KUNDKORT-DRIFT.md | — |
| Caspeco F&E | Migrering startar Q1-27 → ta bort `tackning`-luckan då | — |
| **Besökshantering (Vasakronan)** | ✅ GO. Auth/session LIVE 2026-08-26. Nästa: besöksloggen (steg B). Se BESOKSHANTERING.md §8 | Christian |
| **Staff-modulen** | ✅ BYGGD 2026-08-28 (staff_api.js + mira-staff.html + staff_smoke.mjs, 156 gröna · roll + tilldelning). **Nästa: deploy + rökkör §10 i STAFF-MODULEN.md** — två fältnamnsantaganden är ej verifierade mot skarp data | Christian |
| **App-frikoppling (iOS)** | Utred push: OneSignal vs Bubble-native → sedan Capacitor-paket. Se APP-FRIKOPPLING.md | Christian |

### ⚠️ KVAR I BUBBLE (Christian)
- ~~**`create_user_account`:** parametern `role` + "Set User_role = role"~~ — ✅ **KLART**, bekräftat av Christian 2026-08-26. Kedjan Render→Bubble är hel.
- **Besök: database trigger på User** — `receptionist_fastigheter` eller `User_role` ändras → sätt `visitor_token = ""`. Utan den släpar receptionistens scope upp till 12 h (BESOKSHANTERING.md §7.5.3c). Säkerhetsrelevant. ⚠️ **Fortfarande nödvändig** även efter Staff-modulen: dess tilldelnings-endpoint nollar tokenen, men bara för ändringar som görs DÄR — en rollsändring i Bubble-editorn fångas bara av triggern.
- **Klistra in `mira-staff.html`** i `dashboard_crm` + fyll i `planning_token` + bind `data-mira="user_company"` till `Current User's Company's unique id`. ⚠️ ALDRIG på `/visitor` — blocket bär admin-token. Utan `user_company` (och utan `CAROTTE_COMPANY_ID` i env) vägrar backend sätta receptionist-rollen, och kandidatlistan visar även kundernas inloggningar.
- **`taggade_personer`** (List of Coworker) på `activitet_crm` — Aktivitet-fliken på person-detaljvyn är tom tills fältet finns och aktiviteter taggas.
- Sätt `User_role` manuellt på Sofias befintliga User.

---

## 1. Arbetssätt & miljö (viktigt)
- **Deploy:** Christian pushar själv (`git push origin main`) → Render auto-deployar från `main`. Claudes tool-shell saknar git-credentials OCH env-vars → kan committa lokalt men inte pusha/trigga. Claude ger curl-kommandon, Christian kör dem.
- **Repo:** `/Users/christianmertzig/Documents/GitHub/Mira-Exchange` (GitHub: `mertzigc/Mira-Exchange`, branch `main`).
- **Bubble Data API base:** `https://mira-fm.com` (default i index.js). Live-frontend: `mira-fm.com`. Render-tjänst: `https://mira-exchange.onrender.com`.
- **Auth mot `/sync/v2`:** kräver BÅDE `x-api-key: $KEY` (= MIRA_RENDER_API_KEY på Render) OCH `x-sync-secret: $SYNC_SECRET`. En GLOBAL `requireApiKey`-middleware körs före route-auth.
- **Christians shell-vars** (interaktiva, ofta EJ exporterade): `KEY`, `HOST`, `SYNC_SECRET`, `BUBBLE_API_KEY`, `MIRA_RENDER_API_KEY`. Curl funkar (in-shell-expansion) men `bash script.sh` ser dem ej om de inte exporteras → mappa in på raden vid lokal scripttest.
- **Kommunikation:** svenska, direkt + pushback. Raka quotes (inte smart-quotes). Heredoc (`<<'PYEOF'`) ej `python3 -c`. **INGA `#`-kommentarsrader i klistrade shell-block** (zsh utan interactive_comments kör dem som kommando → `unknown file attribute`). Bubble är case-sensitive på fältnamn.

---

---

## 🧭 SÅ HÄR JOBBAR VI (2026-08-20→)

1. **En domän per session.** Byt inte spår mitt i — starta en ny session i stället.
2. **Claude säger till när sessionen spårar ur** och föreslår att spåret bryts ut.
3. **Mät före slutsats.** Tom data är aldrig ett svar; en inaktuell källa är
   farligare än en tom. Verifiera fältnamn mot hur koden SKRIVER raden.
4. **Mutationstesta varje ny svit** — testerna MÅSTE falla mot gammal kod.
5. **Uppdatera rätt domänfil**, inte den här. Den här filen är en karta.
