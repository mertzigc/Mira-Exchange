// Köks-iPad-auth: delad åtkomstkod → scoped, HMAC-signerad session-token (bara /admin/produktion/*).
// Bär ALDRIG admin-token på den publika sidan. Testbar isolerat (kitchen_auth_smoke.mjs).
import crypto from "node:crypto";

export function makeKitchenAuth({ secret, ttlMs, code } = {}) {
  const TTL = ttlMs || 12 * 60 * 60 * 1000;                 // 12h default
  const SECRET = secret || "mira-kitchen-fallback";
  const CODE = String(code || "").trim();

  function sign(b64) { return crypto.createHmac("sha256", SECRET).update(b64).digest("base64url"); }

  function mint() {
    const b64 = Buffer.from(JSON.stringify({ scope: "produktion", exp: Date.now() + TTL })).toString("base64url");
    return b64 + "." + sign(b64);
  }

  // Verifierar x-kitchen-token: HMAC-signatur (timing-safe) + scope + exp.
  function authed(req) {
    const raw = String((req && req.headers && req.headers["x-kitchen-token"]) || "").trim();
    const dot = raw.indexOf(".");
    if (dot < 1) return false;
    const b64 = raw.slice(0, dot), sig = raw.slice(dot + 1);
    if (!b64 || !sig) return false;
    const sb = Buffer.from(sig), eb = Buffer.from(sign(b64));
    if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return false;
    let p; try { p = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")); } catch (e) { return false; }
    if (!p || p.scope !== "produktion" || typeof p.exp !== "number" || p.exp < Date.now()) return false;
    return true;
  }

  // Kod-inloggning (timing-safe). → { ok, token, exp } | { ok:false, error, status }
  function verifyCode(input) {
    if (!CODE) return { ok: false, error: "kitchen_code_not_configured", status: 503 };
    const cb = Buffer.from(String(input == null ? "" : input)), kb = Buffer.from(CODE);
    const ok = cb.length === kb.length && crypto.timingSafeEqual(cb, kb);
    if (!ok) return { ok: false, error: "invalid_code", status: 401 };
    return { ok: true, token: mint(), exp: Date.now() + TTL };
  }

  return { mint, authed, verifyCode, ttlMs: TTL, configured: !!CODE };
}
