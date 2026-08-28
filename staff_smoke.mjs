// Smoke: staff_api.js — Staff-modulen (Service & People).
//   node staff_smoke.mjs
//
// ⚠️ Sviten kör den RIKTIGA kedjan: fejkad Bubble-store → companies_api:s
// projektioner → staff_api. Mockas projektionerna bort testas bara mocken, och då
// hade fällorna "Titel, inte Namn" och "ClientCompany.Fastighet, inte
// Fastighet.Hyresgäster" inte kunnat falla. Fastighet-raderna saknar därför
// `Hyresgäster` — precis som i produktion, där vår kod aldrig skriver det fältet.
//
// ⚠️ MOCKA ALDRIG MER TILLÅTANDE ÄN BUBBLE. Patch-mocken avvisar okända fält med
// samma 400 som Bubble ger, och avvisar HELA patchen — annars kan ett felstavat
// fältnamn passera en grön svit och bli en no-op i drift.
import { registerStaffRoutes, STAFF } from "./staff_api.js";
import { registerCompaniesRoutes } from "./companies_api.js";
import { VISIT } from "./visitor_api.js";
import fs from "node:fs/promises";

const DAG = 86400000;
const NU = Date.now();
const iso = (msSedan) => new Date(NU - msSedan).toISOString();

// ── Fixtur ──────────────────────────────────────────────────────────────────
function nyStore() {
  return {
    Fastighet: [
      { _id: "f1", Titel: "Hötorget 3", Adress: { address: "Sveavägen 17, Stockholm" } },
      { _id: "f2", Adress: { address: "Malmskillnadsgatan 32, Stockholm" } },   // saknar Titel → adressfallback
      { _id: "f3", Titel: "Kungsbron 2" },
      { _id: "f9", Titel: "Ohanterat hus" },                                     // ingen receptionist → utanför urvalet
    ],
    ClientCompany: [
      { _id: "cc1", Name_company: "twoday Sverige AB", Fastighet: ["f1"] },
      { _id: "cc2", Name_company: "Swedbank AB",       Fastighet: ["f1", "f2"] },
      { _id: "cc3", Name_company: "Beyond Retail",     Fastighet: ["f2"] },
      { _id: "cc4", Name_company: "Utan Värdar AB",    Fastighet: ["f3"] },
      { _id: "cc9", Name_company: "Hemligt Bolag AB",  Fastighet: ["f9"] },
    ],
    Coworker: [
      { _id: "co1", "Kundföretag": "cc1", "Förnamn": "Evelina", "Efternamn": "Åblad", Telefon: 701785977, Email: "evelina@twoday.com" },
      { _id: "co2", "Kundföretag": "cc1", "Förnamn": "Petra",   "Efternamn": "Lindholm", Email: "petra@twoday.com" },
      { _id: "co3", "Kundföretag": "cc1", "Förnamn": "Ove",     "Efternamn": "Okontakt" },   // ingen kanal
      { _id: "co4", "Kundföretag": "cc2", "Förnamn": "Bo",      "Efternamn": "Onåbar" },     // enda värden, ingen kanal
      { _id: "co5", "Kundföretag": "cc3", "Förnamn": "Sara",    "Efternamn": "Berg", Telefon: 700000001 },
      // cc4 har INGA värdar alls → "ingen kontaktlista"
    ],
    User: [
      { _id: "u1", "First Name": "Anna", "Surname": "Reception", email: "anna.r@carotte.se", Company: "CAROTTE",
        User_role: "Receptionist", receptionist_fastigheter: ["f1", "f2"],
        visitor_token: "tok-anna", visitor_token_exp: new Date(NU + 6 * 3600000).toISOString() },
      { _id: "u2", "First Name": "Sofia", "Surname": "Lind", email: "sofia.l@carotte.se", Company: "CAROTTE",
        User_role: "Receptionist", receptionist_fastigheter: [] },
      { _id: "u3", "First Name": "Marcus", "Surname": "Ek", email: "marcus.e@carotte.se", Company: "CAROTTE",
        User_role: "Receptionist", receptionist_fastigheter: ["f3"],
        visitor_token: "tok-marcus", visitor_token_exp: new Date(NU - 3600000).toISOString() },
      { _id: "u4", "First Name": "Karin", "Surname": "Chef", email: "karin@carotte.se", Company: "CAROTTE",
        User_role: "Ansvarig", visitor_token: "tok-karin" },
      // Vår egen, helt utan roll → den typiska kandidaten.
      { _id: "u7", "First Name": "Nils", "Surname": "Ny", email: "nils@carotte.se", Company: "CAROTTE" },
      // ⚠️ KUNDENS egen inloggning. Får ALDRIG bli receptionist — då ser hen
      // hyresgästernas kontaktlistor. Samma klass av fel som kundansvarig-buggen.
      { _id: "k1", "First Name": "Kund", "Surname": "Persson", email: "kund@twoday.com", Company: "cc1", User_role: "Medarbetare" },
      { _id: "u5", email: "namnlos@carotte.se", User_role: "Receptionist", receptionist_fastigheter: ["f1", "fDÖD"], Company: "CAROTTE" },
      // ⚠️ Varken namn eller e-post. Den här faller TYST bort ur companies_api:s
      // namnfilter om receptionisterna inte plockas ut före det.
      { _id: "u6", User_role: "Receptionist", receptionist_fastigheter: ["f1"], Company: "CAROTTE" },
    ],
    Visit: [
      // f1 — twoday (cc1): 3 besök, 2 notiser fram, 1 fel
      { _id: "v1", fastighet: "f1", hyresgast: "cc1", incheckad_at: iso(1 * DAG), via: "reception", notis_status: "skickad", registrerad_av: "u1", vard_namn: "Evelina Åblad" },
      { _id: "v2", fastighet: "f1", hyresgast: "cc1", incheckad_at: iso(2 * DAG), via: "lobby",     notis_status: "skickad" },
      { _id: "v3", fastighet: "f1", hyresgast: "cc1", incheckad_at: iso(2 * DAG), via: "reception", notis_status: "fel", notis_kanal: "ingen", notis_fel: "Värden saknar både mobil och e-post", registrerad_av: "u1", vard_namn: "Ove Okontakt" },
      // f1 — Swedbank (cc2): 2 besök, båda utan notis (värden går inte att nå)
      { _id: "v4", fastighet: "f1", hyresgast: "cc2", incheckad_at: iso(1 * DAG), via: "reception", notis_status: "fel", notis_kanal: "ingen", notis_fel: "Värden saknar både mobil och e-post", registrerad_av: "u1" },
      { _id: "v5", fastighet: "f1", hyresgast: "cc2", incheckad_at: iso(3 * DAG), via: "reception", notis_status: "vantar", registrerad_av: "u5" },
      // f2 — Beyond Retail (cc3): 1 besök
      { _id: "v6", fastighet: "f2", hyresgast: "cc3", incheckad_at: iso(1 * DAG), via: "lobby", notis_status: "skickad" },
      // f3 — Utan Värdar AB (cc4): 2 besök, inga notiser
      { _id: "v7", fastighet: "f3", hyresgast: "cc4", incheckad_at: iso(1 * DAG), via: "reception", notis_status: "vantar", registrerad_av: "u3" },
      { _id: "v8", fastighet: "f3", hyresgast: "cc4", incheckad_at: iso(4 * DAG), via: "reception", notis_status: "vantar", registrerad_av: "u3" },
      // UTANFÖR FÖNSTRET (30 dagar sedan) — får aldrig räknas i en 7-dagarsvy
      { _id: "v9", fastighet: "f1", hyresgast: "cc1", incheckad_at: iso(30 * DAG), via: "lobby", notis_status: "skickad" },
      // f9 — hus utan receptionist. Får aldrig dyka upp.
      { _id: "v10", fastighet: "f9", hyresgast: "cc9", incheckad_at: iso(1 * DAG), via: "reception", notis_status: "fel", notis_fel: "hemligt" },
    ],
  };
}

// ── Bubble-mock ─────────────────────────────────────────────────────────────
// Verifierade skrivbara fält per typ. ⚠️ Ett fält som inte står här ska avvisas
// precis som Bubble gör: 400 + HELA patchen blir en no-op.
const KNOWN_FIELDS = {
  User: ["First Name", "Surname", "Title_user", "Phone_user", "email", "Email", "Company",
         "Associated_company", "User_role", "Consent",
         // Tillagda 2026-08-26 för besökshanteringen (BESOKSHANTERING.md §7.5.3).
         "receptionist_fastigheter", "visitor_token", "visitor_token_exp"],
};

function mkDeps(STORE, opt) {
  opt = opt || {};
  const räknare = { find: [], patch: [], get: [] };
  const matchar = (r, c) => {
    const v = r[c.key];
    if (c.constraint_type === "contains") {
      const a = Array.isArray(v) ? v : (v == null ? [] : [v]);
      return a.map(String).indexOf(String(c.value)) > -1;
    }
    if (c.constraint_type === "greater than") return Date.parse(String(v)) > Date.parse(String(c.value));
    if (c.constraint_type === "less than")    return Date.parse(String(v)) < Date.parse(String(c.value));
    return String(v == null ? "" : v) === String(c.value);
  };
  const kastaBubble = (status, body) => { const e = new Error("bubbleFind failed"); e.detail = { status, body }; throw e; };

  const bubbleFind = async (t, o) => {
    o = o || {};
    const cs = o.constraints || [];
    räknare.find.push({ t, constraints: cs, cursor: o.cursor || 0 });
    for (const c of cs) {
      // Bubble 400: referens-id:t finns inte längre (raderad rad kvar i en lista).
      if (c.constraint_type === "equals" || c.constraint_type === "contains") {
        if (/^f/.test(String(c.value)) && !(STORE.Fastighet || []).some((f) => f._id === c.value)) {
          kastaBubble(400, JSON.stringify({ statusCode: 400, body: { status: "MISSING_DATA", message: "object with this id does not exist: " + c.value } }));
        }
      }
      // Simulerad okänd constraint-nyckel (Bubbles slug-form för date-fält).
      if (opt.datumConstraintFel && c.key === VISIT.F_IN) {
        kastaBubble(400, JSON.stringify({ statusCode: 400, body: { status: "ERROR", message: "Invalid field for constraint: " + VISIT.F_IN } }));
      }
    }
    let rows = (STORE[t] || []).filter((r) => cs.every((c) => matchar(r, c)));
    const cursor = o.cursor || 0, limit = o.limit == null ? 100 : o.limit;
    return rows.slice(cursor, cursor + limit);
  };
  const bubbleFindAll = async (t, o) => {
    o = o || {};
    const ut = []; let cursor = 0;
    for (;;) {
      const b = await bubbleFind(t, { constraints: o.constraints || [], limit: 100, cursor });
      ut.push.apply(ut, b);
      if (b.length < 100) break;
      cursor += 100;
    }
    return ut;
  };
  const bubbleGet = async (t, id) => { räknare.get.push({ t, id }); return (STORE[t] || []).find((r) => r._id === id) || null; };
  const bubblePatch = async (t, id, payload) => {
    räknare.patch.push({ t, id, payload });
    const known = KNOWN_FIELDS[t];
    if (known) {
      const okänt = Object.keys(payload).filter((k) => known.indexOf(k) < 0);
      if (okänt.length) {
        // Bubble avvisar HELA patchen — inget av de övriga fälten skrivs heller.
        const e = new Error("bubblePatch failed");
        e.detail = { status: 400, body: JSON.stringify({ status: "ERROR", message: "Unrecognized field: " + okänt[0] }) };
        throw e;
      }
    }
    const r = (STORE[t] || []).find((x) => x._id === id);
    if (!r) { const e = new Error("bubblePatch failed"); e.detail = { status: 404, body: "missing" }; throw e; }
    // ⚠️ Bubble DROPPAR ett okänt fält tyst i vissa lägen och svarar 204 ändå
    // ([[reference-bubble-tysta-faltdrop]]). Mocken kan simulera exakt det.
    for (const [k, v] of Object.entries(payload)) {
      if ((opt.tystDrop || []).indexOf(k) > -1) continue;
      r[k] = v;
    }
    return true;
  };
  return { bubbleFind, bubbleFindAll, bubbleGet, bubbleId: (r) => (r ? r._id : null), bubblePatch, räknare };
}

function mkApp() {
  const routes = { get: {}, post: {}, patch: {}, delete: {}, put: {}, options: {} };
  const sist = (a) => a[a.length - 1];
  const app = {};
  for (const m of Object.keys(routes)) app[m] = (p, ...a) => { routes[m][p] = sist(a); };
  app.use = () => {};
  return { app, routes };
}
function call(routes, method, path, o) {
  o = o || {};
  const h = routes[method][path];
  if (!h) return Promise.resolve({ code: 404, body: { ok: false, error: "no_route", route: method + " " + path } });
  return new Promise((r) => {
    const res = { _c: 200, status(c) { this._c = c; return this; }, json(b) { r({ code: this._c, body: b }); }, sendStatus(c) { r({ code: c, body: null }); } };
    Promise.resolve(h({ params: o.params || {}, query: o.query || {}, body: o.body || {}, headers: o.headers || {} }, res)).catch((e) => r({ code: 500, body: { ok: false, error: "threw: " + (e && e.message) } }));
  });
}

// ── Uppsättning: riktig companies_api → riktig staff_api ────────────────────
const ADMIN = { "x-admin-token": "hemlig" };
function bygg(opt) {
  opt = opt || {};
  const STORE = opt.store || nyStore();
  const d = mkDeps(STORE, opt);
  const capp = mkApp();
  const co = registerCompaniesRoutes(capp.app, {
    bubbleFind: d.bubbleFind, bubbleFindAll: d.bubbleFindAll, bubbleGet: d.bubbleGet,
    bubbleId: d.bubbleId, bubblePatch: d.bubblePatch,
    bubbleCount: async () => 0, bubbleDelete: async () => true, bubbleCreate: async () => "x",
    companyFullMap: async () => new Map(), companyRevenueMap: async () => new Map(),
    planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "ip",
  });
  const sapp = mkApp();
  const staff = registerStaffRoutes(sapp.app, {
    bubbleFind: d.bubbleFind, bubbleFindAll: d.bubbleFindAll, bubbleGet: d.bubbleGet,
    bubbleId: d.bubbleId, bubblePatch: d.bubblePatch,
    receptionistDirectory: () => co.receptionistDirectory(),
    coworkerDirectory: () => co.coworkerDirectory(),
    fastighetDirectory: () => co.fastighetDirectory(),
    usersForget: () => co.usersForget(),
    userRoleDirectory: () => co.userRoleDirectory(),
    CAROTTE_COMPANY_ID: opt.carotte === undefined ? "CAROTTE" : opt.carotte,
    planningAuthed: (req) => req.headers["x-admin-token"] === "hemlig",
    planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "ip",
    snapshotTtlMs: opt.snapshotTtlMs, tenantTtlMs: opt.tenantTtlMs,
  });
  return { STORE, routes: sapp.routes, räknare: d.räknare, staff, co };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
// ⚠️ Ett mutationstest ska FALLA, inte KRASCHA — en krasch mot gammal kod dödar
// resten av sviten och man ser aldrig vad mer som gick sönder. `at()` gör därför
// varje indexering säker; en saknad rad blir ett falskt villkor, inte en TypeError.
const at = (arr, i) => (Array.isArray(arr) && arr.length > i ? arr[i] : {});
const _str = (v) => (v == null ? "" : String(v));

const run = async () => {
  // ── AUTH ──────────────────────────────────────────────────────────────────
  {
    const s = bygg();
    const u = await call(s.routes, "get", "/admin/staff/oversikt", {});
    ok("utan admin-token → 401", u.code === 401 && u.body.error === "unauthorized");
    const b = await call(s.routes, "get", "/admin/staff/oversikt", { headers: { "x-admin-token": "fel" } });
    ok("fel admin-token → 401", b.code === 401);
    const v = await call(s.routes, "get", "/admin/staff/oversikt", { headers: { "x-visitor-token": "vadsomhelst" } });
    ok("visitor-token ger INTE åtkomst till CRM-ytan", v.code === 401);
    const p = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", { params: { id: "u2" }, body: { fastigheter: ["f1"] } });
    ok("skrivning utan admin-token → 401", p.code === 401);
  }

  // ── ÖVERSIKT: KPI + åtgärdslista ──────────────────────────────────────────
  {
    const s = bygg();
    const r = await call(s.routes, "get", "/admin/staff/oversikt", { headers: ADMIN });
    ok("översikt ok", r.body.ok === true && r.body.dagar === 7);
    const k = r.body.kpi;
    // f1: v1..v5 = 5, f2: v6 = 1, f3: v7,v8 = 2  → 8. v9 (30 dgr) och v10 (f9) räknas inte.
    ok("KPI: besök inom fönstret = 8 (30-dagarsbesöket räknas inte)", k.besok === 8);
    // fDÖD ingår i urvalet därför att en receptionist är tilldelad den — den ska
    // synas som ett problem, inte försvinna. f9 har ingen receptionist alls.
    ok("KPI: hus = receptionisternas tilldelningar (inkl. den raderade), aldrig f9", k.hus === 4);
    // lobby: v2, v6 = 2 av 8 = 25 %
    ok("KPI: andel via lobbyskärm = 25 %", k.via_lobby_andel === 25);
    // skickad: v1,v2,v6 = 3 · fel: v3,v4 = 2 → 2/5 = 40 %
    ok("KPI: notisfel = 2 st, 40 % av försökta", k.notis_fel === 2 && k.notis_fel_andel === 40);
    ok("KPI: receptionister som inte kan jobba = 1 (Sofia)", k.receptionister_kan_ej_jobba === 1 && k.receptionister_totalt === 5);

    const a = r.body.atgarder;
    const typer = a.map((x) => x.typ);
    // ⚠️ MUTATIONSMÅL 1: hyresgäst utan kontaktlista måste finnas i listan.
    const utan = a.find((x) => x.typ === "kund_utan_kontaktlista");
    ok("åtgärd: hyresgäst UTAN kontaktlista (cc4) finns", !!utan && utan.kund_id === "cc4");
    ok("åtgärd: kund_utan_kontaktlista har verb + konsekvens", !!utan && utan.verb === "Kontakta kunden" && utan.text.indexOf("2 besök") > -1);
    const onabar = a.find((x) => x.typ === "kund_utan_kontaktvag");
    ok("åtgärd: hyresgäst vars alla värdar saknar kanal (cc2)", !!onabar && onabar.kund_id === "cc2");
    ok("åtgärd: konsekvensen är besök utan notis, inte bara en siffra", !!onabar && onabar.text.indexOf("gick utan notis") > -1);
    const delvis = a.find((x) => x.typ === "vardar_utan_kontaktvag");
    ok("åtgärd: 1 av 3 värdar hos cc1 går inte att nå → warn", !!delvis && delvis.niv === "warn" && delvis.rubrik.indexOf("1 av 3") > -1);
    const sofia = a.find((x) => x.typ === "receptionist_utan_hus");
    ok("åtgärd: receptionist utan hus + backends egen felkod", !!sofia && sofia.user_id === "u2" && sofia.text.indexOf("no_fastigheter_assigned") > -1);
    ok("åtgärd: receptionist utan hus har verbet 'Tilldela hus'", !!sofia && sofia.verb === "Tilldela hus");
    const dod = a.find((x) => x.typ === "fastighet_saknas");
    ok("åtgärd: raderad fastighet i en tilldelning syns", !!dod && dod.hus_id === "fDÖD");
    const nfel = a.find((x) => x.typ === "notiser_fel");
    ok("åtgärd: notisfel per hus med vanligaste orsaken", !!nfel && nfel.text.indexOf("saknar både mobil") > -1);
    ok("åtgärd: allvarligt sorteras före varning", at(a, 0).niv === "bad" && typer.indexOf("vardar_utan_kontaktvag") > typer.indexOf("kund_utan_kontaktlista"));
    ok("åtgärd: hus utanför urvalet läcker inte in (cc9/f9)", !a.some((x) => x.kund_id === "cc9" || x.hus_id === "f9"));
    // ⚠️ Varje rad MÅSTE ha ett verb — en avvikelse utan handling är bara en notis.
    ok("åtgärd: varje rad har verb och text", a.every((x) => x.verb && x.text && x.rubrik));
  }

  // ── HUS: besöksuppsättningar ──────────────────────────────────────────────
  {
    const s = bygg();
    const r = await call(s.routes, "get", "/admin/staff/hus", { headers: ADMIN });
    ok("hus ok, 4 rader (f1,f2,f3 + den raderade)", r.body.ok === true && r.body.total === 4);
    ok("hus: ohanterat hus (f9) syns inte", !r.body.rader.some((h) => h.id === "f9"));
    ok("hus: den raderade fastigheten märks ut, inte gömd", r.body.rader.some((h) => h.id === "fDÖD" && h.saknas === true));
    const byId = new Map(r.body.rader.map((h) => [h.id, h]));
    const f1 = byId.get("f1"), f2 = byId.get("f2"), f3 = byId.get("f3");
    // ⚠️ MUTATIONSMÅL 4: namnet ligger i Titel. Adress är ett geo-OBJEKT.
    ok("hus: namnet läses ur Titel", f1.namn === "Hötorget 3");
    ok("hus: saknad Titel → adresstext, ALDRIG [object Object]", f2.namn === "Malmskillnadsgatan 32, Stockholm");
    ok("hus: inget namn blir [object Object]", r.body.rader.every((h) => h.namn.indexOf("[object Object]") < 0));
    // ⚠️ MUTATIONSMÅL 5: hyresgäster via ClientCompany.Fastighet, inte Fastighet.Hyresgäster.
    ok("hus: hyresgäster härledda ur ClientCompany.Fastighet (f1 = cc1+cc2)", f1.hyresgaster === 2);
    ok("hus: en kund i två hus räknas i båda (cc2 i f1+f2)", f2.hyresgaster === 2);
    ok("hus: kontaktlistor = kunder med minst en nåbar värd", f1.kontaktlistor === 1 && f1.utan_kontaktlista === 1);
    ok("hus: f3 har en kund helt utan värdar", f3.hyresgaster === 1 && f3.kontaktlistor === 0);
    ok("hus: besök per hus", f1.besok === 5 && f2.besok === 1 && f3.besok === 2);
    ok("hus: andel via lobbyn (f1: 1 av 5 = 20 %)", f1.lobby_andel === 20);
    // ⚠️ MUTATIONSMÅL 3: fel får ALDRIG räknas som skickad.
    ok("hus: notisstatus skiljer skickad/fel/väntar (f1: 2/2/1)", f1.notis_skickad === 2 && f1.notis_fel === 2 && f1.notis_vantar === 1);
    ok("hus: andel notiser fram = skickad/(skickad+fel), inte av alla besök", f1.notis_fram_andel === 50);
    // ⚠️ Noll försök får aldrig bli "100 % gick fram".
    ok("hus: inga notisförsök → null, aldrig 0 % eller 100 %", f3.notis_fram_andel === null);
    ok("hus: inga besök → lobby_andel null (ingen påhittad nolla)", byId.get("f2").besok > 0 || byId.get("f2").lobby_andel === null);
    ok("hus: receptionister per hus", f1.receptionister.length === 3 && at(f3.receptionister, 0).namn === "Marcus Ek");
    const u = f1.utan_kontaktvag;
    ok("hus: kunderna bakom siffran går att öppna", u.length === 1 && at(u, 0).kund_id === "cc2" && at(u, 0).besok === 2);
  }

  // ── RECEPTIONISTER ────────────────────────────────────────────────────────
  {
    const s = bygg();
    const r = await call(s.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
    ok("receptionister: bara User_role = Receptionist", r.body.total === 5 && !r.body.rader.some((x) => x.id === "u4"));
    const byId = new Map(r.body.rader.map((x) => [x.id, x]));
    const anna = byId.get("u1"), sofia = byId.get("u2"), marcus = byId.get("u3"), namnlos = byId.get("u5");
    ok("session: giltig token → aktiv", anna.session.status === "aktiv" && anna.kan_jobba === true);
    // ⚠️ Backends EGNA felkod, så ingen behöver läsa serverloggar.
    ok("session: inget hus → nekas + no_fastigheter_assigned", sofia.session.status === "nekas" && sofia.session.kod === "no_fastigheter_assigned" && sofia.kan_jobba === false);
    ok("session: utgången token → utloggad, inte aktiv", marcus.session.status === "utloggad" && marcus.session.kod === "token_expired");
    ok("receptionist utan namn faller INTE tyst bort (faller tillbaka på e-post)", !!namnlos && namnlos.namn === "namnlos@carotte.se");
    const utanAllt = byId.get("u6");
    // ⚠️ Tyst bortfall är exakt hur "[object Object]"-buggen kunde leva vidare.
    ok("receptionist utan BÅDE namn och e-post syns ändå, märkt", !!utanAllt && utanAllt.namn === "(namnlös användare)");
    ok("fastighetsnamn resolvat på raden", at(anna.fastigheter, 0).namn === "Hötorget 3");
    ok("raderad fastighet märks ut i tilldelningen", namnlos.fastigheter.some((f) => f.id === "fDÖD" && f.saknas === true));
    ok("besök per receptionist räknas ur registrerad_av", anna.besok === 3 && marcus.besok === 2);
    ok("fastighetsväljaren följer med", r.body.fastigheter.length === 4);
    // ⚠️ Tokenen får ALDRIG lämna servern.
    const json = JSON.stringify(r.body);
    ok("sessionsnyckeln läcker inte ut i svaret", json.indexOf("tok-anna") < 0 && json.indexOf("tok-marcus") < 0);
  }

  // ── TILLDELNING (skriver) ─────────────────────────────────────────────────
  {
    const s = bygg();
    const r = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u2" }, body: { fastigheter: ["f1", "f3"] },
    });
    ok("tilldelning ok", r.body.ok === true && r.body.fastigheter.join(",") === "f1,f3");
    const u2 = s.STORE.User.find((u) => u._id === "u2");
    ok("tilldelning: receptionist_fastigheter skrivet", (u2.receptionist_fastigheter || []).join(",") === "f1,f3");
    // ⚠️ MUTATIONSMÅL 2 — SÄKERHETSRELEVANT. Utan detta behåller en avaktiverad
    // receptionist sin åtkomst i upp till 12 h (BESOKSHANTERING.md §7.5.3c).
    ok("tilldelning NOLLAR visitor_token", u2.visitor_token === "" && r.body.token_rensad === true);
    ok("tilldelning: fältet som bet rapporteras", r.body.token_falt === "visitor_token");
    ok("tilldelning: ingen varning när tokenen nollades", r.body.varning === null);
    // ⚠️ Två patchar med flit: ett felstavat tokenfält får aldrig göra
    // fastighetsskrivningen till en no-op (Bubble avvisar HELA patchen).
    const patchar = s.räknare.patch.filter((p) => p.t === "User" && p.id === "u2");
    ok("tilldelning: fastigheter och token skrivs i SKILDA patchar", patchar.length === 2 &&
       Object.keys(at(patchar, 0).payload || {}).join() === STAFF.FASTIGHETER && Object.keys(at(patchar, 1).payload || {}).join() === "visitor_token");
    // Listan ska visa det nya direkt — inte om en timme.
    const efter = await call(s.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
    const sofia = efter.body.rader.find((x) => x.id === "u2");
    ok("tilldelning: listan visar de nya husen direkt (cachen vräkt)", sofia.fastigheter.length === 2 && sofia.kan_jobba === true);
    ok("tilldelning: sessionen visas som utloggad efter nollning", sofia.session.status === "utloggad");

    // Revokering: tom lista ska gå igenom OCH nolla sessionen.
    const rev = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u1" }, body: { fastigheter: [] },
    });
    const u1 = s.STORE.User.find((u) => u._id === "u1");
    ok("revokering: tom lista tillåts och nollar sessionen", rev.body.ok === true && (u1.receptionist_fastigheter || []).length === 0 && u1.visitor_token === "");
  }

  // ── TILLDELNING: fel som ska fångas ───────────────────────────────────────
  {
    const s = bygg();
    const okänd = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u2" }, body: { fastigheter: ["f1", "hittepå"] },
    });
    ok("okänt fastighets-id → 400, INGEN död referens skrivs", okänd.code === 400 && okänd.body.error === "unknown_fastighet" && okänd.body.okanda.join() === "hittepå");
    ok("okänt id: ingenting skrevs", (s.STORE.User.find((u) => u._id === "u2").receptionist_fastigheter || []).length === 0);
    const ejRec = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u4" }, body: { fastigheter: ["f1"] },
    });
    ok("tilldelning till någon utan rollen → 409 med rollen i svaret", ejRec.code === 409 && ejRec.body.error === "not_receptionist" && ejRec.body.role === "Ansvarig");
    const saknas = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "finns-ej" }, body: { fastigheter: ["f1"] },
    });
    ok("okänd användare → 404", saknas.code === 404 && saknas.body.error === "user_not_found");
    const ejArray = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u2" }, body: { fastigheter: "f1" },
    });
    ok("fastigheter måste vara en lista → 400", ejArray.code === 400 && ejArray.body.error === "fastigheter_must_be_array");
  }

  // ── TILLDELNING: tokenfältets versalisering ───────────────────────────────
  // ⚠️ Dokumentationen skriver både `visitor_token` och `Visitor_token`. Bubble är
  // case-sensitivt och avvisar hela patchen vid fel namn — därför provas båda.
  {
    const s = bygg();
    const orig = KNOWN_FIELDS.User.slice();
    KNOWN_FIELDS.User = orig.filter((f) => f !== "visitor_token").concat(["Visitor_token"]);
    const r = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u2" }, body: { fastigheter: ["f1"] },
    });
    KNOWN_FIELDS.User = orig;
    ok("token: faller tillbaka till Visitor_token när gement namn avvisas", r.body.ok === true && r.body.token_rensad === true && r.body.token_falt === "Visitor_token");
    ok("token: fastigheterna skrevs ändå", (s.STORE.User.find((u) => u._id === "u2").receptionist_fastigheter || []).join() === "f1");
  }
  {
    const s = bygg();
    const orig = KNOWN_FIELDS.User.slice();
    KNOWN_FIELDS.User = orig.filter((f) => f !== "visitor_token");   // inget av namnen finns
    const r = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u2" }, body: { fastigheter: ["f1"] },
    });
    KNOWN_FIELDS.User = orig;
    // Tilldelningen ska INTE fallera — men tystnad om en icke-nollad session vore värre än allt.
    ok("token: kan den inte nollas SÄGS det, högt", r.body.ok === true && r.body.token_rensad === false && /12 h/.test(r.body.varning || ""));
    ok("token: fastighetsskrivningen överlever ändå", (s.STORE.User.find((u) => u._id === "u2").receptionist_fastigheter || []).join() === "f1");
  }

  // ── TILLDELNING: tyst fältdrop ────────────────────────────────────────────
  // ⚠️ [[reference-bubble-tysta-faltdrop]]: "sparat" utan återläsning är en gissning.
  {
    const s = bygg({ tystDrop: [STAFF.FASTIGHETER] });
    const r = await call(s.routes, "post", "/admin/staff/receptionister/:id/fastigheter", {
      headers: ADMIN, params: { id: "u2" }, body: { fastigheter: ["f1"] },
    });
    ok("tyst fältdrop upptäcks av återläsningen → 500, aldrig ett falskt 'sparat'",
      r.code === 500 && r.body.error === "fastigheter_ej_skrivna" && r.body.skrivna.length === 0);
  }

  // ── NOTISER ───────────────────────────────────────────────────────────────
  {
    const s = bygg();
    const r = await call(s.routes, "get", "/admin/staff/notiser", { headers: ADMIN });
    ok("notiser ok", r.body.ok === true);
    ok("notiser: summan skiljer skickad/fel/väntar", r.body.summa.skickad === 3 && r.body.summa.fel === 2 && r.body.summa.vantar === 3);
    ok("notiser: andel fram räknas på försökta, inte på alla besök", r.body.summa.fram_andel === 60);
    ok("notiser: felorsaker grupperade", r.body.orsaker.length === 1 && at(r.body.orsaker, 0).antal === 2);
    const cc2 = r.body.kunder.find((k) => k.kund_id === "cc2");
    ok("notiser: fel per hyresgäst med orsak", !!cc2 && cc2.fel === 1 && _str(at(cc2.orsaker, 0).orsak).indexOf("saknar både") > -1);
    ok("notiser: hus utanför urvalet läcker inte in", !r.body.orsaker.some((o) => o.orsak === "hemligt"));
    const filt = await call(s.routes, "get", "/admin/staff/notiser", { headers: ADMIN, query: { fastighet: "f2" } });
    ok("notiser: filter per hus", filt.body.hus.length === 1 && filt.body.summa.fel === 0);
    const utanfor = await call(s.routes, "get", "/admin/staff/notiser", { headers: ADMIN, query: { fastighet: "f9" } });
    ok("notiser: okänt/ohanterat hus → 404, inte tyst tomt", utanfor.code === 404);
  }

  // ── PERIOD ────────────────────────────────────────────────────────────────
  {
    const s = bygg();
    const r90 = await call(s.routes, "get", "/admin/staff/oversikt", { headers: ADMIN, query: { dagar: "90" } });
    ok("dagar=90 tar med 30-dagarsbesöket", r90.body.kpi.besok === 9);
    const r1 = await call(s.routes, "get", "/admin/staff/oversikt", { headers: ADMIN, query: { dagar: "1" } });
    ok("dagar=1 → bara gårdagens", r1.body.kpi.besok < 8);
    const skräp = await call(s.routes, "get", "/admin/staff/oversikt", { headers: ADMIN, query: { dagar: "abc" } });
    ok("skräp i dagar → 7 dagar, inte NaN", skräp.body.dagar === 7 && Number.isFinite(skräp.body.kpi.besok));
    const tak = await call(s.routes, "get", "/admin/staff/oversikt", { headers: ADMIN, query: { dagar: "9999" } });
    ok("orimlig period klampas till 7", tak.body.dagar === 7);
  }

  // ── WU-disciplin ──────────────────────────────────────────────────────────
  {
    const s = bygg();
    await call(s.routes, "get", "/admin/staff/oversikt", { headers: ADMIN });
    const visitFragor = s.räknare.find.filter((f) => f.t === VISIT.TYPE);
    // ⚠️ INGET helsvep av Visit. Varje fråga MÅSTE bära fastighets-constrainten.
    ok("Visit hämtas aldrig utan fastighets-constraint", visitFragor.length > 0 &&
      visitFragor.every((f) => f.constraints.some((c) => c.key === VISIT.F_FASTIGHET)));
    ok("Visit frågas EN gång per hus i urvalet, inte per hyresgäst", visitFragor.filter((f) => (f.cursor || 0) === 0).length === 4);
    // Datum-constraint skickas ned → Bubble filtrerar, vi hämtar inte hela historiken.
    ok("datumfönstret skickas som constraint", visitFragor.every((f) => f.constraints.some((c) => c.key === VISIT.F_IN)));

    const före = s.räknare.find.length;
    await call(s.routes, "get", "/admin/staff/hus", { headers: ADMIN });
    await call(s.routes, "get", "/admin/staff/notiser", { headers: ADMIN });
    await call(s.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
    ok("alla fyra vyerna delar EN ögonblicksbild — noll nya Bubble-frågor", s.räknare.find.length === före);

    const s2 = bygg({ snapshotTtlMs: 0 });
    await call(s2.routes, "get", "/admin/staff/oversikt", { headers: ADMIN });
    const n1 = s2.räknare.find.filter((f) => f.t === "ClientCompany").length;
    await call(s2.routes, "get", "/admin/staff/oversikt", { headers: ADMIN });
    const n2 = s2.räknare.find.filter((f) => f.t === "ClientCompany").length;
    ok("hyresgästlistan cachas separat (TTL) även när ögonblicksbilden byggs om", n2 === n1);
  }

  // ── DATUM-CONSTRAINT SOM INTE BITER ───────────────────────────────────────
  // Bubbles slug-form för date-fält är inte verifierad mot Visit. Biter den inte
  // ska svaret bli RÄTT ändå (JS-omfiltrering) — och vägen ska redovisas.
  {
    const s = bygg({ datumConstraintFel: true });
    const r = await call(s.routes, "get", "/admin/staff/oversikt", { headers: ADMIN });
    ok("datum-constraint avvisas → siffrorna blir ändå rätt", r.body.ok === true && r.body.kpi.besok === 8);
    ok("fallbacken redovisas i meta, aldrig tyst", r.body.meta.datumfilter_fallback === 3);
  }

  // ── FEL SOM MÅSTE BRAKA ───────────────────────────────────────────────────
  {
    // ⚠️ ENDAST User-svepet fallerar — Coworker och Fastighet svarar normalt. Utan
    // den isoleringen hade testet blivit grönt av fel skäl (Coworker-svepet kastar
    // ändå), och `.catch(() => [])`-fällan i _users hade kunnat smyga tillbaka.
    const d = mkDeps(nyStore());
    let userForsok = 0;
    const capp = mkApp();
    const co = registerCompaniesRoutes(capp.app, {
      bubbleFind: async (t, o) => { if (t === "User") { userForsok++; const e = new Error("bubbleFind failed"); e.detail = { status: 500, body: "boom" }; throw e; } return d.bubbleFind(t, o); },
      bubbleFindAll: async (t, o) => { if (t === "User") { userForsok++; const e = new Error("bubbleFind failed"); e.detail = { status: 500, body: "boom" }; throw e; } return d.bubbleFindAll(t, o); },
      bubbleGet: d.bubbleGet, bubbleId: d.bubbleId, bubblePatch: d.bubblePatch,
      planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "ip",
    });
    const sapp = mkApp();
    registerStaffRoutes(sapp.app, {
      bubbleFind: d.bubbleFind, bubbleFindAll: d.bubbleFindAll, bubbleGet: d.bubbleGet, bubbleId: d.bubbleId, bubblePatch: d.bubblePatch,
      receptionistDirectory: () => co.receptionistDirectory(),
      coworkerDirectory: () => co.coworkerDirectory(),
      fastighetDirectory: () => co.fastighetDirectory(),
      usersForget: () => co.usersForget(),
      userRoleDirectory: () => co.userRoleDirectory(), CAROTTE_COMPANY_ID: "CAROTTE",
      planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "ip",
    });
    const r = await call(sapp.routes, "get", "/admin/staff/oversikt", { headers: ADMIN });
    ok("trasigt User-svep → fel, ALDRIG '0 receptionister'", r.code >= 500 && r.body.ok === false && r.body.error === "user_sweep_failed");
    // ⚠️ Och det får inte cachas. Cachas ett misslyckat svep serveras tomheten i 60
    // minuter — mätt på att User FAKTISKT frågas igen, inte på felkoden (den blir
    // densamma även ur en cachad tomhet).
    userForsok = 0;
    await call(sapp.routes, "get", "/admin/staff/oversikt", { headers: ADMIN });
    ok("misslyckat User-svep cachas inte — nästa anrop frågar Bubble igen", userForsok > 0);

    // Ett 5xx från Visit-frågan får inte heller sväljas.
    const s3 = bygg();
    const co3 = s3.co;
    const bad = mkApp();
    registerStaffRoutes(bad.app, {
      bubbleFind: async (t) => { if (t === VISIT.TYPE) { const e = new Error("bubbleFind failed"); e.detail = { status: 503, body: "upstream" }; throw e; } return []; },
      bubbleFindAll: async () => [], bubbleGet: async () => null, bubbleId: (r) => (r ? r._id : null), bubblePatch: async () => true,
      receptionistDirectory: () => co3.receptionistDirectory(),
      coworkerDirectory: () => co3.coworkerDirectory(),
      fastighetDirectory: () => co3.fastighetDirectory(),
      usersForget: () => {}, userRoleDirectory: () => co3.userRoleDirectory(), CAROTTE_COMPANY_ID: "CAROTTE",
      planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "ip",
    });
    const r3 = await call(bad.routes, "get", "/admin/staff/hus", { headers: ADMIN });
    ok("5xx från Visit brakar — inte tomma siffror", r3.code >= 500 && r3.body.ok === false);
  }

  // ── KLUSTER ───────────────────────────────────────────────────────────────
  {
    const STORE = nyStore();
    STORE.Cluster = [
      { _id: "kl1", Titel: "Sergelstan", Fastighet: ["f1", "f2", "raderad"] },
      { _id: "kl2", Titel: "Tomt kluster", Fastighet: [] },
    ];
    const s = bygg({ store: STORE });
    const r = await call(s.routes, "get", "/admin/staff/kluster", { headers: ADMIN });
    ok("kluster: listas som UI-genväg", r.body.ok === true && r.body.total === 1 && at(r.body.kluster, 0).namn === "Sergelstan");
    ok("kluster: raderade fastigheter filtreras bort ur genvägen", (at(r.body.kluster, 0).fastigheter || []).join() === "f1,f2");
  }

  // ── ROLLSÄTTNING: skapa/ta bort receptionist ──────────────────────────────
  {
    const s = bygg();
    const r = await call(s.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
    const kid = r.body.kandidater.map((k) => k.id);
    ok("kandidater: våra egna users som inte redan är receptionister", kid.indexOf("u7") > -1 && kid.indexOf("u4") > -1);
    ok("kandidater: befintliga receptionister listas inte som kandidater", kid.indexOf("u1") < 0 && kid.indexOf("u2") < 0);
    // ⚠️ KÄRNAN: kundens egen inloggning får aldrig erbjudas rollen.
    ok("kandidater: KUNDENS egna users syns aldrig", kid.indexOf("k1") < 0);
    ok("kandidater: nuvarande roll visas så man ser vad man skriver över",
      at(r.body.kandidater.filter((k) => k.id === "u4"), 0).roll === "Ansvarig");
    ok("kandidater: bolaget redovisas och listan är filtrerad", r.body.bolag === "CAROTTE" && r.body.kandidater_ofiltrerade === undefined);
    // ⚠️ Moment 22: värdet måste gå att sätta FÖRSTA gången, innan någon bär det.
    ok("roller: Receptionist finns alltid i väljaren", r.body.roller.indexOf("Receptionist") > -1);
    ok("roller: övriga härleds ur datan, gissas inte", r.body.roller.indexOf("Ansvarig") > -1 && r.body.roller.indexOf("Hittepåroll") < 0);
    // ⚠️ MOMENT 22, det som faktiskt biter: i en databas där INGEN ännu är
    // receptionist kan värdet inte härledas ur datan — och då måste den FÖRSTA
    // receptionisten ändå gå att skapa. Testas därför mot en tom värld.
    {
      const tomStore = nyStore();
      tomStore.User = tomStore.User.filter((u) => u.User_role !== "Receptionist");
      const st = bygg({ store: tomStore });
      const rt = await call(st.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
      ok("ingen är receptionist ännu → rollen går ÄNDÅ att välja", rt.body.roller.indexOf("Receptionist") > -1);
      ok("ingen är receptionist ännu → tom lista, inget fel", rt.body.ok === true && rt.body.total === 0);
      const first = await call(st.routes, "post", "/admin/staff/receptionister/:id/roll", {
        headers: ADMIN, params: { id: "u7" }, body: { roll: "Receptionist" },
      });
      ok("den FÖRSTA receptionisten går att skapa", first.body.ok === true &&
        st.STORE.User.find((u) => u._id === "u7").User_role === "Receptionist");
    }

    // Utan bolag: filtrera INTE tyst — säg det.
    const s0 = bygg({ carotte: "" });
    const r0 = await call(s0.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
    ok("utan bolag: kandidatlistan filtreras inte — men det SÄGS", r0.body.kandidater_ofiltrerade === true && r0.body.kandidater.some((k) => k.id === "k1"));

    // Sätt rollen
    const sat = await call(s.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u7" }, body: { roll: "Receptionist" },
    });
    const u7 = s.STORE.User.find((u) => u._id === "u7");
    ok("roll: sätts på vår egen user", sat.body.ok === true && u7.User_role === "Receptionist" && sat.body.tidigare === null);
    ok("roll: svaret säger att personen tappar CRM-åtkomsten", sat.body.crm_atkomst === false);
    const efter = await call(s.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
    ok("roll: personen dyker upp i listan direkt (cachen vräkt)", efter.body.rader.some((x) => x.id === "u7"));
    ok("roll: och med backends egen felkod tills hen fått hus",
      at(efter.body.rader.filter((x) => x.id === "u7"), 0).session.kod === "no_fastigheter_assigned");
    ok("roll: personen är inte längre kandidat", efter.body.kandidater.every((k) => k.id !== "u7"));

    // ⚠️ SÄKERHETSRELEVANT: att TA BORT rollen ska stänga sessionen direkt.
    const s2 = bygg();
    const bort = await call(s2.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u1" }, body: { roll: "Medarbetare" },
    });
    const u1 = s2.STORE.User.find((u) => u._id === "u1");
    ok("roll: borttagen roll nollar sessionen SAMMA sekund, inte om 12 h",
      bort.body.ok === true && u1.User_role === "Medarbetare" && u1.visitor_token === "" && bort.body.token_rensad === true);
    ok("roll: den gamla rollen redovisas", bort.body.tidigare === "Receptionist");
    const kvar = await call(s2.routes, "get", "/admin/staff/receptionister", { headers: ADMIN });
    ok("roll: personen försvinner ur receptionistlistan", kvar.body.rader.every((x) => x.id !== "u1"));
  }

  // ── ROLLSÄTTNING: fel som ska fångas ──────────────────────────────────────
  {
    const s = bygg();
    // ⚠️ KÄRNAN. En kundanvändare som blir receptionist ser hyresgästernas kontaktlistor.
    const kund = await call(s.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "k1" }, body: { roll: "Receptionist" },
    });
    ok("roll på KUNDENS user → 403, aldrig skriven", kund.code === 403 && kund.body.error === "not_our_user" &&
      s.STORE.User.find((u) => u._id === "k1").User_role === "Medarbetare");
    const os = await call(s.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u7" }, body: { roll: "receptionist" },
    });
    // Option-set är case-sensitivt — "receptionist" är inte "Receptionist".
    ok("okänt/felstavat rollvärde → 400 med tillåtna värden", os.code === 400 && os.body.error === "unknown_roll" && os.body.tillatna.indexOf("Receptionist") > -1);
    const tom = await call(s.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u7" }, body: {},
    });
    ok("roll utan värde → 400", tom.code === 400 && tom.body.error === "missing_roll");
    const saknas = await call(s.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "finns-ej" }, body: { roll: "Receptionist" },
    });
    ok("okänd användare → 404", saknas.code === 404);
    const lika = await call(s.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u4" }, body: { roll: "Ansvarig" },
    });
    ok("samma roll igen → no-op, ingen onödig sessionsnollning",
      lika.body.ok === true && lika.body.oforandrad === true && s.STORE.User.find((u) => u._id === "u4").visitor_token === "tok-karin");

    // ⚠️ FAIL-CLOSED: utan bolag får rollen inte delas ut på måfå.
    const s0 = bygg({ carotte: "" });
    const utan = await call(s0.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u7" }, body: { roll: "Receptionist" },
    });
    ok("utan känt bolag → 400, INGEN roll skriven (fail-closed)",
      utan.code === 400 && utan.body.error === "carotte_company_id_missing" &&
      s0.STORE.User.find((u) => u._id === "u7").User_role === undefined);
    // Blockets user_company vinner över env — samma regel som companies_api.
    const medQ = await call(s0.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u7" }, query: { user_company: "CAROTTE" }, body: { roll: "Receptionist" },
    });
    ok("user_company från blocket räcker när env saknas", medQ.body.ok === true);

    // ⚠️ Tyst fältdrop på ett option-set: "sparat" utan återläsning är en gissning.
    const sd = bygg({ tystDrop: [STAFF.ROLE] });
    const drop = await call(sd.routes, "post", "/admin/staff/receptionister/:id/roll", {
      headers: ADMIN, params: { id: "u7" }, body: { roll: "Receptionist" },
    });
    ok("roll som inte fastnar upptäcks av återläsningen → 500", drop.code === 500 && drop.body.error === "roll_ej_skriven");
  }

  // ── ALLA ROUTES RÖKTESTAS ─────────────────────────────────────────────────
  // ⚠️ Aritetstest räcker inte — varje registrerad route ska faktiskt ANROPAS.
  // En route som aldrig fick sina deps (eller stavades fel) syns bara så här.
  {
    const s = bygg();
    const paths = { get: Object.keys(s.routes.get), post: Object.keys(s.routes.post) };
    ok("routes: fem GET + två POST registrerade", paths.get.length === 5 && paths.post.length === 2);
    ok("routes: alla ligger under /admin/staff (openPrefix-täckning)",
      paths.get.concat(paths.post).every((p) => p.indexOf("/admin/staff") === 0));
    const STORE2 = nyStore(); STORE2.Cluster = [];
    const s2 = bygg({ store: STORE2 });
    for (const p of Object.keys(s2.routes.get)) {
      const r = await call(s2.routes, "get", p, { headers: ADMIN, params: { id: "u2" } });
      ok("route GET " + p + " svarar 2xx", r.code >= 200 && r.code < 300 && r.body && r.body.ok === true);
      const u = await call(s2.routes, "get", p, { params: { id: "u2" } });
      ok("route GET " + p + " kräver admin-token", u.code === 401);
    }
    for (const p of Object.keys(s2.routes.post)) {
      const kropp = { fastigheter: ["f1"], roll: "Receptionist" };
      const r = await call(s2.routes, "post", p, { headers: ADMIN, params: { id: "u2" }, body: kropp });
      ok("route POST " + p + " svarar 2xx", r.code >= 200 && r.code < 300 && r.body && r.body.ok === true);
      const u = await call(s2.routes, "post", p, { params: { id: "u2" }, body: kropp });
      ok("route POST " + p + " kräver admin-token", u.code === 401);
    }
    // ⚠️ Blocket får inte anropa en sökväg som backend inte registrerat
    // (jfr /mypage/me som låg fel i deps 2026-08-27 → routen fanns aldrig).
    const html = await fs.readFile(new URL("./mira-staff.html", import.meta.url), "utf8");
    const anropade = Array.from(new Set((html.match(/"\/admin\/staff\/[a-z\/]*/g) || []).map((x) => x.slice(1))));
    ok("block: minst fem sökvägar anropas", anropade.length >= 5);
    for (const a of anropade) {
      const träff = paths.get.concat(paths.post).some((p) => p === a || p.indexOf(a) === 0);
      ok("block anropar en route som finns: " + a, träff);
    }
  }

  // ── HTML-BLOCKET ──────────────────────────────────────────────────────────
  // Fem fällor som alla bränt oss en gång. Statiska, men de fäller en regression.
  {
    const html = await fs.readFile(new URL("./mira-staff.html", import.meta.url), "utf8");
    const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || "";
    // ⚠️ Bubbles globala button:hover har !important → knappen blir helorange med
    // osynlig text om blocket inte kontrar på BÅDE background och color.
    // [[reference-bubble-button-hover-important]]
    const hover = (html.match(/\.st-btn:hover[^}]*}/g) || []).join(" ");
    ok("block: knapparnas :hover kontrar Bubbles !important på background OCH color",
      /background:[^;]*!important/.test(hover) && /color:[^;]*!important/.test(hover));
    ok("block: primärknappens :hover kontrar också",
      /\.st-btn\.pri:hover[^}]*background:[^;]*!important[^}]*color:[^;]*!important/.test(html.replace(/\n/g, " ")));
    // ⚠️ Ett setInterval-helsvep kostade en gång 78 % av Miras idle-golv.
    ok("block: ingen setInterval/setTimeout-poller", script.indexOf("setInterval") < 0);
    // ⚠️ Bubble ärver word-break:break-all → text bryts mitt i ord.
    ok("block: word-break neutraliserad", /word-break:\s*normal/.test(html));
    // ⚠️ `overflow-wrap:anywhere` globalt påverkar min-content-bredden → smala
    // tabellkolumner krymper och "Sergelhuset" renderas som "Sergelhus/et".
    ok("block: global overflow-wrap är break-word, inte anywhere",
      /\.st, \.st \*\{[^}]*overflow-wrap:break-word/.test(html.replace(/\n\s*/g, "")));
    // ⚠️ Breda tabeller måste ligga i egen overflow-x, annars klipps sista kolumnen.
    ok("block: breda tabeller i egen overflow-x-container", /\.st-tw\{[^}]*overflow-x:auto/.test(html));
    ok("block: konventionerna hålls (ingen ?. / ??)", !/[^\/]\?\./.test(script) && script.indexOf("??") < 0);
    ok("block: inga smart quotes", !/[\u2018\u2019\u201c\u201d]/.test(html));
    // ⚠️ Rita aldrig en flik mot en källa som inte finns.
    // Orden får stå i förklaringen ("saknas med flit") — men aldrig som en FLIK.
    const tabs = (script.match(/var TABS=\[([\s\S]*?)\];/) || [])[1] || "";
    ok("block: exakt fyra flikar — ingen Bemanning, ingen Academy",
      (tabs.match(/k:"/g) || []).length === 4 && tabs.indexOf("Bemanning") < 0 && tabs.indexOf("Academy") < 0);
    ok("block: säger vad som saknas och varför", html.indexOf("Intelliplan saknar klockslag") > -1);
    // BROOT: både LÄSNINGEN (hoppa över redan tagna rötter) och SKRIVNINGEN behövs.
    // Utan skrivningen tar båda blocken samma rot. [[reference-bubble-multiblock-collision]]
    ok("block: BROOT-claim både läses och sätts (två block på samma sida krockar annars)",
      /getAttribute\("data-st-claimed"\)/.test(script) && /setAttribute\("data-st-claimed"/.test(script));
    // ⚠️ null betyder "går inte att räkna" — vyn får aldrig rita 0 % eller 100 %.
    ok("block: null-procent renderas som streck", /function pf\(p\)\{ return p==null\?"—"/.test(script));
  }

  console.log(fail ? `❌ FEL  pass=${pass} fail=${fail}` : `✅ ALLA GRÖNA  pass=${pass} fail=${fail}`);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
