# Nyhetsbrev — "Nya Mira är här" (kundens nya webbvy)

Färdigt nyhetsutskick om kundvyn: tjänste-grid, översikt, planering, bokningswizard,
fakturaportal, ärenden + kvalitetskontroll, todos och medarbetarportal (beta).

**Inget behöver återskapas i Bubble-editorn.** Innehållet ligger som `content_blocks`-JSON
och skapas med ett anrop mot `/admin/invite/create`. Kommunikationsmodulen (Nyheter-fliken)
plockar sedan upp utskicket som vilket annat som helst. `skicka.py` tar det hela vägen ut.

---

## Filer

| Fil | Vad |
|---|---|
| `utskick.json` | Kampanjens metadata (rubrik, brödtext, accentfärg, CTA, taggar) |
| `blocks.json` | 30 designblock — rubriker, bilder, text, listor, avdelare. `__IMG_0N__` = platshållare |
| `bilder/*.jpg` | 6 skärmbilder, 1240 px breda, renderade ur de riktiga HTML-blocken med demo-data |
| `skapa.py` | Laddar upp bilderna, byter ut platshållarna, skapar utskicket |
| `skicka.py` | Status, testutskick, bygg målgrupp, skicka — sköter pagineringen |
| `mottagare_users.py` | Mottagare ur `User` (de som har konto) i stället för `Coworker` |
| `forhandsgranska.mjs` | Renderar mejlet lokalt till `preview.html` |
| `preview.html` | Förhandsgranskning (bilder inbakade, öppnas utan server) |

Bilderna är genererade ur `mira-kund-dashboard-tjanster.html`, `mira-kund-dashboard-kpi.html`,
`mira-kalender.html`, `mira-forfragan-skapa.html` och `mira-faktura.html` i deras demo-läge —
alltså den riktiga produkten, med påhittad kunddata. Ingen kunds data syns.

---

## 1. Titta på det först

```bash
node nyhetsbrev/forhandsgranska.mjs && open nyhetsbrev/preview.html
```

Blockrenderingen är den riktiga (`renderBlocksEmail` ur `content_blocks.js`), så det du ser
är det som går ut. Ramen runt är en kopia av `wrapLayout` — den kan i teorin glida isär från
`emailer.js`; blocken kan inte.

Vill du ändra text: redigera `blocks.json` / `utskick.json` och kör om kommandot ovan.

## 2. Skapa utskicket

```bash
HOST=$HOST KEY=$KEY BUBBLE_API_KEY=$BUBBLE_API_KEY python3 nyhetsbrev/skapa.py --dry-run
```

```bash
HOST=$HOST KEY=$KEY BUBBLE_API_KEY=$BUBBLE_API_KEY python3 nyhetsbrev/skapa.py
```

Env-varsen måste mappas in på raden — de är interaktiva och ej exporterade, så ett naket
`python3 skapa.py` ser dem inte.

Skriptet laddar upp de sex bilderna, byter ut `__IMG_0N__` mot Bubble-URL:erna och skapar en
`Invitation` med `kind=news`. Det **skickar ingenting**.

### ⚠️ Varför bilderna INTE går via `/admin/media/upload`

`express.json()` i `index.js` (rad 48) sätter ingen `limit` → Express default är **100 kb**.
`/admin/media/upload` tar emot bilden som base64 i JSON-bodyn, så allt över ~74 kb råfil
svarar **413 Payload Too Large** långt innan endpointens egen `_MEDIA_MAX_BYTES`-koll på 6 MB
ens körs. Den kollen är i praktiken död kod idag. Arkiv-uppladdningen i
`mira-kommunikation-admin.html` funkar bara för att klienten komprimerar till 512 px först.

Skriptet går därför **direkt mot Bubbles `/fileupload`** (multipart, `BUBBLE_API_KEY`) och
skapar `MediaAsset`-raden separat — så bilderna hamnar i Arkiv-väljaren precis som vanligt.

Höjer du taket någon gång (`express.json({ limit: "8mb", type: [...] })`) fungerar
`--via-render` i stället. Det är en enradsändring men den påverkar *alla* endpoints, så den
hör hemma i en egen deploy — inte mitt i ett utskick.

Uppladdade bilder cachas i `bilder/uppladdade.json` — kör du om skriptet laddas de **inte**
upp igen (uppladdning till Bubble går inte att ångra). Byter du ut en bildfil laddas just den
upp på nytt automatiskt, eftersom cachen är nycklad på filstorlek. `--ladda-om` tvingar upp allt.

Sista raden ska säga `KLART. Utskicks-id: …`. Säger den i stället
`VARNING: content_blocks landade INTE` — då saknas fältet på `Invitation` i Bubble och
utskicket skulle gå ut som en naken textmassa. Fixa fältet först.

Behöver du ändra efter att det skapats:

```bash
HOST=$HOST KEY=$KEY BUBBLE_API_KEY=$BUBBLE_API_KEY python3 nyhetsbrev/skapa.py --update <utskicks-id>
```

## 3-5. Testa, bygg lista, skicka

`skicka.py` sköter pagineringen. Kör kommandona i den här ordningen — alla utom `test`
frågar innan de gör något.

```bash
HOST=$HOST KEY=$KEY python3 nyhetsbrev/skicka.py status <utskicks-id>
```

Visar rubrik, antal designblock (ska vara 30) och gäststatus. Säger den `0 block` — stopp,
brevet skulle gå ut tomt.

```bash
HOST=$HOST KEY=$KEY python3 nyhetsbrev/skicka.py test <utskicks-id> christian@carotte.se
```

Lägger till din adress som ensam mottagare och köar brevet dit. Pollern tömmer kön var 2:a
minut, så det ligger i inkorgen inom ~3 min. Läs det i Outlook **och** på mobilen.

### Målgrupp: `User` eller `Coworker`? — läs det här innan du bygger listan

Två helt olika storlekar, och det är lätt att ta fel:

| Väg | Bygger på | Vilka |
|---|---|---|
| `mottagare_users.py` | `User` | de som **har konto** på Mira — ca 116 st |
| `skicka.py malgrupp` / Målgrupp-fliken | `Coworker` | **alla kontaktpersoner** på alla kundföretag, oavsett konto — tusentals |

`_resolveAudience` i `index.js` läser `Coworker`, inte `User`. Vill du nå "samtliga users
på Mira" är det alltså **inte** Målgrupp-vägen.

Räkna först (läser bara, ändrar ingenting):

```bash
python3 nyhetsbrev/mottagare_users.py rakna
```

Stämmer siffran mot de 116 du väntar dig — importera dem:

```bash
python3 nyhetsbrev/mottagare_users.py importera <utskicks-id>
```

Vill du i stället ha den breda `Coworker`-listan, kör `skicka.py malgrupp <id>` — den visar
antalet och frågar innan den bygger något.

```bash
HOST=$HOST KEY=$KEY python3 nyhetsbrev/skicka.py skicka <utskicks-id>
```

Köar brevet till alla som inte redan fått det. Avregistrerade (`EmailOptout`) filtreras bort.
Pollern skickar ~20 mejl varannan minut, alltså ~600/timme — ett stort utskick tar sin tid,
men du behöver inte sitta kvar.

Fastnade rader hittar du i Bubble: sök `emailqueue` på `email_sent = false AND error_message
is not empty`.

---

## Om något strular

**`401 Unauthorized (bad x-api-key)`** — `x-api-key` jämförs mot `MIRA_RENDER_API_KEY` på
Render, och ditt `$KEY` matchar inte. Kör med `KEY=$MIRA_RENDER_API_KEY` i stället. Gäller
båda skripten.

**`413 Payload Too Large` på `/admin/media/upload`** — se avsnittet om `express.json` ovan.
Standardvägen (direkt mot Bubble) drabbas inte.

**`ingen MediaAsset-rad: HTTP Error 404`** — typen `MediaAsset` är inte exponerad i Bubbles
Data API. Bilderna ligger uppe och fungerar i mejlet; de syns bara inte i Arkiv-väljaren.
Samma sak händer tyst i `/admin/media/upload` (`catch (_) {}` sväljer felet), så mediaarkivet
har troligen aldrig fyllts på. Exponera typen i Bubble om du vill ha den funktionen.

---

## Om du vill byta ut en bild

Skärmbilderna genereras ur blocken i demo-läge. Kort recept:

1. Lägg en wrapper-HTML som inkluderar blocket, servera mappen med `python3 -m http.server`
2. `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --virtual-time-budget=8000 --window-size=1300,700 --force-device-scale-factor=2 --screenshot=ut.png http://localhost:PORT/sida.html`
3. `sips -s format jpeg -s formatOptions 86 --resampleWidth 1240 ut.png --out nyhetsbrev/bilder/NN-namn.jpg`

Håll bredden på 1240 px — mejlets innehållsbredd är 528 px, så det ger skarpt på retina
utan att brevet blir tungt.
