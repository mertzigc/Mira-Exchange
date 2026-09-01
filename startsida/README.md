# Startsidan — komplett omtag

`index.html` är en färdig fil som ersätter den befintliga rakt av. All copy, alla
sektioner och hela flödet är kvar. Det som ändrats är designen och systemvyerna.

## Vad som ändrats

**Paletten är affärsvyns.** `--base:#1e2235` · `--panel:#23283f` · `--card:#262b42` ·
`--input:#2e3350` · orange `#F47B30` — exakt samma tokens som `.af` i
`mira-affar-samlad.html` och kund-dashboardens block. Skärmbilderna sitter därför i
samma färgrymd som sidan runt dem i stället för att se inklistrade ut.

**Lättare.** Bakgrunden gick från nästan svart (`#080b12`) till `#1e2235`. Grain-lagret
och två av tre orbs är borta, skuggorna är halverade, kortkanterna mjukare, luften mellan
sektionerna ökad. Rubrikerna är **DM Serif Display** — samma typsnitt som produktens
egna vyer använder.

**Fem handbyggda attrapper är utbytta mot riktiga skärmbilder:**

| Plats | Blir |
|---|---|
| Hero-kortet | KPI-blocket renderat vid 700 px |
| Flik Översikt | kund-dashboardens KPI-vy |
| Flik Bokningar | tjänste-gridden med paket och avtalspris |
| Flik Lokalvård | kvalitetskontroll med betyg per yta |
| Flik Ärenden | ärendelistan med prioritet och status |

**Fyra sektioner har fått var sin egen form i stället för fyra rutnät i rad.** Copy
oförändrad, ord för ord — det är bara layouten som skiljer:

| Sektion | Var | Är nu |
|---|---|---|
| Så fungerar integrationen | två kolumner à 4 kort | **växelverkan** — 4 par på en mittsräls, digital handling till vänster, fysisk respons till höger |
| Plattformen | 6 lika kort | **register** — numrerade rader med hårfina avdelare, ingen ruta |
| Mira AI | 4 kort | **tidslinje** — lodrät rälsen med 4 noder, passar "lansering vintern 2026" |
| Carotte levererar | 5 kort + ruta med 3 steg | **lista utan ramar** + slingan ritad som en faktisk sluten loop med returpil |

Kvar orörda enligt önskemål: header, "Se det i action", iOS-sektionen och foten.

**AI-modulen är kvar och tydligt daterad.** "Lansering vintern 2026" står på tre ställen:
badgen i AI-sektionen, taggen på funktionskort 05, och under exempel-insikten som nu är
märkt "Så här kan en AI-insikt se ut" i stället för att presenteras som något systemet
redan gör.

**Småfix på vägen.** Sista CTA-knappen hade en trasig `<a>`-tagg (saknad `>`) — lagad.
Mejllänkarna är vanliga `mailto:info@carotte.se` i stället för Cloudflares
`/cdn-cgi/l/email-protection`-hashar; Cloudflare obfuskerar om dem automatiskt vid
leverans. `prefers-reduced-motion` respekteras. Bilderna har `width`/`height` så layouten
inte hoppar, och `loading="lazy"` under folden.

## Titta

```bash
open startsida/index.html
```

Flikarna i "Se det i action" är klickbara.

## Publicera

```bash
BUBBLE_API_KEY=$BUBBLE_API_KEY python3 startsida/ladda_upp.py
```

Laddar upp de fem bilderna till Bubble och skriver `startsida/index-live.html` med
CDN-URL:erna inbakade — det är den filen du klistrar in. Bilder cachas, en omkörning
skapar inga dubbletter.

## Filer

| Fil | Vad |
|---|---|
| `index.html` | hela sidan, bildsökväg `bilder/` |
| `index-live.html` | genereras av `ladda_upp.py`, CDN-URL:er — den som publiceras |
| `bilder/` | fem skärmbilder + uppladdningscache |
| `ladda_upp.py` | uppladdning + URL-byte |
| `patcha.py` | alternativ: byter bara ut vyerna i din gamla fil, rör inte designen |
| `forhandsgranska.html` | isolerad vy av bara showcase + hero-kort |

## Om bilderna

Renderade med headless Chrome i 2× ur blockens egna demo-lägen:
`mira-kund-dashboard-kpi.html`, `mira-kund-dashboard-tjanster.html` och `mira-drift.html`.
Drift-modulen saknar demo-läge, så en `fetch`-stub matar den med påhittad kunddata
("Nordvik Group AB"). Ingen verklig kunds uppgifter syns. Admin-detaljer som inte hör
hemma publikt — "← Drift"-knappen, företagssökrutan, Demo-raden — är dolda i renderingen.

## Vad jag INTE bytte

**Telefonerna i `#app`.** 190 × 380 px, och blocken är inte responsiva under ~700 px —
vid 390 px klipps innehållet i stället för att stapla. En riktig skärmbild i den storleken
blir en oläslig fläck. De abstrakta korten är omgjorda i den nya paletten i stället.
Fixa responsiviteten i blocken, så är mobilbilder en kvart.

**Bridge- och AI-sektionen.** Konceptdiagram, inte skärmbilder — de påstår inte att de
visar produkten.

---

# Ljus variant — `index-ljus.html` (experiment)

Separat fil. Den mörka `index.html` är orörd, så du kan jämföra och välja.

## Ytan — lovable-skolan

Jag mätte lovable.dev: canvas `oklch(.9699)` ≈ **varm off-white**, kort i **rent vitt**,
kanter `#D6D6D5`, **inga skuggor alls**, radier 16–32 px, rubriker 48 px. Det är inte
"vit bakgrund" — det är en ljus canvas där korten är *ljusare* än sidan. Omvänt mot mörkt
läge, och det är det som ger lättheten.

Översatt till Mira: canvas `#F4F3F1`, ytor `#FFFFFF`, kanter `#E5E2DC`, radier 16/26 px,
piller-knappar, inga skuggor utom en mycket mjuk på hero-rutan. Orange är `#DB6923`
(den djupare av de två) eftersom `#F47B30` blir för svag mot ljust. Grönt, blått och lila
är mörkade för att klara kontrast mot vitt. DM Serif Display är kvar.

## Mindre text åt gången

| Sektion | Förut | Nu |
|---|---|---|
| Hero | rubrik + brödtext + 3 chips + flytande kort | rubrik + en mening + **actionrutan** |
| Så fungerar integrationen | 8 rutor samtidigt | **fyra steg, ett i taget** — klicka Steg 1–4 |
| Plattformen | 6 block med all text synlig | **dragspel** — sex rubriker, en öppen |
| Se det i action | flikar | oförändrat (var redan rätt) |

## Actionknappen: "Räkna på vårt kontor"

Lovables hero *är* handlingen — en inputruta, inte en knapp till en annan sida. Samma grepp
här: en ruta med "Vårt kontor är [ ___ kvm]" som startar en wizard i tre steg
(yta + arbetsplatser + tidplan → tjänster + fritext → kontaktuppgifter).

Den postar till **`/leads/create-from-calculator`** — endpointen som redan driver
kalkylator-leadsen. Leadet får `lead_score`, `lead_priority`, strukturerad beskrivning och
kopplas mot ClientCompany. Alltså noll ny backend.

### ⚠️ Två saker att fixa innan den går live

1. **Ingen rate-limit på endpointen.** `/leads/create-from-calculator` saknar
   `_publicRateLimited`. På en undanskymd kalkylatorsida spelade det mindre roll — som
   primär knapp på startsidan är det en öppen dörr. En rad, samma mönster som grannarna:
   ```js
   if (_publicRateLimited(_clientIp(req), 20, undefined, "calculator_lead"))
     return res.status(429).json({ ok:false, error:"rate_limited" });
   ```
   Egen `bucket` är inte valfritt — se [[reference-publika-ratelimit-hinkar]].
2. **Endpointen skapar ClientCompany** när företagsnamnet inte matchar något befintligt.
   Skräppost blir alltså skräprader i CRM:et, inte bara skräpleads. Överväg att bara skapa
   bolaget när mejldomänen inte är gmail/hotmail/etc.

### Varför inget pris visas

Wizarden visar en **sammanfattning**, inte kronor. Det är samma beslut du redan tog för
paketkorten 2026-08-27: kronorna sätts i offert och avtal, inte i ett gränssnitt som inte
känner kundens ytor. Att visa ett pris till en anonym besökare vore ett steg tillbaka från
det. Vill du ändå ha en prisindikation går det — men då bör den räknas av
`pricing_engine.js`, inte av en kopia i sidan.

## Testa flödet

Öppna filen, klicka knappen, fyll i med **din egen adress**. Det skapar ett skarpt Lead
(och möjligen ett ClientCompany) i Bubble — så gör det en gång och städa efteråt.

## Loggan

Bubble-loggan är vit-på-transparent och syns inte mot ljus canvas. Den ljusa varianten
använder ordmärket "mira." i DM Serif Display i stället. Vill du ha bildloggan behövs en
mörk version av filen.


## Uppstädning 2026-08-31 — less is more

Bort: etiketterna ovanför varje rubrik (PLATTFORMEN, SE DET I ACTION, DET SOM GÖR MIRA
UNIKT, IOS APP, KOM IGÅNG), hero-pillret, de tre hero-chipsen, alla tagg-piller i
dragspelet, samtliga emoji-ikoner (register, tjänstelista, AI-tidslinje, loop-rubrik,
växelverkans etiketter, wizard-chipsen).

Kvar men avpillrat: statusen i växelverkan är nu en färgad punkt + versal text i stället
för en badge. "Lansering vintern 2026" står kvar på båda ställena — som ren text, inte
piller, eftersom det är information och inte dekoration.

Mer luft: sektionerna 104 → 132 px, hero 170 → 188 px topp och 96 → 128 px botten,
dragspelsraderna 24 → 28 px, tjänsteraderna 17 → 22 px, rubrikmarginal 14 → 20 px.

### Loggan

`index-ljus.html` pekar på `bilder/mira-x-carotte.png`. **Spara den bifogade loggan där**
så plockas den upp — `ladda_upp.py` hittar den automatiskt eftersom den skannar
`bilder/`-mappen efter filer som sidan refererar till.

Saknas filen faller `<img>` tillbaka på ordmärket "mira." via `onerror`, så sidan ser
aldrig trasig ut medan du väntar.


## Carotte-bilder och logga (2026-08-31)

Källfilerna ligger i repo-rotens `Bilder/`. Webbversionerna är genererade därifrån med
Pillow och sparade i `startsida/bilder/`:

| Källa | Blir | Används till |
|---|---|---|
| `Mira x Carotte blue.png` (4800 px) | `mira-x-carotte.png` 520 px | loggan i navigationen |
| samma fil, urklippt | `carotte-ordmarke.png` 300 px | Carotte-ordmärket över "Inte bara mjukvara" |
| `2023_05_17_Carotte18118.tif` (72 MB) | `foto-lokalvard.jpg` 1500 px, 140 kB | stora bilden i Plattformen |
| `Lågupplöst-32.jpg` | `foto-servering.jpg` 1100 px, 103 kB | Carotte-collaget, bakre bilden |
| `Carotte Buffe 24.01 343.jpg` | `foto-mat.jpg` 1100 px, 215 kB | Carotte-collaget, främre bilden |

Ordmärket är urklippt ur den kombinerade loggan — jag hittade ingen fristående Carotte-logga
på carotte.se (den ligger inline i sidan). Har ni originalfilen är den bättre; byt bara ut
`carotte-ordmarke.png`.

### Plattformen — nu med bild

Sektionen var en centrerad lista och blev tråkig. Nu är den tvåkolumn enligt lovables
"For building and beyond": rubrik, ingress och dragspelet till vänster, en stor bild till
höger som **sitter kvar när man bläddrar** (`position:sticky`). Bilden är en Carotte-medarbetare
i ett riktigt kontor — vilket är exakt vad rubriken påstår.

### Carotte-modulen — mer Carotte

Ordmärket över rubriken, och ett fotocollage till höger: serveringsbilden stor, matbilden
förskjuten över nedre vänstra hörnet med en canvasfärgad ram. Tjänstelistan ligger kvar i
vänsterkolumnen så båda spalterna fylls.


## Bredderna — mätt mot lovable (2026-08-31)

Sidan kändes smal jämfört med lovable. Jag mätte deras faktiska värden vid 1920 px viewport
i stället för att gissa:

| | Lovable | Mira (före) | Mira (nu) |
|---|---|---|---|
| Yttre container | **1536 px** (192 px marginal) | 1120 px | **1536 px** |
| Text : bild i tvåkolumn | **1 : 2** (448 / 896) | 1.05 : 0.95 | **1 : 2** |
| Kolumngap | 80 px | 76 px | 80 px |

Det var proportionen som saknades, inte färgerna. En bild som är dubbelt så bred som texten
läser som en produktbild; en som är lika bred läser som en illustration bredvid en spalt.

Övrigt som växte: växelverkan-kortet 960 → 1280 px, skärmbildsramen 940 → 1320 px,
AI-spalten och app-sektionen fick mer gap, sektionshöjden 132 → 140 px, hero-rubriken
upp till 82 px.

Sidmarginalen är `clamp(24px, 6vw, 96px)` och navigationen använder
`max(den marginalen, (100vw − 1536px) / 2)` så loggan alltid ligger i linje med innehållet.
Brytpunkten där kolumnerna staplar flyttades 1000 → 1180 px.

**Rubriker i smal spalt** har en egen skala (`clamp(30px, 2.35vw, 42px)`) — annars blev
42-teckens rubriker fem rader i en 485 px-spalt. De centrerade rubrikerna skalar fritt
upp till 56 px.

Fotona är omgenererade i större format nu när de visas bredare: `foto-lokalvard.jpg`
2000 px (220 kB), `foto-servering.jpg` 1700 px (198 kB), `foto-mat.jpg` 1400 px (315 kB).


## Bildtexter bort + tydligare pilar (2026-08-31)

Borttagna undertexter: hero-noten under actionrutan, "Carottes egen personal.",
"Skärmbilder ur produkten, med exempeldata.", raden under AI-citatet och
"Mat, värdskap och lokalvård – av Carottes egna team." CSS-reglerna är borttagna med.

⚠️ Raden under AI-citatet bar även **"Funktionen lanseras vintern 2026"**. Datumet står
kvar på två ställen — badgen ovanför rubriken och taggen på funktion 05 — och citatrutans
egen rubrik säger fortfarande "Så här kan en AI-insikt se ut", så exempel-ramningen är
intakt. Men det är en påminnelse värd att ha: tar ni bort något av de två återstående
ställena påstår sidan att AI:n finns idag.

**Pilarna** är ritade i stället för tecknade. `→` som glyf var tunn och blek i alla
figurer. Nu: linje + pilhuvud i SVG, 2 px stroke, orange.

| Var | Förut | Nu |
|---|---|---|
| Växelverkan | `→` 17 px | SVG 52 × 16, stroke 2 |
| Loopens steg | `→` 13 px, opacity .6 | SVG 46 × 16, stroke 2, full opacitet |
| Returbågen | stroke 1.4 px, ljusbeige | stroke 2 px orange 55 %, tydligare pilhuvud |
| Tjänstelistan | `→` 14 px i `--ink25` | 19 px i orange, glider längre vid hover |

**Carotte-loggan** ligger nu som en vit pill i nedre högra hörnet på serveringsbilden i
stället för ovanför rubriken. Den ersätter bildtexten som togs bort.


## Loggan fristående + kodstädning (2026-08-31)

**Carotte-loggan** ligger nu som ett eget element under fotogruppen, högerställt
(`.car-sign`), i stället för som en vit pill ovanpå bilden. Den överlappar inget motiv och
läser som en avsändarstämpel för hela blocket. På mobil vänsterställs den med bilderna.

**Kommentarer borttagna ur den levererade filen.** Sidan klistras in i ett HTML-element i
Bubble, så allt i källkoden är läsbart för vem som helst med "visa källa". Bort med:

- CSS-headern som beskrev att ytan är hämtad från lovable
- `/* hero-action: lovable-rutan, fast för kontorsyta */`
- kommentaren om att rubriker i smal spalt behöver egen skala
- kommentaren om att food/event saknar egna fält i lead-endpointen — den pekade ut hur
  backend är byggd
- samtliga `<!-- ═══ SEKTION ═══ -->`-markörer

Kvar är neutrala CSS-sektionsrubriker (`/* ── hero ── */` osv.) som bara namnger blocken.

Arbetsanteckningarna finns kvar här i README:n i stället, där de hör hemma.


## Engelsk version + språkväxlare (2026-09-01)

**En fil, två språk** — inte två filer. Sidan klistras in i ett HTML-element i Bubble, så
två språk hade betytt två Bubble-sidor och två filer att hålla i synk. Nu ligger båda i
`index-ljus.html` och växlas direkt i webbläsaren.

### Hur det fungerar

Varje översättbar text bär sitt engelska värde som attribut:

| Attribut | För | Exempel |
|---|---|---|
| `data-en` | ren text | `<span data-en="Service booking">Bokning av tjänster</span>` |
| `data-en-html` | element med `<em>`/`<strong>` inuti | rubrikerna |
| `data-en-placeholder` / `-alt` / `-aria-label` | attribut | fältplatshållare, bild-alt |

`setLang()` sparar den svenska originaltexten i `data-sv…` första gången den körs, så
växlingen går fram och tillbaka utan att tappa något. Verifierat: efter EN → SV är brödtext,
platshållare och `<title>` tillbaka i original.

Totalt 144 översatta strängar. Dessutom byts `<html lang>`, `<title>` och
`<meta name="description">`, och wizardens dynamiska texter (knappetiketter, sammanfattning,
felmeddelanden, tjänstenamn) via en JS-ordlista.

### Växlaren

Ett litet SV/EN-piller i navigationen, aktivt val i mörk fyllning. Ordningen är:

1. `?lang=en` eller `#lang=en` i URL:en
2. sparat val i `localStorage`
3. webbläsarens språk — allt utom svenska ger engelska
4. annars svenska

### Två saker att veta

**SEO.** Google indexerar bara den svenska versionen eftersom växlingen sker i JS. Vill ni
ranka på engelska behövs en egen URL. Vägen dit är kort: skapa en Bubble-sida `/en`, klistra
in samma block, och lägg `?lang=en` i länken — sidan startar då på engelska. Sätt `hreflang`
i Bubbles SEO-inställningar på båda.

**Leadet vet vilket språk besökaren använde.** Wizarden skickar `lead_language: "sv"|"en"`.
Fältet finns inte på Bubbles Lead-typ, men hamnar i `calculator_payload_raw` som endpointen
redan sparar — så inget behöver läggas till. Vill ni filtrera på det i CRM:et krävs ett eget
fält plus en rad i `/leads/create-from-calculator`.


## ⚠️ `index-live.html` genereras — den uppdateras inte av sig själv

Filen skapas av `ladda_upp.py`. Ändrar du `index-ljus.html` händer **ingenting** med
`index-live.html` förrän du kör skriptet igen. Klistrar du in en gammal `index-live.html`
ser du därför inga av dina senaste ändringar.

Kolla läget utan att ladda upp något:

```bash
BUBBLE_API_KEY=$BUBBLE_API_KEY python3 startsida/ladda_upp.py --kolla
```

Den skriver ut källans och `index-live.html`:s tidsstämplar och säger rakt ut om filen är
äldre än källan.

Generera om:

```bash
BUBBLE_API_KEY=$BUBBLE_API_KEY python3 startsida/ladda_upp.py
```

Skriptet tar numera **`index-ljus.html`** som standardkälla (den aktiva sidan). Vill du ha
den mörka varianten: ge `startsida/index.html` som argument.

Efter körning skriver den ut hur många tecken filen har och varnar om någon bildsökväg
fortfarande pekar lokalt.

**Regeln:** klistra alltid in `index-live.html`, aldrig `index-ljus.html` — den senare pekar
på en `bilder/`-mapp som bara finns på din dator.
