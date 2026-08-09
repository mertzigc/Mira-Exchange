// Smoke: order-PDF + kök-PM (kör riktiga HTML-byggarna) + affär render-route. node affar_render_smoke.mjs
import { registerOffertRoutes } from "./offert_api.js";
import { registerAffarRoutes } from "./affar_api.js";

const noApp = () => ({ get(){}, post(){}, options(){}, patch(){} });

const DB = {
  MiraOrder: [{ _id: "moM", source: "mira_fe", ordernr: "FE-2026-0001", orderdatum: "2026-07-06", orderstatus: "I produktion", kundforetag: "cc1", leveransdatum: "2026-08-01", leveranstid: "11:30", leveransadress: "Kammakargatan 12, Stockholm", betalningsvillkor: "10 dagar", valuta: "SEK", villkor_text: "Villkor.", intern_instruktion: "Var på plats 10:30 för uppdukning!", summa: 2000, moms_belopp: 240, total: 2240 },
                { _id: "moF", source: "fortnox", ordernr: "40718" }],
  MiraOrderRad: [
    { _id: "r1", order: "moM", radnr: 1, benamning: "Dagens lunch", beskrivning_long: "God lunch", antal: 15, enhet: "st", apris: 100, rabatt: 0, moms: 12, radsumma: 1500, kok: "k1", prep_kategori: "Varmkök" },
    { _id: "r2", order: "moM", radnr: 2, benamning: "Spira vatten", beskrivning_long: "", antal: 10, enhet: "st", apris: 20, rabatt: 0, moms: 12, radsumma: 200, kok: "", prep_kategori: "" },
  ],
  ClientCompany: [{ _id: "cc1", Name_company: "Acme AB", Org_Number: "5560001111", Adress: "Storgatan 1" }],
  Kok: [{ _id: "k1", namn: "Varmkök Söder", aktiv: true }],
  Offert: [], OffertRad: [],
};
const _match = (r, c) => { const v = r[c.key]; if (c.constraint_type === "equals") return String(v == null ? "" : v) === String(c.value); return true; };
let captured = [];
const bubbleMocks = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFind: async (t, { constraints = [], limit = 300 } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))).slice(0, limit),
  bubbleFindAll: async (t, { constraints = [] } = {}) => (DB[t] || []).filter((r) => constraints.every((c) => _match(r, c))),
  bubbleFindOne: async (t, cs = []) => (DB[t] || []).find((r) => cs.every((c) => _match(r, c))) || null,
  bubbleGet: async (t, id) => (DB[t] || []).find((r) => r._id === id) || null,
  bubbleCreate: async () => "new", bubblePatch: async () => ({}), bubbleDelete: async () => ({}),
  bubbleCount: async (t) => (DB[t] || []).length,
};
const contractRenderEngine = { renderAndPersist: async ({ templateHtml, titel }) => { captured.push({ titel, html: templateHtml }); return { file_url: "//cdn/" + encodeURIComponent(titel) + ".pdf", dokument_id: "doc1", bytes: 1234 }; } };

const offertEngine = registerOffertRoutes(noApp(), {
  ...bubbleMocks, contractRenderEngine, planningAuthed: () => true, planningCors: () => {}, FE_CONNECTION_ID: "FE",
});

// affär-route med render wired
const routes = { get: {}, post: {}, options: {} };
const app2 = { get: (p, h) => { routes.get[p] = h; }, post: (p, h) => { routes.post[p] = h; }, options: (p, h) => { routes.options[p] = h; } };
registerAffarRoutes(app2, {
  ...bubbleMocks, planningAuthed: () => true, planningCors: () => {}, publicRateLimited: () => false, clientIp: () => "x",
  FE_CONNECTION_ID: "FE", CONNECTION_NAMES: { FE: "Food & Event" },
  offertConvert: async () => ({ ok: true }),
  renderOrderPdf: (id, kind) => offertEngine.renderOrderPdf(id, kind),
});
function callP(path, { params = {}, query = {} } = {}) {
  const h = routes.post[path]; return new Promise((resolve) => { const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { resolve({ code: this._c, body: o }); } }; h({ params, query, body: {}, headers: {} }, res); });
}

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const run = async () => {
  // ── kund-order-PDF ──
  const ro = await offertEngine.renderOrderPdf("moM", "order");
  ok("renderOrderPdf order ok + file_url", ro.ok && /Order%20FE-2026-0001/.test(ro.file_url));
  const orderHtml = captured[captured.length - 1].html;
  ok("order-html: Orderbekräftelse + leverans-banner", /Orderbekräftelse/.test(orderHtml) && /class="o-lev"/.test(orderHtml) && /2026-08-01/.test(orderHtml) && /11:30/.test(orderHtml));
  ok("order-html: kund + rader + totaler", /Acme AB/.test(orderHtml) && /Dagens lunch/.test(orderHtml) && /Att betala/.test(orderHtml));

  // ── kök-PM ──
  const rp = await offertEngine.renderOrderPdf("moM", "pm");
  ok("renderOrderPdf pm ok", rp.ok && /PM%20FE-2026-0001/.test(rp.file_url));
  const pmHtml = captured[captured.length - 1].html;
  ok("pm-html: Produktions-PM + leverans-banner", /Produktions-PM/.test(pmHtml) && /class="pm-lev"/.test(pmHtml) && /11:30/.test(pmHtml));
  ok("pm-html: intern instruktion highlightad", /Intern instruktion/.test(pmHtml) && /Var på plats 10:30/.test(pmHtml));
  ok("pm-html: grupperad per kök (Varmkök Söder + Ej tilldelat kök)", /Varmkök Söder/.test(pmHtml) && /Ej tilldelat kök/.test(pmHtml));
  ok("pm-html: mat highlightad (pm-ben) utan pris-kolumn", /pm-ben/.test(pmHtml) && !/Att betala/.test(pmHtml));

  // ── affär render-route ──
  const rr = await callP("/admin/affar/order/:id/render-pdf", { params: { id: "moM" }, query: { kind: "pm" } });
  ok("affär render-route pm → https-url", rr.body.ok && rr.body.kind === "pm" && /^https:\/\/cdn\//.test(rr.body.file_url));
  const rrf = await callP("/admin/affar/order/:id/render-pdf", { params: { id: "moF" }, query: { kind: "order" } });
  ok("Fortnox-order render → 400 ej_mira_order", rrf.code === 400 && rrf.body.error === "ej_mira_order");

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
