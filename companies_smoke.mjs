// Smoke: företagslista (companies_api.js). Mockad Bubble + injicerade delade cachar.
//   node companies_smoke.mjs
import { registerCompaniesRoutes } from "./companies_api.js";

// ── Rå ClientCompany-DB (för bubbleGet/patch + re-projektion i companyPatchEntry) ──
const CC = {
  cc1: { _id: "cc1", Name_company: "Acme AB",   Org_Number: "556000-1111", Kundstatus: "Aktiv kund", Bransch: "IT", Potential: "A-kund", Lojalitet: "3", Region: "Stockholm", customer_type: "Direkt", NKI_carotte: 8, antal_medarbetare: 40, "omsättning": 5000, Kundansvarig: "u1", group: "g1", Fastighet: ["f1", "f2"] },
  cc2: { _id: "cc2", Name_company: "Beta Bygg",  Org_Number: "556000-2222", Kundstatus: "Prospekt",   Bransch: "Bygg", Potential: "B-kund", Lojalitet: "2", Region: "Göteborg", customer_type: "", NKI_carotte: null, antal_medarbetare: 10, "omsättning": null, Kundansvarig: "u2", group: null, Fastighet: ["f1"] },
  cc3: { _id: "cc3", Name_company: "Zeta Zoo",   Org_Number: "556000-3333", Kundstatus: "",          Bransch: "", Potential: "", Lojalitet: "", Region: "", customer_type: "", NKI_carotte: null, antal_medarbetare: null, "omsättning": null, Kundansvarig: null, group: null, Fastighet: [] },
};
const REV = new Map([["cc1", { 2025: 146750, 2026: 40992 }], ["cc2", { 2026: 7600 }]]);
const AUX = {
  User: [{ _id: "u1", "First Name": "Anna", "Surname": "Andersson" }, { _id: "u2", "First Name": "Bo", "Surname": "Berg" }],
  ClientGroup: [{ _id: "g1", name: "Acme-koncernen" }],
  Fastighet: [{ _id: "f1", Namn: "Kungsgatan 1" }, { _id: "f2", Namn: "Vasagatan 5" }],
};

// projektion identisk med index.js _projectCompany
const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : v._id));
const _refList = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])).map(_ref).filter(Boolean);
const _num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function project(c) {
  return {
    id: c._id, name: c.Name_company || "", orgnr: c.Org_Number == null ? "" : String(c.Org_Number),
    kundstatus: String(c.Kundstatus || ""), bransch: String(c.Bransch || ""), potential: String(c.Potential || ""),
    lojalitet: String(c.Lojalitet || ""), region: String(c.Region || ""), customer_type: String(c.customer_type || ""),
    nki: _num(c.NKI_carotte), antal_medarbetare: _num(c.antal_medarbetare), omsattning_field: _num(c["omsättning"]),
    ansvarig_id: _ref(c.Kundansvarig), group_id: _ref(c.group), fastighet_ids: _refList(c.Fastighet),
  };
}
const FULL = new Map(Object.values(CC).map((c) => [c._id, project(c)]));

const fetchedTypes = [];
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t) => { fetchedTypes.push(t); return AUX[t] || (t === "ClientCompany" ? Object.values(CC) : []); },
  bubbleFind: async (t) => { fetchedTypes.push(t); return AUX[t] || []; },
  bubbleGet: async (t, id) => (t === "ClientCompany" ? (CC[id] || null) : null),
  bubblePatch: async (t, id, payload) => { if (t === "ClientCompany" && CC[id]) Object.assign(CC[id], payload); return {}; },
  companyFullMap: async () => FULL,
  companyRevenueMap: async () => REV,
  companyPatchEntry: (id, fresh) => { FULL.set(id, project(fresh)); },
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
};

function mk() { const routes = { get: {}, post: {}, patch: {}, options: {} }; return { app: { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, patch: (p, h) => { routes.patch[p] = h; }, options: (p, h) => { routes.options[p] = h; } }, routes }; }
function call(routes, method, path, { query = {}, params = {}, body = {} } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } }; h({ params, query, body, headers: {} }, res); });
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  const s = mk(); registerCompaniesRoutes(s.app, deps);

  // ── META ──
  const meta = await call(s.routes, "get", "/admin/companies/meta");
  ok("meta ok", meta.body.ok);
  ok("meta facets.kundstatus = [Aktiv kund, Prospekt]", JSON.stringify(meta.body.facets.kundstatus) === JSON.stringify(["Aktiv kund", "Prospekt"]));
  ok("meta users 2 st sorterade", meta.body.users.length === 2 && meta.body.users[0].name === "Anna Andersson");
  ok("meta groups 1 st", meta.body.groups.length === 1 && meta.body.groups[0].name === "Acme-koncernen");
  ok("meta fastigheter 2 st", meta.body.fastigheter.length === 2);
  ok("meta editable ansvarig=userref", meta.body.editable.ansvarig === "userref");

  // ── LIST (default sort name asc) ──
  fetchedTypes.length = 0;
  const l = await call(s.routes, "get", "/admin/companies/list", { query: { year: "2026", prev: "2025" } });
  ok("list ok", l.body.ok);
  ok("list total 3", l.body.total === 3);
  ok("list ClientCompany laddades ALDRIG (delad cache)", fetchedTypes.indexOf("ClientCompany") === -1);
  const r0 = l.body.rows[0];
  ok("list sort namn asc → Acme först", r0.name === "Acme AB");
  ok("list resolvar ansvarig-namn", r0.ansvarig === "Anna Andersson");
  ok("list resolvar grupp-namn", r0.group === "Acme-koncernen");
  ok("list resolvar fastigheter", JSON.stringify(r0.fastigheter) === JSON.stringify(["Kungsgatan 1", "Vasagatan 5"]));
  ok("list omsättning nu (2026)=40992", r0.oms_now === 40992);
  ok("list omsättning prev (2025)=146750", r0.oms_prev === 146750);
  ok("list meta bifogad på page 1", !!l.body.meta && l.body.meta.cache_total === 3);

  // ── FILTER: kundstatus ──
  const fS = await call(s.routes, "get", "/admin/companies/list", { query: { kundstatus: "Prospekt" } });
  ok("filter kundstatus=Prospekt → 1 (Beta)", fS.body.total === 1 && fS.body.rows[0].name === "Beta Bygg");

  // ── FILTER: ansvarig ──
  const fA = await call(s.routes, "get", "/admin/companies/list", { query: { ansvarig: "u1" } });
  ok("filter ansvarig=u1 → 1 (Acme)", fA.body.total === 1 && fA.body.rows[0].id === "cc1");

  // ── FILTER: unassigned ──
  const fU = await call(s.routes, "get", "/admin/companies/list", { query: { unassigned: "1" } });
  ok("filter unassigned → 1 (Zeta)", fU.body.total === 1 && fU.body.rows[0].id === "cc3");

  // ── FILTER: fastighet ──
  const fF = await call(s.routes, "get", "/admin/companies/list", { query: { fastighet: "f2" } });
  ok("filter fastighet=f2 → 1 (Acme)", fF.body.total === 1 && fF.body.rows[0].id === "cc1");

  // ── SÖK q ──
  const fQ = await call(s.routes, "get", "/admin/companies/list", { query: { q: "beta" } });
  ok("sök q=beta → 1", fQ.body.total === 1 && fQ.body.rows[0].id === "cc2");
  const fQo = await call(s.routes, "get", "/admin/companies/list", { query: { q: "556000-3333" } });
  ok("sök q=orgnr → 1 (Zeta)", fQo.body.total === 1 && fQo.body.rows[0].id === "cc3");

  // ── SORT: namn desc ──
  const sD = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "name", dir: "desc" } });
  ok("sort namn desc → Zeta först", sD.body.rows[0].name === "Zeta Zoo");

  // ── SORT: nki (numeriskt, tomma sist) ──
  const sN = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "nki", dir: "desc" } });
  ok("sort nki desc → Acme(8) först, tomma sist", sN.body.rows[0].id === "cc1" && sN.body.rows[2].nki == null);

  // ── SORT: oms_now numeriskt ──
  const sO = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "oms_now", dir: "desc" } });
  ok("sort oms_now desc → Acme(40992) först", sO.body.rows[0].id === "cc1");

  // ── PAGINERING ──
  const p1 = await call(s.routes, "get", "/admin/companies/list", { query: { limit: "2", page: "1" } });
  const p2 = await call(s.routes, "get", "/admin/companies/list", { query: { limit: "2", page: "2" } });
  ok("paginering: page1 2 rader, page2 1 rad", p1.body.rows.length === 2 && p2.body.rows.length === 1 && p1.body.pages === 2);

  // ── PATCH: text (namn) ──
  const pt = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "name", value: "Beta Bygg AB" } });
  ok("patch namn ok + cache uppdaterad", pt.body.ok && pt.body.row.name === "Beta Bygg AB" && FULL.get("cc2").name === "Beta Bygg AB");

  // ── PATCH: number (nki) ──
  const pn = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "nki", value: 7 } });
  ok("patch nki ok", pn.body.ok && pn.body.row.nki === 7 && CC.cc2.NKI_carotte === 7);

  // ── PATCH: optionset giltig ──
  const po = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "kundstatus", value: "Aktiv kund" } });
  ok("patch kundstatus giltig ok", po.body.ok && CC.cc2.Kundstatus === "Aktiv kund");

  // ── PATCH: optionset OGILTIG → 400 ──
  const pox = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "region", value: "Mars" } });
  ok("patch okänt option-set-värde → 400", pox.code === 400 && String(pox.body.error).startsWith("unknown_optionset_value"));

  // ── PATCH: userref (byt ansvarig) ──
  const pu = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { field: "ansvarig", value: "u2" } });
  ok("patch ansvarig ok + resolvar namn", pu.body.ok && pu.body.row.ansvarig === "Bo Berg" && CC.cc3.Kundansvarig === "u2");

  // ── PATCH: ej redigerbart fält → 400 ──
  const pbad = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc1" }, body: { field: "oms_now", value: 1 } });
  ok("patch icke-redigerbart fält → 400", pbad.code === 400 && String(pbad.body.error).startsWith("field_not_editable"));

  // ── PATCH: okänt id → 404 ──
  const p404 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "nope" }, body: { field: "name", value: "X" } });
  ok("patch okänt id → 404", p404.code === 404);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
