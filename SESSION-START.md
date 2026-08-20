# Standardprompt — kopiera in vid varje ny Mira-session

Fyll i **ämnet** och **målet**, klistra in resten som det är.

---

```
ÄMNE: <en domän — t.ex. "Intelliplan pass/schema" eller "Drift Fas 2">
MÅL:  <vad som ska vara sant när sessionen är klar>

LÄS FÖRST, I DENNA ORDNING:
1. Mira-Exchange/HANDOFF.md  — HELA filen (~100 rader). Ordlistan är obligatorisk.
2. Mira-Exchange/handoff/<DOMÄN>.md  — filen som ordlistan/kartan pekar ut för ÄMNE.
3. Minnena som den domänfilen listar under "Minne:".

KÖR SEDAN HÄLSOKOLLEN innan du drar någon slutsats om skarp data:
  curl -sS "$HOST/version" | python3 -m json.tool
  curl -sS "$HOST/admin/bokningslage/kallhalsa" -H "x-api-key: $API_KEY" | python3 -m json.tool

Rapportera kort: vilken commit som kör, vilka källor som är 🔴, och om något
i domänfilen motsägs av verkligheten. Fråga INTE om lov att läsa — bara gör det.

ARBETSREGLER (gäller hela sessionen):
- EN domän. Spårar vi ur: säg till, föreslå att spåret bryts ut till egen
  session, och fortsätt inte in i det nya ämnet utan att jag bekräftat.
- Mät före slutsats. Tom data är aldrig ett svar. En INAKTUELL källa är
  farligare än en tom — den ser frisk ut.
- Verifiera fältnamn mot hur koden SKRIVER raden. Aldrig mot vad en kommentar
  påstår, aldrig mot vad du minns.
- Aldrig .catch(() => []) på en Bubble-fråga. Låt den braka.
- Mutationstesta varje ny svit: testerna MÅSTE falla mot gammal kod. Greppa
  strippad kod, aldrig råtext med kommentarer.
- Jag deployar själv. Ge mig curl-kommandon, committa inte utan att jag ber om det.
- Uppdatera rätt fil i handoff/ när vi är klara — inte HANDOFF.md (den är en karta).
```

---

## Varför den ser ut så här

**Ordlistan först.** 2026-08-20 tolkades "pass" som Tengella när Intelliplan
avsågs. Ordet fanns då på exakt ett ställe i dokumentationen, och det pekade åt
fel håll. Ordlistan i `HANDOFF.md` finns för att göra den tolkningen omöjlig.

**Hälsokollen före slutsatser.** Samma dag drogs en slutsats ur kod som aldrig
deployats, och en annan ur en källa som varit fryst i elva veckor. `/version` och
`kallhalsa` kostar två sekunder och stänger båda felen.

**En domän per session.** Det som gick fel gick fel när sessionen redan bytt
ämne två gånger. Claude ska säga till när det händer — och föreslå ett bättre
upplägg, inte bara följa med.

## När sessionen ändå spårar ur

Claude ska säga ungefär detta, oombedd:

> ⚠️ Vi har lämnat ÄMNE (`<x>`) och är nu inne på `<y>`. Det är ett eget spår med
> egen domänfil. Förslag: jag noterar `<y>` i `handoff/<Y>.md` som nästa steg och
> vi tar det i en egen session — annars blandas kontexten och risken för
> feltolkning ökar. Vill du att jag fortsätter här ändå så gör jag det, men säg
> till uttryckligen.
