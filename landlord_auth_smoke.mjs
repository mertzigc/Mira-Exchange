// Smoke: landlord_auth.js — fastighetsägarens scopade session.
//   node landlord_auth_smoke.mjs
import { makeLandlordAuth, bubbleRefId } from "./landlord_auth.js";
import crypto from "node:crypto";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
const req = (tok) => ({ headers: tok == null ? {} : { "x-landlord-token": tok } });

const A = makeLandlordAuth({ secret: "s3cr3t", sessionSecret: "wf-shared", ttlMs: 60 * 60 * 1000 });
const HV = "1700000000001x111";

// ── mint + authed ───────────────────────────────────────────────────────────
const m = A.mint({ uid: "u1", hv: HV, fastigheter: ["f1", "f2"], name: "Anna" });
ok("mint ger token + exp + hv + fastighetslista",
  !!m.token && m.exp > Date.now() && m.hv === HV && JSON.stringify(m.fastigheter) === JSON.stringify(["f1", "f2"]));
const p = A.authed(req(m.token));
ok("authed returnerar PAYLOADEN (inte bara true) — scopet behövs av anroparen",
  !!p && p.uid === "u1" && JSON.stringify(p.fast) === JSON.stringify(["f1", "f2"]));
ok("payload bär hyresvärd-id (ägarens egna ärenden hänger på det)", p.hv === HV);
ok("payload bär namn", p.name === "Anna");
ok("mint dedupar fastigheter",
  JSON.stringify(A.mint({ uid: "u1", hv: HV, fastigheter: ["f1", "f1", "f2"] }).fastigheter) === JSON.stringify(["f1", "f2"]));

// ⚠️ KÄRNAN i mint: utan hyresvärd finns ingen session att minta.
ok("mint utan uid → null", A.mint({ hv: HV, fastigheter: ["f1"] }) === null);
ok("mint utan hyresvärd → null (aldrig en token som scopar mot tomt)", A.mint({ uid: "u1", fastigheter: ["f1"] }) === null);
ok("mint med tom hyresvärd-sträng → null", A.mint({ uid: "u1", hv: "   ", fastigheter: ["f1"] }) === null);

// ── avvisning ───────────────────────────────────────────────────────────────
ok("ingen token → null", A.authed(req(null)) === null);
ok("skräp → null", A.authed(req("nonsens")) === null);
ok("token utan punkt → null", A.authed(req("abc")) === null);
const [b64, sig] = m.token.split(".");
const tampered = Buffer.from(JSON.stringify({ scope: "landlord", uid: "u1", hv: HV, fast: ["f9"], exp: Date.now() + 9e6 })).toString("base64url");
ok("manipulerad payload med gammal signatur → null (HMAC håller)", A.authed(req(tampered + "." + sig)) === null);
const B = makeLandlordAuth({ secret: "annan-nyckel", sessionSecret: "wf-shared" });
ok("token signerad med annan nyckel → null", A.authed(req(B.mint({ uid: "u1", hv: HV, fastigheter: ["f1"] }).token)) === null);
const short = makeLandlordAuth({ secret: "s3cr3t", sessionSecret: "x", ttlMs: -1000 });
ok("utgången token → null", short.authed(req(short.mint({ uid: "u1", hv: HV, fastigheter: ["f1"] }).token)) === null);

const signWith = (obj) => {
  const b = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return b + "." + crypto.createHmac("sha256", "s3cr3t").update(b).digest("base64url");
};
// ⚠️ Scope-isolering: en receptionisttoken bär samma HMAC-nyckel (PLANNING_ADMIN_TOKEN)
//    och SAMMA fältform. Bara `scope` skiljer dem åt.
ok("giltig signatur men scope=visitor → null (scope-isolering mot receptionisten)",
  A.authed(req(signWith({ scope: "visitor", uid: "u1", fast: ["f1"], exp: Date.now() + 9e6 }))) === null);
ok("giltig signatur men scope=mypage → null", A.authed(req(signWith({ scope: "mypage", uid: "u1", exp: Date.now() + 9e6 }))) === null);
// ⚠️ Payload IDENTISK i form — bara `scope` skiljer. Utan den här raden är
//    scope-kontrollen inte bevisat bärande: de andra scope-testerna faller på att
//    payloaden saknar `hv`/`fast`, inte på scopet. (Mutationstest 2026-09-03.)
ok("identiskt formad payload med scope=visitor → null (SCOPET ensamt avvisar)",
  A.authed(req(signWith({ scope: "visitor", uid: "u1", hv: HV, fast: ["f1", "f2"], name: "Anna", exp: Date.now() + 9e6 }))) === null);
ok("payload utan fastighetslista → null", A.authed(req(signWith({ scope: "landlord", uid: "u1", hv: HV, exp: Date.now() + 9e6 }))) === null);
ok("payload utan hv → null", A.authed(req(signWith({ scope: "landlord", uid: "u1", fast: ["f1"], exp: Date.now() + 9e6 }))) === null);
ok("payload utan uid → null", A.authed(req(signWith({ scope: "landlord", hv: HV, fast: ["f1"], exp: Date.now() + 9e6 }))) === null);

// ── session-secret (Bubble-wf → Render) ─────────────────────────────────────
ok("rätt hemlighet → ok", A.verifySessionSecret("wf-shared").ok === true);
ok("fel hemlighet → 401", A.verifySessionSecret("fel").status === 401);
ok("tom hemlighet → 401", A.verifySessionSecret("").status === 401);
const noSec = makeLandlordAuth({ secret: "s", sessionSecret: "" });
ok("okonfigurerad → 503 (aldrig tyst genomsläpp)", noSec.verifySessionSecret("x").status === 503 && noSec.configured === false);

// ── scope-hjälpare ──────────────────────────────────────────────────────────
ok("hasFastighet: eget hus → true", A.hasFastighet(p, "f1") === true);
ok("hasFastighet: annat hus → false", A.hasFastighet(p, "f9") === false);
// ⚠️ KÄRNAN: tom lista får ALDRIG betyda "alla".
const empty = A.authed(req(A.mint({ uid: "u2", hv: HV, fastigheter: [] }).token));
ok("tom fastighetslista → hasFastighet false (inte 'alla')", A.hasFastighet(empty, "f1") === false);
ok("tom fastighetslista → resolveScope null (ingen åtkomst)", A.resolveScope(empty, "") === null);
ok("resolveScope utan begärt hus → hela beståndet", JSON.stringify(A.resolveScope(p, "")) === JSON.stringify(["f1", "f2"]));
ok("resolveScope med eget hus → bara det huset", JSON.stringify(A.resolveScope(p, "f2")) === JSON.stringify(["f2"]));
ok("resolveScope med FRÄMMANDE hus → null (anroparen svarar 403, inte tom lista)", A.resolveScope(p, "f9") === null);
ok("resolveScope null-payload → null", A.resolveScope(null, "f1") === null);

// ── bubbleRefId: option-set-fällan ──────────────────────────────────────────
// ⚠️ På User finns BÅDE `Hyresvärd` (ref) och `hyresvard` (option set User_role).
//    Läser man fel fält får man tillbaka strängen "Hyresvärd".
ok("bubbleRefId: riktigt Bubble-id passerar", bubbleRefId("1700000000001x111") === "1700000000001x111");
ok("bubbleRefId: objekt med _id passerar", bubbleRefId({ _id: "1700000000001x222" }) === "1700000000001x222");
ok("bubbleRefId: option-set-strängen 'Hyresvärd' förkastas", bubbleRefId("Hyresvärd") === "");
ok("bubbleRefId: option-set-objekt {display} förkastas", bubbleRefId({ display: "Hyresvärd" }) === "");
ok("bubbleRefId: tom/null förkastas", bubbleRefId(null) === "" && bubbleRefId("") === "");
ok("bubbleRefId: id utan x förkastas", bubbleRefId("1700000000001111") === "");

console.log(fail ? `❌ FEL  pass=${pass} fail=${fail}` : `✅ ALLA GRÖNA  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
