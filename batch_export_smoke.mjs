// Smoke: multidok-batch-export (samtliga ordrar i intervall → ETT PDF). node batch_export_smoke.mjs
import { registerOffertRoutes } from "./offert_api.js";
import { registerProduktionRoutes } from "./produktion_api.js";

const TS = (d) => new Date(d + "T00:00:00.000Z").getTime() + 12 * 3600000;   // mitt på dagen
const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB", Org_Number: "5560001111", Adress: "Storgatan 1" }, { _id: "cc2", Name_company: "Beta AB" }],
  Kok: [{ _id: "k1", namn: "Epicenter", aktiv: true }, { _id: "k2", namn: "Söder", aktiv: true }],
  User: [{ _id: "u1", "First Name": "Anna", "Surname": "Andersson" }, { _id: "u2", "First Name": "Bertil", "Surname": "Berg" }],
  deal: [{ _id: "d1", deal_owner: ["u1"] }],
  Offert: [{ _id: "off1", deal: "d1" }],
  MiraOrder: [
    { _id: "o1", source: "mira_fe", ordernr: "FE-1", kundforetag: "cc1", orderstatus: "Bekräftad", leverans_ts: TS("2026-08-12"), leveransdatum: "2026-08-12", leveranstid: "12:00", leveransadress: "Kungsgatan 1", offert: "off1", valuta: "SEK", intern_instruktion: "Var på plats 10:30!" },
    { _id: "o2", source: "mira_fe", ordernr: "FE-2", kundforetag: "cc2", orderstatus: "I produktion", leverans_ts: TS("2026-08-12"), leveransdatum: "2026-08-12", leveranstid: "11:30", var_referens: "u2" },
    { _id: "o3", source: "mira_fe", ordernr: "FE-3", kundforetag: "cc1", orderstatus: "Levererad", leverans_ts: TS("2026-08-13"), leveransdatum: "2026-08-13", leveranstid: "09:00", offert: "off1" },
    { _id: "o4", source: "mira_fe", ordernr: "FE-4", kundforetag: "cc1", orderstatus: "Bekräftad", leverans_ts: TS("2026-08-20"), leveransdatum: "2026-08-20" },   // utanför intervall
    { _id: "oF", source: "fortnox", ordernr: "40718", leverans_ts: TS("2026-08-12") },   // ej mira → exkluderas
  ],
  MiraOrderRad: [
    { _id: "r1", order: "o1", radnr: 1, benamning: "Landgång", antal: 20, enhet: "st", apris: 100, moms: 12, kok: "k1", prep_kategori: "Frallor" },
    { _id: "r2", order: "o1", radnr: 2, benamning: "Grön sallad", antal: 15, enhet: "port", apris: 40, moms: 12, kok: "k1", prep_kategori: "Sallad" },
    { _id: "r3", order: "o2", radnr: 1, benamning: "Räksallad", antal: 30, enhet: "port", apris: 60, moms: 12, kok: "k1", prep_kategori: "Sallad" },   // aggregeras med r2 (k1/Sallad)
    { _id: "r4", order: "o2", radnr: 2, benamning: "Kyckling", antal: 25, enhet: "port", apris: 90, moms: 12, kok: "k2", prep_kategori: "Varm lunch" },
    { _id: "r5", order: "o1", radnr: 3, benamning: "Kaka", antal: 40, enhet: "st", apris: 20, moms: 12, kok: "", prep_kategori: "Konditori" },   // Ej tilldelat kök
    { _id: "r6", order: "o3", radnr: 1, benamning: "Frukostfralla", antal: 10, enhet: "st", apris: 30, moms: 12, kok: "k1", prep_kategori: "Frallor" },
  ],
};
const _n = (v) => (typeof v === "number" ? v : parseFloat(v));
const _match = (r, c) => { const v = r[c.key];
  if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value);
  if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v));
  if (c.constraint_type === "greater than") return _n(v) > _n(c.value);
  if (c.constraint_type === "less than") return _n(v) < _n(c.value);
  return true; };
let captured = null;
const bubbleMocks = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFind: async (t, { constraints = [], limit = 300 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFindOne: async (t, cs = []) => (DB[t] || []).find((r) => cs.every((c) => _match(r, c))) || null,
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCreate: async () => "new", bubblePatch: async () => ({}), bubbleDelete: async () => ({}), bubbleCount: async (t) => (DB[t] || []).length,
};
const contractRenderEngine = { renderAndPersist: async ({ templateHtml, titel }) => { captured = { titel, html: templateHtml }; return { file_url: "//cdn/" + encodeURIComponent(titel) + ".pdf", dokument_id: "doc1", bytes: templateHtml.length }; } };
const noApp = () => ({ get() {}, post() {}, options() {}, patch() {} });
const offertEngine = registerOffertRoutes(noApp(), { ...bubbleMocks, contractRenderEngine, planningAuthed: () => true, planningCors: () => {}, FE_CONNECTION_ID: "FE" });

// produktion-route med export wired
const routes = { get: {}, post: {}, options: {} };
const app2 = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
registerProduktionRoutes(app2, { ...bubbleMocks, planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x", renderBatchExport: (o) => offertEngine.renderBatchExport(o) });
function callGet(path, query = {}) { const h = routes.get[path]; return new Promise((resolve) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { resolve({ code: this._c, body: o }); } }; h({ params: {}, query, body: {}, headers: {} }, res); }); }

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
const count = (h, re) => (h.match(re) || []).length;

const run = async () => {
  // ── full export (alla delar) för intervall 12–13 aug ──
  const ex = await offertEngine.renderBatchExport({ from: "2026-08-12", to: "2026-08-13" });
  ok("export ok + file_url", ex.ok && /Export/.test(ex.file_url));
  ok("3 mira-ordrar (o4 utanför + oF fortnox exkluderade)", ex.order_count === 3);
  const h = captured.html;
  ok("innehåller Leveranslista", /Leveranslista/.test(h) && /class="be-list"/.test(h));
  ok("leveranslista har alla 3 ordrarna", /FE-1/.test(h) && /FE-2/.test(h) && /FE-3/.test(h) && !/FE-4/.test(h));
  ok("innehåller Prep-lista per kök", /Prep-lista per kök/.test(h));
  ok("prep aggregerar k1/Sallad 15+30=45", /Sallad/.test(h) && /45 st/.test(h));
  ok("prep visar Ej tilldelat kök (kaka)", /Ej tilldelat kök/.test(h) && /Konditori/.test(h));
  ok("Kök-PM: en Produktions-PM per order (3 st)", count(h, /Produktions-PM/g) === 3);
  ok("Orderbekräftelse: en per order (3 st)", count(h, /Orderbekräftelse/g) === 3);
  ok("sidbrytnings-sektioner (be-sec) finns", count(h, /class="be-sec/g) >= 3 + 3 + 2);   // list+prep + 3 pm + 3 order
  ok("ansvarig: Anna (o1 via offert→deal) + Bertil (o2 override)", /Anna Andersson/.test(h) && /Bertil Berg/.test(h));
  ok("kombinerad style: både .o- och .pm- klasser i head", /\.o-lev/.test(h) && /\.pm-lev/.test(h) && /\.be-sec/.test(h));

  // ── parts-filter: bara leveranslista ──
  const exL = await offertEngine.renderBatchExport({ from: "2026-08-12", to: "2026-08-13", parts: "list" });
  const hL = captured.html;
  ok("parts=list: har Leveranslista utan PM/order", exL.ok && /Leveranslista/.test(hL) && !/Produktions-PM/.test(hL) && !/Orderbekräftelse/.test(hL));

  // ── parts=prep,pm ──
  await offertEngine.renderBatchExport({ from: "2026-08-12", to: "2026-08-13", parts: ["prep", "pm"] });
  const hPP = captured.html;
  ok("parts=prep,pm: prep+PM men ingen leveranslista/orderbekräftelse", /Prep-lista/.test(hPP) && /Produktions-PM/.test(hPP) && !/class="be-list"/.test(hPP) && !/Orderbekräftelse/.test(hPP));

  // ── enkel dag (date=) ──
  const exD = await offertEngine.renderBatchExport({ date: "2026-08-13" });
  ok("date=2026-08-13: bara o3 (FE-3)", exD.order_count === 1 && /FE-3/.test(captured.html) && !/FE-1/.test(captured.html));

  // ── tom period → ok + 0 ──
  const exE = await offertEngine.renderBatchExport({ date: "2026-01-01" });
  ok("tom period → ok, 0 ordrar, meddelande", exE.ok && exE.order_count === 0 && /Inga ordrar/.test(captured.html));

  // ── saknad period → fel ──
  const exX = await offertEngine.renderBatchExport({});
  ok("saknad period → period_krävs", !exX.ok && exX.error === "period_krävs");

  // ── produktion-route ──
  const rt = await callGet("/admin/produktion/export", { from: "2026-08-12", to: "2026-08-13" });
  ok("route /export → https-url + order_count", rt.body.ok && /^https:\/\/cdn\//.test(rt.body.file_url) === false && /cdn/.test(rt.body.file_url) && rt.body.order_count === 3);
  const rtBad = await callGet("/admin/produktion/export", {});
  ok("route utan period → 400", rtBad.code === 400 && rtBad.body.error === "period_krävs");

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
