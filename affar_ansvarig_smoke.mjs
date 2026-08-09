// Smoke: ansvarig/skapare-kolumn + datum-filter. node affar_ansvarig_smoke.mjs
import { registerAffarRoutes } from "./affar_api.js";
const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
function call(path, { query = {} } = {}) { const h = routes.get[path]; return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }; h({ query, params: {}, body: {}, headers: {} }, res); }); }

const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }],
  User: [{ _id: "u1", "First Name": "Sara", "Last Name": "Säljare" }, { _id: "u2", "First Name": "Per", "Last Name": "Planerare" }],
  deal: [{ _id: "d1", titel: "Acme lunch", "kundföretag": "cc1", Status: "Offert", value_brutto: 5000, deal_owner: ["u2"], Kategori: ["Food & Event"], "Created Date": "2026-07-01" }],
  Lead: [{ _id: "l1", Name: "Kalle", Company: "cc1", "Created By": "u1", "Created Date": "2026-07-10" }],
  activitet_crm: [{ _id: "a1", beskrivning: "Ringde", company: "cc1", writer: "u1", "Created Date": "2026-07-11" }],
  Offert: [{ _id: "o1", source: "mira_fe", offertnr: "FE-1", kundforetag: "cc1", total: 2000, deal: "d1", "Created Date": "2026-07-12" }],
  FortnoxOffer: [],
  MiraOrder: [{ _id: "mo1", source: "mira_fe", ordernr: "FE-1", kundforetag: "cc1", total: 2000, deal: "d1", "Created Date": "2026-07-13" }],
  FortnoxOrder: [], TengellaWorkorder: [],
  FortnoxInvoice: [{ _id: "inv1", ft_customer_name: "Acme AB", ft_document_number: "F-1", ft_total: 2000, ft_our_reference: "Sara S", connection: "FE", "Created Date": "2026-07-14" }],
  Contract: [{ _id: "c1", contract_title: "Ramavtal", "kundföretag": "cc1", "månadskostnad": 1000, deal: "d1", "Created Date": "2026-07-15" }],
  Todo: [], "leverantör-supplier": [],
};
let lastConstraints = {};
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v)); if (c.constraint_type === "greater than") return Date.parse(v) > Date.parse(c.value); if (c.constraint_type === "less than") return Date.parse(v) < Date.parse(c.value); return true; };
const rec = (t, cs) => { lastConstraints[t] = (lastConstraints[t] || []).concat(cs); };
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => { rec(t, constraints); return (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))); },
  bubbleFind: async (t, { constraints = [], limit = 30, cursor = 0 } = {}) => { rec(t, constraints); return (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(cursor, cursor + limit); },
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCount: async (t) => (DB[t] || []).length,
  bubblePatch: async () => ({}), bubbleCreate: async () => "n", bubbleDelete: async () => ({}),
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE", CONNECTION_NAMES: { FE: "Food & Event" }, offertConvert: async () => ({}), renderOrderPdf: async () => ({}),
};
registerAffarRoutes(app, deps);

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
const run = async () => {
  const lead = await call("/admin/affar/list", { query: { type: "lead" } });
  ok("lead ansvarig = skapare (Sara Säljare)", lead.body.rows[0].ansvarig === "Sara Säljare");
  const akt = await call("/admin/affar/list", { query: { type: "aktivitet" } });
  ok("aktivitet ansvarig = writer (Sara Säljare)", akt.body.rows[0].ansvarig === "Sara Säljare");
  const affar = await call("/admin/affar/list", { query: { type: "affar" } });
  ok("affär ansvarig = deal_owner (Per Planerare)", affar.body.rows[0].ansvarig === "Per Planerare");
  const off = await call("/admin/affar/list", { query: { type: "offert" } });
  ok("offert ansvarig = affärens ägare via deal (Per Planerare)", off.body.rows.find((r) => r.id === "o1").ansvarig === "Per Planerare");
  const ord = await call("/admin/affar/list", { query: { type: "order" } });
  ok("order ansvarig = affärens ägare (Per Planerare)", ord.body.rows.find((r) => r.id === "mo1").ansvarig === "Per Planerare");
  const fak = await call("/admin/affar/list", { query: { type: "faktura" } });
  ok("faktura ansvarig = ft_our_reference (Sara S)", fak.body.rows[0].ansvarig === "Sara S");
  const avt = await call("/admin/affar/list", { query: { type: "avtal" } });
  ok("avtal ansvarig = affärens ägare (Per Planerare)", avt.body.rows[0].ansvarig === "Per Planerare");

  // datum-filter → dateBase-constraint på Created Date
  lastConstraints = {};
  const df = await call("/admin/affar/list", { query: { type: "lead", from: "2026-07-01", to: "2026-07-31" } });
  ok("datum-filter ekar tillbaka from/to", df.body.from === "2026-07-01" && df.body.to === "2026-07-31");
  const leadC = (lastConstraints["Lead"] || []).flat();
  ok("Created Date greater-than-constraint (giltig Bubble-typ)", leadC.some((c) => c.key === "Created Date" && c.constraint_type === "greater than"));
  ok("Created Date less-than-constraint (giltig Bubble-typ)", leadC.some((c) => c.key === "Created Date" && c.constraint_type === "less than"));
  ok("lead 2026-07-10 INOM range → syns (inklusiv from/till)", df.body.rows.length === 1 && df.body.rows[0].id === "l1");
  // utanför range → tomt
  const df2 = await call("/admin/affar/list", { query: { type: "lead", from: "2026-08-01", to: "2026-08-31" } });
  ok("lead 2026-07-10 UTANFÖR aug-range → tomt", df2.body.rows.length === 0);
  // exakt from-dag inkluderas (lead skapad 2026-07-10, range from=2026-07-10)
  const df3 = await call("/admin/affar/list", { query: { type: "lead", from: "2026-07-10", to: "2026-07-10" } });
  ok("exakt from=till=skapdag → inkluderas", df3.body.rows.length === 1);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
