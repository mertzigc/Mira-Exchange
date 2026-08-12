// Smoke: skapa aktivitet + todo via affar_api. Mockad Bubble. node affar_create_smoke.mjs
import { registerAffarRoutes } from "./affar_api.js";

const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
function call(method, path, { params = {}, query = {}, body = {} } = {}) {
  const h = routes[method][path];
  if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((resolve) => {
    const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); }, sendStatus(c) { resolve({ code: c }); } };
    h({ params, query, body, headers: {} }, res);
  });
}

const created = []; // {type, id, payload}
const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }],
  User: [{ _id: "u1", "First Name": "Sara", "Last Name": "S" }],
  deal: [{ _id: "d1", titel: "Acme lunch", "kundföretag": "cc1", todo: ["t_old"] }],
  Lead: [{ _id: "lead1", Name: "Kalle Kund", status: "Ny" }],
  activitet_crm: [{ _id: "akt1", beskrivning: "Ringde kund" }], Todo: [{ _id: "t_old" }], "leverantör-supplier": [], Coworker: [],
};
let seq = 1;
const _match = (rec, c) => { const v = rec[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); return true; };
let patched = [];
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFind: async (t, { constraints = [], limit = 100 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCount: async (t) => (DB[t] || []).length,
  bubblePatch: async (t, id, p) => { patched.push({ t, id, p }); const r = (DB[t] || []).find((x) => x._id === id); if (r) Object.assign(r, p); return {}; },
  bubbleCreate: async (t, payload) => { const id = t.toLowerCase() + "_" + (seq++); const rec = { _id: id, ...payload }; (DB[t] = DB[t] || []).push(rec); created.push({ t, id, payload }); return id; },
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE_CONN", CONNECTION_NAMES: { FE_CONN: "Food & Event" },
};
registerAffarRoutes(app, deps);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  // ── aktivitet: enkel ──
  const a1 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Säljsamtal", beskrivning: "Ringde", company_id: "cc1", deal_id: "d1" } });
  ok("aktivitet ok", a1.body.ok);
  const c1 = created.find((c) => c.t === "activitet_crm");
  ok("aktivitet payload activity_type+beskrivning", c1.payload.activity_type === "Säljsamtal" && c1.payload.beskrivning === "Ringde");
  ok("aktivitet company+deal satt", c1.payload.company === "cc1" && c1.payload.deal === "d1");
  ok("icke-Kundmöte → ingen Kundmöte/Datum_bokning-nyckel", !("Kundmöte" in c1.payload) && !("Datum_bokning" in c1.payload));
  ok("aktivitet row returneras (nAktFull)", a1.body.row && a1.body.row.type === "Aktivitet");

  // ── aktivitet: Kundmöte + genomfört + anteckning ──
  const a2 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Kundmöte", beskrivning: "Möte", fas: "Fas 2", motesdatum: "2026-08-10", genomfort: true, motesanteckning: "Bra möte" } });
  const c2 = created.filter((c) => c.t === "activitet_crm")[1];
  ok("Kundmöte: Kundmöte(fas)+Datum_bokning ISO", c2.payload["Kundmöte"] === "Fas 2" && /^2026-08-10T/.test(c2.payload["Datum_bokning"]));
  ok("Kundmöte: genomfört=true + mötesantecking", c2.payload["genomfört"] === true && c2.payload["mötesantecking"] === "Bra möte");

  // ── aktivitet: tom → 400 ──
  const a3 = await call("post", "/admin/affar/aktivitet/create", { body: {} });
  ok("tom aktivitet → 400", a3.code === 400);

  // ── todo: full + deal-append ──
  patched = [];
  const t1 = await call("post", "/admin/affar/todo/create", { body: { titel: "Följ upp", beskrivning: "desc", kategori: "Food & Event", status: "Planerad", starttid: "2026-08-07T22:00", sluttid: "2026-08-07T23:00", company_id: "cc1", coworker_id: "co1", user_id: "u1", deal_id: "d1" } });
  ok("todo ok + deal_linked", t1.body.ok && t1.body.deal_linked === true);
  const ct = created.find((c) => c.t === "Todo");
  ok("todo Titel/Beskrivning/Kategori/Status", ct.payload["Titel"] === "Följ upp" && ct.payload["Beskrivning"] === "desc" && ct.payload["Kategori"] === "Food & Event" && ct.payload["Status"] === "Planerad");
  ok("todo Starttid/Sluttid ISO", /^2026-08-07T/.test(ct.payload["Starttid"]) && /^2026-08-07T/.test(ct.payload["Sluttid"]));
  ok("todo Företag/Medarbetare/user", ct.payload["Företag"] === "cc1" && ct.payload["Medarbetare"] === "co1" && ct.payload["user"] === "u1");
  const dealPatch = patched.find((p) => p.t === "deal" && p.id === "d1");
  ok("Deal.todo append (behåller t_old + ny)", dealPatch && dealPatch.p.todo.indexOf("t_old") > -1 && dealPatch.p.todo.indexOf(ct.id) > -1 && dealPatch.p.todo.length === 2);

  // ── todo utan titel → 400 ──
  const t2 = await call("post", "/admin/affar/todo/create", { body: { beskrivning: "x" } });
  ok("todo utan titel → 400", t2.code === 400);

  // ── todo utan deal → deal_linked false, ingen deal-patch ──
  patched = [];
  const t3 = await call("post", "/admin/affar/todo/create", { body: { titel: "Solo todo" } });
  ok("todo utan deal → deal_linked false", t3.body.ok && t3.body.deal_linked === false && !patched.some((p) => p.t === "deal"));

  // ── skapa affär från LEAD (+ koppla + lead→Delegerad) ──
  patched = [];
  const dc = await call("post", "/admin/affar/deal/create", { body: { titel: "Acme – F&E", beskrivning: "Från lead", kundforetag_id: "cc1", kategori: "Food & Event", value_brutto: 50000, deal_owner: "u1", source_type: "lead", source_id: "lead1" } });
  ok("deal/create ok + deal_id + linked + lead_status_set", dc.body.ok && !!dc.body.deal_id && dc.body.linked === true && dc.body.lead_status_set === true);
  const cd = created.find((c) => c.t === "deal");
  ok("deal payload titel + Status=Kundkontakt (auto) + beskrivning", cd.payload.titel === "Acme – F&E" && cd.payload.Status === "Kundkontakt" && cd.payload.beskrivning === "Från lead");
  ok("deal kundföretag + Kategori(list) + value_brutto + deal_owner(list)", cd.payload["kundföretag"] === "cc1" && Array.isArray(cd.payload.Kategori) && cd.payload.Kategori[0] === "Food & Event" && cd.payload.value_brutto === 50000 && Array.isArray(cd.payload.deal_owner) && cd.payload.deal_owner[0] === "u1");
  const leadLink = patched.find((p) => p.t === "Lead" && p.id === "lead1" && p.p.deal);
  ok("lead kopplad → nya affärens deal-id", leadLink && leadLink.p.deal === cd.id);
  const leadStat = patched.find((p) => p.t === "Lead" && p.id === "lead1" && p.p.status);
  ok("lead status → Delegerad", leadStat && leadStat.p.status === "Delegerad");

  // ── titel obligatorisk ──
  const dcBad = await call("post", "/admin/affar/deal/create", { body: { source_type: "lead", source_id: "lead1" } });
  ok("deal/create utan titel → 400 titel_krävs", dcBad.code === 400 && dcBad.body.error === "titel_krävs");

  // ── skapa affär från AKTIVITET (koppla, ingen lead-status) ──
  patched = [];
  const dcA = await call("post", "/admin/affar/deal/create", { body: { titel: "Från akt", source_type: "aktivitet", source_id: "akt1" } });
  ok("deal/create från aktivitet ok + linked, lead_status_set=false", dcA.body.ok && dcA.body.linked === true && dcA.body.lead_status_set === false);
  const aktLink = patched.find((p) => p.t === "activitet_crm" && p.id === "akt1" && p.p.deal);
  ok("aktivitet kopplad → nya affären", aktLink && aktLink.p.deal === dcA.body.deal_id);
  ok("ingen lead-status-patch vid aktivitet-källa", !patched.some((p) => p.t === "Lead"));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
