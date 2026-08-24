// Smoke: offert-modulen — kategori + nummerserie per bolag. node offert_smoke.mjs
//
// Bakgrund: "Offert Allmän" (uppladdat dokument) ska fungera för ALLA bolag. Förut
// fick varje offert `FE-{år}-{löpnr}` oavsett kategori, och löpnumret söktes på
// `source` — dominerar F&E hittades aldrig HK:s högsta nummer och serien började om.
import { registerOffertRoutes } from "./offert_api.js";
import { readFileSync } from "node:fs";

const routes = { get: {}, post: {}, patch: {}, delete: {}, options: {} };
const app = {
  get: (p, ...a) => { routes.get[p] = a[a.length - 1]; },
  post: (p, ...a) => { routes.post[p] = a[a.length - 1]; },
  patch: (p, ...a) => { routes.patch[p] = a[a.length - 1]; },
  delete: (p, ...a) => { routes.delete[p] = a[a.length - 1]; },
  options: (p, ...a) => { routes.options[p] = a[a.length - 1]; },
};
function call(rs, method, path, { params = {}, query = {}, body = {} } = {}) {
  const h = rs[method][path];
  // ⚠️ Saknad route får inte kasta — då dör sviten vid mutationstest och döljer resten.
  if (!h) return Promise.resolve({ code: 404, body: { ok: false, error: "no_route", route: method + " " + path } });
  return new Promise((r) => {
    const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } };
    h({ params, query, body, headers: {} }, res);
  });
}

const YEAR = new Date().getFullYear();
let DB, created, patched, idc;
function reset() {
  idc = 0; created = []; patched = [];
  DB = {
    Offert: [
      // Befintlig F&E-serie: högsta = 0007. HK har redan 0003.
      { _id: "o1", source: "mira_fe", offertnr: `FE-${YEAR}-0007`, kategori: "Food & Event", "Created Date": "2026-08-01" },
      { _id: "o2", source: "mira_fe", offertnr: `FE-${YEAR}-0006`, kategori: "Food & Event", "Created Date": "2026-07-01" },
      { _id: "o3", source: "mira_fe", offertnr: `HK-${YEAR}-0003`, kategori: "Housekeeping", "Created Date": "2026-06-01" },
    ],
    OffertRad: [], ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }], Product: [],
  };
}
reset();

const _match = (rec, c) => {
  const v = rec[c.key];
  if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value);
  if (c.constraint_type === "text contains") return String(v == null ? "" : v).indexOf(String(c.value)) > -1;
  return true;
};
const baseDeps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFind: async (t, { constraints = [], limit = 100 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFindOne: async (t, o) => ((DB[t] || []).filter((r) => (o.constraints || []).every((c) => _match(r, c)))[0] || null),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCreate: async (t, payload) => { const id = t.toLowerCase() + "_" + (++idc); const rec = Object.assign({ _id: id }, payload); (DB[t] = DB[t] || []).push(rec); created.push({ t, id, payload }); return id; },
  bubblePatch: async (t, id, p) => { patched.push({ t, id, p }); const r = (DB[t] || []).find((x) => x._id === id); if (r) Object.assign(r, p); return {}; },
  bubbleDelete: async (t, id) => { if (DB[t]) { const i = DB[t].findIndex((r) => r._id === id); if (i >= 0) DB[t].splice(i, 1); } return {}; },
  contractRenderEngine: { renderHtml: async () => "<html></html>", htmlToPdf: async () => Buffer.from("pdf") },
  planningAuthed: () => true, planningCors: () => {},
  publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE_CONN",
};
registerOffertRoutes(app, baseDeps);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  const mk = (body) => call(routes, "post", "/admin/offert/create", { body: Object.assign({ kundforetag: "cc1", rows: [] }, body) });

  // ── Nummerserie per bolag ────────────────────────────────────────────────
  const fe = await mk({ kategori: "Food & Event" });
  ok("F&E fortsätter befintlig serie (0007 → 0008)", fe.body.offertnr === `FE-${YEAR}-0008`);
  // ⚠️ Kärnan: HK har en EGEN serie. Söktes löpnumret på `source` (som förr) skulle
  // de senaste 200 domineras av F&E och HK börja om på 0001 → krock med HK-0003.
  const hk = await mk({ kategori: "Housekeeping" });
  ok("Housekeeping har egen serie och fortsätter från 0003 → 0004", hk.body.offertnr === `HK-${YEAR}-0004`);
  const sp = await mk({ kategori: "Service & People" });
  ok("Service & People får egen serie från 0001", sp.body.offertnr === `SP-${YEAR}-0001`);
  const of = await mk({ kategori: "Other facility services" });
  ok("Other facility services får egen serie", of.body.offertnr === `OF-${YEAR}-0001`);
  const hk2 = await mk({ kategori: "Housekeeping" });
  ok("nästa HK räknar upp korrekt (0004 → 0005)", hk2.body.offertnr === `HK-${YEAR}-0005`);
  // ⚠️ Serierna får ALDRIG dela löpnummer.
  ok("serierna är oberoende av varandra",
     hk.body.offertnr !== fe.body.offertnr && sp.body.offertnr !== of.body.offertnr);

  // ── Kategori ─────────────────────────────────────────────────────────────
  ok("kategorin skrivs till Offert", created.filter((c) => c.t === "Offert").pop().payload.kategori === "Housekeeping");
  const std = await mk({});
  ok("utan kategori → Food & Event (bakåtkompatibelt, befintlig serie orörd)",
     std.body.kategori === "Food & Event" && /^FE-/.test(std.body.offertnr));
  // ⚠️ `Service & People` heter INTE `Staff` — fel värde ger 400 från Bubble.
  const bad = await mk({ kategori: "Staff" });
  ok("okänd kategori → 400 med allowed (fångas före Bubble)",
     bad.code === 400 && bad.body.error === "okand_kategori" &&
     (bad.body.allowed || []).indexOf("Service & People") > -1 &&
     (bad.body.allowed || []).indexOf("Staff") < 0);
  // ⚠️ `source` ska vara ORÖRD — den används av listan och order-konverteringen.
  ok("source lämnas oförändrad (mira_fe = 'skapad i Mira', inte kategori)",
     created.filter((c) => c.t === "Offert").every((c) => c.payload.source === "mira_fe"));

  // ── Nytt Bubble-fält saknas → offerten måste ändå gå att spara ───────────
  const r2 = { get: {}, post: {}, patch: {}, delete: {}, options: {} };
  const app2 = { get: (p, ...a) => { r2.get[p] = a[a.length - 1]; }, post: (p, ...a) => { r2.post[p] = a[a.length - 1]; }, patch: (p, ...a) => { r2.patch[p] = a[a.length - 1]; }, delete: (p, ...a) => { r2.delete[p] = a[a.length - 1]; }, options: (p, ...a) => { r2.options[p] = a[a.length - 1]; } };
  let noKat = null;
  registerOffertRoutes(app2, Object.assign({}, baseDeps, {
    bubbleCreate: async (t, payload) => {
      if (t === "Offert" && payload && payload.kategori !== undefined) {
        const e = new Error("bubbleCreate failed");
        e.detail = { status: 400, body: JSON.stringify({ body: { message: "Unrecognized field: kategori" } }) };
        throw e;
      }
      noKat = payload; return baseDeps.bubbleCreate(t, payload);
    },
  }));
  const miss = await call(r2, "post", "/admin/offert/create", { body: { kundforetag: "cc1", rows: [], kategori: "Housekeeping" } });
  ok("saknat kategori-fält: offerten sparas ändå + rapporteras",
     miss.body.ok === true && miss.body.kategori_field_missing === true);
  // ⚠️ Numret sätts ur kategorin FÖRE skrivningen → rätt serie även om fältet saknas.
  ok("saknat kategori-fält: numret följer ändå rätt serie",
     /^HK-/.test(miss.body.offertnr) && noKat && noKat.kategori === undefined);
  // ⚠️ Ett ANNAT okänt fält måste fortfarande braka.
  const r3 = { get: {}, post: {}, patch: {}, delete: {}, options: {} };
  registerOffertRoutes({ get: (p, ...a) => { r3.get[p] = a[a.length - 1]; }, post: (p, ...a) => { r3.post[p] = a[a.length - 1]; }, patch: () => {}, delete: () => {}, options: () => {} },
    Object.assign({}, baseDeps, { bubbleCreate: async () => { const e = new Error("bubbleCreate failed"); e.detail = { status: 400, body: JSON.stringify({ body: { message: "Unrecognized field: nagot_annat" } }) }; throw e; } }));
  const other = await call(r3, "post", "/admin/offert/create", { body: { kundforetag: "cc1", rows: [], kategori: "Housekeeping" } });
  ok("annat okänt fält braker fortfarande (nedgraderingen matchar smalt)", other.body.ok !== true);

  // ⚠️ Option set läses tillbaka som sträng ELLER {display}-objekt. Utan
  // OS-medveten läsning blir objektformen "[object Object]" → tolkas som okänd
  // kategori och PDF-rubriken degraderar tyst till Food & Event på en HK-offert.
  DB.Offert.push({ _id: "oOS", source: "mira_fe", offertnr: `HK-${YEAR}-0009`, kategori: { display: "Housekeeping" }, kundforetag: "cc1", "Created Date": "2026-08-20" });
  const osPatch = await call(routes, "patch", "/admin/offert/:id", { params: { id: "oOS" }, body: { titel: "Rör inte kategorin" } });
  ok("option set som {display}-objekt: patch går igenom utan att slå om kategorin",
     osPatch.body.ok === true && osPatch.body.offertnr_behalls === undefined);
  const osKeep = await call(routes, "patch", "/admin/offert/:id", { params: { id: "oOS" }, body: { kategori: "Housekeeping" } });
  ok("option set som {display}-objekt: samma kategori flaggas INTE som serieavvikelse",
     osKeep.body.ok === true && osKeep.body.offertnr_behalls === undefined);

  // ── Kategoribyte i efterhand behåller numret ─────────────────────────────
  // ⚠️ Ett utfärdat offertnummer är en IDENTITET. Byter man serie i efterhand pekar
  // utskickade PDF:er och signeringar på ett nummer som inte finns.
  const pat = await call(routes, "patch", "/admin/offert/:id", { params: { id: "o1" }, body: { kategori: "Housekeeping" } });
  ok("kategoribyte: numret behålls och avvikelsen redovisas",
     pat.body.ok === true && pat.body.offertnr_behalls &&
     pat.body.offertnr_behalls.offertnr === `FE-${YEAR}-0007` &&
     DB.Offert.find((o) => o._id === "o1").offertnr === `FE-${YEAR}-0007`);
  const patBad = await call(routes, "patch", "/admin/offert/:id", { params: { id: "o1" }, body: { kategori: "Staff" } });
  ok("kategoribyte: okänt värde → 400 även på patch", patBad.code === 400 && patBad.body.error === "okand_kategori");

  // ── FRONTEND ─────────────────────────────────────────────────────────────
  const aoRaw = readFileSync(new URL("./mira-offert-admin.html", import.meta.url), "utf8");
  const ao = aoRaw.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  ok("frontend: lägena heter efter räckvidd",
     />Offert Food &amp; Event</.test(ao) && />Offert Allmän</.test(ao) && !/>Strukturerad offert</.test(ao));
  ok("frontend: kategoriväljare finns i Allmän-läget",
     /data-ao="f-kategori"/.test(ao) && /kategori:/.test(ao));
  // ⚠️ F&E-läget bygger av F&E-artiklar → kategorin är låst där.
  ok("frontend: kategorin är låst till Food & Event i strukturerat läge",
     /katLocked|kategori-lock|f-kategori"\)\.disabled/.test(ao));
  ok("frontend: underrubriken följer läget", /function subText\(\)/.test(ao) && /Allmän/.test(ao));
  // ⚠️ En icke-F&E-affär ska INTE mötas av ett artikelsök som aldrig hittar något.
  ok("frontend: icke-F&E-affär startar direkt i Allmän-läget",
     /PREF_KAT && PREF_KAT !== "Food & Event"\) \? "uppladdad" : "strukturerad"/.test(ao) &&
     /\$\("f-kategori"\)\.value=PREF_KAT/.test(ao));
  const af = readFileSync(new URL("./mira-affar-samlad.html", import.meta.url), "utf8");
  // ⚠️ Flera kategorier på affären → gissa inte, låt människan välja.
  ok("affärsvyn: ärver kategorin bara när den är ENTYDIG",
     /kats\.length===1\?kats\[0\]:""/.test(af));



  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
