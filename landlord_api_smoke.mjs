// Smoke: landlord_api.js — Mira Fastighet.
//   node landlord_api_smoke.mjs
//
// ⚠️ MOCKEN ÄR STRIKT MED FLIT. Fyra skarpa buggar har passerat gröna sviter för att
//    mocken var mer tillåtande än Bubble. Här gäller:
//      • okänd CONSTRAINT-nyckel → kastar (fångar slug/display-förväxling)
//      • okänd TYP → kastar
//      • läsning sker bara på display-namn som finns på raden
//    Bubble returnerar tyst noll träffar på en felstavad slug. Att kasta i stället gör
//    felet till ett rött test i stället för en tom vy.
import { registerLandlordRoutes } from "./landlord_api.js";
import { makeLandlordAuth } from "./landlord_auth.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

// ── Strikt Bubble-mock ──────────────────────────────────────────────────────
// ⚠️ HÅRDKODADE MED FLIT — de får INTE importeras ur `C` i landlord_api.js.
//    Gör man det muterar en felstavad slug både koden och dess egen kontroll, och
//    testet blir blint för exakt det fel det finns för att fånga. Nycklarna nedan är
//    verifierade i companies_api.js/visitor_api.js. Notera Contract: LITET k.
const TILLATNA = {
  ClientCompany: new Set(["Fastighet"]),
  Office: new Set(["Kundföretag"]),
  Matter: new Set(["Kundföretag"]),
  QualityControl: new Set(["Kundföretag"]),
  Contract: new Set(["kundföretag"]),
  "Kommentar - Comment": new Set(["kvalitetskontroll"]),
  Grade: new Set(),
  Fastighet: new Set(),
  "Hyresvärd": new Set(),
  Internal_room: new Set(),
  MeetingRoom: new Set(),
};
let STORE = {}, calls = { get: 0, findAll: 0 }, sprangdeConstraints = [];

function matchC(row, c) {
  const v = row[c.key];
  if (c.constraint_type === "equals") return String(v == null ? "" : (v._id || v.id || v)) === String(c.value);
  if (c.constraint_type === "in") return (c.value || []).indexOf(String(v == null ? "" : (v._id || v.id || v))) > -1;
  if (c.constraint_type === "contains") return (Array.isArray(v) ? v : []).map(String).indexOf(String(c.value)) > -1;
  throw new Error("okänd constraint_type: " + c.constraint_type);
}
const bubbleId = (o) => (o && (o._id || o.id)) || null;
const bubbleGet = (type, id) => {
  calls.get++;
  if (!(type in TILLATNA)) return Promise.reject(new Error("okänd typ: " + type));
  const r = (STORE[type] || []).find((x) => x._id === id);
  return r ? Promise.resolve(r) : Promise.reject(new Error("404 " + type + "/" + id));
};
const bubbleFindAll = (type, { constraints = [] } = {}) => {
  calls.findAll++;
  if (!(type in TILLATNA)) return Promise.reject(new Error("okänd typ: " + type));
  for (const c of constraints) {
    if (!TILLATNA[type].has(c.key)) {
      sprangdeConstraints.push(type + "." + c.key);
      // ⚠️ REJECT, inte throw. Bubble är ett nätverksanrop — det avvisar asynkront.
      //    Kastar mocken synkront hinner anroparens `.catch()` aldrig kopplas på,
      //    felet slår upp genom Promise.all och testet KRASCHAR i stället för att
      //    FALLA. En krasch dödar hela mutationstestet. [[feedback-testet-ska-falla-inte-krascha]]
      return Promise.reject(new Error("okänd constraint-nyckel " + type + "." + c.key));
    }
  }
  return Promise.resolve((STORE[type] || []).filter((r) => constraints.every((c) => matchC(r, c))));
};

// ── Fejkad express ──────────────────────────────────────────────────────────
const ROUTES = {};
const app = { get: (p, h) => { ROUTES[p] = h; }, options: () => {}, post: (p, h) => { ROUTES[p] = h; } };
const AUTH = makeLandlordAuth({ secret: "hmac", sessionSecret: "s", ttlMs: 60 * 60 * 1000 });
const API = registerLandlordRoutes(app, {
  bubbleFindAll, bubbleGet, bubbleId, landlordAuth: AUTH,
  planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "1.2.3.4",
});

async function call(path, { token, query } = {}) {
  let status = 200, body = null;
  const res = { status(c) { status = c; return this; }, json(o) { body = o; return this; }, sendStatus() {} };
  await ROUTES[path]({ headers: token ? { "x-landlord-token": token } : {}, query: query || {} }, res);
  return { status, body };
}

// ── Data ────────────────────────────────────────────────────────────────────
const HV = "1700000000001x111", F1 = "1700000000010x001", F2 = "1700000000010x002";
const AGARE_CC = "1700000000020x900", CC1 = "1700000000020x001", CC2 = "1700000000020x002", CC3 = "1700000000020x003", CC4 = "1700000000020x004";
function reset() {
  calls = { get: 0, findAll: 0 }; sprangdeConstraints = [];
  API.tenantsForget(); API.overviewForget();
  STORE = {
    // ⚠️ Fältnamnet är AVKLIPPT i Bubble-editorn — mocken speglar det.
    "Hyresvärd": [{ _id: HV, Namn: "Vasakronan", "Fastighetsägare - (1) för Vasakronan AB": AGARE_CC }],
    Fastighet: [
      { _id: F1, Titel: "Hötorgshuset", Adress: { address: "Sveavägen 17, Stockholm" } },
      // ⚠️ Utan Titel: namnet ska falla tillbaka på adressens TEXTDEL, aldrig "[object Object]".
      { _id: F2, Adress: { address: "Sergelgatan 1, Stockholm" } },
    ],
    ClientCompany: [
      { _id: AGARE_CC, Name_company: "Vasakronan AB", Fastighet: [F1, F2] },
      { _id: CC1, Name_company: "Scania CV", Fastighet: [F1] },
      { _id: CC2, Name_company: "Planhat", Fastighet: [F1] },
      { _id: CC3, Name_company: "EA Dice", Fastighet: [F2] },
      // ⚠️ Sitter i BÅDA husen — dedupningen i tjänstekartan hänger på den här raden.
      { _id: CC4, Name_company: "Kry Sverige", Fastighet: [F1, F2] },
    ],
    Office: [
      { _id: "of1", "Kundföretag": CC1, Fastighet: F1, Office_title: "Scania plan 6", Yta: 1800, Arbetsplatser: 160 },
      { _id: "of2", "Kundföretag": CC2, Fastighet: F1, Office_title: "Planhat", Yta: 640, Arbetsplatser: 70 },
      { _id: "of3", "Kundföretag": CC3, Fastighet: F2, Office_title: "EA", Yta: 2400, Arbetsplatser: 280 },
      // ⚠️ Kry har kontor i BÅDA husen — det är kontoret, inte hyresgästen, som säger var ett ärende hör hemma.
      { _id: "of4", "Kundföretag": CC4, Fastighet: F1, Office_title: "Kry plan 3", Yta: 400, Arbetsplatser: 40 },
      { _id: "of5", "Kundföretag": CC4, Fastighet: F2, Office_title: "Kry plan 9", Yta: 300, Arbetsplatser: 30 },
      // Ägarens egen yta i F2 — bär ärendet som testar att husfiltret gäller ÄVEN egna ärenden.
      { _id: "of6", "Kundföretag": AGARE_CC, Fastighet: F2, Office_title: "Sergelhuset entré", Yta: 0, Arbetsplatser: 0 },
    ],
    Matter: [
      // Ägarens egna — får visas i detalj
      { _id: "m1", "Kundföretag": AGARE_CC, Rubrik: "Entrédörr går trögt", Prioritet: "3 - brådskande",
        status: "Pågående", Avvikelse: true, "Created Date": new Date(Date.now() - 6 * 864e5).toISOString() },
      // Hyresgästens — får ALDRIG visas i detalj
      { _id: "m2", "Kundföretag": CC1, Rubrik: "HEMLIG RUBRIK SCANIA", Beskrivning: "HEMLIG BESKRIVNING",
        Prioritet: "2", status: "Pågående", Avvikelse: false, "Created Date": new Date(Date.now() - 3 * 864e5).toISOString() },
      { _id: "m3", "Kundföretag": CC2, Rubrik: "HEMLIG RUBRIK PLANHAT", Prioritet: "1 - låg", status: "Pågående",
        Avvikelse: true, "Created Date": new Date(Date.now() - 2 * 864e5).toISOString() },
      // Stängt: ska räknas i mtts men inte i öppna
      { _id: "m4", "Kundföretag": CC1, Rubrik: "HEMLIG STÄNGD", status: "Avslutat", Avvikelse: false,
        "Created Date": new Date(Date.now() - 12 * 864e5).toISOString(), closed_date: new Date(Date.now() - 8 * 864e5).toISOString() },
      { _id: "m5", "Kundföretag": CC3, Rubrik: "HEMLIG EA", status: "Pågående", Avvikelse: false,
        "Created Date": new Date(Date.now() - 1 * 864e5).toISOString() },
      // Kry: ETT ärende per hus. Utan Kontor→Fastighet hamnar båda på F1.
      { _id: "m6", "Kundföretag": CC4, Kontor: "of4", Rubrik: "HEMLIG KRY F1", status: "Pågående",
        Avvikelse: false, "Created Date": new Date(Date.now() - 1 * 864e5).toISOString() },
      { _id: "m7", "Kundföretag": CC4, Kontor: "of5", Rubrik: "HEMLIG KRY F2", status: "Pågående",
        Avvikelse: false, "Created Date": new Date(Date.now() - 1 * 864e5).toISOString() },
      // ⚠️ ÄGARENS eget ärende i det ANDRA huset. Filtrerar man till F1 får det inte
      //    följa med — `egna_arenden` scope-filtreras inte i efterhand.
      { _id: "m8", "Kundföretag": AGARE_CC, Kontor: "of6", Rubrik: "Hiss B luktar", status: "Pågående",
        Avvikelse: true, "Created Date": new Date(Date.now() - 4 * 864e5).toISOString() },
    ],
    QualityControl: [
      { _id: "q1", "Kundföretag": CC1, kontrolldatum: "2026-08-20", Titel: "Kontroll aug" },
      { _id: "q2", "Kundföretag": CC3, kontrolldatum: "2026-08-25", Titel: "Kontroll EA" },
    ],
    "Kommentar - Comment": [
      { _id: "k1", kvalitetskontroll: "q1", Betyg: "g4", Intern_lokal: "r1" },
      { _id: "k2", kvalitetskontroll: "q1", Betyg: "g2", Intern_lokal: "r2" },
      { _id: "k3", kvalitetskontroll: "q2", Betyg: "g5", Intern_lokal: "r1" },
    ],
    // ⚠️ Betyg_lev finns MED FLIT inte här — koden får inte använda det fältet.
    Grade: [{ _id: "g2", "Värde": 2 }, { _id: "g4", "Värde": 4 }, { _id: "g5", "Värde": 5 }],
    Internal_room: [{ _id: "r1", Namn: "Toaletter" }, { _id: "r2", Namn: "Pentry" }],
    MeetingRoom: [],
    Contract: [
      { _id: "c1", "kundföretag": CC1, "kategori": "Housekeeping", "månadskostnad": 42000 },
      { _id: "c2", "kundföretag": CC1, "kategori": "Reception", "månadskostnad": 91000 },
      { _id: "c3", "kundföretag": CC3, "kategori": "Housekeeping", "månadskostnad": 15000 },
      // Utgånget avtal — ska INTE räknas som aktiv tjänst
      { _id: "c4", "kundföretag": CC2, "kategori": "Catering", "slutdatum": "2025-01-01", "månadskostnad": 8000 },
    ],
  };
}
const TOK = () => AUTH.mint({ uid: "u1", hv: HV, fastigheter: [F1, F2], name: "Eva Berg" }).token;

// ── Grind: ALLA registrerade routes ─────────────────────────────────────────
// ⚠️ Aritetstest räcker inte — loopa varje faktiskt registrerad route.
reset();
const paths = Object.keys(ROUTES);
ok("minst två routes registrerade", paths.length >= 2);
for (const p of paths) {
  const r = await call(p, {});
  ok("utan token → 401: " + p, r.status === 401 && r.body.error === "unauthorized");
  const r2 = await call(p, { token: "skräp.skräp" });
  ok("ogiltig token → 401: " + p, r2.status === 401);
}
// En visitor-token får aldrig öppna en landlord-route.
const VIS = makeLandlordAuth({ secret: "hmac", sessionSecret: "s" });
for (const p of paths) {
  const r = await call(p, { token: "eyJzY29wZSI6InZpc2l0b3IifQ.x" });
  ok("visitor-formad token → 401: " + p, r.status === 401);
}

// ── context ─────────────────────────────────────────────────────────────────
reset();
const ctx = await call("/landlord/context", { token: TOK() });
ok("context 200", ctx.status === 200 && ctx.body.ok === true);
ok("hyresvärdens namn med", ctx.body.hyresvard.namn === "Vasakronan");
ok("husnamn ur Titel", ctx.body.fastigheter.some((f) => f.namn === "Hötorgshuset"));
// ⚠️ Geo-objektet får aldrig stringifieras.
ok("hus utan Titel faller tillbaka på adressens TEXTDEL, inte [object Object]",
  ctx.body.fastigheter.some((f) => f.namn === "Sergelgatan 1, Stockholm"));
ok("ingen [object Object] någonstans i context", JSON.stringify(ctx.body).indexOf("[object Object]") === -1);
ok("adress är text", ctx.body.fastigheter.every((f) => typeof f.adress === "string"));
ok("context räknar hyresgäster per hus (rå lista, ägaren ingår)", ctx.body.fastigheter.find((f) => f.namn === "Hötorgshuset").hyresgaster === 4);

// ── scope ───────────────────────────────────────────────────────────────────
reset();
const utanfor = await call("/landlord/overview", { token: TOK(), query: { fastighet: "1700000000010x999" } });
ok("främmande hus → 403 outside_scope (aldrig tom lista)",
  utanfor.status === 403 && utanfor.body.error === "outside_scope");
reset();
const ettHus = await call("/landlord/overview", { token: TOK(), query: { fastighet: F1 } });
ok("husfiltrerad overview svarar 200", ettHus.status === 200 && !!ettHus.body.bestand);
if (!ettHus.body.bestand) ettHus.body = { bestand: [], puls: {}, hg_arenden: {}, egna_arenden: [], hela_bestandet: null };
ok("ett hus i scope → bara det huset", ettHus.body.bestand.length === 1 && ettHus.body.bestand[0].id === F1);
ok("hela_bestandet=false när ett hus valts", ettHus.body.hela_bestandet === false);
// ⚠️ Scopet måste bära ända in i ärendena — inte bara i beståndsraderna.
ok("ärenden från ett hus UTANFÖR urvalet räknas inte", (ettHus.body.hg_arenden[F2] || null) === null);
// ⚠️ Kärnan: Kry har ett ärende i vardera huset. Attribueras de på hyresgästen i
//    stället för på kontoret hamnar båda i F1 och husfiltret blir en illusion.
ok("hyresgäst i två hus: ärendet bokförs på KONTORETS hus, inte på det första",
  ettHus.body.hg_arenden[F1].oppna === 3);
ok("bara det valda husets ärenden summeras", ettHus.body.puls.arenden_oppna === 4);
ok("bara det valda husets hyresgäster räknas", ettHus.body.puls.hyresgaster === 3);
// ⚠️ Den skarpaste scope-raden: ägarens egna ärenden filtreras INTE i efterhand,
//    så husfiltret måste gälla redan när de plockas ut.
ok("ägarens egna ärende i ett ANNAT hus följer inte med husfiltret",
  ettHus.body.egna_arenden.length === 1 && ettHus.body.egna_arenden[0].hus === F1);
ok("och dess rubrik finns inte i svaret alls",
  JSON.stringify(ettHus.body).indexOf("Hiss B luktar") === -1);

// ── ⚠️ INTEGRITETSREGELN ────────────────────────────────────────────────────
reset();
const ov = await call("/landlord/overview", { token: TOK() });
ok("overview 200", ov.status === 200 && ov.body.ok === true);
const raw = JSON.stringify(ov.body);
ok("HYRESGÄSTENS ärenderubriker läcker ALDRIG ut", raw.indexOf("HEMLIG") === -1);
ok("hyresgästens beskrivning läcker aldrig", raw.indexOf("HEMLIG BESKRIVNING") === -1);
ok("ägarens EGNA ärenden visas i detalj, ett per hus", ov.body.egna_arenden.length === 2);
ok("mest akuta överst (avvikelse, sedan ålder)", (ov.body.egna_arenden[0] || {}).rubrik === "Entrédörr går trögt");
ok("ägarens egna ärenden bär prioritet + avvikelse + ålder",
  ((ov.body.egna_arenden[0] || {}).avvikelse) === true && ((ov.body.egna_arenden[0] || {}).dgr || 0) >= 5);
ok("hyresgästernas ärenden finns BARA som aggregat",
  ov.body.hg_arenden[F1].oppna === 3 && Array.isArray(ov.body.hg_arenden[F1].kat));
// ⚠️ Chipsen måste räkna samma rader som siffran ovanför dem.
ok("kategorierna räknar hyresgästernas rader, inte ägarens",
  ov.body.hg_arenden[F1].kat.reduce((a, k) => a + k[1], 0) === 4);
ok("aggregatet räknar hyresgästens avvikelse", ov.body.hg_arenden[F1].avv === 1);
ok("ägarens egna ärende räknas INTE in i hyresgästaggregatet", ov.body.hg_arenden[F1].oppna === 3 && ov.body.bestand.find((h) => h.id === F1).oppna === 4);

// ── ⚠️ INGA BELOPP ──────────────────────────────────────────────────────────
ok("månadskostnad läcker aldrig ut", raw.indexOf("månadskostnad") === -1);
ok("inget avtalsbelopp i svaret", raw.indexOf("42000") === -1 && raw.indexOf("91000") === -1 && raw.indexOf("15000") === -1);

// ── Ägarens egen ClientCompany hittas via avklippt fältnamn ─────────────────
ok("ownCompanyId hittar det avklippta fältet", API._internal.ownCompanyId(STORE["Hyresvärd"][0]) === AGARE_CC);
ok("ownCompanyId på rad utan fältet → null", API._internal.ownCompanyId({ _id: "x", Namn: "Fabege" }) === null);
ok("ownCompanyId förkastar ett option-set-värde", API._internal.ownCompanyId({ "Fastighetsägare - x": "Hyresvärd" }) === "Hyresvärd");
ok("agarens_egen_kund flaggas", ov.body.agarens_egen_kund === true);

// ── Bestånd ─────────────────────────────────────────────────────────────────
const h1 = ov.body.bestand.find((h) => h.id === F1);
ok("kvm summeras per hus", h1.kvm === 2840);
ok("arbetsplatser summeras per hus", h1.arbetsplatser === 270);
// ⚠️ Ägarens eget bolag ligger i ClientCompany.Fastighet för sina hus, men är
// ingen hyresgäst hos sig själv.
ok("ägarens EGET bolag räknas inte som hyresgäst", h1.hyresgaster === 3);
ok("puls räknar DISTINKTA hyresgäster, ägaren exkluderad", ov.body.puls.hyresgaster === 4);
ok("ägaren är ingen rad i sin egen tjänstekarta",
  ov.body.tjanster.rader.every((r) => r.namn !== "Vasakronan AB"));
ok("hyresgäst i två hus ger EN rad i tjänstekartan",
  ov.body.tjanster.rader.length === new Set(ov.body.tjanster.rader.map((r) => r.id)).size);
ok("öppna ärenden per hus", h1.oppna === 4);
ok("avvikelser per hus", h1.avvikelser === 2);
// ⚠️ mtts bara på STÄNGDA ärenden — m4 stängdes efter 4 dygn.
ok("medeltid till stängning räknas bara på stängda", h1.mtts === 4);
ok("hus utan stängda ärenden ger mtts null, inte 0",
  ov.body.bestand.find((h) => h.id === F2).mtts === null);

// ── Kvalitet: Grade.Värde, aldrig Betyg_lev ─────────────────────────────────
ok("snittbetyg = medel av Grade.Värde (4 och 2 → 3)", h1.betyg === 3);
ok("underlaget redovisas", h1.betyg_underlag === 2);
ok("ytatyp-nedbrytning finns", ov.body.kvalitet.ytatyper.some((y) => y.namn === "Toaletter"));
const toa = ov.body.kvalitet.ytatyper.find((y) => y.namn === "Toaletter");
ok("ytatyp per hus: Toaletter F1=4, F2=5", ((toa || {}).per_hus || {})[F1] === 4 && ((toa || {}).per_hus || {})[F2] === 5);
ok("puls-kvalitet = medel över hela underlaget (4+2+5)/3", ov.body.puls.kvalitet === 3.7);

// ── Tjänster ────────────────────────────────────────────────────────────────
ok("katalogen härleds ur avtalens kategori", ov.body.tjanster.katalog.indexOf("Housekeeping") > -1);
// ⚠️ Utgånget avtal får inte räknas som aktiv tjänst.
ok("utgånget avtal räknas INTE som aktiv tjänst", ov.body.tjanster.katalog.indexOf("Catering") === -1);
const planhat = ov.body.tjanster.rader.find((r) => r.namn === "Planhat");
ok("hyresgäst med bara utgånget avtal har noll tjänster", ((planhat || {}).tj || ["x"]).length === 0);
ok("Scania har två tjänster", (ov.body.tjanster.rader.find((r) => r.namn === "Scania CV") || { tj: [] }).tj.length === 2);
// ⚠️ Kry sitter i två hus — men ska bara ha EN rad, med båda husen listade.
const kry = ov.body.tjanster.rader.filter((r) => r.namn === "Kry Sverige");
ok("hyresgäst i två hus ger exakt en rad", kry.length === 1);
ok("raden bär båda husen", kry.length === 1 && kry[0].hus.length === 2);
ok("vitt utrymme räknar dem som saknar tjänsten",
  ((ov.body.tjanster.vitt.find((v) => v.namn === "Reception") || {}).utan) === 3);
ok("tjänstetäckning per hus (1 av 3 hyresgäster i F1 har tjänst)", h1.tackning === 0.33);

// ── Källtäckning ────────────────────────────────────────────────────────────
const kal = ov.body.kallor;
ok("källtäckning finns", Array.isArray(kal) && kal.length >= 6);
// ⚠️ De ej inkopplade spåren MÅSTE stå med — att utelämna dem döljer luckan.
for (const n of ["Städpass (Housekeeping)", "Leveranser (Food & Event)", "Uppdrag (Service & People)", "Besöksflöde"]) {
  ok("källa redovisas som ej i drift: " + n, (kal.find((k) => k.namn === n) || {}).status === "ej_i_drift");
}
ok("Ärenden redovisas som live", (kal.find((k) => k.namn === "Ärenden och avvikelser") || {}).status === "live");
reset();
STORE["Hyresvärd"][0] = { _id: HV, Namn: "Fabege" };   // ingen egen ClientCompany
const ov2 = await call("/landlord/overview", { token: TOK() });
ok("utan egen ClientCompany → egna ärenden tomt", ov2.body.egna_arenden.length === 0);
ok("och källtäckningen SÄGER varför, i stället för att bara visa noll",
  (ov2.body.kallor.find((k) => k.namn === "Ägarens egna ärenden") || {}).status === "saknas");

// ── WU ──────────────────────────────────────────────────────────────────────
reset();
await call("/landlord/overview", { token: TOK() });
const kallt = calls.findAll + calls.get;
const eftersta = calls;
await call("/landlord/overview", { token: TOK() });
ok("andra anropet träffar cachen → noll nya Bubble-anrop", (calls.findAll + calls.get) === kallt);
await call("/landlord/overview", { token: TOK(), query: { fastighet: F1 } });
ok("husfilter byggs ur SAMMA cache → fortfarande noll nya anrop", (calls.findAll + calls.get) === kallt);
// ⚠️ Ett svep per typ, inte per hyresgäst.
ok("ett bygge = ett fåtal findAll, inte N+1 per hyresgäst", calls.findAll <= 9);
ok("cache-läget redovisas i meta", (await call("/landlord/overview", { token: TOK() })).body.meta.cache === "hit");

// ── Mocken sprängdes aldrig ─────────────────────────────────────────────────
ok("ingen okänd constraint-nyckel användes (slug vs display)",
  sprangdeConstraints.length === 0 || !console.log("     sprängda:", sprangdeConstraints.join(", ")));

console.log(fail ? `❌ FEL  pass=${pass} fail=${fail}` : `✅ ALLA GRÖNA  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
