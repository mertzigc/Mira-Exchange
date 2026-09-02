// Smoke: ansvarig/skapare-kolumn + datum-filter. node affar_ansvarig_smoke.mjs
import { registerAffarRoutes } from "./affar_api.js";
const routes = { get: {}, post: {}, options: {} };
const app = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
function call(path, { query = {} } = {}) { const h = routes.get[path]; return new Promise((r) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }; h({ query, params: {}, body: {}, headers: {} }, res); }); }

const DB = {
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB" }],
  User: [{ _id: "u1", "First Name": "Sara", "Last Name": "Säljare" }, { _id: "u2", "First Name": "Per", "Last Name": "Planerare" }],
  deal: [{ _id: "d1", titel: "Acme lunch", "kundföretag": "cc1", Status: "Offert", value_brutto: 5000, deal_owner: ["u2"], Kategori: ["Food & Event"], "Created Date": "2026-07-01" }],
  Lead: [{ _id: "l1", Name: "Kalle", Company: "cc1", "Created By": "u1", "Created Date": "2026-07-10" }],
  activitet_crm: [{ _id: "a1", beskrivning: "Ringde", company: "cc1", writer: "u1", "Created Date": "2026-07-11" }],
  Offert: [{ _id: "o1", source: "mira_fe", offertnr: "FE-1", kundforetag: "cc1", total: 2000, deal: "d1", "Created Date": "2026-07-12" }],
  FortnoxOffer: [],
  MiraOrder: [{ _id: "mo1", source: "mira_fe", ordernr: "FE-1", kundforetag: "cc1", total: 2000, deal: "d1", "Created Date": "2026-07-13" }],
  // ⚠️ HK och F&E i SAMMA tabell efter §9-cutovern (LIVE 2026-06-08).
  // HK: connection=TENG, source="tengella-workorder", BARA ft_order_date.
  // F&E: connection=FE, ft_delivery_date.
  FortnoxOrder: [
    { _id: "fo1", connection: "FE", ft_document_number: "FE-100", ft_customer_name: "Acme AB",
      ft_total: 4000, ft_net: 3200, ft_delivery_date: "2026-07-20", "Created Date": "2026-07-02" },
    { _id: "wo1", connection: "TENG", source: "tengella-workorder", ft_document_number: "10568",
      ft_customer_name: "Acme AB", ft_total: 2880, ft_net: 2304,
      ft_order_date: "2026-07-18", "Created Date": "2026-08-19" },
  ],
  FortnoxOrderRow: [
    { _id: "for1", connection: "TENG", ft_order_document_number: "10568", ft_row_index: 1,
      ft_article_number: "ST-1", ft_description: "Storstädning", ft_quantity: 2, ft_price: "1200", ft_total: "2400" },
    { _id: "for2", connection: "TENG", ft_order_document_number: "10568", ft_row_index: 2,
      ft_article_number: "FÖ-2", ft_description: "Fönsterputs", ft_quantity: 1, ft_price: "480", ft_total: "480" },
  ],
  FortnoxInvoice: [{ _id: "inv1", ft_customer_name: "Acme AB", ft_document_number: "F-1", ft_total: 2000, ft_our_reference: "Sara S", connection: "FE", connection_id: "FE", ft_invoice_date: "2026-07-31", "Created Date": "2026-08-05" }],
  Contract: [{ _id: "c1", contract_title: "Ramavtal", "kundföretag": "cc1", "månadskostnad": 1000, deal: "d1", "Created Date": "2026-07-15" }],
  Todo: [], "leverantör-supplier": [],
};
let lastConstraints = {};
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v)); if (c.constraint_type === "not in") return !(Array.isArray(c.value) && c.value.map(String).includes(String(v))); if (c.constraint_type === "contains") return Array.isArray(v) ? v.map(String).includes(String(c.value)) : String(v) === String(c.value); if (c.constraint_type === "greater than") return Date.parse(v) > Date.parse(c.value); if (c.constraint_type === "less than") return Date.parse(v) < Date.parse(c.value); return true; };
const rec = (t, cs) => { lastConstraints[t] = (lastConstraints[t] || []).concat(cs); };
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t, { constraints = [] } = {}) => { rec(t, constraints); return (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))); },
  bubbleFind: async (t, { constraints = [], limit = 30, cursor = 0 } = {}) => { rec(t, constraints); return (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(cursor, cursor + limit); },
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCount: async (t, cs = []) => (DB[t] || []).filter((r) => cs.every((c) => _match(r, c))).length,
  bubblePatch: async () => ({}), bubbleCreate: async () => "n", bubbleDelete: async () => ({}),
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE", TENGELLA_CONNECTION_ID: "TENG",
  CONNECTION_NAMES: { FE: "Food & Event", TENG: "Housekeeping" },
  offertConvert: async () => ({}), renderOrderPdf: async () => ({}),
};
registerAffarRoutes(app, deps);

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
const run = async () => {
  const lead = await call("/admin/affar/list", { query: { type: "lead" } });
  ok("lead ansvarig = skapare (Sara Säljare)", lead.body.rows[0].ansvarig === "Sara Säljare");
  const akt = await call("/admin/affar/list", { query: { type: "aktivitet" } });
  ok("aktivitet ansvarig = writer (Sara Säljare)", akt.body.rows[0].ansvarig === "Sara Säljare");
  const affar = await call("/admin/affar/list", { query: { type: "affar" } });
  ok("affär ansvarig = deal_owner (Per Planerare)", affar.body.rows[0].ansvarig === "Per Planerare");
  const off = await call("/admin/affar/list", { query: { type: "offert" } });
  ok("offert ansvarig = affärens ägare via deal (Per Planerare)", off.body.rows.find((r) => r.id === "o1").ansvarig === "Per Planerare");
  const ord = await call("/admin/affar/list", { query: { type: "order" } });
  ok("order ansvarig = affärens ägare (Per Planerare)", ord.body.rows.find((r) => r.id === "mo1").ansvarig === "Per Planerare");
  const fak = await call("/admin/affar/list", { query: { type: "faktura" } });
  ok("faktura ansvarig = ft_our_reference (Sara S)", fak.body.rows[0].ansvarig === "Sara S");
  const avt = await call("/admin/affar/list", { query: { type: "avtal" } });
  ok("avtal ansvarig = affärens ägare (Per Planerare)", avt.body.rows[0].ansvarig === "Per Planerare");

  // datum-filter → dateBase-constraint på Created Date
  lastConstraints = {};
  const df = await call("/admin/affar/list", { query: { type: "lead", from: "2026-07-01", to: "2026-07-31" } });
  ok("datum-filter ekar tillbaka from/to", df.body.from === "2026-07-01" && df.body.to === "2026-07-31");
  const leadC = (lastConstraints["Lead"] || []).flat();
  ok("Created Date greater-than-constraint (giltig Bubble-typ)", leadC.some((c) => c.key === "Created Date" && c.constraint_type === "greater than"));
  ok("Created Date less-than-constraint (giltig Bubble-typ)", leadC.some((c) => c.key === "Created Date" && c.constraint_type === "less than"));
  ok("lead 2026-07-10 INOM range → syns (inklusiv from/till)", df.body.rows.length === 1 && df.body.rows[0].id === "l1");
  // utanför range → tomt
  const df2 = await call("/admin/affar/list", { query: { type: "lead", from: "2026-08-01", to: "2026-08-31" } });
  ok("lead 2026-07-10 UTANFÖR aug-range → tomt", df2.body.rows.length === 0);
  // exakt from-dag inkluderas (lead skapad 2026-07-10, range from=2026-07-10)
  const df3 = await call("/admin/affar/list", { query: { type: "lead", from: "2026-07-10", to: "2026-07-10" } });
  ok("exakt from=till=skapdag → inkluderas", df3.body.rows.length === 1);

  // ── faktura filtreras på AFFÄRSDATUM (ft_invoice_date=juli), EJ Created Date (aug-synk) ──
  lastConstraints = {};
  const fq = await call("/admin/affar/list", { query: { type: "faktura", from: "2026-07-01", to: "2026-07-31" } });
  ok("faktura constraint på ft_invoice_date (ej Created Date)", (lastConstraints["FortnoxInvoice"] || []).flat().some((c) => c.key === "ft_invoice_date" && c.constraint_type === "greater than"));
  ok("faktura (fakturadatum juli) syns i juli-filter", fq.body.rows.length === 1);
  const fq2 = await call("/admin/affar/list", { query: { type: "faktura", from: "2026-08-01", to: "2026-08-31" } });
  ok("faktura (skapad aug men fakturadatum juli) syns EJ i aug-filter", fq2.body.rows.length === 0);

  // ── PERSON-filter ──
  const pAff = await call("/admin/affar/list", { query: { type: "affar", person: "u2" } });
  ok("person=u2 på affär → d1 (deal_owner u2)", pAff.body.rows.length === 1 && pAff.body.rows[0].id === "d1");
  const pAff0 = await call("/admin/affar/list", { query: { type: "affar", person: "u1" } });
  ok("person=u1 på affär → tomt (äger ej d1)", pAff0.body.rows.length === 0);
  const pOff = await call("/admin/affar/list", { query: { type: "offert", person: "u2" } });
  ok("person=u2 på offert → o1 (via affär d1)", pOff.body.rows.some((r) => r.id === "o1"));
  const pLead = await call("/admin/affar/list", { query: { type: "lead", person: "u1" } });
  ok("person=u1 på lead → l1 (Created By u1)", pLead.body.rows.length === 1 && pLead.body.rows[0].id === "l1");

  // ── KATEGORI-filter ──
  const kAff = await call("/admin/affar/list", { query: { type: "affar", kategori: "Food & Event" } });
  ok("kategori F&E på affär → d1", kAff.body.rows.length === 1 && kAff.body.rows[0].id === "d1");
  const kAff0 = await call("/admin/affar/list", { query: { type: "affar", kategori: "Housekeeping" } });
  ok("kategori Housekeeping på affär → tomt", kAff0.body.rows.length === 0);
  const kOff = await call("/admin/affar/list", { query: { type: "offert", kategori: "Food & Event" } });
  ok("kategori F&E på offert → Mira o1 syns", kOff.body.rows.some((r) => r.id === "o1"));
  const kOff0 = await call("/admin/affar/list", { query: { type: "offert", kategori: "Service & People" } });
  ok("kategori Service&People på offert → Mira exkluderad (tomt, ingen Fortnox)", kOff0.body.rows.length === 0);
  const kFak = await call("/admin/affar/list", { query: { type: "faktura", kategori: "Food & Event" } });
  ok("kategori F&E på faktura → inv1 (connection_id FE)", kFak.body.rows.length === 1);

  // ── COUNT: grand_total + filtrerad total ──
  const cAll = await call("/admin/affar/list", { query: { type: "affar" } });
  ok("ofiltrerat: total=grand_total, filtered=false", cAll.body.total === 1 && cAll.body.grand_total === 1 && cAll.body.filtered === false);
  ok("filtrerat: grand_total kvar, filtered=true, total krymper", kAff0.body.grand_total === 1 && kAff0.body.filtered === true && kAff0.body.total === 0);

  // ══════════════════════════════════════════════════════════════════════════
  // HOUSEKEEPING i affärsvyn — §9-cutovern (utredd 2026-08-20)
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ Affärsvyn läste `TengellaWorkorder` — en typ fryst 2026-06-04 — och
  // EXKLUDERADE FortnoxOrder(TENGELLA), den kanoniska källan. Resultat: elva
  // veckor gammal HK-data utan att något larmade.
  const hkOrd = await call("/admin/affar/list", { query: { type: "order" } });
  const orows = (hkOrd.body && hkOrd.body.rows) || [];
  const hk = orows.find((r) => r.number === "10568");
  const fe = orows.find((r) => r.number === "FE-100");

  ok("HK-ordern syns i affärsvyn", !!hk);
  // ⚠️ HK hämtas i en EGEN fråga (annat datumfält). Utan `not in`-exkluderingen
  // i F&E-frågan kommer samma order tillbaka i båda och listas TVÅ gånger.
  ok("HK-ordern listas exakt EN gång", orows.filter((r) => r.number === "10568").length === 1);
  ok("inga dubbletter alls i listan",
     orows.map((r) => r.id).filter((v, i, a) => a.indexOf(v) !== i).length === 0);
  ok("och märks som tengella, inte fortnox", (hk || {}).source === "tengella");
  ok("F&E-ordern syns fortfarande", !!fe && fe.source === "fortnox");
  // ⚠️ Kärnan: HK har inget ft_delivery_date. Daterades den på det fältet föll
  // den tillbaka på Created Date (synkdatum 2026-08-19), inte affärsdatumet.
  ok("HK dateras på ft_order_date", (hk || {}).date === "2026-07-18");
  ok("HK dateras INTE på Created Date", (hk || {}).date !== "2026-08-19");
  ok("F&E dateras på ft_delivery_date", (fe || {}).date === "2026-07-20");
  // Vi vet inget om leverans för HK → gissa inte "Levererad".
  ok("HK får neutral status, inte Levererad", (hk || {}).status === "Workorder");
  ok("F&E får levererad-status (datum passerat)", (fe || {}).status === "Levererad");
  // Rader ur FortnoxOrderRow, batchat efter paginering.
  ok("HK bär sina rader", ((hk || {}).rows || []).length === 2);
  ok("raderna är sorterade på radindex", (((hk || {}).rows || [])[0] || {}).art === "ST-1");
  ok("radinnehållet mappas rätt", (((hk || {}).rows || [])[0] || {}).name === "Storstädning");
  ok("radbelopp läses ur ft_total", (((hk || {}).rows || [])[0] || {}).sum === 2400);
  ok("HK flaggas som expanderbar (wo)", !!(hk || {}).wo);
  ok("F&E är INTE expanderbar som workorder", !(fe || {}).wo);

  // ── Kategorifiltret ────────────────────────────────────────────────────────
  const hkOnly = await call("/admin/affar/list", { query: { type: "order", kategori: "Housekeeping" } });
  const hkRows = (hkOnly.body && hkOnly.body.rows) || [];
  ok("kategori=Housekeeping ger HK-ordern", hkRows.some((r) => r.number === "10568"));
  ok("och INTE F&E-ordern", !hkRows.some((r) => r.number === "FE-100"));
  const feOnly = await call("/admin/affar/list", { query: { type: "order", kategori: "Food & Event" } });
  const feRows = (feOnly.body && feOnly.body.rows) || [];
  ok("kategori=Food & Event ger F&E-ordern", feRows.some((r) => r.number === "FE-100"));
  ok("och INTE HK-ordern", !feRows.some((r) => r.number === "10568"));

  // ── Datumfilter — HK måste följa med ──────────────────────────────────────
  const jul = await call("/admin/affar/list", { query: { type: "order", from: "2026-07-01", to: "2026-07-31" } });
  const julRows = (jul.body && jul.body.rows) || [];
  ok("datumfilter juli fångar HK (ft_order_date)", julRows.some((r) => r.number === "10568"));
  ok("datumfilter juli fångar F&E (ft_delivery_date)", julRows.some((r) => r.number === "FE-100"));
  const aug = await call("/admin/affar/list", { query: { type: "order", from: "2026-08-01", to: "2026-08-31" } });
  const augRows = (aug.body && aug.body.rows) || [];
  ok("HK dyker INTE upp i augusti (skulle betyda Created Date-fallback)", !augRows.some((r) => r.number === "10568"));

  // ══════════════════════════════════════════════════════════════════════════
  // RÖKTEST PÅ SAMTLIGA GET-ROUTES — fångar odefinierade variabler
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ SKARP KRASCH 2026-08-20: `/admin/affar/feed` dog med "cWO is not defined".
  // Jag tog bort `cWO` ur destruktureringen (TengellaWorkorder-räknaren) men
  // missade att den fortfarande användes i svarets `funnel`/`counts_detail`.
  // Ett aritetstest (variabler == uttryck i Promise.all) räckte INTE — det
  // säger inget om användningar längre ner i funktionen.
  //
  // INGEN svit anropade feed:en. Den här loopen kallar varje registrerad
  // GET-route med minimala argument och kräver att den inte exploderar. Billigt,
  // brett, och fångar precis den klassen av fel.
  const GET_ROUTES = Object.keys(routes.get);
  ok("det finns GET-routes att röktesta", GET_ROUTES.length > 0);
  for (const rp of GET_ROUTES) {
    // Routes med :param får ett dummy-id; de får svara 404, bara inte krascha.
    const params = {};
    (rp.match(/:([a-zA-Z]+)/g) || []).forEach((m) => { params[m.slice(1)] = "x"; });
    let res;
    try {
      res = await new Promise((r) => routes.get[rp](
        { query: {}, params, body: {}, headers: {} },
        { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }));
    } catch (e) {
      res = { code: 500, body: { ok: false, error: "THROW: " + (e && e.message) } };
    }
    const kraschat = res.code >= 500 || /is not defined|THROW:/.test(String((res.body || {}).error || ""));
    ok("GET " + rp + " kraschar inte" + (kraschat ? " (" + ((res.body || {}).error || res.code) + ")" : ""), !kraschat);
  }
  // Feed:en specifikt — den var den som dog, och dess funnel ska summera rätt.
  const feed = await new Promise((r) => routes.get["/admin/affar/feed"](
    { query: {}, params: {}, body: {}, headers: {} },
    { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); } }));
  ok("feed svarar ok", !!(feed.body && feed.body.ok));
  ok("feed har en funnel", !!(feed.body && feed.body.funnel));
  // ⚠️ HK ingår i order_fortnox nu — ingen separat workorder-räknare får finnas
  // kvar, den hade dubbelräknat samma rader.
  ok("funnel.order = mira + fortnox (ingen separat workorder-räknare)",
     (feed.body.funnel || {}).order === ((feed.body.counts_detail || {}).order_mira + (feed.body.counts_detail || {}).order_fortnox));
  ok("counts_detail har ingen order_tengella längre",
     !("order_tengella" in (feed.body.counts_detail || {})));

  // ══════════════════════════════════════════════════════════════════════════
  // BELOPP-fallback i affärslistan (Christians beslut 2026-09-02)
  // ══════════════════════════════════════════════════════════════════════════
  // Prioritet: netto → brutto → offertvärde. En affär utan varken netto eller
  // brutto ska falla tillbaka på offertens `total` (batchad, en Bubble-query).
  // ⚠️ Fixturen speglar tre skarpa fall:
  //   dN  — har netto satt (25000) OCH brutto (50000) → visa NETTO
  //   dB  — har bara brutto (7000)                    → visa BRUTTO
  //   dO  — varken netto eller brutto, men OFFERT     → visa offertens total
  //   dX  — inget alls                                → amount=null (— i UI)
  DB.deal.push(
    { _id: "dN", titel: "Netto-deal",  "kundföretag": "cc1", Status: "Offert", value_brutto: 50000, value_netto: 25000, deal_owner: ["u2"], "Created Date": "2026-08-01" },
    { _id: "dB", titel: "Brutto-deal", "kundföretag": "cc1", Status: "Offert", value_brutto: 7000,                   deal_owner: ["u2"], "Created Date": "2026-08-02" },
    { _id: "dO", titel: "Offert-deal", "kundföretag": "cc1", Status: "Offert",                                        deal_owner: ["u2"], "Created Date": "2026-08-03" },
    { _id: "dX", titel: "Tomt-deal",   "kundföretag": "cc1", Status: "Offert",                                        deal_owner: ["u2"], "Created Date": "2026-08-04" },
  );
  DB.Offert.push(
    { _id: "oDo1", source: "mira_fe", offertnr: "FE-9",   kundforetag: "cc1", total: 12000, deal: "dO", "Created Date": "2026-08-03" },
    // ⚠️ Två offerter på samma affär — HÖGSTA vinner (annars visar vi
    // "smallest offer" som fake affärsvärde), och 0-belopp räknas inte.
    { _id: "oDo2", source: "mira_fe", offertnr: "FE-10",  kundforetag: "cc1", total: 34000, deal: "dO", "Created Date": "2026-08-03" },
    { _id: "oDo3", source: "mira_fe", offertnr: "FE-11",  kundforetag: "cc1", total: 0,     deal: "dO", "Created Date": "2026-08-03" },
  );
  const listAll = await call("/admin/affar/list", { query: { type: "affar" } });
  const byId = (id) => listAll.body.rows.find((r) => r.id === id);

  ok("dN visar NETTO (25000), inte brutto",       (byId("dN") || {}).amount === 25000);
  ok("dB visar BRUTTO (7000)",                    (byId("dB") || {}).amount === 7000);
  ok("dO faller tillbaka på HÖGSTA offertvärdet (34000)",
     (byId("dO") || {}).amount === 34000);
  ok("dO flaggas amount_source=offert (så UI kan indikera)",
     (byId("dO") || {}).amount_source === "offert");
  ok("dX utan varken netto/brutto/offert → amount null (— i UI)",
     (byId("dX") || {}).amount === null);
  // Regression: deals MED brutto ska INTE trigga offert-lookup (och inte
  // heller få amount_source="offert" påklistrat).
  ok("dB har INTE amount_source=offert (den fick brutto direkt)",
     (byId("dB") || {}).amount_source === undefined);

  // ⚠️ Batchning: bara EN Offert-query får gå ner för hela sidans fallback,
  // oavsett hur många deals som saknar amount. Utan batchning blir det
  // N Bubble-anrop och listan skalar dåligt (samma fälla som drift-N+1 2026-08-17).
  // ⚠️ lastConstraints är FLAT (concat, inte push) → räkna constraint-objekt
  // direkt, inte constraint-arrays.
  lastConstraints = { };
  await call("/admin/affar/list", { query: { type: "affar" } });
  const offConstr = lastConstraints["Offert"] || [];
  const fbConstraints = offConstr.filter((c) => c && c.key === "deal" && c.constraint_type === "in");
  ok("fallback: exakt EN 'deal in'-constraint (batchad) oavsett antal deals utan amount",
     fbConstraints.length === 1);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
