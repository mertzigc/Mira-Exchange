// Smoke: sälj mötestratt + attribution + säljmål. node salj_smoke.mjs
import { registerSaljRoutes } from "./salj_api.js";
import { readFileSync } from "node:fs";
const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
function call(method, path, { params = {}, query = {}, body = {} } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
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
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v)); return true; };
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFind: async (t, { constraints = [], limit = 300 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCreate: async (t, p) => { const id = t.toLowerCase() + "_" + (seq++); (DB[t] = DB[t] || []).push({ _id: id, ...p }); return id; },
  bubblePatch: async (t, id, p) => { const r = (DB[t] || []).find((x) => x._id === id); if (r) Object.assign(r, p); return {}; },
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
  const pOwner = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "a3" }, body: { by_user: "u2", fas: "Fas 2", genomfort: true, motesanteckning: "Bra möte", beskrivning: "Uppföljning", nasta_steg: "avslutat" } });
  ok("ägare (u2) redigerar eget möte → ok", pOwner.body.ok && pOwner.body.mote);
  const a3 = DB.activitet_crm.find((x) => x._id === "a3");
  ok("möte patchat: fas/genomfört/anteckning/beskr", a3["Kundmöte"] === "Fas 2" && a3["genomfört"] === true && a3["mötesantecking"] === "Bra möte" && a3.beskrivning === "Uppföljning");
  ok("returnerat mote har motesanteckning", pOwner.body.mote.motesanteckning === "Bra möte" && pOwner.body.mote.genomfort === true);

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
  const sg3 = await call("post", "/admin/salj/mote/:id/patch", { params: { id: "aG1" }, body: { genomfort: true, motesanteckning: "Klart", nasta_steg: "avslutat" } });
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
  ok("mote-raden exponerar nasta_steg som ren sträng", sg7.body.mote && sg7.body.mote.nasta_steg === "todo");

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
     sg8.body.mote && sg8.body.mote.company_id === "cc1" && sg8.body.mote.company === "Acme AB");
  ok("backend: mote-raden bär affärs-id (uppföljaren ärver affären)",
     sg8.body.mote && sg8.body.mote.deal_id === "d1");

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

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
