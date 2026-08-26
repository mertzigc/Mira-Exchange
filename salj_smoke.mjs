// Smoke: sälj mötestratt + attribution + säljmål. node salj_smoke.mjs
import { registerSaljRoutes } from "./salj_api.js";
import { readFileSync } from "node:fs";
const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
// ⚠️ call() svarar 404 på okänd route — den KASTAR aldrig. En kastande testram
// dödar hela sviten vid första anropet mot en route som inte finns i gammal kod,
// och då rapporterar mutationstestet en påhittad siffra (2026-08-24: dolde 13 fel).
// Se [[feedback-testet-ska-falla-inte-krascha]].
function call(method, path, { params = {}, query = {}, body = {} } = {}) {
  const h = routes[method][path];
  if (!h) return Promise.resolve({ code: 404, body: { ok: false, error: "no_route", route: method + " " + path } });
  return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }; h({ params, query, body, headers: {} }, res); });
}
let seq = 1;
const DB = {
  User: [{ _id: "u1", "First Name": "Anna", "Surname": "Andersson", salesmanager: true }, { _id: "u2", "First Name": "Bertil", "Surname": "Berg" }],
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }],
  deal: [{ _id: "d1", titel: "Acme F&E", value_brutto: 50000, Status: "Avtal" }, { _id: "d2", titel: "Beta städ", value_brutto: 20000, Status: "Offert" }],
  activitet_crm: [
    { _id: "a1", activity_type: "Kundmöte", "Kundmöte": "Fas 1", "Datum_bokning": "2026-08-10", "genomfört": true, writer: "u1", company: "cc1", deal: "d1", beskrivning: "Uppstart" },
    { _id: "a2", activity_type: "Kundmöte", "Kundmöte": "Fas 2", "Datum_bokning": "2026-08-15", "genomfört": false, writer: "u1", company: "cc1" },
    { _id: "a3", activity_type: "Kundmöte", "Kundmöte": "Fas 1", "Datum_bokning": "2026-08-20", "genomfört": true, writer: "u2", company: "cc1", deal: "d2" },
    { _id: "a4", activity_type: "Kundmöte", "Kundmöte": "Fas 3", "Datum_bokning": "2026-09-05", writer: "u1", company: "cc1" },   // annan månad
    { _id: "a5", activity_type: "Säljsamtal", "Datum_bokning": "2026-08-11", writer: "u1" },   // ej Kundmöte → exkluderas
  ],
  SalesBudget: [
    { _id: "sb1", User: "u1", Startdatum: "2026-08-01T00:00:00.000Z", Slutdatum: "2026-08-31T00:00:00.000Z", mal_fas1: 5, mal_fas2: 3, mal_fas3: 2, mal_fas4: 0, mal_ovrigt: 0, total_kundmote: 10, total_affar: 3, total_invoice: 100000, active: true, "Godkänd": false, kommentar: "Augusti" },
  ],
};
const _n = (v) => (typeof v === "number" ? v : parseFloat(v));

// ⚠️ MOCKA ALDRIG MER TILLÅTANDE ÄN BUBBLE ([[feedback-mocka-aldrig-mer-tillatande]]).
// Fyra skarpa buggar har passerat gröna sviter för att fixturen accepterade mer än
// verkligheten. Här härmas tre av Bubbles avvisningar:
//   1. okänt FÄLT vid skrivning → 400 "Unrecognized field: X", HELA skrivningen faller
//   2. constraint-nyckel = SLUG-form, inte display-namn (de skiljer sig!)
//   3. constraint_type utanför Bubbles lista (det finns t.ex. INGET "greater than or equal")
const KNOWN_FIELDS = {
  // Schema-verifierat 2026-08-14 + de tre fält som lagts till sedan dess.
  activitet_crm: new Set(["activity_type", "beskrivning", "company", "Datum_bokning", "deal", "genomfört",
    "Kundmöte", "lead", "Leverantör", "mötesantecking", "mötesanteckning_writer", "taggade_personer",
    "user_tag", "writer", "aktivitet_nasta_steg", "nasta_steg_kommentar", "anteckning_todo", "Created Date"]),
  // Todo-fält enligt [[reference-bubble-todo-fields]] (skärmdump 2026-08-07).
  Todo: new Set(["Titel", "Beskrivning", "Kategori", "Status", "frekvens_kontroll", "Starttid", "Sluttid",
    "Företag", "Medarbetare", "user", "lead", "contracts", "Tråd", "kvalitetskontroll", "qualitycontrol", "reminder_sent"]),
};
// Fält som "ännu inte finns i Bubble" — driver nedgraderings-testerna.
const MISSING = new Set();
function bubble400(field) {
  const e = new Error("bubble write failed");
  e.detail = { status: 400, body: { status: "ERROR", message: "Unrecognized field: " + field } };
  throw e;
}
function assertFields(t, p) {
  const known = KNOWN_FIELDS[t];
  for (const k of Object.keys(p || {})) {
    if (MISSING.has(t + "." + k)) bubble400(k);
    if (known && !known.has(k)) bubble400(k);
  }
}
// Constraint-nyckel (slug) → läsnyckel (display). Okänd nyckel KASTAR: ett felstavat
// constraint ska falla högljutt, inte tyst matcha allt (jfr FortnoxOrder.connection_id).
const CONSTRAINT_KEY = { activity_type: "activity_type", datum_bokning_date: "Datum_bokning", User: "User" };
const _cts = (v) => { const t = Date.parse(String(v == null ? "" : v)); return Number.isNaN(t) ? null : t; };
const _match = (r, c) => {
  const key = CONSTRAINT_KEY[c.key];
  if (!key) throw new Error("okänd constraint-nyckel: " + c.key + " (constraints använder SLUG-form)");
  const v = r[key];
  if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value);
  if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v));
  // ⚠️ Bubble saknar >= och <=. En ogiltig constraint_type avvisar HELA frågan.
  if (c.constraint_type === "greater than") { const a = _cts(v), b = _cts(c.value); return a != null && b != null && a > b; }
  if (c.constraint_type === "less than")    { const a = _cts(v), b = _cts(c.value); return a != null && b != null && a < b; }
  throw new Error("ogiltig constraint_type: " + c.constraint_type);
};
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFind: async (t, { constraints = [], limit = 300 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCreate: async (t, p) => { assertFields(t, p); const id = t.toLowerCase() + "_" + (seq++); (DB[t] = DB[t] || []).push({ _id: id, ...p }); return id; },
  bubblePatch: async (t, id, p) => { assertFields(t, p); const r = (DB[t] || []).find((x) => x._id === id); if (r) Object.assign(r, p); return {}; },
  bubbleDelete: async (t, id) => { const a = DB[t] || []; const i = a.findIndex((x) => x._id === id); if (i > -1) a.splice(i, 1); return {}; },
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
};
registerSaljRoutes(app, deps);
let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  // ── mötestratt (ofiltrerad) ──
  const m = await call("get", "/admin/salj/moten", { query: {} });
  ok("moten ok + 5 fas-grupper", m.body.ok && m.body.groups.length === 5 && m.body.groups[0].fas === "Fas 1");
  const fas1 = m.body.groups.find((g) => g.fas === "Fas 1");
  ok("Fas 1 = a1 + a3 (sorterat på datum)", fas1.moten.length === 2 && fas1.moten[0].id === "a1" && fas1.moten[1].id === "a3");
  ok("a5 (Säljsamtal) exkluderas", !m.body.groups.some((g) => g.moten.some((x) => x.id === "a5")));
  ok("summary: total 4, genomförda 2, blev_affär 2, konvertering 50%", m.body.summary.total === 4 && m.body.summary.genomforda === 2 && m.body.summary.blev_affar === 2 && m.body.summary.konvertering === 50);
  ok("summary: affärsvärde 50000+20000=70000", m.body.summary.affarsvarde === 70000);
  ok("attribution: a1 blev_affär m. deal-namn+värde", fas1.moten[0].blev_affar === true && fas1.moten[0].deal_name === "Acme F&E" && fas1.moten[0].deal_value === 50000);
  ok("a2 blev_affär false", m.body.groups.find((g) => g.fas === "Fas 2").moten[0].blev_affar === false);
  ok("personer: u1 + u2", m.body.personer.length === 2 && m.body.personer.map((p) => p.id).sort().join() === "u1,u2");
  ok("per_fas: Fas1=2 Fas2=1 Fas3=1 Fas4=0", m.body.per_fas["Fas 1"] === 2 && m.body.per_fas["Fas 2"] === 1 && m.body.per_fas["Fas 3"] === 1 && m.body.per_fas["Fas 4"] === 0);

  // ── datumfilter (bara augusti) ──
  const mAug = await call("get", "/admin/salj/moten", { query: { from: "2026-08-01", to: "2026-08-31" } });
  ok("augusti: a4 (sept) exkluderad → total 3", mAug.body.summary.total === 3 && mAug.body.filtered === true);
  ok("augusti: Fas 3 tom (a4 borta)", mAug.body.per_fas["Fas 3"] === 0);

  // ── personfilter u1 ──
  const mU1 = await call("get", "/admin/salj/moten", { query: { person: "u1" } });
  ok("person u1: a1+a2+a4 → total 3, blev_affär 1, värde 50000", mU1.body.summary.total === 3 && mU1.body.summary.blev_affar === 1 && mU1.body.summary.affarsvarde === 50000);

  // ── säljmål GET (augusti) ──
  const b = await call("get", "/admin/salj/budget", { query: { month: "2026-08" } });
  ok("budget ok + 1 rad (u1 har SalesBudget)", b.body.ok && b.body.rows.length === 1 && b.body.rows[0].user_id === "u1");
  const r0 = b.body.rows[0];
  ok("u1 mål: möten 10 / affär 3 / invoice 100000", r0.mal.moten === 10 && r0.mal.affar === 3 && r0.mal.invoice === 100000);
  ok("u1 utfall augusti: möten 2 (a1,a2), genomförda 1, blev_affär 1, värde 50000", r0.utfall.moten === 2 && r0.utfall.genomforda === 1 && r0.utfall.blev_affar === 1 && r0.utfall.affarsvarde === 50000);
  ok("budget total-summa", b.body.total.mal_moten === 10 && b.body.total.moten === 2 && b.body.total.affarsvarde === 50000);
  ok("users-picker + taken=[u1]", b.body.users.length === 2 && b.body.taken.length === 1 && b.body.taken[0] === "u1");
  // ── per-fas mål + utfall ──
  ok("u1 mål per fas: F1=5 F2=3 F3=2, summa 10", r0.mal.moten_fas["Fas 1"] === 5 && r0.mal.moten_fas["Fas 2"] === 3 && r0.mal.moten_fas["Fas 3"] === 2 && r0.mal.moten === 10);
  ok("u1 utfall per fas: F1=1 (a1) F2=1 (a2)", r0.utfall.moten_fas["Fas 1"] === 1 && r0.utfall.moten_fas["Fas 2"] === 1 && r0.utfall.moten_fas["Fas 3"] === 0);

  // ── egen-scope (user_id filter) ──
  const bOwn = await call("get", "/admin/salj/budget", { query: { month: "2026-08", user_id: "u1" } });
  ok("user_id=u1 → bara u1:s rad", bOwn.body.rows.length === 1 && bOwn.body.rows[0].user_id === "u1");
  const bNone = await call("get", "/admin/salj/budget", { query: { month: "2026-08", user_id: "u2" } });
  ok("user_id=u2 (ingen budget) → 0 rader", bNone.body.rows.length === 0);

  // ── month saknas → 400 ──
  const bBad = await call("get", "/admin/salj/budget", { query: {} });
  ok("budget utan month → 400", bBad.code === 400 && bBad.body.error === "month_krävs");

  // ── säljmål SET: per-fas + by_user (chef) ──
  const setU1 = await call("post", "/admin/salj/budget/set", { body: { user_id: "u1", month: "2026-08", by_user: "u1", mal_fas: { "Fas 1": 6, "Fas 2": 4, "Fas 3": 2, "Fas 4": 1, "Övrigt": 0 }, total_affar: 4, total_invoice: 120000, godkand: true } });
  ok("set u1 (chef) → uppdaterar befintlig (created false)", setU1.body.ok && setU1.body.created === false && setU1.body.budget_id === "sb1");
  const sb1 = DB.SalesBudget.find((x) => x._id === "sb1");
  ok("sb1 per-fas skrivet + total_kundmote=summa 13", sb1.mal_fas1 === 6 && sb1.mal_fas2 === 4 && sb1.mal_fas4 === 1 && sb1.total_kundmote === 13 && sb1["Godkänd"] === true);

  // ── SET by_user icke-chef → 403 ──
  const set403 = await call("post", "/admin/salj/budget/set", { body: { user_id: "u1", month: "2026-08", by_user: "u2", mal_fas: { "Fas 1": 99 } } });
  ok("set by_user=u2 (ej salesmanager) → 403 ej_salesmanager", set403.code === 403 && set403.body.error === "ej_salesmanager");
  ok("sb1 orört efter 403", DB.SalesBudget.find((x) => x._id === "sb1").mal_fas1 === 6);
  const setNoBy = await call("post", "/admin/salj/budget/set", { body: { user_id: "u1", month: "2026-08", mal_fas: { "Fas 1": 7, "Fas 2": 0, "Fas 3": 0, "Fas 4": 0, "Övrigt": 0 } } });
  ok("set utan by_user (admin/curl) → släpps igenom", setNoBy.body.ok && DB.SalesBudget.find((x) => x._id === "sb1").mal_fas1 === 7);

  // ── säljmål SET: skapa ny (u2 aug) ──
  const setU2 = await call("post", "/admin/salj/budget/set", { body: { user_id: "u2", month: "2026-08", total_kundmote: 8, total_affar: 2, total_invoice: 60000 } });
  ok("set u2 → skapar ny (created true)", setU2.body.ok && setU2.body.created === true);
  const newSb = DB.SalesBudget.find((x) => x.User === "u2");
  ok("ny SalesBudget: User u2 + Startdatum aug + total_affar 2", newSb && /^2026-08-01/.test(newSb.Startdatum) && newSb.total_affar === 2);

  // efter u2-budget → budget-GET har 2 rader
  const b2 = await call("get", "/admin/salj/budget", { query: { month: "2026-08" } });
  ok("nu 2 säljare i augusti-budgeten", b2.body.rows.length === 2);
  const u2row = b2.body.rows.find((x) => x.user_id === "u2");
  ok("u2 utfall: 1 möte (a3), blev_affär 1, värde 20000", u2row.utfall.moten === 1 && u2row.utfall.blev_affar === 1 && u2row.utfall.affarsvarde === 20000);

  // ── set utan user_id → 400 ──
  const setBad = await call("post", "/admin/salj/budget/set", { body: { month: "2026-08" } });
  ok("set utan user_id → 400", setBad.code === 400 && setBad.body.error === "user_id_krävs");

  // ── mötes-redigering (a3 ägs av u2) ──
  // ⚠️ genomfort:true kräver nu ett nästa steg (grinden 2026-08-21) — även här.
  const pOwner = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "a3" }, body: { by_user: "u2", fas: "Fas 2", genomfort: true, motesanteckning: "Bra möte", beskrivning: "Uppföljning", nasta_steg: "avslutat", nasta_steg_kommentar: "Kunden valde konkurrent" } });
  ok("ägare (u2) redigerar eget möte → ok", pOwner.body.ok && pOwner.body.mote);
  const a3 = DB.activitet_crm.find((x) => x._id === "a3");
  ok("möte patchat: fas/genomfört/anteckning/beskr", a3["Kundmöte"] === "Fas 2" && a3["genomfört"] === true && a3["mötesantecking"] === "Bra möte" && a3.beskrivning === "Uppföljning");
  const mo = (r) => (r.body || {}).mote || {};
  ok("returnerat mote har motesanteckning", mo(pOwner).motesanteckning === "Bra möte" && mo(pOwner).genomfort === true);

  // salesmanager (u1) redigerar annans möte (a3) → ok
  const pMgr = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "a3" }, body: { by_user: "u1", fas: "Fas 3" } });
  ok("salesmanager (u1) redigerar annans möte → ok", pMgr.body.ok && DB.activitet_crm.find((x) => x._id === "a3")["Kundmöte"] === "Fas 3");

  // icke-ägare icke-chef (u2) redigerar a1 (ägs u1) → 403
  const p403 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "a1" }, body: { by_user: "u2", fas: "Övrigt" } });
  ok("icke-ägare icke-chef → 403 ej_behörig", p403.code === 403 && p403.body.error === "ej_behörig");
  ok("a1 orört efter 403", DB.activitet_crm.find((x) => x._id === "a1")["Kundmöte"] === "Fas 1");

  // utan by_user (admin/curl) → släpps
  const pAdmin = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "a1" }, body: { beskrivning: "Admin-ändring" } });
  ok("utan by_user (admin) → släpps", pAdmin.body.ok && DB.activitet_crm.find((x) => x._id === "a1").beskrivning === "Admin-ändring");

  // okänt id → 404
  const p404 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "nope" }, body: { by_user: "u1", fas: "Fas 1" } });
  ok("okänt möte → 404", p404.code === 404 && p404.body.error === "möte_not_found");

  // ══════════════════════════════════════════════════════════════════════════
  // NÄSTA STEG-GRINDEN i mötesbokningsvyn (2026-08-21)
  // TREDJE skrivaren av `genomfört`. Utan grind här var kravet bara en artighet i
  // två vyer av tre. ⚠️ Bubble-fält: `aktivitet_nasta_steg` (Option Set).
  // ══════════════════════════════════════════════════════════════════════════
  DB.activitet_crm.push({ _id: "aG1", activity_type: "Kundmöte", writer: "u2", "genomfört": false, beskrivning: "Pågår" });
  const sg1 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG1" }, body: { genomfort: true, motesanteckning: "Klart" } });
  ok("grind: markera genomförd utan nästa steg → 400",
     sg1.code === 400 && sg1.body.error === "nasta_steg_krävs");
  const sg2 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG1" }, body: { genomfort: true, motesanteckning: "Klart", nasta_steg: "hittepa" } });
  ok("grind: okänt värde → 400", sg2.code === 400 && sg2.body.error === "okänt_nasta_steg");
  const sg3 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG1" }, body: { genomfort: true, motesanteckning: "Klart", nasta_steg: "avslutat", nasta_steg_kommentar: "Budget drogs in" } });
  ok("grind: med nästa steg → sparas i RÄTT Bubble-fält",
     sg3.body.ok === true && DB.activitet_crm.find((x) => x._id === "aG1")["aktivitet_nasta_steg"] === "avslutat" &&
     sg3.body.nasta_steg_field_missing === false);
  const sg4 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG1" }, body: { motesanteckning: "Rättar stavfel" } });
  ok("grind: beslut redan fattat → ingen ny fråga", sg4.body.ok === true);
  // ⚠️ Grinden får INTE blockera sparningar som inte rör avklarandet.
  DB.activitet_crm.push({ _id: "aG2", activity_type: "Kundmöte", writer: "u2", "genomfört": true, beskrivning: "Gammalt klart möte" });
  const sg5 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG2" }, body: { fas: "Fas 3" } });
  ok("grind: patch som bara ändrar fas blockeras INTE", sg5.body.ok === true);
  const sg6 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG2" }, body: { motesanteckning: "Efterhandsanteckning" } });
  ok("grind: gammalt genomfört möte UTAN beslut grindas när anteckningen rörs",
     sg6.code === 400 && sg6.body.error === "nasta_steg_krävs");
  // Option set som {display}-objekt får inte se ut som ett värde när det saknas
  DB.activitet_crm.push({ _id: "aG3", activity_type: "Kundmöte", writer: "u2", "genomfört": true, aktivitet_nasta_steg: { display: "todo" } });
  const sg7 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG3" }, body: { motesanteckning: "x" } });
  ok("grind: {display}-objekt läses som ett riktigt beslut (ingen ny fråga)", sg7.body.ok === true);
  ok("mote-raden exponerar nasta_steg som ren sträng", mo(sg7).nasta_steg === "todo");

  // ── FRONTEND (mira-motesbokning.html) ─────────────────────────────────────
  const mbRaw = readFileSync(new URL("./mira-motesbokning.html", import.meta.url), "utf8");
  const mb = mbRaw.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  // ⚠️ Knapparna byggs ur NS_STEG-arrayen, så de literala data-ns-strängarna finns
  // inte i källan — assertionen måste spegla hur koden FAKTISKT bygger dem.
  ok("frontend: grinden renderas i mötesformuläret",
     /function nsHtml\(mt\)/.test(mb) && /nsHtml\(mt\)\+/.test(mb) &&
     /var NS_STEG=\[\["aktivitet",[^\]]*\],\["todo",[^\]]*\],\["avslutat",/.test(mb) &&
     /data-ns="'\+esc\(NS_STEG\[i\]\[0\]\)\+'"/.test(mb));
  ok("frontend: grindar bara när beslut saknas",
     /if\(mt\.genomfort && mt\.nasta_steg\) return "";/.test(mb));
  ok("frontend: Genomfört-bocken visar/döljer grinden",
     /if\(nsw\) nsw\.style\.display=t\.checked\?"block":"none"/.test(mb));
  ok("frontend: sparning blockeras utan val",
     /if\(ns\.error\)\{ nsMsg\(mcard2, ns\.error, true\); return; \}/.test(mb));
  // ⚠️ SCOPE: hjälparna måste ligga på IIFE-nivå, INTE inuti render-funktionen.
  // Första versionen hamnade i mcard-scopet → nsHtml renderade, men klickhanteraren
  // fick `nsSelect is not defined` och grinden gick inte att använda alls.
  // Greppet kräver att de deklareras med samma indrag som de andra toppfunktionerna
  // (två blanksteg) — inuti en funktion hade de fått fyra.
  ok("frontend: ns-hjälparna ligger på IIFE-nivå (klickhanteraren ser dem)",
     /\n  function nsSelect\(/.test(mb) && /\n  function nsPick\(/.test(mb) &&
     /\n  function nsCreateFollow\(/.test(mb) && /\n  function nsHtml\(/.test(mb));
  ok("frontend: segmentknapparna hanteras före spara-knappen i klickhanteraren",
     mb.indexOf('t.closest("[data-ns]")') > -1 &&
     mb.indexOf('t.closest("[data-ns]")') < mb.indexOf('t.closest(\'[data-mb="savemote"]\')'));
  ok("frontend: saknat Bubble-fält rapporteras", /aktivitet_nasta_steg saknas i Bubble/.test(mb));
  // ⚠️ FAS på nästa steg-aktiviteten (2026-08-24). Ett Kundmöte utan fas hamnar i
  // "Övrigt" i tratten — och tratten är hela poängen med vyn.
  ok("nästa steg: fas-väljare finns och krävs för Kundmöte",
     /data-nf="a_fas"/.test(mb) && /välj fas/.test(mb) &&
     /typ==="Kundmöte" && !g\("a_fas"\)/.test(mb) &&
     /hamnar det i Övrigt i tratten/.test(mb));
  ok("nästa steg: fas visas bara för Kundmöte och följer typbytet",
     /function nsFasToggle\(wrap\)/.test(mb) &&
     /t\.value==="Kundmöte"\) \? "" : "none"/.test(mb) &&
     /data-nf"\)==="a_typ"/.test(mb));
  ok("nästa steg: fasen skickas med till aktivitets-skapandet",
     /fas:follow\.fas\|\|""/.test(mb));
  // ⚠️ Uppföljaren skapas här också (rättat efter Christians påpekande 2026-08-21):
  // activitet_crm har `company` — kunden behöver inte gissas. `nMote` bär nu
  // `company_id`, och uppföljaren ärver både företag och affär från mötesraden.
  ok("frontend: mini-formulär för både aktivitet och todo",
     /data-nsform="aktivitet"/.test(mb) && /data-nsform="todo"/.test(mb) &&
     /data-nf="a_datum"/.test(mb) && /data-nf="t_titel"/.test(mb));
  ok("frontend: uppföljaren ärver företag OCH affär från mötesraden",
     /nsCreateFollow\(ns\.follow, mt&&mt\.company_id, mt&&mt\.deal_id\)/.test(mb) &&
     /company_id:companyId\|\|"", deal_id:dealId\|\|""/.test(mb));
  ok("frontend: uppföljaren skapas FÖRE mötet och stoppar sparningen om den faller",
     /mötet sparades INTE/.test(mb));
  ok("frontend: validerar datum resp. titel innan sparning",
     /Ange datum för den nya aktiviteten/.test(mb) && /Ange en titel för att-göra-punkten/.test(mb));
  // ⚠️ Todo kan planeras långt fram → starttid måste finnas i formuläret, och minst
  // ett datum krävs (utan datum syns todon aldrig som planerad på kundkortet).
  ok("frontend: todo-formuläret har både startdatum och klart-senast",
     /data-nf="t_start"/.test(mb) && /data-nf="t_slut"/.test(mb));
  ok("frontend: starttid skickas till todo-endpointen",
     /titel:follow\.titel, starttid:follow\.starttid, sluttid:follow\.sluttid/.test(mb));
  ok("frontend: todo utan något datum blockeras",
     /if\(!g\("t_start"\) && !g\("t_slut"\)\) return \{ error:/.test(mb));
  ok("frontend: säger vilket företag uppföljaren knyts till",
     /Knyts till <b>/.test(mb) && /Mötet saknar kundkoppling/.test(mb));
  DB.activitet_crm.push({ _id: "aG4", activity_type: "Kundmöte", writer: "u2", "genomfört": false, company: "cc1", deal: "d1" });
  const sg8 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG4" }, body: { fas: "Fas 2" } });
  ok("backend: mote-raden bär kundens id (uppföljaren knyts till rätt företag)",
     mo(sg8).company_id === "cc1" && mo(sg8).company === "Acme AB");
  ok("backend: mote-raden bär affärs-id (uppföljaren ärver affären)",
     mo(sg8).deal_id === "d1");

  // ══════════════════════════════════════════════════════════════════════════
  // SKAPAD-DATUM-FILTER i mötestratten (2026-08-22)
  // ⚠️ Två OLIKA frågor: "vilka möten HÅLLS i perioden" (Datum_bokning) och
  // "hur många möten BOKADES i perioden" (Created Date). Filtren är oberoende.
  // ══════════════════════════════════════════════════════════════════════════
  DB.activitet_crm.push(
    { _id: "cm1", activity_type: "Kundmöte", "Kundmöte": "Fas 1", writer: "u2", "Datum_bokning": "2026-09-10", "Created Date": "2026-08-05" },
    { _id: "cm2", activity_type: "Kundmöte", "Kundmöte": "Fas 1", writer: "u2", "Datum_bokning": "2026-09-11", "Created Date": "2026-07-05" },
    { _id: "cm3", activity_type: "Kundmöte", "Kundmöte": "Fas 2", writer: "u2", "Datum_bokning": "2026-06-01", "Created Date": "2026-08-20" },
  );
  const moten = (q) => call("get", "/admin/salj/moten", { query: q });
  const ids = (r) => (r.body.groups || []).reduce((a, g) => a.concat(g.moten.map((m) => m.id)), []).sort();

  const cAug = await moten({ cfrom: "2026-08-01", cto: "2026-08-31" });
  ok("skapad-filter: bara möten SKAPADE i augusti (oavsett mötesdatum)",
     ids(cAug).indexOf("cm1") > -1 && ids(cAug).indexOf("cm3") > -1 && ids(cAug).indexOf("cm2") < 0);
  // ⚠️ cm3 hålls i juni men bokades i augusti — bevisar att filtren är OLIKA.
  const dSep = await moten({ from: "2026-09-01", to: "2026-09-30" });
  ok("mötesdatum-filter är oberoende av skapad-filtret",
     ids(dSep).indexOf("cm1") > -1 && ids(dSep).indexOf("cm2") > -1 && ids(dSep).indexOf("cm3") < 0);
  const both = await moten({ from: "2026-09-01", to: "2026-09-30", cfrom: "2026-08-01", cto: "2026-08-31" });
  ok("filtren kan kombineras (hålls i sep OCH bokades i aug → bara cm1)",
     ids(both).length === 1 && ids(both)[0] === "cm1");
  ok("skapad-filter: totalen speglar träffmängden", ((cAug.body.summary || {}).total) === ids(cAug).length);
  // ⚠️ Defensivt: mot gammal kod saknas `filter` helt. `x.filter.skapad` hade
  // KRASCHAT sviten i st.f. att falla — fjärde gången den fällan dyker upp här.
  const flt = (r) => (r.body || {}).filter || {};
  ok("svaret säger VILKA filter som är på (rubriken får inte påstå fel fråga)",
     flt(cAug).skapad === true && flt(cAug).motesdatum === false &&
     flt(dSep).skapad === false && flt(dSep).motesdatum === true &&
     flt(both).skapad === true && flt(both).motesdatum === true);
  ok("mote-raden bär skapad-datum", (dSep.body.groups || []).some((g) => g.moten.some((m) => m.skapad === "2026-08-05")));
  // ⚠️ En rad UTAN skapad-datum får inte tyst passera ett skapad-filter.
  DB.activitet_crm.push({ _id: "cmX", activity_type: "Kundmöte", "Kundmöte": "Fas 1", writer: "u2", "Datum_bokning": "2026-09-12" });
  const cAug2 = await moten({ cfrom: "2026-08-01", cto: "2026-08-31" });
  ok("möte utan skapad-datum räknas INTE in i ett skapad-filter", ids(cAug2).indexOf("cmX") < 0);

  // ── FRONTEND ──────────────────────────────────────────────────────────────
  ok("frontend: skapad-datum-filtret finns och skickas till servern",
     /data-mb="cfrom"/.test(mb) && /data-mb="cto"/.test(mb) &&
     /qs\.push\("cfrom="/.test(mb) && /qs\.push\("cto="/.test(mb));
  ok("frontend: båda datumparen är rubricerade (mötesdatum vs skapade)",
     />Mötesdatum:</.test(mb) && />Skapade:</.test(mb));
  ok("frontend: Rensa nollställer även skapad-datumen",
     /STATE\.cfrom=""; STATE\.cto=""; loadMoten\(\)/.test(mb));
  // ⚠️ Rubriken på totalen måste följa vilket filter som är på — samma siffra får
  // inte påstå både "hålls i perioden" och "skapades i perioden".
  ok("frontend: totalen visas i trattens rubrik med filterberoende etikett",
     /class="fas-total"/.test(mb) && /Möten skapade i perioden/.test(mb) &&
     /Möten med mötesdatum i perioden/.test(mb) && /Alla möten i tratten/.test(mb));


  // ══════════════════════════════════════════════════════════════════════════
  // MÅL 1 — MOTIVERING VID AVSLUTAT SPÅR (2026-08-26)
  // "Avslutat" är enda beslutet som inte lämnar något spår efter sig i systemet.
  // ⚠️ Bubble-fält: `nasta_steg_kommentar` (TEXT, inte option set).
  // ══════════════════════════════════════════════════════════════════════════
  DB.activitet_crm.push({ _id: "aK1", activity_type: "Kundmöte", writer: "u2", "genomfört": false, company: "cc1" });
  const k1 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK1" }, body: { genomfort: true, motesanteckning: "Klart", nasta_steg: "avslutat" } });
  ok("avslut: utan motivering → 400 avslut_kommentar_krävs",
     k1.code === 400 && k1.body.error === "avslut_kommentar_krävs" && k1.body.min === 3);
  ok("avslut: inget skrevs när grinden fällde",
     DB.activitet_crm.find((x) => x._id === "aK1")["aktivitet_nasta_steg"] === undefined);
  const k2 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK1" }, body: { genomfort: true, nasta_steg: "avslutat", nasta_steg_kommentar: "ok" } });
  ok("avslut: för kort motivering (2 tecken) → 400", k2.code === 400 && k2.body.error === "avslut_kommentar_krävs");
  const k3 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK1" }, body: { genomfort: true, motesanteckning: "Klart", nasta_steg: "avslutat", nasta_steg_kommentar: "  Kunden valde konkurrent  " } });
  const aK1 = DB.activitet_crm.find((x) => x._id === "aK1");
  ok("avslut: med motivering → sparas trimmad i RÄTT Bubble-fält",
     k3.body.ok === true && aK1["nasta_steg_kommentar"] === "Kunden valde konkurrent" && aK1["aktivitet_nasta_steg"] === "avslutat");
  ok("avslut: motiveringen exponeras på mote-raden", mo(k3).nasta_steg_kommentar === "Kunden valde konkurrent");
  ok("avslut: båda saknat-flaggorna är false när fälten finns",
     (k3.body || {}).nasta_steg_field_missing === false && (k3.body || {}).avslut_kommentar_field_missing === false);
  // ⚠️ Kravet får INTE hänga på att sparningen råkar röra avklarandet — annars
  // slipper en patch som BARA sätter avslutat igenom utan motivering.
  DB.activitet_crm.push({ _id: "aK2", activity_type: "Kundmöte", writer: "u2", "genomfört": true });
  const k4 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK2" }, body: { nasta_steg: "avslutat" } });
  ok("avslut: patch som BARA sätter avslutat grindas också",
     k4.code === 400 && k4.body.error === "avslut_kommentar_krävs");
  // De andra två stegen lämnar spår efter sig (aktivitet/todo) → ingen motivering.
  DB.activitet_crm.push({ _id: "aK3", activity_type: "Kundmöte", writer: "u2", "genomfört": false });
  const k5 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK3" }, body: { genomfort: true, nasta_steg: "todo" } });
  ok("avslut: 'todo' som nästa steg kräver INGEN motivering", k5.body.ok === true);
  DB.activitet_crm.push({ _id: "aK4", activity_type: "Kundmöte", writer: "u2", "genomfört": false });
  const k6 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK4" }, body: { genomfort: true, nasta_steg: "aktivitet" } });
  ok("avslut: 'aktivitet' som nästa steg kräver INGEN motivering", k6.body.ok === true);

  // ── Nedgradering: fälten kan saknas i Bubble, VAR FÖR SIG ──────────────────
  // ⚠️ bubblePatch avvisar HELA patchen vid ETT okänt fält. Droppas de inte ett i
  // taget hade ett saknat kommentarsfält tagit med sig beslutet i fallet.
  DB.activitet_crm.push({ _id: "aK5", activity_type: "Kundmöte", writer: "u2", "genomfört": false });
  MISSING.add("activitet_crm.nasta_steg_kommentar");
  const k7 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK5" }, body: { genomfort: true, motesanteckning: "Klart", nasta_steg: "avslutat", nasta_steg_kommentar: "Fel tajming" } });
  const aK5 = DB.activitet_crm.find((x) => x._id === "aK5");
  ok("nedgradering: saknat kommentarsfält stoppar INTE beslutet",
     k7.body.ok === true && aK5["aktivitet_nasta_steg"] === "avslutat" && aK5["mötesantecking"] === "Klart");
  ok("nedgradering: saknad motivering rapporteras på EGEN flagga",
     (k7.body || {}).avslut_kommentar_field_missing === true && (k7.body || {}).nasta_steg_field_missing === false);
  MISSING.delete("activitet_crm.nasta_steg_kommentar");
  DB.activitet_crm.push({ _id: "aK6", activity_type: "Kundmöte", writer: "u2", "genomfört": false });
  MISSING.add("activitet_crm.aktivitet_nasta_steg");
  const k8 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aK6" }, body: { genomfort: true, nasta_steg: "avslutat", nasta_steg_kommentar: "Kunden pausade" } });
  ok("nedgradering: saknat beslutsfält stoppar INTE motiveringen",
     k8.body.ok === true && DB.activitet_crm.find((x) => x._id === "aK6")["nasta_steg_kommentar"] === "Kunden pausade" &&
     (k8.body || {}).nasta_steg_field_missing === true && (k8.body || {}).avslut_kommentar_field_missing === false);
  MISSING.delete("activitet_crm.aktivitet_nasta_steg");

  // ══════════════════════════════════════════════════════════════════════════
  // MÅL 2 — PERSONLISTAN FÅR INTE KOLLAPSA (2026-08-26)
  // Vyn öppnar med "kundansvarig = jag själv". Byggdes personlistan ur den
  // FILTRERADE mängden (som fram till nu) kunde man inte byta till en kollega.
  // ══════════════════════════════════════════════════════════════════════════
  const pAll = await call("get", "/admin/salj/moten", { query: {} });
  const pids = (r) => ((r.body || {}).personer || []).map((x) => x.id).sort().join(",");
  const alla = pids(pAll);
  ok("personer: minst två ansvariga i ofiltrerad tratt", alla.indexOf("u1") > -1 && alla.indexOf("u2") > -1);
  const pMine = await call("get", "/admin/salj/moten", { query: { person: "u1" } });
  ok("personer: listan är HELA uppsättningen även med personfilter på", pids(pMine) === alla);
  ok("personer: filtret biter fortfarande på raderna",
     ((pMine.body || {}).groups || []).every((g) => g.moten.every((m) => m.ansvarig_id === "u1")));
  const pNarrow = await call("get", "/admin/salj/moten", { query: { from: "2026-08-01", to: "2026-08-02", person: "u1" } });
  ok("personer: listan krymper inte heller av ett smalt datumfönster", pids(pNarrow) === alla);

  // ══════════════════════════════════════════════════════════════════════════
  // MÅL 3 — AUTOMATISK "LÄGG IN MÖTESANTECKNING"-TODO (2026-08-26)
  // ⚠️ Idempotensen hänger HELT på Bubble-fältet `anteckning_todo`.
  // ══════════════════════════════════════════════════════════════════════════
  // ── ROUTE-INVENTARIET ─────────────────────────────────────────────────────
  // ⚠️ Ett aritetstest räcker inte — varje registrerad route ska vara med i sviten.
  // Se [[feedback-testa-alla-routes]].
  const POSTS = Object.keys(routes.post).sort();
  ok("routes: exakt de POST-routes vi tror finns",
     POSTS.join(" | ") === ["/admin/salj/budget/set", "/admin/salj/mote/:id/patch", "/salj/anteckning-todo/cron"].join(" | "));
  ok("routes: exakt de GET-routes vi tror finns",
     Object.keys(routes.get).sort().join(" | ") === ["/admin/salj/budget", "/admin/salj/moten"].join(" | "));
  // ⚠️ SÄKERHET: `/admin/salj` är undantaget från index.js globala requireApiKey och
  // grindas bara av PLANNING_ADMIN_TOKEN — som ligger i KLARTEXT i Bubble-blocket.
  // En SKRIVANDE massjobbs-endpoint under det prefixet hade kunnat triggas från vilken
  // webbläsare som helst. Cron-routen MÅSTE ligga utanför.
  ok("routes: cron-routen ligger UTANFÖR /admin/salj (x-api-key, inte planning-token)",
     POSTS.some((r) => r === "/salj/anteckning-todo/cron") && !POSTS.some((r) => r.indexOf("/admin/salj/anteckning") === 0));
  // Och den får inte ha en OPTIONS/CORS-öppning — den anropas av cron, inte av en browser.
  ok("routes: cron-routen har ingen CORS-preflight (den anropas inte från browsern)",
     Object.keys(routes.options).indexOf("/salj/anteckning-todo/cron") < 0);

  const CRON = "/salj/anteckning-todo/cron";
  const dagar = (n) => new Date(Date.now() + n * 86400000).toISOString();
  DB.activitet_crm.push(
    { _id: "cr1", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-3) },                                  // ska få todo
    { _id: "cr2", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-3), "genomfört": true },               // avbockat
    { _id: "cr3", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-3), "mötesantecking": "Gick bra" },    // har anteckning
    { _id: "cr4", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(3) },                                   // i framtiden
    { _id: "cr5", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-60) },                                 // utanför fönstret
    { _id: "cr6", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-0.2) },                                // inom grace
    { _id: "cr7", activity_type: "Kundmöte", company: "cc1", "Datum_bokning": dagar(-3) },                                                // saknar writer
    { _id: "cr8", activity_type: "Säljsamtal", writer: "u1", company: "cc1", "Datum_bokning": dagar(-3) },                                // ej Kundmöte
  );
  // ⚠️ days=7 håller de FASTA fixtur-datumen (a1-a4, cm*) utanför fönstret — annars
  // hade testet varit beroende av hur långt från 2026-08 väggklockan råkar stå.
  // Assertionerna testar MEDLEMSKAP, inte antal, av samma skäl.
  const CQ = { days: "7" };
  const dry = await call("post", CRON, { query: Object.assign({ dry: "1" }, CQ) });
  const dids = ((dry.body || {}).rader || []).map((x) => x.aktivitet_id).sort();
  ok("cron dry: cr1 (passerat, ej avbockat, utan anteckning) är kandidat",
     dry.body.ok === true && dids.indexOf("cr1") > -1);
  ok("cron dry: avbockat/anteckning/framtid/utanför fönstret/inom grace/utan writer/annan typ faller bort",
     dry.body.ok === true && ["cr2", "cr3", "cr4", "cr5", "cr6", "cr7", "cr8"].every((id) => dids.indexOf(id) < 0));
  ok("cron dry: rader utan writer hoppas över och RAPPORTERAS (aldrig tyst bortfall)",
     (dry.body || {}).utan_agare === 1 && ((dry.body || {}).utan_agare_ids || []).indexOf("cr7") > -1);
  ok("cron dry: skriver ingenting", dry.body.ok === true && (DB.Todo || []).length === 0 &&
     DB.activitet_crm.find((x) => x._id === "cr1")["anteckning_todo"] === undefined);

  const run1 = await call("post", CRON, { query: CQ });
  const forAkt = (id) => ((run1.body || {}).rader || []).find((x) => x.aktivitet_id === id);
  const todo1 = (DB.Todo || []).find((t) => forAkt("cr1") && t._id === forAkt("cr1").todo_id);
  ok("cron: skapar en todo för cr1", run1.body.ok === true && !!todo1);
  ok("cron: todon tilldelas mötets ÄGARE (writer), inte Created By", todo1 && todo1["user"] === "u1");
  ok("cron: todon knyts till kunden och namnger den i titeln",
     todo1 && todo1["Företag"] === "cc1" && /Acme AB/.test(todo1["Titel"]));
  // ⚠️ Utan framtida datum syns todon aldrig som planerad på kundkortet.
  ok("cron: todon har status Pågående och ett FRAMTIDA slutdatum",
     todo1 && todo1["Status"] === "Pågående" && Date.parse(todo1["Sluttid"]) > Date.now());
  // ⚠️ Kategori går inte att härleda ur mötet — ett gissat Category-värde avvisas av Bubble.
  ok("cron: Kategori gissas INTE", todo1 && todo1["Kategori"] === undefined);
  // ⚠️ (todo1 || {}) — mot gammal kod finns ingen todo. `todo1._id` KRASCHADE och
  // dödade mutationstestet (femte gången samma fälla). Assertions mot något som kan
  // saknas måste FALLA, inte kasta. Se [[feedback-testet-ska-falla-inte-krascha]].
  ok("cron: markören sätts på aktiviteten",
     !!todo1 && DB.activitet_crm.find((x) => x._id === "cr1")["anteckning_todo"] === todo1._id);

  const antalEfter1 = (DB.Todo || []).length;
  const run2 = await call("post", CRON, { query: CQ });
  ok("cron: IDEMPOTENT — andra körningen skapar ingenting",
     run2.body.ok === true && (run2.body || {}).skapade === 0 && (DB.Todo || []).length === antalEfter1);

  // ── Taket får aldrig vara tyst ────────────────────────────────────────────
  DB.activitet_crm.push(
    { _id: "cx1", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-4) },
    { _id: "cx2", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-5) },
    { _id: "cx3", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-6) },
  );
  const cap = await call("post", CRON, { query: Object.assign({ limit: "2" }, CQ) });
  ok("cron: taket rapporteras (capped + kvar), aldrig tyst avhugget",
     (cap.body || {}).skapade === 2 && (cap.body || {}).capped === true && (cap.body || {}).kvar === 1);

  // ── Fail-closed: utan markör-fältet skulle samma todo skapas VARJE natt ───
  DB.activitet_crm.push({ _id: "cz1", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-4) });
  const todosFore = (DB.Todo || []).length;
  MISSING.add("activitet_crm.anteckning_todo");
  const failRun = await call("post", CRON, { query: CQ });
  ok("cron: saknad markör avbryter körningen med 500 (fail-closed)",
     failRun.code === 500 && failRun.body.error === "anteckning_todo_markor_misslyckades");
  ok("cron: den skapade todon RULLAS TILLBAKA — inga föräldralösa rader",
     (DB.Todo || []).length === todosFore && /raderad/.test((failRun.body || {}).rollback || ""));
  MISSING.delete("activitet_crm.anteckning_todo");

  // ── ...och den TYSTA droppen, som 400-vakten ovan inte ser ────────────────
  // ⚠️ bubblePatch avvisar HELA patchen vid okänt fält (400) MEN kan också ignorera
  // en okänd nyckel TYST — båda beteendena är dokumenterade. Utan läs-tillbaka hade
  // en tyst dropp gett samma todo VARJE natt och loggen sagt "lyckades".
  const freshApp = (over) => {
    const r = { get: {}, post: {}, options: {} };
    const a = { get: (pp, h) => { r.get[pp] = h; }, post: (pp, h) => { r.post[pp] = h; }, options: (pp, h) => { r.options[pp] = h; } };
    registerSaljRoutes(a, Object.assign({}, deps, over));
    // ⚠️ Samma regel som call(): saknas routen svarar vi 404 — vi KASTAR aldrig.
    // Mot gammal kod finns cron-routen inte, och en kastande hjälpare hade dödat
    // sviten och gjort mutationstestets siffra påhittad (sjunde gången samma fälla).
    return (query) => new Promise((resolve) => {
      const h = r.post["/salj/anteckning-todo/cron"];
      if (typeof h !== "function") return resolve({ code: 404, body: { ok: false, error: "no_route" } });
      const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { resolve({ code: this._c, body: o }); } };
      h({ params: {}, query, body: {}, headers: {} }, res);
    });
  };
  DB.activitet_crm.push({ _id: "cz2", activity_type: "Kundmöte", writer: "u1", company: "cc1", "Datum_bokning": dagar(-4) });
  const foreTyst = (DB.Todo || []).length;
  const tystRun = freshApp({ bubblePatch: async (t, id, pl) => { if (t === "activitet_crm" && pl && pl.anteckning_todo !== undefined) return {}; return deps.bubblePatch(t, id, pl); } });
  const tyst = await tystRun(CQ);
  ok("cron: TYST fältdropp fångas av läs-tillbaka (500, inte falsk success)",
     tyst.code === 500 && (tyst.body || {}).error === "anteckning_todo_markor_ej_verifierad");
  ok("cron: todon rullas tillbaka även vid tyst dropp",
     (DB.Todo || []).length === foreTyst && /raderad/.test((tyst.body || {}).rollback || ""));

  // ⚠️ Går VERIFIERINGEN inte att göra är det OKÄNT, inte "saknas". Markören kan ha
  // fastnat — raderas todon då pekar aktiviteten på en död rad och mötet får aldrig
  // mer en påminnelse. Avbryt, men rulla INTE tillbaka.
  const foreLasfel = (DB.Todo || []).length;
  const lasfelRun = freshApp({ bubbleGet: async (t, id) => { if (t === "activitet_crm") throw new Error("bubbleGet failed"); return deps.bubbleGet(t, id); } });
  const lasfel = await lasfelRun(CQ);
  ok("cron: misslyckad verifiering ger 500 av EGEN felkod (okänt ≠ saknat)",
     lasfel.code === 500 && (lasfel.body || {}).error === "anteckning_todo_verifiering_misslyckades");
  ok("cron: vid misslyckad verifiering rullas todon INTE tillbaka",
     (DB.Todo || []).length === foreLasfel + 1 && /med flit/.test((lasfel.body || {}).rollback || ""));
  // Städa upp så efterföljande assertions inte ser den kvarlämnade todon.
  DB.Todo = (DB.Todo || []).slice(0, foreLasfel);
  DB.activitet_crm = DB.activitet_crm.filter((x) => x._id !== "cz2");

  // ── FRONTEND (mål 1 + mål 2) ──────────────────────────────────────────────
  ok("frontend: avsluta-formuläret har ett obligatoriskt varför-fält",
     /data-nsform="avslutat"/.test(mb) && /data-nf="x_varfor"/.test(mb) && /Varfor avslutas sparet\? \*/.test(mb));
  ok("frontend: kort motivering blockerar sparningen",
     /if\(why\.length<3\) return \{ error:/.test(mb));
  ok("frontend: motiveringen skickas till servern",
     /if\(ns\.kommentar\) body\.nasta_steg_kommentar=ns\.kommentar;/.test(mb));
  ok("frontend: saknat kommentarsfält rapporteras SEPARAT från beslutet",
     /avslut_kommentar_field_missing/.test(mb) && /MOTIVERINGEN lagrades inte/.test(mb));
  ok("frontend: fattat beslut + motivering visas read-only i båda vyerna",
     /function nsDone\(mt\)/.test(mb) && /nsDone\(mt\)\+nsHtml\(mt\)/.test(mb) && /var det=nsDone\(mt\);/.test(mb));
  // ⚠️ Defaultvyn: kundansvarig = jag själv, mötesdatum idag ±7 dagar.
  ok("frontend: defaultfiltret sätts vid boot",
     /function defaultFilter\(\)\{ return \{ person:\(ME\|\|""\), from:dayShift\(-7\), to:dayShift\(7\)/.test(mb) &&
     /\n  applyDefault\(\);/.test(mb));
  ok("frontend: skapad-datumfiltret lämnas tomt i defaulten", /cfrom:"", cto:"" \}; \}/.test(mb));
  // ⚠️ Utan current_user hade defaultfiltret gett en tom tratt som såg ut som "inga möten".
  ok("frontend: saknad current_user faller tillbaka på alla OCH säger det",
     /Kunde inte identifiera dig \(current_user saknas\)/.test(mb));
  ok("frontend: 'Min vecka' återställer defaulten och markeras när den är aktiv",
     /data-mb="mine"/.test(mb) && /applyDefault\(\); loadMoten\(\); return;/.test(mb) && /isDefaultFilter\(\)\?" on":""/.test(mb));
  // ⚠️ Hjälparna måste ligga på IIFE-nivå (två blanksteg), inte i en render-funktion.
  ok("frontend: default-hjälparna ligger på IIFE-nivå",
     /\n  function defaultFilter\(/.test(mb) && /\n  function applyDefault\(/.test(mb) &&
     /\n  function isDefaultFilter\(/.test(mb) && /\n  function dayShift\(/.test(mb));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
