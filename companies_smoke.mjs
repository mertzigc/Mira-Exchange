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
    // ⚠️ BÅDA bildfälten satta, med OLIKA värden (2026-08-27). Prodilbild ska vinna.
    // En fixture med bara ett fält hade inte kunnat uttrycka fel läs-ordning.
    // ⚠️ VERSALER i Email (2026-08-27). Ossians rad hade "Ossian.Eliasson@avtalat.se"
    // medan User.email är gemener → Bubbles skiftlägeskänsliga `equals` missade och
    // Min sida sa "ingen kopplad medarbetare". Fixturen var lowercase i båda ändar
    // och kunde därför inte uttrycka felet — den var snällare än Bubble.
    { _id: "co1", "Kundföretag": "cc1", "Förnamn": "Testare", "Efternamn": "Testsson", Titel: "Projektledare", Email: "Christian.Mertzig@Gmail.com", Telefon: 755678900, crm_info: "Nyckelkontakt", Avdelning: "Försäljning", Kontor: "of1", Prodilbild: "//files/co1.jpg", Foto: "//files/PENSIONERAD.jpg" },  // har User (matchar u1) + bild i båda fälten
    { _id: "co2", "Kundföretag": "cc1", "Förnamn": "Rena", "Efternamn": "Kontakt", Email: "rena@acme.se" },  // ren CRM-kontakt
    // ⚠️ SKARPT FALL (Christians skärmbild 2026-08-26): personer UTAN Efternamn finns
    // (Kajsas i Parken: "Elaine", "Melissa"; Mariebo: "Dennis"). Sorterar man i Bubble
    // på Efternamn fälls de TYST ([[reference-bubble-sort-drops-empty]]). Fixturen måste
    // kunna uttrycka felet — annars är den mer förlåtande än verkligheten.
    { _id: "co3", "Kundföretag": "cc2", "Förnamn": "Elaine", Email: "elaine@beta.se", Foto: "//files/legacy_co3.jpg" },  // inget Efternamn + annat företag + BARA pensionerat Foto (fallback-fallet)
    // ⚠️ E-posten MÅSTE vara u3:s (cilla@), inte u2:s (bo@) — mypage-sviten bevisar att en
    // User UTAN kopplad Coworker inte kraschar, och den använder u2. Ger vi u2 en Coworker
    // här testar den svitens "utan koppling"-fall en värld som inte längre finns.
    { _id: "co4", "Kundföretag": "cc2", "Förnamn": "Cilla", "Efternamn": "Berg", Email: "cilla@carotte.se", Avdelning: "IT", Telefon: 701234567 },   // har User (u3) via e-post
    { _id: "co5", "Kundföretag": "cc3", "Förnamn": "Zeb", "Efternamn": "Zoo", Email: "" },                     // ingen e-post → aldrig konto
    { _id: "co6", "Förnamn": "Ingen", "Efternamn": "Utan", Email: "utan@x.se" },                               // INGET Kundföretag → company/ansvarig måste bli tomma, inte krascha
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
STORE.consent = [];   // Min sida-godkännanden skapas här
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
  // Verifierat User-schema (skärmdump 2026-08-25). Min sida skriver bara de fyra
  // profilfälten + Consent; övriga listas för att INTE bryta befintliga patcher
  // (Associated_company). email/Email/lösenord skrivs ALDRIG härifrån.
  User: ["First Name", "Surname", "Title_user", "Phone_user", "email", "Email", "Company", "Associated_company", "User_role", "Consent"],
  // Coworker-fält som CO_EDITABLE + create + foto + Min sida-spegling faktiskt skriver.
  // Prodilbild = kanonisk skrivnyckel för profilbild (2026-08-27). "Foto" står kvar
  // ENBART för att upload/clear nollar det pensionerade fältet — inget skriver dit ett värde.
  Coworker: ["Förnamn", "Efternamn", "Titel", "Email", "Telefon", "crm_info", "Avdelning", "Kontor", "Prodilbild", "Foto", "Kundföretag"],
  // consent (Min sida): Användarvillkor(file, skrivs ej), Godkänt(OS), User(ref).
  consent: ["Godkänt", "User", "Användarvillkor"],
};
// ⚠️ TYPER som skiljer sig mellan objekt är Org_Number-fällan (2026-08-24) i ny form:
// User.Phone_user är TEXT, Coworker.Telefon är NUMBER. En spegling som skriver fel typ
// åt något håll 400:ar skarpt — mocken måste avvisa likadant, annars testar vi en
// påhittad värld. Skip null (rensning). Option set Godkänd: bara Ja/Nej.
const PATCH_TYPES = {
  User: { "Phone_user": "string", "First Name": "string", "Surname": "string", "Title_user": "string" },
  Coworker: { "Telefon": "number" },
};
const OPTIONSET_VALUES = { consent: { "Godkänt": ["Ja", "Nej"] } };
function _typeReject(t, payload, kind) {
  const spec = PATCH_TYPES[t];
  if (spec) {
    for (const [f, want] of Object.entries(spec)) {
      if (payload[f] === undefined || payload[f] === null) continue;
      if (typeof payload[f] !== want) {
        const e = new Error(kind + " failed");
        e.detail = { status: 400, body: JSON.stringify({ body: { status: "INVALID_DATA", message: "Invalid data for field " + f + ": Expected a " + want + ", but got a " + typeof payload[f] } }) };
        throw e;
      }
    }
  }
  const os = OPTIONSET_VALUES[t];
  if (os) {
    for (const [f, allowed] of Object.entries(os)) {
      if (payload[f] === undefined || payload[f] === null) continue;
      if (allowed.indexOf(String(payload[f])) < 0) {
        const e = new Error(kind + " failed");
        e.detail = { status: 400, body: JSON.stringify({ body: { status: "ERROR", message: "could not parse " + payload[f] + " as option set value for " + f } }) };
        throw e;
      }
    }
  }
}
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
    _typeReject(t, payload || {}, "bubblePatch");
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
    // Okänt fält + option-set-värde avvisas som Bubble (consent.Godkänt = Ja/Nej).
    const knownC = KNOWN_FIELDS[t];
    if (knownC) {
      const badC = Object.keys(payload || {}).filter((k) => knownC.indexOf(k) < 0);
      if (badC.length) { const e = new Error("bubbleCreate failed"); e.detail = { status: 400, body: JSON.stringify({ body: { status: "ERROR", message: "Unrecognized field: " + badC[0] } }) }; throw e; }
    }
    _typeReject(t, payload || {}, "bubbleCreate");
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
// headers stöds sedan 2026-08-27: kundens Min sida-ingång auth:ar på x-mypage-token,
// och utan dem hade varje token-test tyst blivit "ingen header → 401" i stället för
// att testa det det påstår sig testa.
function call(routes, method, path, { query = {}, params = {}, body = {}, file = undefined, headers = {} } = {}) {
  // ⚠️ Saknad route får INTE kasta. Vid mutationstest (gammal kod utan den nya
  // endpointen) dog hela sviten på första anropet och dolde alla följande fel —
  // samma klass av tyst missvisning som en assertion som kraschar i st.f. att falla.
  // Nu svarar den 404 så testet FALLER begripligt.
  const h = routes[method][path];
  if (!h) return Promise.resolve({ code: 404, body: { ok: false, error: "no_route", route: method + " " + path } });
  return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } }; h({ params, query, body, file, headers }, res); });
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
  ok("coworker namn/titel/email/telefon", coTest.name === "Testare Testsson" && coTest.title === "Projektledare" && coTest.email === "Christian.Mertzig@Gmail.com" && coTest.phone === "755678900");
  ok("coworker crm_info/avdelning/kontor resolvat", coTest.crm_info === "Nyckelkontakt" && coTest.avdelning === "Försäljning" && coTest.kontor_id === "of1" && coTest.kontor === "CMIAB Sthlm");
  ok("coworker foto (https-normaliserat) + tom när saknas", coTest.foto === "https://files/co1.jpg" && coRen.foto === "");
  // ⚠️ Prodilbild MÅSTE vinna över det pensionerade Foto. Faller detta visar kortet
  // en gammal bild som ingen längre underhåller.
  ok("coworker bild: Prodilbild slår pensionerat Foto", coTest.foto === "https://files/co1.jpg" && coTest.foto.indexOf("PENSIONERAD") === -1);
  ok("coworkers svar bär offices + departments", cw.body.offices.length === 2 && cw.body.offices[0].name === "CMIAB Göteborg" && cw.body.departments.indexOf("Försäljning") > -1);
  ok("coworker has_user (email matchar User vars Company==företaget)", coTest.has_user === true && coTest.user_id === "u1");
  ok("ren coworker = CRM-kontakt (has_user false)", coRen.has_user === false && coRen.user_id === null);
  // ── LÖSENORDS-RESET (eget token-flöde) ──
  STORE.PasswordReset.length = 0; STORE.emailqueue.length = 0;
  var pw = await call(s.routes, "post", "/admin/companies/coworker/:id/send-password", { params: { id: "co1" } });
  // ⚠️ E-posten går ut SOM DEN STÅR på Coworker-raden — inklusive versaler. Reset-flödet
  // skickar den vidare till Bubble-wf:en assign_temp_password som slår upp User på den.
  // User.email är alltid gemener (Bubble normaliserar auth-mail), så matchningen vilar på
  // att Bubbles egen search är skiftlägesokänslig. Håller inte det antagandet får en
  // Coworker med versal-mail ingen reset. EJ verifierat mot skarp Bubble — se HANDOFF.
  ok("send-password ok + email (versaler bevaras)", pw.body.ok && pw.body.email === "Christian.Mertzig@Gmail.com");
  ok("send-password skapade PasswordReset + emailqueue", STORE.PasswordReset.length === 1 && STORE.emailqueue.length === 1);
  var eq = STORE.emailqueue[0];
  ok("emailqueue: rätt template_id + email_sent false", eq.template_id === "tpl_pw" && eq.email_sent === false);
  var ed = JSON.parse(eq.extra_data);
  ok("emailqueue extra_data har reset_url med token", /\/reset_pw\?t=[a-f0-9]{48}$/.test(ed.reset_url));
  var rawTok = ed.reset_url.split("t=")[1];
  ok("PasswordReset: token_hash satt, used false, coworker=co1", STORE.PasswordReset[0].token_hash && STORE.PasswordReset[0].used === false && STORE.PasswordReset[0].coworker === "co1");

  // exchange: byt token mot temp
  var ex = await call(s.routes, "post", "/admin/reset-password/exchange", { body: { token: rawTok } });
  ok("exchange ok → email + temp_password", ex.body.ok && ex.body.email === "Christian.Mertzig@Gmail.com" && ex.body.temp_password === "TMP-Christian.Mertzig@Gmail.com");
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

  // ── PROFILBILD (Coworker.Prodilbild): sätt / rensa / valideringar ──
  var ph = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, file: { buffer: Buffer.from("abc"), mimetype: "image/png" } });
  ok("photo upload ok → url + Prodilbild satt på Coworker", ph.body.ok && ph.body.url === "https://files/coworker_co2_foto.png" && STORE.Coworker[1].Prodilbild === "https://files/coworker_co2_foto.png");
  // ⚠️ Uppladdning måste också nolla det pensionerade fältet — annars bär raden två bilder.
  ok("photo upload → pensionerat Foto nollat", STORE.Coworker[1].Foto === "");
  var phClr = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, body: { clear: "1" } });
  // ⚠️ BÅDA fälten. Töms bara Prodilbild återuppstår en gammal Foto-bild via läs-fallbacken
  // och "Ta bort" ser ut att inte fungera.
  ok("photo clear → BÅDA bildfälten tömda", phClr.body.ok && phClr.body.url === "" && STORE.Coworker[1].Prodilbild === "" && STORE.Coworker[1].Foto === "");
  var phNo = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, body: {} });
  ok("photo utan fil (ej clear) → 400 no_file", phNo.code === 400 && phNo.body.error === "no_file");
  var phBad = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "co2" }, file: { buffer: Buffer.from("x"), mimetype: "application/pdf" } });
  ok("photo icke-bild → 400 not_image", phBad.code === 400 && phBad.body.error === "not_image");
  var ph404 = await call(s.routes, "post", "/admin/companies/coworker/:id/photo", { params: { id: "nope" }, file: { buffer: Buffer.from("x"), mimetype: "image/jpeg" } });
  ok("photo okänd coworker → 404", ph404.code === 404);

  // ── HISTORIK: skapa + redigera aktivitet (activitet_crm) ──
  var abefore = STORE.activitet_crm.length;
  // ⚠️ genomfort:true kräver nu ett nästa steg (grinden 2026-08-21) — utan det 400:ar den.
  var hc = await call(s.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "Nytt möte", fas: "Fas 3", motesdatum: "2026-08-20", genomfort: true, motesanteckning: "Genomgång", nasta_steg: "avslutat", nasta_steg_kommentar: "Kunden valde konkurrent" } });
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

  // ══════════ PERSONER — global personlista (/admin/persons/list) ══════════
  // Läget här: co1 Testsson(cc1, Kontor of2, har User u1) · co2 Kontakt(cc1) · co3 Elaine(cc2,
  // INGET efternamn) · co4 Berg(cc2, Avdelning IT, har User u3) · co5 Zoo(cc3) · co6 Utan(INGET
  // företag) · new_N Ny/Nils(cc1, skapad av create-testet). Totalt 7.
  // ⚠️ Assertions får INTE hårdkoda företagsnamn/ansvarig: 390 tester har redan patchat
  // cc2:s namn och satt Kundansvarig på cc3. Vi jämför därför mot cacharnas FAKTISKA
  // innehåll — det testar resolveringen, inte fixturens ursprungstillstånd.
  findAllCalls.length = 0;
  getCalls.length = 0;
  var pl = await call(s.routes, "get", "/admin/persons/list");
  ok("persons/list ok + 7 personer över alla företag", pl.body.ok && pl.body.total === 7 && pl.body.rows.length === 7);

  // ⚠️ KÄRNTESTET: personen utan Efternamn (co3 Elaine) MÅSTE finnas kvar. Sorteras det
  // i Bubble på Efternamn fälls hon tyst → total blir 5 och detta test faller.
  var harElaine = pl.body.rows.filter(function (r) { return r.id === "co3"; });
  ok("persons: person UTAN efternamn finns kvar i listan (sort_field-fällan)", harElaine.length === 1);
  var ordning = pl.body.rows.map(function (r) { return r.last || "(tom)"; });
  ok("persons: sorterad på efternamn, tomma SIST", JSON.stringify(ordning) === JSON.stringify(["Berg", "Kontakt", "Ny", "Testsson", "Utan", "Zoo", "(tom)"]));

  // Företagsnamn + kundansvarig hämtas ur de delade cacharna (noll Bubble-anrop)
  var rBerg = pl.body.rows.filter(function (r) { return r.id === "co4"; })[0];
  var cc2Now = FULL.get("cc2") || {};
  var ansvNow = STORE.User.filter(function (u) { return u._id === cc2Now.ansvarig_id; })[0] || {};
  var ansvNamn = ((ansvNow["First Name"] || "") + " " + (ansvNow["Surname"] || "")).trim();
  ok("persons: company + ansvarig resolvade ur de delade cacharna", rBerg.company === cc2Now.name && rBerg.ansvarig === ansvNamn && !!cc2Now.name);
  var rUtan = pl.body.rows.filter(function (r) { return r.id === "co6"; })[0];
  ok("persons: person utan Kundföretag → tom company/ansvarig (inte krasch)", rUtan.company === "" && rUtan.ansvarig === "" && rUtan.company_id === null);

  // has_user via _users().byEmail (delad TTL-cache) — inte ett User-svep per företag
  ok("persons: has_user satt för co1(u1) + co4(u3), inte för de andra",
    pl.body.rows.filter(function (r) { return r.has_user; }).map(function (r) { return r.id; }).sort().join(",") === "co1,co4");

  // Kontorsnamn resolvas BARA för sidan, och cachas per office-id
  var rTest = pl.body.rows.filter(function (r) { return r.id === "co1"; })[0];
  ok("persons: kontorsnamn resolvat för raden", rTest.kontor === "CMIAB Göteborg" && rTest.kontor_id === "of2");
  var officeGets1 = getCalls.filter(function (g) { return g.t === "Office"; }).length;
  var coSweeps1 = findAllCalls.filter(function (c) { return c.t === "Coworker"; }).length;
  ok("persons: ETT Coworker-svep på första anropet", coSweeps1 === 1);

  // WU: andra anropet (paginering/sök) får INTE svepa Coworker igen — TTL-cache.
  var pl2 = await call(s.routes, "get", "/admin/persons/list", { query: { page: "1", limit: "10" } });
  var coSweeps2 = findAllCalls.filter(function (c) { return c.t === "Coworker"; }).length;
  var officeGets2 = getCalls.filter(function (g) { return g.t === "Office"; }).length;
  ok("persons: andra anropet gör INGET nytt Coworker-svep (TTL-cache)", pl2.body.ok && coSweeps2 === 1);
  ok("persons: kontorsnamn cachas per office-id (inga nya bubbleGet)", officeGets2 === officeGets1);

  // Sök/filter — allt i minnet mot cachen
  var pQ = await call(s.routes, "get", "/admin/persons/list", { query: { q: "elaine" } });
  ok("persons: namnsök träffar även den utan efternamn", pQ.body.total === 1 && pQ.body.rows[0].id === "co3");
  var pQ2 = await call(s.routes, "get", "/admin/persons/list", { query: { q: "testsson" } });
  ok("persons: namnsök matchar efternamn", pQ2.body.total === 1 && pQ2.body.rows[0].id === "co1");
  var pMail = await call(s.routes, "get", "/admin/persons/list", { query: { email: "cilla@carotte.se" } });
  ok("persons: e-postsök → co4", pMail.body.total === 1 && pMail.body.rows[0].id === "co4");
  var pCo = await call(s.routes, "get", "/admin/persons/list", { query: { company: "beta" } });
  ok("persons: företagsnamn-sök → cc2:s två personer", pCo.body.total === 2 && pCo.body.rows.map(function (r) { return r.id; }).sort().join(",") === "co3,co4");
  var pCid = await call(s.routes, "get", "/admin/persons/list", { query: { company_id: "cc2" } });
  ok("persons: company_id-scope (återbruk för kundkort/besöksmodul) → samma två", pCid.body.total === 2);
  var pAvd = await call(s.routes, "get", "/admin/persons/list", { query: { avdelning: "IT" } });
  ok("persons: avdelningsfilter → co4", pAvd.body.total === 1 && pAvd.body.rows[0].id === "co4");
  var pKontoJa = await call(s.routes, "get", "/admin/persons/list", { query: { konto: "yes" } });
  ok("persons: konto=yes → 2 (co1+co4)", pKontoJa.body.total === 2);
  var pKontoNej = await call(s.routes, "get", "/admin/persons/list", { query: { konto: "no" } });
  ok("persons: konto=no → 5 (resten)", pKontoNej.body.total === 5);

  // Facetter härleds UR DATAN (som drift-prioriteter/roller) — aldrig hårdkodade
  ok("persons: facets.avdelningar härledd ur datan + sorterad", pl.body.facets.avdelningar.indexOf("IT") > -1 && JSON.stringify(pl.body.facets.avdelningar) === JSON.stringify(pl.body.facets.avdelningar.slice().sort()));
  ok("persons: departments (option-set) + roles följer med för redigering/kontoskapande", pl.body.departments.length > 0 && Array.isArray(pl.body.roles));

  // Paginering
  var pPag = await call(s.routes, "get", "/admin/persons/list", { query: { limit: "10", page: "2" } });
  ok("persons: limit-golv 10 → 1 sida, sida 2 tom", pPag.body.pages === 1 && pPag.body.rows.length === 0);

  // ⚠️ Cache-invalidering: en redigering måste synas DIREKT i den globala listan.
  // Utan _coworkersForget() i PATCH:en visar listan gammal data i upp till en timme
  // (samma klass som [[reference-bubble-vy-cache-slapar]]).
  await call(s.routes, "patch", "/admin/companies/coworker/:id", { params: { id: "co5" }, body: { fields: { title: "Zoolog" } } });
  var pAfter = await call(s.routes, "get", "/admin/persons/list", { query: { q: "zoo" } });
  var coSweeps3 = findAllCalls.filter(function (c) { return c.t === "Coworker"; }).length;
  ok("persons: PATCH invaliderar cachen → nytt svep + ny titel syns", coSweeps3 === 2 && pAfter.body.rows[0].title === "Zoolog");

  // ── "+ Ny person": företagsväljare + create ──────────────────────────────────
  // Den globala vyn saknar kundkortets implicita bolag → create kräver ett val.
  // Sökningen går mot companyFullMap (förvärmd) — INGA Bubble-anrop.
  findAllCalls.length = 0;
  var pc = await call(s.routes, "get", "/admin/persons/companies", { query: { q: "acme" } });
  ok("persons/companies: söker i cachen → träff", pc.body.ok && pc.body.items.length === 1 && pc.body.items[0].id === "cc1");
  ok("persons/companies: NOLL Bubble-svep (bara cache-uppslag)", findAllCalls.length === 0);
  var pcAll = await call(s.routes, "get", "/admin/persons/companies");
  ok("persons/companies: utan q → alla bolag, namnsorterade", pcAll.body.items.length >= 3 && pcAll.body.items[0].name.localeCompare(pcAll.body.items[1].name, "sv") <= 0);
  var pcMiss = await call(s.routes, "get", "/admin/persons/companies", { query: { q: "finnsinte" } });
  ok("persons/companies: utan träff → tom lista (inte fel)", pcMiss.body.ok && pcMiss.body.items.length === 0);
  var pcLim = await call(s.routes, "get", "/admin/persons/companies", { query: { limit: "1" } });
  ok("persons/companies: limit respekteras men total visar hela träffmängden", pcLim.body.items.length === 1 && pcLim.body.total > 1);

  // create via den globala vyn: samma endpoint som kundkortet, men med valt bolag.
  var nyBefore = STORE.Coworker.length;
  var nyOk = await call(s.routes, "post", "/admin/companies/:id/coworker/create", { params: { id: "cc2" }, body: { first: "Ny", last: "Global", email: "ny@beta.se", phone: "070-999 88 77", title: "Kontakt" } });
  ok("persons: create mot valt bolag → Coworker på cc2 med Telefon=number", nyOk.body.ok && STORE.Coworker.length === nyBefore + 1 && STORE.Coworker[STORE.Coworker.length - 1]["Kundföretag"] === "cc2" && STORE.Coworker[STORE.Coworker.length - 1].Telefon === 709998877);
  var pNy = await call(s.routes, "get", "/admin/persons/list", { query: { q: "global" } });
  ok("persons: create invaliderar cachen → nya personen syns direkt i listan", pNy.body.total === 1 && pNy.body.rows[0].company_id === "cc2");

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
  const g6 = await nsPatch(g4id, { genomfort: true, motesanteckning: "Klart", nasta_steg: "avslutat", nasta_steg_kommentar: "Kunden valde konkurrent" });
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
  const nf = await call(nfs.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "Möte utan fält", genomfort: true, nasta_steg: "avslutat", nasta_steg_kommentar: "Kunden valde konkurrent" } });
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
  const of2 = await call(ofs.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "x", genomfort: true, nasta_steg: "avslutat", nasta_steg_kommentar: "Kunden valde konkurrent" } });
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

  // ══════════════════════════════════════════════════════════════════════════
  // MOTIVERING VID AVSLUTAT SPÅR (2026-08-26) — kundkortets Historik
  // ⚠️ Kravet gäller i ALLA TRE skrivarna. Grindades bara mötestratten hade man
  // kunnat avsluta spåret utan motivering härifrån i stället.
  // ⚠️ Bubble-fält: `nasta_steg_kommentar` (TEXT, inte option set).
  // ══════════════════════════════════════════════════════════════════════════
  const kk1 = await nsCreate({ activity_type: "Kundmöte", beskrivning: "Avslutas", genomfort: true, nasta_steg: "avslutat" });
  ok("kortet: avslutat utan motivering → 400 avslut_kommentar_krävs",
     kk1.code === 400 && (kk1.body || {}).error === "avslut_kommentar_krävs" && (kk1.body || {}).min === 3);
  const kkBefore = STORE.activitet_crm.length;
  const kk2 = await nsCreate({ activity_type: "Kundmöte", beskrivning: "Avslutas", genomfort: true, nasta_steg: "avslutat", nasta_steg_kommentar: "ok" });
  ok("kortet: för kort motivering → 400 och INGEN rad skapad",
     kk2.code === 400 && STORE.activitet_crm.length === kkBefore);
  const kk3 = await nsCreate({ activity_type: "Kundmöte", beskrivning: "Avslutas", genomfort: true, nasta_steg: "avslutat", nasta_steg_kommentar: "  Budget drogs in  " });
  const kkRow = STORE.activitet_crm[STORE.activitet_crm.length - 1];
  ok("kortet: med motivering → sparas trimmad i rätt fält + exponeras på raden",
     kk3.body.ok === true && kkRow["nasta_steg_kommentar"] === "Budget drogs in" &&
     ((kk3.body || {}).row || {}).nasta_steg_kommentar === "Budget drogs in");
  ok("kortet: båda saknat-flaggorna är false när fälten finns",
     (kk3.body || {}).nasta_steg_field_missing === false && (kk3.body || {}).avslut_kommentar_field_missing === false);
  // ⚠️ Får inte hänga på att sparningen rör avklarandet — annars slipper en patch
  // som BARA sätter avslutat igenom utan motivering.
  const kk4 = await nsPatch(g4id, { nasta_steg: "avslutat" });
  ok("kortet: patch som BARA sätter avslutat grindas också",
     kk4.code === 400 && (kk4.body || {}).error === "avslut_kommentar_krävs");
  // ⚠️ Saknat kommentarsfält får INTE ta med sig beslutet i fallet (Bubble avvisar
  // hela skrivningen vid ett okänt fält → fälten måste droppas ETT i taget).
  const noKommDeps = Object.assign({}, deps, {
    bubbleCreate: async (t, payload) => {
      if (t === "activitet_crm" && payload && payload.nasta_steg_kommentar !== undefined) {
        const e = new Error("bubbleCreate failed");
        e.detail = { status: 400, body: JSON.stringify({ body: { status: "ERROR", message: "Unrecognized field: nasta_steg_kommentar" } }) };
        throw e;
      }
      return deps.bubbleCreate(t, payload);
    },
  });
  const nks = mk(); registerCompaniesRoutes(nks.app, noKommDeps);
  const nk = await call(nks.routes, "post", "/admin/companies/:id/historik/create", { params: { id: "cc1" }, body: { activity_type: "Kundmöte", beskrivning: "Utan kommentarsfält", genomfort: true, nasta_steg: "avslutat", nasta_steg_kommentar: "Fel tajming" } });
  const nkRow = STORE.activitet_crm[STORE.activitet_crm.length - 1];
  ok("kortet: saknat kommentarsfält stoppar INTE beslutet, och rapporteras separat",
     nk.body.ok === true && nkRow["aktivitet_nasta_steg"] === "avslutat" &&
     (nk.body || {}).avslut_kommentar_field_missing === true && (nk.body || {}).nasta_steg_field_missing === false);

  // ── FRONTEND (mira-foretag-lista.html) ────────────────────────────────────
  ok("frontend kort: avsluta-formuläret har ett obligatoriskt varför-fält",
     /data-nsform="avslutat"/.test(fl) && /data-nf="x_varfor"/.test(fl) && /Varför avslutas spåret\? \*/.test(fl));
  ok("frontend kort: kort motivering blockerar sparningen",
     /if\(why\.length<3\) return \{ error:/.test(fl));
  ok("frontend kort: motiveringen skickas till servern",
     /if\(ns\.kommentar\) p\.nasta_steg_kommentar=ns\.kommentar;/.test(fl));
  ok("frontend kort: saknat kommentarsfält rapporteras SEPARAT från beslutet",
     /avslut_kommentar_field_missing/.test(fl) && /MOTIVERINGEN lagrades INTE/.test(fl));

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
  // ⚠️ Kopplingen kan LYCKAS utan att personen syns under "Vår personal" — den
  // listan filtrerar på Company === user_company. Utan varning blir det en tyst
  // motsägelse: ansvaret satt, personen osynlig. (Bet oss skarpt 2026-08-24:
  // ansvarig byttes till en person som aldrig dök upp i listan.)
  const patUtanfor = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc3" }, body: { fields: { ansvarig: "u1" }, user_company: "cc2" } });
  ok("byte av ansvarig: person utanför bolaget knyts MEN flaggas",
     patUtanfor.body.ok === true && patUtanfor.body.ansvarig_kopplad === true &&
     patUtanfor.body.ansvarig_utanfor_bolaget &&
     (STORE.User.find((u) => u._id === "u1")["Associated_company"] || []).indexOf("cc3") > -1);
  ok("byte av ansvarig: varningen bär personens namn",
     /Anna/.test(String(patUtanfor.body.ansvarig_utanfor_bolaget)));
  const patInom = await call(s.routes, "patch", "/admin/companies/:id", { params: { id: "cc2" }, body: { fields: { ansvarig: "u3" }, user_company: "cc2" } });
  ok("byte av ansvarig: person INOM bolaget flaggas inte",
     patInom.body.ansvarig_kopplad === true && patInom.body.ansvarig_utanfor_bolaget === undefined);
  // ⚠️ VY-INVALIDERING (2026-08-24). Byte av kundansvarig ändrar två vyer UTANFÖR
  // den man står i: "Vår personal" och onboarding-chippet. Båda cachas i STATE och
  // nollställs bara när man klickar in på under-fliken — ett vanligt flikbyte gör
  // det inte. Följd: man bytte ansvarig, gick till Leverantörer, såg en GAMMAL lista
  // och drog slutsatsen att kopplingen inte fungerade. Bevisat i harness: utan
  // invalideringen har servern två kopplade medan vyn visar en.
  ok("frontend: byte av ansvarig invaliderar Vår personal OCH onboarding",
     /function invalideraAnsvarigVyer\(\)/.test(fl) &&
     /STATE\.setupLev=null;\s*\/\/ Vår personal hämtas om/.test(fl) &&
     /STATE\.onboarding=null;\s*\/\/ Carotte-medarbetare-chippet räknas om/.test(fl) &&
     (fl.match(/if\(j\.ansvarig_kopplad !== undefined\) invalideraAnsvarigVyer\(\);/g) || []).length === 2);
  ok("frontend: user_company skickas i PATCH och varningen visas i båda editvägarna",
     /user_company:cfg\("user_company"\)/.test(fl) &&
     (fl.match(/ansvarig_utanfor_bolaget/g) || []).length >= 2 &&
     /syns ej under Vår personal/.test(fl));

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

  // ══════════════════════════════════════════════════════════════════════════
  // KUNDANSVARIG = ALLTID EN CAROTTARE (2026-08-24)
  // ⚠️ `_users()` sveper HELA User-tabellen — där ligger även kundernas egna
  // inloggningar. Utan filtret kunde man sätta en kundanvändare som kundansvarig,
  // och då gick hen inte att se under "Vår personal" (som filtrerar på samma
  // company) → ansvaret fanns men personen syntes ingenstans. Samma bugg, två ytor.
  // ══════════════════════════════════════════════════════════════════════════
  const metaAll = await call(s.routes, "get", "/admin/companies/meta");
  const metaOurs = await call(s.routes, "get", "/admin/companies/meta", { query: { user_company: "cc2" } });
  ok("kundansvarig: utan user_company listas alla + flaggan sätts",
     (metaAll.body.users || []).length === 3 && metaAll.body.users_unfiltered === true);
  ok("kundansvarig: med user_company listas BARA våra egna",
     (metaOurs.body.users || []).length === 2 &&
     (metaOurs.body.users || []).every(function (x) { return x.id === "u2" || x.id === "u3"; }) &&
     metaOurs.body.users_unfiltered === undefined);
  // ⚠️ u1 är kundens EGEN user (Company cc1) — får aldrig kunna väljas som ansvarig.
  ok("kundansvarig: kundens egen user filtreras bort",
     !(metaOurs.body.users || []).some(function (x) { return x.id === "u1"; }));
  const listOurs = await call(s.routes, "get", "/admin/companies/list", { query: { meta: "1", user_company: "cc2" } });
  ok("kundansvarig: samma filter i list-metan", ((listOurs.body.meta || {}).users || []).length === 2);
  const cardOurs = await call(s.routes, "get", "/admin/companies/:id/card", { params: { id: "cc1" }, query: { user_company: "cc2" } });
  ok("kundansvarig: samma filter i kortets meta", ((cardOurs.body.meta || {}).users || []).length === 2);
  ok("frontend: user_company skickas i list- och kort-anropen",
     /p\.push\("user_company="\+encodeURIComponent\(uc\)\)/.test(fl) &&
     /function ucq\(\)/.test(fl) &&
     /\/card"\+ucq\(\)/.test(fl) && /\/onboarding"\+ucq\(\)/.test(fl));

  // ── Onboarding och "Vår personal" måste läsa SAMMA definition ─────────────
  // ⚠️ Onboarding-chippet använde ENBART env-varen CAROTTE_COMPANY_ID medan
  // personallistan filtrerar på den inloggades company. Skiljer de sig säger
  // ytorna emot varandra: personen stod under "Vår personal" samtidigt som
  // chippet sa "ingen Carotte-medarbetare".
  const obDeps = Object.assign({}, deps, { CAROTTE_COMPANY_ID: "NAGOT_ANNAT_ID" });
  const obs = mk(); registerCompaniesRoutes(obs.app, obDeps);
  const obNoQ = await call(obs.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc1" } });
  const obWithQ = await call(obs.routes, "get", "/admin/companies/:id/onboarding", { params: { id: "cc1" }, query: { user_company: "cc2" } });
  // ⚠️ Defensivt — mot gammal kod kan formen saknas helt; en krasch hade dolt resten.
  // ⚠️ Defensivt — mot gammal kod kan formen saknas helt; en krasch hade dolt resten.
  // Delkraven ligger under `mira.checks` (inte i topp-nivåns `steps`).
  const staffOf = (r) => {
    const arr = (r && r.body && r.body.mira && r.body.mira.checks) || [];
    return (Array.isArray(arr) ? arr : []).filter(function (x) { return x && x.id === "staff"; })[0] || {};
  };
  ok("onboarding: env ensam hittar ingen Carottare (fel id)", staffOf(obNoQ).done !== true);
  // u3 har Company cc2 och Associated_company innehåller cc1 → ska räknas.
  const stQ = staffOf(obWithQ);
  ok("onboarding: med user_company hittas samma person som i Vår personal",
     stQ.done === true && stQ.count >= 1);

  // ── WIRING: nås mypageAuth verkligen fram i index.js? (2026-08-27) ──────────
  // ⚠️ Sviten nedan injicerar mypageAuth själv och var därför GRÖN medan
  //    /mypage/me svarade 404 skarpt — depen låg i registerVisitorRoutes deps
  //    i stället för registerCompaniesRoutes. Modulen testad, kopplingen inte.
  //    Statisk kontroll, men den fångar exakt den klassen av fel.
  {
    const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
    const i = src.indexOf("registerCompaniesRoutes(app, {");
    const block = i > -1 ? src.slice(i, src.indexOf("});", i)) : "";
    ok("index.js skickar mypageAuth till registerCompaniesRoutes", /\bmypageAuth\s*:/.test(block));
    const v = src.indexOf("registerVisitorRoutes(app, {");
    const vblock = v > -1 ? src.slice(v, src.indexOf("});", v)) : "";
    ok("mypageAuth ligger INTE i registerVisitorRoutes deps", !/\bmypageAuth\s*:/.test(vblock));
  }

  // ── MIN SIDA VIA KUNDINGÅNGEN /mypage/me (2026-08-27) ───────────────────────
  // ⚠️ HELA POÄNGEN: kundvägen får uid ur den SIGNERADE TOKENEN, aldrig ur URL:en.
  //    Sviten ska falla om någon någonsin lägger tillbaka ett :userId där.
  {
    const { makeMypageAuth } = await import("./mypage_auth.js");
    const auth = makeMypageAuth({ secret: "smoke-secret", sessionSecret: "smoke-session" });
    const mp = mk();
    registerCompaniesRoutes(mp.app, Object.assign({}, deps, { mypageAuth: auth }));
    const tok = (uid) => ({ headers: { "x-mypage-token": auth.mint({ uid }).token } });

    // ⚠️ BUBBLES VERKLIGA USER-FORM (2026-08-27). Auth-users bär e-posten under
    //    authentication.email.email — INTE som ett toppnivå-`email`. Fixturens övriga
    //    users har toppnivå-email och kan därför inte uttrycka det: en mutation som
    //    tog bort authentication-fallbacken passerade sviten. Läggs och plockas bort
    //    lokalt så antal-assertions i andra block inte rubbas.
    STORE.User.push({ _id: "u9", "First Name": "Auth", "Surname": "Only",
      authentication: { email: { email: "auth.only@carotte.se" } }, Company: "cc1" });
    STORE.Coworker.push({ _id: "co9", "Kundföretag": "cc1", "Förnamn": "Auth", "Efternamn": "Only",
      Email: "Auth.Only@Carotte.SE" });
    const authOnly = await call(mp.routes, "get", "/mypage/me", tok("u9"));
    ok("mypage/me: e-post läses ur authentication.email.email", (authOnly.body.user || {}).email === "auth.only@carotte.se");
    ok("mypage/me: coworker hittas trots att BÅDA leden skiljer i skiftläge",
       authOnly.body.coworker_linked === true && (authOnly.body.coworker || {}).id === "co9");
    STORE.User.pop(); STORE.Coworker.pop();

    const me = await call(mp.routes, "get", "/mypage/me", tok("u1"));
    ok("mypage/me: token → egen profil", me.body.ok === true && (me.body.user || {}).id === "u1" && me.body.user.first === "Anna");
    ok("mypage/me: coworker kopplad via e-post", me.body.coworker_linked === true && (me.body.coworker || {}).id === "co1");

    // ⚠️ ANGREPPET: giltig token för u1, men försök läsa u2. Vägen har inget :userId,
    //    så ett påhittat params-objekt får INTE kunna styra vem som läses.
    const cross = await call(mp.routes, "get", "/mypage/me", Object.assign({ params: { userId: "u2" } }, tok("u1")));
    ok("mypage/me: params kan INTE peka om till annan user", (cross.body.user || {}).id === "u1");

    ok("mypage/me: ingen token → 401", (await call(mp.routes, "get", "/mypage/me", {})).code === 401);
    ok("mypage/me: skräptoken → 401", (await call(mp.routes, "get", "/mypage/me", { headers: { "x-mypage-token": "skrap.skrap" } })).code === 401);
    // Admin-tokenen får aldrig duga på kundvägen — det är hela skälet till modulen.
    ok("mypage/me: x-admin-token duger inte", (await call(mp.routes, "get", "/mypage/me", { headers: { "x-admin-token": "T" } })).code === 401);

    // PATCH via kundingången skriver på tokenens user, inte på params.
    const pw = await call(mp.routes, "patch", "/mypage/me", Object.assign({ params: { userId: "u2" }, body: { fields: { title: "Kundchef" } } }, tok("u1")));
    ok("mypage/me PATCH skriver tokenens user", pw.body.ok === true && (STORE.User.find((x) => x._id === "u1") || {})["Title_user"] === "Kundchef");
    ok("mypage/me PATCH rörde INTE u2", (STORE.User.find((x) => x._id === "u2") || {})["Title_user"] !== "Kundchef");
    ok("mypage/me PATCH okänt fält → 400", (await call(mp.routes, "patch", "/mypage/me", Object.assign({ body: { fields: { admin_crm: true } } }, tok("u1")))).code === 400);

    // Profilbild: coworkern slås upp ur tokenen. u2 saknar coworker → 409, inte tyst ok.
    const ph = await call(mp.routes, "post", "/mypage/me/photo", Object.assign({ file: { buffer: Buffer.from("x"), mimetype: "image/png" } }, tok("u1")));
    ok("mypage/me/photo → Prodilbild på EGEN coworker", ph.body.ok === true && (STORE.Coworker.find((c) => c._id === "co1") || {}).Prodilbild === ph.body.url && ph.body.coworker_id === "co1");
    const phNo = await call(mp.routes, "post", "/mypage/me/photo", Object.assign({ file: { buffer: Buffer.from("x"), mimetype: "image/png" } }, tok("u2")));
    ok("mypage/me/photo utan kopplad coworker → 409, inte tyst ok", phNo.code === 409 && (phNo.body || {}).error === "no_coworker_linked");

    // ⚠️ Utan mypageAuth ska kundvägen INTE finnas. Hellre 404 än en ogrindad route.
    const utan = mk(); registerCompaniesRoutes(utan.app, deps);
    ok("utan mypageAuth registreras /mypage/me inte alls",
       !Object.keys(utan.routes.get).some((r) => r.indexOf("/mypage/me") === 0) &&
       !Object.keys(utan.routes.patch).some((r) => r.indexOf("/mypage/me") === 0));
  }

  // ── MIN SIDA (User-profil: speglad skrivning User+Coworker + consent) ────────
  // ⚠️ Sist så spegelskrivningen inte muterar tidigare User/Coworker-assertions.
  {
    const ms = mk(); registerCompaniesRoutes(ms.app, deps);
    // GET: u1 (Anna) ↔ co1 (Testare) länkade via e-post christian.mertzig@gmail.com
    const g = await call(ms.routes, "get", "/admin/companies/mypage/:userId", { params: { userId: "u1" } });
    const gu = (g.body && g.body.user) || {};
    const gco = (g.body && g.body.coworker) || {};
    ok("mypage GET ok + user-fält", g.body.ok === true && gu.first === "Anna" && gu.last === "Andersson" && gu.email === "christian.mertzig@gmail.com");
    ok("mypage GET hittar kopplad coworker via e-post", g.body.coworker_linked === true && gco.id === "co1");
    ok("mypage GET consent tomt (u1 saknar Consent)", ((g.body || {}).consent || {}).godkant === false);

    // GET: u2 (bo@x.se) saknar coworker → linked false, INTE krasch
    const g2 = await call(ms.routes, "get", "/admin/companies/mypage/:userId", { params: { userId: "u2" } });
    ok("mypage GET utan kopplad coworker → linked false + coworker null", g2.body.ok === true && g2.body.coworker_linked === false && g2.body.coworker === null);

    // GET okänd user → 404
    const g404 = await call(ms.routes, "get", "/admin/companies/mypage/:userId", { params: { userId: "nope" } });
    ok("mypage GET okänd user → 404", g404.code === 404 && (g404.body || {}).error === "user_not_found");

    // PATCH: speglad skrivning. Telefon formatterad — User=TEXT (behålls), Coworker=NUMBER.
    const emailBefore = (STORE.User.find((u) => u._id === "u1") || {}).email;
    const p = await call(ms.routes, "patch", "/admin/companies/mypage/:userId", { params: { userId: "u1" }, body: { fields: { first: "Anders", last: "Ny", title: "VD", phone: "070-111 22 33" } } });
    const u1 = STORE.User.find((u) => u._id === "u1") || {};
    const c1 = STORE.Coworker.find((c) => c._id === "co1") || {};
    ok("mypage PATCH ok + coworker_linked + coworker_id", (p.body || {}).ok === true && p.body.coworker_linked === true && p.body.coworker_id === "co1");
    ok("mypage PATCH User: First Name/Surname/Title_user", u1["First Name"] === "Anders" && u1["Surname"] === "Ny" && u1["Title_user"] === "VD");
    ok("mypage PATCH User.Phone_user = TEXT (behåller '070-111 22 33')", u1["Phone_user"] === "070-111 22 33");
    ok("mypage PATCH speglar Coworker: Förnamn/Efternamn/Titel", c1["Förnamn"] === "Anders" && c1["Efternamn"] === "Ny" && c1["Titel"] === "VD");
    ok("mypage PATCH Coworker.Telefon = NUMBER 701112233", c1["Telefon"] === 701112233 && typeof c1["Telefon"] === "number");
    ok("mypage PATCH rör ALDRIG User.email (auth + join-nyckel)", u1.email === emailBefore);

    // PATCH utan kopplad coworker → user skrivs, linked false, ingen krasch
    const p2 = await call(ms.routes, "patch", "/admin/companies/mypage/:userId", { params: { userId: "u2" }, body: { fields: { first: "Boris" } } });
    const u2 = STORE.User.find((u) => u._id === "u2") || {};
    ok("mypage PATCH utan coworker → user skriven + linked false", (p2.body || {}).ok === true && p2.body.coworker_linked === false && u2["First Name"] === "Boris");

    // PATCH okänt fält → 400 (whitelist)
    const pBad = await call(ms.routes, "patch", "/admin/companies/mypage/:userId", { params: { userId: "u1" }, body: { fields: { admin_crm: true } } });
    ok("mypage PATCH okänt fält → 400 field_not_editable", pBad.code === 400 && /field_not_editable/.test((pBad.body || {}).error || ""));

    // PATCH tomt → 400
    const pEmpty = await call(ms.routes, "patch", "/admin/companies/mypage/:userId", { params: { userId: "u1" }, body: { fields: {} } });
    ok("mypage PATCH tomt → 400 no_fields", pEmpty.code === 400 && (pEmpty.body || {}).error === "no_fields");

    // CONSENT: godkänn → skapar consent{Godkänt:'Ja', User:u1} + sätter User.Consent
    const cBefore = STORE.consent.length;
    const cRes = await call(ms.routes, "post", "/admin/companies/mypage/:userId/consent", { params: { userId: "u1" }, body: { agree: true } });
    const newC = STORE.consent[STORE.consent.length - 1] || {};
    const u1c = STORE.User.find((u) => u._id === "u1") || {};
    ok("consent POST ok + ny consent-post skapad", (cRes.body || {}).ok === true && STORE.consent.length === cBefore + 1);
    ok("consent skriver Godkänt='Ja' + User=u1", newC["Godkänt"] === "Ja" && newC["User"] === "u1");
    ok("consent sätter User.Consent → nya id:t", u1c.Consent === newC._id && u1c.Consent === cRes.body.consent_id);

    // CONSENT GET reflekterar godkänt
    const gAfter = await call(ms.routes, "get", "/admin/companies/mypage/:userId", { params: { userId: "u1" } });
    ok("consent GET reflekterar godkänt=true", ((gAfter.body || {}).consent || {}).godkant === true);

    // CONSENT utan agree → 400
    const cNo = await call(ms.routes, "post", "/admin/companies/mypage/:userId/consent", { params: { userId: "u1" }, body: {} });
    ok("consent utan agree → 400 agree_required", cNo.code === 400 && (cNo.body || {}).error === "agree_required");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KUNDGRUPPER (Fas 1) — egen fixtur så befintliga tester inte rubbas
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // ⚠️ Medlemskapet ligger på `ClientCompany.group`. `ClientGroup.companies`
    // fylls MEDVETET fel i fixturen — den riktningen skrivs inte av vår kod och
    // ett test måste bevisa att vi inte råkar läsa den.
    const GRUPPER = [
      { _id: "gg1", name: "Vasakronan-koncernen", slug: "vasakronan", status: "confirmed",
        primary_company: "gc1", companies: ["gc1", "gcX"], org_numbers: ["556061-4603"], aliases: ["Vasakronan AB"] },
      { _id: "gg2", name: "Tom koncern", slug: "tom", status: "suggested", companies: [] },
      { _id: "gg4", name: "Halvkänd koncern", slug: "halv", status: "confirmed", companies: ["gc5"] },
      // Varken name ELLER slug — _groups() faller tillbaka på slug när namnet saknas,
      // så en grupp med slug är INTE namnlös. Det här är det verkliga fallet.
      { _id: "gg3", status: "suggested", companies: [] },
    ];
    const gproj = (id, name, group, fast, orgnr) => ({
      id, name, orgnr: orgnr || "", kundstatus: "Aktiv kund", bransch: "", potential: "", lojalitet: "",
      region: "", customer_type: "", nki: null, antal_medarbetare: null, omsattning_field: null,
      ansvarig_id: null, group_id: group, fastighet_ids: fast || [], modified: "2026-08-01T00:00:00.000Z",
    });
    const GFULL = new Map([
      ["gc1", gproj("gc1", "Vasakronan AB", "gg1", ["f1", "f2"], "556061-4603")],
      ["gc2", gproj("gc2", "Vasakronan Fastigheter AB", "gg1", ["f2", "f3"], "556061-9999")],
      ["gc3", gproj("gc3", "Fristaende AB", null, ["f1"], "556000-0001")],
      ["gc4", gproj("gc4", "Spöke AB", "gDÖD", [], "556000-0002")],
      ["gc5", gproj("gc5", "Med intäkt AB", "gg4", [], "556000-0003")],
      ["gc6", gproj("gc6", "Utan intäkt AB", "gg4", [], "556000-0004")],
    ]);
    const GREV = new Map([["gc1", { 2026: 1000000, 2025: 900000 }], ["gc2", { 2026: 250000 }], ["gc5", { 2026: 50000 }]]);
    const GBOLAG = new Map([["gc1", { "Staff": Date.now() }], ["gc2", { "Housekeeping": Date.now() }]]);
    const gDeps = Object.assign({}, deps, {
      bubbleFindAll: async (t, o) => (t === "ClientGroup" ? GRUPPER.slice() : deps.bubbleFindAll(t, o)),
      companyFullMap: async () => GFULL,
      companyRevenueMap: async () => GREV,
      companyRevenueMapWarm: () => GREV,
      companyBolagMapWarm: () => GBOLAG,
      companyTouchMapWarm: () => new Map(),
    });
    const gs2 = mk(); registerCompaniesRoutes(gs2.app, gDeps);

    const L = await call(gs2.routes, "get", "/admin/companies/groups", { query: { year: "2026", prev: "2025" } });
    ok("grupper: listan svarar", L.body.ok === true && L.body.total === 4);
    const gById = new Map((L.body.grupper || []).map((x) => [x.id, x]));
    const g1 = gById.get("gg1") || {};
    // ⚠️ KÄRNAN: medlemmarna härleds ur ClientCompany.group. Läses ClientGroup.companies
    // blir gc2 osynlig och spökbolaget gcX räknas i stället.
    ok("grupper: medlemmar härledda ur ClientCompany.group", g1.medlemmar === 2);
    ok("grupper: bolag som BARA står i ClientGroup.companies blir aldrig medlem",
      JSON.stringify(L.body.grupper).indexOf("gcX") < 0);
    ok("grupper: omsättning summeras över medlemmarna", g1.oms_now === 1250000 && g1.oms_prev === 900000);
    ok("grupper: fastigheter räknas distinkt över koncernen", g1.fastigheter === 3);
    ok("grupper: våra bolag unionas över medlemmarna", (g1.bolag || []).length === 2);
    ok("grupper: primärbolagets namn resolvas", g1.primary_company === "Vasakronan AB");
    // ⚠️ Ett bolag som BARA står i den döda listan är OSYNLIGT — det ska flaggas.
    ok("grupper: osynligt bolag (bara i companies-listan) RAPPORTERAS",
      !!g1.spegling && g1.spegling.bara_i_companies === 1 && g1.spegling.bara_i_group === 1);
    const g2 = gById.get("gg2") || {};
    ok("grupper: tom grupp ger 0 medlemmar och 0 kr", g2.medlemmar === 0 && g2.oms_now === 0);
    ok("grupper: tom grupp har ingen spegelvarning", g2.spegling === null);
    const g3 = gById.get("gg3") || {};
    ok("grupper: namnlös grupp faller INTE tyst bort", !!g3.id && g3.namnlos === true);
    // ⚠️ En medlem vars omsättning inte är känd får inte tyst räknas som 0 kr —
    // då ser en halvt okänd koncern ut som en fattig koncern.
    const g4 = gById.get("gg4") || {};
    ok("grupper: medlem utan känd omsättning räknas som OKÄND, inte som noll",
      g4.medlemmar === 2 && g4.oms_now === 50000 && g4.oms_okand === 1);
    // ⚠️ NORMALFALLET: den döda companies-listan släpar efter en korrekt gruppering.
    // Flaggar vi på det lyser till slut ALLA grupper, och då läser ingen varningen.
    // (Skarpt 2026-09-01: Scandic 6 och Strawberry 1 sådana — helt ofarliga.)
    ok("grupper: släpande companies-lista flaggas INTE — den kräver ingen åtgärd", g4.spegling === null);

    const h = L.body.halsa;
    ok("hälsa: företag med/utan grupp", h.foretag_totalt === 6 && h.foretag_med_grupp === 5 && h.foretag_utan_grupp === 1);
    ok("hälsa: tomma grupper räknas", h.grupper_tomma === 2);
    ok("hälsa: namnlösa grupper räknas", h.grupper_utan_namn === 1);
    // ⚠️ En raderad grupp som ligger kvar på ett företag får varje query mot den att
    // 400:a (MISSING_DATA). Den ska synas här, inte upptäckas som ett driftfel.
    ok("hälsa: död gruppreferens upptäcks och namnges",
      h.doda_gruppreferenser === 1 && ((h.doda_gruppreferenser_exempel || [])[0] || {}).namn === "Spöke AB");
    ok("hälsa: andel grupperade räknas", h.andel_grupperade === 83.3);
    ok("hälsa: bara grupper med OSYNLIGA bolag räknas", h.grupper_med_osynliga_bolag === 1 && h.osynliga_bolag === 1);

    const D = await call(gs2.routes, "get", "/admin/companies/groups/:id", { params: { id: "gg1" }, query: { year: "2026", prev: "2025" } });
    ok("gruppdetalj: svarar med medlemsrader", D.body.ok === true && (D.body.medlemmar || []).length === 2);
    ok("gruppdetalj: sorterad på omsättning", ((D.body.medlemmar || [])[0] || {}).id === "gc1");
    ok("gruppdetalj: summan matchar listan", D.body.summa.oms_now === 1250000 && D.body.summa.medlemmar === 2);
    ok("gruppdetalj: aliases och org_numbers bärs med", (D.body.grupp.org_numbers || [])[0] === "556061-4603");
    ok("gruppdetalj: avvikelsen namnger bolagen, inte bara antalet",
      !!D.body.spegling && ((D.body.spegling.bara_i_group || [])[0] || {}).namn === "Vasakronan Fastigheter AB");
    ok("gruppdetalj: säger rakt ut om åtgärd krävs", D.body.spegling.atgard_kravs === true);
    const D4 = await call(gs2.routes, "get", "/admin/companies/groups/:id", { params: { id: "gg4" } });
    ok("gruppdetalj: släpande lista redovisas men utan åtgärdskrav",
      !!D4.body.spegling && D4.body.spegling.atgard_kravs === false &&
      (D4.body.spegling.note || "").indexOf("Ingen åtgärd") === 0);
    const D404 = await call(gs2.routes, "get", "/admin/companies/groups/:id", { params: { id: "finns-ej" } });
    ok("gruppdetalj: okänd grupp → 404", D404.code === 404);

    // ⚠️ Omsättning som inte hunnit värmas får INTE bli 0 kr.
    const coldG = Object.assign({}, gDeps, { companyRevenueMapWarm: () => null, companyRevenueMap: async () => null });
    const cgs = mk(); registerCompaniesRoutes(cgs.app, coldG);
    const C = await call(cgs.routes, "get", "/admin/companies/groups", {});
    ok("kall omsättning → null, aldrig 0 kr", C.body.ok === true && C.body.revenue_ready === false &&
      (C.body.grupper.find((x) => x.id === "gg1") || {}).oms_now === null);

    // ⚠️ Ett trasigt ClientGroup-svep får ALDRIG bli "inga kundgrupper".
    const brokenG = Object.assign({}, gDeps, {
      bubbleFindAll: async (t, o) => { if (t === "ClientGroup") { const e = new Error("bubbleFind failed"); e.detail = { status: 500, body: "boom" }; throw e; } return deps.bubbleFindAll(t, o); },
    });
    const bgs = mk(); registerCompaniesRoutes(bgs.app, brokenG);
    const B = await call(bgs.routes, "get", "/admin/companies/groups", {});
    ok("trasigt ClientGroup-svep → 502, inte tom lista", B.code === 502 && B.body.error === "clientgroup_sweep_failed");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FAS 2 — skapa grupp, bulk-tilldelning, koncernlins
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // Egen värld med räknare, så N+1 går att BEVISA och inte bara antas.
    const GRP = [{ _id: "k1", name: "Vasakronan", slug: "vasakronan", companies: [] }];
    const KCC = {
      a1: { _id: "a1", Name_company: "Vasakronan AB", group: "k1" },
      a2: { _id: "a2", Name_company: "Vasakronan Fastigheter AB", group: "k1" },
      a3: { _id: "a3", Name_company: "Fristaende AB", group: null },
      a4: { _id: "a4", Name_company: "Kandidat AB", group: null },
    };
    const KROWS = {
      FortnoxInvoice: [
        { _id: "i1", linked_company: "a1", ft_document_number: "1", ft_total: 100, ft_net: 80, ft_invoice_date: "2026-05-01", ft_balance: 0 },
        { _id: "i2", linked_company: "a2", ft_document_number: "2", ft_total: 200, ft_net: 160, ft_invoice_date: "2026-06-01", ft_balance: 0 },
        { _id: "i3", linked_company: "a3", ft_document_number: "3", ft_total: 900, ft_net: 720, ft_invoice_date: "2026-06-02", ft_balance: 0 },
      ],
      Matter: [
        { _id: "m1", "Kundföretag": "a1", Rubrik: "Trasig dörr", Datum: "2026-06-01" },
        { _id: "m2", "Kundföretag": "a2", Rubrik: "Lampa", Datum: "2026-06-02" },
      ],
      Coworker: [
        { _id: "p1", "Kundföretag": "a1", "Förnamn": "Anna", "Efternamn": "Ek" },
        { _id: "p2", "Kundföretag": "a2", "Förnamn": "Bo", "Efternamn": "Vik" },
        { _id: "p3", "Kundföretag": "a3", "Förnamn": "Hemlig", "Efternamn": "Person" },
      ],
      QualityControl: [], Office: [], Contract: [], activitet_crm: [],
      deal: [], Lead: [], Offert: [], FortnoxOffer: [], MiraOrder: [], FortnoxOrder: [],
      OfferApprovalRequest: [], User: [],
    };
    const kmatch = (r, cs) => (cs || []).every((c) => {
      const v = r[c.key];
      if (c.constraint_type === "in") return (c.value || []).map(String).indexOf(String(v)) > -1;
      if (c.constraint_type === "contains") { const a = Array.isArray(v) ? v : (v == null ? [] : [v]); return a.map(String).indexOf(String(c.value)) > -1; }
      return String(v == null ? "" : v) === String(c.value);
    });
    const kCalls = [];
    const kproj = (c) => ({ id: c._id, name: c.Name_company, orgnr: "", kundstatus: "", bransch: "", potential: "",
      lojalitet: "", region: "", customer_type: "", nki: null, antal_medarbetare: null, omsattning_field: null,
      ansvarig_id: null, group_id: c.group || null, fastighet_ids: [], modified: null });
    let KFULL = new Map(Object.values(KCC).map((c) => [c._id, kproj(c)]));
    const kDeps = Object.assign({}, deps, {
      bubbleFindAll: async (t, o = {}) => {
        kCalls.push({ t, constraints: o.constraints || [] });
        if (t === "ClientGroup") return GRP.slice();
        if (t === "ClientCompany") return Object.values(KCC).filter((r) => kmatch(r, o.constraints));
        return (KROWS[t] || []).filter((r) => kmatch(r, o.constraints));
      },
      bubbleGet: async (t, id) => (t === "ClientCompany" ? (KCC[id] || null) : (t === "ClientGroup" ? (GRP.find((g) => g._id === id) || null) : null)),
      bubblePatch: async (t, id, payload) => {
        // ⚠️ ClientGroup.companies får ALDRIG skrivas — mocken skriker om det händer.
        if (t === "ClientGroup" && Object.keys(payload || {}).indexOf("companies") > -1) throw new Error("FORBJUDET: skrev till ClientGroup.companies");
        if (t === "ClientCompany" && KCC[id]) Object.assign(KCC[id], payload);
        return {};
      },
      bubbleCreate: async (t, payload) => {
        if (t === "ClientGroup") {
          if (Object.keys(payload || {}).indexOf("companies") > -1) throw new Error("FORBJUDET: skrev till ClientGroup.companies");
          const id = "kNy" + (GRP.length + 1); GRP.push(Object.assign({ _id: id }, payload)); return id;
        }
        return "x";
      },
      companyFullMap: async () => KFULL,
      companyRevenueMap: async () => new Map(), companyRevenueMapWarm: () => new Map(),
      companyBolagMapWarm: () => new Map(), companyTouchMapWarm: () => new Map(),
      companyPatchEntry: (id, fresh) => { KFULL.set(id, kproj(fresh)); },
    });
    const ks = mk(); registerCompaniesRoutes(ks.app, kDeps);

    // ── SKAPA GRUPP ────────────────────────────────────────────────────────
    const ny = await call(ks.routes, "post", "/admin/companies/groups", { body: { namn: "Scandic Hotels" } });
    ok("skapa grupp: ok + slug härledd", ny.body.ok === true && ny.body.slug === "scandic-hotels");
    ok("skapa grupp: ClientGroup.companies rördes ALDRIG",
      (GRP.find((g) => g._id === ny.body.id) || {}).companies === undefined);
    const dubb = await call(ks.routes, "post", "/admin/companies/groups", { body: { namn: "  scandic   hotels " } });
    // ⚠️ Två "Vasakronan" som skiljer sig på ett mellanslag är två grupper ingen menade skapa.
    ok("skapa grupp: dubblett på normaliserat namn → 409", dubb.code === 409 && dubb.body.error === "group_exists");
    const utan = await call(ks.routes, "post", "/admin/companies/groups", { body: {} });
    ok("skapa grupp: utan namn → 400", utan.code === 400 && utan.body.error === "missing_namn");

    // ── BULK-TILLDELNING ───────────────────────────────────────────────────
    const add = await call(ks.routes, "post", "/admin/companies/groups/:id/members", {
      params: { id: "k1" }, body: { companies: ["a3", "a4", "a1"], action: "add" } });
    ok("bulk: två ändrade, en oförändrad (a1 låg redan i gruppen)",
      add.body.ok === true && add.body.andrade === 2 && add.body.oforandrade === 1);
    ok("bulk: skrev ClientCompany.group", KCC.a3.group === "k1" && KCC.a4.group === "k1");
    ok("bulk: cachen uppdaterad direkt", KFULL.get("a3").group_id === "k1");
    const rem = await call(ks.routes, "post", "/admin/companies/groups/:id/members", {
      params: { id: "k1" }, body: { companies: ["a4"], action: "remove" } });
    ok("bulk: remove tömmer group", rem.body.ok === true && !KCC.a4.group);
    const okand = await call(ks.routes, "post", "/admin/companies/groups/:id/members", {
      params: { id: "k1" }, body: { companies: ["a1", "finns-ej"] } });
    ok("bulk: okänt företag → 400, INGET skrivs", okand.code === 400 && okand.body.error === "unknown_company");
    const okandG = await call(ks.routes, "post", "/admin/companies/groups/:id/members", {
      params: { id: "hittepa" }, body: { companies: ["a3"] } });
    ok("bulk: okänd grupp → 404", okandG.code === 404);
    const badA = await call(ks.routes, "post", "/admin/companies/groups/:id/members", {
      params: { id: "k1" }, body: { companies: ["a3"], action: "flytta" } });
    ok("bulk: okänd action → 400", badA.code === 400 && badA.body.error === "bad_action");

    // ⚠️ Delvis lyckad skrivning får ALDRIG svara 200 ok — samma optimism som
    // _bulkCreate hade när 3 420 skickade rader blev "created: 3420".
    const halv = Object.assign({}, kDeps, {
      bubblePatch: async (t, id, payload) => {
        if (t === "ClientCompany" && id === "a4") { const e = new Error("bubblePatch failed"); e.detail = { status: 400, body: "boom" }; throw e; }
        if (t === "ClientCompany" && KCC[id]) Object.assign(KCC[id], payload);
        return {};
      },
    });
    KCC.a3.group = null; KCC.a4.group = null; KFULL = new Map(Object.values(KCC).map((c) => [c._id, kproj(c)]));
    const hs = mk(); registerCompaniesRoutes(hs.app, Object.assign({}, halv, { companyFullMap: async () => KFULL }));
    const delvis = await call(hs.routes, "post", "/admin/companies/groups/:id/members", {
      params: { id: "k1" }, body: { companies: ["a3", "a4"] } });
    ok("bulk: delvis misslyckad → 207 och ok:false, aldrig tyst framgång",
      delvis.code === 207 && delvis.body.ok === false && delvis.body.andrade === 1 &&
      (delvis.body.misslyckade || []).length === 1 && (delvis.body.misslyckade[0] || {}).namn === "Kandidat AB");

    // ⚠️ TYST FÄLTDROP: Bubble svarar 204 men fältet fastnar inte. En skrivning
    // utan återläsning hade rapporterat "ändrad" på något som aldrig sparades
    // ([[reference-bubble-tysta-faltdrop]]).
    KCC.a3.group = null; KFULL = new Map(Object.values(KCC).map((c) => [c._id, kproj(c)]));
    const tyst = Object.assign({}, kDeps, {
      companyFullMap: async () => KFULL,
      bubblePatch: async (t, id) => { if (t === "ClientCompany" && id === "a3") return {}; return {}; },
    });
    const tys = mk(); registerCompaniesRoutes(tys.app, tyst);
    const drop = await call(tys.routes, "post", "/admin/companies/groups/:id/members", {
      params: { id: "k1" }, body: { companies: ["a3"] } });
    ok("bulk: tyst fältdrop upptäcks av återläsningen, aldrig falskt 'ändrad'",
      drop.code === 502 && drop.body.andrade === 0 &&
      ((drop.body.misslyckade || [])[0] || {}).orsak === "verifiering_falerade");

    // ── KONCERNLINSEN ──────────────────────────────────────────────────────
    KCC.a3.group = null; KCC.a4.group = null;
    KFULL = new Map(Object.values(KCC).map((c) => [c._id, kproj(c)]));
    const ls = mk(); registerCompaniesRoutes(ls.app, Object.assign({}, kDeps, { companyFullMap: async () => KFULL }));

    const en = await call(ls.routes, "get", "/admin/companies/:id/chain", { params: { id: "a1" }, query: { type: "fakturor" } });
    ok("lins av: bara bolagets egna rader", en.body.count === 1 && en.body.grupp === undefined);
    ok("lins av: bolagskolumnen sätts ändå (en väg i frontenden)", (en.body.rows[0] || {}).company === "Vasakronan AB");

    kCalls.length = 0;
    const kon = await call(ls.routes, "get", "/admin/companies/:id/chain", { params: { id: "a1" }, query: { type: "fakturor", group: "k1" } });
    ok("lins på: unionen över koncernen", kon.body.count === 2);
    ok("lins på: främmande bolags rader kommer INTE med", !kon.body.rows.some((r) => r.company_id === "a3"));
    // ⚠️ Varje rad måste säga vilket bolag den kom från — annars är aggregering en gröt.
    ok("lins på: varje rad bär bolagsnamn",
      kon.body.rows.every((r) => r.company === "Vasakronan AB" || r.company === "Vasakronan Fastigheter AB"));
    ok("lins på: gruppmeta följer med", !!kon.body.grupp && kon.body.grupp.medlemmar === 2 && kon.body.trunkerad === false);
    // ⚠️ EN query, inte en per medlem. Det här är N+1-vakten.
    const inv = kCalls.filter((c) => c.t === "FortnoxInvoice");
    ok("lins på: EN query per flik, inte en per medlem",
      inv.length === 1 && (inv[0].constraints[0] || {}).constraint_type === "in");

    const ejMed = await call(ls.routes, "get", "/admin/companies/:id/chain", { params: { id: "a3" }, query: { type: "fakturor", group: "k1" } });
    ok("lins: bolag utanför gruppen → 400", ejMed.code === 400 && ejMed.body.error === "company_not_in_group");
    const ejGrp = await call(ls.routes, "get", "/admin/companies/:id/chain", { params: { id: "a1" }, query: { type: "fakturor", group: "hittepa" } });
    ok("lins: okänd grupp → 404", ejGrp.code === 404);

    const pers = await call(ls.routes, "get", "/admin/companies/:id/coworkers", { params: { id: "a1" }, query: { group: "k1" } });
    ok("lins: personer aggregeras över koncernen", (pers.body.rows || []).length === 2);
    const drift = await call(ls.routes, "get", "/admin/companies/:id/matters", { params: { id: "a1" }, query: { group: "k1" } });
    ok("lins: ärenden aggregeras + bär bolag", (drift.body.rows || []).length === 2 &&
      (drift.body.rows || []).every((r) => !!r.company));
    const driftEn = await call(ls.routes, "get", "/admin/companies/:id/matters", { params: { id: "a1" } });
    ok("lins av: ärenden oförändrade", (driftEn.body.rows || []).length === 1);
  }

  // ── HTML-BLOCKET: koncernlinsen (Fas 2) ────────────────────────────────────
  {
    const html = readFileSync(new URL("./mira-foretag-lista.html", import.meta.url), "utf8");
    const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || "";
    // ⚠️ DEN VIKTIGASTE: missas linsen på EN hämtare visar den fliken ett bolags
    // rader medan resten visar koncernens — och ingen skulle se skillnaden.
    const hamtare = ["/chain?type=", "/coworkers", "/matters", "/qc"];
    for (const h of hamtare) {
      const rad = script.split("\n").find((l) => l.indexOf('cardId)+"' + h) > -1);
      ok("block: " + h + " bär koncernlinsen", !!rad && rad.indexOf("lensQ(") > -1);
    }
    // ⚠️ Flikcacharna innehåller ETT bolags rader. Töms de inte vid linsbyte visas
    // fel data under rätt rubrik.
    const bytet = (script.match(/if\(lensBtn\)\{[\s\S]*?fetchTabData\(\); return; \}/) || [])[0] || "";
    // ⚠️ Lyssnaren grenar på STATE.view INNAN den når listans hanterare. Ligger
    // lins-branchen i listgrenen körs den aldrig i kortvyn — klicket dör tyst.
    // (Skarpt 2026-09-01: exakt det hände.)
    const kortgren = (script.match(/if\(STATE\.view==="card"\)\{[\s\S]*?data-fk="tab"/) || [])[0] || "";
    ok("block: linsklicket ligger i KORT-grenen, inte i listgrenen",
      kortgren.indexOf('data-fk="lens"') > -1 && kortgren.indexOf('data-fk="gopen"') > -1);
    ok("block: linsbytet tömmer ALLA flikcachar",
      ["STATE.chain={}", "STATE.coworkers=null", "STATE.matters=null", "STATE.qcList=null"].every((x) => bytet.indexOf(x) > -1));
    // ⚠️ Linsen är per kort — bärs den vidare visar kortet en koncern bolaget
    // kanske inte tillhör.
    const opna = (script.match(/function openCard\(id\)\{[\s\S]*?var cached=cacheGet/) || [])[0] || "";
    ok("block: linsen nollställs när ett nytt kort öppnas", opna.indexOf("STATE.lens=false") > -1);
    ok("block: växeln visas bara när bolaget har en grupp",
      /function lensToggle\(\)\{[\s\S]*?if\(!c\|\|!c\.group_id\) return "";/.test(script));
    // ⚠️ Utan bolagsnamn per rad är aggregering en gröt.
    ok("block: bolagsbadge bara i koncernläge", /function cBadge\(r\)\{\s*\n?\s*if\(!STATE\.lens/.test(script));
    // Kryssrutekolumnen ändrar kolumnantalet — colspan måste följa med.
    ok("block: tomrads-colspan räknar med kryssrutekolumnen", script.indexOf("COLS.length+1") > -1);
    ok("block: konventionerna hålls (ingen ?. / ??)", !/[^\/]\?\./.test(script) && script.indexOf("??") < 0);
    // ⚠️ Kall omsättning får aldrig ritas som 0 kr.
    ok("block: koncernöversikten visar 'beräknar' vid kall cache",
      /d\.revenue_ready\?krc\(sum\.oms_now\):'<span class="fk-calc">/.test(script));
    ok("block: koncernöversikten säger att summan kan vara i underkant",
      script.indexOf("kan vara i underkant") > -1);
    // ⚠️ En skrivning får aldrig sluta i tystnad: kvittot måste överleva att
    // urvalet rensas (bulkKlar tömmer STATE.sel vid framgång).
    // ⚠️ BLANDADE BASER: hjältens nyckeltal, onboarding och flikbadgarna är alla
    // BOLAGETS siffror. Visas de omärkta bredvid koncernens flikar blir de ett
    // beslutsunderlag de inte förtjänar att vara.
    // ⚠️ BUBBLES GLOBALA button:hover HAR !important → helorange knapp med osynlig
    // text. Specificitet hjälper INTE; enda motmedlet är !important på BÅDE
    // background och color. Blocket saknade skyddet helt (skarpt 2026-09-01 —
    // Christian såg det i drift). [[reference-bubble-button-hover-important]]
    const hoverBas = (html.match(/\.fl button:hover,\.fl button:focus\{[^}]*\}/) || [])[0] || "";
    ok("block: basregel för button:hover sätter background OCH color med !important",
      /background:[^;]*!important/.test(hoverBas) && /color:[^;]*!important/.test(hoverBas));
    // Varje klass som deklarerar om sin hover vinner på specificitet och måste
    // därför bära !important själv — annars förlorar just den mot Bubbles regel.
    for (const grupp of ["fl-refresh", "fl-newco", "fk-editbtn", "fk-act.pri", "ab-btn.primary", "fk-roomdel"]) {
      const re = new RegExp("\\.fl \\." + grupp.replace(".", "\\.") + ":hover");
      const blocket = (html.split(/\n\n/).find((b) => re.test(b) && b.indexOf("!important") > -1)) || "";
      ok("block: " + grupp + ":hover kontrar med !important",
        re.test(html) && /background:[^;]*!important/.test(blocket) && /color:[^;]*!important/.test(blocket));
    }
    // ⚠️ Endast <button> träffas av Bubbles regel — men varje knapp i blocket är
    // ett <button>, så basregeln måste täcka dem alla.
    ok("block: inga oskyddade hover-regler på knappklasser kvar",
      !/\n  \.(fl|fk)-(refresh|newco|clear|back|act|cancel|editbtn|key|nsbtn|roomdel|lclose):hover\{(?![^}]*!important)/.test(html));

    // ── Design: samma manér som mira-affar-samlad.html ──────────────────────
    // ⚠️ De gamla --fl-*-namnen PEKAR på affärsvyns variabler. Byts den mappningen
    // mot hårdkodade hexar igen driver blocket isär från affärsvyn utan att någon
    // märker det förrän de står bredvid varandra.
    ok("block: affärsvyns palett är källan", /--base:#1e2235;--panel:#23283f;--card:#262b42/.test(html));
    ok("block: fl-variablerna mappar mot paletten, inte mot egna hexar",
      /--fl-bg:var\(--base\);--fl-card:var\(--panel\)/.test(html) && /--fl-acc:var\(--orange\)/.test(html));
    ok("block: DM Serif-rubrik som affärsvyn",
      html.indexOf("DM+Serif+Display") > -1 && /\.fl-head h1\{font-family:'DM Serif Display'/.test(html));
    ok("block: gamla navypaletten helt borta",
      !/#0f1830|#16223d|#1c2b4d|#243456|#e7ecf6|#8ea0c2|#df6f39/.test(html));
    // ⚠️ Båda knapparna hade `margin-left:auto` och sköt isär varandra — Uppdatera
    // hamnade mitt i raden i stället för bredvid Nytt företag.
    ok("block: Uppdatera och Nytt företag sitter ihop till höger",
      /<span class="fl-headact">\s*<button class="fl-refresh" data-fl="refresh">[\s\S]*?data-fl="newco"[\s\S]*?<\/span>/.test(html) &&
      /\.fl-headact\{margin-left:auto/.test(html));
    ok("block: hjältens nyckeltal märks som bolagets i koncernläge",
      script.indexOf("Nyckeltalen ovan avser") > -1);
    ok("block: onboarding-strippen döljs i koncernläge",
      /var onb=\(STATE\.cardTab==="hem" && !STATE\.lens\)/.test(script));
    ok("block: flikbadgarna döljs i koncernläge (bolagets antal)",
      /cv!==undefined && !STATE\.lens\) badge=/.test(script));
    ok("block: bulk-kvittot renderas även när urvalet är tomt",
      /function bulkBar\(\)\{[\s\S]*?if\(!STATE\.sel\.length\)\{[\s\S]*?if\(!STATE\.bulkMsg\) return "";/.test(script));
  }

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
