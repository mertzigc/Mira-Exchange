// visitor_auth.js — receptionistens session för /visitor (besökshantering).
//
// Speglar kitchen_auth.js men med TVÅ skillnader som följer av att receptionisten är en
// riktig användare, inte en kiosk:
//   1. Ingen delad kod. Sessionen mintas server-till-server: Bubble backend-wf (som känner
//      Current User) → Render med VISITOR_SESSION_SECRET. Browsern ser bara den färdiga,
//      scopade tokenen. PLANNING_ADMIN_TOKEN får ALDRIG ligga i /visitor-blocket.
//   2. `authed()` returnerar PAYLOADEN, inte bara true/false — anroparen behöver
//      fastighetslistan för att kunna scope-filtrera varje fråga.
//
// ⚠️ Koppla ALDRIG in authed() i planningAuthed för andra moduler. Scope-isoleringen
//    sker vid DI-injektionen (samma princip som _kitchenAuth, index.js ~20817).
//
// Testbar isolerat: visitor_auth_smoke.mjs
import crypto from "node:crypto";

export function makeVisitorAuth({ secret, sessionSecret, ttlMs } = {}) {
  const TTL = ttlMs || 12 * 60 * 60 * 1000;                  // 12h — täcker ett pass
  const SECRET = secret || "mira-visitor-fallback";
  const SESSION_SECRET = String(sessionSecret || "").trim();  // Bubble-wf → Render

  function sign(b64) { return crypto.createHmac("sha256", SECRET).update(b64).digest("base64url"); }

  // payload: { uid, fast:[fastighet-id], name }
  function mint({ uid, fastigheter, name } = {}) {
    const fast = Array.from(new Set((fastigheter || []).filter(Boolean).map(String)));
    const body = { scope: "visitor", uid: String(uid || ""), fast, name: String(name || ""), exp: Date.now() + TTL };
    const b64 = Buffer.from(JSON.stringify(body)).toString("base64url");
    return { token: b64 + "." + sign(b64), exp: body.exp, fastigheter: fast };
  }

  // Verifierar x-visitor-token → payload | null. HMAC timing-safe, scope + exp kontrolleras.
  function authed(req) {
    const raw = String((req && req.headers && req.headers["x-visitor-token"]) || "").trim();
    const dot = raw.indexOf(".");
    if (dot < 1) return null;
    const b64 = raw.slice(0, dot), sig = raw.slice(dot + 1);
    if (!b64 || !sig) return null;
    const sb = Buffer.from(sig), eb = Buffer.from(sign(b64));
    if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
    let p; try { p = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!p || p.scope !== "visitor") return null;
    if (typeof p.exp !== "number" || p.exp < Date.now()) return null;
    if (!Array.isArray(p.fast)) return null;
    return p;
  }

  // Delad hemlighet för session-endpointen (Bubble-wf → Render). Timing-safe.
  function verifySessionSecret(input) {
    if (!SESSION_SECRET) return { ok: false, error: "visitor_session_secret_not_configured", status: 503 };
    const ib = Buffer.from(String(input == null ? "" : input)), sb = Buffer.from(SESSION_SECRET);
    const ok = ib.length === sb.length && crypto.timingSafeEqual(ib, sb);
    return ok ? { ok: true } : { ok: false, error: "unauthorized", status: 401 };
  }

  // ── Scope-hjälpare ────────────────────────────────────────────────────────
  // ⚠️ Tom fastighetslista = INGEN åtkomst (inte "alla"). En receptionist utan
  //    tilldelade fastigheter ska se noll, aldrig hela beståndet.
  function hasFastighet(payload, fastighetId) {
    if (!payload || !Array.isArray(payload.fast) || !payload.fast.length) return false;
    return payload.fast.indexOf(String(fastighetId || "")) > -1;
  }

  // Begärt hus → tillåtet hus. Utanför scope ger null → anroparen svarar 403.
  // Inget hus begärt → hela scopet (receptionisten ser alla sina hus).
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
