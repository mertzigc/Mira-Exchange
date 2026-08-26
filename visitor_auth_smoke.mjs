// Smoke: visitor_auth.js — receptionistens scopade session.
//   node visitor_auth_smoke.mjs
import { makeVisitorAuth } from "./visitor_auth.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
const req = (tok) => ({ headers: tok == null ? {} : { "x-visitor-token": tok } });

const A = makeVisitorAuth({ secret: "s3cr3t", sessionSecret: "wf-shared", ttlMs: 60 * 60 * 1000 });

// ── mint + authed ───────────────────────────────────────────────────────────
const m = A.mint({ uid: "u1", fastigheter: ["f1", "f2"], name: "Anna" });
ok("mint ger token + exp + fastighetslista", !!m.token && m.exp > Date.now() && JSON.stringify(m.fastigheter) === JSON.stringify(["f1", "f2"]));
const p = A.authed(req(m.token));
ok("authed returnerar PAYLOADEN (inte bara true) — scopet behövs av anroparen", !!p && p.uid === "u1" && JSON.stringify(p.fast) === JSON.stringify(["f1", "f2"]));
ok("payload bär namn för signering av besök", p.name === "Anna");
ok("mint dedupar fastigheter", JSON.stringify(A.mint({ uid: "u1", fastigheter: ["f1", "f1", "f2"] }).fastigheter) === JSON.stringify(["f1", "f2"]));

// ── avvisning ───────────────────────────────────────────────────────────────
ok("ingen token → null", A.authed(req(null)) === null);
ok("skräp → null", A.authed(req("nonsens")) === null);
ok("token utan punkt → null", A.authed(req("abc")) === null);
// ⚠️ Manipulerad payload: byt ut fastighetslistan men behåll signaturen.
const [b64, sig] = m.token.split(".");
const tampered = Buffer.from(JSON.stringify({ scope: "visitor", uid: "u1", fast: ["f9"], exp: Date.now() + 9e6 })).toString("base64url");
ok("manipulerad payload med gammal signatur → null (HMAC håller)", A.authed(req(tampered + "." + sig)) === null);
// Signerad med FEL nyckel
const B = makeVisitorAuth({ secret: "annan-nyckel", sessionSecret: "wf-shared" });
ok("token signerad med annan nyckel → null", A.authed(req(B.mint({ uid: "u1", fastigheter: ["f1"] }).token)) === null);
// Utgången
const short = makeVisitorAuth({ secret: "s3cr3t", sessionSecret: "x", ttlMs: -1000 });
ok("utgången token → null", short.authed(req(short.mint({ uid: "u1", fastigheter: ["f1"] }).token)) === null);
// Fel scope (t.ex. en kitchen-token som råkar bära samma HMAC-nyckel)
const crypto = await import("node:crypto");
const wrongScope = Buffer.from(JSON.stringify({ scope: "produktion", uid: "u1", fast: ["f1"], exp: Date.now() + 9e6 })).toString("base64url");
const wsSig = crypto.createHmac("sha256", "s3cr3t").update(wrongScope).digest("base64url");
ok("giltig signatur men scope=produktion → null (scope-isolering)", A.authed(req(wrongScope + "." + wsSig)) === null);
// Payload utan fast-array
const noFast = Buffer.from(JSON.stringify({ scope: "visitor", uid: "u1", exp: Date.now() + 9e6 })).toString("base64url");
const nfSig = crypto.createHmac("sha256", "s3cr3t").update(noFast).digest("base64url");
ok("payload utan fastighetslista → null", A.authed(req(noFast + "." + nfSig)) === null);

// ── session-secret (Bubble-wf → Render) ─────────────────────────────────────
ok("rätt hemlighet → ok", A.verifySessionSecret("wf-shared").ok === true);
ok("fel hemlighet → 401", A.verifySessionSecret("fel").status === 401);
ok("tom hemlighet → 401", A.verifySessionSecret("").status === 401);
const noSec = makeVisitorAuth({ secret: "s", sessionSecret: "" });
ok("okonfigurerad → 503 (aldrig tyst genomsläpp)", noSec.verifySessionSecret("x").status === 503 && noSec.configured === false);

// ── scope-hjälpare ──────────────────────────────────────────────────────────
ok("hasFastighet: eget hus → true", A.hasFastighet(p, "f1") === true);
ok("hasFastighet: annat hus → false", A.hasFastighet(p, "f9") === false);
// ⚠️ KÄRNAN: tom lista får ALDRIG betyda "alla".
const empty = A.authed(req(A.mint({ uid: "u2", fastigheter: [] }).token));
ok("tom fastighetslista → hasFastighet false (inte 'alla')", A.hasFastighet(empty, "f1") === false);
ok("tom fastighetslista → resolveScope null (ingen åtkomst)", A.resolveScope(empty, "") === null);
ok("resolveScope utan begärt hus → hela mitt scope", JSON.stringify(A.resolveScope(p, "")) === JSON.stringify(["f1", "f2"]));
ok("resolveScope med eget hus → bara det huset", JSON.stringify(A.resolveScope(p, "f2")) === JSON.stringify(["f2"]));
ok("resolveScope med FRÄMMANDE hus → null (anroparen svarar 403, inte tom lista)", A.resolveScope(p, "f9") === null);
ok("resolveScope null-payload → null", A.resolveScope(null, "f1") === null);

console.log(fail ? `❌ FEL  pass=${pass} fail=${fail}` : `✅ ALLA GRÖNA  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
