// Smoke: produktions-dagsvy + reassign. node produktion_smoke.mjs
import { registerProduktionRoutes } from "./produktion_api.js";
const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
function call(method, path, { params = {}, query = {}, body = {} } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }; h({ params, query, body, headers: {} }, res); });
}
const TS = (d) => new Date(d + "T00:00:00.000Z").getTime() + 12 * 3600000;   // mitt på dagen
const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }, { _id: "cc2", Name_company: "Beta AB" }],
  Kok: [{ _id: "k1", namn: "Epicenter", aktiv: true }, { _id: "k2", namn: "Söder", aktiv: true }],
  User: [{ _id: "u1", "First Name": "Anna", "Surname": "Andersson" }],
  deal: [{ _id: "d1", deal_owner: ["u1"] }],
  Offert: [{ _id: "off1", deal: "d1" }],
  MiraOrder: [
    { _id: "o1", source: "mira_fe", ordernr: "FE-1", kundforetag: "cc1", orderstatus: "Bekräftad", leverans_ts: TS("2026-08-12"), leveranstid: "12:00", offert: "off1" },
    { _id: "o2", source: "mira_fe", ordernr: "FE-2", kundforetag: "cc2", orderstatus: "I produktion", leverans_ts: TS("2026-08-12"), leveranstid: "11:30" },
    { _id: "o3", source: "mira_fe", ordernr: "FE-3", kundforetag: "cc1", orderstatus: "Levererad", leverans_ts: TS("2026-08-12") },   // fel status → exkluderas
    { _id: "o4", source: "mira_fe", ordernr: "FE-4", kundforetag: "cc1", orderstatus: "Bekräftad", leverans_ts: TS("2026-08-13") },   // fel dag → exkluderas
  ],
  MiraOrderRad: [
    { _id: "r1", order: "o1", benamning: "Landgång", antal: 20, enhet: "st", kok: "k1", prep_kategori: "Frallor" },
    { _id: "r2", order: "o1", benamning: "Grön sallad", antal: 15, enhet: "port", kok: "k1", prep_kategori: "Sallad" },
    { _id: "r3", order: "o2", benamning: "Räksallad", antal: 30, enhet: "port", kok: "k1", prep_kategori: "Sallad" },   // samma kök+kategori som r2 → aggregeras
    { _id: "r4", order: "o2", benamning: "Varmrätt kyckling", antal: 25, enhet: "port", kok: "k2", prep_kategori: "Varm lunch" },
    { _id: "r5", order: "o1", benamning: "Kaka", antal: 40, enhet: "st", kok: "", prep_kategori: "Konditori" },   // inget kök → Ej tilldelat
    { _id: "rX", order: "o3", benamning: "Skippas", antal: 99, kok: "k1", prep_kategori: "Frallor" },   // order fel status
  ],
};
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v)); if (c.constraint_type === "greater than") return _n(v) > _n(c.value); if (c.constraint_type === "less than") return _n(v) < _n(c.value); return true; };
const _n = (v) => (typeof v === "number" ? v : parseFloat(v));
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFind: async (t, { constraints = [], limit = 300 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubblePatch: async (t, id, p) => { const r = (DB[t] || []).find((x) => x._id === id); if (r) Object.assign(r, p); return {}; },
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
};
registerProduktionRoutes(app, deps);
let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  const d = await call("get", "/admin/produktion/dag", { query: { date: "2026-08-12" } });
  ok("dag ok", d.body.ok);
  ok("2 ordrar (fel status + fel dag exkluderade)", d.body.order_count === 2);
  ok("5 rader (rX exkluderad, order fel status)", d.body.row_count === 5);
  const byId = (id) => d.body.koks.find((k) => k.kok_id === id);
  const k1 = byId("k1"), k2 = byId("k2"), none = byId("");
  ok("kök k1 (Epicenter) finns", k1 && k1.kok_namn === "Epicenter");
  const k1Sallad = k1 && k1.prep.find((p) => p.kategori === "Sallad");
  ok("k1 Sallad aggregerad 15+30=45", k1Sallad && k1Sallad.total_antal === 45 && k1Sallad.items.length === 2);
  const k1Frallor = k1 && k1.prep.find((p) => p.kategori === "Frallor");
  ok("k1 Frallor 20 (Landgång, med ordernr+företag)", k1Frallor && k1Frallor.total_antal === 20 && k1Frallor.items[0].order_nr === "FE-1" && k1Frallor.items[0].company === "Acme AB");
  ok("kök k2 Varm lunch 25", k2 && k2.prep.find((p) => p.kategori === "Varm lunch").total_antal === 25);
  ok("Ej tilldelat kök (kaka) finns + sist", none && none.kok_namn === "Ej tilldelat kök" && d.body.koks[d.body.koks.length - 1].kok_id === "");
  ok("koklist (2 kök) medskickad för fördelning", d.body.koklist.length === 2);

  // date saknas → 400
  const bad = await call("get", "/admin/produktion/dag", { query: {} });
  ok("date saknas → 400", bad.code === 400);

  // ── vår referens (ansvarig) + leveranstid per rad ──
  const frItem = k1.prep.find((p) => p.kategori === "Frallor").items[0];
  ok("item ansvarig = deal-ägare (Anna Andersson via off1→d1→u1)", frItem.ansvarig === "Anna Andersson");
  ok("item leveranstid från order (12:00)", frItem.leveranstid === "12:00");

  // ── order-vy (orders-lista) ──
  ok("orders-lista: 2 ordrar", d.body.orders.length === 2);
  const oFE1 = d.body.orders.find((o) => o.ordernr === "FE-1");
  ok("order FE-1: ansvarig + leveranstid + köks + antal", oFE1 && oFE1.ansvarig === "Anna Andersson" && oFE1.leveranstid === "12:00" && oFE1.total_antal === 75 && oFE1.koks.length >= 1);

  // ── status-avcheckning ──
  const st = await call("post", "/admin/produktion/order/:id/status", { params: { id: "o1" }, body: { status: "Levererad" } });
  ok("status → Levererad", st.body.ok && DB.MiraOrder.find((o) => o._id === "o1").orderstatus === "Levererad");
  const st0 = await call("post", "/admin/produktion/order/:id/status", { params: { id: "o1" }, body: { status: "Trams" } });
  ok("ogiltig status → 400", st0.code === 400);
  // efter Levererad → o1 försvinner ur dagsvyn (bara o2 kvar)
  const d2 = await call("get", "/admin/produktion/dag", { query: { date: "2026-08-12" } });
  ok("o1 (Levererad) borta ur dagsvyn → 1 order kvar", d2.body.order_count === 1);

  // reassign rad r5 (kaka) → k2
  const mv = await call("post", "/admin/produktion/rad/:id/kok", { params: { id: "r5" }, body: { kok_id: "k2" } });
  ok("reassign rad → k2 (Söder)", mv.body.ok && mv.body.kok_namn === "Söder" && DB.MiraOrderRad.find((r) => r._id === "r5").kok === "k2");

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
