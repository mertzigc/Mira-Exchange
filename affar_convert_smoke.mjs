// Smoke: Mira offert→order convert + orderstatus-berikning. node affar_convert_smoke.mjs
import { registerAffarRoutes } from "./affar_api.js";

const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
function call(method, path, { params = {}, query = {}, body = {} } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((resolve) => { const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); }, sendStatus(c) { resolve({ code: c }); } }; h({ params, query, body, headers: {} }, res); });
}

const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }],
  // FE-0001 har redan en order (mo1); FE-0002 saknar order; FF-9 = Fortnox-offert (ej konverterbar)
  Offert: [
    { _id: "offA", source: "mira_fe", status: "Sent", kundforetag: "cc1", offertnr: "FE-2026-0001", total: 20000, offertdatum: "2026-07-01", dokument: [] },
    { _id: "offB", source: "mira_fe", status: "Sent", kundforetag: "cc1", offertnr: "FE-2026-0002", total: 15000, offertdatum: "2026-07-02", dokument: [] },
    { _id: "offC", source: "fortnox_sync", status: "Sent", kundforetag: "cc1", offertnr: "SYNC-1", total: 5000, offertdatum: "2026-07-03", dokument: [] },
  ],
  FortnoxOffer: [{ _id: "ffX", ft_customer_name: "Acme AB", ft_document_number: "9", ft_total: 9000 }],
  MiraOrder: [{ _id: "mo1", offert: "offA", ordernr: "FE-2026-0001" }],
  FortnoxInvoice: [], FortnoxOrder: [], TengellaWorkorder: [], Contract: [], deal: [], Lead: [], activitet_crm: [], Todo: [], "leverantör-supplier": [], User: [], Dokument: [],
};
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v)); return true; };
let convertCalls = [];
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFind: async (t, { constraints = [], limit = 100, cursor = 0 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(cursor, cursor + limit),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCount: async (t, cs = []) => (DB[t] || []).filter((r) => cs.every((c) => _match(r, c))).length,
  bubblePatch: async () => ({}), bubbleCreate: async () => "new",
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE_CONN", CONNECTION_NAMES: { FE_CONN: "Food & Event" },
  // simulera offert_api-motorn: skapar order för offB, idempotent för offA (mo1 finns)
  offertConvert: async (id) => {
    convertCalls.push(id);
    if (id === "offA") return { ok: true, order_id: "mo1", created: false, reason: "already_converted" };
    if (id === "offB") { DB.MiraOrder.push({ _id: "mo2", offert: "offB", ordernr: "FE-2026-0002" }); return { ok: true, order_id: "mo2", created: true, rows_created: 3 }; }
    return { ok: false, error: "offert_not_found" };
  },
};
registerAffarRoutes(app, deps);

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  // ── berikning i /list type=offert ──
  const l = await call("get", "/admin/affar/list", { query: { type: "offert" } });
  ok("list ok", l.body.ok);
  const rowA = l.body.rows.find((r) => r.id === "offA");
  const rowB = l.body.rows.find((r) => r.id === "offB");
  const rowF = l.body.rows.find((r) => r.id === "ffX");
  ok("offA (konverterad) → order_id=mo1 + order_nr", rowA && rowA.order_id === "mo1" && rowA.order_nr === "FE-2026-0001");
  ok("offB (ej konverterad) → order_id null", rowB && rowB.order_id === null);
  ok("Fortnox-offert → source fortnox, ingen order_id-berikning", rowF && rowF.source === "fortnox" && !rowF.order_id);

  // ── convert offB → skapar order ──
  const c1 = await call("post", "/admin/affar/offert/:id/convert", { params: { id: "offB" } });
  ok("convert offB ok + created", c1.body.ok && c1.body.created === true && c1.body.order_id === "mo2");
  ok("convert offB order_nr", c1.body.order_nr === "FE-2026-0002");
  ok("offertConvert anropad med offB", convertCalls.includes("offB"));

  // ── convert offA (redan konverterad) → idempotent, created false ──
  const c2 = await call("post", "/admin/affar/offert/:id/convert", { params: { id: "offA" } });
  ok("convert offA idempotent (created false, reason)", c2.body.ok && c2.body.created === false && c2.body.reason === "already_converted");

  // ── convert Offert med source≠mira_fe → 400 ej_mira_offert ──
  const c3 = await call("post", "/admin/affar/offert/:id/convert", { params: { id: "offC" } });
  ok("convert sync-offert (source fortnox_sync) → 400 ej_mira_offert", c3.code === 400 && c3.body.error === "ej_mira_offert");

  // ── convert Fortnox-offert-id (finns ej i Offert) → 404 ──
  const c3b = await call("post", "/admin/affar/offert/:id/convert", { params: { id: "ffX" } });
  ok("convert Fortnox-offert-id → 404 (ej en Offert)", c3b.code === 404);

  // ── convert okänd → 404 ──
  const c4 = await call("post", "/admin/affar/offert/:id/convert", { params: { id: "nope" } });
  ok("convert okänd → 404", c4.code === 404);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
