# Prompt — perspektivväxlaren på startsidan (Hyresgäst ⇄ Fastighetsägare)

Kopiera blocket nedan. **Fyll i `[FYLL I]`-platserna först** — särskilt award-briefen,
annars gissar sessionen om vad juryn frågar efter.

---

```
ÄMNE: Startsidan — perspektivväxlare i toppmenyn. Nuvarande sida blir "Hyresgäst",
      ny vy "Fastighetsägare" presenterar Mira Fastighet.
MÅL:  (1) växlaren finns och båda vyerna håller ihop, (2) ett internt underlag
      säljare och drift kan prata utifrån, (3) ett awardutkast i min röst.

LÄS FÖRST, I DENNA ORDNING:
1. Mira-Exchange/HANDOFF.md — HELA filen. Ordlistan är obligatorisk.
2. Mira-Exchange/handoff/GRANSSNITTSSTRATEGI.md — hela. §0 (varför ägaren är rädd),
   §1 (skyltfönster vs transaktion), §2 (två vägar in, en motor), §4 punkt 6
   (ägarvända ytor lyder under omvänd regel), §5 (haverilistan).
3. Mira-Exchange/handoff/FASTIGHETSAGARVYN.md — §0, §2, §3, §4. Det är produkten.
4. Mira-Exchange/startsida/README.md — palett, hur skärmbilder renderas och publiceras.
5. Öppna Mira-Exchange/mira-fastighet-demo.html och klicka igenom alla sex flikarna
   innan du skriver en rad copy. Skriv inte om en vy du inte har sett.

VARFÖR VÄXLAREN ÄR RÄTT FORM, INTE BARA EN MENYKNAPP
GRANSSNITTSSTRATEGI §2 heter "TVÅ VÄGAR IN, EN MOTOR". Växlaren är den meningen
byggd i HTML: två mottagare, samma plattform, samma data. Bygg den så att den syns
— det är ett argument, inte en navigationsdetalj. En besökare som växlar fram och
tillbaka ska förstå att det är samma motor, inte två produkter.

⚠️ DEN STÖRSTA RISKEN MED HELA UPPDRAGET
Diagnosen i GRANSSNITTSSTRATEGI §0 är att fastighetsägaren är rädd för att bli
bortkopplad från hyresgästrelationen — det är därför de vill äga gränssnittet.
En publik "Fastighetsägare"-vy kan därför läsas som att Carotte flyttar upp i
stacken. Exakt det övertramp som utlöser rädslan.

Framställningen måste göra det jobbet, och det avgör tonen i hela vyn:
  Detta är ERT fönster mot ERA hus, byggt av den som utför arbetet.
  Inte ännu en plattform att upphandla.
Leder vi med haverilistan (§5) är vi den som förutsåg problemen. Leder vi med
"vi har också en ägarportal" är vi en till leverantör som vill äga gränssnittet.
Om ägarvyn efter allt arbete låter som en portal — börja om med copyn.

VINKELN, OM DU BARA FÅR EN
Fastighetsägaren vet vad hyresgästen betalar, hur många kvm de har och när avtalet
löper ut. De vet ingenting om hur hyresgästen mår. Serviceaktivitet är den tidigaste
signalen som finns i ett hus — och den kan bara produceras av den som utför arbetet.
Det är inte en mjukvarufunktion. Det är en biprodukt av att vi står i huset varje dag.

TRE SAKER SOM MÅSTE MED, FÖR DE GÅR INTE ATT KOPIERA
1. Integritetsregeln är ett SÄLJARGUMENT, inte finstilt. Ägaren ser huset,
   hyresgästen äger sitt eget innehåll. En plattformsleverantör kan inte göra det
   löftet — de har ingen relation till någon av parterna. Vi har till båda. Sagt på
   ägarsidan bygger det förtroende hos ägaren OCH skyddar hyresgästlöftet i andra vyn.
2. Källtäckningsfliken. Vi skriver ut vad vi INTE vet. En tom kolumn ser annars ut
   som "inget händer" när den betyder "vi mäter inte här än".
3. Inga kronor. Aldrig. Aktivitet, kvalitet, täckning. Priser hör hemma i avtalet.

⚠️ VAD SOM INTE FÅR PÅSTÅS
De tre aktivitetsspåren (Tengella, Fortnox, Intelliplan) är INTE inkopplade, och
därmed är hyresgästpulsens trend inte byggd. Presentera den inte som något systemet
gör. Följ precedensen från AI-modulen på sidan: datera den öppet och märk exemplet
som ett exempel. Ett daterat löfte är starkare än ett vagt — och oändligt mycket
starkare än ett som visar sig vara fel i första kunddemot.

⚠️ SKÄRMBILDER — BARA FRÅN mira-fastighet-demo.html
Aldrig från det skarpa blocket. En live-vy innehåller riktiga hyresgästers driftdata,
och att illustrera ett integritetslöfte med den bryter löftet i samma bild. Demofilens
mockdata är medvetet vald: Kista Entré halkar, Tele2 har gått tyst. Rendera som
README:n beskriver — headless Chrome i 2× — och lägg bilderna i startsida/bilder/
så ladda_upp.py plockar upp dem.

TEKNIK
- Växlaren i <nav id="nav">, i .nav-r bredvid "Logga in". Segmenterad kontroll,
  inte en till textlänk — den ska läsas som ett val, inte som en meny-post.
- Client-side växling på samma sida. Ingen ny route, ingen reload, inget SEO-tapp
  på den befintliga sidan. Läget i URL:en (#fastighetsagare) så länken går att dela.
- Ankarlänkarna i menyn (#features, #showcase, #ai, #carotte, #app) hör till
  hyresgästvyn. Ägarvyn behöver egna sektioner och egna ankare — återanvänd inte
  hyresgästvyns rubriker med ny text, det blir en mall som inte passar.
- prefers-reduced-motion respekteras, width/height på bilder, loading="lazy".
- Blocket kör redan sidans palett och DM Serif Display, så bilderna sitter rätt.
- ⚠️ index-ljus.html också. Finns växlaren bara i den mörka varianten glider de isär.

RÖST
Startsidans copy är Miras röst — matcha den befintliga sidan, hitta inte på en ny ton
för ägarvyn. Award-bidraget och allt jag signerar själv: skill:christians-skrivstil.

ARBETSREGLER
- EN domän. Spårar vi ur: säg till och föreslå att spåret bryts ut.
- Påstå inget om produkten du inte sett i demofilen eller läst i handoffen.
- Skriv inte "AI-driven", "sömlös", "revolutionerande" eller "unik". Säg vad den gör.
- Jag deployar och publicerar själv. Committa inte utan att jag ber om det.
- Uppdatera startsida/README.md: vad som lades till, hur bilderna gjordes, hur
  växlaren fungerar.

TRE MOTTAGARE, TRE BEHOV — blanda inte ihop dem:
- Ägarvyn på sidan: någon som aldrig hört talas om modulen. Löftet i en mening plus
  en bild som gör det trovärdigt. Inte en funktionslista.
- Internt: säljare och drift som ska kunna prata om den utan att lova fel saker.
  Vad den gör, vad den INTE gör än, exakt var gränsen går. Max en A4.
- Award: en jury som läser hundra bidrag. Vad som är nytt och varför det var svårt.
  Att hålla isär ägarens och hyresgästens data i en produkt som säljs till båda är
  ett riktigt designproblem — den sortens sak känner en jury igen.

AWARD-BRIEF (klistra in, gissa inte):
[FYLL I: kategori, bedömningskriterier, ordgräns, format, deadline]

KLART NÄR:
- index.html + index-ljus.html har växlaren och båda vyerna håller ihop
- ägarvyn har egna sektioner och minst en skärmbild ur demofilen
- internt underlag på max en A4
- awardutkast mot de faktiska kriterierna, i mitt tonläge
- README:n uppdaterad
```

---

## Varför prompten ser ut så här

**Växlaren är strategin i HTML.** GRANSSNITTSSTRATEGI §2 heter "två vägar in, en motor".
Byggd som en segmenterad kontroll blir den ett argument i sig — samma motor, två
mottagare. Byggd som en till menylänk blir den navigation.

**Den största risken står först, inte i finstilten.** En publik ägarvy kan läsas som att
vi flyttar upp i stacken — precis den rädsla §0 säger driver ägarna att vilja äga
gränssnittet. Tonen är därför inte en smaksak, den är uppdragets svåraste del.

**Vad som inte får påstås.** Aktivitetsspåren är den mest säljbara delen och den enda
som inte är byggd. Utan en uttrycklig spärr hamnar den i copyn.

**Demofilen, inte det skarpa blocket.** Att illustrera ett integritetslöfte med en
skärmdump av riktig hyresgästdata bryter löftet i samma bild.

**Award-briefen är en ifyllnadsplats.** Kriterierna avgör vad bidraget handlar om. Utan
dem skriver sessionen om det den själv tycker är intressant, vilket sällan är samma sak.
