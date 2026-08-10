// Smoke: köks-iPad-auth (delad kod → scoped token). node kitchen_auth_smoke.mjs
import { makeKitchenAuth } from "./kitchen_auth.js";

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
const reqWith = (tok) => ({ headers: tok == null ? {} : { "x-kitchen-token": tok } });

const A = makeKitchenAuth({ secret: "s3cr3t-planning", ttlMs: 12 * 3600 * 1000, code: "KOK-2026" });

// ── kod-validering ──
const good = A.verifyCode("KOK-2026");
ok("rätt kod → ok + token + exp", good.ok && typeof good.token === "string" && good.token.indexOf(".") > 0 && good.exp > Date.now());
const bad = A.verifyCode("fel");
ok("fel kod → 401 invalid_code", !bad.ok && bad.status === 401 && bad.error === "invalid_code");
const empty = A.verifyCode("");
ok("tom kod → 401", !empty.ok && empty.status === 401);
ok("configured=true", A.configured === true);

// ── token-verifiering ──
ok("giltig token → authed", A.authed(reqWith(good.token)));
ok("ingen token → ej authed", !A.authed(reqWith(null)));
ok("skräp-token → ej authed", !A.authed(reqWith("gibberish")) && !A.authed(reqWith("a.b")));

// tamper: ändra payload men behåll gammal signatur
const [b64, sig] = good.token.split(".");
const forgedPayload = Buffer.from(JSON.stringify({ scope: "produktion", exp: Date.now() + 999999999 })).toString("base64url");
ok("manipulerad payload (gammal sig) → ej authed", !A.authed(reqWith(forgedPayload + "." + sig)));
ok("manipulerad signatur → ej authed", !A.authed(reqWith(b64 + ".deadbeef")));

// fel scope
const wrongScope = makeKitchenAuth({ secret: "s3cr3t-planning" });
// mint en token med annan scope manuellt (samma secret) → ska nekas pga scope-check
import crypto from "node:crypto";
const badScopeB64 = Buffer.from(JSON.stringify({ scope: "admin", exp: Date.now() + 100000 })).toString("base64url");
const badScopeSig = crypto.createHmac("sha256", "s3cr3t-planning").update(badScopeB64).digest("base64url");
ok("fel scope (även rätt-signerad) → ej authed", !A.authed(reqWith(badScopeB64 + "." + badScopeSig)));

// utgången token
const expB64 = Buffer.from(JSON.stringify({ scope: "produktion", exp: Date.now() - 1000 })).toString("base64url");
const expSig = crypto.createHmac("sha256", "s3cr3t-planning").update(expB64).digest("base64url");
ok("utgången token → ej authed", !A.authed(reqWith(expB64 + "." + expSig)));

// annan secret → token från A ska INTE gälla i B
const B = makeKitchenAuth({ secret: "annat-secret", code: "X" });
ok("token signerad med annan secret → ej authed", !B.authed(reqWith(good.token)));

// ── ingen kod konfigurerad → 503 ──
const noCode = makeKitchenAuth({ secret: "s", code: "" });
const nc = noCode.verifyCode("vadsomhelst");
ok("ingen kod konfigurerad → 503", !nc.ok && nc.status === 503 && nc.error === "kitchen_code_not_configured");
ok("configured=false utan kod", noCode.configured === false);

console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
if (fail) process.exit(1);
