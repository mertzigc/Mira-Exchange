# App-frikoppling (iOS) — bort från Bubbles sista brygga

> Domänfil. Status: **STRATEGI / EJ BYGGD** (2026-08-25). Utredning först, se §3.
> Del av Bubble→Render-migreringen (pågår sedan våren 2026). Eget spår — INTE del
> av besöks-fas 1.

---

## 0. Mål

Ersätt Bubbles roll som **iOS-app-producent** med ett eget kodpaket. Bubbles sista
egentliga förtjänst är att den bygger och lägger appens kodpaket på App Store Connect.
Allt annat i Mira har flyttat till Render (Node/Express + handskrivna HTML/JS-block).

## 1. ⚠️ Viktig premiss (Christians korrigering 2026-08-25)

**Carotte äger redan allt runt appen själv:**
- Apple Developer-kontot (appen ligger på Carottes konto).
- TestFlight, alla avtal, App Store Connect.
- **APNs-push-nycklarna är redan knutna till Carottes konto.**

Bubble producerar i praktiken **bara det kompilerade kodpaketet**. → Hela "löpande
ops som Bubble absorberar"-bördan (Apple-konto, review, nycklar) **finns redan hos
Carotte**. Det enda som återstår att bygga är **kodpaketet + push-sänd-pipelinen**.

## 2. Rekommenderad väg: Capacitor WebView-wrapper

- **UI:t är redan webb** (`.fl`/`.dr`/`.fk`-block mot Render) → native-appen behöver
  inte byggas om, den laddar befintlig Render-webb i en WebView.
- **Capacitor** (open source, gratis): tunt native-skal + native push, deep links,
  biometrik, splash. `npx cap add ios` → Xcode-projekt med Carottes bundle-ID +
  signing-team → arkivera → ladda upp (fastlane skriptar uppladdningen).
- **Avråds:** full native/React Native-rewrite (månader, löser problem vi inte har).
- **Avråds:** PWA/iOS web-push (andra klass, opålitligt — och push är just det vi inte
  får kompromissa med).
- **Steg 0-alternativ:** behåll Bubble som app-skal tills beslut fattas — frikopplar
  beslutet från resten av migreringen. Billigt att låta den tunna appen leva kvar.

## 3. ⚠️ FÖRSTA STEGET — den enda utredningen som avgör storleken

**Hur skickas push idag — OneSignal eller Bubble-native?**
- **OneSignal under huven** (vår .p8 redan uppladdad där): near lift-and-shift. Nya
  Capacitor-appen använder OneSignals Capacitor-SDK, tokens landar i OneSignal,
  sändningen oförändrad. **~1–2 dagar.**
- **Bubbles egen native-push** (Bubble lagrar tokens + skickar med vår nyckel):
  reproducera det — token-lagring på Render/Bubble + liten sändare med befintlig .p8
  (`node-apn`). **~3–5 dagar.**

Nyckeln är redan vår → även tyngre grenen är bara några dagars kod, ingen Apple-ceremoni.

## 4. Storlek (omräknad efter §1)

| Del | Dagar |
|---|---|
| Capacitor-skal + WebView mot Render + auth/session-överföring | 2–4 |
| Native-finish (ikoner, splash, deep links, safe areas, pull-to-refresh) | 2–3 |
| Push-wiring (token i appen + sändare) | 1–5 (OneSignal vs Bubble-native) |
| fastlane build/sign/upload + första TestFlight | 1–2 |
| Enhetstest + review-inlämning | 2–3 |
| **Summa** | **~1,5–2,5 veckor** |

Det enda som tas på nytt jämfört med idag: **arkivera + ladda upp vid varje *native*-
ändring** (webb-innehåll är fortsatt live utan review, som nu). Den muskeln finns redan
(TestFlight + uppladdningar sköts av Christian).

## 5. Beslut
- **Eget spår, inte del av besöks-fas 1.** Logisk sista pjäs i Bubble→Render-resan.
- Ingen brådska: Steg 0 (behåll Bubble som skal) kostar lite → flytta när det passar.

## 6. Nästa steg
1. Utred push-mekaniken (OneSignal vs Bubble-native) — det sätter siffran.
2. Vid grönt: bryt ut Capacitor-bygget till egen session.
