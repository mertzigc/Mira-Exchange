# Nyhetsbrev — "Nya Mira är här" (kundens nya webbvy)

Färdigt nyhetsutskick om kundvyn: tjänste-grid, översikt, planering, bokningswizard,
fakturaportal, ärenden + kvalitetskontroll, todos och medarbetarportal (beta).

**Inget behöver återskapas i Bubble-editorn.** Innehållet ligger som `content_blocks`-JSON
och skapas med ett anrop mot `/admin/invite/create`. Kommunikationsmodulen (Nyheter-fliken)
plockar sedan upp utskicket som vilket annat som helst — bygg mottagarlista och skicka där,
eller med curl längre ned.

---

## Filer

| Fil | Vad |
|---|---|
| `utskick.json` | Kampanjens metadata (rubrik, brödtext, accentfärg, CTA, taggar) |
| `blocks.json` | 30 designblock — rubriker, bilder, text, listor, avdelare. `__IMG_0N__` = platshållare |
| `bilder/*.jpg` | 6 skärmbilder, 1240 px breda, renderade ur de riktiga HTML-blocken med demo-data |
| `skapa.py` | Laddar upp bilderna, byter ut platshållarna, skapar utskicket |
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
HOST=$HOST KEY=$KEY python3 nyhetsbrev/skapa.py --dry-run
```

```bash
HOST=$HOST KEY=$KEY python3 nyhetsbrev/skapa.py
```

Env-varsen måste mappas in på raden — de är interaktiva och ej exporterade, så ett naket
`python3 skapa.py` ser dem inte.

Skriptet laddar upp de sex bilderna via `/admin/media/upload` (de hamnar i mediaarkivet),
byter ut `__IMG_0N__` mot Bubble-URL:erna och skapar en `Invitation` med `kind=news`.
Det **skickar ingenting**.

Sista raden ska säga `KLART. Utskicks-id: …`. Säger den i stället
`VARNING: content_blocks landade INTE` — då saknas fältet på `Invitation` i Bubble och
utskicket skulle gå ut som en naken textmassa. Fixa fältet först.

Behöver du ändra efter att det skapats:

```bash
HOST=$HOST KEY=$KEY python3 nyhetsbrev/skapa.py --update <utskicks-id>
```

## 3. Bygg mottagarlistan

Kolla först hur många det blir (skapar ingenting):

```bash
curl -sS -X POST "$HOST/admin/audience/preview" -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['company_count'],'företag ·',d['user_count'],'mottagare ·',d['no_email'],'utan mejl')"
```

Tomt filter = alla kontaktpersoner (`Coworker`) på alla kundföretag som har en mejladress.
Det är den bredaste målgruppen som finns — den innehåller även personer som ännu inte har
inloggning på Mira. Brevet är skrivet för det (sista stycket säger var man skaffar konto).
Vill du hellre bara ha en region eller en ägare, skicka `{"regions":["Stockholm"]}` resp.
`{"owners":["<user-id>"]}` — eller bygg urvalet i Målgrupp-fliken.

Bygg sedan listan (kör om med `offset` tills `done: true` — sidan är 100 åt gången):

```bash
curl -sS -X POST "$HOST/admin/invite/<utskicks-id>/guests/build" -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"offset":0,"limit":100}'
```

Avregistrerade (`EmailOptout`) filtreras bort automatiskt vid utskick, inte här.

## 4. Testa på dig själv innan

Lägg till din egen adress som ensam gäst på ett **kopierat** utskick (duplicera i
Nyheter-fliken), skicka den, läs mejlet i Outlook och på mobilen. Först därefter kör du
skarpt. Skickade gäster markeras `invite_sent=true` — samma utskick går inte ut två gånger
till samma adress.

## 5. Skicka

Enklast i Kommunikation → Nyheter → utskicket → skicka. Eller:

```bash
curl -sS -X POST "$HOST/admin/invite/<utskicks-id>/send" -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"offset":0,"limit":40}'
```

Kör om med `next_offset` ur svaret tills `done: true`. Raderna hamnar i `emailqueue` och
pollern skickar dem via SendGrid. Designblocken skickas **inte** per mottagare — mallen
hämtar dem en gång via `invitation_id`, och `blocks_count` är kontrakt: stämmer det inte
failar raden högljutt i stället för att skicka ut ett urholkat brev.

---

## Om du vill byta ut en bild

Skärmbilderna genereras ur blocken i demo-läge. Kort recept:

1. Lägg en wrapper-HTML som inkluderar blocket, servera mappen med `python3 -m http.server`
2. `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --virtual-time-budget=8000 --window-size=1300,700 --force-device-scale-factor=2 --screenshot=ut.png http://localhost:PORT/sida.html`
3. `sips -s format jpeg -s formatOptions 86 --resampleWidth 1240 ut.png --out nyhetsbrev/bilder/NN-namn.jpg`

Håll bredden på 1240 px — mejlets innehållsbredd är 528 px, så det ger skarpt på retina
utan att brevet blir tungt.
