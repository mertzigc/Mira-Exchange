// Smoke: visitor_api.js — besöksloggen med scope-enforcement.
//   node visitor_api_smoke.mjs
import { registerVisitorRoutes, VISIT } from "./visitor_api.js";
import { makeVisitorAuth } from "./visitor_auth.js";

// ── Fixtur ──────────────────────────────────────────────────────────────────
// f1+f2 = receptionistens hus. f9 = FRÄMMANDE hus (får aldrig synas).
// ⚠️ Kundkopplingen ligger på ClientCompany.Fastighet (List) — INTE på
//    Fastighet.Hyresgäster. Fixturen speglar det: Fastighet-raderna saknar
//    Hyresgäster-fält, precis som i produktion där vår kod aldrig skriver det.
const STORE = {
  Fastighet: [
    { _id: "f1", Titel: "Hötorget 3", Adress: { address: "Sveavägen 17, Stockholm" } },
    { _id: "f2", Adress: { address: "Malmskillnadsgatan 32, Stockholm" } },   // saknar Titel → adressfallback
    { _id: "f9", Titel: "Sergelhuset" },
  ],
  ClientCompany: [
    { _id: "cc1", Name_company: "twoday Sverige AB", Fastighet: ["f1"] },
    { _id: "cc2", Name_company: "Swedbank AB",       Fastighet: ["f1", "f2"] },
    { _id: "cc3", Name_company: "Beyond Retail",     Fastighet: ["f2"] },
    { _id: "cc9", Name_company: "Hemligt Bolag AB",  Fastighet: ["f9"] },      // annat hus
  ],
  Coworker: [
    { _id: "co1", "Kundföretag": "cc1", "Förnamn": "Evelina", "Efternamn": "Åblad", Titel: "People Lead", Telefon: 701785977, Email: "evelina@twoday.com" },
    { _id: "co2", "Kundföretag": "cc1", "Förnamn": "Petra", "Efternamn": "Lindholm", Email: "petra@twoday.com" },   // saknar telefon → endast mail
    { _id: "co9", "Kundföretag": "cc9", "Förnamn": "Hemlig", "Efternamn": "Person", Email: "x@hemligt.se" },
  ],
  Visit: [],
};
let _idc = 0;
const _cmatch = (r, cs) => (cs || []).every((c) => {
  const v = r[c.key];
  if (c.constraint_type === "contains") { const a = Array.isArray(v) ? v : (v == null ? [] : [v]); return a.map(String).includes(String(c.value)); }
  return String(v == null ? "" : v) === String(c.value);
});
const findAllCalls = [];
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => {
    findAllCalls.push({ t, constraints });
    return (STORE[t] || []).filter((r) => _cmatch(r, constraints));
  },
  bubbleGet: async (t, id) => (STORE[t] || []).find((r) => r._id === id) || null,
  bubbleCreate: async (t, payload) => { const id = "v" + (++_idc); (STORE[t] = STORE[t] || []).push(Object.assign({ _id: id }, payload)); return id; },
  bubblePatch: async (t, id, payload) => { const r = (STORE[t] || []).find((x) => x._id === id); if (r) Object.assign(r, payload); return {}; },
  planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
};

function mk() {
  const routes = { get: {}, post: {}, options: {} };
  const last = (a) => a[a.length - 1];
  return { app: { get: (p, ...a) => { routes.get[p] = last(a); }, post: (p, ...a) => { routes.post[p] = last(a); }, options: (p, ...a) => { routes.options[p] = last(a); } }, routes };
}
function call(routes, method, path, { query = {}, params = {}, body = {}, headers = {} } = {}) {
  const h = routes[method][path];
  if (!h) return Promise.resolve({ code: 404, body: { ok: false, error: "no_route", route: method + " " + path } });
  return new Promise((r) => {
    const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } };
    h({ params, query, body, headers }, res);
  });
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  const auth = makeVisitorAuth({ secret: "s", sessionSecret: "x", ttlMs: 3600000 });
  const s = mk();
  registerVisitorRoutes(s.app, Object.assign({}, deps, { visitorAuth: auth }));

  const mine = auth.mint({ uid: "u1", fastigheter: ["f1", "f2"], name: "Anna Reception" });
  const H = { "x-visitor-token": mine.token };
  const other = auth.mint({ uid: "u9", fastigheter: ["f9"], name: "Erik Annat" });
  const H9 = { "x-visitor-token": other.token };

  // ── AUTH-GRINDEN ──────────────────────────────────────────────────────────
  const noTok = await call(s.routes, "get", "/visitor/context", {});
  ok("utan token → 401", noTok.code === 401);
  const badTok = await call(s.routes, "get", "/visitor/context", { headers: { "x-visitor-token": "skräp" } });
  ok("skräptoken → 401", badTok.code === 401);

  // ── CONTEXT ───────────────────────────────────────────────────────────────
  const ctx = await call(s.routes, "get", "/visitor/context", { headers: H });
  ok("context ok + användarens namn", ctx.body.ok && ctx.body.user.name === "Anna Reception");
  ok("context: mina 2 fastigheter", ctx.body.fastigheter.length === 2);
  ok("context: Fastighet-namnet kommer från Titel", ctx.body.fastigheter[0].name === "Hötorget 3");
  // ⚠️ f2 saknar Titel → adressfallback, och Adress är ett OBJEKT (aldrig "[object Object]").
  ok("context: saknad Titel → adресstext, inte [object Object]",
    ctx.body.fastigheter[1].name === "Malmskillnadsgatan 32, Stockholm");
  // Härledd kundlista: cc1(f1) + cc2(f1,f2) + cc3(f2) = 4 rader (cc2 i båda husen)
  ok("context: hyresgäster härledda ur ClientCompany.Fastighet", ctx.body.hyresgaster.length === 4);
  ok("context: FRÄMMANDE bolag (cc9 i f9) syns ALDRIG",
    !ctx.body.hyresgaster.some((c) => c.id === "cc9"));

  // ── HOSTS ─────────────────────────────────────────────────────────────────
  const hosts = await call(s.routes, "get", "/visitor/hosts", { headers: H, query: { hyresgast: "cc1" } });
  ok("hosts: 2 värdar hos cc1", hosts.body.ok && hosts.body.count === 2);
  const evelina = hosts.body.hosts.find((h) => h.name === "Evelina Åblad");
  ok("hosts: kanaler visas (telefon → sms, mail → mail)", evelina.has_sms === true && evelina.has_mail === true);
  const petra = hosts.body.hosts.find((h) => h.name === "Petra Lindholm");
  ok("hosts: saknad telefon → has_sms false (receptionisten ser att SMS ej går)", petra.has_sms === false && petra.has_mail === true);
  // ⚠️ KÄRNAN: annat bolag får inte läcka kontaktuppgifter.
  const hostsOut = await call(s.routes, "get", "/visitor/hosts", { headers: H, query: { hyresgast: "cc9" } });
  ok("hosts: bolag utanför mitt scope → 403 (inte tom lista)", hostsOut.code === 403 && hostsOut.body.error === "outside_scope");
  const hostsNo = await call(s.routes, "get", "/visitor/hosts", { headers: H });
  ok("hosts utan hyresgäst → 400", hostsNo.code === 400);

  // ── SKAPA BESÖK ───────────────────────────────────────────────────────────
  const crt = await call(s.routes, "post", "/visitor/visits", {
    headers: H, body: { fastighet: "f1", hyresgast: "cc1", gast: "Anna Lindqvist", gast_bolag: "Ramboll", vard: "co1", vard_namn: "Evelina Åblad" },
  });
  ok("skapa besök ok", crt.body.ok && !!crt.body.id);
  const v1 = STORE.Visit[0];
  ok("besök: fastighet/hyresgäst/gäst skrivna", v1[VISIT.F_FASTIGHET] === "f1" && v1[VISIT.F_HYRESGAST] === "cc1" && v1[VISIT.F_GAST_NAMN] === "Anna Lindqvist");
  ok("besök: via=reception + signerat av receptionisten", v1[VISIT.F_VIA] === "reception" && v1[VISIT.F_AV] === "u1" && v1[VISIT.F_AV_NAMN] === "Anna Reception");
  ok("besök: notis_status börjar som 'vantar'", v1[VISIT.F_STATUS] === "vantar");
  ok("besök: incheckad_at satt", !!v1[VISIT.F_IN]);

  // Självincheckning signeras som lobbyn, inte som en person.
  const lob = await call(s.routes, "post", "/visitor/visits", {
    headers: H, body: { fastighet: "f2", hyresgast: "cc3", gast: "Sara Berglund", via: "lobby" },
  });
  const v2 = STORE.Visit.find((v) => v._id === lob.body.id);
  ok("lobby-incheckning: via=lobby, ingen person som avsändare", v2[VISIT.F_VIA] === "lobby" && v2[VISIT.F_AV_NAMN] === "Självincheckning" && v2[VISIT.F_AV] === undefined);

  // ── SCOPE VID SKRIVNING ───────────────────────────────────────────────────
  const outF = await call(s.routes, "post", "/visitor/visits", { headers: H, body: { fastighet: "f9", hyresgast: "cc9", gast: "X" } });
  ok("skapa i FRÄMMANDE fastighet → 403", outF.code === 403 && outF.body.error === "outside_scope");
  // ⚠️ Hyresgästen måste ligga i DEN fastigheten — inte bara i mitt scope.
  const wrongPair = await call(s.routes, "post", "/visitor/visits", { headers: H, body: { fastighet: "f1", hyresgast: "cc3", gast: "X" } });
  ok("hyresgäst i fel hus (cc3 är i f2, ej f1) → 403", wrongPair.code === 403 && wrongPair.body.error === "tenant_not_in_fastighet");
  const noGuest = await call(s.routes, "post", "/visitor/visits", { headers: H, body: { fastighet: "f1", hyresgast: "cc1" } });
  ok("besök utan gästnamn → 400", noGuest.code === 400 && noGuest.body.error === "missing_gast");

  // ── LISTA ─────────────────────────────────────────────────────────────────
  const list = await call(s.routes, "get", "/visitor/visits", { headers: H });
  ok("lista: mina 2 besök idag", list.body.ok && list.body.total === 2);
  ok("lista: hyresgästnamn resolvat", list.body.rows.some((r) => r.hyresgast === "twoday Sverige AB"));
  ok("lista: nyast först", Date.parse(list.body.rows[0].in) >= Date.parse(list.body.rows[1].in));
  const listF1 = await call(s.routes, "get", "/visitor/visits", { headers: H, query: { fastighet: "f1" } });
  ok("lista filtrerad på ett av mina hus → 1", listF1.body.total === 1);
  const listOut = await call(s.routes, "get", "/visitor/visits", { headers: H, query: { fastighet: "f9" } });
  ok("lista med FRÄMMANDE hus → 403", listOut.code === 403);
  const q = await call(s.routes, "get", "/visitor/visits", { headers: H, query: { q: "ramboll" } });
  ok("sök på besökarens bolag", q.body.total === 1 && q.body.rows[0].gast === "Anna Lindqvist");
  // ⚠️ Annan receptionist ser INTE mina besök.
  const listOther = await call(s.routes, "get", "/visitor/visits", { headers: H9 });
  ok("annan receptionists scope → ser noll av mina besök", listOther.body.ok && listOther.body.total === 0);

  // ── UTCHECKNING ───────────────────────────────────────────────────────────
  const co = await call(s.routes, "post", "/visitor/visits/:id/checkout", { headers: H, params: { id: crt.body.id } });
  ok("utcheckning ok + tid satt", co.body.ok && !!co.body.utcheckad_at && !!STORE.Visit[0][VISIT.F_UT]);
  const co2 = await call(s.routes, "post", "/visitor/visits/:id/checkout", { headers: H, params: { id: crt.body.id } });
  ok("dubbel utcheckning → idempotent (already), skriver inte om tiden", co2.body.ok && co2.body.already === true);
  // ⚠️ KÄRNAN: gissat id i annat hus får inte gå att checka ut.
  const coOut = await call(s.routes, "post", "/visitor/visits/:id/checkout", { headers: H9, params: { id: crt.body.id } });
  ok("utcheckning av besök utanför mitt scope → 403", coOut.code === 403 && coOut.body.error === "outside_scope");
  const co404 = await call(s.routes, "post", "/visitor/visits/:id/checkout", { headers: H, params: { id: "finns-ej" } });
  ok("utcheckning av okänt id → 404", co404.code === 404);
  const openList = await call(s.routes, "get", "/visitor/visits", { headers: H, query: { open: "1" } });
  ok("open=1 filtrerar bort utcheckade", openList.body.total === 1);

  // ── WU: hyresgästlistan cachas ────────────────────────────────────────────
  findAllCalls.length = 0;
  await call(s.routes, "get", "/visitor/context", { headers: H });
  await call(s.routes, "get", "/visitor/context", { headers: H });
  ok("hyresgäst-svepet cachas (inga nya ClientCompany-frågor andra gången)",
    findAllCalls.filter((c) => c.t === "ClientCompany").length === 0);

  console.log(fail ? `❌ FEL  pass=${pass} fail=${fail}` : `✅ ALLA GRÖNA  pass=${pass} fail=${fail}`);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
