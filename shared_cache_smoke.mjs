// Smoke: delad companyMap-injektion → moduler laddar INTE ClientCompany själva. node shared_cache_smoke.mjs
import { registerSaljRoutes } from "./salj_api.js";
import { registerProduktionRoutes } from "./produktion_api.js";

const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "SKA EJ LADDAS" }],   // om denna dyker upp → injektion trasig
  User: [{ _id: "u1", "First Name": "Anna", "Surname": "A" }],
  deal: [{ _id: "d1", titel: "D", value_brutto: 1000 }],
  Offert: [], Kok: [{ _id: "k1", namn: "Kök" }],
  activitet_crm: [{ _id: "a1", activity_type: "Kundmöte", "Kundmöte": "Fas 1", "Datum_bokning": "2026-08-10", writer: "u1", company: "cc1" }],
  MiraOrder: [{ _id: "o1", source: "mira_fe", ordernr: "FE-1", kundforetag: "cc1", orderstatus: "Bekräftad", leverans_ts: new Date("2026-08-12T12:00:00Z").getTime(), leveransdatum: "2026-08-12" }],
  MiraOrderRad: [{ _id: "r1", order: "o1", benamning: "X", antal: 5, kok: "k1", prep_kategori: "Frallor" }],
};
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v)); if (c.constraint_type === "greater than") return parseFloat(v) > parseFloat(c.value); if (c.constraint_type === "less than") return parseFloat(v) < parseFloat(c.value); return true; };
const fetchedTypes = [];
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => { fetchedTypes.push(t); return (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))); },
  bubbleFind: async (t, { constraints = [], limit = 300 } = {}) => { fetchedTypes.push(t); return (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit); },
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubblePatch: async () => ({}), bubbleCreate: async () => "new",
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  // injicerad delad CC-cache — modulerna ska använda DENNA istället för att ladda ClientCompany
  companyMap: async () => new Map([["cc1", "Acme AB (delad cache)"]]),
};
function mk() { const routes = { get: {}, post: {}, options: {} }; return { app: { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } }, routes }; }
function call(routes, method, path, query = {}) { const h = routes[method][path]; return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }; h({ params: {}, query, body: {}, headers: {} }, res); }); }

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  // ── SÄLJ /moten ──
  const s = mk(); registerSaljRoutes(s.app, deps);
  fetchedTypes.length = 0;
  const m = await call(s.routes, "get", "/admin/salj/moten");
  ok("salj/moten ok", m.body.ok);
  ok("salj: företagsnamn kom från injicerad cache", m.body.groups.find((g) => g.fas === "Fas 1").moten[0].company === "Acme AB (delad cache)");
  ok("salj: ClientCompany laddades ALDRIG via bubbleFindAll", fetchedTypes.indexOf("ClientCompany") === -1);
  ok("salj: laddade dock User/deal/activitet_crm (lokalt)", fetchedTypes.indexOf("activitet_crm") > -1);

  // ── PRODUKTION /dag ──
  const p = mk(); registerProduktionRoutes(p.app, deps);
  fetchedTypes.length = 0;
  const d = await call(p.routes, "get", "/admin/produktion/dag", { date: "2026-08-12" });
  ok("produktion/dag ok", d.body.ok);
  ok("produktion: företagsnamn från injicerad cache", d.body.orders[0].company === "Acme AB (delad cache)");
  ok("produktion: ClientCompany laddades ALDRIG", fetchedTypes.indexOf("ClientCompany") === -1);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
