// mypage_auth.js — kundens session för "Min sida" (mira-min-sida-kund.html).
//
// Speglar visitor_auth.js. Samma grundregel, samma skäl:
//   PLANNING_ADMIN_TOKEN får ALDRIG ligga i ett kundvänt HTML-block.
//   guard() i companies_api.js är EN token för HELA modulen — läcker den, ligger
//   alla 5 499 företag, kundkort och all personal öppna. Kundens block får därför
//   bara se en kortlivad token som är scopad till EN user.
//
// Skillnad mot visitor: scopet är en enda `uid`, ingen fastighetslista. Därför är
// `authed()`s payload det enda som får avgöra VEMS profil som läses/skrivs —
// aldrig ett id ur URL:en. Se `_mypageRoutes` i companies_api.js.
//
// Sessionen mintas server-till-server: Bubble backend-wf (som känner Current User)
// → POST /mypage/session med MYPAGE_SESSION_SECRET. Browsern ser bara resultatet.
//
// ⚠️ Koppla ALDRIG in authed() i planningAuthed. Scope-isoleringen sker vid
//    DI-injektionen (samma princip som _visitorAuth, index.js).
//
// Testbar isolerat: mypage_auth_smoke.mjs
import crypto from "node:crypto";

export function makeMypageAuth({ secret, sessionSecret, ttlMs } = {}) {
  const TTL = ttlMs || 8 * 60 * 60 * 1000;                   // 8h — en arbetsdag
  const SECRET = secret || "mira-mypage-fallback";
  const SESSION_SECRET = String(sessionSecret || "").trim();  // Bubble-wf → Render

  function sign(b64) { return crypto.createHmac("sha256", SECRET).update(b64).digest("base64url"); }

  // payload: { uid, name }
  function mint({ uid, name } = {}) {
    const id = String(uid || "").trim();
    // ⚠️ Tom uid = ingen token. En token utan uid hade passerat authed() och sedan
    //    slagit mot bubbleGet("User", "") — dvs ett 404 som ser ut som "profil saknas"
    //    i stället för "sessionen är trasig".
    if (!id) return null;
    const body = { scope: "mypage", uid: id, name: String(name || ""), exp: Date.now() + TTL };
    const b64 = Buffer.from(JSON.stringify(body)).toString("base64url");
    return { token: b64 + "." + sign(b64), exp: body.exp, uid: id };
  }

  // Verifierar x-mypage-token → payload | null. HMAC timing-safe, scope + exp kontrolleras.
  function authed(req) {
    const raw = String((req && req.headers && req.headers["x-mypage-token"]) || "").trim();
    const dot = raw.indexOf(".");
    if (dot < 1) return null;
    const b64 = raw.slice(0, dot), sig = raw.slice(dot + 1);
    if (!b64 || !sig) return null;
    const sb = Buffer.from(sig), eb = Buffer.from(sign(b64));
    if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
    let p; try { p = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!p || p.scope !== "mypage") return null;
    if (typeof p.exp !== "number" || p.exp < Date.now()) return null;
    if (!p.uid || typeof p.uid !== "string") return null;
    return p;
  }

  // Delad hemlighet för session-endpointen (Bubble-wf → Render). Timing-safe.
  function verifySessionSecret(input) {
    if (!SESSION_SECRET) return { ok: false, error: "mypage_session_secret_not_configured", status: 503 };
    const ib = Buffer.from(String(input == null ? "" : input)), sb = Buffer.from(SESSION_SECRET);
    const ok = ib.length === sb.length && crypto.timingSafeEqual(ib, sb);
    return ok ? { ok: true } : { ok: false, error: "unauthorized", status: 401 };
  }

  return { mint, authed, verifySessionSecret, ttlMs: TTL, configured: !!SESSION_SECRET };
}
