// Smoke: företagslista (companies_api.js). Mockad Bubble + injicerade delade cachar.
//   node companies_smoke.mjs
import { registerCompaniesRoutes } from "./companies_api.js";

// ── Rå ClientCompany-DB (för bubbleGet/patch + re-projektion i companyPatchEntry) ──
const CC = {
  cc1: { _id: "cc1", Name_company: "Acme AB",   Org_Number: "556000-1111", Kundstatus: "Aktiv kund", Bransch: "IT", Potential: "A-kund", Lojalitet: "3", Region: "Stockholm", customer_type: "Direkt", NKI_carotte: 8, antal_medarbetare: 40, "omsättning": 5000, Kundansvarig: "u1", group: "g1", Fastighet: ["f1", "f2"], Email: "info@acme.se", Telefon: 733716298, hemsida_crm: "acme.se", kundinfo_crm: "Bra kund", Fakturainfo: "Ref 42", "Grundat_år": "1999-01-01", Adress: { address: "Storgatan 1, Stockholm" }, logotyp: "//img/acme.png" },
  cc2: { _id: "cc2", Name_company: "Beta Bygg",  Org_Number: "556000-2222", Kundstatus: "Prospekt",   Bransch: "Bygg", Potential: "B-kund", Lojalitet: "2", Region: "Göteborg", customer_type: "", NKI_carotte: null, antal_medarbetare: 10, "omsättning": null, Kundansvarig: "u2", group: null, Fastighet: ["f1"] },
  cc3: { _id: "cc3", Name_company: "Zeta Zoo",   Org_Number: "556000-3333", Kundstatus: "",          Bransch: "", Potential: "", Lojalitet: "", Region: "", customer_type: "", NKI_carotte: null, antal_medarbetare: null, "omsättning": null, Kundansvarig: null, group: null, Fastighet: [] },
};
const REV = new Map([["cc1", { 2025: 146750, 2026: 40992 }], ["cc2", { 2026: 7600 }]]);
const AUX = {
  ClientGroup: [{ _id: "g1", name: "Acme-koncernen" }],
  Fastighet: [{ _id: "f1", Namn: "Kungsgatan 1" }, { _id: "f2", Namn: "Vasagatan 5" }],
};
const CONTRACTS = [
  { _id: "ct1", "kundföretag": "cc1", "månadskostnad": 100000, "slutdatum": null, contract_type: "Subscription", contract_title: "Reception CMIAB" },   // aktiv (inget slut)
  { _id: "ct2", "kundföretag": "cc1", "månadskostnad": 73985,  "slutdatum": "2020-01-01", contract_type: "Subscription", "kategori": "Housekeeping" },  // utgången
  { _id: "ct3", "kundföretag": "cc1", "månadskostnad": 173985, "slutdatum": "2099-01-01", contract_type: "Hybrid", contract_title: "HK Hybrid" },        // aktiv (framtida slut)
];
const ACTS = [{ _id: "a1", clientcompany: "cc1" }, { _id: "a2", clientcompany: "cc1" }];
// Kedje-typer per företag (reverse-lookup): Mira via kundföretag/kundforetag/client_company, Fortnox via linked_company
const STORE = {
  Contract: CONTRACTS,
  activitet_crm: ACTS,
  deal: [{ _id: "d1", "kundföretag": "cc1", titel: "CMIAB fruktlåda", value_brutto: 5000, Status: "Avtal", "Created Date": "2026-08-12" }],
  Lead: [{ _id: "l1", client_company: "cc1", Name: "Lead X", estimated_service_cost_monthly: 92880, status: "Ny", "Created Date": "2026-06-22" }],
  Offert: [{ _id: "of1", kundforetag: "cc1", offertnr: "MO-1", total: 12000, status: "Approved", offertdatum: "2026-07-01" }],
  FortnoxOffer: [{ _id: "ff1", linked_company: "cc1", ft_document_number: "FE-2026-0004", ft_total: 8000, ft_sent: true, ft_offer_date: "2026-07-31" }],
  MiraOrder: [{ _id: "mo1", kundforetag: "cc1", ordernr: "O-1", total: 9000, orderstatus: "Levererad", orderdatum: "2026-08-01" }],
  FortnoxOrder: [{ _id: "fo1", linked_company: "cc1", ft_document_number: "FO-1", ft_total: 15000, ft_delivery_date: "2026-08-10" }],
  FortnoxInvoice: [
    { _id: "inv1", linked_company: "cc1", ft_document_number: "F-1", ft_total: 20000, ft_invoice_date: "2026-05-01", ft_balance: 0, ft_cancelled: false },
    { _id: "inv2", linked_company: "cc1", ft_document_number: "F-2", ft_total: 5000, ft_invoice_date: "2026-06-01", ft_balance: 5000, ft_due_date: "2020-01-01", ft_cancelled: false },
  ],
  Coworker: [
    { _id: "co1", "Kundföretag": "cc1", "Förnamn": "Testare", "Efternamn": "Testsson", Titel: "Projektledare", Email: "christian.mertzig@gmail.com", Telefon: 755678900, crm_info: "Nyckelkontakt", Avdelning: "Försäljning", Kontor: "of1", Foto: "//files/co1.jpg" },  // har User (matchar u1) + foto
    { _id: "co2", "Kundföretag": "cc1", "Förnamn": "Rena", "Efternamn": "Kontakt", Email: "rena@acme.se" },  // ren CRM-kontakt
  ],
  Office: [
    { _id: "of1", "Kundföretag": "cc1", "Office_title": "CMIAB Sthlm", "Fastighet": "f1", "Kontorsansvarig": ["co1"], "office_address": { address: "Kammakargatan 12, Stockholm" }, "Yta": 200, "Arbetsplatser": 10, "Budget": 500000, "Mötesrum": ["m1"], "intern_lokal": ["i1", "i2"] },
    { _id: "of2", "Kundföretag": "cc1", "Office_title": "CMIAB Göteborg" },
  ],
  MeetingRoom: [{ _id: "m1", office: "of1", Company: "cc1", Name: "Stora mötesrummet", room_email: "stora@acme.se" }],
  // i1 = ref-väg (kontor satt); i2 = list-väg (INGET kontor, ligger bara i Office.intern_lokal — som native-rum)
  Internal_room: [{ _id: "i1", kontor: "of1", "kundföretag": "cc1", Namn: "Pentry" }, { _id: "i2", "kundföretag": "cc1", Namn: "Toaletter" }],
  OfferApprovalRequest: [
    { _id: "oar1", clientcompany: "cc1", rubrik: "Avtal — CMIAB", status: "Approved", signed_count: 1, recipients_count: 1, "Created Date": "2026-08-05" },
    { _id: "oar2", clientcompany: "cc1", rubrik: "Offert FE-2026-0004", status: "Sent", signed_count: 0, recipients_count: 1, "Created Date": "2026-07-31" },
  ],
  // kund-koppling = fältet `company` (ClientCompany) — enda kund-fältet på activitet_crm (Bubble-schema 2026-08-14)
  activitet_crm: [
    { _id: "act1", company: "cc1", taggade_personer: ["co1"], writer: "u1", "Datum_bokning": "2026-08-10", activity_type: "Kundmöte", "Kundmöte": "Fas 2", beskrivning: "Möte om frukten", "mötesantecking": "Bra möte", "genomfört": true, "Created Date": "2026-08-01" },
    { _id: "act2", company: "cc1", taggade_personer: ["co1", "co2"], "Datum_bokning": "2026-06-20", activity_type: "Samtal", beskrivning: "Uppföljning", "Created Date": "2026-06-20" },
    { _id: "act3", company: "cc2", taggade_personer: ["co2"], "Datum_bokning": "2026-07-01", activity_type: "Mail", "Created Date": "2026-07-01" },
    { _id: "act4", company: "cc1", activity_type: "Kommentar", beskrivning: "Kommentar", "Datum_bokning": "2026-01-05", "Created Date": "2026-01-05" },
    { _id: "act5", company: "cc1", activity_type: "Möte", beskrivning: "Möte", "Datum_bokning": "2026-01-04", "Created Date": "2026-01-04" },
  ],
};
// User i STORE (behövs för bubbleGet/patch i personal-koppling); u1 kopplad till cc1 via Associated_company
STORE.User = [
  { _id: "u1", "First Name": "Anna", "Surname": "Andersson", email: "christian.mertzig@gmail.com", Company: "cc1", "Associated_company": ["cc1"] },
  { _id: "u2", "First Name": "Bo", "Surname": "Berg", email: "bo@x.se", Company: "cc2" },
];
// Dotterbolag: sup1 kopplad till cc1 (via Kundföretag-listan), sup2 tillgänglig
STORE["Leverantör - Supplier"] = [
  { _id: "sup1", "Företagsnamn": "Carotte Housekeeping AB", "Kategori": "Housekeeping", "Kundföretag": ["cc1"] },
  { _id: "sup2", "Företagsnamn": "Carotte Food & Event AB", "Kategori": "Food & Event", "Kundföretag": [] },
];
// Fastighetsägare: hv1 har cc1 som hyresgäst, hv2 tillgänglig
STORE["Hyresvärd"] = [
  { _id: "hv1", Namn: "Vasakronan", "Hyresgäster": ["cc1"] },
  { _id: "hv2", Namn: "Fabege", "Hyresgäster": [] },
];
// Drift: ärenden (Matter) + kvalitetskontroller (QualityControl) + ytor (Kommentar-Comment) + Grade
// Kontor=of2 (aldrig omdöpt) + surface=i2 (aldrig raderad) → drift-testerna oberoende av office/room-mutationer
STORE.Matter = [
  { _id: "mt1", "Kundföretag": "cc1", Rubrik: "Kaffemaskin trasig", Beskrivning: "Fungerar ej", Kontor: "of2", Referens: "u1", "Created Date": "2026-08-10", Prioritet: "3 - brådskande", status: "Pågående", Avvikelse: false, "Team åtgärd intern": ["co1"], "Tråd": ["Christian: tittar på det"], Feedback: "" },
  { _id: "mt2", "Kundföretag": "cc1", Rubrik: "Avfallshantering", Beskrivning: "Glas", Kontor: "of2", "Created Date": "2026-07-20", Prioritet: "2", status: "Avslutad", Avvikelse: false },
  { _id: "mt3", "Kundföretag": "cc1", Rubrik: "Fel städ", Beskrivning: "Ej torkat", Kontor: "of2", "Created Date": "2026-08-05", Prioritet: "3", status: "Pågående", Avvikelse: true },
  { _id: "mt4", "Kundföretag": "cc2", Rubrik: "Annat bolag", status: "Pågående" },
];
STORE.QualityControl = [
  { _id: "qc1", "Kundföretag": "cc1", Titel: "Regelmässigt städ", Avtal: "ct1", Kontor: "of2", kontrolldatum: "2026-06-09", Kontrollant: "u1", "Leverantör": "sup1", "Betyg_lev": 4, "arbetskläder": true, servicekort: false, "städförråd": true, Meddelande: "Bra jobbat", betyg_client: "Nivå 3", feedback_client: "Nöjda", "Kundreferens": ["co1"] },
];
STORE["Kommentar - Comment"] = [
  { _id: "kc1", kvalitetskontroll: "qc1", "Intern_lokal": "i2", Betyg: "gr1", Bild: "//img/toa.jpg", Beskrivning: "Regelmässig städ ok", "Godkänd": true },
  { _id: "kc2", kvalitetskontroll: "qc1", "Mötesrum": "m1", Betyg: "gr2", Beskrivning: "Dammsuget", "Godkänd": true },
];
STORE.Grade = [
  { _id: "gr1", kvalitetskontroll: "qc1", "Värde": 4 },
  { _id: "gr2", kvalitetskontroll: "qc1", "Värde": 4 },
];
STORE.PasswordReset = []; STORE.emailqueue = [];   // token-flödet skapar rader här
let _idc = 0;
const _cmatch = (r, cs) => (cs || []).every((c) => {
  const v = r[c.key];
  if (c.constraint_type === "contains") { const a = Array.isArray(v) ? v : (v == null ? [] : [v]); return a.map(String).includes(String(c.value)); }
  if (c.constraint_type === "text contains") return String(v == null ? "" : v).toLowerCase().includes(String(c.value).toLowerCase());
  if (c.constraint_type === "not equal") return String(v == null ? "" : v) !== String(c.value);
  if (c.constraint_type === "is_not_empty") return v != null && String(v) !== "";
  if (c.constraint_type === "is_empty") return v == null || String(v) === "";
  return String(v == null ? "" : v) === String(c.value);
});

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
const createUserCalls = [];
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => {
    fetchedTypes.push(t);
    const arr = STORE[t] || AUX[t] || (t === "ClientCompany" ? Object.values(CC) : []);
    return arr.filter((r) => _cmatch(r, constraints));
  },
  bubbleFind: async (t) => { fetchedTypes.push(t); return AUX[t] || []; },
  bubbleCount: async (t, cs = []) => (STORE[t] ? STORE[t].filter((r) => _cmatch(r, cs)).length : 0),
  bubbleGet: async (t, id) => { if (t === "ClientCompany") return CC[id] || null; if (STORE[t]) return STORE[t].find((r) => r._id === id) || null; return null; },
  bubblePatch: async (t, id, payload) => { if (t === "ClientCompany" && CC[id]) { Object.assign(CC[id], payload); return {}; } if (STORE[t]) { const r = STORE[t].find((x) => x._id === id); if (r) Object.assign(r, payload); } return {}; },
  bubbleCreate: async (t, payload) => { const id = "new_" + (++_idc); (STORE[t] = STORE[t] || []).push(Object.assign({ _id: id }, payload)); return id; },
  bubbleDelete: async (t, id) => { if (STORE[t]) { const i = STORE[t].findIndex((r) => r._id === id); if (i >= 0) STORE[t].splice(i, 1); } return {}; },
  bubbleUploadFile: async ({ filename }) => "//files/" + filename,   // fejkad Bubble file storage
  // photoUpload utelämnas → _photoMw blir passthrough; testet sätter req.file direkt.
  companyFullMap: async () => FULL,
  companyRevenueMap: async () => REV,
  companyRevenueMapWarm: () => REV,
  companyPatchEntry: (id, fresh) => { FULL.set(id, project(fresh)); },
  assignTempPassword: async ({ email }) => ({ ok: true, temp_password: "TMP-" + email }),
  createUserAccount: async (args) => { createUserCalls.push(args); return { ok: true, user_id: "newuser1" }; },
  appBaseUrl: "https://mira-fm.com",
  pwResetTemplateId: "tpl_pw",
  welcomeTemplateId: "tpl_welcome",
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
};

// Fångar SISTA handlern per rout (foto-routen registreras med middleware + handler → ta sista).
function mk() { const routes = { get: {}, post: {}, patch: {}, delete: {}, options: {} }; const last = (a) => a[a.length - 1]; return { app: { get: (p, ...a) => { routes.get[p] = last(a); }, post: (p, ...a) => { routes.post[p] = last(a); }, patch: (p, ...a) => { routes.patch[p] = last(a); }, delete: (p, ...a) => { routes.delete[p] = last(a); }, options: (p, ...a) => { routes.options[p] = last(a); } }, routes }; }
function call(routes, method, path, { query = {}, params = {}, body = {}, file = undefined } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } }; h({ params, query, body, file, headers: {} }, res); });
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
  ok("list revenue_ready=true (varm cache)", l.body.revenue_ready === true);

  // ── revenue_ready=false när faktura-cachen är kall (warm→null) ──
  var coldDeps = Object.assign({}, deps, { companyRevenueMapWarm: function(){ return null; } });
  var cs = mk(); registerCompaniesRoutes(cs.app, coldDeps);
  var lc = await call(cs.routes, "get", "/admin/companies/list", {});
  ok("kall faktura-cache → revenue_ready=false + oms null", lc.body.revenue_ready === false && lc.body.rows[0].oms_now === null);

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

  // ── CARD: Hem-fliken ──
  var card = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "cc1" } });
  ok("card ok", card.body.ok);
  ok("card company kunddata (namn+adress+email+web)", card.body.company.name === "Acme AB" && card.body.company.adress === "Storgatan 1, Stockholm" && card.body.company.email === "info@acme.se" && card.body.company.web === "acme.se");
  ok("card resolvar ansvarig/grupp/fastigheter", card.body.company.ansvarig === "Anna Andersson" && card.body.company.group === "Acme-koncernen" && card.body.company.fastigheter.length === 2);
  ok("card grundat-år + logotyp https + kundinfo", card.body.company.grundat === "1999" && card.body.company.logotyp === "https://img/acme.png" && card.body.company.kundinformation === "Bra kund");
  ok("card KPI MRR=273985 (aktiva 2) + total 3", card.body.kpi.mrr === 273985 && card.body.kpi.active_contracts === 2 && card.body.kpi.contracts_total === 3);
  ok("card KPI omsättning nu/prev", card.body.kpi.omsattning_now === 40992 && card.body.kpi.omsattning_prev === 146750 && card.body.kpi.nki === 8);
  ok("card counts avtal/historik(company-fältet)/deals", card.body.counts.avtal === 3 && card.body.counts.historik === 4 && card.body.counts.deals === 1);
  ok("card counts leads/offerter/ordrar/fakturor", card.body.counts.leads === 1 && card.body.counts.offerter === 2 && card.body.counts.ordrar === 2 && card.body.counts.fakturor === 2);
  ok("card counts personer=2", card.body.counts.personer === 2);
  ok("card counts drift = öppna ärenden (Pågående) = 2", card.body.counts.drift === 2);

  // ── CHAIN: reverse-lookup per flik ──
  var chD = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "deals" } });
  ok("chain deals → 1 (Deal/mira, status Avtal→ok)", chD.body.ok && chD.body.count === 1 && chD.body.rows[0].type === "Deal" && chD.body.rows[0].status_cls === "ok" && chD.body.rows[0].amount === 5000);
  var chL = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "leads" } });
  ok("chain leads → 1", chL.body.count === 1 && chL.body.rows[0].title === "Lead X" && chL.body.rows[0].amount === 92880);
  var chO = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "offerter" } });
  ok("chain offerter → 2 (Mira+Fortnox), nyast först", chO.body.count === 2 && chO.body.rows[0].date === "2026-07-31" && chO.body.rows.filter(function(r){return r.source==="fortnox";}).length === 1);
  var chOr = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "ordrar" } });
  ok("chain ordrar → 2 (Mira Levererad + Fortnox)", chOr.body.count === 2 && chOr.body.rows.some(function(r){return r.status==="Levererad";}));
  var chF = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "fakturor" } });
  ok("chain fakturor → 2 (Betald + Förfallen)", chF.body.count === 2 && chF.body.rows.some(function(r){return r.status_cls==="ok";}) && chF.body.rows.some(function(r){return r.status==="Förfallen";}));
  var chA = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "avtal" } });
  ok("chain avtal → 3 (1 avslutad, typ Hybrid finns)", chA.body.count === 3 && chA.body.rows.some(function(r){return r.status==="Avslutad";}) && chA.body.rows.some(function(r){return r.contract_type==="Hybrid";}) && chA.body.rows.some(function(r){return r.amount===100000;}));
  var chS = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "signeringar" } });
  ok("chain signeringar → 2 (Approved→ok, Sent→open)", chS.body.count === 2 && chS.body.rows.some(function(r){return r.status==="Approved"&&r.status_cls==="ok";}) && chS.body.rows.some(function(r){return r.status==="Sent"&&r.status_cls==="open";}) && chS.body.rows[0].recipients === 1);
  var chH = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "historik" } });
  ok("chain historik → 4 (company-fältet), nyast först", chH.body.count === 4 && chH.body.rows[0].id === "act1" && chH.body.rows[0].typ === "Kundmöte" && chH.body.rows[0].fas === "Fas 2" && chH.body.rows[0].genomfort === true && chH.body.rows[1].id === "act2");
  ok("chain historik tar bara detta företags aktiviteter (act3 på cc2 utesluts)", chH.body.rows.every(function(r){return r.id!=="act3";}) && chH.body.rows.some(function(r){return r.id==="act4";}));
  ok("chain historik: full edit-prefill (ansvarig via writer, motesanteckning, motesdatum_iso)", chH.body.rows[0].ansvarig === "Anna Andersson" && chH.body.rows[0].motesanteckning === "Bra möte" && chH.body.rows[0].motesdatum_iso === "2026-08-10" && chH.body.rows[0].beskrivning === "Möte om frukten");
  var chBad = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "nope" } });
  ok("chain okänd typ → 400", chBad.code === 400);

  // ── PERSONER (Coworker + konto-badge) ──
  var cw = await call(s.routes, "get", "/admin/companies/:id/coworkers", { params: { id: "cc1" } });
  ok("coworkers ok, 2 rader", cw.body.ok && cw.body.count === 2);
  var coTest = cw.body.rows.filter(function(r){return r.id==="co1";})[0];
  var coRen = cw.body.rows.filter(function(r){return r.id==="co2";})[0];
  ok("coworker namn/titel/email/telefon", coTest.name === "Testare Testsson" && coTest.title === "Projektledare" && coTest.email === "christian.mertzig@gmail.com" && coTest.phone === "755678900");
  ok("coworker crm_info/avdelning/kontor resolvat", coTest.crm_info === "Nyckelkontakt" && coTest.avdelning === "Försäljning" && coTest.kontor_id === "of1" && coTest.kontor === "CMIAB Sthlm");
  ok("coworker foto (https-normaliserat) + tom när saknas", coTest.foto === "https://files/co1.jpg" && coRen.foto === "");
  ok("coworkers svar bär offices + departments", cw.body.offices.length === 2 && cw.body.offices[0].name === "CMIAB Göteborg" && cw.body.departments.indexOf("Försäljning") > -1);
  ok("coworker has_user (email matchar User vars Company==företaget)", coTest.has_user === true && coTest.user_id === "u1");
  ok("ren coworker = CRM-kontakt (has_user false)", coRen.has_user === false && coRen.user_id === null);
  // ── LÖSENORDS-RESET (eget token-flöde) ──
  STORE.PasswordReset.length = 0; STORE.emailqueue.length = 0;
  var pw = await call(s.routes, "post", "/admin/companies/coworker/:id/send-password", { params: { id: "co1" } });
  ok("send-password ok + email", pw.body.ok && pw.body.email === "christian.mertzig@gmail.com");
  ok("send-password skapade PasswordReset + emailqueue", STORE.PasswordReset.length === 1 && STORE.emailqueue.length === 1);
  var eq = STORE.emailqueue[0];
  ok("emailqueue: rätt template_id + email_sent false", eq.template_id === "tpl_pw" && eq.email_sent === false);
  var ed = JSON.parse(eq.extra_data);
  ok("emailqueue extra_data har reset_url med token", /\/reset_pw\?t=[a-f0-9]{48}$/.test(ed.reset_url));
  var rawTok = ed.reset_url.split("t=")[1];
  ok("PasswordReset: token_hash satt, used false, coworker=co1", STORE.PasswordReset[0].token_hash && STORE.PasswordReset[0].used === false && STORE.PasswordReset[0].coworker === "co1");

  // exchange: byt token mot temp
  var ex = await call(s.routes, "post", "/admin/reset-password/exchange", { body: { token: rawTok } });
  ok("exchange ok → email + temp_password", ex.body.ok && ex.body.email === "christian.mertzig@gmail.com" && ex.body.temp_password === "TMP-christian.mertzig@gmail.com");
  ok("exchange brände token (used=true)", STORE.PasswordReset[0].used === true);
  var ex2 = await call(s.routes, "post", "/admin/reset-password/exchange", { body: { token: rawTok } });
  ok("exchange samma token igen → 400 invalid_or_expired", ex2.code === 400 && ex2.body.error === "invalid_or_expired");
  var exBad = await call(s.routes, "post", "/admin/reset-password/exchange", { body: { token: "deadbeef" } });
  ok("exchange okänd token → 400", exBad.code === 400 && exBad.body.error === "invalid_or_expired");
  var exNo = await call(s.routes, "post", "/admin/reset-password/exchange", { body: {} });
  ok("exchange utan token → 400 missing_token", exNo.code === 400 && exNo.body.error === "missing_token");
  var exInit = await call(s.routes, "post", "/admin/reset-password/exchange", { body: { token: "__INIT__" } });
  ok("exchange __INIT__ → sample-svar (rör ej data)", exInit.body.ok && exInit.body.sample === true && exInit.body.temp_password === "INIT-SAMPLE-PW");

  var pw404 = await call(s.routes, "post", "/admin/companies/coworker/:id/send-password", { params: { id: "nope" } });
  ok("send-password okänd coworker → 404", pw404.code === 404);

  // ny-user-flödet: /admin/reset-password/send {email}
  STORE.PasswordReset.length = 0; STORE.emailqueue.length = 0;
  var snd = await call(s.routes, "post", "/admin/reset-password/send", { body: { email: "ny.user@acme.se", name: "Ny User" } });
  ok("reset-password/send ok + skapade token+mail", snd.body.ok && snd.body.email === "ny.user@acme.se" && STORE.PasswordReset.length === 1 && STORE.emailqueue.length === 1);
  ok("send: mail till rätt adress + reset_url", STORE.emailqueue[0].to_email === "ny.user@acme.se" && /\/reset_pw\?t=/.test(JSON.parse(STORE.emailqueue[0].extra_data).reset_url));
  ok("send: nya användare får VÄLKOMST-mallen (tpl_welcome)", STORE.emailqueue[0].template_id === "tpl_welcome");
  var sndNo = await call(s.routes, "post", "/admin/reset-password/send", { body: {} });
  ok("send utan email → 400 no_email", sndNo.code === 400 && sndNo.body.error === "no_email");

  // ── skapa person (Coworker) från kortet ──
  var cbefore = STORE.Coworker.length;
  var cr = await call(s.routes, "post", "/admin/companies/:id/coworker/create", { params: { id: "cc1" }, body: { first: "Nils", last: "Ny", email: "nils@acme.se", phone: "070-111 11 11", title: "Tekniker" } });
  ok("coworker/create ok + Coworker skapad med rätt fält", cr.body.ok && STORE.Coworker.length === cbefore + 1);
  var newCo = STORE.Coworker[STORE.Coworker.length - 1];
  ok("ny Coworker: Förnamn/Efternamn/Email/Titel/Kundföretag + Telefon=number", newCo["Förnamn"] === "Nils" && newCo.Email === "nils@acme.se" && newCo.Titel === "Tekniker" && newCo["Kundföretag"] === "cc1" && newCo.Telefon === 701111111);

  // ── skapa login-konto + välkomstmail för en ren CRM-kontakt (co2) ──
  STORE.emailqueue.length = 0; createUserCalls.length = 0;
  var ca = await call(s.routes, "post", "/admin/companies/coworker/:id/create-account", { params: { id: "co2" } });
  ok("create-account ok (user_id + mail)", ca.body.ok && ca.body.user_id === "newuser1" && ca.body.mail === true);
  ok("create-account anropade Bubble-wf med email+firstname/surname+company+coworker", createUserCalls.length === 1 && createUserCalls[0].email === "rena@acme.se" && createUserCalls[0].firstname === "Rena" && createUserCalls[0].surname === "Kontakt" && createUserCalls[0].company === "cc1" && createUserCalls[0].coworker_id === "co2");
  ok("create-account skickade VÄLKOMST-mailet", STORE.emailqueue.length === 1 && STORE.emailqueue[0].template_id === "tpl_welcome" && STORE.emailqueue[0].to_email === "rena@acme.se");
  var ca404 = await call(s.routes, "post", "/admin/companies/coworker/:id/create-account", { params: { id: "nope" } });
  ok("create-account okänd coworker → 404", ca404.code === 404);

  // ── redigera person (Coworker PATCH) ──
  var cop = await call(s.routes, "patch", "/admin/companies/coworker/:id", { params: { id: "co1" }, body: { fields: { title: "Senior PL", telefon: "070-222 33 44", crm_info: "VD-kontakt", avdelning: "Ledning", kontor: "of2" } } });
  ok("coworker PATCH ok (Titel/Telefon/crm_info/Avdelning/Kontor)", cop.body.ok && STORE.Coworker[0].Titel === "Senior PL" && STORE.Coworker[0].Telefon === 702223344 && STORE.Coworker[0].crm_info === "VD-kontakt" && STORE.Coworker[0].Avdelning === "Ledning" && STORE.Coworker[0].Kontor === "of2");
  var copBad = await call(s.routes, "patch", "/admin/companies/coworker/:id", { params: { id: "co1" }, body: { field: "has_user", value: true } });
  ok("coworker PATCH icke-redigerbart → 400", copBad.code === 400 && String(copBad.body.error).startsWith("field_not_editable"));
  var cop404 = await call(s.routes, "patch", "/admin/companies/coworker/:id", { params: { id: "nope" }, body: { field: "title", value: "X" } });
  ok("coworker PATCH okänt id → 404", cop404.code === 404);

  // ── PROFILFOTO (Coworker.Foto): sätt / rensa / valideringar ──
  var ph = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, file: { buffer: Buffer.from("abc"), mimetype: "image/png" } });
  ok("photo upload ok → url + Foto satt på Coworker", ph.body.ok && ph.body.url === "https://files/coworker_co2_foto.png" && STORE.Coworker[1].Foto === "https://files/coworker_co2_foto.png");
  var phClr = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, body: { clear: "1" } });
  ok("photo clear → Foto tömt", phClr.body.ok && phClr.body.url === "" && STORE.Coworker[1].Foto === "");
  var phNo = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, body: {} });
  ok("photo utan fil (ej clear) → 400 no_file", phNo.code === 400 && phNo.body.error === "no_file");
  var phBad = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, file: { buffer: Buffer.from("x"), mimetype: "application/pdf" } });
  ok("photo icke-bild → 400 not_image", phBad.code === 400 && phBad.body.error === "not_image");
  var ph404 = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "nope" }, file: { buffer: Buffer.from("x"), mimetype: "image/jpeg" } });
  ok("photo okänd coworker → 404", ph404.code === 404);

  // ── HISTORIK: skapa + redigera aktivitet (activitet_crm) ──
  var abefore = STORE.activitet_crm.length;
  var hc = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "Nytt möte", fas: "Fas 3", motesdatum: "2026-08-20", genomfort: true, motesanteckning: "Genomgång" } });
  ok("historik/create ok + rad skapad", hc.body.ok && STORE.activitet_crm.length === abefore + 1 && hc.body.row && hc.body.row.typ === "Kundmöte");
  var newAkt = STORE.activitet_crm[STORE.activitet_crm.length - 1];
  ok("ny aktivitet: company=cc1 + Kundmöte-fält (display-nycklar)", newAkt.company === "cc1" && newAkt.clientcompany === undefined && newAkt.activity_type === "Kundmöte" && newAkt["Kundmöte"] === "Fas 3" && newAkt["genomfört"] === true && newAkt["mötesantecking"] === "Genomgång" && /^2026-08-20/.test(newAkt["Datum_bokning"]));
  var hcTom = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: {} });
  ok("historik/create tom → 400", hcTom.code === 400 && hcTom.body.error === "tom_aktivitet");
  // icke-Kundmöte skickar inte fas/datum
  var hc2 = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kommentar", beskrivning: "Bara en kommentar" } });
  var newAkt2 = STORE.activitet_crm[STORE.activitet_crm.length - 1];
  ok("historik/create icke-Kundmöte → ingen fas/datum satt", hc2.body.ok && newAkt2.activity_type === "Kommentar" && newAkt2["Kundmöte"] === undefined && newAkt2["Datum_bokning"] === undefined);
  // patch: redigera act2
  var hp = await call(s.routes, "post", "/admin/companies/historik/:id/patch", { params: { id: "act2" }, body: { beskrivning: "Uppdaterad text", activity_type: "Säljsamtal" } });
  ok("historik/patch ok (bara skickade fält)", hp.body.ok && STORE.activitet_crm.filter(function(r){return r._id==="act2";})[0].beskrivning === "Uppdaterad text" && hp.body.row.beskrivning === "Uppdaterad text");
  var hpNo = await call(s.routes, "post", "/admin/companies/historik/:id/patch", { params: { id: "act2" }, body: {} });
  ok("historik/patch inga fält → 400", hpNo.code === 400 && hpNo.body.error === "no_fields");
  var hp404 = await call(s.routes, "post", "/admin/companies/historik/:id/patch", { params: { id: "nope" }, body: { beskrivning: "x" } });
  ok("historik/patch okänt id → 404", hp404.code === 404);

  // ── INSTÄLLNINGAR: KONTOR (Office) ──
  var of = await call(s.routes, "get", "/admin/companies/:id/offices", { params: { id: "cc1" } });
  ok("offices → 2 (cc1), sorterade + dropdown-data", of.body.ok && of.body.count === 2 && of.body.fastigheter.length === 2 && of.body.coworkers.length >= 2);
  var of1 = of.body.rows.filter(function(r){return r.id==="of1";})[0];
  ok("office nOffice: namn/fastighet/ansvarig/adress/yta/arbetsplatser/budget/rum-antal", of1.name === "CMIAB Sthlm" && of1.fastighet === "Kungsgatan 1" && of1.ansvariga.length === 1 && of1.ansvariga[0].name === "Testare Testsson" && of1.adress === "Kammakargatan 12, Stockholm" && of1.yta === 200 && of1.arbetsplatser === 10 && of1.budget === 500000 && of1.motesrum === 1 && of1.intern === 2);
  // skapa kontor + auto-rum
  var mrBefore = (STORE.MeetingRoom || []).length, ilBefore = (STORE.Internal_room || []).length, ofBefore = STORE.Office.length;
  var oc = await call(s.routes, "post", "/admin/companies/:id/office/create", { params: { id: "cc1" }, body: { name: "CMIAB Malmö", fastighet_id: "f2", ansvarig_ids: ["co1"], yta: "350", arbetsplatser: "25", budget: "800000" } });
  ok("office/create ok + rum-rapport (1 mötesrum + 8 interna)", oc.body.ok && oc.body.rooms.meeting === 1 && oc.body.rooms.internal === 8 && STORE.Office.length === ofBefore + 1);
  var newOf = STORE.Office[STORE.Office.length - 1];
  ok("nytt kontor: Office_title/Kundföretag/Fastighet/Kontorsansvarig/Yta/Arbetsplatser/Budget", newOf["Office_title"] === "CMIAB Malmö" && newOf["Kundföretag"] === "cc1" && newOf["Fastighet"] === "f2" && JSON.stringify(newOf["Kontorsansvarig"]) === '["co1"]' && newOf["Yta"] === 350 && newOf["Arbetsplatser"] === 25 && newOf["Budget"] === 800000);
  ok("auto-rum skapade: 1 MeetingRoom + 8 Internal_room med rätt kopplingar", (STORE.MeetingRoom || []).length === mrBefore + 1 && (STORE.Internal_room || []).length === ilBefore + 8);
  var newMr = STORE.MeetingRoom[STORE.MeetingRoom.length - 1];
  var newIl = STORE.Internal_room[STORE.Internal_room.length - 1];
  ok("MeetingRoom: Name/office/Company", newMr.Name === "Mötesrum" && newMr.office === newOf._id && newMr.Company === "cc1");
  ok("Internal_room: Namn ur default-listan + kontor/kundföretag", newIl.Namn === "Kontorsrum" && newIl.kontor === newOf._id && newIl["kundföretag"] === "cc1");
  ok("Office-listorna Mötesrum/intern_lokal appendade (8 interna)", (newOf["Mötesrum"] || []).length === 1 && (newOf["intern_lokal"] || []).length === 8);
  var ocTom = await call(s.routes, "post", "/admin/companies/:id/office/create", { params: { id: "cc1" }, body: {} });
  ok("office/create utan namn → 400", ocTom.code === 400 && ocTom.body.error === "namn_krävs");
  // redigera kontor
  var op = await call(s.routes, "patch", "/admin/companies/office/:id", { params: { id: "of1" }, body: { name: "CMIAB Sthlm HK", yta: "225", ansvarig_ids: ["co2"] } });
  ok("office PATCH ok (namn/yta/ansvarig)", op.body.ok && STORE.Office[0]["Office_title"] === "CMIAB Sthlm HK" && STORE.Office[0]["Yta"] === 225 && JSON.stringify(STORE.Office[0]["Kontorsansvarig"]) === '["co2"]' && op.body.row.yta === 225);
  var opNo = await call(s.routes, "patch", "/admin/companies/office/:id", { params: { id: "of1" }, body: {} });
  ok("office PATCH inga fält → 400", opNo.code === 400 && opNo.body.error === "no_fields");
  var op404 = await call(s.routes, "patch", "/admin/companies/office/:id", { params: { id: "nope" }, body: { name: "X" } });
  ok("office PATCH okänt id → 404", op404.code === 404);

  // ── KONTOR 1b: rum (mötesrum + interna lokaler) ──
  var rm = await call(s.routes, "get", "/admin/companies/office/:id/rooms", { params: { id: "of1" } });
  ok("office rooms → union av Office-listan (i2, ingen ref) + ref-query (i1) → 2 interna + 1 mötesrum", rm.body.ok && rm.body.meetingrooms.length === 1 && rm.body.meetingrooms[0].name === "Stora mötesrummet" && rm.body.meetingrooms[0].email === "stora@acme.se" && rm.body.internals.length === 2 && rm.body.internals.some(function(r){return r.id==="i2";}));
  var rm404 = await call(s.routes, "get", "/admin/companies/office/:id/rooms", { params: { id: "nope" } });
  ok("office rooms okänt kontor → 404", rm404.code === 404);
  var ilBefore2 = STORE.Internal_room.length;
  var ra = await call(s.routes, "post", "/admin/companies/office/:id/room", { params: { id: "of1" }, body: { type: "internal", name: "Dusch" } });
  ok("room/create internal ok + rad skapad", ra.body.ok && STORE.Internal_room.length === ilBefore2 + 1);
  var newRoom = STORE.Internal_room[STORE.Internal_room.length - 1];
  ok("nytt internal-rum: Namn/kontor/kundföretag + Office.intern_lokal appendad", newRoom.Namn === "Dusch" && newRoom.kontor === "of1" && newRoom["kundföretag"] === "cc1" && (STORE.Office[0]["intern_lokal"] || []).indexOf(newRoom._id) > -1);
  var rmr = await call(s.routes, "post", "/admin/companies/office/:id/room", { params: { id: "of1" }, body: { type: "meeting", name: "Lilla rummet" } });
  ok("room/create meeting ok (Name/office/Company)", rmr.body.ok && STORE.MeetingRoom.some(function(r){return r.Name === "Lilla rummet" && r.office === "of1" && r.Company === "cc1";}));
  var raBad = await call(s.routes, "post", "/admin/companies/office/:id/room", { params: { id: "of1" }, body: { type: "x", name: "Y" } });
  ok("room/create bad_type → 400", raBad.code === 400 && raBad.body.error === "bad_type");
  var raTom = await call(s.routes, "post", "/admin/companies/office/:id/room", { params: { id: "of1" }, body: { type: "internal" } });
  ok("room/create utan namn → 400", raTom.code === 400 && raTom.body.error === "namn_krävs");
  var ra404 = await call(s.routes, "post", "/admin/companies/office/:id/room", { params: { id: "nope" }, body: { type: "internal", name: "X" } });
  ok("room/create okänt kontor → 404", ra404.code === 404);
  var delBefore = STORE.Internal_room.length;
  var rd = await call(s.routes, "delete", "/admin/companies/office/:oid/room/:rid", { params: { oid: "of1", rid: "i1" }, query: { type: "internal" } });
  ok("room DELETE ok + borttagen ur STORE + ur Office-listan", rd.body.ok && STORE.Internal_room.length === delBefore - 1 && !STORE.Internal_room.some(function(r){return r._id === "i1";}) && (STORE.Office[0]["intern_lokal"] || []).indexOf("i1") === -1);
  var rdBad = await call(s.routes, "delete", "/admin/companies/office/:oid/room/:rid", { params: { oid: "of1", rid: "i2" }, query: { type: "x" } });
  ok("room DELETE bad_type → 400", rdBad.code === 400 && rdBad.body.error === "bad_type");

  // ── LOGO (ClientCompany.logotyp) ──
  var lg = await call(s.routes, "post", "/admin/companies/:id/logo", { params: { id: "cc1" }, file: { buffer: Buffer.from("abc"), mimetype: "image/png" } });
  ok("logo upload ok → url + ClientCompany.logotyp satt", lg.body.ok && lg.body.url === "https://files/logo_cc1.png" && CC.cc1.logotyp === "https://files/logo_cc1.png");
  var lgClr = await call(s.routes, "post", "/admin/companies/:id/logo", { params: { id: "cc1" }, body: { clear: "1" } });
  ok("logo clear → logotyp tömt", lgClr.body.ok && lgClr.body.url === "" && CC.cc1.logotyp === "");
  var lgNo = await call(s.routes, "post", "/admin/companies/:id/logo", { params: { id: "cc1" }, body: {} });
  ok("logo utan fil (ej clear) → 400", lgNo.code === 400 && lgNo.body.error === "no_file");
  var lg404 = await call(s.routes, "post", "/admin/companies/:id/logo", { params: { id: "nope" }, file: { buffer: Buffer.from("x"), mimetype: "image/png" } });
  ok("logo okänt företag → 404", lg404.code === 404);

  // ── LEVERANTÖRER: dotterbolag (supplier.Kundföretag) + personal (User.Associated_company) ──
  var lev = await call(s.routes, "get", "/admin/companies/:id/leverantorer", { params: { id: "cc1" }, query: { user_company: "cc2" } });
  ok("leverantörer: dotterbolag kopplat (sup1) + tillgängligt (sup2)", lev.body.ok && lev.body.suppliers.length === 1 && lev.body.suppliers[0].name === "Carotte Housekeeping AB" && lev.body.suppliers[0].category === "Housekeeping" && lev.body.available.some(function(x){return x.id==="sup2";}));
  ok("leverantörer: personal kopplad (u1) + pool via Company==user_company (u2)", lev.body.personnel.length === 1 && lev.body.personnel[0].name === "Anna Andersson" && lev.body.personnel_available.length === 1 && lev.body.personnel_available[0].id === "u2");
  // koppla dotterbolag sup2
  var addSup = await call(s.routes, "post", "/admin/companies/:id/leverantor", { params: { id: "cc1" }, body: { supplier_id: "sup2" } });
  ok("leverantor add → company appendad till supplier.Kundföretag", addSup.body.ok && (STORE["Leverantör - Supplier"][1]["Kundföretag"] || []).indexOf("cc1") > -1);
  var delSup = await call(s.routes, "delete", "/admin/companies/:id/leverantor/:sid", { params: { id: "cc1", sid: "sup1" } });
  ok("leverantor delete → company borttagen ur supplier.Kundföretag", delSup.body.ok && (STORE["Leverantör - Supplier"][0]["Kundföretag"] || []).indexOf("cc1") === -1);
  var addSup404 = await call(s.routes, "post", "/admin/companies/:id/leverantor", { params: { id: "cc1" }, body: { supplier_id: "nope" } });
  ok("leverantor add okänd → 404", addSup404.code === 404);
  // koppla personal u2
  var addP = await call(s.routes, "post", "/admin/companies/:id/personal", { params: { id: "cc1" }, body: { user_id: "u2" } });
  ok("personal add → company appendad till User.Associated_company", addP.body.ok && (STORE.User[1]["Associated_company"] || []).indexOf("cc1") > -1);
  var delP = await call(s.routes, "delete", "/admin/companies/:id/personal/:uid", { params: { id: "cc1", uid: "u1" } });
  ok("personal delete → company borttagen ur Associated_company", delP.body.ok && (STORE.User[0]["Associated_company"] || []).indexOf("cc1") === -1);
  var addP404 = await call(s.routes, "post", "/admin/companies/:id/personal", { params: { id: "cc1" }, body: { user_id: "nope" } });
  ok("personal add okänd user → 404", addP404.code === 404);

  // ── FASTIGHETSÄGARE (Hyresvärd.Hyresgäster) ──
  var fa = await call(s.routes, "get", "/admin/companies/:id/fastighetsagare", { params: { id: "cc1" } });
  ok("fastighetsägare: kopplad (Vasakronan) + tillgänglig (Fabege)", fa.body.ok && fa.body.landlords.length === 1 && fa.body.landlords[0].name === "Vasakronan" && fa.body.available.some(function(x){return x.id==="hv2";}));
  var addHv = await call(s.routes, "post", "/admin/companies/:id/fastighetsagare", { params: { id: "cc1" }, body: { landlord_id: "hv2" } });
  ok("fastighetsägare add → company appendad till Hyresvärd.Hyresgäster", addHv.body.ok && (STORE["Hyresvärd"][1]["Hyresgäster"] || []).indexOf("cc1") > -1);
  var delHv = await call(s.routes, "delete", "/admin/companies/:id/fastighetsagare/:hid", { params: { id: "cc1", hid: "hv1" } });
  ok("fastighetsägare delete → company borttagen ur Hyresgäster", delHv.body.ok && (STORE["Hyresvärd"][0]["Hyresgäster"] || []).indexOf("cc1") === -1);
  var addHv404 = await call(s.routes, "post", "/admin/companies/:id/fastighetsagare", { params: { id: "cc1" }, body: { landlord_id: "nope" } });
  ok("fastighetsägare add okänd → 404", addHv404.code === 404);

  // ── DRIFT: ärenden (Matter) + kvalitetskontroller (QualityControl) ──
  var mts = await call(s.routes, "get", "/admin/companies/:id/matters", { params: { id: "cc1" } });
  ok("matters → 3 (cc1, ej cc2), nyast först + fält (referens/kontor resolvade)", mts.body.ok && mts.body.count === 3 && mts.body.rows[0].id === "mt1" && mts.body.rows[0].referens === "Anna Andersson" && mts.body.rows[0].kontor === "CMIAB Göteborg" && mts.body.rows[0].open === true && mts.body.rows.every(function(r){return r.id!=="mt4";}));
  ok("matters: avvikelse-flagga (mt3) + status (mt2 avslutad)", mts.body.rows.filter(function(r){return r.id==="mt3";})[0].avvikelse === true && mts.body.rows.filter(function(r){return r.id==="mt2";})[0].open === false);
  var mdet = await call(s.routes, "get", "/admin/companies/matter/:id", { params: { id: "mt1" } });
  ok("matter detalj: team_intern (co1) + tråd + beskrivning", mdet.body.ok && mdet.body.matter.team_intern.length === 1 && mdet.body.matter.team_intern[0] === "Testare Testsson" && mdet.body.matter.trad.length === 1 && mdet.body.matter.beskrivning === "Fungerar ej");
  var mdet404 = await call(s.routes, "get", "/admin/companies/matter/:id", { params: { id: "nope" } });
  ok("matter detalj okänt id → 404", mdet404.code === 404);
  var qcs = await call(s.routes, "get", "/admin/companies/:id/qc", { params: { id: "cc1" } });
  ok("qc → 1 (cc1) + resolvade namn (avtal/kontor/leverantör/kontrollant)", qcs.body.ok && qcs.body.count === 1 && qcs.body.rows[0].avtal === "Reception CMIAB" && qcs.body.rows[0].kontor === "CMIAB Göteborg" && qcs.body.rows[0].leverantor === "Carotte Housekeeping AB" && qcs.body.rows[0].kontrollant === "Anna Andersson" && qcs.body.rows[0].snittbetyg === 4);
  var qdet = await call(s.routes, "get", "/admin/companies/qc/:id", { params: { id: "qc1" } });
  ok("qc detalj: 2 ytor m. rätt namn/betyg + snittbetyg 4 (medel Grade.Värde)", qdet.body.ok && qdet.body.qc.surfaces.length === 2 && qdet.body.qc.surfaces.some(function(x){return x.namn==="Toaletter" && x.betyg===4;}) && qdet.body.qc.surfaces.some(function(x){return x.namn==="Stora mötesrummet";}) && qdet.body.qc.snittbetyg === 4);
  ok("qc detalj: header (kund/avtal/leverantör) + summering + kundutvärdering + mottagare", qdet.body.qc.kund === "Acme AB" && qdet.body.qc.summering.arbetsklader === true && qdet.body.qc.summering.servicekort === false && qdet.body.qc.summering.stadforrad === true && qdet.body.qc.kundutvardering.feedback === "Nöjda" && qdet.body.qc.kundreferens[0] === "Testare Testsson");
  var qdet404 = await call(s.routes, "get", "/admin/companies/qc/:id", { params: { id: "nope" } });
  ok("qc detalj okänt id → 404", qdet404.code === 404);

  // ── DRIFT stå-alone: aggregerar över ALLA kunder + sök/filter ──
  var dOpen = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "open" } });
  ok("drift open → 3 (mt1/mt3/mt4 över cc1+cc2) + företagsnamn resolvat", dOpen.body.ok && dOpen.body.total === 3 && dOpen.body.rows.some(function(r){return r.id==="mt4" && r.company==="Beta Bygg AB";}) && dOpen.body.rows.some(function(r){return r.id==="mt1" && r.company==="Acme AB";}));
  var dClosed = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "closed" } });
  ok("drift closed → 1 (mt2 Avslutad)", dClosed.body.total === 1 && dClosed.body.rows[0].id === "mt2");
  var dAvv = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "avvikelser" } });
  ok("drift avvikelser → 1 (mt3)", dAvv.body.total === 1 && dAvv.body.rows[0].id === "mt3");
  var dQ = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "open", q: "kaffe" } });
  ok("drift sök rubrik (text contains) → 1 (mt1)", dQ.body.total === 1 && dQ.body.rows[0].id === "mt1");
  var dCo = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "open", company: "beta" } });
  ok("drift företagsnamn-filter (Beta) → 1 (mt4)", dCo.body.total === 1 && dCo.body.rows[0].id === "mt4");
  var dPrio = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "open" } });
  ok("drift matters bär prioritet-facet", Array.isArray(dPrio.body.prioriteter));
  var dQC = await call(s.routes, "get", "/admin/drift/list", { query: { type: "qc" } });
  ok("drift qc → 1 (qc1) + företagsnamn resolvat", dQC.body.ok && dQC.body.total === 1 && dQC.body.rows[0].id === "qc1" && dQC.body.rows[0].company === "Acme AB");

  // ── Aktivitet-fliken: aktiviteter där personen är taggad (taggade_personer contains) ──
  var av1 = await call(s.routes, "get", "/admin/companies/coworker/:id/activities", { params: { id: "co1" } });
  ok("activities co1 → 2 (act1+act2), nyast först + fält", av1.body.count === 2 && av1.body.rows[0].id === "act1" && av1.body.rows[0].typ === "Kundmöte" && av1.body.rows[0].fas === "Fas 2" && av1.body.rows[0].genomfort === true);
  var av2 = await call(s.routes, "get", "/admin/companies/coworker/:id/activities", { params: { id: "co2" } });
  ok("activities co2 → 2 (act2+act3)", av2.body.count === 2 && av2.body.rows.some(function(r){return r.id==="act3";}));
  // utan pwResetTemplateId → 501 not_configured
  var noTplDeps = Object.assign({}, deps, { pwResetTemplateId: "" });
  var nts = mk(); registerCompaniesRoutes(nts.app, noTplDeps);
  var pw501 = await call(nts.routes, "post", "/admin/companies/coworker/:id/send-password", { params: { id: "co1" } });
  ok("send-password utan template → 501 not_configured", pw501.code === 501 && pw501.body.error === "not_configured");
  ok("card meta editable inkl kunddata-fält", card.body.meta.editable.email === "text" && card.body.meta.editable.kundinformation === "text");
  var card404 = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "nope" } });
  ok("card okänt id → 404", card404.code === 404);

  // ── PATCH på nya kunddata-fält (email/web/kundinformation) ──
  var pce = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc1" }, body: { fields: { email: "ny@acme.se", web: "nyacme.se", kundinformation: "Uppdaterad" } } });
  ok("patch kunddata-fält ok", pce.body.ok && CC.cc1.Email === "ny@acme.se" && CC.cc1.hemsida_crm === "nyacme.se" && CC.cc1.kundinfo_crm === "Uppdaterad");

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
