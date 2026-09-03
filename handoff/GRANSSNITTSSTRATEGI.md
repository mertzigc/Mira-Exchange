# Gränssnittsstrategi — en motor, många fronter

> **Strategidokument, inte en logg.** Beskriver hur Mira förhåller sig till att
> fastighetsägare vill äga det digitala gränssnittet mot hyresgästen.
> Skrivet 2026-09-02. **Styr designbeslut i alla nya hyresgästvända moduler** —
> läs §4 innan en ny kundvänd yta byggs.
>
> Formaterad version: https://claude.ai/code/artifact/2c3ad266-3282-4a03-a6ed-351054a91dc4
> Systerdokument: Attraktivitetsaffären (erbjudandet mot ägarledet) ·
> Fastighetsägarvyn (produktunderlag för ägarmodulen)

---

## 0. LÄGET

Fastighetsägaren vill äga gränssnittet mot hyresgästen — inte bara lås, nyheter
och event utan även **handel med tjänster**. Det byggs med en plattformsleverantör
(Flowpass, Spaceflow) eller i ägarens egen satsning. Plattformsleverantören tycker
det är utmärkt, för ägaren är deras kund. Varken hyresgästen eller vi tillfrågas —
trots att det är vi två som arbetar ihop varje dag.

⚠️ **Hydda** är inte en hyresgästapp utan ett buy-and-build-bolag, grundat av
**Vasakronan + blq Invest**, som köper nischat proptech-SaaS (Homemaker, Elbilio,
Parkando, **Accessy**). Vår största kund äger alltså vår tänkta integrationspartner.
En integrationsdialog med ett förvärvsbolag är också en titt under huven — vet
vilket samtal vi är i innan arkitekturen visas.

**Anledningen till att de vill äga gränssnittet är inte oklar.** Ägaren är rädd för
att bli bortkopplad: ligger den dagliga relationen hos leverantören är ägaren en
passiv hyresuppbärare vid omförhandling. Och de kan inte köpa en serviceorganisation
— bara mjukvara. En app är vad man bygger när man vill ha serviceförmåga men bara
kan upphandla gränssnitt.

---

## 1. SKILJELINJEN — SKYLTFÖNSTER MOT TRANSAKTION

| Ägaren äger | Vi äger |
|---|---|
| **Skyltfönstret** — katalog, nyheter, event, bokning, dörren, avsändarskapet och varumärket | **Transaktionen** — pris, avtalsvillkor, kapacitet, ledtid, allergener, leverans, fakturering, kvalitetsuppföljning |

Vi slåss inte om gränssnittet. Vi slåss om beställningen. Skyltfönstret är billigt
att ge bort och det är det ägaren faktiskt vill ha. Transaktionen är inte ett
gränssnittsproblem utan ett driftproblem — ingen kan bygga den som inte utför arbetet.

**Svaret till ägaren är aldrig nej.** Det är *"ja — och här är vad ni behöver av oss
för att det ska fungera"*, följt av att **vi** skriver beställningsspecen från
leveranssidan. Den som definierar vad en tjänstebeställning måste innehålla blir den
form alla plattformar anpassar sig efter, oavsett vem som äger appen.

---

## 2. TVÅ VÄGAR IN, EN MOTOR

| Fastighetstyp | Väg till hyresgästen | Vår roll |
|---|---|---|
| **Fristående** (ingen front-app) | Hyresgästen går direkt in i Mira | Leverantör + plattform |
| **Låst** (ägaren har valt plattform) | Beställningen flödar genom deras front in i Mira | Partner till ägare **och** plattformsleverantör |

Fronten varierar. Motorn gör det inte. Det gör gränssnittsvalet till ägarens fråga
i stället för vår.

Pågående dialoger med **Fabege** och **Vasakronan** — båda angelägna om oss — täcker
i praktiken de plattformar som dominerar hyresgästapp-nischen, utan att vi väljer
sida och utan att vi bygger en egen app i konkurrens med någon.

**Positionen är starkare än den ser ut:** varje sådan plattform lever på daglig
användning, och det enda innehåll som skapar daglig användning är mat och service.
Ingen öppnar en app för dörren. Man öppnar den för lunchen. Vi är deras
engagemangskälla — deras intresse sammanfaller mer med vårt än med ägarens.

---

## 3. TRE SAKER VI ALDRIG SLÄPPER

Vi kan vara flexibla på nästan allt — inklusive vems app det blir — så länge dessa
tre stannar hos oss.

| # | Vad | Teknisk motsvarighet i repot |
|---|---|---|
| 1 | **Prislogiken och avtalet** | `pricing_engine.js` — prismotorn är enda prissanning i hela produkten (TJANSTEGRID-PRIS.md). Sätter en front sitt eget pris är den regeln bruten. |
| 2 | **Den direkta kundrelationen** | `ClientCompany` + `Contract`/abonnemang. Ordrar får flöda genom deras gränssnitt; kontot, avtalet och dialogen får inte. |
| 3 | **Leverans- och kvalitetsdatan** | `Matter`, `QualityControl`, `Visit`. Underlaget för ägarvyn, och det enda vi har som ingen annan kan producera. |

---

## 4. ⚠️ VAD DET BETYDER FÖR HUR VI BYGGER

**Varje hyresgästvänd yta vi bygger måste kunna ersättas av någon annans front
utan att affärslogiken följer med.** Det är inte en framtidsfråga — det är ett
designkrav från och med nu.

1. **Affärslogik ligger aldrig i HTML-blocket.** Kommunikationsmodulens arkitektur
   (Bubble som databas, kod i repo, UX i HTML-block) är redan standard. Regeln
   skärps: UX-lagret är **utbytbart**. Allt som avgör vad som får beställas, till
   vilket pris och med vilken ledtid ligger i Render-tjänsten.
2. **Beställnings-API:et är försäkringen, inte en tillväxtsatsning.** Kan vi
   leverera in i vilken front som helst slutar varje ny plattformsupphandling hos
   en ägare vara ett hot. Utan det är vi exponerade varje gång en ägare väljer.
   Adapter-mönstret i NIR-kärnan (SYNC-KARNAN.md) är rätt form — skillnaden är att
   detta är en **inkommande** adapter.
3. **Exponera ordrar in och leveransstatus ut. Inget mer.** Aldrig prislogik,
   aldrig avtalsdata, aldrig kvalitetsdatan, aldrig kundregistret.
4. **Bygg integrationen specifik, inte generisk.** Ett rent "beställnings-API" kan
   plattformen plugga in vilken cateringleverantör som helst i nästa år.
   Integrationen ska bära vårt avtal, vår prismotor och vår kvalitetsåterkoppling
   — då är den vår, inte deras.
5. **Besökshanteringen är gränsfallet.** Besökshantering ligger direkt intill
   passage, och Hydda äger nu Accessy. Vi bygger den för att våra receptionister
   bemannar disken — det är drift, inte mjukvara. Accessy ↔ Miras besökslogg är
   det uppenbara första gemensamma projektet, och att föreslå det själva gör oss
   till partner i stället för inkräktare.

---

## 5. HAVERILISTAN — SÄGS I FÖRSTA MÖTET, SKRIFTLIGT

De här projekten går sönder på samma sätt varje gång. Säger vi det innan det händer
är vi den som förutsåg det. Säger vi det efteråt är vi den som var negativ.

- Katalogen blir inaktuell inom ett kvartal — ingen äger uppdateringen.
- Priserna blir fel — appen känner inte till varje hyresgästs avtal.
- Ordrar landar i en mejlkorg som ingen bemannar 06:30.
- Appen säger ja till något som inte går att leverera (kapacitet, ledtid, allergener).
- Ingen vet vem som tar reklamationen.
- Användningen dör efter tre månader, och ägaren skyller på leverantören.

**Varje punkt har en lösning och samtliga ligger hos oss.** Listan är därför inte
en invändning utan ett erbjudande.

---

## 6. ⏭️ NÄSTA STEG

| Steg | Vad | Status |
|---|---|---|
| 1 | **Beställningsspecen** — orderobjekt, kapacitet, ledtider, prislogik, undantag, kvalitetsåterkoppling. Kort dokument, från leveranssidan, klart innan någon annan låser sitt. | 🔴 ej påbörjad |
| 2 | **Direktdialog med plattformsleverantörerna** — inte genom ägaren. | 🔴 ej påbörjad |
| 3 | **Fråga hyresgästerna** via undersökningsmodulen hur de vill beställa. Riktig undersökning, delad öppet med ägaren — inte kampanj. | 🔴 ej påbörjad |
| 4 | **Beställnings-API** (inkommande adapter). | 🔴 ej påbörjad |

⚠️ **Tajmingen har bäst-före-datum.** Vi för samtalen medan vi är efterfrågade, inte
medan vi rullas in i något som redan är bestämt. Den skillnaden avgör om vi skriver
specen eller anpassar oss till någon annans — och fönstret är månader, inte år.
