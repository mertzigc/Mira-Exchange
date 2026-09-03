// Smoke: POST /landlord/session — sessionsmintningen för fastighetsägarvyn.
//   node landlord_session_smoke.mjs
//
// Kör mot RIKTIG källkod: endpointen klipps ut ur index.js och körs mot en stubbad
// Bubble + en fejkad express-app. index.js är för stor/sidoeffektsfylld för att
// importeras — samma textextraktionsmönster som cc_cache_smoke.mjs.
//
// ⚠️ Den HÄR sviten finns för branchningen, inte för HMAC:en (den ligger i
//    landlord_auth_smoke.mjs). Fyra grenar som alla har egen felkod, och som utan
//    test hade kollapsat till ett tyst "no_fastigheter_assigned":
//      1. option-set-fältet `hyresvard` läst i stället för ref-fältet `Hyresvärd`
//      2. `Hyresvärd.Fastighet` tom → fallback till `Fastighet.Ägare`
//      3. `hyresvard_fastigheter` smalnar av beståndet
//      4. `hyresvard_fastigheter` pekar UTANFÖR beståndet (datafel, inte "ingen access")
import fs from "node:fs";
import { makeLandlordAuth, bubbleRefId } from "./landlord_auth.js";

const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
function slice(a, b, label) {
  const i = SRC.indexOf(a); if (i < 0) throw new Error("hittade inte start för " + label);
  const j = SRC.indexOf(b, i); if (j < 0) throw new Error("hittade inte slut för " + label);
  return SRC.slice(i, j + b.length);
}
const epSrc = slice(
  'app.post("/landlord/session", async (req, res) => {',
  '\n});',
  "/landlord/session"
);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

// ── Stubbad Bubble ──────────────────────────────────────────────────────────
let STORE = {};
let findAllCalls = [];
const bubbleGet = (type, id) => {
  const row = (STORE[type] || []).find((r) => r._id === id);
  return row ? Promise.resolve(row) : Promise.reject(Object.assign(new Error("not found"), { detail: { status: 404 } }));
};
const bubbleFindAll = (type) => { findAllCalls.push(type); return Promise.resolve((STORE[type] || []).slice()); };

const AUTH = makeLandlordAuth({ secret: "hmac", sessionSecret: "wf-shared", ttlMs: 60 * 60 * 1000 });

// ── Fejkad express ──────────────────────────────────────────────────────────
let HANDLER = null;
const app = { post: (p, h) => { if (p === "/landlord/session") HANDLER = h; }, options: () => {} };
new Function("app", "bubbleGet", "bubbleFindAll", "bubbleRefId", "_landlordAuth", "_planningCors", "_publicRateLimited", "_clientIp", "console",
  epSrc)(app, bubbleGet, bubbleFindAll, bubbleRefId, AUTH, () => {}, () => false, () => "1.2.3.4",
  { log: () => {}, error: () => {} });
if (!HANDLER) throw new Error("endpointen registrerades inte — ändrades routen i index.js?");

async function call(body, secret = "wf-shared") {
  let status = 200, payload = null;
  const res = { status(c) { status = c; return this; }, json(o) { payload = o; return this; }, sendStatus() {} };
  await HANDLER({ headers: { "x-landlord-secret": secret }, body: body || {} }, res);
  return { status, body: payload };
}

const HV = "1700000000001x111", HV2 = "1700000000002x222";
const F1 = "1700000000010x001", F2 = "1700000000010x002", F3 = "1700000000010x003";
function reset() {
  findAllCalls = [];
  STORE = {
    User: [
      { _id: "u1", User_role: "Hyresvärd", "Hyresvärd": HV, "First Name": "Eva", "Surname": "Berg" },
      { _id: "u2", User_role: "Receptionist", "Hyresvärd": HV },
      { _id: "u3", User_role: "Hyresvärd" },
      // ⚠️ Fällan: option-set-fältet ifyllt, ref-fältet TOMT.
      { _id: "u4", User_role: "Hyresvärd", hyresvard: "Hyresvärd" },
      { _id: "u5", User_role: "Hyresvärd", "Hyresvärd": HV, hyresvard_fastigheter: [F2] },
      { _id: "u6", User_role: "Hyresvärd", "Hyresvärd": HV, hyresvard_fastigheter: [F3] },
      { _id: "u7", User_role: "Hyresvärd", "Hyresvärd": HV2 },
      { _id: "u8", User_role: { display: "Hyresvärd" }, "Hyresvärd": HV },
    ],
    "Hyresvärd": [
      { _id: HV, Namn: "Vasakronan", Fastighet: [F1, F2] },
      { _id: HV2, Namn: "Fabege", Fastighet: [] },
    ],
    Fastighet: [
      { _id: F1, Titel: "Hötorgshuset", "Ägare": HV },
      { _id: F2, Titel: "Sergelhuset", "Ägare": HV },
      { _id: F3, Titel: "Kista Entré", "Ägare": HV2 },
    ],
  };
}

// ── Grind ───────────────────────────────────────────────────────────────────
reset();
ok("fel hemlighet → 401", (await call({ user_id: "u1" }, "fel")).status === 401);
ok("saknat user_id → 400", (await call({})).status === 400);
ok("okänd user → 404 user_not_found", (await call({ user_id: "finns-ej" })).body.error === "user_not_found");

// ── Rollen ──────────────────────────────────────────────────────────────────
const r2 = await call({ user_id: "u2" });
ok("receptionist → 403 not_landlord (rollen bär scopet, inte fältet)", r2.status === 403 && r2.body.error === "not_landlord");
ok("felaktig roll rapporteras tillbaka så felet går att se", r2.body.role === "Receptionist");
const r8 = await call({ user_id: "u8" });
ok("User_role som {display} normaliseras → släpps igenom", r8.status === 200 && r8.body.ok === true);

// ── ⚠️ Option-set-fällan ────────────────────────────────────────────────────
const r3 = await call({ user_id: "u3" });
ok("Hyresvärd-ref saknas → 403 no_landlord_linked", r3.status === 403 && r3.body.error === "no_landlord_linked");
const r4 = await call({ user_id: "u4" });
ok("BARA option-set-fältet `hyresvard` ifyllt → 403, ALDRIG en session mot 'Hyresvärd' som id",
  r4.status === 403 && r4.body.error === "no_landlord_linked");

// ── Beståndet: riktning 1 (Hyresvärd.Fastighet) ─────────────────────────────
reset();
const r1 = await call({ user_id: "u1" });
ok("giltig ägare → 200 + token", r1.status === 200 && !!r1.body.token);
ok("beståndet kommer ur Hyresvärd.Fastighet", JSON.stringify(r1.body.fastigheter) === JSON.stringify([F1, F2]));
ok("kalla säger vilken riktning som bar datan", r1.body.kalla === "hyresvard_lista");
ok("hyresvärd-id + namn följer med (blocket behöver rubriken)", r1.body.hyresvard === HV && r1.body.hyresvard_namn === "Vasakronan");
ok("namnet sätts ihop av First Name + Surname", r1.body.name === "Eva Berg");
ok("exp_iso är en ISO-sträng (Bubbles date-fält kan inte ta ett tal)",
  typeof r1.body.exp_iso === "string" && !isNaN(Date.parse(r1.body.exp_iso)));
ok("tokenen går att verifiera med samma auth", !!AUTH.authed({ headers: { "x-landlord-token": r1.body.token } }));
ok("payloadens scope = de två husen",
  JSON.stringify(AUTH.authed({ headers: { "x-landlord-token": r1.body.token } }).fast) === JSON.stringify([F1, F2]));
// ⚠️ WU: listriktningen får INTE svepa Fastighet.
ok("listriktningen sveper inte Fastighet (WU)", findAllCalls.indexOf("Fastighet") === -1);

// ── Beståndet: riktning 2 (fallback Fastighet.Ägare) ────────────────────────
reset();
STORE["Hyresvärd"][0].Fastighet = [];        // listan tom → fallback
const rf = await call({ user_id: "u1" });
ok("tom Hyresvärd.Fastighet → faller tillbaka på Fastighet.Ägare",
  rf.status === 200 && JSON.stringify(rf.body.fastigheter) === JSON.stringify([F1, F2]));
ok("fallbacken rapporteras i kalla (så vi ser att listan behöver backfillas)", rf.body.kalla === "fastighet_agare_svep");
ok("fallbacken tar bara med EGNA hus (F3 tillhör Fabege)", rf.body.fastigheter.indexOf(F3) === -1);
ok("fallbacken sveper Fastighet exakt en gång", findAllCalls.filter((t) => t === "Fastighet").length === 1);

// ── Ingen fastighet alls ────────────────────────────────────────────────────
reset();
const r7 = await call({ user_id: "u7" });   // Fabege: tom lista, F3 pekar på HV2 → 1 hus
ok("hyresvärd med ett hus via Ägare-fallbacken → 200", r7.status === 200 && r7.body.antal_fastigheter === 1);
reset();
STORE["Hyresvärd"][1].Fastighet = [];
STORE.Fastighet = STORE.Fastighet.filter((f) => f._id !== F3);
const r7b = await call({ user_id: "u7" });
ok("hyresvärd utan hus → 403 no_fastigheter_assigned (aldrig en tom token)",
  r7b.status === 403 && r7b.body.error === "no_fastigheter_assigned");

// ── Smalning per användare ──────────────────────────────────────────────────
reset();
const r5 = await call({ user_id: "u5" });
ok("hyresvard_fastigheter smalnar av till ett hus",
  r5.status === 200 && JSON.stringify(r5.body.fastigheter) === JSON.stringify([F2]));
// ⚠️ Egen felkod: tilldelningen pekar på ett hus som inte är ägarens.
const r6 = await call({ user_id: "u6" });
ok("tilldelning UTANFÖR beståndet → 403 fastigheter_outside_landlord, inte 'ingen tilldelning'",
  r6.status === 403 && r6.body.error === "fastigheter_outside_landlord");
ok("felet bär både beståndets och tilldelningens storlek (diagnoserbart)",
  r6.body.bestand === 2 && r6.body.tilldelade === 1);
// ⚠️ Smalningen får ALDRIG ge access till någon annans hus.
reset();
STORE.User.find((x) => x._id === "u5").hyresvard_fastigheter = [F2, F3];
const r5b = await call({ user_id: "u5" });
ok("smalning som INNEHÅLLER ett främmande hus → bara det egna släpps igenom",
  JSON.stringify(r5b.body.fastigheter) === JSON.stringify([F2]));

console.log(fail ? `❌ FEL  pass=${pass} fail=${fail}` : `✅ ALLA GRÖNA  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
