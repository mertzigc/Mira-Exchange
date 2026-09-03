// landlord_auth.js — fastighetsägarens session för /fastighet (Mira Fastighet).
//
// Speglar visitor_auth.js. Samma grundregel, samma skäl:
//   PLANNING_ADMIN_TOKEN får ALDRIG ligga i ett kundvänt HTML-block. guard() i
//   companies_api.js är EN token för HELA modulen — läcker den ligger alla 5 499
//   företag, kundkort och all personal öppna. Ägarens block får bara se en
//   kortlivad token scopad till hens eget bestånd.
//
// TVÅ skillnader mot visitor:
//   1. Payloaden bär även `hv` (Hyresvärd-id). Ägarvyn behöver veta VEM ägaren är,
//      inte bara vilka hus hen ser — `Hyresvärd.Hyresgäster` och ägarens egna
//      ärenden hänger på det id:t.
//   2. TTL 8h (en arbetsdag) i stället för 12h (ett receptionspass).
//
// ⚠️ Fastighetslistan expanderas SERVER-SIDE i /landlord/session och skrivs in
//    explicit i tokenen. Det bevarar visitor-regeln **tom lista = INGEN åtkomst,
//    aldrig "alla"** — mutationstestad där, ska inte omtolkas här.
//
// ⚠️ Koppla ALDRIG in authed() i planningAuthed. Scope-isoleringen sker vid
//    DI-injektionen (samma princip som _visitorAuth/_mypageAuth i index.js).
//
// Testbar isolerat: landlord_auth_smoke.mjs
import crypto from "node:crypto";

export function makeLandlordAuth({ secret, sessionSecret, ttlMs } = {}) {
  const TTL = ttlMs || 8 * 60 * 60 * 1000;                   // 8h — en arbetsdag
  const SECRET = secret || "mira-landlord-fallback";
  const SESSION_SECRET = String(sessionSecret || "").trim();  // Bubble-wf → Render

  function sign(b64) { return crypto.createHmac("sha256", SECRET).update(b64).digest("base64url"); }

  // payload: { scope:"landlord", uid, hv, fast:[fastighet-id], name }
  function mint({ uid, hv, fastigheter, name } = {}) {
    const id = String(uid || "").trim();
    const hvId = String(hv || "").trim();
    // ⚠️ Tom uid ELLER tom hyresvärd = ingen token. En token utan hv hade passerat
    //    authed() och sedan scopat mot en tom hyresvärd — dvs "inga hyresgäster"
    //    i stället för "sessionen är trasig".
    if (!id || !hvId) return null;
    const fast = Array.from(new Set((fastigheter || []).filter(Boolean).map(String)));
    const body = { scope: "landlord", uid: id, hv: hvId, fast, name: String(name || ""), exp: Date.now() + TTL };
    const b64 = Buffer.from(JSON.stringify(body)).toString("base64url");
    return { token: b64 + "." + sign(b64), exp: body.exp, hv: hvId, fastigheter: fast };
  }

  // Verifierar x-landlord-token → payload | null. HMAC timing-safe, scope + exp kontrolleras.
  function authed(req) {
    const raw = String((req && req.headers && req.headers["x-landlord-token"]) || "").trim();
    const dot = raw.indexOf(".");
    if (dot < 1) return null;
    const b64 = raw.slice(0, dot), sig = raw.slice(dot + 1);
    if (!b64 || !sig) return null;
    const sb = Buffer.from(sig), eb = Buffer.from(sign(b64));
    if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
    let p; try { p = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!p || p.scope !== "landlord") return null;
    if (typeof p.exp !== "number" || p.exp < Date.now()) return null;
    if (!p.uid || typeof p.uid !== "string") return null;
    if (!p.hv || typeof p.hv !== "string") return null;
    if (!Array.isArray(p.fast)) return null;
    return p;
  }

  // Delad hemlighet för session-endpointen (Bubble-wf → Render). Timing-safe.
  function verifySessionSecret(input) {
    if (!SESSION_SECRET) return { ok: false, error: "landlord_session_secret_not_configured", status: 503 };
    const ib = Buffer.from(String(input == null ? "" : input)), sb = Buffer.from(SESSION_SECRET);
    const ok = ib.length === sb.length && crypto.timingSafeEqual(ib, sb);
    return ok ? { ok: true } : { ok: false, error: "unauthorized", status: 401 };
  }

  // ── Scope-hjälpare ────────────────────────────────────────────────────────
  // ⚠️ Tom fastighetslista = INGEN åtkomst (inte "alla"). En ägare vars bestånd
  //    inte är kopplat i Bubble ska se noll, aldrig hela registret.
  function hasFastighet(payload, fastighetId) {
    if (!payload || !Array.isArray(payload.fast) || !payload.fast.length) return false;
    return payload.fast.indexOf(String(fastighetId || "")) > -1;
  }

  // Begärt hus → tillåtet hus. Utanför scope ger null → anroparen svarar 403.
  // Inget hus begärt → hela beståndet.
  function resolveScope(payload, requested) {
    const mine = (payload && Array.isArray(payload.fast)) ? payload.fast : [];
    if (!mine.length) return null;
    const want = String(requested || "").trim();
    if (!want) return mine.slice();
    return hasFastighet(payload, want) ? [want] : null;
  }

  return {
    mint, authed, verifySessionSecret, hasFastighet, resolveScope,
    ttlMs: TTL,
    configured: !!SESSION_SECRET,
  };
}

// ── Bubble-id-form ──────────────────────────────────────────────────────────
// ⚠️ FINNS AV ETT SKARPT SKÄL. På `User` ligger både ett ref-fält `Hyresvärd`
// (→ Hyresvärd) och ett option-set-fält `hyresvard` (→ User_role). Läser man fel
// får man tillbaka strängen "Hyresvärd" — som ser ut som ett värde, passerar en
// truthy-koll och sedan slår mot bubbleGet("Hyresvärd", "Hyresvärd") → 404 som ser
// ut som "hyresvärden finns inte" i stället för "vi läste fel fält".
// Ett Bubble-id är <epoch-ms>x<siffror>. Allt annat förkastas.
export function bubbleRefId(v) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String((v && (v._id || v.id)) || "");
  return /^\d{10,}x\d+$/.test(s) ? s : "";
}
