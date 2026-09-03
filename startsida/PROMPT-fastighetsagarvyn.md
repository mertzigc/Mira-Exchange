# Prompt — Mira Fastighet på startsidan + presentationsmaterial

Kopiera blocket nedan. **Fyll i de tre `[FYLL I]`-platserna först** — särskilt
award-briefen, annars gissar sessionen om vad juryn faktiskt frågar efter.

---

```
ÄMNE: Mira Fastighet (fastighetsägarvyn) — presentation på startsidan + material
      internt och inför [FYLL I: award-namn]
MÅL:  (1) modulen finns på startsidan i samma form som övriga systemvyer,
      (2) ett internt underlag som säljare och drift kan prata utifrån,
      (3) ett utkast till award-bidrag som jag kan skriva om i min egen röst.

LÄS FÖRST, I DENNA ORDNING:
1. Mira-Exchange/HANDOFF.md — HELA filen. Ordlistan är obligatorisk.
2. Mira-Exchange/handoff/FASTIGHETSAGARVYN.md — hela. §0 (varför modulen finns),
   §2 (löftet), §3 (de sex vyerna), §4 (integritetsregeln) är kärnan i all copy.
3. Mira-Exchange/handoff/GRANSSNITTSSTRATEGI.md §3 — de tre sakerna vi aldrig
   släpper. Punkt 3 är hela argumentet för den här modulen.
4. Mira-Exchange/startsida/README.md — hur sidan är byggd, vilken palett den kör,
   hur skärmbilderna renderas och publiceras.
5. Öppna Mira-Exchange/mira-fastighet-demo.html i webbläsaren och klicka igenom
   alla sex flikarna innan du skriver en rad copy. Skriv inte om en vy du inte sett.

TRE MOTTAGARE, TRE BEHOV. Att blanda ihop dem är hela risken:
- Startsidan: någon som aldrig hört talas om modulen. Behöver löftet i en mening
  och en bild som gör det trovärdigt. Inte en funktionslista.
- Internt: säljare och drift som ska kunna prata om den utan att lova fel saker.
  Behöver vad den gör, vad den INTE gör än, och exakt var gränsen går.
- Award: en jury som läser hundra bidrag. Behöver vad som är nytt och varför det
  är svårt — inte vad som är fint.

VINKELN, OM DU BARA FÅR EN:
Fastighetsägaren vet vad hyresgästen betalar, hur många kvm de har och när avtalet
löper ut. De vet ingenting om hur hyresgästen mår. Serviceaktivitet är den tidigaste
signalen som finns i ett hus — och den kan bara produceras av den som utför arbetet.
Det är inte en mjukvarufunktion. Det är en biprodukt av att vi står i huset varje dag.

TRE SAKER SOM MÅSTE MED, FÖR DE ÄR DET SOM INTE GÅR ATT KOPIERA:
1. Integritetsregeln är ett SÄLJARGUMENT, inte finstilt. Ägaren ser huset,
   hyresgästen äger sitt eget innehåll. En plattformsleverantör kan inte göra det
   löftet — de har ingen relation till någon av parterna. Vi har till båda.
2. Källtäckningsfliken. Vi skriver ut vad vi INTE vet. En tom kolumn ser annars ut
   som "inget händer" när den betyder "vi mäter inte här än".
3. Inga kronor. Aldrig. Aktivitet, kvalitet, täckning. Priser hör hemma i avtalet.

⚠️ VAD SOM INTE FÅR PÅSTÅS
De tre aktivitetsspåren (Tengella, Fortnox, Intelliplan) är INTE inkopplade. Därmed
är hyresgästpulsens trend inte byggd. Presentera den inte som något systemet gör.
Följ precedensen från AI-modulen på startsidan: datera den öppet ("lansering ...")
och märk exemplet som ett exempel. Ett daterat löfte är starkare än ett vagt — och
oändligt mycket starkare än ett som visar sig vara fel i första kunddemot.

⚠️ SKÄRMBILDER — BARA FRÅN mira-fastighet-demo.html
Aldrig från det skarpa blocket. En live-vy innehåller riktiga hyresgästers driftdata,
och att visa den i en pitch bryter exakt det löfte modulen säljs på. Demofilens
mockdata är dessutom medvetet vald: Kista Entré är huset som halkar, Tele2 är
hyresgästen som gått tyst. Rendera som README:n beskriver — headless Chrome i 2× —
och lägg bilderna i startsida/bilder/ så ladda_upp.py plockar upp dem.

DESIGN
Blocket kör redan startsidans palett och DM Serif Display, så skärmbilderna sitter i
samma färgrymd som sidan. Lägg modulen som en ny flik i "Se det i action" om den
passar där — annars föreslå en egen sektion och motivera varför. Kolla index-ljus.html
också: finns modulen bara i den mörka varianten glider de isär.

RÖST
Startsidans copy är Miras röst — matcha den befintliga sidan, hitta inte på en ny ton.
Award-bidraget och allt jag signerar själv: använd skill:christians-skrivstil.

ARBETSREGLER
- EN domän. Spårar vi ur: säg till och föreslå att spåret bryts ut.
- Påstå inget om produkten du inte sett i demofilen eller läst i handoffen.
- Skriv inte "AI-driven", "sömlös", "revolutionerande" eller "unik". Säg vad den gör.
- Jag deployar och publicerar själv. Committa inte utan att jag ber om det.
- Uppdatera startsida/README.md med vad som lades till och hur bilderna gjordes.

AWARD-BRIEF (klistra in, gissa inte):
[FYLL I: kategori, bedömningskriterier, ordgräns, format, deadline]

KLART NÄR:
- startsida/index.html + index-ljus.html visar modulen, med skärmbild(er) ur demofilen
- ett internt underlag på max en A4: vad den gör, vad den inte gör än, vad vi får lova
- ett award-utkast mot de faktiska kriterierna, i mitt tonläge
- README:n uppdaterad
```

---

## Varför prompten ser ut så här

**Tre mottagare, inte en.** Startsidecopy, internt säljunderlag och ett awardbidrag
har olika uppgifter. En text som ska göra alla tre gör ingen av dem.

**Vinkeln är låst i förväg.** Utan den skriver vem som helst en funktionslista.
Argumentet är inte att vyn finns — det är att underlaget bara kan produceras av den
som utför arbetet. Det står i GRANSSNITTSSTRATEGI §3 punkt 3 och är samma mening som
gör modulen strategisk.

**Vad som inte får påstås står med.** Aktivitetsspåren är den mest säljbara delen och
den enda som inte är byggd. Utan en uttrycklig spärr hamnar den i copyn.

**Demofilen, inte det skarpa blocket.** Att illustrera ett integritetslöfte med en
skärmdump av riktig hyresgästdata är det enda sättet att förlora affären på förhand.

**Award-briefen är en ifyllnadsplats.** Kriterierna avgör vad bidraget ska handla om.
Utan dem skriver sessionen om det den tycker är intressant, vilket sällan är samma sak.
