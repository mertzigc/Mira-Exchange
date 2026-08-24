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

  // ── KATEGORI + NUMMERSERIE PER BOLAG (2026-08-24) ──────────────────
  // "Offert Allmän" (uppladdat dokument) fungerar för alla bolag — men numret och
  // kategorin måste följa med, annars heter en HK-offert `FE-2026-0042` och räknas
  // som Food & Event i listan.
  //
  // ⚠️ Kategorivärdena är Category-option-setets KANONISKA fyra. `Service & People`
  // heter INTE `Staff` — `Staff` är anslutningens namn. Se [[bubble-option-sets]];
  // fel värde ger 400 "could not parse this as a Category", inte ett tyst fel.
  const OFFERT_KATEGORIER = ["Food & Event", "Housekeeping", "Service & People", "Other facility services"];
  const KAT_PREFIX = {
    "Food & Event": "FE",
    "Housekeeping": "HK",
    "Service & People": "SP",
    "Other facility services": "OF",
  };
  const DEFAULT_KATEGORI = "Food & Event";   // bakåtkompatibelt: befintlig serie orörd
  // ⚠️ `kategori` blir ett Option Set (Category) i Bubble → kan läsas tillbaka som
  // STRÄNG eller som `{display}`-OBJEKT. `_str(objekt)` ger "[object Object]", vilket
  // hade fallit igenom som "okänd kategori" och tyst degraderat PDF-rubriken till
  // Food & Event på en HK-offert. Samma klass av fel som fastighetsnamnen och
  // aktivitet_nasta_steg. Se [[bubble-option-sets]].
  function _katOf(v) {
    if (v == null) return "";
    const s = (typeof v === "object") ? _str(v.display || v.Display || "") : _str(v);
    const t = s.trim();
    return OFFERT_KATEGORIER.indexOf(t) > -1 ? t : "";
  }
  // ── offertnr: {PREFIX}-{år}-{seq} — egen löpnummerserie per bolag ──
  // ⚠️ Sekvensen söks på PREFIXET, inte på `source`. Filtrerade man som förr på
  // source hämtades de 200 SENASTE Mira-offerterna oavsett serie — dominerar F&E
  // hittas HK:s högsta nummer aldrig och serien börjar om på 0001 → krock.
  async function generateOffertnr(kategori) {
    const year = new Date().getFullYear();
    const pfx = KAT_PREFIX[_katOf(kategori) || DEFAULT_KATEGORI] || KAT_PREFIX[DEFAULT_KATEGORI];
    const prefix = `${pfx}-${year}-`;
    let maxSeq = 0;
    try {
      const rows = await bubbleFind(TYPE_OFFERT, {
        constraints: [
          { key: "source", constraint_type: "equals", value: SOURCE_MIRA_FE },
          { key: "offertnr", constraint_type: "text contains", value: prefix },
        ],
        limit: 200, sort_field: "Created Date", descending: true,
      });
      const re = new RegExp("^" + pfx + "-(\\d{4})-(\\d+)$");
      for (const row of rows) {
        const m = re.exec(_str(row.offertnr));
        if (m && Number(m[1]) === year) maxSeq = Math.max(maxSeq, Number(m[2]));
      }
    } catch (_) { /* best-effort */ }
    return prefix + String(maxSeq + 1).padStart(4, "0");
  }
  // ⚠️ `kategori` är ett NYTT fält på Offert. Modulen får rå bubbleCreate/bubblePatch
  // → okänt fält 400:ar HELA skrivningen. Stryp bara det fältet och rapportera, så
  // offerten går att spara även innan fältet finns i Bubble.
  function _unknownField(e, field) {
    const d = e && e.detail;
    if (!d || d.status !== 400) return false;
    const body = typeof d.body === "string" ? d.body : JSON.stringify(d.body || "");
    return body.indexOf("Unrecognized field: " + field) > -1;
  }
  async function _writeOptional(fn, payload, field) {
    if (payload[field] === undefined) return { value: await fn(payload), missing: false };
    try { return { value: await fn(payload), missing: false }; }
    catch (e) {
      if (!_unknownField(e, field)) throw e;
      const q = Object.assign({}, payload); delete q[field];
      console.warn("[offert] fältet " + field + " saknas på Offert i Bubble — offerten sparas utan det");
      return { value: await fn(q), missing: true };
    }
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
      deal: body.deal || undefined,                 // affärs-koppling → syns i affärskortets kedja
      kind: body.kind ? _str(body.kind) : (isCreate ? "strukturerad" : undefined),  // strukturerad|uppladdad|fortnox
      dokument: (Array.isArray(body.dokument_ids) && body.dokument_ids.length) ? body.dokument_ids : undefined,  // uppladdad offert: PDF:en
      recipient: Array.isArray(body.recipient) ? body.recipient : undefined,
      sender: Array.isArray(body.sender) ? body.sender : undefined,
    };
    // Kategorin styr nummerserie + PDF-rubrik. Okänt värde avvisas hellre än skrivs.
    // ⚠️ `source` lämnas ORÖRD (`mira_fe` = "skapad i Mira") — den används på sex
    // ställen inkl. order-konverteringen och listan. Kategorin är ett eget fält.
    const kat = _katOf(body.kategori);
    if (body.kategori !== undefined) p.kategori = kat || undefined;
    if (isCreate) {
      p.source = SOURCE_MIRA_FE;
      if (!p.kategori) p.kategori = DEFAULT_KATEGORI;
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
      // ⚠️ Okänd kategori avvisas — annars hamnar skräp i Category-fältet och
      // nummerserien faller tillbaka på FE utan att någon märker det.
      if (body.kategori !== undefined && _str(body.kategori).trim() && !_katOf(body.kategori)) {
        return res.status(400).json({ ok: false, error: "okand_kategori", value: _str(body.kategori), allowed: OFFERT_KATEGORIER });
      }
      const payload = buildOffertPayload(body, { isCreate: true });
      payload.offertnr = body.offertnr ? _str(body.offertnr) : await generateOffertnr(payload.kategori);
      payload.summa = totals.summa;
      payload.moms_belopp = totals.moms_belopp;
      payload.total = totals.total;
      const cw = await _writeOptional((q) => bubbleCreate(TYPE_OFFERT, q), payload, "kategori");
      const offertId = cw.value;
      const radIds = await createRows(offertId, rows);
      return res.json({ ok: true, offert_id: offertId, offertnr: payload.offertnr, kategori: payload.kategori,
        rows_created: radIds.length, totals,
        kategori_field_missing: cw.missing || undefined });
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

      if (body.kategori !== undefined && _str(body.kategori).trim() && !_katOf(body.kategori)) {
        return res.status(400).json({ ok: false, error: "okand_kategori", value: _str(body.kategori), allowed: OFFERT_KATEGORIER });
      }
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
      // ⚠️ Numret följer INTE med en kategoriändring. Ett utfärdat offertnummer är
      // en identitet — byter man serie i efterhand pekar utskickade PDF:er och
      // signeringar på ett nummer som inte längre finns. Kategorin får ändras, numret
      // står kvar; svaret säger det så att det inte blir en tyst inkonsekvens.
      let numMismatch;
      if (payload.kategori) {
        const pfx = KAT_PREFIX[payload.kategori];
        const cur = _str(existing.offertnr);
        if (pfx && cur && cur.indexOf(pfx + "-") !== 0) numMismatch = { offertnr: cur, kategori: payload.kategori };
      }
      let missing;
      if (Object.keys(payload).length) {
        const pw = await _writeOptional((q) => bubblePatch(TYPE_OFFERT, id, q), payload, "kategori");
        missing = pw.missing || undefined;
      }
      return res.json({ ok: true, offert_id: id, updated: Object.keys(payload), rows: rowsResult,
        kategori_field_missing: missing, offertnr_behalls: numMismatch });
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

      // Uppladdad offert: förhandsgranska det UPPLADDADE dokumentet, rendera INTE strukturerat (skulle bli tomt).
      if (_str(offert.kind) === "uppladdad") {
        const first = (Array.isArray(offert.dokument) ? offert.dokument : [])[0];
        const doc = first ? await bubbleGet("Dokument", _ref(first)).catch(() => null) : null;
        const url = doc && (doc.file || doc.File);
        if (!url) return res.status(400).json({ ok: false, error: "inget_dokument" });
        return res.json({ ok: true, offert_id: id, kind: "uppladdad", file_url: String(url).replace(/^\/\//, "https://") });
      }

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

      // 1) signeringsunderlag — grenat på kind:
      //    uppladdad → använd det UPPLADDADE dokumentet direkt (ingen strukturerad render)
      //    strukturerad → rendera aktuell PDF (speglar senaste offert)
      let dokumentIds = [];
      let fileUrl = null;
      if (_str(offert.kind) === "uppladdad") {
        dokumentIds = Array.isArray(offert.dokument) ? offert.dokument.slice() : [];
        if (!dokumentIds.length) return res.status(400).json({ ok: false, error: "inget_dokument", hint: "Uppladdad offert saknar dokument att signera." });
      } else {
        const rows = await loadRows(id);
        const company = offert.kundforetag ? await bubbleGet("ClientCompany", offert.kundforetag).catch(() => null) : null;
        const office = offert.office ? await bubbleGet("Office", offert.office).catch(() => null) : null;
        const pdfTitel = `Offert ${offert.offertnr || id}`;
        const html = buildOffertHtml({ offert, rows, company, office });
        const rendered = await contractRenderEngine.renderAndPersist({ templateHtml: html, spec: {}, titel: pdfTitel });
        fileUrl = rendered.file_url;
        const cur = Array.isArray(offert.dokument) ? offert.dokument : [];
        const staleIds = [];
        for (const dId of cur) {
          if (!dId || dId === rendered.dokument_id) continue;
          const d = await bubbleGet("Dokument", dId).catch(() => null);
          if (d && _str(d.titel) === pdfTitel) staleIds.push(dId);
        }
        dokumentIds = cur.filter((d) => !staleIds.includes(d));
        if (rendered.dokument_id && !dokumentIds.includes(rendered.dokument_id)) dokumentIds.push(rendered.dokument_id);
        await bubblePatch(TYPE_OFFERT, id, { dokument: dokumentIds });
        for (const sId of staleIds) { try { await bubbleDelete("Dokument", sId); } catch (_) {} }
      }

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
          // ⚠️ Fallback följer offertens kategori — hårdkodat "Food & Event" hade
          // stått som rubrik på en HK-offert utan titel.
          rubrik: `Offert ${offert.offertnr || ""} – ${offert.titel || _katOf(offert.kategori) || DEFAULT_KATEGORI}`.trim(),
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
      return res.json({ ok: true, offert_id: id, kind: _str(offert.kind) || "strukturerad", request_id: result && (result.request_id || result.requestId || result.request), recipients: recipients.length, file_url: fileUrl });
    } catch (e) {
      console.error("[/admin/offert/:id/send-for-signing]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── ORDER-PDF (kund) + KÖK-PM — återanvänder render-motorn. Exponeras via offertEngine. ──
  const _pmMoney = (n) => _round2(n).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const _ordDay = (v) => (v ? _esc(String(v).slice(0, 10)) : "");
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : (v._id || bubbleId(v) || null)));

  // Kund-order: som offert-PDF men med tydlig leverans-banner överst + "Orderbekräftelse".
  const ORDER_STYLES = `
      @page{size:A4;margin:18mm 16mm}*{box-sizing:border-box}
      body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#1a1a1a;font-size:11px;margin:0}
      h1{font-size:22px;margin:0 0 2px;letter-spacing:.5px}.o-sub{color:#6b7280;font-size:11px;margin-bottom:16px}
      .o-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
      .o-meta{text-align:right;font-size:11px;line-height:1.6}.o-meta b{display:inline-block;min-width:92px;text-align:left;color:#6b7280;font-weight:500}
      .o-lev{border:1.5px solid #111;border-radius:8px;padding:11px 14px;margin:6px 0 18px;background:#f6f7f9;display:flex;gap:26px;flex-wrap:wrap}
      .o-lev h3{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;margin:0 0 3px}
      .o-lev .o-lev-v{font-size:14px;font-weight:700}
      .o-cols{display:flex;gap:24px;margin-bottom:14px}.o-box{flex:1}.o-box h3{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;margin:0 0 4px}.o-box p{margin:0;line-height:1.5}
      table.o-rows{width:100%;border-collapse:collapse;margin-top:6px}table.o-rows th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;border-bottom:1.5px solid #111;padding:6px}
      table.o-rows td{padding:8px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top}.o-num{text-align:right;white-space:nowrap}.o-ben-titel{font-weight:600}.o-rad-beskr{color:#374151;margin-top:3px;font-size:10.5px;line-height:1.45}
      .o-totals{margin-top:14px;margin-left:auto;width:260px;font-size:11.5px}.o-totals div{display:flex;justify-content:space-between;padding:3px 0}.o-totals .o-grand{border-top:1.5px solid #111;margin-top:4px;padding-top:6px;font-weight:700;font-size:13px}
      .o-villkor{margin-top:26px;padding-top:12px;border-top:1px solid #e5e7eb;color:#374151;line-height:1.5;white-space:pre-wrap}.o-missing{color:#b91c1c;font-style:italic}`;
  function buildOrderBody({ order, rows, company }) {
    const totals = computeTotals(rows);
    const custName = _esc((company && company.Name_company) || "");
    const custOrg = _esc((company && company.Org_Number) || "");
    const isPrivat = _str(company && company.customer_type) === "Privat";
    const custAddr = _esc(_pickAddr(company && (company.Adress || company.address || company.Address)) || _pickAddr(company && company.faktura_adress));
    const dLev = _ordDay(order.leveransdatum), levTid = _esc(order.leveranstid || ""), levAddr = _esc(_pickAddr(order.leveransadress));
    const M = (t) => `<span class="o-missing">${_esc(t)}</span>`;
    const rowsHtml = rows.map((r) => {
      const rs = computeRow(r); const beskr = _noMustache(r.beskrivning_long || "");
      return `<tr><td class="o-artnr">${_esc(r.artikelnr || "")}</td><td class="o-ben"><div class="o-ben-titel">${_esc(_noMustache(r.benamning))}</div>${beskr ? `<div class="o-rad-beskr">${_esc(beskr).replace(/\n/g, "<br>")}</div>` : ""}</td><td class="o-num">${_esc(_pmMoney(_num(r.antal)))}</td><td class="o-enh">${_esc(r.enhet || "")}</td><td class="o-num">${_esc(_pmMoney(_num(r.apris)))}</td><td class="o-num">${_num(r.rabatt) ? _esc(_pmMoney(_num(r.rabatt))) + "%" : ""}</td><td class="o-num">${_esc(_pmMoney(rs))}</td><td class="o-num">${_esc(String(_num(r.moms)))}%</td></tr>`;
    }).join("");
    return `
      <div class="o-head"><div><h1>Orderbekräftelse</h1><div class="o-sub">${_esc(order.ordernr || "")}</div></div>
        <div class="o-meta"><div><b>Ordernr</b> ${order.ordernr ? _esc(order.ordernr) : M("saknas")}</div><div><b>Orderdatum</b> ${_ordDay(order.orderdatum) || M("saknas")}</div><div><b>Betalningsvillkor</b> ${order.betalningsvillkor ? _esc(order.betalningsvillkor) : M("saknas")}</div><div><b>Status</b> ${_esc(order.orderstatus || "Bekräftad")}</div></div></div>
      <div class="o-lev"><div><h3>Leveransdatum</h3><div class="o-lev-v">${dLev ? dLev + (levTid ? " · " + levTid : "") : M("saknas")}</div></div><div style="flex:1"><h3>Leveransadress</h3><div class="o-lev-v" style="font-size:12px">${levAddr || M("saknas")}</div></div></div>
      <div class="o-cols"><div class="o-box"><h3>Kund</h3><p>${custName || M("kundnamn saknas")}<br>${isPrivat ? "Privatperson" : (custOrg ? "Org.nr " + custOrg : "")}<br>${custAddr || ""}</p></div></div>
      <table class="o-rows"><thead><tr><th>Artikelnr</th><th>Benämning</th><th class="o-num">Antal</th><th>Enhet</th><th class="o-num">À-pris</th><th class="o-num">Rabatt</th><th class="o-num">Summa</th><th class="o-num">Moms</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      <div class="o-totals"><div><span>Summa (ex. moms)</span><span>${_esc(_pmMoney(totals.summa))} ${_esc(order.valuta || "SEK")}</span></div><div><span>Moms</span><span>${_esc(_pmMoney(totals.moms_belopp))} ${_esc(order.valuta || "SEK")}</span></div><div class="o-grand"><span>Att betala</span><span>${_esc(_pmMoney(totals.total))} ${_esc(order.valuta || "SEK")}</span></div></div>
      ${order.villkor_text ? `<div class="o-villkor">${_esc(_noMustache(order.villkor_text))}</div>` : ""}`;
  }
  function buildOrderHtml({ order, rows, company }) {
    return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><style>${ORDER_STYLES}
      </style></head><body>${buildOrderBody({ order, rows, company })}
      </body></html>`;
  }

  // Kök-PM: leveransinfo + intern instruktion highlightade, rader GRUPPERADE per kök (produktionsenhet).
  const PM_STYLES = `
      @page{size:A4;margin:16mm 15mm}*{box-sizing:border-box}
      body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#1a1a1a;font-size:12px;margin:0}
      h1{font-size:20px;margin:0 0 2px}.pm-sub{color:#6b7280;font-size:11px;margin-bottom:14px}
      .pm-lev{border:2px solid #111;border-radius:8px;padding:12px 16px;margin-bottom:14px;display:flex;gap:30px;flex-wrap:wrap;background:#fff7ed}
      .pm-lev h3{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#9a3412;margin:0 0 3px}.pm-lev .v{font-size:17px;font-weight:800}
      .pm-instr{border-left:5px solid #F47B30;background:#fff7ed;padding:11px 15px;margin-bottom:16px;border-radius:0 8px 8px 0}
      .pm-instr h3{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#9a3412;margin:0 0 4px}.pm-instr p{margin:0;font-size:13px;font-weight:600;line-height:1.5;white-space:pre-wrap}
      .pm-group{margin-bottom:18px;break-inside:avoid}
      .pm-group h2{font-size:15px;margin:0 0 6px;padding:6px 10px;background:#111;color:#fff;border-radius:6px;display:flex;justify-content:space-between;align-items:center}
      .pm-count{font-size:10px;font-weight:500;opacity:.8}
      table.pm-rows{width:100%;border-collapse:collapse}
      table.pm-rows th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;border-bottom:1.5px solid #111;padding:5px 6px}
      table.pm-rows td{padding:9px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top}
      .pm-antal{font-weight:800;font-size:15px;white-space:nowrap;width:76px}.pm-ben{font-weight:700;font-size:13.5px}.pm-beskr{color:#374151;margin-top:3px;font-size:11px;line-height:1.45}.pm-prep{color:#6b7280;white-space:nowrap;width:110px}`;
  function buildOrderPmBody({ order, rows, company, kokById, ansvarig }) {
    const custName = _esc((company && company.Name_company) || "");
    const ansv = _esc(ansvarig || "");
    const dLev = _ordDay(order.leveransdatum), levTid = _esc(order.leveranstid || ""), levAddr = _esc(_pickAddr(order.leveransadress));
    const intern = _noMustache(_str(order.intern_instruktion || ""));
    const groups = new Map();
    for (const r of rows) { const kn = (_ref(r.kok) ? (kokById.get(_ref(r.kok)) || "Okänt kök") : "Ej tilldelat kök"); if (!groups.has(kn)) groups.set(kn, []); groups.get(kn).push(r); }
    const groupHtml = [...groups.entries()].map(([kn, rs]) => {
      const rrows = rs.map((r) => `<tr><td class="pm-antal">${_esc(String(_num(r.antal)))} ${_esc(r.enhet || "")}</td><td><div class="pm-ben">${_esc(_noMustache(r.benamning))}</div>${r.beskrivning_long ? `<div class="pm-beskr">${_esc(_noMustache(r.beskrivning_long)).replace(/\n/g, "<br>")}</div>` : ""}</td><td class="pm-prep">${_esc(r.prep_kategori || "")}</td></tr>`).join("");
      return `<div class="pm-group"><h2>${_esc(kn)} <span class="pm-count">${rs.length} rader</span></h2><table class="pm-rows"><thead><tr><th>Antal</th><th>Maträtt / produkt</th><th>Prep</th></tr></thead><tbody>${rrows}</tbody></table></div>`;
    }).join("");
    return `
      <h1>Produktions-PM</h1><div class="pm-sub">${_esc(order.ordernr || "")}${custName ? " · " + custName : ""}</div>
      <div class="pm-lev"><div><h3>Leverans</h3><div class="v">${dLev || "—"}${levTid ? " · " + levTid : ""}</div></div><div><h3>Vår referens</h3><div class="v" style="font-size:14px">${ansv || "—"}</div></div><div style="flex:1"><h3>Plats</h3><div class="v" style="font-size:14px">${levAddr || "—"}</div></div></div>
      ${intern ? `<div class="pm-instr"><h3>Intern instruktion</h3><p>${_esc(intern).replace(/\n/g, "<br>")}</p></div>` : ""}
      ${groupHtml || '<p style="color:#6b7280">Inga rader.</p>'}`;
  }
  function buildOrderPmHtml({ order, rows, company, kokById, ansvarig }) {
    return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><style>${PM_STYLES}
      </style></head><body>${buildOrderPmBody({ order, rows, company, kokById, ansvarig })}
      </body></html>`;
  }

  // renderOrderPdf(orderId, kind) — kind: "order" (kund) | "pm" (kök). Renderar + persisterar → file_url.
  async function renderOrderPdf(orderId, kind) {
    const order = await bubbleGet(TYPE_ORDER, orderId);
    if (!order) return { ok: false, error: "order_not_found" };
    if (_str(order.source) !== SOURCE_MIRA_FE) return { ok: false, error: "ej_mira_order" };
    const rows = await loadOrderRows(orderId);
    const company = order.kundforetag ? await bubbleGet("ClientCompany", _ref(order.kundforetag)).catch(() => null) : null;
    let html, titel;
    if (kind === "pm") {
      const koks = await bubbleFindAll("Kok", {}).catch(() => []);
      const kokById = new Map(); for (const k of koks) { const id = bubbleId(k); if (id) kokById.set(id, _str(k.namn) || _str(k.Namn) || _str(k.name) || ""); }
      const ansvarig = await _resolveOrderAnsvarig(order);
      html = buildOrderPmHtml({ order, rows, company, kokById, ansvarig }); titel = `PM ${order.ordernr || orderId}`;
    } else {
      html = buildOrderHtml({ order, rows, company }); titel = `Order ${order.ordernr || orderId}`;
    }
    const rendered = await contractRenderEngine.renderAndPersist({ templateHtml: html, spec: {}, titel });
    return { ok: true, kind: kind === "pm" ? "pm" : "order", file_url: rendered.file_url, dokument_id: rendered.dokument_id, bytes: rendered.bytes };
  }

  // ── BATCH-EXPORT: samtliga ordrar inom ett tidsintervall → ETT sammanslaget PDF med sidbrytningar. ──
  // parts (delar): "list" (leveransöversikt) | "prep" (aggregerad prep-lista/kök) | "pm" (kök-PM/order) | "order" (kund-orderbekräftelser)
  const BATCH_STATUS = ["Bekräftad", "I produktion", "Levererad"];
  const BATCH_STYLES = `
      @page{size:A4;margin:15mm 14mm}*{box-sizing:border-box}
      body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#1a1a1a;font-size:11px;margin:0}
      h1{font-size:21px;margin:0 0 2px}
      .be-sec{page-break-before:always}.be-first{page-break-before:auto}
      .be-title{font-size:24px;margin:0 0 3px;letter-spacing:.3px}
      .be-period{color:#6b7280;font-size:12.5px;margin-bottom:20px;font-weight:600}
      .be-h2{font-size:17px;margin:0 0 10px;padding-bottom:6px;border-bottom:2.5px solid #111}
      table.be-list{width:100%;border-collapse:collapse;font-size:11px}
      table.be-list th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;border-bottom:1.5px solid #111;padding:6px 7px}
      table.be-list td{padding:8px 7px;border-bottom:1px solid #e5e7eb;vertical-align:top}
      .be-list .be-tid{font-weight:800;white-space:nowrap}.be-list .be-antal{text-align:right;font-weight:700;white-space:nowrap}
      .be-list .be-stat{font-size:9.5px;text-transform:uppercase;letter-spacing:.3px;color:#6b7280}
      .be-kok{margin-bottom:20px;break-inside:avoid}
      .be-kok-h{font-size:15px;margin:0 0 6px;padding:6px 11px;background:#111;color:#fff;border-radius:6px}
      .be-kok.none .be-kok-h{background:#b91c1c}
      .be-cat{margin:0 0 9px;padding-left:2px}
      .be-cat-h{display:flex;justify-content:space-between;font-weight:800;font-size:12.5px;border-bottom:1px solid #d1d5db;padding:4px 2px;margin-bottom:3px}
      .be-cat-h .be-cat-tot{background:#f3f4f6;border-radius:5px;padding:1px 9px;font-variant-numeric:tabular-nums}
      .be-item{display:flex;gap:9px;padding:3px 2px;font-size:11px;color:#374151}
      .be-item .be-i-antal{font-weight:800;min-width:52px;white-space:nowrap}
      .be-item .be-i-ben{flex:1}.be-item .be-i-src{color:#9ca3af;white-space:nowrap}
      .be-empty{color:#6b7280;padding:20px 2px}`;
  function _batchBounds({ from, to, date }) {
    const f = _str(from).slice(0, 10), t = _str(to).slice(0, 10), d = _str(date).slice(0, 10);
    const isRange = /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t);
    if (!isRange && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const start = isRange ? new Date(f + "T00:00:00.000Z").getTime() : new Date(d + "T00:00:00.000Z").getTime();
    const end = isRange ? (new Date(t + "T00:00:00.000Z").getTime() + 86400000) : (start + 86400000);
    return { start, end, label: isRange ? (f + " – " + t) : d, isRange };
  }
  async function renderBatchExport({ from, to, date, parts } = {}) {
    const bounds = _batchBounds({ from, to, date });
    if (!bounds) return { ok: false, error: "period_krävs", hint: "?date=YYYY-MM-DD eller ?from=&to=" };
    let want = parts;
    if (typeof want === "string") want = want.split(",").map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(want) || !want.length) want = ["list", "prep", "pm", "order"];
    const wants = (k) => want.indexOf(k) > -1;

    const orders = await bubbleFind(TYPE_ORDER, { constraints: [
      { key: "leverans_ts", constraint_type: "greater than", value: bounds.start - 1 },
      { key: "leverans_ts", constraint_type: "less than", value: bounds.end },
      { key: "orderstatus", constraint_type: "in", value: BATCH_STATUS },
    ], limit: 300 }).catch(() => []);
    const mira = orders.filter((o) => _str(o.source) === SOURCE_MIRA_FE);
    mira.sort((a, b) => (_num(a.leverans_ts) - _num(b.leverans_ts)) || _str(a.leveranstid).localeCompare(_str(b.leveranstid)) || _str(a.ordernr).localeCompare(_str(b.ordernr)));

    const koks = await bubbleFindAll("Kok", {}).catch(() => []);
    const kokById = new Map(); for (const k of koks) { const id = bubbleId(k); if (id) kokById.set(id, _str(k.namn) || _str(k.Namn) || _str(k.name) || ""); }

    // Ladda per order: rader + kund + ansvarig
    const enriched = [];
    for (const o of mira) {
      const oid = bubbleId(o);
      const rows = await loadOrderRows(oid);
      const company = o.kundforetag ? await bubbleGet("ClientCompany", _ref(o.kundforetag)).catch(() => null) : null;
      const ansvarig = await _resolveOrderAnsvarig(o);
      enriched.push({ order: o, rows, company, ansvarig, ordernr: _str(o.ordernr), companyName: _str((company && company.Name_company) || "") });
    }

    if (!enriched.length) {
      const emptyHtml = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><style>${BATCH_STYLES}</style></head><body><h1 class="be-title">Produktionsexport</h1><div class="be-period">${_esc(bounds.label)}</div><div class="be-empty">Inga ordrar i produktion för perioden.</div></body></html>`;
      const r = await contractRenderEngine.renderAndPersist({ templateHtml: emptyHtml, spec: {}, titel: `Export ${bounds.label}` });
      return { ok: true, order_count: 0, parts: want, file_url: r.file_url, dokument_id: r.dokument_id, bytes: r.bytes };
    }

    const sections = [];
    // Sektion 1: Leveranslista (översikt)
    if (wants("list")) {
      const trs = enriched.map((e) => {
        const o = e.order;
        const koksSet = new Set(e.rows.map((r) => (_ref(r.kok) ? (kokById.get(_ref(r.kok)) || "Okänt") : "Ej tilldelat")));
        const antal = e.rows.reduce((s, r) => s + _num(r.antal), 0);
        return `<tr><td>${_ordDay(o.leveransdatum) || "—"}</td><td class="be-tid">${_esc(_str(o.leveranstid) || "—")}</td><td><b>${_esc(e.ordernr)}</b></td><td>${_esc(e.companyName)}</td><td>${_esc(e.ansvarig || "—")}</td><td class="be-antal">${_esc(String(antal))}</td><td>${_esc([...koksSet].sort().join(", "))}</td><td class="be-stat">${_esc(_str(o.orderstatus) || "Bekräftad")}</td></tr>`;
      }).join("");
      sections.push(`<section class="be-sec be-first"><h1 class="be-title">Leveranslista</h1><div class="be-period">${_esc(bounds.label)} · ${enriched.length} ordrar</div>
        <table class="be-list"><thead><tr><th>Datum</th><th>Tid</th><th>Order</th><th>Kund</th><th>Vår referens</th><th class="be-antal">Antal</th><th>Kök</th><th>Status</th></tr></thead><tbody>${trs}</tbody></table></section>`);
    }
    // Sektion 2: Aggregerad prep-lista per kök
    if (wants("prep")) {
      const KOK_UN = "￿Ej tilldelat kök";
      const kokMap = new Map();   // kökNamn → Map(kategori → {total, items:[]})
      for (const e of enriched) {
        for (const r of e.rows) {
          const kn = _ref(r.kok) ? (kokById.get(_ref(r.kok)) || "Okänt kök") : KOK_UN;
          if (!kokMap.has(kn)) kokMap.set(kn, new Map());
          const cats = kokMap.get(kn);
          const cat = _str(r.prep_kategori) || "Övrigt";
          if (!cats.has(cat)) cats.set(cat, { total: 0, items: [] });
          const c = cats.get(cat); c.total += _num(r.antal);
          c.items.push({ antal: _num(r.antal), enhet: _str(r.enhet), ben: _noMustache(r.benamning), ordernr: e.ordernr, company: e.companyName });
        }
      }
      const kokNames = [...kokMap.keys()].sort((a, b) => a.localeCompare(b, "sv"));
      const kokHtml = kokNames.map((kn) => {
        const isNone = kn === KOK_UN; const disp = isNone ? "Ej tilldelat kök" : kn;
        const cats = [...kokMap.get(kn).entries()].sort((a, b) => a[0].localeCompare(b[0], "sv"));
        const catHtml = cats.map(([cat, c]) => {
          const items = c.items.map((it) => `<div class="be-item"><span class="be-i-antal">${_esc(String(it.antal))} ${_esc(it.enhet)}</span><span class="be-i-ben">${_esc(it.ben)}</span><span class="be-i-src">${_esc(it.ordernr)}${it.company ? " · " + _esc(it.company) : ""}</span></div>`).join("");
          return `<div class="be-cat"><div class="be-cat-h"><span>${_esc(cat)}</span><span class="be-cat-tot">${_esc(String(Math.round(c.total * 100) / 100))} st</span></div>${items}</div>`;
        }).join("");
        return `<div class="be-kok${isNone ? " none" : ""}"><div class="be-kok-h">${_esc(disp)}</div>${catHtml}</div>`;
      }).join("");
      sections.push(`<section class="be-sec"><h1 class="be-title">Prep-lista per kök</h1><div class="be-period">${_esc(bounds.label)} · summerat</div>${kokHtml || '<div class="be-empty">Inga rader.</div>'}</section>`);
    }
    // Sektion 3: Kök-PM per order (grupperat per kök i varje)
    if (wants("pm")) {
      for (const e of enriched) {
        sections.push(`<section class="be-sec">${buildOrderPmBody({ order: e.order, rows: e.rows, company: e.company, kokById, ansvarig: e.ansvarig })}</section>`);
      }
    }
    // Sektion 4: Kund-orderbekräftelser per order
    if (wants("order")) {
      for (const e of enriched) {
        sections.push(`<section class="be-sec">${buildOrderBody({ order: e.order, rows: e.rows, company: e.company })}</section>`);
      }
    }

    const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><style>${ORDER_STYLES}
      ${PM_STYLES}
      ${BATCH_STYLES}
      </style></head><body>${sections.join("\n")}</body></html>`;
    const rendered = await contractRenderEngine.renderAndPersist({ templateHtml: html, spec: {}, titel: `Export ${bounds.label}` });
    return { ok: true, order_count: enriched.length, parts: want, file_url: rendered.file_url, dokument_id: rendered.dokument_id, bytes: rendered.bytes };
  }
  // Vår referens (ansvarig) för en order: MiraOrder.var_referens (override) ELLER offert→deal→deal_owner.
  function _uName(u) { if (!u) return ""; const first = _str(u["First Name"] || u["Förnamn"]); const last = _str(u["Last Name"] || u["Efternamn"] || u["Surname"]); return (first + " " + last).trim() || _str(u.email || u.Email); }
  async function _resolveOrderAnsvarig(order) {
    const vr = _ref(order.var_referens);
    if (vr) { const u = await bubbleGet("User", vr).catch(() => null); return _uName(u); }
    const offId = _ref(order.offert); if (!offId) return "";
    const off = await bubbleGet("Offert", offId).catch(() => null); const dealId = off ? _ref(off.deal) : null; if (!dealId) return "";
    const deal = await bubbleGet("deal", dealId).catch(() => null); if (!deal) return "";
    const ownerId = _ref(Array.isArray(deal.deal_owner) ? deal.deal_owner[0] : deal.deal_owner); if (!ownerId) return "";
    const owner = await bubbleGet("User", ownerId).catch(() => null); return _uName(owner);
  }
  async function loadOrderRows(orderId) {
    const rows = await bubbleFind(TYPE_ORDERRAD, { constraints: [{ key: "order", constraint_type: "equals", value: orderId }], limit: 300 }).catch(() => []);
    rows.sort((a, b) => _num(a.radnr) - _num(b.radnr));
    return rows;
  }

  console.log("[offert_api] routes registered (/admin/offert/*)");
  return { convertOffertToOrder, renderOrderPdf, renderBatchExport };
}
