// offert_api.js
// ─────────────────────────────────────────────────────────────────────────────
// F&E offert-modul (Fas 2). Mira = system of record för Food & Event-offerter.
// Design + beslut: OFFERT_PRODUKTION_HANDOFF.md.
//
// DI-mönster (som contract_render.js / offer_approval_doc.js): index.js skickar
// in bubble-helpers, auth-helpers, contractRenderEngine + FE_CONNECTION_ID via
// registerOffertRoutes(app, deps). ALL offert-kod bor här → index.js växer inte.
//
// Endpoints (alla admin-only, x-admin-token = PLANNING_ADMIN_TOKEN):
//   GET  /admin/offert/products?q=      — F&E-artikel-autocomplete (FortnoxConnection-filtrerad)
//   GET  /admin/offert/list             — offert-lista (source=mira_fe)
//   GET  /admin/offert/:id              — en offert + dess rader
//   POST /admin/offert/create           — skapa offert + rader (offertnr, cachade totaler)
//   PATCH /admin/offert/:id             — uppdatera offert + ersätt rader
//   POST /admin/offert/:id/render-pdf   — kund-PDF (Mira-genererad, obegränsad radtext)
//   POST /admin/offert/:id/convert-to-order — accept → MiraOrder (Fas 3-trigger, testbar nu)
// ─────────────────────────────────────────────────────────────────────────────

export function registerOffertRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleFindOne, bubbleCreate, bubblePatch, bubbleGet, bubbleDelete, bubbleId,
    contractRenderEngine, planningAuthed, planningCors, FE_CONNECTION_ID,
    publicRateLimited, clientIp, createApprovalRequest,
  } = deps;

  const req_ = (name, v) => { if (!v) throw new Error(`registerOffertRoutes: ${name} required`); };
  req_("bubbleFind", bubbleFind); req_("bubbleCreate", bubbleCreate); req_("bubblePatch", bubblePatch);
  req_("bubbleGet", bubbleGet); req_("contractRenderEngine", contractRenderEngine);
  req_("planningAuthed", planningAuthed); req_("FE_CONNECTION_ID", FE_CONNECTION_ID);

  const TYPE_OFFERT = "Offert";
  const TYPE_OFFERTRAD = "OffertRad";
  const TYPE_ORDER = "MiraOrder";
  const TYPE_ORDERRAD = "MiraOrderRad";
  const SOURCE_MIRA_FE = "mira_fe";
  const PROD_CATEGORY_FIELD = "Product category"; // återanvänt Product-fält = prep-kategori

  // ── små helpers ────────────────────────────────────────────────────
  const _num = (v) => {
    if (v == null || v === "") return 0;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const _round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const _str = (v) => (v == null ? "" : String(v));
  const _esc = (s) => _str(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  // användartext får aldrig innehålla {{token}} som renderTemplate skulle råka substituera
  const _noMustache = (s) => _str(s).replace(/\{\{/g, "{​{");
  // Bubble geografisk adress → sträng. Data API ger {address, formatted, lat, lng}.
  const _pickAddr = (raw) => raw == null ? ""
    : (typeof raw === "object" ? _str(raw.address || raw.formatted || "") : _str(raw).trim());
  const _iso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const _ts = (v) => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };
  // droppa null/undefined ur payload så Bubble behåller defaults / rör inte fält
  const _clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
    return out;
  };

  // ── radberäkning (server-side, litar aldrig på klientens radsumma) ──
  // apris + radsumma ex moms. moms = procent (12/25). rabatt = procent.
  function computeRow(r) {
    const antal = _num(r.antal);
    const apris = _num(r.apris);
    const rabatt = _num(r.rabatt);
    const radsumma = _round2(antal * apris * (1 - rabatt / 100));
    return radsumma;
  }
  function computeTotals(rows) {
    let summa = 0, moms_belopp = 0;
    for (const r of rows) {
      const rs = computeRow(r);
      summa += rs;
      moms_belopp += rs * (_num(r.moms) / 100);
    }
    summa = _round2(summa);
    moms_belopp = _round2(moms_belopp);
    return { summa, moms_belopp, total: _round2(summa + moms_belopp) };
  }

  // ── offertnr: FE-{år}-{seq} (best-effort löpnummer) ────────────────
  async function generateOffertnr() {
    const year = new Date().getFullYear();
    const prefix = `FE-${year}-`;
    let maxSeq = 0;
    try {
      const rows = await bubbleFind(TYPE_OFFERT, {
        constraints: [{ key: "source", constraint_type: "equals", value: SOURCE_MIRA_FE }],
        limit: 200, sort_field: "Created Date", descending: true,
      });
      for (const row of rows) {
        const m = /^FE-(\d{4})-(\d+)$/.exec(_str(row.offertnr));
        if (m && Number(m[1]) === year) maxSeq = Math.max(maxSeq, Number(m[2]));
      }
    } catch (_) { /* best-effort */ }
    return prefix + String(maxSeq + 1).padStart(4, "0");
  }

  // ── bygg offert-huvud-payload från body ────────────────────────────
  function buildOffertPayload(body, { isCreate }) {
    const p = {
      titel: body.titel != null ? _str(body.titel) : undefined,
      kundforetag: body.kundforetag || undefined,
      office: body.office || undefined,
      offertdatum: _iso(body.offertdatum),
      giltig_till: _iso(body.giltig_till),
      leveransdatum: _iso(body.leveransdatum),
      leveranstid: body.leveranstid != null ? _str(body.leveranstid) : undefined,
      leveransadress: body.leveransadress || undefined,
      betalningsvillkor: body.betalningsvillkor != null ? _str(body.betalningsvillkor) : undefined,
      momstyp: body.momstyp != null ? _str(body.momstyp) : undefined,
      valuta: body.valuta != null ? _str(body.valuta) : (isCreate ? "SEK" : undefined),
      beskrivning: body.beskrivning != null ? _str(body.beskrivning) : undefined,
      villkor_text: body.villkor_text != null ? _str(body.villkor_text) : undefined,
      comission: body.comission || undefined,
      recipient: Array.isArray(body.recipient) ? body.recipient : undefined,
      sender: Array.isArray(body.sender) ? body.sender : undefined,
    };
    if (isCreate) {
      p.source = SOURCE_MIRA_FE;
      p.status = body.status || "Draft"; // offer_approval_status
      if (body.offertdatum == null) p.offertdatum = new Date().toISOString();
    }
    return _clean(p);
  }

  // ── skapa OffertRad-rader för en offert ────────────────────────────
  async function createRows(offertId, rows) {
    const list = Array.isArray(rows) ? rows : [];
    const created = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i] || {};
      const radsumma = computeRow(r);
      const payload = _clean({
        offert: offertId,
        radnr: r.radnr != null ? _num(r.radnr) : (i + 1),
        product: r.product || undefined,
        artikelnr: _str(r.artikelnr),
        benamning: _str(r.benamning),
        beskrivning_long: _str(r.beskrivning_long),
        antal: _num(r.antal),
        enhet: _str(r.enhet),
        apris: _num(r.apris),
        rabatt: _num(r.rabatt),
        moms: _num(r.moms),
        radsumma,
        konto: _str(r.konto),
        ks: _str(r.ks),
      });
      const id = await bubbleCreate(TYPE_OFFERTRAD, payload);
      created.push(id);
    }
    return created;
  }

  async function loadRows(offertId) {
    const rows = await bubbleFindAll(TYPE_OFFERTRAD, {
      constraints: [{ key: "offert", constraint_type: "equals", value: offertId }],
    });
    return rows.sort((a, b) => _num(a.radnr) - _num(b.radnr));
  }

  async function deleteRows(offertId) {
    const rows = await loadRows(offertId);
    for (const r of rows) {
      const id = bubbleId(r);
      if (id) { try { await bubbleDelete(TYPE_OFFERTRAD, id); } catch (_) {} }
    }
    return rows.length;
  }

  // ── PDF-mall: Fortnox-lik offertlayout, obegränsad beskrivning_long ─
  function buildOffertHtml({ offert, rows, company, office }) {
    const money = (n) => _round2(n).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const totals = computeTotals(rows);
    const custName = _esc(company?.Name_company || offert.titel || "");
    const custOrg = _esc(company?.Org_Number || "");
    const isPrivat = _str(company?.customer_type) === "Privat";
    const custAddr = _esc(_pickAddr(company?.Adress) || _pickAddr(company?.address) || _pickAddr(company?.Address) || _pickAddr(company?.faktura_adress));
    const officeName = _esc(office?.Office_title || "");
    const dOff = offert.offertdatum ? _esc(String(offert.offertdatum).slice(0, 10)) : "";
    const dValid = offert.giltig_till ? _esc(String(offert.giltig_till).slice(0, 10)) : "";
    const dLev = offert.leveransdatum ? _esc(String(offert.leveransdatum).slice(0, 10)) : "";
    const levAddr = _esc(_pickAddr(offert.leveransadress));

    const rowsHtml = rows.map((r) => {
      const rs = computeRow(r);
      const benamning = _esc(_noMustache(r.benamning));
      const beskr = _noMustache(r.beskrivning_long || "");
      const beskrHtml = beskr
        ? `<div class="o-rad-beskr">${_esc(beskr).replace(/\n/g, "<br>")}</div>`
        : "";
      return `<tr>
        <td class="o-artnr">${_esc(r.artikelnr || "")}</td>
        <td class="o-ben"><div class="o-ben-titel">${benamning}</div>${beskrHtml}</td>
        <td class="o-num">${_esc(money(_num(r.antal)))}</td>
        <td class="o-enh">${_esc(r.enhet || "")}</td>
        <td class="o-num">${_esc(money(_num(r.apris)))}</td>
        <td class="o-num">${_num(r.rabatt) ? _esc(money(_num(r.rabatt))) + "%" : ""}</td>
        <td class="o-num">${_esc(money(rs))}</td>
        <td class="o-num">${_esc(String(_num(r.moms)))}%</td>
      </tr>`;
    }).join("");

    // markör för saknat värde (tydlig signal i granskning innan utskick)
    const M = (t) => `<span class="o-missing">${_esc(t)}</span>`;

    return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; font-size: 11px; margin: 0; }
  h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: .5px; }
  .o-sub { color: #6b7280; font-size: 11px; margin-bottom: 18px; }
  .o-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
  .o-meta { text-align: right; font-size: 11px; line-height: 1.6; }
  .o-meta b { display: inline-block; min-width: 92px; text-align: left; color: #6b7280; font-weight: 500; }
  .o-cols { display: flex; gap: 24px; margin-bottom: 18px; }
  .o-box { flex: 1; }
  .o-box h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: #6b7280; margin: 0 0 4px; }
  .o-box p { margin: 0; line-height: 1.5; }
  table.o-rows { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.o-rows th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px;
    color: #6b7280; border-bottom: 1.5px solid #111; padding: 6px 6px; }
  table.o-rows td { padding: 8px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  .o-num { text-align: right; white-space: nowrap; }
  .o-ben-titel { font-weight: 600; }
  .o-rad-beskr { color: #374151; margin-top: 3px; font-size: 10.5px; line-height: 1.45; }
  .o-totals { margin-top: 14px; margin-left: auto; width: 260px; font-size: 11.5px; }
  .o-totals div { display: flex; justify-content: space-between; padding: 3px 0; }
  .o-totals .o-grand { border-top: 1.5px solid #111; margin-top: 4px; padding-top: 6px; font-weight: 700; font-size: 13px; }
  .o-villkor { margin-top: 26px; padding-top: 12px; border-top: 1px solid #e5e7eb; color: #374151; line-height: 1.5; white-space: pre-wrap; }
  .o-missing { color: #b91c1c; font-style: italic; font-weight: 400; }
</style></head><body>
  <div class="o-head">
    <div>
      <h1>Offert</h1>
      <div class="o-sub">${_esc(offert.offertnr || "")}${officeName ? " · " + officeName : ""}</div>
    </div>
    <div class="o-meta">
      <div><b>Offertnr</b> ${offert.offertnr ? _esc(offert.offertnr) : M("saknas")}</div>
      <div><b>Offertdatum</b> ${dOff || M("saknas")}</div>
      <div><b>Giltig t.o.m.</b> ${dValid || M("saknas")}</div>
      <div><b>Leveransdatum</b> ${dLev ? dLev + (offert.leveranstid ? " " + _esc(offert.leveranstid) : "") : M("saknas")}</div>
      <div><b>Betalningsvillkor</b> ${offert.betalningsvillkor ? _esc(offert.betalningsvillkor) : M("saknas")}</div>
    </div>
  </div>

  <div class="o-cols">
    <div class="o-box">
      <h3>Kund</h3>
      <p>${custName || M("kundnamn saknas")}<br>${isPrivat ? "Privatperson" : (custOrg ? "Org.nr " + custOrg : M("org.nr saknas"))}<br>${custAddr || M("adress saknas")}</p>
    </div>
    <div class="o-box">
      <h3>Leverans</h3>
      <p>${levAddr || M("leveransadress saknas")}<br>${dLev ? dLev + (offert.leveranstid ? " " + _esc(offert.leveranstid) : "") : M("leveransdatum saknas")}</p>
    </div>
  </div>

  ${offert.beskrivning ? `<p>${_esc(_noMustache(offert.beskrivning)).replace(/\n/g, "<br>")}</p>` : ""}

  <table class="o-rows">
    <thead><tr>
      <th>Artikelnr</th><th>Benämning</th><th class="o-num">Antal</th><th>Enhet</th>
      <th class="o-num">À-pris</th><th class="o-num">Rabatt</th><th class="o-num">Summa</th><th class="o-num">Moms</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <div class="o-totals">
    <div><span>Summa (ex. moms)</span><span>${_esc(money(totals.summa))} ${_esc(offert.valuta || "SEK")}</span></div>
    <div><span>Moms</span><span>${_esc(money(totals.moms_belopp))} ${_esc(offert.valuta || "SEK")}</span></div>
    <div class="o-grand"><span>Att betala</span><span>${_esc(money(totals.total))} ${_esc(offert.valuta || "SEK")}</span></div>
  </div>

  ${offert.villkor_text ? `<div class="o-villkor">${_esc(_noMustache(offert.villkor_text))}</div>` : ""}
</body></html>`;
  }

  // ── convertOffertToOrder — accept → MiraOrder + rader (återanvänds av endpoint + signering) ──
  // ⚠️ Kräver att MiraOrder har fälten `ordernr` (text) + `orderdatum` (date).
  async function convertOffertToOrder(offertId) {
    const offert = await bubbleGet(TYPE_OFFERT, offertId);
    if (!offert) return { ok: false, error: "offert_not_found" };
    // idempotens: finns redan en order för offerten?
    const existing = await bubbleFindOne(TYPE_ORDER, [{ key: "offert", constraint_type: "equals", value: offertId }]);
    if (existing) return { ok: true, order_id: bubbleId(existing), created: false, reason: "already_converted" };

    const rows = await loadRows(offertId);
    const leverans_ts = _ts(offert.leveransdatum);

    const orderId = await bubbleCreate(TYPE_ORDER, _clean({
      offert: offertId,
      ordernr: offert.offertnr || null,
      orderdatum: new Date().toISOString(),
      orderstatus: "Bekräftad",
      kundforetag: offert.kundforetag || null,
      office: offert.office || null,
      comission: offert.comission || null,
      leveransdatum: offert.leveransdatum || null,
      leveranstid: offert.leveranstid || null,
      leveransadress: offert.leveransadress || null,
      leverans_ts,
      betalningsvillkor: offert.betalningsvillkor || null,
      momstyp: offert.momstyp || null,
      valuta: offert.valuta || null,
      summa: _num(offert.summa),
      moms_belopp: _num(offert.moms_belopp),
      total: _num(offert.total),
      villkor_text: offert.villkor_text || null,
      source: SOURCE_MIRA_FE,
    }));

    let radCount = 0;
    for (const r of rows) {
      let default_kok = null, prep = "";
      if (r.product) {
        const prod = await bubbleGet("Product", r.product).catch(() => null);
        if (prod) { default_kok = prod.default_kok || null; prep = prod[PROD_CATEGORY_FIELD] || ""; }
      }
      await bubbleCreate(TYPE_ORDERRAD, _clean({
        order: orderId, offert: offertId, radnr: _num(r.radnr), product: r.product || null,
        artikelnr: r.artikelnr || null, benamning: r.benamning || null, beskrivning_long: r.beskrivning_long || null,
        antal: _num(r.antal), enhet: r.enhet || null, apris: _num(r.apris), rabatt: _num(r.rabatt),
        moms: _num(r.moms), radsumma: _num(r.radsumma), konto: r.konto || null, ks: r.ks || null,
        kok: default_kok, prep_kategori: prep || null, leverans_ts,
      }));
      radCount++;
    }
    // spegla accept på offerten
    try { await bubblePatch(TYPE_OFFERT, offertId, { status: "Approved" }); } catch (_) {}
    return { ok: true, order_id: orderId, created: true, rows_created: radCount };
  }

  // ── auth-wrapper ───────────────────────────────────────────────────
  function guard(req, res) {
    planningCors && planningCors(req, res);
    if (!planningAuthed(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
    // ⚠️ Egen rate-limit-hink ("offert:"-prefix). _publicRateLimited nycklar på strängen,
    // och delas annars per RÅ IP med bl.a. OTP-endpointen (lägre gräns) → admin-aktivitet
    // (autocomplete per tangenttryck m.m.) skulle annars äta OTP:ns budget. Isolerat här.
    if (publicRateLimited && clientIp && publicRateLimited("offert:" + clientIp(req), 240)) {
      res.status(429).json({ ok: false, error: "rate_limited" }); return false;
    }
    return true;
  }
  const opt = (path) => app.options(path, (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });

  // ═══ ENDPOINTS ═════════════════════════════════════════════════════

  // GET /admin/offert/products?q= — F&E-artikel-autocomplete
  opt("/admin/offert/products");
  app.get("/admin/offert/products", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const q = _str(req.query.q).trim();
      const base = [{ key: "FortnoxConnection", constraint_type: "equals", value: FE_CONNECTION_ID }];
      const seen = new Map();
      const add = (arr) => { for (const p of arr) { const id = bubbleId(p); if (id && !seen.has(id)) seen.set(id, p); } };
      if (q) {
        add(await bubbleFind("Product", { constraints: [...base, { key: "Produkttitel", constraint_type: "text contains", value: q }], limit: 25 }));
        if (/^\d+$/.test(q)) {
          add(await bubbleFind("Product", { constraints: [...base, { key: "ft_article_number", constraint_type: "text contains", value: q }], limit: 25 }));
        }
      } else {
        add(await bubbleFind("Product", { constraints: base, limit: 25, sort_field: "Produkttitel" }));
      }
      const results = [...seen.values()].slice(0, 25).map((p) => ({
        id: bubbleId(p),
        artikelnr: p.ft_article_number || "",
        titel: p.Produkttitel || "",
        apris: _num(p.ft_sales_price),
        enhet: p.ft_unit || "",
        moms: _num(p.ft_vat),
        beskrivning: p.Beskrivning || "",
        prep_kategori: p[PROD_CATEGORY_FIELD] || "",
        default_kok: p.default_kok || null,
      }));
      return res.json({ ok: true, count: results.length, results });
    } catch (e) {
      console.error("[/admin/offert/products]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // GET /admin/offert/coworkers?clientcompany= — kontaktpersoner (Coworker) på kunden (för mottagar-picker)
  opt("/admin/offert/coworkers");
  app.get("/admin/offert/coworkers", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const ccId = _str(req.query.clientcompany).trim();
      if (!ccId) return res.json({ ok: true, count: 0, items: [] });
      const rows = await bubbleFindAll("Coworker", {
        constraints: [{ key: "Kundföretag", constraint_type: "equals", value: ccId }],
      });
      const items = (rows || []).map((c) => {
        const email = _str(c.Email).trim();
        const name = [c["Förnamn"], c["Efternamn"]].filter(Boolean).join(" ").trim() || email;
        return email ? { id: bubbleId(c), name, email } : null;
      }).filter(Boolean);
      items.sort((a, b) => a.name.localeCompare(b.name, "sv"));
      return res.json({ ok: true, count: items.length, items });
    } catch (e) {
      console.error("[/admin/offert/coworkers]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // GET /admin/offert/list
  opt("/admin/offert/list");
  app.get("/admin/offert/list", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const rows = await bubbleFindAll(TYPE_OFFERT, {
        constraints: [{ key: "source", constraint_type: "equals", value: SOURCE_MIRA_FE }],
        sort_field: "Created Date", descending: true,
      });
      const results = rows.map((o) => ({
        id: bubbleId(o), offertnr: o.offertnr || "", titel: o.titel || "",
        status: o.status || "", offertdatum: o.offertdatum || null, giltig_till: o.giltig_till || null,
        leveransdatum: o.leveransdatum || null, total: _num(o.total), valuta: o.valuta || "SEK",
      }));
      return res.json({ ok: true, count: results.length, results });
    } catch (e) {
      console.error("[/admin/offert/list]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // GET /admin/offert/:id
  opt("/admin/offert/:id");
  app.get("/admin/offert/:id", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const offert = await bubbleGet(TYPE_OFFERT, req.params.id);
      if (!offert) return res.status(404).json({ ok: false, error: "offert_not_found" });
      const rows = await loadRows(req.params.id);
      return res.json({ ok: true, offert, rows });
    } catch (e) {
      console.error("[/admin/offert/:id]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // POST /admin/offert/create
  opt("/admin/offert/create");
  app.post("/admin/offert/create", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = req.body || {};
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const totals = computeTotals(rows);
      const payload = buildOffertPayload(body, { isCreate: true });
      payload.offertnr = body.offertnr ? _str(body.offertnr) : await generateOffertnr();
      payload.summa = totals.summa;
      payload.moms_belopp = totals.moms_belopp;
      payload.total = totals.total;
      const offertId = await bubbleCreate(TYPE_OFFERT, payload);
      const radIds = await createRows(offertId, rows);
      return res.json({ ok: true, offert_id: offertId, offertnr: payload.offertnr, rows_created: radIds.length, totals });
    } catch (e) {
      console.error("[/admin/offert/create]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // POST /admin/offert/client/create — skapa ClientCompany (företag/privat) + ev. Beställare (Coworker)
  opt("/admin/offert/client/create");
  app.post("/admin/offert/client/create", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const b = req.body || {};
      const type = _str(b.customer_type).trim() || "Företag";     // "Företag" | "Privat"
      const isForetag = type === "Företag";
      const namn = _str(b.namn).trim();
      if (!namn) return res.status(400).json({ ok: false, error: "namn_required" });

      const digits = (v) => { const d = _str(v).replace(/[^\d]/g, ""); return d ? Number(d) : null; };
      const orgDigits = _str(b.org_nr).replace(/[^\d]/g, "");

      const ccPayload = _clean({
        Name_company: namn,
        customer_type: type,
        Org_Number: (isForetag && orgDigits) ? orgDigits : null,   // privat → inget org.nr
        faktura_email: _str(b.faktura_email).trim() || null,
        faktura_referens: _str(b.faktura_referens).trim() || null,
        Adress: _str(b.adress).trim() || null,                     // ⚠️ geo-write via Data API (se HANDOFF)
        Telefon: digits(b.telefon),                                // Telefon = number-fält
      });
      const ccId = await bubbleCreate("ClientCompany", ccPayload);

      // Beställare → Coworker kopplad till nya kundföretaget
      let coworkerId = null;
      const be = b.bestallare || {};
      if (_str(be.email).trim() || _str(be.fornamn).trim() || _str(be.efternamn).trim()) {
        coworkerId = await bubbleCreate("Coworker", _clean({
          "Förnamn": _str(be.fornamn).trim() || null,
          "Efternamn": _str(be.efternamn).trim() || null,
          Email: _str(be.email).trim() || null,
          "Kundföretag": ccId,
        }));
      }

      return res.json({
        ok: true, clientcompany_id: ccId, coworker_id: coworkerId,
        name: namn, org_nr: (isForetag && orgDigits) ? orgDigits : null,
        address: _str(b.adress).trim() || null, customer_type: type,
      });
    } catch (e) {
      console.error("[/admin/offert/client/create]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // PATCH /admin/offert/:id — uppdaterar huvud + (om rows givet) ERSÄTTER raderna
  app.patch("/admin/offert/:id", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const id = req.params.id;
      const body = req.body || {};
      const existing = await bubbleGet(TYPE_OFFERT, id);
      if (!existing) return res.status(404).json({ ok: false, error: "offert_not_found" });

      const payload = buildOffertPayload(body, { isCreate: false });
      if (body.status) payload.status = _str(body.status);

      let rowsResult = null;
      if (Array.isArray(body.rows)) {
        await deleteRows(id);
        const radIds = await createRows(id, body.rows);
        const totals = computeTotals(body.rows);
        payload.summa = totals.summa;
        payload.moms_belopp = totals.moms_belopp;
        payload.total = totals.total;
        rowsResult = { rows_created: radIds.length, totals };
      }
      if (Object.keys(payload).length) await bubblePatch(TYPE_OFFERT, id, payload);
      return res.json({ ok: true, offert_id: id, updated: Object.keys(payload), rows: rowsResult });
    } catch (e) {
      console.error("[PATCH /admin/offert/:id]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // POST /admin/offert/:id/render-pdf — Mira-genererad kund-PDF → Offert.dokument
  opt("/admin/offert/:id/render-pdf");
  app.post("/admin/offert/:id/render-pdf", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const id = req.params.id;
      const offert = await bubbleGet(TYPE_OFFERT, id);
      if (!offert) return res.status(404).json({ ok: false, error: "offert_not_found" });
      const rows = await loadRows(id);

      const company = offert.kundforetag ? await bubbleGet("ClientCompany", offert.kundforetag).catch(() => null) : null;
      const office = offert.office ? await bubbleGet("Office", offert.office).catch(() => null) : null;

      const pdfTitel = `Offert ${offert.offertnr || id}`;
      const html = buildOffertHtml({ offert, rows, company, office });
      const rendered = await contractRenderEngine.renderAndPersist({
        templateHtml: html, spec: {}, titel: pdfTitel,
      });

      // Kirurgisk städ: hitta TIDIGARE auto-genererade offert-PDF:er (titel === pdfTitel)
      // i dokument-listan → ta bort dem. Uppladdade bilagor (annan titel) rörs ALDRIG.
      const cur = Array.isArray(offert.dokument) ? offert.dokument : [];
      const staleIds = [];
      for (const dId of cur) {
        if (!dId || dId === rendered.dokument_id) continue;
        const d = await bubbleGet("Dokument", dId).catch(() => null);
        if (d && _str(d.titel) === pdfTitel) staleIds.push(dId);
      }
      const nextList = cur.filter((d) => !staleIds.includes(d));
      if (rendered.dokument_id && !nextList.includes(rendered.dokument_id)) nextList.push(rendered.dokument_id);
      await bubblePatch(TYPE_OFFERT, id, { dokument: nextList });
      // radera de gamla raderna (non-fatal per rad)
      for (const sId of staleIds) { try { await bubbleDelete("Dokument", sId); } catch (_) {} }

      return res.json({ ok: true, offert_id: id, dokument_id: rendered.dokument_id, file_url: rendered.file_url, bytes: rendered.bytes, replaced: staleIds.length });
    } catch (e) {
      console.error("[/admin/offert/:id/render-pdf]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // POST /admin/offert/:id/convert-to-order — accept → MiraOrder + rader
  // ⚠️ Kräver att MiraOrder har fälten `ordernr` (text) + `orderdatum` (date)
  //    (döp om från offertnr/offertdatum, number→text). Fas 3 kopplar denna
  //    till offer_approval_status=Approved automatiskt; nu manuell + testbar.
  opt("/admin/offert/:id/convert-to-order");
  app.post("/admin/offert/:id/convert-to-order", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const out = await convertOffertToOrder(req.params.id);
      if (!out.ok) return res.status(out.error === "offert_not_found" ? 404 : 500).json(out);
      return res.json(out);
    } catch (e) {
      console.error("[/admin/offert/:id/convert-to-order]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // POST /admin/offert/:id/send-for-signing — rendera PDF + skapa OfferApproval-signering
  // Mottagare: body.recipients [{email,name,role}] ELLER Offert.recipient (Coworkers).
  // OfferApprovalRequest.offert länkas → auto-convert till MiraOrder vid Approved (§ hook i index.js).
  opt("/admin/offert/:id/send-for-signing");
  app.post("/admin/offert/:id/send-for-signing", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!createApprovalRequest) return res.status(501).json({ ok: false, error: "signing_not_wired" });
      const id = req.params.id;
      const offert = await bubbleGet(TYPE_OFFERT, id);
      if (!offert) return res.status(404).json({ ok: false, error: "offert_not_found" });
      const body = req.body || {};

      // 1) rendera aktuell PDF (så signeringsunderlaget alltid speglar senaste offert)
      const rows = await loadRows(id);
      const company = offert.kundforetag ? await bubbleGet("ClientCompany", offert.kundforetag).catch(() => null) : null;
      const office = offert.office ? await bubbleGet("Office", offert.office).catch(() => null) : null;
      const pdfTitel = `Offert ${offert.offertnr || id}`;
      const html = buildOffertHtml({ offert, rows, company, office });
      const rendered = await contractRenderEngine.renderAndPersist({ templateHtml: html, spec: {}, titel: pdfTitel });

      // dokument-lista: nya PDF:en + ev. befintliga bilagor (ej gamla auto-renders)
      const cur = Array.isArray(offert.dokument) ? offert.dokument : [];
      const staleIds = [];
      for (const dId of cur) {
        if (!dId || dId === rendered.dokument_id) continue;
        const d = await bubbleGet("Dokument", dId).catch(() => null);
        if (d && _str(d.titel) === pdfTitel) staleIds.push(dId);
      }
      const dokumentIds = cur.filter((d) => !staleIds.includes(d));
      if (rendered.dokument_id && !dokumentIds.includes(rendered.dokument_id)) dokumentIds.push(rendered.dokument_id);
      await bubblePatch(TYPE_OFFERT, id, { dokument: dokumentIds });
      for (const sId of staleIds) { try { await bubbleDelete("Dokument", sId); } catch (_) {} }

      // 2) mottagare — prioritet: body.recipients [{email,name}] → body.recipient_ids (Coworker-ids från UI) → Offert.recipient
      let recipients = Array.isArray(body.recipients) ? body.recipients.filter((r) => r && r.email) : [];
      const idsToResolve = (!recipients.length && Array.isArray(body.recipient_ids) && body.recipient_ids.length)
        ? body.recipient_ids
        : ((!recipients.length && Array.isArray(offert.recipient)) ? offert.recipient : []);
      for (const cwId of idsToResolve) {
        const cw = await bubbleGet("Coworker", cwId).catch(() => null);
        if (cw && cw.Email) recipients.push({ email: cw.Email, name: [cw["Förnamn"], cw["Efternamn"]].filter(Boolean).join(" ").trim(), role: "Signer" });
      }
      if (!recipients.length) return res.status(400).json({ ok: false, error: "recipients_required", hint: "Ingen beställare/recipient på offerten — skicka recipients i body." });

      // 3) skapa signeringsbegäran (länka offert → auto-convert vid Approved)
      const result = await createApprovalRequest({
        req,
        dokumentIds,
        payload: {
          rubrik: `Offert ${offert.offertnr || ""} – ${offert.titel || "Food & Event"}`.trim(),
          meddelande: _str(body.meddelande || offert.beskrivning || ""),
          sender_email: _str(body.sender_email || ""),
          sender_name: _str(body.sender_name || "Carotte"),
          clientcompany: offert.kundforetag || null,
          deal: offert.deal || null,
          offert: id,
          recipients,
          expires_at: offert.giltig_till || null,
        },
      });

      await bubblePatch(TYPE_OFFERT, id, { status: "Sent" });
      return res.json({ ok: true, offert_id: id, request_id: result && (result.request_id || result.requestId || result.request), recipients: recipients.length, file_url: rendered.file_url });
    } catch (e) {
      console.error("[/admin/offert/:id/send-for-signing]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  console.log("[offert_api] routes registered (/admin/offert/*)");
  return { convertOffertToOrder };
}
