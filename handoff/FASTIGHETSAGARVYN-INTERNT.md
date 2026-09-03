# Mira Fastighet — internt underlag för säljare och drift

> **En A4 — läs innan modulen nämns för en ägare.** Djup: [FASTIGHETSAGARVYN.md](FASTIGHETSAGARVYN.md) · position: [GRANSSNITTSSTRATEGI.md](GRANSSNITTSSTRATEGI.md) · 2026-09-03.

**Vad det är:** ägarens egen inloggning i Mira som visar allt som händer i deras
bestånd ur ett serviceperspektiv — **utan en enda krona**.

## Meningen som ska sägas först
> Det här är **ert** fönster mot **era** hus, byggt av den som utför arbetet.

⚠️ **Säg aldrig "vi har också en ägarportal".** Ägaren vill äga gränssnittet mot
hyresgästen av rädsla för att bli bortkopplad — en leverantör som "flyttar upp i
stacken" utlöser exakt den rädslan. Och vi konkurrerar inte med Flowpass/Spaceflow:
de vänder sig till hyresgästen, vyn vänder sig till ägaren.

## Vad den gör idag — fem av sex vyer på skarp data
| Vy | Innehåll | Status |
|---|---|---|
| Bestånd | En rad per hus: hyresgäster, kvm i service, öppna ärenden, medeltid till stängning, kvalitetssnitt, tjänstetäckning | 🟢 |
| Ärenden | Ägarens **egna** ytor i full detalj · hyresgästernas **bara** aggregerat per hus | 🟢 |
| Kvalitet | Snitt per hus **och per ytatyp** (toaletter, pentry, reception, korridor, mötesrum, städförråd) | 🟢 |
| Tjänstekartan | Matris hyresgäst × tjänst + vitt utrymme per tjänst | 🟢 |
| Källtäckning | Vad vyn bygger på, täckning per källa, senast uppdaterad | 🟢 |
| Hyresgästpuls | Rad per hyresgäst — **trendetiketten är inte beräknad än** | 🔴 |

## ⚠️ Vad den INTE gör än — lova inget av detta
1. **Hyresgästpulsens trend.** De tre aktivitetsspåren (Tengella, Fortnox,
   Intelliplan) är inte inkopplade. Etiketterna Växande / Stabil / Avtagande /
   Tyst finns i designen men räknas inte fram. **Säg "kopplas in vintern 2026/27"
   och visa exemplet som ett exempel.** Ett löfte som visar sig fel i första demot
   slår tillbaka.
2. **Besöksflöde.** `Visit` finns inte än — står som "Ej i drift" i Källtäckning.
   En tom kolumn betyder "vi mäter inte här än", och vi skriver ut det själva.
3. **Mat & event: 70 % täckning** tills Caspeco-migreringen Q1-27. Står i vyn.
4. **Pass per dag för Service & People.** Intelliplan ger månadsnivå.
5. **Hyresgästens egna kvalitetsbetyg.** Bara aggregat. Opt-in per kund är fas 2.

## ⚠️ Var gränsen går — integritetsregeln
**Ägaren ser HUSET. Hyresgästen äger sitt eget innehåll.**

| Ägaren ser | Ägaren ser aldrig |
|---|---|
| Volym, avvikelsegrad, kategori, medeltid till stängning, kvalitetssnitt — per hus | Rubrik, beskrivning eller person i en hyresgästs ärende |
| Sina egna ärenden i sin helhet (egna ytor: entré, hisshall, garage, lastkaj) | Enskild hyresgästs kvalitetsbetyg |
| Vilka tjänster hyresgästerna har | Belopp, priser, avtalsvärden — **inga kronor någonstans** |

Det är ett **säljargument**, inte finstilt: löftet kan bara den ge som har relation
till båda parter. Aggregerat är ett betyg ett leveransbevis; enskilt är det ett
slagträ inför nästa förhandling.

## ⚠️ Demo och skärmbilder
Visa **`mira-fastighet-demo.html`**, aldrig det skarpa blocket — en live-vy
innehåller riktiga hyresgästers driftdata. Demofilens namn är Vasakronans faktiska
bestånd med riktiga hyresgäster: bra i ett rum, aldrig publikt. Startsidans bilder
har neutraliserade namn (`startsida/rendera_fastighet.py`).

**"Vi bygger en egen hyresgästapp."** Bra — skyltfönstret är ert. Svaret är aldrig
nej: ja, och här är vad ni behöver av oss för att det ska fungera.
