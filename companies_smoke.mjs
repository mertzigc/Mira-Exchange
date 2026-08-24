// Smoke: företagslista (companies_api.js). Mockad Bubble + injicerade delade cachar.
//   node companies_smoke.mjs
import { registerCompaniesRoutes } from "./companies_api.js";
import { readFileSync } from "node:fs";

// ── Rå ClientCompany-DB (för bubbleGet/patch + re-projektion i companyPatchEntry) ──
const CC = {
  cc1: { _id: "cc1", "Modified Date": "2026-08-01T09:00:00.000Z", Name_company: "Acme AB",   Org_Number: "556000-1111", Kundstatus: "Aktiv kund", Bransch: "IT", Potential: "A-kund", Lojalitet: "3", Region: "Stockholm", customer_type: "Direkt", NKI_carotte: 8, antal_medarbetare: 40, "omsättning": 5000, Kundansvarig: "u1", group: "g1", Fastighet: ["f1", "f2"], Email: "info@acme.se", Telefon: 733716298, hemsida_crm: "acme.se", kundinfo_crm: "Bra kund", Fakturainfo: "Ref 42", "Grundat_år": "1999-01-01", Adress: { address: "Storgatan 1, Stockholm" }, logotyp: "//img/acme.png" },
  cc2: { _id: "cc2", "Modified Date": "2026-08-10T09:00:00.000Z", Name_company: "Beta Bygg",  Org_Number: "556000-2222", Kundstatus: "Prospekt",   Bransch: "Bygg", Potential: "B-kund", Lojalitet: "2", Region: "Göteborg", customer_type: "", NKI_carotte: null, antal_medarbetare: 10, "omsättning": null, Kundansvarig: "u2", group: null, Fastighet: ["f1"] },
  cc3: { _id: "cc3", "Modified Date": "2026-06-01T09:00:00.000Z", Name_company: "Zeta Zoo",   Org_Number: "556000-3333", Kundstatus: "",          Bransch: "", Potential: "", Lojalitet: "", Region: "", customer_type: "", NKI_carotte: null, antal_medarbetare: null, "omsättning": null, Kundansvarig: null, group: null, Fastighet: [] },
};
// "Senast ändrad" — relaterade typers senaste rörelse per företag (index.js
// sharedCompanyTouchMapWarm). cc1: aktivitet NYARE än egen Modified Date;
// cc2: lead ÄLDRE än egen → grunddata vinner; cc3: ingen relaterad rörelse.
const TOUCH = new Map([
  ["cc1", { ts: Date.parse("2026-08-15T12:00:00.000Z"), src: "aktivitet" }],
  ["cc2", { ts: Date.parse("2026-07-01T12:00:00.000Z"), src: "lead" }],
]);
const REV = new Map([["cc1", { 2025: 146750, 2026: 40992 }], ["cc2", { 2026: 7600 }]]);
// ⚠️ Todo-schemat är VERIFIERAT (skärmdump 2026-08-07, [[reference-bubble-todo-fields]]):
// Titel · Starttid/Sluttid(date) · Status(status_reminder-OS) · Företag(ClientCompany).
// Fixturer som hittar på fältnamn testar en påhittad värld — se Fastighet-buggen.
const _dagar = (n) => new Date(Date.now() + n * 86400000).toISOString();
const AUX = {
  Todo: [
    { _id: "td1", Titel: "Ring Sarah",      Företag: "cc1", Sluttid: _dagar(7),   Status: "Pågående" },
    { _id: "td2", Titel: "Gammal punkt",    Företag: "cc1", Sluttid: _dagar(-30), Status: "Pågående" },   // förfluten → ej levande
    { _id: "td3", Titel: "Redan klar",      Företag: "cc1", Sluttid: _dagar(14),  Status: "Avslutad" },   // framtid MEN avslutad
    { _id: "td4", Titel: "Startar snart",   Företag: "cc2", Starttid: _dagar(3),  Status: "Planerad" },
  ],
  ClientGroup: [{ _id: "g1", name: "Acme-koncernen" }],
  // ⚠️ VERKLIGT Fastighet-schema (Bubble-editorn 2026-08-21): namnet ligger i `Titel`,
  // och `Adress` är ett geographic address-OBJEKT. Fixturen sa tidigare `Namn` — ett
  // fält som inte finns — och var därmed mer förlåtande än verkligheten. Precis den
  // sortens mock som lät "[object Object]" nå produktion.
  // f3 har ingen Titel → ska falla tillbaka på adresstexten, inte på objektet.
  Fastighet: [
    { _id: "f1", Titel: "Kungsgatan 1", Adress: { address: "Kungsgatan 1, Stockholm" } },
    { _id: "f2", Titel: "Vasagatan 5",  Adress: { address: "Vasagatan 5, Stockholm" } },
    { _id: "f3", Adress: { address: "Drottninggatan 9, Göteborg" } },
    { _id: "f4" },
  ],
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
  // l1 = redan kopplad till affär (kortet ska visa "✓ Affär"), l2 = okopplad (får skapa-knapp)
  Lead: [{ _id: "l1", client_company: "cc1", Name: "Lead X", estimated_service_cost_monthly: 92880, status: "Ny", "Created Date": "2026-06-22", deal: "d1" },
         { _id: "l2", client_company: "cc1", Name: "Lead Y", estimated_service_cost_monthly: 5000, status: "Ny", "Created Date": "2026-06-21" }],
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
    { _id: "act2", company: "cc1", taggade_personer: ["co1", "co2"], "Datum_bokning": "2026-06-20", activity_type: "Samtal", beskrivning: "Uppföljning", "Created Date": "2026-06-20", deal: "d1" },
    { _id: "act3", company: "cc2", taggade_personer: ["co2"], "Datum_bokning": "2026-07-01", activity_type: "Mail", "Created Date": "2026-07-01" },
    { _id: "act4", company: "cc1", activity_type: "Kommentar", beskrivning: "Kommentar", "Datum_bokning": "2026-01-05", "Created Date": "2026-01-05" },
    { _id: "act5", company: "cc1", activity_type: "Möte", beskrivning: "Möte", "Datum_bokning": "2026-01-04", "Created Date": "2026-01-04" },
    // Levande-fall: framtida datum, EJ genomförd (cc2). Och en fälla: framtida
    // datum men redan genomförd (cc1) → ska INTE räknas som levande.
    { _id: "act6", company: "cc2", activity_type: "Kundmöte", "Kundmöte": "Fas 1", beskrivning: "Uppstart", "Datum_bokning": _dagar(10), "Created Date": "2026-08-21" },
    { _id: "act7", company: "cc3", activity_type: "Kundmöte", beskrivning: "Redan avbockat", "Datum_bokning": _dagar(20), "genomfört": true, "Created Date": "2026-08-21" },
  ],
};
// User i STORE (behövs för bubbleGet/patch i personal-koppling); u1 kopplad till cc1 via Associated_company
STORE.User = [
  { _id: "u1", "First Name": "Anna", "Surname": "Andersson", email: "christian.mertzig@gmail.com", Company: "cc1", "Associated_company": ["cc1"], User_role: "Ansvarig" },
  { _id: "u2", "First Name": "Bo", "Surname": "Berg", email: "bo@x.se", Company: "cc2", User_role: { display: "Medarbetare" } },   // objekt-form: option-set kan komma som {display}
  // ⚠️ "Vår personal" ska bara visa CAROTTARE. Fixturen måste därför innehålla båda
  // sorterna som är kopplade till cc1: u1 är KUNDENS egen user (Company cc1) och
  // ska filtreras bort, u3 är Carottaren (Company cc2 = inloggad users company).
  // Utan u3 testade vi en värld där skillnaden inte fanns.
  { _id: "u3", "First Name": "Cilla", "Surname": "Carotte", email: "cilla@carotte.se", Company: "cc2", "Associated_company": ["cc1"], User_role: "Ansvarig" },
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
  { _id: "mt1", "Kundföretag": "cc1", Rubrik: "Kaffemaskin trasig", Beskrivning: "Fungerar ej", Kontor: "of2", Referens: "u1", "Created Date": "2026-08-10", Prioritet: "3 - brådskande", status: "Pågående", Avvikelse: false, "Team åtgärd intern": ["co1"], "Tråd": ["Christian Mertzig, Carotte Group, 260810,09:15: tittar på det", "26/07/22, 15:21:35 / Biljana Nikolic: Jag fixar imorgon"], Feedback: "" },
  { _id: "mt2", "Kundföretag": "cc1", Rubrik: "Avfallshantering", Beskrivning: "Glas", Kontor: "of2", "Created Date": "2026-07-20", Prioritet: "2", status: "Avslutat", Avvikelse: false },
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
    modified: c["Modified Date"] || c["Created Date"] || null,
  };
}
const FULL = new Map(Object.values(CC).map((c) => [c._id, project(c)]));
// ── Våra bolag (companyId → {bolag: senaste fakturadatum ms}). Byggs i index.js ur
// faktura-svepet; här injiceras den färdig. Fönstret (12 mån) läggs på i companies_api.
const _dago = (n) => Date.now() - n * 86400000;
const BOLAG = new Map([
  ["cc1", { "Staff": _dago(10), "Food & Event": _dago(40), "Group": _dago(5) }],
  ["cc2", { "Housekeeping": _dago(700) }],          // fakturerade FÖRR, inte nu
]);                                                  // cc3 saknas helt = ingen fakturering

// Verifierade Bubble-scheman (skärmdump/HANDOFF). Används av mocken för att avvisa
// okända fält precis som Bubble gör. Utöka när fler typer verifierats.
let userPatches = 0;
const KNOWN_FIELDS = {
  PasswordReset: ["email", "coworker", "token_hash", "expires_at", "used"],
};
const fetchedTypes = [];
const findAllCalls = [];   // {t, constraints} — för att bevisa att filter går NER i Bubble
const getCalls = [];       // {t, id} — för att mäta N+1 (kontorsnamn per rad)
const createUserCalls = [];
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => {
    fetchedTypes.push(t);
    findAllCalls.push({ t, constraints });
    const arr = STORE[t] || AUX[t] || (t === "ClientCompany" ? Object.values(CC) : []);
    return arr.filter((r) => _cmatch(r, constraints));
  },
  bubbleFind: async (t) => { fetchedTypes.push(t); return STORE[t] || AUX[t] || []; },
  bubbleCount: async (t, cs = []) => (STORE[t] ? STORE[t].filter((r) => _cmatch(r, cs)).length : 0),
  bubbleGet: async (t, id) => { getCalls.push({ t, id }); if (t === "ClientCompany") return CC[id] || null; if (STORE[t]) return STORE[t].find((r) => r._id === id) || null; return null; },
  // ⚠️ Bubble avvisar HELA patchen om ETT fält är okänt ("Unrecognized field: x") —
  // mocken gjorde tidigare Object.assign rakt av och var alltså mer tillåtande än
  // verkligheten. Det dolde att exchange patchade `used_at` (finns inte på
  // PasswordReset) → `used` sattes aldrig → token brändes aldrig, live. (2026-08-18)
  // Typer med känt schema valideras därför här; övriga är fortsatt fria.
  bubblePatch: async (t, id, payload) => {
    const known = KNOWN_FIELDS[t];
    if (known) {
      const bad = Object.keys(payload || {}).filter((k) => known.indexOf(k) < 0);
      if (bad.length) { const e = new Error("bubblePatch failed"); e.detail = { status: 400, body: JSON.stringify({ body: { status: "ERROR", message: "Unrecognized field: " + bad[0] } }) }; throw e; }
    }
    if (t === "User") userPatches++;   // för att kunna bevisa att vi inte skriver i onödan
    if (t === "ClientCompany" && CC[id]) { Object.assign(CC[id], payload); return {}; }
    if (STORE[t]) { const r = STORE[t].find((x) => x._id === id); if (r) Object.assign(r, payload); }
    return {};
  },
  // ⚠️ ClientCompany läses ur `CC` (av bubbleGet OCH av FULL/project). Skrev create
  // bara till STORE blev en nyskapad rad osynlig för läs-tillbaka och cache-insert —
  // mocken var alltså inkonsekvent med sig själv och dolde att flödet inte fungerade.
  bubbleCreate: async (t, payload) => {
    // ⚠️ MOCKA ALDRIG MER TILLÅTANDE ÄN BUBBLE. Den här mocken svalde vad som helst,
    // och därför gick `Org_Number: Number(...)` rakt igenom testet men 400:ade skarpt
    // ("Expected a string, but got a number"). Samma klass som used_at-buggen.
    // Typerna nedan är VERIFIERADE (index.js ~1291: Org_Number är text).
    const TYPES = { ClientCompany: { Org_Number: "string", Name_company: "string" } };
    const spec = TYPES[t];
    if (spec) {
      for (const [f, want] of Object.entries(spec)) {
        if (payload[f] === undefined || payload[f] === null) continue;
        if (typeof payload[f] !== want) {
          const e = new Error("bubbleCreate failed");
          e.detail = { status: 400, body: JSON.stringify({ body: { status: "INVALID_DATA", message: "Invalid data for field " + f + ": Expected a " + want + ", but got a " + typeof payload[f] } }) };
          throw e;
        }
      }
    }
    const id = "new_" + (++_idc); const rec = Object.assign({ _id: id }, payload);
    if (t === "ClientCompany") CC[id] = rec; else (STORE[t] = STORE[t] || []).push(rec);
    return id;
  },
  bubbleDelete: async (t, id) => { if (STORE[t]) { const i = STORE[t].findIndex((r) => r._id === id); if (i >= 0) STORE[t].splice(i, 1); } return {}; },
  bubbleUploadFile: async ({ filename }) => "//files/" + filename,   // fejkad Bubble file storage
  // photoUpload utelämnas → _photoMw blir passthrough; testet sätter req.file direkt.
  companyFullMap: async () => FULL,
  companyRevenueMap: async () => REV,
  companyRevenueMapWarm: () => REV,
  companyTouchMapWarm: () => TOUCH,
  companyBolagMapWarm: () => BOLAG,
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
  // ⚠️ Saknad route får INTE kasta. Vid mutationstest (gammal kod utan den nya
  // endpointen) dog hela sviten på första anropet och dolde alla följande fel —
  // samma klass av tyst missvisning som en assertion som kraschar i st.f. att falla.
  // Nu svarar den 404 så testet FALLER begripligt.
  const h = routes[method][path];
  if (!h) return Promise.resolve({ code: 404, body: { ok: false, error: "no_route", route: method + " " + path } });
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
  ok("meta users 3 st sorterade", meta.body.users.length === 3 && meta.body.users[0].name === "Anna Andersson");
  ok("meta groups 1 st", meta.body.groups.length === 1 && meta.body.groups[0].name === "Acme-koncernen");
  // 3 av 4: f4 saknar både Titel och Adress → utelämnas (och loggas).
  ok("meta fastigheter 3 namngivna av 4", meta.body.fastigheter.length === 3);
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

  // ── SORT: senast ändrad (grunddata + relaterade typer) 2026-08-17 ──
  const sM = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "modified" } });
  ok("sort modified utan dir → desc (nyast först): cc1, cc2, cc3",
    sM.body.rows.map((r) => r.id).join(",") === "cc1,cc2,cc3");
  ok("modified = MAX(egen, relaterad) + källa när relaterad vinner",
    sM.body.rows[0].modified_src === "aktivitet" && /^2026-08-15/.test(sM.body.rows[0].modified));
  ok("egen Modified Date vinner → källa 'grunddata'",
    sM.body.rows[1].modified_src === "grunddata" && /^2026-08-10/.test(sM.body.rows[1].modified));
  ok("företag utan relaterad rörelse faller tillbaka på egen tid",
    sM.body.rows[2].id === "cc3" && sM.body.rows[2].modified_src === "grunddata" && /^2026-06-01/.test(sM.body.rows[2].modified));
  ok("list bär touch_ready=true när cachen är varm", sM.body.touch_ready === true);
  const sMa = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "modified", dir: "asc" } });
  ok("explicit dir=asc vänder → äldst först", sMa.body.rows.map((r) => r.id).join(",") === "cc3,cc2,cc1");
  // Sorteringen ska gälla OAVSETT filter (den körs efter filtreringen)
  const sMf = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "modified", fastighet: "f1" } });
  ok("sort modified + filter fastighet=f1 → 2 rader, nyast först",
    sMf.body.total === 2 && sMf.body.rows.map((r) => r.id).join(",") === "cc1,cc2");
  const sMfa = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "modified", dir: "asc", fastighet: "f1" } });
  ok("samma filter + asc → omvänd ordning", sMfa.body.rows.map((r) => r.id).join(",") === "cc2,cc1");
  // Kall touch-cache: touch_ready=false och bara grunddata-datum
  var coldTouch = Object.assign({}, deps, { companyTouchMapWarm: function () { return null; } });
  var ts2 = mk(); registerCompaniesRoutes(ts2.app, coldTouch);
  var lt = await call(ts2.routes, "get", "/admin/companies/list", { query: { sort: "modified" } });
  ok("kall touch-cache → touch_ready=false + grunddata-ordning (cc2 nyast)",
    lt.body.touch_ready === false && lt.body.rows.map((r) => r.id).join(",") === "cc2,cc1,cc3" &&
    lt.body.rows[0].modified_src === "grunddata");

  // ── DÖTT FÖRETAGS-ID: cachen ligger före verkligheten (2026-08-17) ─────────
  // Delta-refreshen ser inte raderingar → ett företag raderat i Bubble finns kvar
  // i companyFullMap upp till 12 h. Kortet ska då 404:a och GLÖMMA id:t, inte
  // rendera ett tomt skal (och inte låta referens-queries braka mot Bubble-400).
  var forgotten = [];
  var ghostFull = new Map(FULL);
  ghostFull.set("ccGhost", { id: "ccGhost", name: "Raderat AB", orgnr: "", kundstatus: "", bransch: "", potential: "", lojalitet: "", region: "", customer_type: "", nki: null, antal_medarbetare: null, omsattning_field: null, ansvarig_id: null, group_id: null, fastighet_ids: [], modified: "2026-08-17T09:00:00.000Z" });
  var ghostDeps = Object.assign({}, deps, {
    companyFullMap: async () => ghostFull,
    companyForget: function (id) { forgotten.push(id); ghostFull.delete(id); return true; },
  });
  var gs = mk(); registerCompaniesRoutes(gs.app, ghostDeps);
  var gcard = await call(gs.routes, "get", "/admin/companies/:id/card", { params: { id: "ccGhost" } });
  ok("dött id → 404 company_not_found + stale_cache", gcard.code === 404 && gcard.body.error === "company_not_found" && gcard.body.stale_cache === true);
  ok("dött id glöms ur delade cachen", forgotten.indexOf("ccGhost") > -1 && !ghostFull.has("ccGhost"));
  var gcard2 = await call(gs.routes, "get", "/admin/companies/:id/card", { params: { id: "ccGhost" } });
  ok("efter evictering → 404 direkt ur cachen (ingen ny Bubble-slagning)", gcard2.code === 404);
  // Ett LEVANDE företag ska fortfarande ge kort
  var glive = await call(gs.routes, "get", "/admin/companies/:id/card", { params: { id: "cc1" } });
  ok("levande företag opåverkat av evicterings-kontrollen", glive.body.ok === true && glive.body.company.name === "Acme AB");

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
  ok("card counts leads/offerter/ordrar/fakturor", card.body.counts.leads === 2 && card.body.counts.offerter === 2 && card.body.counts.ordrar === 2 && card.body.counts.fakturor === 2);
  ok("card counts personer=2", card.body.counts.personer === 2);
  ok("card counts drift = öppna ärenden (Pågående) = 2", card.body.counts.drift === 2);

  // ── CHAIN: reverse-lookup per flik ──
  var chD = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "deals" } });
  ok("chain deals → 1 (Deal/mira, status Avtal→ok)", chD.body.ok && chD.body.count === 1 && chD.body.rows[0].type === "Deal" && chD.body.rows[0].status_cls === "ok" && chD.body.rows[0].amount === 5000);
  var chL = await call(s.routes, "get", "/admin/companies/:id/chain", { params: { id: "cc1" }, query: { type: "leads" } });
  ok("chain leads → 2 (nyast först)", chL.body.count === 2 && chL.body.rows[0].title === "Lead X" && chL.body.rows[0].amount === 92880);
  // ── deal_id på källrader: styr om kortet visar "✓ Affär" eller skapa-knappen (2026-08-18) ──
  ok("lead med befintlig affär bär deal_id", chL.body.rows[0].deal_id === "d1");
  ok("okopplat lead har deal_id null (→ skapa-knapp)", chL.body.rows[1].title === "Lead Y" && chL.body.rows[1].deal_id === null);
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
  ok("aktivitet med affär bär deal_id (→ \"Kopplad\" i kortet)", chH.body.rows.filter(function(r){return r.id==="act2";})[0].deal_id === "d1");
  ok("okopplad aktivitet har deal_id null (→ skapa-knapp)", chH.body.rows[0].id === "act1" && chH.body.rows[0].deal_id === null);
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
  var ca = await call(s.routes, "post", "/admin/companies/coworker/:id/create-account", { params: { id: "co2" }, body: { role: "Ansvarig" } });
  // Rollerna HÄRLEDS ur User-datan (som _matterStatuses) — inget hårdkodat option-set.
  var cwRoles = await call(s.routes, "get", "/admin/companies/:id/coworkers", { params: { id: "cc1" } });
  ok("coworkers bär roles härledda ur datan, sorterade", JSON.stringify(cwRoles.body.roles || null) === JSON.stringify(["Ansvarig", "Medarbetare"]));
  ok("option-set som objekt ({display}) läses också", (cwRoles.body.roles || []).indexOf("Medarbetare") > -1);
  ok("create-account ok (user_id + mail)", ca.body.ok && ca.body.user_id === "newuser1" && ca.body.mail === true);
  ok("create-account anropade Bubble-wf med email+firstname/surname+company+coworker", createUserCalls.length === 1 && createUserCalls[0].email === "rena@acme.se" && createUserCalls[0].firstname === "Rena" && createUserCalls[0].surname === "Kontakt" && createUserCalls[0].company === "cc1" && createUserCalls[0].coworker_id === "co2");
  // ── User_role (2026-08-18): utan roll kastar dashboard_crm ut användaren till /index ──
  ok("create-account skickar role till Bubble-wf", (createUserCalls[0] || {}).role === "Ansvarig" && ca.body.role === "Ansvarig");
  ok("create-account skickade VÄLKOMST-mailet", STORE.emailqueue.length === 1 && STORE.emailqueue[0].template_id === "tpl_welcome" && STORE.emailqueue[0].to_email === "rena@acme.se");
  var caNoRole = await call(s.routes, "post", "/admin/companies/coworker/:id/create-account", { params: { id: "co2" } });
  ok("utan role skickas tom sträng (wf:en kan defaulta) + role:null i svaret", caNoRole.body.ok && (createUserCalls[1] || {}).role === "" && caNoRole.body.role === null);
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
  // ⚠️ genomfort:true kräver nu ett nästa steg (grinden 2026-08-21) — utan det 400:ar den.
  var hc = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "Nytt möte", fas: "Fas 3", motesdatum: "2026-08-20", genomfort: true, motesanteckning: "Genomgång", nasta_steg: "avslutat" } });
  ok("historik/create ok + rad skapad", hc.body.ok && STORE.activitet_crm.length === abefore + 1 && hc.body.row && hc.body.row.typ === "Kundmöte");
  var newAkt = STORE.activitet_crm[STORE.activitet_crm.length - 1];
  ok("ny aktivitet: company=cc1 + Kundmöte-fält (display-nycklar)", newAkt.company === "cc1" && newAkt.clientcompany === undefined && newAkt.activity_type === "Kundmöte" && newAkt["Kundmöte"] === "Fas 3" && newAkt["genomfört"] === true && newAkt["mötesantecking"] === "Genomgång" && /^2026-08-20/.test(newAkt["Datum_bokning"]));
  var hcTom = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: {} });
  ok("historik/create tom → 400", hcTom.code === 400 && hcTom.body.error === "tom_aktivitet");
  // ── ÄGARSKAP: by_user → writer (2026-08-17) ────────────────────────────────
  // Utan writer saknar aktiviteten ansvarig i mötestratten (salj_api: writer||Created By);
  // "Created By" blir API-nyckelns user via Data API och duger inte som ägare.
  var hcW = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Säljsamtal", beskrivning: "Ringde Hugo", by_user: "u2" } });
  var newW = STORE.activitet_crm[STORE.activitet_crm.length - 1];
  ok("historik/create sätter writer från by_user", hcW.body.ok && newW.writer === "u2");
  ok("historik/create: writer resolvas till ansvarig i svaret", hcW.body.row && hcW.body.row.ansvarig === "Bo Berg");
  var hcNoW = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kommentar", beskrivning: "Utan användare" } });
  ok("historik/create utan by_user → ingen tom writer skrivs", hcNoW.body.ok && !("writer" in STORE.activitet_crm[STORE.activitet_crm.length - 1]));
  // patch får INTE flytta ägarskapet
  var wOwner = STORE.activitet_crm.filter(function (r) { return r._id === hcW.body.id; })[0];
  await call(s.routes, "post", "/admin/companies/historik/:id/patch", { params: { id: hcW.body.id }, body: { beskrivning: "Redigerad av annan", by_user: "u1" } });
  ok("historik/patch flyttar INTE writer", wOwner.writer === "u2" && wOwner["beskrivning"] === "Redigerad av annan");
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
  ok("offices → 2 (cc1), sorterade + dropdown-data", of.body.ok && of.body.count === 2 && of.body.fastigheter.length === 3 && of.body.coworkers.length >= 2);
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
  // ⚠️ u1 är kundens EGEN user (Company cc1) och är kopplad till cc1 — den fick
  // tidigare stå i "Vår personal". Nu visas bara u3 (Company == user_company).
  ok("leverantörer: bara CAROTTARE i personallistan (kundens egen user filtreras bort)",
     lev.body.personnel.length === 1 && lev.body.personnel[0].id === "u3" &&
     !lev.body.personnel.some(function(x){ return x.id === "u1"; }));
  ok("leverantörer: poolen är Company==user_company minus redan kopplade",
     lev.body.personnel_available.length === 1 && lev.body.personnel_available[0].id === "u2");
  ok("leverantörer: personal_ok true när frågorna gick igenom", lev.body.personnel_ok === true && lev.body.personnel_unfiltered === false);
  // ⚠️ Utan user_company går Carottare inte att skilja från kundens folk → filtrera
  // inte, men säg det. Tyst fel filter vore värre än en synlig varning.
  var levNo = await call(s.routes, "get", "/admin/companies/:id/leverantorer", { params: { id: "cc1" } });
  ok("leverantörer: utan user_company filtreras inget bort MEN flaggan sätts",
     levNo.body.personnel.length === 2 && levNo.body.personnel_unfiltered === true);
  // ⚠️ Fallen fråga får aldrig läsas som "ingen personal kopplad".
  var pFailDeps = Object.assign({}, deps, {
    bubbleFindAll: async (t, o) => {
      if (t === "User" && o && (o.constraints || []).some(function(c){ return c.key === "Associated_company"; })) throw new Error("Bubble 500");
      return deps.bubbleFindAll(t, o);
    },
  });
  var pfs = mk(); registerCompaniesRoutes(pfs.app, pFailDeps);
  var pf = await call(pfs.routes, "get", "/admin/companies/:id/leverantorer", { params: { id: "cc1" }, query: { user_company: "cc2" } });
  ok("leverantörer: fallen personal-fråga → personnel_ok:false (inte tom lista som svar)",
     pf.body.ok === true && pf.body.personnel_ok === false && pf.body.personnel.length === 0);
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
  ok("matter detalj: team_intern (co1) + tråd + beskrivning", mdet.body.ok && mdet.body.matter.team_intern.length === 1 && mdet.body.matter.team_intern[0] === "Testare Testsson" && mdet.body.matter.trad.length === 2 && mdet.body.matter.beskrivning === "Fungerar ej");
  ok("matter detalj: tråd-datum tvättat båda formaten + status_options ur datan", mdet.body.matter.trad[0].indexOf("10 aug 2026 · 09:15") > -1 && mdet.body.matter.trad[0].indexOf("260810") === -1 && mdet.body.matter.trad[1] === "Biljana Nikolic · 22 jul 2026 · 15:21: Jag fixar imorgon" && mdet.body.matter.status_options.indexOf("Pågående") > -1 && mdet.body.matter.status_options.indexOf("Avslutat") > -1);
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
  ok("drift closed → 1 (mt2 Avslutat)", dClosed.body.total === 1 && dClosed.body.rows[0].id === "mt2");
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

  // ── DRIFT-lista: paginering / facet / N+1 på kontorsnamn (WU-fix 2026-08-17) ──
  // 90 bulk-ärenden på cc3 (Zeta Zoo), VARJE med eget Kontor → gamla koden gjorde en
  // bubbleGet per distinkt kontor i HELA träffmängden (90 st) för att rendera 40 rader.
  // reported_at faller med i → i=1 nyast (sida 1), i=90 äldst (sista sidan).
  for (var bi = 1; bi <= 90; bi++) {
    STORE.Matter.push({
      _id: "bm" + bi, "Kundföretag": "cc3", Rubrik: "Bulkärende " + bi, status: "Pågående",
      Prioritet: (bi === 90 ? "1 - låg" : "3 - brådskande"),   // "1 - låg" finns BARA på sista sidan
      Kontor: "ofb" + bi,
      reported_at: new Date(Date.UTC(2026, 0, 1) + (90 - bi) * 86400000).toISOString().slice(0, 10),
    });
  }
  var getsBefore = getCalls.filter(function (c) { return c.t === "Office"; }).length;
  var pg1 = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "open", company: "zeta" } });
  var officeGets = getCalls.filter(function (c) { return c.t === "Office"; }).length - getsBefore;
  ok("drift paginering: total=90, pages=3, men bara 40 rader i svaret", pg1.body.total === 90 && pg1.body.pages === 3 && pg1.body.rows.length === 40);
  ok("drift resolvar kontorsnamn BARA för sidans rader (" + officeGets + " bubbleGet, ej 90)", officeGets > 0 && officeGets <= 40);
  ok("drift sida 1 sorterad nyast först (bm1 överst)", pg1.body.rows[0].id === "bm1");
  var pg3 = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "open", company: "zeta", page: "3" } });
  ok("drift sida 3 = 10 rader utan överlapp mot sida 1", pg3.body.rows.length === 10 && !pg3.body.rows.some(function (r) { return pg1.body.rows.some(function (x) { return x.id === r.id; }); }));
  ok("drift prioritet-facet räknas på HELA träffmängden, inte bara sidan", pg1.body.prioriteter.indexOf("1 - låg") > -1 && pg1.body.prioriteter.indexOf("3 - brådskande") > -1);
  var pgPrio = await call(s.routes, "get", "/admin/drift/list", { query: { type: "matters", scope: "open", company: "zeta", prio: "1 - låg" } });
  ok("drift prioritet-filter → 1 (bm90)", pgPrio.body.total === 1 && pgPrio.body.rows[0].id === "bm90");
  // QC: `q` ska gå NER i Bubble som constraint på Titel (inte helsvep + filter i minnet)
  findAllCalls.length = 0;
  var qcQ = await call(s.routes, "get", "/admin/drift/list", { query: { type: "qc", q: "regelmässigt" } });
  var qcCall = findAllCalls.filter(function (c) { return c.t === "QualityControl"; })[0];
  ok("drift qc-sök skickar Titel-constraint till Bubble", !!qcCall && qcCall.constraints.some(function (c) { return c.key === "Titel" && c.constraint_type === "text contains"; }));
  ok("drift qc-sök → 1 (qc1)", qcQ.body.total === 1 && qcQ.body.rows[0].id === "qc1");
  var qcMiss = await call(s.routes, "get", "/admin/drift/list", { query: { type: "qc", q: "finnsinte" } });
  ok("drift qc-sök utan träff → 0", qcMiss.body.total === 0 && qcMiss.body.rows.length === 0);
  var qcCo = await call(s.routes, "get", "/admin/drift/list", { query: { type: "qc", company: "acme" } });
  ok("drift qc företagsfilter (på rådata) → 1 (qc1)", qcCo.body.total === 1 && qcCo.body.rows[0].id === "qc1");
  var qcCoMiss = await call(s.routes, "get", "/admin/drift/list", { query: { type: "qc", company: "zeta" } });
  ok("drift qc företagsfilter utan träff → 0", qcCoMiss.body.total === 0);

  // ── DRIFT SKRIV (status + kommentar) — sist för att inte mutera tidigare assertions ──
  var cLen = STORE.Matter.filter(function(r){return r._id==="mt1";})[0]["Tråd"].length;
  var cAdd = await call(s.routes, "post", "/admin/companies/matter/:id/comment", { params: { id: "mt1" }, body: { text: "Ny kommentar från test", author: "Testaren" } });
  var mt1Now = STORE.Matter.filter(function(r){return r._id==="mt1";})[0];
  ok("matter comment → tråd appendad m. rent datum + författare", cAdd.body.ok && mt1Now["Tråd"].length === cLen + 1 && /^Testaren · \d+ \w+ \d{4} · \d{2}:\d{2}: Ny kommentar/.test(mt1Now["Tråd"][mt1Now["Tråd"].length - 1]));
  var cTom = await call(s.routes, "post", "/admin/companies/matter/:id/comment", { params: { id: "mt1" }, body: { text: "" } });
  ok("matter comment tom → 400", cTom.code === 400 && cTom.body.error === "tom_kommentar");
  var sSet = await call(s.routes, "post", "/admin/companies/matter/:id/status", { params: { id: "mt1" }, body: { status: "Avslutat" } });
  ok("matter status → satt + closed_date vid avslut", sSet.body.ok && mt1Now.status === "Avslutat" && mt1Now.closed_date);
  var sNo = await call(s.routes, "post", "/admin/companies/matter/:id/status", { params: { id: "mt1" }, body: {} });
  ok("matter status utan värde → 400", sNo.code === 400 && sNo.body.error === "missing_status");
  var s404 = await call(s.routes, "post", "/admin/companies/matter/:id/status", { params: { id: "nope" }, body: { status: "Avslutat" } });
  ok("matter status okänt id → 404", s404.code === 404);

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

  // ══════════════════════════════════════════════════════════════════════════
  // BRANSCH-FILTER + KOLUMNERNA FASTIGHET/REGION (2026-08-21)
  //
  // Bakgrunden är ett moment 22: `_facets` härleder option-set-värden UR DATAN, och
  // PATCH validerar mot samma facetter. Ett fält som är tomt på alla företag har
  // därför inga giltiga värden → det går varken att filtrera på eller att skriva i,
  // för alltid. `Bransch` var precis så i produktion. Seeden ur Bubbles option-set
  // bryter dödläget; testerna nedan vaktar BÅDE att seeden finns OCH att den är en
  // UNION (ett värde som bara finns i datan får aldrig falla ur).
  // ══════════════════════════════════════════════════════════════════════════
  const BRANSCH_OS = ["Bank", "Investmentbolag", "Fastigheter", "Mat & dryck", "Fordon", "Bygg",
                      "Tillverkning", "Konsumentvaror", "IT-tjänster", "Digitala program",
                      "Offentlig verksamhet", "Konsulttjänster", "Hotell", "Övriga tjänster"];
  const meta2 = await call(s.routes, "get", "/admin/companies/meta");
  const fb = (meta2.body.facets && meta2.body.facets.bransch) || [];
  ok("facets.bransch bär HELA option-setet (14 värden) fast inget företag har dem",
     BRANSCH_OS.every((v) => fb.indexOf(v) > -1));
  ok("facets.bransch är UNION — datavärdet 'IT' (ej i option-setet) finns kvar",
     fb.indexOf("IT") > -1);
  ok("facets.bransch dedupar överlapp (Bygg finns i både seed och data)",
     fb.filter((v) => v === "Bygg").length === 1);
  ok("facets.bransch sorterad på svenska (Bank först, Övriga tjänster sist)",
     fb[0] === "Bank" && fb[fb.length - 1] === "Övriga tjänster");
  ok("seeden läcker INTE till andra option-set-fält (region = bara datans värden)",
     JSON.stringify((meta2.body.facets.region || []).slice().sort()) === JSON.stringify(["Göteborg", "Stockholm"]));

  // Själva dödläget: sätta ett värde som INGET företag har idag.
  const pb1 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { field: "bransch", value: "Hotell" } });
  ok("patch bransch till option-set-värde som ingen har → ok (dödläget brutet)",
     pb1.body.ok === true && CC.cc3.Bransch === "Hotell" && pb1.body.row.bransch === "Hotell");
  const pb2 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { field: "bransch", value: "Rymdfart" } });
  ok("patch bransch med värde utanför option-setet → 400 (skräp når aldrig Bubble)",
     pb2.code === 400 && String(pb2.body.error).startsWith("unknown_optionset_value") && CC.cc3.Bransch === "Hotell");
  const lb = await call(s.routes, "get", "/admin/companies/list", { query: { bransch: "Hotell" } });
  ok("list?bransch=Hotell filtrerar → bara cc3", lb.body.total === 1 && lb.body.rows[0].id === "cc3");

  // ── Fastighet: LIST-fält, redigerbart utan att tappa värden ──
  ok("meta editable fastighet=reflist", meta2.body.editable.fastighet === "reflist");
  const pf1 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "fastighet", value: ["f1", "f2"] } });
  ok("patch fastighet: lägger till utan att tappa den befintliga",
     pf1.body.ok && JSON.stringify(CC.cc2.Fastighet) === JSON.stringify(["f1", "f2"]) &&
     JSON.stringify(pf1.body.row.fastigheter) === JSON.stringify(["Kungsgatan 1", "Vasagatan 5"]));
  const pf2 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "fastighet", value: ["f2"] } });
  ok("patch fastighet: tar bort en (hela listan skrivs)",
     pf2.body.ok && JSON.stringify(CC.cc2.Fastighet) === JSON.stringify(["f2"]));
  const pf3 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "fastighet", value: ["f2", "f2", "f1"] } });
  ok("patch fastighet: dubbletter dedupas, ordning bevarad",
     JSON.stringify(CC.cc2.Fastighet) === JSON.stringify(["f2", "f1"]));
  const pf4 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "fastighet", value: "f1,f2" } });
  ok("patch fastighet: kommaseparerad sträng accepteras",
     JSON.stringify(CC.cc2.Fastighet) === JSON.stringify(["f1", "f2"]));
  const pf5 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "fastighet", value: [] } });
  ok("patch fastighet: tom lista rensar fältet",
     pf5.body.ok && JSON.stringify(CC.cc2.Fastighet) === JSON.stringify([]) && JSON.stringify(pf5.body.row.fastigheter) === JSON.stringify([]));
  // ⚠️ Ett referens-id som inte finns ger Bubble 400 MISSING_DATA (se _deadRefId).
  // Vi ska stoppa det själva och säga VILKET id — inte låta Bubble braka.
  const pf6 = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "fastighet", value: ["f1", "fSPOKE"] } });
  ok("patch fastighet: okänt fastighets-id → 400 unknown_ref_id, inget skrivs",
     pf6.code === 400 && pf6.body.error === "unknown_ref_id:fastighet" && pf6.body.value === "fSPOKE" &&
     JSON.stringify(CC.cc2.Fastighet) === JSON.stringify([]));
  await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { field: "fastighet", value: ["f1"] } });

  // Sortering på listkolumnen (tomma sist, oavsett riktning)
  // ⚠️ Måste SKILJA sig från namnsorteringen — annars är testet grönt även när
  // SORT_GETTERS.fastighet saknas och servern tyst faller tillbaka på sort=name.
  // Namn asc = cc1, cc2, cc3. Fastighet asc = cc2 ("Kungsgatan 1"), cc1
  // ("Kungsgatan 1, Vasagatan 5"), cc3 (tom → alltid sist).
  const sf = await call(s.routes, "get", "/admin/companies/list", { query: { sort: "fastighet", dir: "asc" } });
  const sfIds = sf.body.rows.map((r) => r.id);
  ok("sort=fastighet sorterar på fastighetsnamnen, tomma sist (ej namn-fallback)",
     JSON.stringify(sfIds) === JSON.stringify(["cc2", "cc1", "cc3"]));
  const lf = await call(s.routes, "get", "/admin/companies/list", { query: { fastighet: "f1" } });
  ok("list?fastighet=f1 oförändrad efter reflist-editen", lf.body.total === 2);

  // ── FRONTEND (mira-foretag-lista.html) ────────────────────────────────────
  // ⚠️ Greppar STRIPPAD kod: kommentarsrader bort först, annars kan en kommentar
  // som beskriver en funktion göra testet grönt utan att koden finns.
  const flRaw = readFileSync(new URL("./mira-foretag-lista.html", import.meta.url), "utf8");
  const fl = flRaw.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  ok("frontend: Region-kolumn i COLS, redigerbar",
     /\{key:"region",\s*label:"Region",\s*sort:"region",\s*edit:"region"/.test(fl));
  ok("frontend: Fastighet-kolumn i COLS med kind reflist",
     /\{key:"fastighet",\s*label:"Fastighet",\s*sort:"fastighet",\s*edit:"fastighet",\s*kind:"reflist"\}/.test(fl));
  ok("frontend: Bransch-select i filterraden", /data-flf="bransch"/.test(fl) && /Alla branscher/.test(fl));
  ok("frontend: STATE.f initierar bransch", /f:\{[^}]*bransch:""/.test(fl));
  ok("frontend: listcellen ritas som chips + add-dropdown",
     /function reflistEditHtml/.test(fl) && /data-fladd="1"/.test(fl) && /data-flrm="/.test(fl));
  // ⚠️ Klick-ordning: chip-× och "Klar" MÅSTE hanteras före den generella
  // cell-grenen, annars faller varje klick i editorn igenom till beginEdit.
  ok("frontend: data-flrm hanteras FÖRE data-flcell i klick-hanteraren",
     fl.indexOf('t.closest("[data-flrm]")') > -1 &&
     fl.indexOf('t.closest("[data-flrm]")') < fl.indexOf('t.closest(\'[data-flcell="1"]\'):null;\n    if(cell)'));
  ok("frontend: öppen editor klickas inte igenom till beginEdit",
     /if\(cell\)\{ if\(cell\.getAttribute\("data-editing"\)\) return; beginEdit\(cell\); return; \}/.test(fl));
  ok("frontend: add-dropdownen skickar hela listan via commitList",
     /data-fladd"\)\)\{/.test(fl) && /commitList\(atd, next\)/.test(fl));

  // ══════════════════════════════════════════════════════════════════════════
  // VÅRA BOLAG: badges + filter (2026-08-21)
  // Fönstret "fakturerar idag" = 12 rullande månader (Christians beslut).
  // ⚠️ Kartan kommer ur faktura-svepet, som värms LAT. En kall karta ger 0 träffar
  // på bolagsfiltret — och 0 får aldrig läsas som "ingen kund har det bolaget".
  // ══════════════════════════════════════════════════════════════════════════
  const lb2 = await call(s.routes, "get", "/admin/companies/list", { query: { meta: "1" } });
  // ⚠️ Defensivt: mot gammal kod saknas fälten helt. Kraschar assertionen i st.f. att
  // FALLA, dör sviten mitt i och mutationstestet döljer alla följande fel
  // (exakt det som hände med `body.roles.indexOf` 2026-08-18).
  const bRow = (id) => {
    const r = lb2.body.rows.filter((x) => x.id === id)[0] || {};
    return { id: r.id, bolag: r.bolag || null, bolag_all: r.bolag_all || null };
  };
  const bAll = (id, i) => ((bRow(id).bolag_all || [])[i] || {});
  ok("bolag: cc1 faktureras av Staff + F&E + Group (aktiva, sorterade)",
     JSON.stringify(bRow("cc1").bolag) === JSON.stringify(["Staff", "Food & Event", "Group"]));
  ok("bolag: cc2 har INGEN aktiv (700 dagar sedan) men finns kvar i bolag_all",
     JSON.stringify(bRow("cc2").bolag) === JSON.stringify([]) &&
     (bRow("cc2").bolag_all || []).length === 1 && bAll("cc2", 0).name === "Housekeeping" &&
     bAll("cc2", 0).active === false);
  ok("bolag: bolag_all bär senaste fakturadatum (YYYY-MM-DD)",
     /^\d{4}-\d{2}-\d{2}$/.test(bAll("cc2", 0).last || ""));
  ok("bolag: cc3 utan fakturor → tomma listor, inte null",
     JSON.stringify(bRow("cc3").bolag) === JSON.stringify([]) && JSON.stringify(bRow("cc3").bolag_all) === JSON.stringify([]));
  ok("bolag: meta.bolag har alla fyra bolagen i kanonisk ordning",
     JSON.stringify((lb2.body.meta || {}).bolag) === JSON.stringify(["Staff", "Food & Event", "Housekeeping", "Group"]));
  ok("bolag: list-svaret bär bolag_ready", lb2.body.bolag_ready === true);

  const fStaff = await call(s.routes, "get", "/admin/companies/list", { query: { bolag: "Staff" } });
  ok("bolag: ?bolag=Staff → bara cc1", fStaff.body.total === 1 && fStaff.body.rows[0].id === "cc1");
  const fHk = await call(s.routes, "get", "/admin/companies/list", { query: { bolag: "Housekeeping" } });
  ok("bolag: ?bolag=Housekeeping → 0 (cc2:s faktura är utanför 12-månadersfönstret)", fHk.body.total === 0);
  const fBoth = await call(s.routes, "get", "/admin/companies/list", { query: { bolag: "Group", kundstatus: "Aktiv kund" } });
  ok("bolag: filtret kombineras med övriga filter", fBoth.body.total === 1 && fBoth.body.rows[0].id === "cc1");

  // ⚠️ KALL CACHE: bolagskartan är null → svaret måste säga bolag_ready:false, annars
  // läses 0 träffar som "ingen kund faktureras av Staff".
  const bolagColdDeps = Object.assign({}, deps, { companyBolagMapWarm: () => null, companyRevenueMapWarm: () => null });
  const bcs = mk(); registerCompaniesRoutes(bcs.app, bolagColdDeps);
  const cold = await call(bcs.routes, "get", "/admin/companies/list", { query: { bolag: "Staff", meta: "1" } });
  ok("bolag: kall karta → bolag_ready:false (0 träffar betyder 'inte beräknat', inte 'finns inte')",
     cold.body.bolag_ready === false && cold.body.total === 0);
  ok("bolag: filtrets värdelista är fylld ÄVEN med kall karta (de fyra alltid med)",
     JSON.stringify((cold.body.meta || {}).bolag) === JSON.stringify(["Staff", "Food & Event", "Housekeeping", "Group"]));

  // Okänd anslutning ska SYNAS, inte tappas
  const oddDeps = Object.assign({}, deps, { companyBolagMapWarm: () => new Map([["cc1", { "Connection abc123": Date.now() }]]) });
  const bos = mk(); registerCompaniesRoutes(bos.app, oddDeps);
  const odd = await call(bos.routes, "get", "/admin/companies/list", { query: { meta: "1" } });
  const oddList = ((odd.body.meta || {}).bolag) || [];
  ok("bolag: okänd anslutning dyker upp i filterlistan (sist), döljs aldrig",
     oddList.length > 0 && oddList.indexOf("Connection abc123") === oddList.length - 1);

  // Kortet
  const bcard = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "cc1" } });
  ok("bolag: kortet bär bolag + bolag_all på company",
     JSON.stringify((bcard.body.company || {}).bolag) === JSON.stringify(["Staff", "Food & Event", "Group"]) &&
     (((bcard.body.company || {}).bolag_all) || []).length === 3);
  const bcard2 = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "cc2" } });
  const c2b = bcard2.body.company || {};
  ok("bolag: kortet visar tidigare fakturering som inaktiv, inte som frånvarande",
     (c2b.bolag || []).length === 0 && ((c2b.bolag_all || [])[0] || {}).active === false);

  // ── FRONTEND: kortets fastighetsredigering + bolagsbadges ──────────────────
  ok("frontend: kortet har Fastighet-fält med chips i redigeringsformuläret",
     /function cardFastInner/.test(fl) && /data-fkfadd="1"/.test(fl) && /data-fkfrm="/.test(fl));
  // ⚠️ Kortets formulär har Avbryt → chipsen får INTE patchas direkt som i listan,
  // utan stageas i STATE.cardFast och skickas med cardSave.
  ok("frontend: kortets chips stageas i STATE.cardFast (inte direkt-PATCH)",
     /STATE\.cardFast=keep; redrawCardFast\(\)/.test(fl) && /STATE\.cardFast=kf; redrawCardFast\(\)/.test(fl) &&
     /fields\.fastighet=STATE\.cardFast\.slice\(\)/.test(fl));
  ok("frontend: Avbryt kastar den stageade listan",
     /data-fk="canceledit"\]'\)\)\{ STATE\.cardEditing=false; STATE\.cardFast=null;/.test(fl));
  // ⚠️ redrawCardFast, ALDRIG renderCard — annars raderas text i formulärets andra fält.
  ok("frontend: chip-ändring ritar bara om fältet, inte hela kortet",
     /function redrawCardFast\(\)\{[\s\S]*?data-fkfast[\s\S]*?\}/.test(fl) &&
     !/data-fkfrm[\s\S]{0,200}renderCard\(\)/.test(fl));
  ok("frontend: Fastighet visas alltid i läsvyn, även tom",
     /rows\+='<div class="k">Fastighet<\/div><div class="val">'\+/.test(fl));
  ok("frontend: bolagsbadges renderas i kort-heron",
     /function bolagBadges/.test(fl) && /fk-bolagrow[\s\S]{0,80}Faktureras av/.test(fl));
  ok("frontend: badge skiljer aktiv från tidigare fakturering",
     /b\.active\?"":" past"/.test(fl));
  // ⚠️ Tom data får aldrig bli ett svar — varken i badgen eller i tomma tabellen.
  ok("frontend: kall bolagskarta visar 'beräknar', inte 'Ingen fakturering'",
     /if\(!ready\) return '<span class="fk-bolag b-other">beräknar bolag…<\/span>';/.test(fl));
  ok("frontend: bolagsfilter + kall karta ger 'Beräknar…', inte 'Inga företag matchar'",
     /STATE\.f\.bolag && !STATE\.bolag_ready/.test(fl));
  ok("frontend: bolagsfilter i filterraden", /data-flf="bolag"/.test(fl) && /Alla våra bolag/.test(fl));

  // ══════════════════════════════════════════════════════════════════════════
  // FASTIGHETSNAMN: "[object Object]" (bugg 2026-08-21)
  // Namnkedjan läste `Adress` (ett geographic address-OBJEKT) FÖRE `Titel`, som är
  // det fält Fastighet faktiskt har. String(objekt) → "[object Object]", vilket
  // syntes i filtret, kolumnen och kortets chips. Testerna vaktar tre saker:
  // Titel vinner · adressen används bara som textfallback · inget objekt kan bli namn.
  // ══════════════════════════════════════════════════════════════════════════
  const fmeta = await call(s.routes, "get", "/admin/companies/meta");
  const fList = fmeta.body.fastigheter || [];
  const fName = (id) => (fList.filter((x) => x.id === id)[0] || {}).name;
  ok("fastighet: INGET namn är '[object Object]'",
     fList.every((x) => x.name !== "[object Object]") &&
     JSON.stringify(fList).indexOf("[object Object]") < 0);
  ok("fastighet: Titel vinner över Adress-objektet", fName("f1") === "Kungsgatan 1" && fName("f2") === "Vasagatan 5");
  ok("fastighet: utan Titel används adressens TEXT, inte objektet", fName("f3") === "Drottninggatan 9, Göteborg");
  ok("fastighet: helt namnlös fastighet utelämnas ur listan", fName("f4") === undefined && fList.length === 3);
  // Radens namnuppslag går via samma karta → kolumnen och kortets chips är också täckta.
  const frow = await call(s.routes, "get", "/admin/companies/list", { query: {} });
  const fr1 = frow.body.rows.filter((r) => r.id === "cc1")[0] || {};
  ok("fastighet: listraden visar riktiga namn (kolumn + kortets chips delar karta)",
     (fr1.fastigheter || []).join("|").indexOf("[object Object]") < 0 && (fr1.fastigheter || []).length > 0);
  ok("frontend: selOpts faller tillbaka på värdet i st.f. att rendera ett objekt",
     /if\(nm===null\|\|nm===undefined\|\|typeof nm==="object"\) nm=v;/.test(fl));

  // ══════════════════════════════════════════════════════════════════════════
  // FRUSNA FILTERVÄRDEN (bugg 2026-08-21, följdfel till "[object Object]")
  // Backend var rättad men dropdownen visade fortfarande skräp: filterraden ritas
  // BARA en gång (`if(!$("filters").innerHTML) renderFilters()`), så värdelistorna
  // frystes vid sessionens FÖRSTA svar — och det kom ur sessionStorage (TTL 15 min),
  // skrivet före deployen. Inte ens Uppdatera-knappen hjälpte: vakten satt på
  // innerHTML, inte på cachen. Två lager: cache-version + synk av options.
  // ══════════════════════════════════════════════════════════════════════════
  ok("frontend: cache-nycklarna bär CACHE_VER (gamla payloads läses aldrig)",
     /var CACHE_VER="\d+";/.test(fl) &&
     /return "fl:list:"\+CACHE_VER\+":"/.test(fl) && /return "fl:card:"\+CACHE_VER\+":"/.test(fl));
  ok("frontend: värdelistorna synkas när filterskelettet redan finns",
     /else syncFilterOptions\(\);/.test(fl) && /function syncFilterOptions/.test(fl));
  // ⚠️ Synken får bara röra [data-flf]-selecten — sökfältet måste lämnas ifred,
  // annars är vi tillbaka i fokus/caret-buggen som gjorde raden render-once.
  ok("frontend: synken rör bara filter-selecten, aldrig sökfältet",
     /sels=root\.querySelectorAll\("\[data-flf\]"\)/.test(fl) &&
     !/function syncFilterOptions[\s\S]*?data-fl="q"[\s\S]*?\n  \}/.test(fl));
  ok("frontend: en öppen/fokuserad dropdown rycks inte undan",
     /if\(el===document\.activeElement\) continue;/.test(fl));
  ok("frontend: valt värde överlever en synk",
     /el\.value=STATE\.f\[k\]\|\|"";/.test(fl));

  // ══════════════════════════════════════════════════════════════════════════
  // NÄSTA STEG-GRINDEN + LEVANDE AKTIVITET/TODO (2026-08-21)
  // En genomförd aktivitet får inte lämnas utan beslut: ny aktivitet, todo eller
  // avslutat. `nasta_steg` är ett NYTT text-fält på activitet_crm — modulen får RÅ
  // bubbleCreate/bubblePatch, så ett okänt fält 400:ar HELA skrivningen. Testerna
  // vaktar både grinden och att mötet ändå sparas när fältet saknas i Bubble.
  // ══════════════════════════════════════════════════════════════════════════
  const nsCreate = (body) => call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body });
  const nsPatch  = (id, body) => call(s.routes, "post", "/admin/companies/historik/:id/patch", { params: { id }, body });

  const g1 = await nsCreate({ activity_type: "Kundmöte", beskrivning: "Möte", genomfort: true, motesanteckning: "Ok" });
  ok("grind: genomförd aktivitet utan nästa steg → 400",
     g1.code === 400 && g1.body.error === "nasta_steg_krävs" &&
     JSON.stringify(g1.body.allowed) === JSON.stringify(["aktivitet", "todo", "avslutat"]));
  const g2 = await nsCreate({ activity_type: "Kundmöte", beskrivning: "Möte", genomfort: true, nasta_steg: "kanske" });
  ok("grind: okänt nästa steg-värde → 400", g2.code === 400 && g2.body.error === "okänt_nasta_steg");
  const g3 = await nsCreate({ activity_type: "Kundmöte", beskrivning: "Möte ok", genomfort: true, nasta_steg: "todo" });
  // ⚠️ Bubble-fältet heter `aktivitet_nasta_steg` (Option Set), verifierat mot
  // editorn 2026-08-21. Testar man fel nyckel testar man en påhittad värld.
  // ⚠️ Regressionsvakt mot precis det fel jag gjorde: koden hette `nasta_steg` medan
  // Bubble-fältet heter `aktivitet_nasta_steg`. Fel nyckel = 400 på HELA skrivningen
  // (eller, med nedgraderingen, ett tyst tappat val vid varje sparning).
  ok("fältnamn: skriver ALDRIG den felaktiga nyckeln `nasta_steg`",
     STORE.activitet_crm.every((r) => !Object.prototype.hasOwnProperty.call(r, "nasta_steg")));
  ok("grind: med nästa steg → skapas + rätt Bubble-fält skrivs",
     g3.body.ok === true && STORE.activitet_crm[STORE.activitet_crm.length - 1]["aktivitet_nasta_steg"] === "todo" &&
     g3.body.nasta_steg_field_missing === false);
  // ⚠️ Grinden gäller ÖVERGÅNGEN, inte varje sparning av en redan genomförd rad.
  const g4 = await nsCreate({ activity_type: "Kundmöte", beskrivning: "Ej klar än", genomfort: false });
  ok("grind: ej genomförd aktivitet kräver inget nästa steg", g4.body.ok === true);
  const g4id = g4.body.id;
  const g5 = await nsPatch(g4id, { genomfort: true, motesanteckning: "Klart" });
  ok("grind: patch som markerar genomförd utan nästa steg → 400", g5.code === 400 && g5.body.error === "nasta_steg_krävs");
  const g6 = await nsPatch(g4id, { genomfort: true, motesanteckning: "Klart", nasta_steg: "avslutat" });
  ok("grind: patch med nästa steg går igenom", g6.body.ok === true);
  const g7 = await nsPatch(g4id, { motesanteckning: "Rättar stavfel" });
  ok("grind: rad med beslut kan redigeras utan att frågas igen", g7.body.ok === true);
  const g8 = await nsPatch(g4id, { genomfort: true, beskrivning: "Ny text" });
  ok("grind: rad med beslut grindas inte om vid ny sparning", g8.body.ok === true);
  // ⚠️ SKÄRPT REGEL: gammalt genomfört möte UTAN beslut ska grindas när
  // avklarandet rörs — annars omfattas de befintliga aktiviteterna aldrig.
  STORE.activitet_crm.push({ _id: "aktGammal", company: "cc1", activity_type: "Kundmöte", "genomfört": true, beskrivning: "Gammalt klart möte" });
  const g9 = await nsPatch("aktGammal", { motesanteckning: "Efterhandsanteckning" });
  ok("grind: gammalt genomfört möte utan beslut grindas när anteckningen rörs",
     g9.code === 400 && g9.body.error === "nasta_steg_krävs");
  // ...men en sparning som INTE rör avklarandet får inte blockeras.
  const g10 = await nsPatch("aktGammal", { fas: "Fas 3" });
  ok("grind: patch som bara ändrar fas blockeras INTE", g10.body.ok === true);
  const g11 = await nsPatch("aktGammal", { beskrivning: "Ny beskrivning" });
  ok("grind: patch som bara ändrar beskrivning blockeras INTE", g11.body.ok === true);

  // ── Fältet saknas i Bubble: mötet MÅSTE ändå sparas ───────────────────────
  // ⚠️ Utan mjuk nedgradering hade en Render-deploy före Bubble-fältet blockerat
  // användaren från att spara sitt möte. Mocken kastar samma 400 som Bubble.
  const noFieldDeps = Object.assign({}, deps, {
    bubbleCreate: async (t, payload) => {
      if (t === "activitet_crm" && payload && payload.aktivitet_nasta_steg !== undefined) {
        const e = new Error("bubbleCreate failed");
        e.detail = { status: 400, body: JSON.stringify({ body: { status: "ERROR", message: "Unrecognized field: aktivitet_nasta_steg" } }) };
        throw e;
      }
      return deps.bubbleCreate(t, payload);
    },
  });
  const nfs = mk(); registerCompaniesRoutes(nfs.app, noFieldDeps);
  const nfBefore = STORE.activitet_crm.length;
  const nf = await call(nfs.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "Möte utan fält", genomfort: true, nasta_steg: "avslutat" } });
  ok("saknat Bubble-fält: mötet sparas ändå + nasta_steg_field_missing:true",
     nf.body.ok === true && nf.body.nasta_steg_field_missing === true && STORE.activitet_crm.length === nfBefore + 1);
  ok("saknat Bubble-fält: raden bär övriga fält (hela skrivningen tappades INTE)",
     STORE.activitet_crm[STORE.activitet_crm.length - 1]["genomfört"] === true &&
     STORE.activitet_crm[STORE.activitet_crm.length - 1]["aktivitet_nasta_steg"] === undefined);
  // ⚠️ Ett ANNAT okänt fält får INTE svaljas — då döljer vi äkta buggar.
  const otherFieldDeps = Object.assign({}, deps, {
    bubbleCreate: async () => { const e = new Error("bubbleCreate failed"); e.detail = { status: 400, body: JSON.stringify({ body: { message: "Unrecognized field: nagot_annat" } }) }; throw e; },
  });
  const ofs = mk(); registerCompaniesRoutes(ofs.app, otherFieldDeps);
  const of2 = await call(ofs.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "x", genomfort: true, nasta_steg: "avslutat" } });
  ok("annat okänt fält braker fortfarande (nedgraderingen matchar SMALT)", of2.code >= 400 && of2.body.ok !== true);

  // ── OPTION SET läses tillbaka som {display}-OBJEKT ────────────────────────
  // ⚠️ `aktivitet_nasta_steg` är ett Option Set. Bubble kan svara med en sträng
  // ELLER med `{display:"todo"}`. Ett rakt String(v) på objektformen ger
  // "[object Object]" → läs-tillbaka-verifieringen hade flaggat fältet som SAKNAT
  // fast allt sparats korrekt, och användaren fått en falsk varning.
  // Samma klass av fel som fastighetsnamnen 2026-08-21.
  const osDeps = Object.assign({}, deps, {
    bubbleGet: async (t, id) => {
      const r = await deps.bubbleGet(t, id);
      if (t === "activitet_crm" && r && typeof r.aktivitet_nasta_steg === "string") {
        return Object.assign({}, r, { aktivitet_nasta_steg: { display: r.aktivitet_nasta_steg } });
      }
      return r;
    },
  });
  const oss = mk(); registerCompaniesRoutes(oss.app, osDeps);
  const os1 = await call(oss.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "OS-form", genomfort: true, nasta_steg: "todo" } });
  ok("option set som {display}-objekt: INGEN falsk 'fältet saknas'-varning",
     os1.body.ok === true && os1.body.nasta_steg_field_missing === false);
  ok("option set som {display}-objekt: raden exponerar värdet som ren sträng",
     os1.body.row && os1.body.row.nasta_steg === "todo");

  // ── LEVANDE AKTIVITET / TODO på kortet ────────────────────────────────────
  const lc1 = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "cc1" } });
  const n1 = lc1.body.nasta || {};
  ok("levande: kortet bär nasta.ok", n1.ok === true);
  ok("levande: todo med framtida sluttid räknas",
     (n1.todos || []).length === 1 && (n1.todos || [])[0].titel === "Ring Sarah");
  ok("levande: förfluten todo och Avslutad-todo räknas INTE",
     !(n1.todos || []).some((t) => t.titel === "Gammal punkt" || t.titel === "Redan klar"));
  const lc2 = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "cc2" } });
  const n2 = lc2.body.nasta || {};
  ok("levande: framtida ej genomförd aktivitet räknas",
     (n2.aktiviteter || []).length === 1 && (n2.aktiviteter || [])[0].typ === "Kundmöte" && (n2.aktiviteter || [])[0].fas === "Fas 1");
  ok("levande: todo med framtida STARTtid räknas (inte bara sluttid)",
     (n2.todos || []).length === 1 && (n2.todos || [])[0].titel === "Startar snart");
  const lc3 = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "cc3" } });
  const n3 = lc3.body.nasta || {};
  ok("levande: framtida men REDAN GENOMFÖRD aktivitet räknas inte som levande",
     n3.ok === true && (n3.aktiviteter || []).length === 0 && (n3.todos || []).length === 0);

  // ⚠️ TOM DATA ÄR ALDRIG ETT SVAR: faller Todo-frågan är svaret OKÄNT, inte "inget
  // planerat". Utan detta visar kortet skapa-knappar för en kund som har fullt upp.
  const todoFailDeps = Object.assign({}, deps, {
    bubbleFindAll: async (t, o) => { if (t === "Todo") throw new Error("Bubble 500"); return deps.bubbleFindAll(t, o); },
  });
  const tfs = mk(); registerCompaniesRoutes(tfs.app, todoFailDeps);
  const tf = await call(tfs.routes, "get", "/admin/companies/:id/card", { params: { id: "cc1" } });
  // ⚠️ Defensivt: mot gammal kod saknas `nasta` helt. `tf.body.nasta.ok` hade
  // KRASCHAT sviten i st.f. att falla — tredje gången den fällan dyker upp i det
  // här repot (roles 2026-08-18, bolag 2026-08-21). Skriv alltid `(x || {})`.
  ok("levande: fallen Todo-fråga → nasta.ok:false (aldrig tolkat som 'inget planerat')",
     tf.body.ok === true && (tf.body.nasta || {}).ok === false);

  // ── FRONTEND ──────────────────────────────────────────────────────────────
  ok("frontend: grinden renderas i historikformuläret",
     /function nastaStegHtml/.test(fl) && /data-ns="aktivitet"/.test(fl) && /data-ns="todo"/.test(fl) && /data-ns="avslutat"/.test(fl));
  ok("frontend: grinden visas bara när Kundmöte + Genomfört",
     /if\(ns\) ns\.style\.display=\(isK&&done&&done\.checked\)\?"":"none";/.test(fl));
  // ⚠️ Grinden gäller frånvaron av ett BESLUT, inte bara övergången. En redan
  // genomförd aktivitet UTAN nasta_steg måste grindas — annars omfattas de
  // hundratals redan avbockade aktiviteterna aldrig av kravet. Har raden ett
  // beslut frågas man inte igen.
  ok("frontend: grindar genomförd rad som SAKNAR beslut, men inte en som har det",
     /function nsLocked\(r\)\{ return !!\(r && r\.genomfort && r\.nasta_steg\); \}/.test(fl) &&
     /if\(nsLocked\(r\)\) return "";/.test(fl));
  // ⚠️ Uppföljaren skapas FÖRE aktiviteten — annars kan mötet stå som genomfört
  // med nasta_steg="aktivitet" utan att någon aktivitet finns.
  ok("frontend: uppföljaren skapas före aktiviteten sparas, och stoppar sparningen om den faller",
     /nsCreateFollow\(ns\.follow\)\.then\(function\(fj\)\{/.test(fl) &&
     /aktiviteten sparades INTE/.test(fl));
  ok("frontend: segmentknapparna re-renderar inte kortet (texten i formuläret överlever)",
     /if\(nsb\)\{ var nsw=nsb\.closest\("\[data-nswrap\]"\); if\(nsw\) nsSelect\(nsw, nsb\.getAttribute\("data-ns"\)\); return; \}/.test(fl));
  ok("frontend: levande-panelen ligger på Hem, ovanför Snabbåtgärder",
     /nastaPanel\(\)\+\n?\s*'<div class="fk-sech" style="margin-top:18px">Snabbåtgärder/.test(fl) || /nastaPanel\(\)\+/.test(fl));
  ok("frontend: nasta.ok:false säger att det är okänt, inte att inget finns",
     /Det betyder inte att inget är planerat/.test(fl));
  ok("frontend: utan levande poster visas skapa-knappar för både aktivitet och att-göra",
     /data-fk="qa-aktivitet">\+ Boka aktivitet/.test(fl) && /data-fk="qa-todo">\+ Skapa att-göra/.test(fl));
  // ⚠️ Varningen måste överleva re-rendern efter sparning — skrivs den bara i
  // formuläret rivs den direkt (fångat i browser-harness 2026-08-21).
  // ── Todo-uppföljaren: BÅDE start- och slutdatum ───────────────────────────
  // ⚠️ En todo kan planeras långt fram ("gör detta om 12 månader") — då är starttiden
  // det som betyder något, inte deadline. Och en todo UTAN båda datumen syns aldrig
  // i kortets levande-panel (som räknar framtida start ELLER slut) → osynlig
  // uppföljning. Därför krävs minst ett av dem.
  ok("frontend: todo-formuläret har både startdatum och klart-senast (grinden)",
     /data-nf="t_start"/.test(fl) && /data-nf="t_slut"/.test(fl) && /<label>Startdatum<\/label>/.test(fl));
  ok("frontend: todo-formuläret på Hem har också startdatum",
     /data-tf="start"/.test(fl) && /data-tf="slut"/.test(fl));
  ok("frontend: starttid skickas vidare till todo-endpointen",
     /starttid: follow\.starttid, sluttid: follow\.sluttid/.test(fl) &&
     /starttid:g\("start"\), sluttid:g\("slut"\)/.test(fl));
  ok("frontend: todo utan något datum blockeras (skulle bli osynlig på kortet)",
     /if\(!g\("t_start"\) && !g\("t_slut"\)\) return \{ error:/.test(fl) &&
     /if\(!g\("start"\) && !g\("slut"\)\)\{/.test(fl));

  ok("frontend: saknat Bubble-fält rapporteras i en banner som överlever re-rendern",
     /STATE\.nsWarn="Aktiviteten sparades, men fältet aktivitet_nasta_steg saknas/.test(fl) &&
     /STATE\.nsWarn\?\(/.test(fl) && /data-fk="nswarnclose"/.test(fl));
  // ⚠️ Chain-cachen använder `undefined` som "hämta om"-sentinel; `null` når
  // historikBody(null) → krasch på rows.length. Fångat i browser-harness 2026-08-21.
  ok("frontend: historik-cachen nollställs med delete (undefined), aldrig null",
     !/STATE\.chain\.historik=null/.test(fl) && /delete STATE\.chain\.historik/.test(fl));

  // ── "5 skäl till bom" på kundkortets affärsformulär (2026-08-22) ──────────
  // ⚠️ RIKTNING: fler stjärnor = starkare position = HÖGRE sannolikhet.
  // Formeln måste vara IDENTISK med backend, annars visar kortet en annan siffra
  // än den som sparas.
  ok("frontend: stjärnkomponenten finns med de fem punkterna",
     /function bomHtml/.test(fl) &&
     /var BOM=\[\["relation",[^\]]*\],\["beslutsprocess",[^\]]*\],\["timing",[^\]]*\],\["budget",[^\]]*\],\["battre",/.test(fl));
  ok("frontend: samma formel som backend ((summa−5)/20 × 0,95, tak 95 %)",
     /Math\.round\(\(\(sum-BOM\.length\)\/\(BOM\.length\*4\)\)\*0\.95\*100\)/.test(fl));
  ok("frontend: sektionen sitter i affärsformuläret och alla fem krävs",
     /bomHtml\(null\)/.test(fl) && /if\(!r\.klar\) return "Gradera alla fem/.test(fl) &&
     /bomApply\(box, payload\)/.test(fl));
  // ⚠️ Stjärnorna ligger i affärsformuläret, som ligger i en expanderbar rad —
  // utan stopPropagation + egen gren kollapsar raden man just fyller i.
  ok("frontend: stjärnklick hanteras före rad-hanterarna och stoppar bubblingen",
     /if\(bst\)\{ e\.stopPropagation\(\); bomSet\(bst\); return; \}/.test(fl) &&
     fl.indexOf('t.closest(".fk-bomstar")') < fl.indexOf('t.closest(\'[data-fk="cdopen"]\')'));
  ok("frontend: stjärnklick punktuppdaterar, anropar aldrig renderCard",
     /function bomSet\(star\)\{[\s\S]*?data-bompct[\s\S]*?\n  \}/.test(fl) &&
     !/fk-bomstar[\s\S]{0,300}renderCard\(\)/.test(fl));
  ok("frontend: saknade bom-fält i Bubble rapporteras till användaren",
     /bom_fields_missing/.test(fl) && /graderingen lagrades inte/.test(fl));

  // ── FRONTEND: "Vår personal" ska bara visa Carottare ──────────────────────
  // ⚠️ Filtreringen sker i servern, men om den INTE kunde göras (ingen
  // user_company) eller frågan föll måste kortet säga det — annars ser en
  // blandning av Carottare och kundens users ut som ett faktum.
  ok("frontend: säger till när listan kan innehålla kundens egna users",
     /personnel_unfiltered/.test(fl) && /går Carottare inte att skilja ut/.test(fl));
  ok("frontend: fallen personal-fråga rapporteras, inte tolkad som tom lista",
     /L\.personnel_ok===false/.test(fl) && /Det betyder inte att ingen är kopplad/.test(fl));

  // ══════════════════════════════════════════════════════════════════════════
  // SKAPA FÖRETAG (2026-08-24)
  // Smalt fältomfång: namn* + org.nr* + ansvarig + kundstatus.
  // ⚠️ Org.nr obligatoriskt och dubblettspärrat — med 5 499 rader och manuell
  // inmatning är dubbletter en tidsfråga, och dyra att städa i efterhand.
  // Jämförelse på SIFFROR: datan bär både "5569748378" och "516409-6348".
  // ══════════════════════════════════════════════════════════════════════════
  const nyF = (body) => call(s.routes, "post", "/admin/companies/create", { body });

  const nf1 = await nyF({ name: "Nytt Bolag AB", orgnr: "5561234567", kundstatus: "Aktiv kund" });
  ok("skapa: företag skapas + rad returneras",
     nf1.body.ok === true && nf1.body.row && nf1.body.row.name === "Nytt Bolag AB" && nf1.body.verified === true);
  ok("skapa: org.nr och kundstatus lagras korrekt",
     STORE.ClientCompany ? true : (function () {
       const rec = CC[nf1.body.id];
       return rec && rec.Org_Number === "5561234567" && rec.Kundstatus === "Aktiv kund";
     })());
  // ⚠️ Siffror, men som STRÄNG — Org_Number är ett text-fält i Bubble.
  ok("skapa: org.nr normaliseras till siffror men skrivs som TEXT",
     (function () { const r = CC[nf1.body.id]; return r && typeof r.Org_Number === "string" && /^\d{10}$/.test(r.Org_Number); })());
  // ⚠️ Nya raden måste in i den DELADE cachen — annars syns den inte i listan
  // förrän nästa helsvep (upp till 12 h).
  const efter = await call(s.routes, "get", "/admin/companies/list", { query: { q: "Nytt Bolag" } });
  // ── Kundansvarig knyts som "Vår personal" på kunden ───────────────────────
  // ⚠️ Annars står ansvaret i ett fält medan personallistan är tom, och notiser
  // som hänger på Associated_company når aldrig fram.
  ok("skapa: kundansvarig får företaget i sin Associated_company",
     nf1.body.ansvarig_kopplad === undefined);   // nf1 skapades utan ansvarig
  const nfA = await nyF({ name: "Med Ansvarig AB", orgnr: "5565550001", ansvarig: "u3" });
  ok("skapa: vald kundansvarig knyts till kunden",
     nfA.body.ok === true && nfA.body.ansvarig_kopplad === true &&
     (STORE.User.find((u) => u._id === "u3")["Associated_company"] || []).indexOf(nfA.body.id) > -1);
  // ⚠️ Befintliga kopplingar får inte skrivas över — listan appendas.
  ok("skapa: befintliga kopplingar på användaren bevaras",
     (STORE.User.find((u) => u._id === "u3")["Associated_company"] || []).indexOf("cc1") > -1);
  // ⚠️ BEST-EFFORT: företaget är redan skapat när kopplingen görs. Faller den ska
  // svaret säga det — inte kasta bort ett företag som finns i Bubble.
  const linkFailDeps = Object.assign({}, deps, {
    bubblePatch: async (t, id, p2) => {
      if (t === "User" && p2 && p2["Associated_company"]) throw new Error("Bubble 500");
      return deps.bubblePatch(t, id, p2);
    },
  });
  const lnkS = mk(); registerCompaniesRoutes(lnkS.app, linkFailDeps);
  const lnk = await call(lnkS.routes, "post", "/admin/companies/create", { body: { name: "Länk faller AB", orgnr: "5565550002", ansvarig: "u3" } });
  ok("skapa: fallen koppling förlorar INTE företaget, men redovisas",
     lnk.body.ok === true && lnk.body.id && lnk.body.ansvarig_kopplad === false);

  // ── Byte av kundansvarig knyter den NYA (2026-08-24) ─────────────────────
  // ⚠️ Utan detta gällde kopplingen bara företag som råkade få rätt ansvarig från
  // början — alla senare byten lämnade personallistan tom.
  const u3Before = (STORE.User.find((u) => u._id === "u3")["Associated_company"] || []).slice();
  const patAns = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { fields: { ansvarig: "u2" } } });
  ok("byte av ansvarig: den nya knyts till kunden",
     patAns.body.ok === true && patAns.body.ansvarig_kopplad === true &&
     (STORE.User.find((u) => u._id === "u2")["Associated_company"] || []).indexOf("cc3") > -1);
  // ⚠️ Den GAMLA ska INTE kopplas bort (Christians beslut) — hen kan fortfarande
  // vara involverad i kunden.
  ok("byte av ansvarig: den gamla kopplingen rörs inte",
     JSON.stringify((STORE.User.find((u) => u._id === "u3")["Associated_company"] || [])) === JSON.stringify(u3Before));
  // Rensa ansvarig → inget att knyta
  const patClr = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { fields: { ansvarig: "" } } });
  ok("byte av ansvarig: rensning knyter ingen", patClr.body.ok === true && patClr.body.ansvarig_kopplad === undefined);
  // Patch som inte rör ansvarig alls
  const patOther = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { fields: { orgnr: "5560001111" } } });
  ok("patch utan ansvarig rör inte kopplingen", patOther.body.ok === true && patOther.body.ansvarig_kopplad === undefined);
  // Redan knuten → ingen onödig skrivning
  const wBefore = userPatches;
  const patAgain = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { fields: { ansvarig: "u2" } } });
  ok("byte av ansvarig: redan knuten → true men ingen ny skrivning (noll WU)",
     patAgain.body.ansvarig_kopplad === true && userPatches === wBefore);

  ok("skapa: företaget syns i listan direkt (cachen uppdaterad)",
     efter.body.total === 1 && efter.body.rows[0].id === nf1.body.id);

  ok("skapa: namn krävs", (await nyF({ orgnr: "5569999999" })).body.error === "namn_krävs");
  ok("skapa: org.nr krävs", (await nyF({ name: "Utan orgnr" })).body.error === "orgnr_krävs");
  const nfLen = await nyF({ name: "Kort orgnr", orgnr: "12345" });
  ok("skapa: org.nr måste ha 10 siffror", nfLen.code === 400 && nfLen.body.error === "orgnr_fel_langd" && nfLen.body.digits === 5);

  // ⚠️ Dubblettspärren: samma org.nr i ANNAT format ska ändå fångas.
  const nfDup = await nyF({ name: "Nytt Bolag Igen AB", orgnr: "556123-4567" });
  ok("skapa: samma org.nr med bindestreck fångas som dubblett → 409 + pekar ut befintligt",
     nfDup.code === 409 && nfDup.body.error === "orgnr_finns_redan" &&
     nfDup.body.existing && nfDup.body.existing.id === nf1.body.id);
  const nfForce = await nyF({ name: "Nytt Bolag Igen AB", orgnr: "556123-4567", force: true });
  ok("skapa: force:true går förbi spärren men redovisar dubbletten",
     nfForce.body.ok === true && nfForce.body.forced_duplicate && nfForce.body.forced_duplicate.id === nf1.body.id);
  // ⚠️ Namnlikhet VARNAR men spärrar aldrig — två bolag kan legitimt heta nästan lika.
  const nfName = await nyF({ name: "nytt  bolag ab", orgnr: "5567777777" });
  ok("skapa: identiskt namn varnar men blockerar inte",
     nfName.body.ok === true && (nfName.body.name_warnings || []).length >= 1);
  // Option-set valideras mot facetterna, som inline-editen
  const nfBadOS = await nyF({ name: "Bad OS", orgnr: "5568888888", kundstatus: "Hittepå" });
  // ⚠️ Bubbles verkliga orsak måste nå UI:t — `e.message` är alltid "bubbleCreate
  // failed". Utan hint står användaren med ett fel som inte säger vad som är fel.
  const typDeps = Object.assign({}, deps, {
    bubbleCreate: async () => {
      const e = new Error("bubbleCreate failed");
      e.detail = { status: 400, body: JSON.stringify({ body: { status: "INVALID_DATA", message: "Invalid data for field Org_Number: Expected a string, but got a number" } }) };
      throw e;
    },
  });
  const tys = mk(); registerCompaniesRoutes(tys.app, typDeps);
  const ty = await call(tys.routes, "post", "/admin/companies/create", { body: { name: "Hint-test", orgnr: "5560000000" } });
  ok("skapa: Bubbles faktiska felmeddelande når fram som hint",
     ty.body.ok !== true && /Expected a string, but got a number/.test(ty.body.hint || ""));

  ok("skapa: okänt kundstatus-värde → 400 med allowed",
     nfBadOS.code === 400 && /unknown_optionset_value/.test(nfBadOS.body.error) && (nfBadOS.body.allowed || []).length > 0);

  // ── FRONTEND ──────────────────────────────────────────────────────────────
  ok("frontend: + Nytt företag finns i listvyn",
     /data-fl="newco"/.test(fl) && /function newCoFormHtml/.test(fl) && /function saveNewCo/.test(fl));
  ok("frontend: org.nr är obligatoriskt i formuläret",
     /Org\.nr \*/.test(fl) && /Ange org\.nr/.test(fl));
  // ⚠️ Dubblett ska erbjuda att ÖPPNA det befintliga, inte bara neka.
  ok("frontend: dubblett visar befintligt företag med öppna-knapp + skapa-ändå",
     /orgnr_finns_redan/.test(fl) && /data-fl="newco-open"/.test(fl) && /data-fl="newco-force"/.test(fl));

  // ── "Per månad" i avtalsrubriken visade 0 (löst 2026-08-24) ───────────────
  // ⚠️ Summeringen filtrerade på contract_type==='Subscription' och uteslöt därmed
  // HYBRID-avtal, som per definition har en fast månadsdel. Sambla: rubriken sa
  // 0 kr medan raden under sa 124 560 kr och kortets KPI sa 124 560 kr.
  ok("avtal: per månad-summan filtrerar INTE på contract_type",
     !/contract_type === 'Subscription' && \(c\.status === 'aktiv'/.test(fl) &&
     /filter\(function \(c\) \{ return c\.status === 'aktiv' \|\| c\.status === 'utgar_snart'; \}\)\s*\n\s*\.reduce/.test(fl));
  // ⚠️ Frontend och backend måste räkna samma sak, annars visar samma vy två tal.
  ok("avtal: samma regel som backend (aktivt → summera månadskostnad)",
     /if \(isActive\) \{ active\+\+; mrr \+= Math\.round\(Number\(ct\["månadskostnad"\] \|\| 0\)\); \}/
       .test(readFileSync(new URL("./companies_api.js", import.meta.url), "utf8")));

  // ── Offert-blocket i affärsvyn: EN bindning för host+token ────────────────
  // ⚠️ Den inflyttade kopian bar sin egen placeholder-token → 401 på ALLT, och
  // `.catch(() => [])` gjorde felet till "Inga företag" i företagssöket.
  const afRaw = readFileSync(new URL("./mira-affar-samlad.html", import.meta.url), "utf8");
  ok("offert i affärsvyn: exakt EN planning_token-bindning i blocket",
     (afRaw.match(/<input[^>]*data-mira="planning_token"/g) || []).length === 1);
  ok("offert i affärsvyn: cfg faller tillbaka på värdblockets bindning",
     /var g=document\.querySelector\('\[data-mira="'\+k\+'"\]'\);/.test(afRaw));
  ok("offert i affärsvyn: företagssöket rapporterar fel i st.f. tom lista",
     /companiesError/.test(afRaw) && /401 — fel eller saknad token/.test(afRaw) &&
     /Kunde inte hämta företagslistan/.test(afRaw) &&
     !/\.catch\(function\(\)\{ companiesPromise=null; return \[\]; \}\)/.test(afRaw));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
