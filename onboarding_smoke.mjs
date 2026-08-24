// Smoke: onboarding-endpointen (companies_api.js).
// Kör: node onboarding_smoke.mjs
//
// ⚠️ REGEL: fixturen MÅSTE kunna uttrycka VARJE falskt-noll-scenario separat —
// annars kan testet aldrig fånga en tyst regression av typen "alla checks
// säger klart fast en Bubble-fråga föll". Fixtur-företagen:
//   cc_ok      — alla fem klara + utbildning + aktivt avtal
//   cc_noOff   — saknar Office
//   cc_noLogo  — saknar logotyp
//   cc_noUser  — saknar kund-user
//   cc_noSup   — saknar Leverantör
//   cc_noStaff — saknar Carotte-personal (User med Company=CAROTTE_COMPANY_ID)
//   cc_partial — några klara, inte utbildning, inget avtal
//
// Mutationstestat: stäng av "Utbildning" i AKT_TYPES-check, ta bort CAROTTE_COMPANY_ID,
// eller ändra `_ref(u.Company) === carotteId` till `contains` → tester faller.

import { registerCompaniesRoutes } from "./companies_api.js";

const CAROTTE = "carotte_id_9999";

// ClientCompany-fixtur (RAW-record). logotyp finns bara på de som ska klara
// logo-checken.
// ⚠️ VERIFIERAT MOT VERKLIGHETEN 2026-08-24: `logotyp` (image) ligger i det
// RÅA CC-recordet, INTE i list-projektionen (`_projectCompany` i index.js
// bär bara filter-/sorterings-fält). Buggen som skarpt data avslöjade var
// exakt det: endpointen läste `proj.logotyp` som alltid är undefined, och
// Carotte som HAR en logotyp visade "logo saknas". Fixtur speglar nu det:
// companyFullMap → projektion UTAN logotyp; bubbleGet → raw MED logotyp.
const CC = {
  cc_ok:      { _id: "cc_ok",      Name_company: "Alla klara AB",   logotyp: "//img/ok.png" },
  cc_noOff:   { _id: "cc_noOff",   Name_company: "Utan kontor AB",  logotyp: "//img/x.png" },
  cc_noLogo:  { _id: "cc_noLogo",  Name_company: "Utan logga AB",   logotyp: "" },
  cc_noUser:  { _id: "cc_noUser",  Name_company: "Utan user AB",    logotyp: "//img/x.png" },
  cc_noSup:   { _id: "cc_noSup",   Name_company: "Utan lev AB",     logotyp: "//img/x.png" },
  cc_noStaff: { _id: "cc_noStaff", Name_company: "Utan Carotte AB", logotyp: "//img/x.png" },
  cc_partial: { _id: "cc_partial", Name_company: "Halvfärdig AB",   logotyp: "" },
};
// List-projektionen (`_projectCompany` i index.js) plockar BARA sorterings-
// och filter-fält. Vi bygger den EXPLICIT här — utan logotyp — så en framtida
// regression där endpointen läser proj.logotyp fångas direkt.
function projectFromRaw(c) {
  return { id: c._id, name: c.Name_company || "", orgnr: "", kundstatus: "", bransch: "", potential: "", lojalitet: "", region: "", customer_type: "", nki: null, antal_medarbetare: null, omsattning_field: null, ansvarig_id: null, group_id: null, fastighet_ids: [], modified: null };
  // ⚠️ INGEN logotyp här — matchar produktionens _projectCompany.
}
const PROJ = new Map(Object.values(CC).map((c) => [c._id, projectFromRaw(c)]));

// Alla utom cc_noOff har ≥1 kontor.
const OFFICE = [];
for (const id of Object.keys(CC)) {
  if (id !== "cc_noOff") OFFICE.push({ _id: "off_" + id, "Kundföretag": id, "Office_title": "Kontor " + id });
}

// Kund-user = User.Company == id. cc_noUser saknar.
const CUSTOMER_USERS = [];
for (const id of Object.keys(CC)) {
  if (id !== "cc_noUser") CUSTOMER_USERS.push({ _id: "usr_" + id, "Company": id, "First Name": "Kund", "Surname": id });
}

// Carotte-users: Company == CAROTTE, kopplade till kunder via Associated_company (list).
// cc_noStaff finns INTE i någon Carotte-users Associated_company.
const CAROTTE_USERS = [
  { _id: "c1", Company: CAROTTE, "Associated_company": ["cc_ok", "cc_noOff", "cc_noLogo", "cc_noUser", "cc_noSup", "cc_partial"], "First Name": "Cilla", Surname: "Carotte" },
  // ⚠️ FÄLLA: en ANNAN Carotte-user som PEKAR PÅ cc_noStaff men vars Company
  // inte är CAROTTE (dvs matchar inte). Här sätter vi den till en sido-kund →
  // testet bevisar att endast Company==CAROTTE räknas som Carotte-personal.
  { _id: "impostor", Company: "some_client", "Associated_company": ["cc_noStaff"], "First Name": "Falsk", Surname: "Anställd" },
];

// Leverantör-Supplier: Kundföretag är en LIST. Alla utom cc_noSup är listade.
const SUPPLIERS = [
  { _id: "sup1", "Företagsnamn": "Städ AB",    "Kundföretag": ["cc_ok", "cc_noOff", "cc_noLogo", "cc_noUser", "cc_noStaff", "cc_partial"] },
];

// activitet_crm: Utbildning genomförd finns bara på cc_ok.
const AKT = [
  { _id: "akt1", company: "cc_ok",      activity_type: "Utbildning", "genomfört": true,  beskrivning: "Kick-off-utbildning", "Datum_bokning": "2026-08-01" },
  // ⚠️ FÄLLA: Utbildning MEN inte genomförd — får inte räknas
  { _id: "akt2", company: "cc_ok",      activity_type: "Utbildning", "genomfört": false, beskrivning: "Planerad" },
  // ⚠️ FÄLLA: genomförd men fel typ
  { _id: "akt3", company: "cc_partial", activity_type: "Kundmöte",   "genomfört": true,  beskrivning: "Möte" },
];

// Contract: aktivt avtal bara på cc_ok. cc_partial har utgånget → räknas inte som "avtal signat".
const CONTRACTS = [
  { _id: "ct_ok", "kundföretag": "cc_ok",     "månadskostnad": 10000, "slutdatum": null },              // aktivt
  { _id: "ct_x",  "kundföretag": "cc_partial","månadskostnad": 5000,  "slutdatum": "2020-01-01" },       // utgånget
];

// ClientGroup / Fastighet: onboardingen använder inte dem men _users(),
// _groups(), _fastigheter() anropas från meta/card. Låt dem vara tomma.
const STORE = {
  Office: OFFICE,
  User: CUSTOMER_USERS.concat(CAROTTE_USERS),
  "Leverantör - Supplier": SUPPLIERS,
  activitet_crm: AKT,
  Contract: CONTRACTS,
  ClientGroup: [],
  Fastighet: [],
};

// Constraint-matchare — samma semantik som companies_smoke (equals/contains).
// yes/no i Bubble constraintas som value:true → strikt likhet mot true.
const _cmatch = (r, cs) => (cs || []).every((c) => {
  const v = r[c.key];
  if (c.constraint_type === "contains") {
    const a = Array.isArray(v) ? v : (v == null ? [] : [v]);
    return a.map(String).includes(String(c.value));
  }
  if (c.constraint_type === "text contains") return String(v == null ? "" : v).toLowerCase().includes(String(c.value).toLowerCase());
  if (c.value === true || c.value === false) return v === c.value;   // yes/no-strikt
  return String(v == null ? "" : v) === String(c.value);
});

const findAllCalls = [];   // för att bevisa constraints går ner i Bubble
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => {
    findAllCalls.push({ t, constraints });
    const arr = STORE[t] || (t === "ClientCompany" ? Object.values(CC) : []);
    return arr.filter((r) => _cmatch(r, constraints));
  },
  bubbleFind: async (t) => STORE[t] || [],
  bubbleCount: async (t, cs = []) => (STORE[t] ? STORE[t].filter((r) => _cmatch(r, cs)).length : 0),
  bubbleGet: async (t, id) => { if (t === "ClientCompany") return CC[id] || null; return (STORE[t] || []).find((r) => r._id === id) || null; },
  bubblePatch: async () => ({}),
  bubbleCreate: async () => "newid",
  bubbleDelete: async () => ({}),
  companyFullMap: async () => PROJ,          // projektion UTAN logotyp — verklighetstroget
  companyRevenueMap: async () => new Map(),
  companyRevenueMapWarm: () => new Map(),
  companyTouchMapWarm: () => new Map(),
  companyBolagMapWarm: () => new Map(),
  companyPatchEntry: () => {},
  companyForget: () => {},
  appBaseUrl: "https://mira-fm.com",
  pwResetTemplateId: "tpl", welcomeTemplateId: "tpl",
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  TENGELLA_CONNECTION_ID: "",
  CAROTTE_COMPANY_ID: CAROTTE,
};

function mk() {
  const routes = { get: {}, post: {}, patch: {}, delete: {}, options: {} };
  const last = (a) => a[a.length - 1];
  return { app: { get: (p, ...a) => { routes.get[p] = last(a); }, post: (p, ...a) => { routes.post[p] = last(a); }, patch: (p, ...a) => { routes.patch[p] = last(a); }, delete: (p, ...a) => { routes.delete[p] = last(a); }, options: (p, ...a) => { routes.options[p] = last(a); } }, routes };
}
function call(routes, method, path, { params = {} } = {}) {
  const h = routes[method][path];
  if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }; h({ params, query: {}, body: {}, headers: {} }, res); });
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  const s = mk();
  registerCompaniesRoutes(s.app, deps);

  // ── ALLA GRÖNA (cc_ok) ──
  const r = await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_ok" } });
  ok("onboarding cc_ok: 200 + ok:true", r.code === 200 && r.body.ok === true);
  ok("cc_ok: mira 5/5 klar",           r.body.mira.done_count === 5 && r.body.mira.total_count === 5 && r.body.mira.ready === true);
  ok("cc_ok: uncertain=false",         r.body.mira.uncertain === false);
  const byId = Object.fromEntries((r.body.mira.checks || []).map((c) => [c.id, c]));
  ok("cc_ok: office done + count>=1",  byId.office.done === true && byId.office.count >= 1);
  ok("cc_ok: logo done",               byId.logo.done === true);
  ok("cc_ok: user done + count>=1",    byId.user.done === true && byId.user.count >= 1);
  ok("cc_ok: supplier done",           byId.supplier.done === true && byId.supplier.count >= 1);
  ok("cc_ok: staff done + count>=1",   byId.staff.done === true && byId.staff.count >= 1);
  ok("cc_ok: steps.avtal.done (aktivt Contract finns)",       r.body.steps.avtal.done === true);
  ok("cc_ok: steps.utbildning.done (Utbildning genomförd=1)", r.body.steps.utbildning.done === true && r.body.steps.utbildning.count === 1);
  ok("cc_ok: steps.mira.done=true",    r.body.steps.mira.done === true);
  ok("cc_ok: mock-steg utpekade (kickoff/leverans)",           r.body.steps.kickoff.mock === true && r.body.steps.leverans.mock === true);
  ok("cc_ok: meta.carotte_company_id_set=true", r.body.meta.carotte_company_id_set === true);

  // ── SAKNADE DELKRAV (mutationstestbara) ──
  const noOff   = (await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_noOff"   } })).body;
  ok("cc_noOff: office done=false + count=0", noOff.mira.checks.find((c) => c.id === "office").done === false && noOff.mira.checks.find((c) => c.id === "office").count === 0);
  ok("cc_noOff: mira ready=false",             noOff.mira.ready === false);

  const noLogo  = (await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_noLogo"  } })).body;
  ok("cc_noLogo: logo done=false",            noLogo.mira.checks.find((c) => c.id === "logo").done === false);

  const noUser  = (await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_noUser"  } })).body;
  ok("cc_noUser: user done=false + count=0",  noUser.mira.checks.find((c) => c.id === "user").done === false && noUser.mira.checks.find((c) => c.id === "user").count === 0);

  const noSup   = (await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_noSup"   } })).body;
  ok("cc_noSup: supplier done=false + count=0", noSup.mira.checks.find((c) => c.id === "supplier").done === false && noSup.mira.checks.find((c) => c.id === "supplier").count === 0);

  const noStaff = (await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_noStaff" } })).body;
  ok("cc_noStaff: staff done=false + count=0", noStaff.mira.checks.find((c) => c.id === "staff").done === false && noStaff.mira.checks.find((c) => c.id === "staff").count === 0);
  // ⚠️ HELA POÄNGEN: en User som PEKAR på cc_noStaff men vars Company inte är CAROTTE
  // får INTE räknas. Om filtreringen tas bort blir count=1 → detta assertion faller.
  ok("cc_noStaff: impostor med fel Company räknas INTE", noStaff.mira.checks.find((c) => c.id === "staff").count === 0);

  // ── PARTIAL: utbildning missing, avtal utgånget ──
  const part = (await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_partial" } })).body;
  ok("cc_partial: utbildning.done=false (fel typ på akt3)",    part.steps.utbildning.done === false && part.steps.utbildning.count === 0);
  ok("cc_partial: avtal.done=false (utgånget slutdatum)",      part.steps.avtal.done === false);
  ok("cc_partial: logo saknas → mira.ready=false",             part.mira.ready === false);

  // ── SAKNAT FÖRETAG → 404 ──
  const missing = await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_borta" } });
  ok("okänt företag → 404 company_not_found", missing.code === 404 && missing.body.error === "company_not_found");

  // ── UTAN CAROTTE_COMPANY_ID → staff-check kan inte köras (ok:false, aldrig tyst 0) ──
  const s2 = mk();
  registerCompaniesRoutes(s2.app, Object.assign({}, deps, { CAROTTE_COMPANY_ID: "" }));
  const noCarotte = (await call(s2.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_ok" } })).body;
  const staffCheck = noCarotte.mira.checks.find((c) => c.id === "staff");
  ok("utan CAROTTE_COMPANY_ID: staff.ok=false + done=false", staffCheck.ok === false && staffCheck.done === false);
  ok("utan CAROTTE_COMPANY_ID: meta flaggar det",             noCarotte.meta.carotte_company_id_set === false);
  ok("utan CAROTTE_COMPANY_ID: mira.uncertain=true",          noCarotte.mira.uncertain === true);
  ok("utan CAROTTE_COMPANY_ID: mira.ready=false",             noCarotte.mira.ready === false);

  // ── BUBBLE-FEL PÅ EN CHECK → egen check bär ok:false, resten fortsätter ──
  const s3 = mk();
  const failDeps = Object.assign({}, deps, {
    bubbleFindAll: async (t, o) => {
      // Låt Office-frågan braka men släpp resten igenom
      if (t === "Office") throw new Error("Bubble 500");
      return deps.bubbleFindAll(t, o);
    },
  });
  registerCompaniesRoutes(s3.app, failDeps);
  const withFail = (await call(s3.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_ok" } })).body;
  const officeCheck = withFail.mira.checks.find((c) => c.id === "office");
  ok("Bubble-fel på Office: office.ok=false + done=false + count=null", officeCheck.ok === false && officeCheck.done === false && officeCheck.count === null);
  ok("Bubble-fel: övriga checks fortsätter (logo klar)",                 withFail.mira.checks.find((c) => c.id === "logo").done === true);
  ok("Bubble-fel: mira.uncertain=true",                                   withFail.mira.uncertain === true);

  // ── CONSTRAINTS GÅR NER I BUBBLE (WU: rätt filter = billiga queries) ──
  findAllCalls.length = 0;
  await call(s.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc_ok" } });
  const officeQ  = findAllCalls.find((c) => c.t === "Office");
  const custUsrQ = findAllCalls.find((c) => c.t === "User" && c.constraints.some((k) => k.key === "Company"));
  const staffQ   = findAllCalls.find((c) => c.t === "User" && c.constraints.some((k) => k.key === "Associated_company"));
  const trainQ   = findAllCalls.find((c) => c.t === "activitet_crm");
  ok("Office-frågan constraintad på Kundföretag=id",
     !!officeQ && officeQ.constraints.some((k) => k.key === "Kundföretag" && k.constraint_type === "equals" && k.value === "cc_ok"));
  ok("Kund-user-frågan constraintad på Company=id (singular, inte Associated_company)",
     !!custUsrQ && custUsrQ.constraints.some((k) => k.key === "Company" && k.constraint_type === "equals" && k.value === "cc_ok"));
  ok("Staff-frågan constraintad på Associated_company contains id",
     !!staffQ && staffQ.constraints.some((k) => k.key === "Associated_company" && k.constraint_type === "contains" && k.value === "cc_ok"));
  ok("Utbildning-frågan constraintad på company + activity_type=Utbildning + genomfört=true",
     !!trainQ &&
     trainQ.constraints.some((k) => k.key === "company"       && k.value === "cc_ok") &&
     trainQ.constraints.some((k) => k.key === "activity_type" && k.value === "Utbildning") &&
     trainQ.constraints.some((k) => k.key === "genomfört"     && k.value === true));

  // ── AKT_TYPES har "Utbildning" (så create-flödet accepterar värdet) ──
  const src = (await import("node:fs")).readFileSync("./companies_api.js", "utf8");
  ok("AKT_TYPES innehåller 'Utbildning'", /const\s+AKT_TYPES\s*=\s*\[[^\]]*"Utbildning"/.test(src));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
