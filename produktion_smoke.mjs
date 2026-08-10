// Smoke: produktions-dagsvy + reassign + #5 producerad/leveransklar + #6 Levererad stannar. node produktion_smoke.mjs
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
  User: [{ _id: "u1", "First Name": "Anna", "Surname": "Andersson" }, { _id: "u2", "First Name": "Bertil", "Surname": "Berg" }],
  deal: [{ _id: "d1", deal_owner: ["u1"] }],
  Offert: [{ _id: "off1", deal: "d1" }],
  MiraOrder: [
    { _id: "o1", source: "mira_fe", ordernr: "FE-1", kundforetag: "cc1", orderstatus: "Bekräftad", leverans_ts: TS("2026-08-12"), leveransdatum: "2026-08-12", leveranstid: "12:00", offert: "off1", klar_for_leverans: true },
    { _id: "o2", source: "mira_fe", ordernr: "FE-2", kundforetag: "cc2", orderstatus: "I produktion", leverans_ts: TS("2026-08-12"), leveransdatum: "2026-08-12", leveranstid: "11:30", var_referens: "u2" },   // #1 override (User = enkelt id)
    { _id: "o3", source: "mira_fe", ordernr: "FE-3", kundforetag: "cc1", orderstatus: "Levererad", leverans_ts: TS("2026-08-12"), leveransdatum: "2026-08-12" },   // #6: Levererad stannar (dimmad)
    { _id: "o4", source: "mira_fe", ordernr: "FE-4", kundforetag: "cc1", orderstatus: "Bekräftad", leverans_ts: TS("2026-08-13"), leveransdatum: "2026-08-13" },   // annan dag
  ],
  MiraOrderRad: [
    { _id: "r1", order: "o1", benamning: "Landgång", antal: 20, enhet: "st", kok: "k1", prep_kategori: "Frallor", producerad: true },   // #5 producerad
    { _id: "r2", order: "o1", benamning: "Grön sallad", antal: 15, enhet: "port", kok: "k1", prep_kategori: "Sallad" },
    { _id: "r3", order: "o2", benamning: "Räksallad", antal: 30, enhet: "port", kok: "k1", prep_kategori: "Sallad" },   // samma kök+kategori som r2 → aggregeras
    { _id: "r4", order: "o2", benamning: "Varmrätt kyckling", antal: 25, enhet: "port", kok: "k2", prep_kategori: "Varm lunch" },
    { _id: "r5", order: "o1", benamning: "Kaka", antal: 40, enhet: "st", kok: "", prep_kategori: "Konditori" },   // inget kök → Ej tilldelat
    { _id: "r6", order: "o3", benamning: "Frukostfralla", antal: 10, kok: "k1", prep_kategori: "Frallor" },   // #6: order Levererad men rad kvar
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
  renderOrderPdf: async (id, kind) => { const o = (DB.MiraOrder || []).find((x) => x._id === id); if (!o) return { ok: false, error: "order_not_found" }; if (o.source !== "mira_fe") return { ok: false, error: "ej_mira_order" }; return { ok: true, kind: kind === "pm" ? "pm" : "order", file_url: "//cdn/" + id + "-" + (kind || "order") + ".pdf", dokument_id: "d", bytes: 9 }; },
};
registerProduktionRoutes(app, deps);
let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  const d = await call("get", "/admin/produktion/dag", { query: { date: "2026-08-12" } });
  ok("dag ok", d.body.ok);
  ok("3 ordrar (o1+o2+o3; o4 fel dag) — #6 Levererad stannar", d.body.order_count === 3);
  ok("6 rader (inkl rad från Levererad order)", d.body.row_count === 6);
  const byId = (id) => d.body.koks.find((k) => k.kok_id === id);
  const k1 = byId("k1"), k2 = byId("k2"), none = byId("");
  ok("kök k1 (Epicenter) finns", k1 && k1.kok_namn === "Epicenter");
  const k1Sallad = k1 && k1.prep.find((p) => p.kategori === "Sallad");
  ok("k1 Sallad aggregerad 15+30=45", k1Sallad && k1Sallad.total_antal === 45 && k1Sallad.items.length === 2);
  const k1Frallor = k1 && k1.prep.find((p) => p.kategori === "Frallor");
  ok("k1 Frallor aggregerad 20+10=30 (2 items, o1+o3)", k1Frallor && k1Frallor.total_antal === 30 && k1Frallor.items.length === 2);
  ok("kök k2 Varm lunch 25", k2 && k2.prep.find((p) => p.kategori === "Varm lunch").total_antal === 25);
  ok("Ej tilldelat kök (kaka) finns + sist", none && none.kok_namn === "Ej tilldelat kök" && d.body.koks[d.body.koks.length - 1].kok_id === "");
  ok("koklist (2 kök) medskickad för fördelning", d.body.koklist.length === 2);

  // date saknas → 400
  const bad = await call("get", "/admin/produktion/dag", { query: {} });
  ok("date saknas → 400", bad.code === 400);

  // ── #5 producerad-flagga per rad ──
  const landgangItem = k1Frallor.items.find((it) => it.order_nr === "FE-1");
  ok("item r1 (Landgång) producerad=true", landgangItem && landgangItem.producerad === true);
  const salladItem = k1Sallad.items.find((it) => it.order_nr === "FE-1");
  ok("item r2 (Grön sallad) producerad=false", salladItem && salladItem.producerad === false);

  // ── #1 vår referens (override + deal-ägar-fallback) + leveranstid ──
  ok("item o1 ansvarig = deal-ägare (Anna Andersson via off1→d1→u1)", landgangItem.ansvarig === "Anna Andersson");
  ok("item o1 leveranstid från order (12:00)", landgangItem.leveranstid === "12:00");
  const raksItem = k1Sallad.items.find((it) => it.order_nr === "FE-2");
  ok("item o2 ansvarig = var_referens-override (Bertil Berg, ej deal-ägare)", raksItem && raksItem.ansvarig === "Bertil Berg");

  // ── order-vy (orders-lista) + #5/#6-fält ──
  ok("orders-lista: 3 ordrar", d.body.orders.length === 3);
  const oFE1 = d.body.orders.find((o) => o.ordernr === "FE-1");
  ok("order FE-1: ansvarig + leveranstid + antal", oFE1 && oFE1.ansvarig === "Anna Andersson" && oFE1.leveranstid === "12:00" && oFE1.total_antal === 75);
  ok("order FE-1: klar_for_leverans=true (#5)", oFE1 && oFE1.klar_for_leverans === true);
  ok("order FE-1: producerade=1 av 3 rader (#5)", oFE1 && oFE1.producerade === 1 && oFE1.row_count === 3);
  const oFE3 = d.body.orders.find((o) => o.ordernr === "FE-3");
  ok("order FE-3: levererad=true (#6 dimmad men kvar)", oFE3 && oFE3.levererad === true);
  ok("order FE-1: levererad=false", oFE1 && oFE1.levererad === false);

  // ── vecko-range (from/to) ──
  const rng = await call("get", "/admin/produktion/dag", { query: { from: "2026-08-12", to: "2026-08-13" } });
  ok("range from/to: 4 ordrar (o1+o2+o3 12/8, o4 13/8)", rng.body.range === true && rng.body.order_count === 4);
  ok("range echo:ar from/to", rng.body.from === "2026-08-12" && rng.body.to === "2026-08-13" && rng.body.date === null);

  // ── #5 POST producerad ──
  const pr = await call("post", "/admin/produktion/rad/:id/producerad", { params: { id: "r2" }, body: { producerad: true } });
  ok("producerad → true persist", pr.body.ok && DB.MiraOrderRad.find((r) => r._id === "r2").producerad === true);
  const pr0 = await call("post", "/admin/produktion/rad/:id/producerad", { params: { id: "r2" }, body: { producerad: false } });
  ok("producerad → false persist", pr0.body.ok && DB.MiraOrderRad.find((r) => r._id === "r2").producerad === false);

  // ── #5 POST leveransklar ──
  const lk = await call("post", "/admin/produktion/order/:id/leveransklar", { params: { id: "o2" }, body: { klar: true } });
  ok("leveransklar → true persist", lk.body.ok && DB.MiraOrder.find((o) => o._id === "o2").klar_for_leverans === true);

  // ── status-avcheckning + #6: Levererad stannar i dagsvyn ──
  const st = await call("post", "/admin/produktion/order/:id/status", { params: { id: "o1" }, body: { status: "Levererad" } });
  ok("status → Levererad", st.body.ok && DB.MiraOrder.find((o) => o._id === "o1").orderstatus === "Levererad");
  const st0 = await call("post", "/admin/produktion/order/:id/status", { params: { id: "o1" }, body: { status: "Trams" } });
  ok("ogiltig status → 400", st0.code === 400);
  const d2 = await call("get", "/admin/produktion/dag", { query: { date: "2026-08-12" } });
  ok("#6: o1 (Levererad) STANNAR i dagsvyn → fortf. 3 ordrar", d2.body.order_count === 3);
  const o1After = d2.body.orders.find((o) => o.ordernr === "FE-1");
  ok("#6: o1 nu levererad=true (dimmas i UI, Ångra-knapp)", o1After && o1After.levererad === true);

  // ── #6 Ångra: status → I produktion ──
  const undo = await call("post", "/admin/produktion/order/:id/status", { params: { id: "o1" }, body: { status: "I produktion" } });
  ok("ångra leverans → I produktion", undo.body.ok && DB.MiraOrder.find((o) => o._id === "o1").orderstatus === "I produktion");

  // reassign rad r5 (kaka) → k2
  const mv = await call("post", "/admin/produktion/rad/:id/kok", { params: { id: "r5" }, body: { kok_id: "k2" } });
  ok("reassign rad → k2 (Söder)", mv.body.ok && mv.body.kok_namn === "Söder" && DB.MiraOrderRad.find((r) => r._id === "r5").kok === "k2");

  // ── order-PDF-route (ladda hem/kika) ──
  const pdf = await call("get", "/admin/produktion/order/:id/pdf", { params: { id: "o1" }, query: {} });
  ok("order-PDF default kind=order → file_url", pdf.body.ok && pdf.body.kind === "order" && /o1-order\.pdf/.test(pdf.body.file_url));
  const pdfPm = await call("get", "/admin/produktion/order/:id/pdf", { params: { id: "o1" }, query: { kind: "pm" } });
  ok("order-PDF kind=pm → pm-fil", pdfPm.body.ok && pdfPm.body.kind === "pm" && /o1-pm\.pdf/.test(pdfPm.body.file_url));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
