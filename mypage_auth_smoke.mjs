// mypage_auth_smoke.mjs — isolerad svit för mypage_auth.js.
//
// Sviten finns för EN sak: bevisa att kundens token inte går att förfalska, förlänga
// eller peka om till någon annans profil. Varje test motsvarar ett konkret angrepp.
// Kör: node mypage_auth_smoke.mjs
import { makeMypageAuth } from "./mypage_auth.js";
import { makeVisitorAuth } from "./visitor_auth.js";

let pass = 0, fail = 0;
const ok = (namn, v) => { if (v) { pass++; console.log("  ✓ " + namn); } else { fail++; console.log("  ✗ " + namn); } };
const req = (token, header = "x-mypage-token") => ({ headers: token == null ? {} : { [header]: token } });

const SECRET = "hemlis-admin-token";
const SESSION = "hemlis-session-secret";
const A = makeMypageAuth({ secret: SECRET, sessionSecret: SESSION });

console.log("\n── mint + authed ──");
const m = A.mint({ uid: "u1", name: "Ossian Eliasson" });
ok("mint ger token + exp + uid", !!m && !!m.token && typeof m.exp === "number" && m.uid === "u1");
const p = A.authed(req(m.token));
ok("authed returnerar payload med rätt uid", !!p && p.uid === "u1" && p.scope === "mypage");
ok("payload bär namnet", p && p.name === "Ossian Eliasson");

console.log("\n── mint vägrar tomt uid ──");
// Utan denna hade en trasig session gett ett 404 som ser ut som "profilen saknas".
ok("mint utan uid → null", A.mint({ uid: "" }) === null && A.mint({}) === null);
ok("mint med whitespace-uid → null", A.mint({ uid: "   " }) === null);

console.log("\n── förfalskning ──");
ok("ingen token → null", A.authed(req(null)) === null);
ok("tom sträng → null", A.authed(req("")) === null);
ok("skräp utan punkt → null", A.authed(req("abcdef")) === null);
ok("punkt först (tom b64) → null", A.authed(req(".sig")) === null);
const [b64, sig] = m.token.split(".");
ok("manipulerad signatur → null", A.authed(req(b64 + ".x" + sig.slice(1))) === null);
ok("avhuggen signatur → null", A.authed(req(b64 + "." + sig.slice(0, -4))) === null);

// ⚠️ Kärnangreppet: byt uid i payloaden och signera om med FEL hemlighet.
const stolen = Buffer.from(JSON.stringify({ scope: "mypage", uid: "NAGON_ANNAN", exp: Date.now() + 9e6 }))
  .toString("base64url");
const B = makeMypageAuth({ secret: "fel-hemlighet", sessionSecret: SESSION });
ok("payload omsignerad med fel hemlighet → null", A.authed(req(B.mint({ uid: "NAGON_ANNAN" }).token)) === null);
ok("payload utan giltig signatur → null", A.authed(req(stolen + ".paittad")) === null);

console.log("\n── scope-isolering mot visitor ──");
// Samma HMAC-hemlighet men annat scope. Utan scope-kontrollen hade en receptionist-
// token öppnat Min sida (och tvärtom) — exakt den korskopplingen visitor_auth varnar för.
const V = makeVisitorAuth({ secret: SECRET, sessionSecret: SESSION });
const vt = V.mint({ uid: "u1", fastigheter: ["f1"], name: "Receptionist" });
ok("visitor-token duger INTE som mypage-token", A.authed(req(vt.token)) === null);
ok("mypage-token duger INTE som visitor-token", V.authed({ headers: { "x-visitor-token": m.token } }) === null);

console.log("\n── utgången token ──");
const Kort = makeMypageAuth({ secret: SECRET, sessionSecret: SESSION, ttlMs: -1000 });
ok("exp i det förflutna → null", Kort.authed(req(Kort.mint({ uid: "u1" }).token)) === null);
const utanExp = Buffer.from(JSON.stringify({ scope: "mypage", uid: "u1" })).toString("base64url");
ok("payload utan exp → null", A.authed(req(utanExp + "." + "x")) === null);

console.log("\n── fel header ──");
ok("token i x-admin-token läses inte", A.authed(req(m.token, "x-admin-token")) === null);
ok("token i x-visitor-token läses inte", A.authed(req(m.token, "x-visitor-token")) === null);

console.log("\n── session-hemligheten ──");
ok("rätt hemlighet → ok", A.verifySessionSecret(SESSION).ok === true);
ok("fel hemlighet → 401", A.verifySessionSecret("fel").status === 401);
ok("tom hemlighet → 401", A.verifySessionSecret("").status === 401);
// Olika längd får inte krascha timingSafeEqual (den kastar på olika buffertlängd).
ok("kortare hemlighet kraschar inte", A.verifySessionSecret("x").ok === false);
ok("längre hemlighet kraschar inte", A.verifySessionSecret(SESSION + "extra").ok === false);
const Okonf = makeMypageAuth({ secret: SECRET });
ok("okonfigurerad → 503, inte 401", Okonf.verifySessionSecret("vadsomhelst").status === 503);
ok("configured speglar hemligheten", A.configured === true && Okonf.configured === false);

console.log("\n" + (fail ? "❌ FEL" : "✅ ALLA GRÖNA") + "  pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
