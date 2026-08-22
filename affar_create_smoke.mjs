// Smoke: skapa aktivitet + todo via affar_api. Mockad Bubble. node affar_create_smoke.mjs
import { registerAffarRoutes } from "./affar_api.js";
import { readFileSync } from "node:fs";

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
  // ⚠️ genomfort:true kräver nu ett nästa steg (grinden 2026-08-21).
  const a2 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Kundmöte", beskrivning: "Möte", fas: "Fas 2", motesdatum: "2026-08-10", genomfort: true, motesanteckning: "Bra möte", nasta_steg: "avslutat" } });
  const c2 = created.filter((c) => c.t === "activitet_crm")[1];
  ok("Kundmöte: Kundmöte(fas)+Datum_bokning ISO", c2.payload["Kundmöte"] === "Fas 2" && /^2026-08-10T/.test(c2.payload["Datum_bokning"]));
  ok("Kundmöte: genomfört=true + mötesantecking", c2.payload["genomfört"] === true && c2.payload["mötesantecking"] === "Bra möte");

  // ── aktivitet: tom → 400 ──
  const a3 = await call("post", "/admin/affar/aktivitet/create", { body: {} });
  ok("tom aktivitet → 400", a3.code === 400);

  // ── ÄGARSKAP: by_user → writer (2026-08-17) ──
  // Utan writer saknar mötet ansvarig i mötestratten (salj_api aktRep = writer||Created By);
  // Bubbles "Created By" blir API-nyckelns user via Data API och duger inte som ägare.
  const a4 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Kundmöte", beskrivning: "Bokat möte", fas: "Fas 1", motesdatum: "2026-09-01", by_user: "u1" } });
  const c4 = created.filter((c) => c.t === "activitet_crm").pop();
  ok("aktivitet: by_user sätts som writer", a4.body.ok && c4.payload.writer === "u1");
  const a5 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Säljsamtal", beskrivning: "Utan användare" } });
  const c5 = created.filter((c) => c.t === "activitet_crm").pop();
  ok("aktivitet utan by_user → ingen tom writer skrivs", a5.body.ok && !("writer" in c5.payload));

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

  // ══════════════════════════════════════════════════════════════════════════
  // NÄSTA STEG-GRINDEN i affärsvyn (2026-08-21)
  // Måste spegla kundkortet exakt — annars är kravet bara en UI-artighet i ena vyn.
  // ⚠️ `nasta_steg` är ett NYTT fält på activitet_crm; modulen får RÅ
  // bubbleCreate/bubblePatch → okänt fält 400:ar HELA skrivningen.
  // ══════════════════════════════════════════════════════════════════════════
  const ng1 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Kundmöte", beskrivning: "M", genomfort: true } });
  ok("grind: genomförd aktivitet utan nästa steg → 400",
     ng1.code === 400 && ng1.body.error === "nasta_steg_krävs");
  const ng2 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Kundmöte", beskrivning: "M", genomfort: true, nasta_steg: "hittepa" } });
  ok("grind: okänt nästa steg-värde → 400", ng2.code === 400 && ng2.body.error === "okänt_nasta_steg");
  const ng3 = await call("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Kundmöte", beskrivning: "M ok", genomfort: true, nasta_steg: "aktivitet" } });
  const ng3rec = created.filter((c) => c.t === "activitet_crm").pop();
  ok("grind: med nästa steg → skapas + fältet skrivs",
     ng3.body.ok === true && ng3rec.payload["aktivitet_nasta_steg"] === "aktivitet" && ng3.body.nasta_steg_field_missing === false);

  // patch: grinden gäller ÖVERGÅNGEN, inte varje sparning av en redan genomförd rad
  DB.activitet_crm.push({ _id: "aktG", beskrivning: "Pågår", "genomfört": false });
  const np1 = await call("post", "/admin/affar/aktivitet/:id/patch", { params: { id: "aktG" }, body: { genomfort: true } });
  ok("grind: patch till genomförd utan nästa steg → 400", np1.code === 400 && np1.body.error === "nasta_steg_krävs");
  const np2 = await call("post", "/admin/affar/aktivitet/:id/patch", { params: { id: "aktG" }, body: { genomfort: true, nasta_steg: "todo" } });
  ok("grind: patch med nästa steg går igenom", np2.body.ok === true);
  const np3 = await call("post", "/admin/affar/aktivitet/:id/patch", { params: { id: "aktG" }, body: { genomfort: true, beskrivning: "rättning" } });
  ok("grind: genomförd→genomförd är ingen övergång → ingen grind", np3.body.ok === true);
  const np4 = await call("post", "/admin/affar/aktivitet/:id/patch", { params: { id: "akt1" }, body: { beskrivning: "bara text" } });
  ok("grind: patch utan genomfort rör inte grinden", np4.body.ok === true);

  // ── Fältet saknas i Bubble: aktiviteten MÅSTE ändå sparas ─────────────────
  const routes2 = { get: {}, post: {}, options: {} };
  const app2 = { get: (p, h) => { routes2.get[p] = h; }, post: (p, h) => { routes2.post[p] = h; }, options: (p, h) => { routes2.options[p] = h; } };
  const call2 = (method, path, opt) => {
    const h = routes2[method][path];
    return new Promise((resolve) => {
      const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); }, sendStatus(c) { resolve({ code: c }); } };
      h({ params: (opt && opt.params) || {}, query: {}, body: (opt && opt.body) || {}, headers: {} }, res);
    });
  };
  let noFieldCreates = 0;
  registerAffarRoutes(app2, Object.assign({}, deps, {
    bubbleCreate: async (t, payload) => {
      if (t === "activitet_crm" && payload && payload.aktivitet_nasta_steg !== undefined) {
        const e = new Error("bubbleCreate failed");
        e.detail = { status: 400, body: JSON.stringify({ body: { message: "Unrecognized field: aktivitet_nasta_steg" } }) };
        throw e;
      }
      noFieldCreates++;
      return deps.bubbleCreate(t, payload);
    },
  }));
  const nf = await call2("post", "/admin/affar/aktivitet/create", { body: { activity_type: "Kundmöte", beskrivning: "Utan fält", genomfort: true, nasta_steg: "avslutat" } });
  ok("saknat Bubble-fält: aktiviteten sparas ändå + nasta_steg_field_missing:true",
     nf.body.ok === true && nf.body.nasta_steg_field_missing === true && noFieldCreates === 1);
  const nfRec = created.filter((c) => c.t === "activitet_crm").pop();
  ok("saknat Bubble-fält: övriga fält skrevs (hela skrivningen tappades INTE)",
     nfRec.payload["genomfört"] === true && nfRec.payload["aktivitet_nasta_steg"] === undefined);

  // ── FRONTEND (mira-affar-samlad.html) ─────────────────────────────────────
  // ⚠️ Greppar STRIPPAD kod — en kommentar som beskriver funktionen får inte
  // göra testet grönt.
  const afRaw = readFileSync(new URL("./mira-affar-samlad.html", import.meta.url), "utf8");
  const af = afRaw.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  // ⚠️ Option set → kan läsas tillbaka som {display}-objekt. Utan OS-medveten läsning
  // ger String(v) "[object Object]" och verifieringen ger falsklarm om saknat fält.
  const osApp = { get: (p, h) => {}, post: (p, h) => { routes3[p] = h; }, options: () => {} };
  const routes3 = {};
  registerAffarRoutes(osApp, Object.assign({}, deps, {
    bubbleGet: async (t, id) => {
      const r = await deps.bubbleGet(t, id);
      if (t === "activitet_crm" && r && typeof r.aktivitet_nasta_steg === "string") return Object.assign({}, r, { aktivitet_nasta_steg: { display: r.aktivitet_nasta_steg } });
      return r;
    },
  }));
  const osRes = await new Promise((resolve) => {
    const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); } };
    routes3["/admin/affar/aktivitet/create"]({ params: {}, query: {}, headers: {}, body: { activity_type: "Kundmöte", beskrivning: "OS-form", genomfort: true, nasta_steg: "todo" } }, res);
  });
  ok("option set som {display}-objekt: ingen falsk 'fältet saknas'-varning",
     osRes.body.ok === true && osRes.body.nasta_steg_field_missing === false);

  ok("frontend: grinden renderas i aktivitetsformuläret",
     /function nsHtml/.test(af) && /data-ns="aktivitet"/.test(af) && /data-ns="todo"/.test(af) && /data-ns="avslutat"/.test(af));
  ok("frontend: grinden visas bara när Genomfört är ibockad",
     /ns\.style\.display=\(isK&&d2&&d2\.checked\)\?"":"none"/.test(af));
  // ⚠️ Redan genomförd rad grindas inte om (locked-argumentet = done).
  // ⚠️ locked = beslut REDAN fattat. En genomförd aktivitet UTAN beslut måste grindas,
  // annars omfattas aldrig de hundratals redan avbockade aktiviteterna av kravet.
  ok("frontend: grindar genomförd aktivitet som SAKNAR beslut, men inte en som har det",
     /nsHtml\("a", isK, done, !!\(done && r\.nasta_steg\)\)/.test(af));
  ok("frontend: uppföljaren skapas FÖRE aktiviteten och stoppar sparningen om den faller",
     /nsCreateFollow\(ns\.follow, row&&row\.company_id, row&&row\.affar_id\)/.test(af) &&
     /aktiviteten sparades INTE/.test(af));
  ok("frontend: uppföljaren ärver företag och affär från raden",
     /company_id:companyId\|\|"", deal_id:dealId\|\|""/.test(af));
  // ⚠️ Klick-ordning: segmentknapparna ligger i redigeringsraden och får inte
  // bubbla vidare till rad-toggeln.
  ok("frontend: segmentknapparna hanteras före rad-hanterarna",
     af.indexOf('t.closest("[data-ns]")') > -1 &&
     af.indexOf('t.closest("[data-ns]")') < af.indexOf('t.closest(".af-a-save")'));
  ok("frontend: saknat Bubble-fält rapporteras till användaren",
     /fältet aktivitet_nasta_steg saknas/.test(af));
  // ⚠️ Todo kan planeras långt fram → starttiden måste gå att ange. Utan BÅDE
  // start och slut tomma syns todon aldrig som planerad på kundkortet.
  ok("frontend: todo-formuläret har både startdatum och klart-senast",
     /data-nf="t_start"/.test(af) && /data-nf="t_slut"/.test(af));
  ok("frontend: starttid skickas till todo-endpointen",
     /titel:follow\.titel, starttid:follow\.starttid, sluttid:follow\.sluttid/.test(af));
  ok("frontend: todo utan något datum blockeras",
     /if\(!g\("t_start"\) && !g\("t_slut"\)\) return \{ error:/.test(af));

  // ══════════════════════════════════════════════════════════════════════════
  // "5 SKÄL TILL BOM" → härledd sannolikhet (2026-08-22)
  // Ersätter den handsatta sannolikhets-dropdownen. ⚠️ RIKTNING: fler stjärnor =
  // starkare position = HÖGRE sannolikhet. Formel (summa−5)/20 × 0,95, tak 95 %.
  // ⚠️ Fälten bom_* är NYA i Bubble → raw create/patch 400:ar hela skrivningen om
  // de saknas. Testerna vaktar både formeln och att affären ändå går att spara.
  // ══════════════════════════════════════════════════════════════════════════
  const BOM_ALLA = (n) => ({ bom_relation: n, bom_beslutsprocess: n, bom_timing: n, bom_budget: n, bom_battre: n });
  const mkDeal = (extra) => call("post", "/admin/affar/deal/create", { body: Object.assign({ titel: "Affär" }, extra) });

  const b1 = await mkDeal(BOM_ALLA(1));
  ok("bom: alla ettor → 0 %", b1.body.ok === true && b1.body.sannolikhet === 0);
  const b5 = await mkDeal(BOM_ALLA(5));
  ok("bom: alla femmor → 95 % (aldrig 100 — det kommer först vid signering)",
     b5.body.ok === true && b5.body.sannolikhet === 0.95);
  const b3 = await mkDeal(BOM_ALLA(3));
  ok("bom: alla treor → 47,5 %", b3.body.ok === true && b3.body.sannolikhet === 0.48);
  // Blandat: 5+4+3+2+1 = 15 → (15−5)/20 × 0,95 = 0,475 → 0.48
  const bMix = await mkDeal({ bom_relation: 5, bom_beslutsprocess: 4, bom_timing: 3, bom_budget: 2, bom_battre: 1 });
  ok("bom: blandad gradering räknas på summan", bMix.body.sannolikhet === 0.48);
  // ⚠️ Riktningen: en HÖGRE gradering får aldrig ge en LÄGRE sannolikhet.
  const bLow = await mkDeal({ bom_relation: 2, bom_beslutsprocess: 2, bom_timing: 2, bom_budget: 2, bom_battre: 2 });
  const bHigh = await mkDeal({ bom_relation: 4, bom_beslutsprocess: 4, bom_timing: 4, bom_budget: 4, bom_battre: 4 });
  ok("bom: fler stjärnor ger ALLTID högre sannolikhet (riktningen inte omvänd)",
     Number(bLow.body.sannolikhet) < Number(bHigh.body.sannolikhet) && Number(bHigh.body.sannolikhet) <= 0.95);

  const dealRec = created.filter((c) => c.t === "deal").pop();
  ok("bom: graderingarna skrivs till rätt Bubble-fält",
     dealRec.payload["bom_relation"] === 4 && dealRec.payload["bom_beslutsprocess"] === 4 &&
     dealRec.payload["bom_timing"] === 4 && dealRec.payload["bom_budget"] === 4 && dealRec.payload["bom_battre"] === 4);
  // ⚠️ Skrivs som TAL. Den gamla väljaren skrev option-setets display-strängar,
  // men ett beräknat värde finns inte i det setet — fältet måste vara number.
  ok("bom: sannolikhet skrivs som ett tal, inte en option-set-sträng",
     dealRec.payload["sannolikhet"] === 0.71);   // alla fyror: (20−5)/20 × 0,95 = 0,7125

  // ⚠️ Alla fem krävs — en halvifylld gradering ger falsk precision.
  const bHalf = await mkDeal({ bom_relation: 5, bom_budget: 3 });
  ok("bom: ofullständig gradering → 400 + vilka som saknas",
     bHalf.code === 400 && bHalf.body.error === "ofullstandig_bom_gradering" &&
     (bHalf.body.saknas || []).indexOf("Beslutsprocess") > -1 && (bHalf.body.saknas || []).length === 3);
  const bBad = await mkDeal(Object.assign(BOM_ALLA(3), { bom_timing: 9 }));
  ok("bom: gradering utanför 1–5 → 400", bBad.code === 400 && bBad.body.error === "ogiltig_bom_gradering" &&
     (bBad.body.fields || []).indexOf("timing") > -1);
  const bNone = await mkDeal({});
  ok("bom: affär utan gradering skapas som förut (sektionen är inte obligatorisk för API:t)",
     bNone.body.ok === true && bNone.body.sannolikhet === null);

  // patch
  DB.deal.push({ _id: "dBom", titel: "Patchbar" });
  const pb = await call("post", "/admin/affar/deal/:id/patch", { params: { id: "dBom" }, body: BOM_ALLA(5) });
  ok("bom: patch räknar om sannolikheten", pb.body.ok === true && pb.body.patched["sannolikhet"] === 0.95 &&
     pb.body.sannolikhet_source === "bom");
  // ⚠️ Graderingen vinner över en handsatt sannolikhet — annars kunde två källor
  // skriva samma fält och den ena tysta den andra.
  const pb2 = await call("post", "/admin/affar/deal/:id/patch", { params: { id: "dBom" }, body: Object.assign({ sannolikhet: "0.1" }, BOM_ALLA(1)) });
  ok("bom: graderingen vinner över medskickad sannolikhet, och källan redovisas",
     pb2.body.patched["sannolikhet"] === 0 && pb2.body.sannolikhet_source === "bom");
  const pb3 = await call("post", "/admin/affar/deal/:id/patch", { params: { id: "dBom" }, body: { titel: "Bara titel" } });
  ok("bom: patch utan gradering rör inte sannolikheten",
     pb3.body.ok === true && pb3.body.patched["sannolikhet"] === undefined);

  // ── Fälten saknas i Bubble: affären måste ändå gå att spara ───────────────
  const routes4 = {}; let missCreated = null;
  registerAffarRoutes({ get: () => {}, post: (p, h) => { routes4[p] = h; }, options: () => {} },
    Object.assign({}, deps, {
      bubbleCreate: async (t, payload) => {
        if (t === "deal") {
          const bad = Object.keys(payload).filter((k) => k.indexOf("bom_") === 0);
          if (bad.length) { const e = new Error("bubbleCreate failed"); e.detail = { status: 400, body: JSON.stringify({ body: { message: "Unrecognized field: " + bad[0] } }) }; throw e; }
          missCreated = payload;
        }
        return deps.bubbleCreate(t, payload);
      },
    }));
  const miss = await new Promise((resolve) => {
    const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); } };
    routes4["/admin/affar/deal/create"]({ params: {}, query: {}, headers: {}, body: Object.assign({ titel: "Utan bom-fält" }, BOM_ALLA(5)) }, res);
  });
  ok("saknade bom-fält: affären skapas ändå + vilka fält som ströks redovisas",
     miss.body.ok === true && (miss.body.bom_fields_missing || []).length === 5);
  ok("saknade bom-fält: sannolikheten skrivs ÄNDÅ (det fältet finns sedan tidigare)",
     missCreated && missCreated["sannolikhet"] === 0.95 && missCreated["bom_relation"] === undefined);

  // ── OPTION-SET-KROCKEN på `sannolikhet` (skarpt fel 2026-08-22) ───────────
  // `deal.sannolikhet` var ett Option Set (`potential_affär`, elva fasta steg).
  // Ett BERÄKNAT värde (0,33 · 0,71 …) finns inte där → Bubble svarar
  //   400 INVALID_DATA "could not parse this as a potential_affär"
  // vilket avvisade HELA skrivningen: ingen affär gick att spara alls.
  // ⚠️ Sannolikheten stryps därför som sista utväg — graderingen måste kunna
  // sparas även om fältet ännu inte bytts till number. Tyst tapp är inte OK:
  // svaret bär `sannolikhet_blocked` med orsak och åtgärd.
  const OS_ERR = () => { const e = new Error("bubblePatch failed");
    e.detail = { status: 400, body: JSON.stringify({ statusCode: 400, body: { status: "INVALID_DATA", message: "Invalid data for field sannolikhet: could not parse this as a potential_affär" } }) };
    return e; };
  const routes5 = {}; let osPatched = null;
  registerAffarRoutes({ get: () => {}, post: (p, h) => { routes5[p] = h; }, options: () => {} },
    Object.assign({}, deps, {
      bubblePatch: async (t, id, payload) => {
        if (t === "deal" && payload && payload.sannolikhet !== undefined) throw OS_ERR();
        osPatched = payload; return deps.bubblePatch(t, id, payload);
      },
    }));
  DB.deal.push({ _id: "dOS", titel: "Option-set-affär" });
  const os = await new Promise((resolve) => {
    const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); } };
    routes5["/admin/affar/deal/:id/patch"]({ params: { id: "dOS" }, query: {}, headers: {}, body: Object.assign({ titel: "Nytt namn" }, BOM_ALLA(4)) }, res);
  });
  ok("option-set-krock: affären sparas ÄNDÅ (hela skrivningen avvisas inte längre)",
     os.body.ok === true);
  ok("option-set-krock: graderingen sparas även om sannolikheten inte kan skrivas",
     osPatched && osPatched["bom_relation"] === 4 && osPatched["titel"] === "Nytt namn" &&
     osPatched["sannolikhet"] === undefined);
  ok("option-set-krock: svaret säger orsaken och åtgärden, inget tyst tapp",
     os.body.sannolikhet_blocked && os.body.sannolikhet_blocked.reason === "fel_typ" &&
     /Byt fältet till number/.test(os.body.sannolikhet_blocked.hint));
  // ⚠️ Andra 400-fel måste fortfarande braka — nedgraderingen matchar SMALT.
  const routes6 = {};
  registerAffarRoutes({ get: () => {}, post: (p, h) => { routes6[p] = h; }, options: () => {} },
    Object.assign({}, deps, {
      bubblePatch: async () => { const e = new Error("bubblePatch failed");
        e.detail = { status: 400, body: JSON.stringify({ body: { status: "INVALID_DATA", message: "Invalid data for field Status: could not parse this as a lead_status" } }) }; throw e; },
    }));
  const osOther = await new Promise((resolve) => {
    const res = { _code: 200, status(c) { this._code = c; return this; }, json(o) { resolve({ code: this._code, body: o }); } };
    routes6["/admin/affar/deal/:id/patch"]({ params: { id: "dOS" }, query: {}, headers: {}, body: { status: "Trams" } }, res);
  });
  ok("option-set-krock: fel på ett ANNAT fält braker fortfarande (döljer inga buggar)",
     osOther.body.ok !== true);

  // ── FRONTEND: bom-sektionen i affärsvyn ───────────────────────────────────
  ok("frontend: stjärnkomponenten finns och listar de fem punkterna",
     /function bomHtml/.test(af) &&
     /var BOM=\[\["relation",[^\]]*\],\["beslutsprocess",[^\]]*\],\["timing",[^\]]*\],\["budget",[^\]]*\],\["battre",/.test(af));
  // ⚠️ Samma formel som servern, annars visar UI:t en annan siffra än den som sparas.
  ok("frontend: samma formel som backend ((summa−5)/20 × 0,95, tak 95 %)",
     /Math\.round\(\(\(sum-BOM\.length\)\/\(BOM\.length\*4\)\)\*0\.95\*100\)/.test(af));
  ok("frontend: sannolikhets-dropdownen är BORTA (härleds nu)",
     !/af-d-prob/.test(af) && !/— sannolikhet —/.test(af));
  ok("frontend: sektionen finns i affärsredigeringen, i skapa-av-lead/aktivitet OCH i nya + Affär",
     /bomHtml\(e\.bom\)/.test(af) && (af.match(/bomHtml\(null\)/g) || []).length >= 2);
  ok("frontend: alla fem krävs innan sparning",
     /if\(!r\.klar\) return "Gradera alla fem/.test(af) &&
     (af.match(/bomApply\(box, payload\)/g) || []).length >= 3);
  // ⚠️ Klick-ordning: stjärnorna ligger i formuläret, som ligger i en expanderbar rad.
  ok("frontend: stjärnklick hanteras före rad-hanterarna",
     af.indexOf('t.closest(".bom-star")') > -1 &&
     af.indexOf('t.closest(".bom-star")') < af.indexOf('t.closest(".af-d-save")'));
  ok("frontend: stjärnklick punktuppdaterar, re-renderar aldrig raden",
     /function bomSet\(star\)\{[\s\S]*?data-bompct[\s\S]*?\n  \}/.test(af) &&
     !/bom-star[\s\S]{0,300}render\(\);/.test(af));
  // "+ Affär" från scratch
  ok("frontend: + Affär finns i Skapa nytt-raden",
     /data-new="affar"/.test(af) && /function dealCreatePanelHtml/.test(af) && /function saveNewDeal/.test(af));
  ok("frontend: + Affär skickar INGEN källrad (fristående affär)",
     !/dealCreatePanelHtml[\s\S]*?source_type/.test(af.slice(af.indexOf("function saveNewDeal"), af.indexOf("function saveNewDeal") + 1400)));
  ok("frontend: saknade bom-fält i Bubble rapporteras till användaren",
     /bom_fields_missing/.test(af) && /graderingen lagrades inte/.test(af));
  // ⚠️ Option-set-krocken måste synas för användaren — annars ser affären sparad ut
  // medan sannolikheten tyst uteblir. Ska finnas i BÅDA spar-vägarna (redigera + skapa).
  ok("frontend: blockerad sannolikhet rapporteras i både redigera och skapa",
     (af.match(/sannolikhet_blocked/g) || []).length >= 3);
  // Skär ut funktionskropparna i st.f. att gissa ett teckenavstånd.
  const kropp = (namn) => {
    const i = af.indexOf("function " + namn + "(");
    if (i < 0) return "";
    const j = af.indexOf("\n  function ", i + 5);
    return af.slice(i, j < 0 ? af.length : j);
  };
  ok("frontend: meddelandet ligger i saveDeal, inte i saveLead",
     kropp("saveDeal").indexOf("sannolikhet_blocked") > -1 &&
     kropp("saveLead").indexOf("sannolikhet_blocked") < 0);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
