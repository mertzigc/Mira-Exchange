// Smoke: rikare affärskort — linked-tagging i /deal/:id + /doc-search-kandidater.
// Mockad Bubble. Kör: node affar_richcard_smoke.mjs
import { registerAffarRoutes } from "./affar_api.js";

// ── fake express ──
const routes = { get: {}, post: {}, options: {} };
const app = {
  get: (p, h) => { routes.get[p] = h; },
  post: (p, h) => { routes.post[p] = h; },
  options: (p, h) => { routes.options[p] = h; },
};
function call(method, path, { params = {}, query = {}, body = {} } = {}) {
  const h = routes[method][path];
  if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((resolve) => {
    const res = {
      _code: 200,
      status(c) { this._code = c; return this; },
      json(obj) { resolve({ code: this._code, body: obj }); return this; },
      sendStatus(c) { resolve({ code: c, body: null }); return this; },
    };
    h({ params, query, body, headers: {} }, res);
  });
}

// ── fake data ──
const DB = {
  ClientCompany: [
    { _id: "cc1", Name_company: "Acme AB", Kundansvarig: "u1" },
    { _id: "cc2", Name_company: "Beta Städ", Kundansvarig: null },
  ],
  User: [{ _id: "u1", "First Name": "Sara", "Last Name": "Säljare" }],
  deal: [
    { _id: "d1", titel: "Acme lunch", kundföretag: "cc1", Status: "Offert", value_brutto: 50000, sannolikhet: 0.6,
      offert: ["offM_list"], order: [], invoice: ["invF_list"], historik: [], lead: "lead1", kontaktpersoner: [], todo: [] },
    { _id: "d2", titel: "Beta ramavtal", kundföretag: "cc2", Status: "Avtal", value_brutto: 12000 },
  ],
  Lead: [{ _id: "lead1", Name: "Kalle Kund", Company: "cc1", "Created Date": "2026-07-01" }],
  activitet_crm: [{ _id: "akt1", deal: "d1", clientcompany: "cc1", beskrivning: "Ringde Acme", "Created Date": "2026-07-02" }],
  // Offert i Deal-listfält (offM_list) + en reverse-kopplad (offM_rev, deal=d1)
  Offert: [
    { _id: "offM_list", source: "mira_fe", status: "Approved", kundforetag: "cc1", offertnr: "FE-2026-0004", total: 20000, offertdatum: "2026-07-03", dokument: [] },
    { _id: "offM_rev", source: "mira_fe", status: "Sent", kundforetag: "cc1", offertnr: "FE-2026-0009", total: 15000, offertdatum: "2026-07-10", dokument: [], deal: "d1" },
  ],
  FortnoxOffer: [{ _id: "offF_rev", ft_customer_name: "Acme AB", ft_document_number: "7718", ft_total: 9000, ft_offer_date: "2026-07-05", deal: "d1" }],
  MiraOrder: [{ _id: "moX", kundforetag: "cc1", ordernr: "FE-2026-0004", total: 20000, orderdatum: "2026-07-06", offert: "offM_list", orderstatus: "Bekräftad" }],
  FortnoxOrder: [
    { _id: "foFE", ft_customer_name: "Acme AB", ft_document_number: "10500", ft_total: 8000, connection: "FE_CONN", deal: "d1" },
    // ⚠️ RÄTTAT 2026-08-20: HK-ordern exkluderades tidigare ur affärsvyn till
    // förmån för TengellaWorkorder — en typ fryst sedan 2026-06-04. Efter
    // §9-cutovern (LIVE 2026-06-08) ÄR detta den kanoniska HK-raden och SKA
    // ingå. HK bär ft_order_date, aldrig ft_delivery_date.
    { _id: "foTeng", ft_customer_name: "Beta Städ", ft_document_number: "10825", ft_total: 3000, ft_order_date: "2026-07-09", connection: "TENG_CONN", source: "tengella-workorder", deal: "d1" },
    // HK-order kopplad till d2 (tidigare TengellaWorkorder "woBeta").
    { _id: "woBeta", ft_customer_name: "Beta Städ", ft_document_number: "WO-99", ft_total: 1000, ft_order_date: "2026-07-08", connection: "TENG_CONN", source: "tengella-workorder", deal: "d2" },
  ],
  // HK-order kopplad till d2 — ligger i FortnoxOrder efter cutovern, med
  // raderna i FortnoxOrderRow (tidigare inbäddade i workorder_rows_json).
  FortnoxOrderRow: [
    { _id: "forB", connection: "TENG_CONN", ft_order_document_number: "WO-99", ft_row_index: 1,
      ft_article_number: "S1", ft_description: "Städ", ft_quantity: 2, ft_price: "500", ft_total: "1000" },
  ],
  FortnoxInvoice: [
    { _id: "invF_list", ft_customer_name: "Acme AB", ft_document_number: "F-1", ft_total: 20000, ft_invoice_date: "2026-07-20", ft_balance: 0, connection: "FE_CONN" },
    { _id: "invF_rev", ft_customer_name: "Acme AB", ft_document_number: "F-2", ft_total: 9000, ft_invoice_date: "2026-07-22", ft_balance: 9000, connection: "FE_CONN", deal: "d1" },
  ],
  Contract: [{ _id: "ct1", "kundföretag": "cc2", contract_title: "Beta ramavtal", "månadskostnad": 4000, startdatum: "2026-06-01", deal: "d2" }],
  Coworker: [], Todo: [], "leverantör-supplier": [],
};

const _match = (rec, c) => {
  const v = rec[c.key];
  if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value);
  if (c.constraint_type === "text contains") return String(v == null ? "" : v).toLowerCase().includes(String(c.value).toLowerCase());
  if (c.constraint_type === "in") return Array.isArray(c.value) && c.value.map(String).includes(String(v));
  return true;
};
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (type, { constraints = [] } = {}) => (DB[type] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFind: async (type, { constraints = [], limit = 100, cursor = 0 } = {}) => (DB[type] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(cursor, cursor + limit),
  bubbleGet: async (type, id) => (DB[type] || []).find((r) => r._id === id) || null,
  bubbleCount: async (type, constraints = []) => (DB[type] || []).filter((r) => constraints.every((c) => _match(r, c))).length,
  bubblePatch: async () => ({}),
  planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE_CONN", TENGELLA_CONNECTION_ID: "TENG_CONN",
  CONNECTION_NAMES: { FE_CONN: "Food & Event", TENG_CONN: "Housekeeping" },
};

registerAffarRoutes(app, deps);

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const run = async () => {
  // ── /deal/d1 — linked-tagging ──
  const r1 = await call("get", "/admin/affar/deal/:id", { params: { id: "d1" } });
  ok("deal d1 ok", r1.body && r1.body.ok);
  const ch = r1.body.chain;
  const off = ch.offert.items;
  const byId = (arr, id) => arr.find((x) => x.id === id);
  ok("offert: 3 st (list+2 reverse)", off.length === 3);
  ok("offM_list linked=false (via Deal-listfält)", byId(off, "offM_list") && byId(off, "offM_list").linked === false);
  ok("offM_rev linked=true (P3 reverse)", byId(off, "offM_rev") && byId(off, "offM_rev").linked === true);
  ok("offF_rev linked=true (FortnoxOffer bara reverse)", byId(off, "offF_rev") && byId(off, "offF_rev").linked === true);
  ok("offert summa = 20000+15000+9000", (off.reduce((s, x) => s + (x.amount || 0), 0)) === 44000);

  const ord = ch.order.items;
  ok("order: foFE + moX + foTeng (HK ingår efter §9-cutovern)",
     ord.length === 3 && byId(ord, "foFE") && byId(ord, "moX") && !!byId(ord, "foTeng"));
  ok("HK-ordern märks som tengella", (byId(ord, "foTeng") || {}).source === "tengella");
  ok("HK-ordern dateras på ft_order_date", (byId(ord, "foTeng") || {}).date === "2026-07-09");
  ok("foFE linked=true (reverse, ej i Deal.order-listfält)", byId(ord, "foFE") && byId(ord, "foFE").linked === true);
  ok("moX linked=false (via offert-kedjan)", byId(ord, "moX") && byId(ord, "moX").linked === false);

  const inv = ch.faktura.items;
  ok("faktura: 2 st", inv.length === 2);
  ok("invF_list linked=false (Deal.invoice-listfält)", byId(inv, "invF_list") && byId(inv, "invF_list").linked === false);
  ok("invF_rev linked=true (reverse)", byId(inv, "invF_rev") && byId(inv, "invF_rev").linked === true);

  // ── /deal/d2 — avtal + workorder reverse ──
  const r2 = await call("get", "/admin/affar/deal/:id", { params: { id: "d2" } });
  ok("d2 avtal linked=true", r2.body.chain.avtal.items.length === 1 && r2.body.chain.avtal.items[0].linked === true);
  ok("d2 workorder linked=true + belopp 1000", r2.body.chain.order.items.length === 1 && r2.body.chain.order.items[0].linked === true && r2.body.chain.order.items[0].amount === 1000);

  // ── /doc-search offert ──
  const ds1 = await call("get", "/admin/affar/doc-search", { query: { type: "offert", q: "Acme" } });
  ok("doc-search offert ok", ds1.body.ok);
  const offCand = ds1.body.rows;
  ok("offert-kandidater innehåller Mira + Fortnox", offCand.some((x) => x.source === "mira") && offCand.some((x) => x.source === "fortnox"));
  ok("offert alla linkable", offCand.every((x) => x.linkable === true));
  // deal_name visas för dok med eget `deal`-fält satt (offM_rev), ej för listfält-medlemmar (offM_list)
  const cand09 = offCand.find((x) => x.number === "FE-2026-0009");
  ok("FE-2026-0009 deal_name = Acme lunch (eget deal-fält)", cand09 && cand09.deal_name === "Acme lunch");
  const cand04 = offCand.find((x) => x.number === "FE-2026-0004");
  ok("FE-2026-0004 deal_name tom (bara i Deal-listfält, ej eget deal)", cand04 && cand04.deal_name === "");

  // ── /doc-search order: mira ej linkable, tengella-fortnox exkluderad ──
  const ds2 = await call("get", "/admin/affar/doc-search", { query: { type: "order", q: "Acme" } });
  const oc = ds2.body.rows;
  const mira = oc.find((x) => x.number === "FE-2026-0004" && x.source === "mira");
  ok("order Mira linkable=false", mira && mira.linkable === false);
  ok("order fortnox(FE) linkable=true finns", oc.some((x) => x.number === "10500" && x.source === "fortnox" && x.linkable === true));
  ok("order fortnox(TENGELLA-spegel 10825) exkluderad", !oc.some((x) => x.number === "10825"));

  const ds3 = await call("get", "/admin/affar/doc-search", { query: { type: "order", q: "Beta" } });
  ok("order tengella-workorder WO-99 linkable=true", ds3.body.rows.some((x) => x.number === "WO-99" && x.source === "tengella" && x.linkable === true));

  // ── /doc-search faktura + avtal + okänd typ ──
  const ds4 = await call("get", "/admin/affar/doc-search", { query: { type: "faktura", q: "Acme" } });
  ok("faktura-kandidater 2 st linkable", ds4.body.rows.length === 2 && ds4.body.rows.every((x) => x.linkable === true));
  const ds5 = await call("get", "/admin/affar/doc-search", { query: { type: "avtal", q: "Beta" } });
  ok("avtal-kandidat Beta ramavtal", ds5.body.rows.some((x) => x.number === "Beta ramavtal"));
  const ds6 = await call("get", "/admin/affar/doc-search", { query: { type: "blah", q: "xx" } });
  ok("okänd typ → 400", ds6.code === 400);
  const ds7 = await call("get", "/admin/affar/doc-search", { query: { type: "offert", q: "a" } });
  ok("q<2 → tom lista", ds7.body.ok && ds7.body.rows.length === 0);

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
