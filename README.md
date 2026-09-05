# Mira-Exchange

Backend och gränssnitt för **Mira FM** (mira-fm.com) — Carottes plattform för
integrerad facility management. Tjänsten limmar ihop sex externa system, håller
all affärslogik för tre affärsområden, och driver ett fyrtiotal vyer.

**Arkitekturen i tre meningar.** Bubble.io är datalager, inloggning och sidhållare.
All affärslogik ligger i den här Node/Express-tjänsten på Render. Gränssnitten är
fristående HTML-block som klistras in i Bubble-sidor och pratar med Render över HTTP.

Det finns alltså **ingen lokal miljö som liknar produktion** — datat och sidorna
sitter i Bubble. Verifiering sker med smoke-sviterna och med curl mot skarp miljö.

---

## Snabbstart

```bash
git clone https://github.com/mertzigc/Mira-Exchange.git
cd Mira-Exchange
npm install
cp .env.example .env          # fyll i, se nedan
npm test                      # 37 sviter, ~2500 kontroller, ~3 s
npm start                     # startar servern på PORT (default 3000)
```

`npm test` kräver varken nätverk, env-variabler eller `npm install` — sviterna
mockar Bubble. Kör den först: den svarar på om din klon är hel.

**Miljövariabler.** `.env.example` listar alla 87 som koden läser, grupperade per
integration och märkta `[KRAVS]` / `[VALFRI]`. Skarpa värden ligger i
Render → Environment. `.env` får aldrig committas.

---

## Läs i den här ordningen

| Fil | Vad |
|---|---|
| **[HANDOFF.md](HANDOFF.md)** | **Börja här.** Kartan över domänerna. Ordlistan högst upp är obligatorisk — samma ord betyder olika saker i de tre affärsområdena, och att blanda ihop dem har kostat verklig tid |
| [BLOCK-INDEX.md](BLOCK-INDEX.md) | Vilket HTML-block som sitter var i Bubble, med status och namnrymd |
| [handoff/](handoff/) | 14 domänfiler. Djupet ligger här, inte i HANDOFF.md |
| [ARKITEKTUR_OCH_OMTAG.md](ARKITEKTUR_OCH_OMTAG.md) | Djupdesign och beslutsmotivering för sync-kärnan |
| [SESSION-START.md](SESSION-START.md) | Standardprompt när arbetet görs tillsammans med Claude |

Domänfilerna är sanningen om varje modul. **Uppdatera rätt domänfil när du är
klar — inte HANDOFF.md.** Den är en karta och ska hållas under ~200 rader.

---

## Katalogstruktur

```
index.js                 monoliten: server, Bubble-helpers, Fortnox/Tengella,
                         Microsoft, Caspeco, KPI, event, kundportal, mail-jobb
*_api.js                 utbrutna moduler som registrerar egna routes
invoice_sync.js          sync-kärnan (NIR) — adaptrar, diff/write, reconcile
pricing_engine.js        enda prissanningen i produkten
*_auth.js                fyra separata HMAC-sessioner: kitchen, visitor,
                         mypage, landlord
*_smoke.mjs              37 testsviter, körs av run-smoke.mjs
mira-*.html              HTML-blocken — se BLOCK-INDEX.md
*.sh                     cron- och verktygsscript (schemat ligger i Render)
handoff/                 domändokumentationen
startsida/               publika startsidan, två perspektiv + SV/EN
prototypes/              ⚠️ serveras av live-routes /prototyp/* — rör inte
contract_templates/      avtalsmallar som JSON
nyhetsbrev/              utskicksverktyg
```

---

## Innan du drar en slutsats om skarp data

```bash
curl -sS "$HOST/version" | python3 -m json.tool
curl -sS "$HOST/admin/bokningslage/kallhalsa" -H "x-api-key: $API_KEY" | python3 -m json.tool
```

`/version` säger vilken commit som **faktiskt kör**. Repot innehåller flera spår
som är byggda och testade men inte deployade — läs aldrig ett skarpt svar utan
att ha kollat den. `kallhalsa` säger vilka källor som lever och vilka som är
pensionerade. **En inaktuell källa är farligare än en tom: den ser frisk ut.**

Auth mot `/sync/v2` kräver **både** `x-api-key` och `x-sync-secret`. En global
`requireApiKey`-middleware körs före all route-auth.

---

## Deploy

Push till `main` → Render auto-deployar. Ingen CI, ingen staging.

Christian deployar. Ett block som ändrats måste dessutom **klistras om i Bubble**
— koden i repot är inte det som kör förrän någon gjort det manuellt.

---

## Regler som inte får brytas

1. **En domän per arbetssession.** Spårar det ur: bryt ut till ett eget spår.
2. **Mät före slutsats.** Tom data är aldrig ett svar.
3. **Verifiera fältnamn mot hur koden SKRIVER raden** — aldrig mot en kommentar,
   aldrig mot minnet. Bubble är case-sensitive.
4. **Aldrig `.catch(() => [])` på en Bubble-fråga.** Låt den braka.
5. **Mutationstesta varje ny svit** — den måste falla mot gammal kod. Greppa
   strippad kod, aldrig råtext med kommentarer.
6. **Affärslogik ligger aldrig i HTML-blocket.** Se `handoff/GRANSSNITTSSTRATEGI.md` §4.
7. **Ägaren ser huset, hyresgästen äger sitt eget innehåll.** Se
   `handoff/FASTIGHETSAGARVYN.md` §4 innan något rörs i `/fastighet`.

---

## Fällor som redan kostat tid

- **`bubbleFind` har `limit:1` som default och paginerar inte.** Använd
  `bubbleFindAll`. Det finns ingen `bubbleUpdate` — allt går via `bubblePatch`.
- **Bubble har hård gräns på 100 träffar per request.**
- **Text- kontra numberfält.** `ft_total`/`ft_balance` är TEXT, `ft_net`/
  `ft_invoice_ts` är NUMBER. Tomma numberfält måste skickas som `null`, aldrig
  `""` — annars failar hela skrivningen tyst.
- **Bubble strippar `value` på hidden inputs utan `data-*`-attribut.**
- **Namnrymden i ett nytt block får inte vara ett biblioteksprefix.** `.fa`
  krockade med Font Awesome och gav en skarp bugg 2026-09-03.
- **Härledda belopp måste avrundas till 2 decimaler**, annars ger flyttalsdrift
  evig update-churn i synken.
- **Inga `#`-kommentarsrader i shell-block som klistras in i zsh.**

---

## Att göra i repot

- `package-lock.json` finns nu — committa den, annars är bygget inte reproducerbart.
- Roten innehåller 127 filer. Sviterna, blocken och shellscripten hör hemma i
  egna kataloger; flytten av `*.sh` kräver att Render-cronens sökvägar ändras
  samtidigt.
- Flera block är byggda och testade men inte inklistrade i Bubble, se
  [BLOCK-INDEX.md](BLOCK-INDEX.md).
