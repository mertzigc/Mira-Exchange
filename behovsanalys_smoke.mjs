// Smoke: behovsanalys_api. Kör: node behovsanalys_smoke.mjs
//
// ⚠️ Fixturen mockar Bubble MED KÄNT SCHEMA — okända fält på BehovsAnalys
// avvisas som Bubble gör i produktion. Utan det hade fixturen varit "mer
// tillåtande än verkligheten" (samma klass som used_at-buggen 2026-08-18).

import { registerBehovsanalysRoutes } from "./behovsanalys_api.js";

const KNOWN = new Set(["clientcompany", "deal", "writer", "data", "updated_at", "status"]);

const DB = { BehovsAnalys: [] };
let idc = 0;
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) =>
    (DB[t] || []).filter((r) => (constraints || []).every((c) => {
      if (c.constraint_type === "equals") return String(r[c.key] == null ? "" : r[c.key]) === String(c.value);
      return true;
    })),
  bubbleFind: async (t) => (DB[t] || []),
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCreate: async (t, payload) => {
    const bad = Object.keys(payload || {}).filter((k) => !KNOWN.has(k));
    if (bad.length) { const e = new Error("bubbleCreate failed"); e.detail = { status: 400, body: JSON.stringify({ body: { message: "Unrecognized field: " + bad[0] } }) }; throw e; }
    const id = "ba_" + (++idc);
    (DB[t] = DB[t] || []).push(Object.assign({ _id: id, "Created Date": new Date().toISOString() }, payload));
    return id;
  },
  bubblePatch: async (t, id, payload) => {
    const bad = Object.keys(payload || {}).filter((k) => !KNOWN.has(k));
    if (bad.length) { const e = new Error("bubblePatch failed"); e.detail = { status: 400, body: JSON.stringify({ body: { message: "Unrecognized field: " + bad[0] } }) }; throw e; }
    const r = (DB[t] || []).find((x) => x._id === id); if (r) Object.assign(r, payload); return {};
  },
  planningAuthed: () => true,
  planningCors: () => {},
};

function mk() {
  const routes = { get: {}, post: {}, options: {} };
  const last = (a) => a[a.length - 1];
  return { app: {
    get: (p, ...a) => { routes.get[p] = last(a); },
    post: (p, ...a) => { routes.post[p] = last(a); },
    options: (p, ...a) => { routes.options[p] = last(a); },
  }, routes };
}
function call(routes, method, path, { params = {}, body = {}, query = {} } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } }; h({ params, body, query, headers: {} }, res); });
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  const s = mk(); registerBehovsanalysRoutes(s.app, deps);

  // ── SCHEMA ───────────────────────────────────────────────────────────────
  const sc = await call(s.routes, "get", "/admin/behovsanalys/schema");
  ok("schema ok + har sections", sc.body.ok && Array.isArray(sc.body.sections) && sc.body.sections.length >= 8);
  ok("schema har total_fields > 0", typeof sc.body.total_fields === "number" && sc.body.total_fields > 15);
  const allFieldIds = sc.body.sections.flatMap((x) => x.fields).map((f) => f.id);
  // ⚠️ Christian nämnde specifikt: kvm, arbetsplatser, syfte, dagar-per-vecka. Bevisa att de finns.
  ok("schema innehåller kvm-fältet",             allFieldIds.indexOf("kvm") > -1);
  ok("schema innehåller arbetsplatser",           allFieldIds.indexOf("arbetsplatser") > -1);
  ok("schema innehåller kontor_syfte (multi)",    allFieldIds.indexOf("kontor_syfte") > -1);
  ok("schema innehåller dagar_per_vecka",         allFieldIds.indexOf("dagar_per_vecka") > -1);
  ok("schema innehåller food/housekeeping/sp",    ["food","housekeeping","sp"].every((k) => allFieldIds.indexOf(k) > -1));

  // ── CREATE (från affär) ──────────────────────────────────────────────────
  const c1 = await call(s.routes, "post", "/admin/behovsanalys/create", {
    body: { clientcompany_id: "cc1", deal_id: "d1", by_user: "u1",
      data: { kvm: 350, arbetsplatser: 25, motesrum: 4,
              fastighetslage: "Hyresgäst", dagar_per_vecka: 3,
              peak_dagar: ["Tis", "Ons", "Tor"],
              kontor_syfte: ["Samarbete", "Kundmöten"],
              food: ["Frukost", "Frukt & grönt", "Fika"],
              housekeeping: ["Städ (löpande)", "Fönsterputs"],
              sp: ["Reception"],
              stad_frekvens: "3 ggr/vecka",
              nuvarande_leverantor: "ISS",
              smarta: "Kvaliteten glider, ingen kontinuitet",
              budget_typ: "Per medarbetare / månad", budget_belopp: 800,
              avtalsform: "Fast abonnemang", startdatum: "2026-11-01T00:00:00.000Z",
              beslutsfattare: "Anna A, CFO", deadline: "2026-10-01T00:00:00.000Z" },
      status: "Utkast" },
  });
  ok("create ok + id", c1.body.ok && !!c1.body.id);
  ok("create bär tillbaka normaliserat item", c1.body.item && c1.body.item.deal_id === "d1" && c1.body.item.clientcompany_id === "cc1");
  ok("create skriver writer (by_user)", c1.body.item && c1.body.item.writer_id === "u1");
  ok("create sätter status Utkast som default", c1.body.item && c1.body.item.status === "Utkast");
  ok("create sanitize: kvm är number, arbetsplatser är number", c1.body.item.data.kvm === 350 && c1.body.item.data.arbetsplatser === 25);
  ok("create sanitize: multi-fält är arrayer", Array.isArray(c1.body.item.data.food) && c1.body.item.data.food.length === 3);
  ok("create sanitize: date kapas till YYYY-MM-DD", c1.body.item.data.startdatum === "2026-11-01");
  ok("create rapporterar completeness (filled/total/pct)", c1.body.completeness && c1.body.completeness.total >= 15 && c1.body.completeness.pct > 0);

  // ── SANITIZE: okända fält droppas TYST, ogiltiga option-set-värden droppas ─
  const c2 = await call(s.routes, "post", "/admin/behovsanalys/create", {
    body: { clientcompany_id: "cc2",
      data: { kvm: 100, "hittepa_falt": "spara-inte", fastighetslage: "MarsBase",
              food: ["Frukost", "OKÄNT-VAL", "Fika"] } },
  });
  ok("sanitize: okänt fält droppat ur bloben", c2.body.item.data["hittepa_falt"] === undefined);
  ok("sanitize: ogiltigt select-värde droppat (fastighetslage)", c2.body.item.data.fastighetslage === undefined);
  ok("sanitize: ogiltigt multi-värde droppat, giltiga behållna", c2.body.item.data.food && c2.body.item.data.food.indexOf("OKÄNT-VAL") === -1 && c2.body.item.data.food.indexOf("Frukost") > -1);
  ok("sanitize: number kvar",                       c2.body.item.data.kvm === 100);

  // ── CREATE utan clientcompany_id → 400 ──
  const cBad = await call(s.routes, "post", "/admin/behovsanalys/create", { body: {} });
  ok("create utan clientcompany_id → 400", cBad.code === 400 && cBad.body.error === "clientcompany_id_krävs");

  // ── FOR-DEAL: hittar senaste, sorterat på updated_at ──
  // Skapa en till för samma deal, äldre updated_at, för att bevisa sortering
  DB.BehovsAnalys.push({ _id: "ba_old", clientcompany: "cc1", deal: "d1", data: JSON.stringify({ kvm: 999 }), updated_at: "2020-01-01T00:00:00.000Z", "Created Date": "2020-01-01" });
  const fd = await call(s.routes, "get", "/admin/behovsanalys/for-deal/:id", { params: { id: "d1" } });
  ok("for-deal ok + count 2", fd.body.ok && fd.body.count === 2);
  ok("for-deal.latest = NYASTE (kvm 350, inte 999)", fd.body.latest && fd.body.latest.data.kvm === 350);

  // ── FOR-COMPANY: hittar alla för kunden, senaste först ──
  const fc = await call(s.routes, "get", "/admin/behovsanalys/for-company/:id", { params: { id: "cc1" } });
  ok("for-company ok + count 2", fc.body.ok && fc.body.count === 2);
  ok("for-company.latest = nyaste", fc.body.latest && fc.body.latest.data.kvm === 350);
  const fcOther = await call(s.routes, "get", "/admin/behovsanalys/for-company/:id", { params: { id: "cc2" } });
  ok("for-company ger BARA denna kunds analyser", fcOther.body.items.every((x) => x.clientcompany_id === "cc2"));

  // ── PATCH: MERGE — nya nycklar vinner, oförändrade behålls ─────────────
  const baId = c1.body.id;
  const pa = await call(s.routes, "post", "/admin/behovsanalys/:id/patch", { params: { id: baId },
    body: { data: { kvm: 400, motesrum: 6 }, status: "Klar", by_user: "u2" } });
  ok("patch ok", pa.body.ok);
  ok("patch MERGE: nya nycklar skrevs (kvm 400, motesrum 6)",
     pa.body.item.data.kvm === 400 && pa.body.item.data.motesrum === 6);
  ok("patch MERGE: oförändrade nycklar BEHÖLLS (arbetsplatser 25, food-listan intakt)",
     pa.body.item.data.arbetsplatser === 25 && Array.isArray(pa.body.item.data.food) && pa.body.item.data.food.length === 3);
  ok("patch: status uppdaterat till Klar", pa.body.item.status === "Klar");
  ok("patch: writer uppdaterat till senaste redigeraren", pa.body.item.writer_id === "u2");

  // ── PATCH: 404 vid okänt id ──
  const pa404 = await call(s.routes, "post", "/admin/behovsanalys/:id/patch", { params: { id: "borta" }, body: { status: "Klar" } });
  ok("patch okänt id → 404", pa404.code === 404);

  // ── GET :id: raw + parsed data ──
  const g1 = await call(s.routes, "get", "/admin/behovsanalys/:id", { params: { id: baId } });
  ok("get :id ok + parse", g1.body.ok && g1.body.item.data.kvm === 400);

  // ── JSON parse-fel flaggas, men kraschar inte ──
  DB.BehovsAnalys.push({ _id: "ba_broken", clientcompany: "cc3", data: "{ trasig json", updated_at: "2026-09-02", "Created Date": "2026-09-02" });
  const gBroken = await call(s.routes, "get", "/admin/behovsanalys/:id", { params: { id: "ba_broken" } });
  ok("trasig JSON: parse_error:true, data:{}", gBroken.body.ok && gBroken.body.item.parse_error === true && Object.keys(gBroken.body.item.data).length === 0);

  // ── COMPLETENESS: siffran är rimlig ──
  ok("completeness: filled ≤ total", g1.body.item.completeness.filled <= g1.body.item.completeness.total);
  ok("completeness pct är 0-100",     g1.body.item.completeness.pct >= 0 && g1.body.item.completeness.pct <= 100);

  // ── UNAUTHORIZED ──
  const s2 = mk();
  registerBehovsanalysRoutes(s2.app, Object.assign({}, deps, { planningAuthed: () => false }));
  const un = await call(s2.routes, "get", "/admin/behovsanalys/schema");
  ok("planningAuthed=false → 401", un.code === 401 && un.body.error === "unauthorized");

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
