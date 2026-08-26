// sms.js — utgående SMS via 46elks. Används av besöksnotisen (/visitor).
//
// EGEN FIL, inte i emailer.js: den är 85k och står under aktiv ombyggnad (mail_theme).
// SMS är dessutom en annan kanal med egen felmodell, och blir testbar isolerat här
// (sms_smoke.mjs) — samma skäl som kitchen_auth.js/visitor_auth.js ligger för sig.
//
// Leverantörsval (handoff/BESOKSHANTERING.md §4): 46elks. Svenskt bolag → personuppgifterna
// (besökarens namn) stannar i EU och personuppgiftsbiträdesavtalet blir trivialt.
// Det, inte styckpriset, är argumentet.
//
// ⚠️ SEGMENTKOSTNAD: ett GSM-7-SMS rymmer 160 tecken. Svenska å/ä/ö ligger i GSM-7-basen
// och är gratis — men EN emoji (eller andra icke-GSM-tecken) tvingar hela meddelandet till
// UCS-2 med 70 tecken/segment, vilket DUBBLAR kostnaden. Håll mallarna emoji-fria.

const GSM7 = new Set(
  ("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
   "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà").split("")
);
// Tecken som finns i GSM-7 men kostar TVÅ positioner (escape-sekvens).
const GSM7_EXT = new Set("^{}\\[~]|€".split(""));

// Hur många segment ett meddelande blir. Används för kostnadskontroll och för att
// kunna varna i loggen när en mall råkat bli dyr.
export function smsSegments(text) {
  const s = String(text == null ? "" : text);
  if (!s) return { segments: 0, encoding: "gsm7", chars: 0 };
  let units = 0, gsm = true;
  for (const ch of s) {
    if (GSM7.has(ch)) units += 1;
    else if (GSM7_EXT.has(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) {
    // UCS-2: räkna kodenheter (emoji utanför BMP tar två).
    const units16 = s.length;
    const per = units16 <= 70 ? 70 : 67;   // segmenterade UCS-2 = 67
    return { segments: Math.ceil(units16 / per), encoding: "ucs2", chars: units16 };
  }
  const per = units <= 160 ? 160 : 153;    // segmenterade GSM-7 = 153
  return { segments: Math.ceil(units / per), encoding: "gsm7", chars: units };
}

// E.164 för svenska nummer. Bubble lagrar Coworker.Telefon som NUMBER, så inledande
// nolla är redan borta (0701785977 → 701785977) — det måste hanteras, annars skickas
// SMS:et till fel land eller avvisas.
export function toE164(input, cc = "46") {
  let d = String(input == null ? "" : input).replace(/[^\d+]/g, "");
  if (!d) return null;
  if (d.startsWith("+")) return /^\+\d{8,15}$/.test(d) ? d : null;
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = cc + d.slice(1);
  else if (d.startsWith(cc)) { /* redan landskod */ }
  else if (d.length === 9) d = cc + d;      // number-fältet: 701785977 → 46701785977
  else d = cc + d;
  return /^\d{8,15}$/.test(d) ? "+" + d : null;
}

export function makeSms({ username, password, from, fetchImpl } = {}) {
  const USER = String(username || "").trim();
  const PASS = String(password || "").trim();
  // Alfanumerisk avsändare fungerar direkt i Sverige (enkelriktat — en ankomstnotis
  // behöver inget svar). Max 11 tecken, annars avvisar operatören.
  const FROM = String(from || "Carotte").trim().slice(0, 11);
  const _fetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const configured = !!(USER && PASS);

  // → { ok, id, segments, encoding, to } | { ok:false, error, status }
  // Kastar ALDRIG: en misslyckad notis får inte välta besöksregistreringen.
  async function send({ to, text }) {
    if (!configured) return { ok: false, error: "sms_not_configured", status: 503 };
    const msg = String(text == null ? "" : text).trim();
    if (!msg) return { ok: false, error: "empty_text", status: 400 };
    const e164 = toE164(to);
    if (!e164) return { ok: false, error: "invalid_number", status: 400, to: String(to || "") };
    const seg = smsSegments(msg);
    if (seg.encoding !== "gsm7") {
      // Inte ett fel — men det dubblar kostnaden, så det ska synas.
      console.warn("[sms] icke-GSM7-tecken → " + seg.segments + " segment (dubbel kostnad)");
    }
    try {
      const body = new URLSearchParams({ from: FROM, to: e164, message: msg });
      const res = await _fetch("https://api.46elks.com/a1/sms", {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(USER + ":" + PASS).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      const txt = await res.text().catch(() => "");
      if (!res.ok) return { ok: false, error: "sms_failed_" + res.status, status: res.status, detail: txt.slice(0, 300) };
      let j = null; try { j = JSON.parse(txt); } catch (_) {}
      return { ok: true, id: (j && j.id) || null, to: e164, segments: seg.segments, encoding: seg.encoding };
    } catch (e) {
      return { ok: false, error: "sms_network_error", status: 502, detail: String(e && e.message || e).slice(0, 300) };
    }
  }

  return { send, configured, from: FROM, smsSegments, toE164 };
}
