// Smoke: order-redigering. node affar_order_smoke.mjs
import { registerAffarRoutes } from "./affar_api.js";

const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
function call(method, path, { params = {}, body = {}, query = {} } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((resolve) => { const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); }, sendStatus(c) { resolve({ code: c }); } }; h({ params, body, query, headers: {} }, res); });
}

let idseq = 100;
const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }],
  Kok: [{ _id: "k1", namn: "Varmkök Söder", aktiv: true }, { _id: "k2", namn: "Kallskänk Nord", aktiv: true }],
  MiraOrder: [
    { _id: "moM", source: "mira_fe", ordernr: "FE-2026-0001", orderdatum: "2026-07-06", orderstatus: "Bekräftad", kundforetag: "cc1", leveransdatum: "2026-07-20", leverans_ts: Date.parse("2026-07-20T00:00:00Z"), leveranstid: "12:00", betalningsvillkor: "10 dagar", momstyp: "SEVAT", valuta: "SEK", summa: 1000, moms_belopp: 120, total: 1120, offert: "off1", villkor_text: "" },
    { _id: "moF", source: "fortnox", ordernr: "40718", ft_customer_name: "Beta" },
  ],
  MiraOrderRad: [
    { _id: "r1", order: "moM", radnr: 1, benamning: "Lunch", antal: 10, enhet: "st", apris: 100, rabatt: 0, moms: 12, radsumma: 1000, kok: "k1", prep_kategori: "Varmkök", leverans_ts: Date.parse("2026-07-20T00:00:00Z") },
  ],
};
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); return true; };
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFind: async (t, { constraints = [], limit = 300 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCount: async (t) => (DB[t] || []).length,
  bubblePatch: async (t, id, p) => { const r = (DB[t] || []).find((x) => x._id === id); if (r) Object.assign(r, p); return {}; },
  bubbleCreate: async (t, p) => { const id = "new" + (idseq++); (DB[t] = DB[t] || []).push({ _id: id, ...p }); return id; },
  bubbleDelete: async (t, id) => { DB[t] = (DB[t] || []).filter((r) => r._id !== id); return {}; },
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE", CONNECTION_NAMES: { FE: "Food & Event" },
  offertConvert: async () => ({ ok: true }),
};
registerAffarRoutes(app, deps);

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  // ── koks ──
  const ks = await call("get", "/admin/affar/koks");
  ok("koks: 2 kök sorterade", ks.body.ok && ks.body.rows.length === 2 && ks.body.rows[0].namn === "Kallskänk Nord");

  // ── GET order ──
  const g = await call("get", "/admin/affar/order/:id", { params: { id: "moM" } });
  ok("GET order ok", g.body.ok);
  ok("order huvud (ordernr/leveransdatum/status)", g.body.order.ordernr === "FE-2026-0001" && g.body.order.leveransdatum === "2026-07-20" && g.body.order.orderstatus === "Bekräftad");
  ok("order rad + kök-namn upplöst", g.body.rows.length === 1 && g.body.rows[0].kok_namn === "Varmkök Söder" && g.body.rows[0].radsumma === 1000);
  ok("status_options + koks medskickade", g.body.status_options.includes("I produktion") && g.body.koks.length === 2);

  // ── GET Fortnox-order → 400 ej redigerbar ──
  const gf = await call("get", "/admin/affar/order/:id", { params: { id: "moF" } });
  ok("Fortnox-order → 400 ej_mira_order", gf.code === 400 && gf.body.error === "ej_mira_order");

  // ── huvud-patch: ändra leveransdatum → rad-leverans_ts uppdateras ──
  const ph = await call("post", "/admin/affar/order/:id/patch", { params: { id: "moM" }, body: { leveransdatum: "2026-08-01", orderstatus: "I produktion" } });
  const newTs = Date.parse("2026-08-01T00:00:00.000Z");
  ok("huvud-patch ok + 1 rad touched", ph.body.ok && ph.body.rows_touched === 1);
  ok("order leverans_ts uppdaterat", DB.MiraOrder.find((o) => o._id === "moM").leverans_ts === newTs);
  ok("rad leverans_ts propagerat", DB.MiraOrderRad.find((r) => r._id === "r1").leverans_ts === newTs);
  ok("orderstatus satt", DB.MiraOrder.find((o) => o._id === "moM").orderstatus === "I produktion");

  // ── rad-patch: ändra antal + kök → radsumma + totaler räknas om ──
  const pr = await call("post", "/admin/affar/order/row/:rowId/patch", { params: { rowId: "r1" }, body: { antal: 20, kok_id: "k2" } });
  ok("rad-patch radsumma 20*100=2000", pr.body.ok && pr.body.radsumma === 2000);
  ok("rad-patch kök-namn upplöst", pr.body.kok_namn === "Kallskänk Nord");
  ok("totaler omräknade (summa 2000, moms 240, total 2240)", pr.body.totals.summa === 2000 && pr.body.totals.moms_belopp === 240 && pr.body.totals.total === 2240);
  ok("rad kök bytt i DB", DB.MiraOrderRad.find((r) => r._id === "r1").kok === "k2");

  // ── add row → radnr 2 + totaler ──
  const ar = await call("post", "/admin/affar/order/:id/row/add", { params: { id: "moM" }, body: { benamning: "Dryck", antal: 5, apris: 50, moms: 12, kok_id: "k1", prep_kategori: "Dryck" } });
  ok("add row radnr 2 + radsumma 250", ar.body.ok && ar.body.radnr === 2 && ar.body.radsumma === 250);
  ok("add row totaler (2000+250=2250)", ar.body.totals.summa === 2250 && ar.body.totals.total === _round2ext(2250 + 2250 * 0.12));
  ok("2 rader i DB för moM", DB.MiraOrderRad.filter((r) => r.order === "moM").length === 2);

  // ── delete row → tillbaka till 1 rad ──
  const newRowId = ar.body.row_id;
  const dr = await call("post", "/admin/affar/order/row/:rowId/delete", { params: { rowId: newRowId } });
  ok("delete row ok + totaler tillbaka (summa 2000)", dr.body.ok && dr.body.totals.summa === 2000);
  ok("1 rad kvar för moM", DB.MiraOrderRad.filter((r) => r.order === "moM").length === 1);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
function _round2ext(n) { return Math.round(n * 100) / 100; }
run().catch((e) => { console.error(e); process.exit(1); });
