// affar_api.js
// ─────────────────────────────────────────────────────────────────────────────
// Affär — samlad CRM-vy (P1, read-only). Ersätter Bubble-native-flikarna med EN
// feed: processtratt (counts) + normaliserad liggare över alla typer/källor.
// Design: OFFERT_PRODUKTION_HANDOFF.md §4.5. DI-mönster som offert_api.js.
//
// Endpoint:
//   GET /admin/affar/feed?limit=40 — { funnel, rows }
//     funnel: {lead, aktivitet, affar, offert, order, faktura} (totala counts)
//     rows:   normaliserade {type, source, company, number, amount, date, status, status_cls, id}
//
// Fältkällor (bekräftade): Fortnox-speglar har ft_customer_name (ingen join).
// CRM/Mira-typer: företag via ref → namn ur ClientCompany-cache (CC_FIELD_OVERRIDES).
// ─────────────────────────────────────────────────────────────────────────────

export function registerAffarRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleGet, bubbleCount, bubblePatch, bubbleId,
    planningAuthed, planningCors, publicRateLimited, clientIp,
    FE_CONNECTION_ID, CONNECTION_NAMES,
  } = deps;

  const SOURCE_MIRA_FE = "mira_fe";
  const _num = (v) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : bubbleId(v)));
  const _ts = (v) => { if (!v) return 0; const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };
  const _day = (v) => (v ? _str(v).slice(0, 10) : "");
  const _httpsUrl = (v) => { const s = _str(v); return s ? s.replace(/^\/\//, "https://") : ""; };

  // ── ClientCompany-cache (id → namn + kundansvarig) ────────────────
  let _ccCache = { name: null, owner: null, ts: 0 };
  const CC_TTL = 5 * 60 * 1000;
  async function _loadCC() {
    if (_ccCache.name && (Date.now() - _ccCache.ts) < CC_TTL) return _ccCache;
    const all = await bubbleFindAll("ClientCompany", {}).catch(() => []);
    const name = new Map(), owner = new Map();
    for (const c of all) {
      const id = bubbleId(c); if (!id) continue;
      name.set(id, c.Name_company || c.name || "");
      const ka = _ref(c.Kundansvarig); if (ka) owner.set(id, ka);
    }
    _ccCache = { name, owner, ts: Date.now() };
    return _ccCache;
  }
  async function companyMap() { return (await _loadCC()).name; }
  async function companyOwnerMap() { return (await _loadCC()).owner; }
  const cname = (m, ref) => { const id = _ref(ref); return id ? (m.get(id) || "") : ""; };

  // ── User-cache (id → visningsnamn) ────────────────────────────────
  let _uCache = { map: null, ts: 0 };
  async function userMap() {
    if (_uCache.map && (Date.now() - _uCache.ts) < CC_TTL) return _uCache.map;
    const all = await bubbleFindAll("User", {}).catch(() => []);
    const m = new Map();
    for (const u of all) {
      const id = bubbleId(u); if (!id) continue;
      const first = _str(u["First Name"] || u["Förnamn"]);
      const last  = _str(u["Last Name"]  || u["Efternamn"]);
      const nm = (first + " " + last).trim() || _str(u.email || u.Email);
      m.set(id, nm);
    }
    _uCache = { map: m, ts: Date.now() };
    return m;
  }

  // ── Deal-cache (id → titel) ───────────────────────────────────────
  let _dCache = { map: null, ts: 0 };
  async function dealMap() {
    if (_dCache.map && (Date.now() - _dCache.ts) < CC_TTL) return _dCache.map;
    const all = await bubbleFindAll("deal", {}).catch(() => []);
    const m = new Map();
    for (const d of all) { const id = bubbleId(d); if (id) m.set(id, _str(d.titel) || _str(d.Namn) || _str(d.name)); }
    _dCache = { map: m, ts: Date.now() };
    return m;
  }

  // ── Leverantör-cache (id → Företagsnamn) ──────────────────────────
  let _sCache = { map: null, ts: 0 };
  async function supplierMap() {
    if (_sCache.map && (Date.now() - _sCache.ts) < CC_TTL) return _sCache.map;
    const all = await bubbleFindAll("leverantör-supplier", {}).catch(() => []);
    const m = new Map();
    for (const s of all) { const id = bubbleId(s); if (id) m.set(id, _str(s["Företagsnamn"])); }
    _sCache = { map: m, ts: Date.now() };
    return m;
  }

  // ── status → {label, cls} ─────────────────────────────────────────
  // cls: ok(grön) | open(orange) | wait(grå) | red
  const OFFER_STATUS = { Draft: ["Utkast", "wait"], Sent: ["Skickad", "open"], Viewed: ["Öppnad", "open"], OTP_Sent: ["Kod skickad", "open"], Approved: ["Accepterad", "ok"], Expired: ["Utgången", "red"], Revoked: ["Återkallad", "red"] };
  const ORDER_STATUS = { "Bekräftad": ["Bekräftad", "open"], "I produktion": ["I produktion", "open"], "Levererad": ["Levererad", "ok"], "Fakturerad": ["Fakturerad", "ok"] };
  const DEAL_STATUS = { "Kundkontakt": ["Kundkontakt", "wait"], "Offert": ["Offert", "open"], "Avtal": ["Avtal", "ok"], "Avslutad": ["Avslutad", "red"] };
  const pick = (map, key, fallback) => map[key] || [key || fallback[0], fallback[1]];

  const connSource = (connId) => {
    const nm = CONNECTION_NAMES && CONNECTION_NAMES[_ref(connId)];
    return nm === "Housekeeping" ? "tengella" : "fortnox";
  };

  // ── hämta senaste N av en typ (sort på Created Date, pålitligt built-in-datum) ──
  async function recent(type, limit, constraints = []) {
    return bubbleFind(type, { constraints, limit, sort_field: "Created Date", descending: true }).catch(() => []);
  }

  // ── normalisering per typ → unified row ───────────────────────────
  function nLead(r, m) { return { type: "Lead", source: "mira", company: cname(m, r.Company) || _str(r.Name), number: "", amount: null, date: _day(r["Created Date"]), status: "Ny", status_cls: "wait", id: bubbleId(r) }; }
  function nAkt(r, m)  { const [lbl] = pick({}, _str(r.kundm_te_option_kundm_te), ["Aktivitet", "wait"]); return { type: "Aktivitet", source: "mira", company: cname(m, r.clientcompany), number: "", amount: null, date: _day(r.datum_bokning_date || r["Created Date"]), status: lbl || "Aktivitet", status_cls: "wait", id: bubbleId(r) }; }
  function nDeal(r, m) { const [lbl, cls] = pick(DEAL_STATUS, _str(r.Status), ["—", "wait"]); return { type: "Affär", source: "mira", company: cname(m, r["kundföretag"]), number: _str(r.titel), amount: _num(r.value_brutto) || null, date: _day(r["Created Date"]), status: lbl, status_cls: cls, id: bubbleId(r) }; }
  // ⚠️ Tengella-belopp: ft_totalvat/total_price ofta tomma → fallback ft_net/total_cost. Bekräfta rätt fält.
  function nWorkorder(r, m) { return { type: "Order", source: "tengella", company: cname(m, r.company), number: _str(r.workorder_no), amount: (_num(r.ft_totalvat) || _num(r.total_price) || _num(r.ft_net) || _num(r.total_cost)) || null, date: _day(r.order_date || r["Created Date"]), status: _str(r.status) || "Order", status_cls: "wait", id: bubbleId(r) }; }
  function nOffertM(r, m, durl) { const [lbl, cls] = pick(OFFER_STATUS, _str(r.status), ["Utkast", "wait"]); const d0 = (Array.isArray(r.dokument) ? r.dokument[0] : null); return { type: "Offert", source: "mira", kind: _str(r.kind) || "strukturerad", company: cname(m, r.kundforetag), number: _str(r.offertnr), amount: _num(r.total) || null, date: _day(r.offertdatum || r["Created Date"]), status: lbl, status_cls: cls, url: (durl && d0) ? (durl.get(_ref(d0)) || "") : "", id: bubbleId(r) }; }
  function nOffertF(r) { const st = r.ft_cancelled ? ["Avbruten", "red"] : (r.ft_sent ? ["Skickad", "open"] : ["Öppen", "open"]); return { type: "Offert", source: "fortnox", kind: "fortnox", company: _str(r.ft_customer_name), number: _str(r.ft_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_offer_date || r.ft_delivery_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf), id: bubbleId(r) }; }
  function nOrderM(r, m) { const [lbl, cls] = pick(ORDER_STATUS, _str(r.orderstatus), ["Bekräftad", "open"]); return { type: "Order", source: "mira", company: cname(m, r.kundforetag), number: _str(r.ordernr), amount: _num(r.total) || null, date: _day(r.orderdatum || r["Created Date"]), status: lbl, status_cls: cls, id: bubbleId(r) }; }
  // Avtal (Contract) i affärskedjan. Status härleds enkelt (affar_api saknar _deriveContractStatus):
  // status_override först, annars slutdatum-passerat → Avslutad, annars Aktiv. Belopp = månadskostnad.
  function nAvtal(r, m) {
    var ov = _str(r.status_override);
    var slutTs = _ts(r.slutdatum);
    var st = ov ? [ov, "wait"] : (slutTs && slutTs < Date.now() ? ["Avslutad", "red"] : ["Aktiv", "ok"]);
    return { type: "Avtal", source: "mira", company: cname(m, r["kundföretag"]), number: _str(r.contract_title) || _str(r.kategori) || "Avtal", amount: _num(r["månadskostnad"]) || null, date: _day(r.startdatum || r.signed_at || r["Created Date"]), contract_type: _str(r.contract_type) || null, status: st[0], status_cls: st[1], id: bubbleId(r) };
  }
  function nOrderF(r) { const past = _ts(r.ft_delivery_date) && _ts(r.ft_delivery_date) < Date.now(); return { type: "Order", source: "fortnox", company: _str(r.ft_customer_name), number: _str(r.ft_document_number || r.ft_order_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_delivery_date || r["Created Date"]), status: past ? "Levererad" : "Bekräftad", status_cls: past ? "ok" : "open", url: _httpsUrl(r.ft_pdf), id: bubbleId(r) }; }
  function nInvoice(r) { const bal = _num(r.ft_balance); const due = _ts(r.ft_due_date); let st = ["Obetald", "open"]; if (bal === 0) st = ["Betald", "ok"]; else if (due && due < Date.now()) st = ["Förfallen", "red"]; return { type: "Faktura", source: connSource(r.connection), company: _str(r.ft_customer_name), number: _str(r.ft_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_invoice_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf) || _httpsUrl(r.ft_url), id: bubbleId(r) }; }

  // ── Rika per-typ-rader för native-ersättande liggaren ─────────────
  // Lead-kolumner: skapad/namn/email/telefon/företag/meddelande/region/källa/formulär/kundansvarig/tilldelad.
  function nLeadFull(r, m, um, ownerMap) {
    const ccId = _ref(r.client_company);
    const kaId = _ref(r.Kundansvarig) || (ccId ? ownerMap.get(ccId) : null);   // lead-ägare, annars företagets kundansvarig
    const tId  = _ref(r.tilldelad);
    const [lbl, cls] = pick(DEAL_STATUS, _str(r.status), [_str(r.status) || "Ny", "wait"]);
    return {
      type: "Lead", source: "mira", id: bubbleId(r), date: _day(r["Created Date"]),
      name: _str(r.Name), email: _str(r.Email), phone: _str(r.Phone),
      company: (ccId ? (m.get(ccId) || "") : "") || _str(r.Company), company_id: ccId || null,
      message: _str(r.prospect_message) || _str(r.Description),
      region: _str(r.Region), kalla: _str(r.Source),
      formular: _ref(r["Formulär"]) ? "Ja" : "",
      status: lbl, status_cls: cls,
      kundansvarig: kaId ? (um.get(kaId) || "") : "",
      tilldelad: tId ? { id: tId, name: um.get(tId) || "" } : null,
    };
  }
  // Aktivitet-kolumner: skapad/leverantör/typ/fas/mötesdatum/företag/affär/meddelande/vår användare.
  function nAktFull(r, m, um, sm, dm) {
    const levs = Array.isArray(r["Leverantör"]) ? r["Leverantör"] : (r["Leverantör"] ? [r["Leverantör"]] : []);
    const dId = _ref(r.deal);
    const wId = _ref(r.writer) || _ref(r["Created By"]);
    return {
      type: "Aktivitet", source: "mira", id: bubbleId(r), date: _day(r.datum_bokning_date || r["Created Date"]),
      created: _day(r["Created Date"]),
      leverantor: levs.map((x) => sm.get(_ref(x)) || "").filter(Boolean).join(", "),
      typ: _str(r.activity_type), fas: _str(r.kundm_te_option_kundm_te),
      motesdatum: _day(r.datum_bokning_date),
      company: cname(m, r.company), company_id: _ref(r.company) || null,
      affar: dId ? (dm.get(dId) || "") : "", affar_id: dId || null,
      meddelande: _str(r.beskrivning) || _str(r["mötesantecking"]),
      var_anvandare: wId ? (um.get(wId) || "") : "",
    };
  }
  // Företags-id:n vars namn matchar q (för ref-företags-sök som Bubble ej klarar direkt)
  function ccIdsMatching(m, q) {
    const ql = String(q || "").toLowerCase(); const ids = [];
    for (const [id, nm] of m) { if (nm && String(nm).toLowerCase().indexOf(ql) !== -1) ids.push(id); }
    return ids;
  }
  // Mira-offert: resolve första Dokumentets fil-URL (för Visa-knappen). Batchat per sida.
  async function dokUrlMap(offRows) {
    const ids = [];
    for (const r of offRows) { const d0 = Array.isArray(r.dokument) ? r.dokument[0] : null; if (d0) ids.push(_ref(d0)); }
    const uniq = [];
    for (const id of ids) { if (id && uniq.indexOf(id) === -1) uniq.push(id); }
    const docs = await Promise.all(uniq.map((id) => bubbleGet("Dokument", id).catch(() => null)));
    const map = new Map();
    uniq.forEach((id, i) => { const d = docs[i]; if (d) map.set(id, _httpsUrl(d.file || d.File)); });
    return map;
  }

  // ── auth ──────────────────────────────────────────────────────────
  function guard(req, res) {
    planningCors && planningCors(req, res);
    if (!planningAuthed(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
    if (publicRateLimited && clientIp && publicRateLimited("affar:" + clientIp(req), 120)) { res.status(429).json({ ok: false, error: "rate_limited" }); return false; }
    return true;
  }
  app.options("/admin/affar/feed", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });

  // ── GET /admin/affar/feed ─────────────────────────────────────────
  app.get("/admin/affar/feed", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const limit = Math.min(80, Math.max(10, parseInt(req.query.limit, 10) || 40));
      const feMira = [{ key: "source", constraint_type: "equals", value: SOURCE_MIRA_FE }];

      const [
        cLead, cAkt, cDeal, cOffM, cOffF, cOrdM, cOrdF, cWO, cInv, cAvtal,
        m, leads, akts, deals, offMs, offFs, ordMs, ordFs, invs, tengWos, avtals,
      ] = await Promise.all([
        bubbleCount("Lead"), bubbleCount("activitet_crm"), bubbleCount("deal"),
        bubbleCount("Offert", feMira), bubbleCount("FortnoxOffer"),
        bubbleCount("MiraOrder"), bubbleCount("FortnoxOrder"), bubbleCount("TengellaWorkorder"),
        bubbleCount("FortnoxInvoice"), bubbleCount("Contract"),
        companyMap(),
        recent("Lead", limit), recent("activitet_crm", limit), recent("deal", limit),
        recent("Offert", limit, feMira), recent("FortnoxOffer", limit),
        recent("MiraOrder", limit), recent("FortnoxOrder", limit), recent("FortnoxInvoice", limit),
        recent("TengellaWorkorder", limit), recent("Contract", limit),
      ]);

      const rows = [
        ...leads.map((r) => nLead(r, m)),
        ...akts.map((r) => nAkt(r, m)),
        ...deals.map((r) => nDeal(r, m)),
        ...offMs.map((r) => nOffertM(r, m)),
        ...offFs.map(nOffertF),
        ...avtals.map((r) => nAvtal(r, m)),
        ...ordMs.map((r) => nOrderM(r, m)),
        ...ordFs.map(nOrderF),
        ...tengWos.filter((r) => !r.is_deleted).map((r) => nWorkorder(r, m)),
        ...invs.map(nInvoice),
      ].filter((r) => r.id);
      rows.sort((a, b) => (_ts(b.date) - _ts(a.date)));

      return res.json({
        ok: true,
        funnel: {
          lead: cLead, aktivitet: cAkt, affar: cDeal,
          offert: cOffM + cOffF, avtal: cAvtal, order: cOrdM + cOrdF + cWO, faktura: cInv,
        },
        counts_detail: { offert_mira: cOffM, offert_fortnox: cOffF, avtal: cAvtal, order_mira: cOrdM, order_fortnox: cOrdF, order_tengella: cWO },
        rows,
        note: "P1 read-only. Alla typer i liggaren (inkl TengellaWorkorder). Sortering på visnings-datum. Ägare (deal_owner) visas ej i P1-liggaren.",
      });
    } catch (e) {
      console.error("[/admin/affar/feed]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/affar/deal/:id — kedjan (P2). Läser Deals list-fält direkt. ──
  app.options("/admin/affar/deal/:id", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/deal/:id", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const deal = await bubbleGet("deal", req.params.id).catch(() => null);
      if (!deal) return res.status(404).json({ ok: false, error: "deal_not_found" });
      const m = await companyMap();
      const getList = async (type, ids) => {
        const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
        const rows = await Promise.all(list.map((id) => bubbleGet(type, _ref(id)).catch(() => null)));
        return rows.filter(Boolean);
      };

      const [leadRow, akts, offList, offRev, ordRows, invRows, avtalRows] = await Promise.all([
        deal.lead ? bubbleGet("Lead", _ref(deal.lead)).catch(() => null) : null,
        getList("activitet_crm", deal.historik),
        getList("Offert", deal.offert),                                                                  // legacy: Deal.offert-lista
        bubbleFind("Offert", { constraints: [{ key: "deal", constraint_type: "equals", value: req.params.id }], limit: 20 }).catch(() => []),  // Mira: Offert.deal reverse-lookup
        getList("FortnoxOrder", deal.order),
        getList("FortnoxInvoice", deal.invoice),
        bubbleFind("Contract", { constraints: [{ key: "deal", constraint_type: "equals", value: req.params.id }], limit: 20 }).catch(() => []),  // Avtal: Contract.deal reverse-lookup (Affär-ryggrad)
      ]);
      // dedupa offerter (legacy-lista + reverse-lookup)
      const _offMap = new Map();
      [...offList, ...(offRev || [])].forEach((o) => { const id = bubbleId(o); if (id && !_offMap.has(id)) _offMap.set(id, o); });
      const offRows = [..._offMap.values()];

      // Mira-ordrar: reverse-lookup per Mira-offert (Deal.order håller bara FortnoxOrders)
      const miraOrders = [];
      for (const off of offRows) {
        const mo = await bubbleFind("MiraOrder", { constraints: [{ key: "offert", constraint_type: "equals", value: bubbleId(off) }], limit: 5 }).catch(() => []);
        miraOrders.push(...(mo || []));
      }

      const akItems = akts.map((r) => nAkt(r, m)).sort((a, b) => _ts(b.date) - _ts(a.date));
      const offItems = offRows.map((r) => nOffertM(r, m));
      const avtalItems = (avtalRows || []).map((r) => nAvtal(r, m));
      const ordItems = [...ordRows.map(nOrderF), ...miraOrders.map((r) => nOrderM(r, m))];
      const invItems = invRows.map(nInvoice);

      return res.json({
        ok: true,
        deal: {
          id: bubbleId(deal), titel: _str(deal.titel), company: cname(m, deal["kundföretag"]),
          status: _str(deal.Status), value: _num(deal.value_brutto) || null, sannolikhet: _num(deal.sannolikhet) || null,
        },
        chain: {
          lead: leadRow ? { name: (_str(leadRow.Name) || _str(leadRow.titel) || cname(m, leadRow.Company)), date: _day(leadRow["Created Date"]) } : null,
          aktivitet: { count: akItems.length, latest: akItems.length ? akItems[0].status : null, date: akItems.length ? akItems[0].date : null },
          offert: { count: offItems.length, items: offItems },
          avtal: { count: avtalItems.length, items: avtalItems },
          order: { count: ordItems.length, items: ordItems },
          faktura: { count: invItems.length, items: invItems },
        },
      });
    } catch (e) {
      console.error("[/admin/affar/deal/:id]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/affar/list — komplett sökbar/paginerad liggare per typ ──
  // ?type=lead|aktivitet|offert|order|faktura|avtal|affar  &q=  &page=  &limit=
  // Ersätter Bubble-native-flikarna: server-side paginering + sök (inkl ref-företag).
  app.options("/admin/affar/list", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/list", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const type  = _str(req.query.type).toLowerCase();
      const q     = _str(req.query.q).trim();
      const limit = Math.min(50, Math.max(10, parseInt(req.query.limit, 10) || 30));
      const page  = Math.max(0, parseInt(req.query.page, 10) || 0);
      const cursor = page * limit;
      const feMira = [{ key: "source", constraint_type: "equals", value: SOURCE_MIRA_FE }];

      const pageOf = (t, extra = []) => bubbleFind(t, { constraints: extra, limit, cursor, sort_field: "Created Date", descending: true }).catch(() => []);
      async function searchUnion(t, sets) {
        const all = await Promise.all(sets.map((cs) => bubbleFindAll(t, { constraints: cs }).catch(() => [])));
        const seen = new Map();
        for (const arr of all) for (const r of arr) { const id = bubbleId(r); if (id && !seen.has(id)) seen.set(id, r); }
        return [...seen.values()];
      }
      const byCreated = (a, b) => _ts(b["Created Date"]) - _ts(a["Created Date"]);

      let rows = [], total = null;

      if (type === "lead") {
        const m = await companyMap(), um = await userMap(), ownerMap = await companyOwnerMap();
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [
            [{ key: "Name",  constraint_type: "text contains", value: q }],
            [{ key: "Email", constraint_type: "text contains", value: q }],
            [{ key: "Phone", constraint_type: "text contains", value: q }],
            [{ key: "Company", constraint_type: "text contains", value: q }],
          ];
          if (ccIds.length) sets.push([{ key: "client_company", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("Lead", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("Lead"); total = await bubbleCount("Lead"); }
        rows = recs.map((r) => nLeadFull(r, m, um, ownerMap));
      }
      else if (type === "aktivitet") {
        const m = await companyMap(), um = await userMap(), sm = await supplierMap(), dm = await dealMap();
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [[{ key: "beskrivning", constraint_type: "text contains", value: q }]];
          if (ccIds.length) sets.push([{ key: "company", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("activitet_crm", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("activitet_crm"); total = await bubbleCount("activitet_crm"); }
        rows = recs.map((r) => nAktFull(r, m, um, sm, dm));
      }
      else if (type === "faktura") {
        let recs;
        if (q) {
          recs = (await searchUnion("FortnoxInvoice", [
            [{ key: "ft_customer_name", constraint_type: "text contains", value: q }],
            [{ key: "ft_document_number", constraint_type: "text contains", value: q }],
          ])).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("FortnoxInvoice"); total = await bubbleCount("FortnoxInvoice"); }
        rows = recs.map(nInvoice);
      }
      else if (type === "avtal") {
        const m = await companyMap();
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [[{ key: "contract_title", constraint_type: "text contains", value: q }]];
          if (ccIds.length) sets.push([{ key: "kundföretag", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("Contract", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("Contract"); total = await bubbleCount("Contract"); }
        rows = recs.map((r) => nAvtal(r, m));
      }
      else if (type === "affar") {
        const m = await companyMap();
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [[{ key: "titel", constraint_type: "text contains", value: q }]];
          if (ccIds.length) sets.push([{ key: "kundföretag", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("deal", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("deal"); total = await bubbleCount("deal"); }
        rows = recs.map((r) => nDeal(r, m));
      }
      else if (type === "offert") {
        const m = await companyMap();
        let miras, forts;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const mSets = [[...feMira, { key: "offertnr", constraint_type: "text contains", value: q }]];
          if (ccIds.length) mSets.push([...feMira, { key: "kundforetag", constraint_type: "in", value: ccIds }]);
          miras = await searchUnion("Offert", mSets);
          forts = await searchUnion("FortnoxOffer", [
            [{ key: "ft_customer_name", constraint_type: "text contains", value: q }],
            [{ key: "ft_document_number", constraint_type: "text contains", value: q }],
          ]);
        } else { miras = await pageOf("Offert", feMira); forts = await pageOf("FortnoxOffer"); }
        const durl = await dokUrlMap(miras);
        rows = [...miras.map((r) => nOffertM(r, m, durl)), ...forts.map(nOffertF)].sort((a, b) => _ts(b.date) - _ts(a.date)).slice(0, limit);
        total = q ? rows.length : ((await bubbleCount("Offert", feMira)) + (await bubbleCount("FortnoxOffer")));
      }
      else if (type === "order") {
        const m = await companyMap();
        let miras, forts, tengs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const mSets = [[{ key: "ordernr", constraint_type: "text contains", value: q }]];
          if (ccIds.length) mSets.push([{ key: "kundforetag", constraint_type: "in", value: ccIds }]);
          miras = await searchUnion("MiraOrder", mSets);
          forts = await searchUnion("FortnoxOrder", [
            [{ key: "ft_customer_name", constraint_type: "text contains", value: q }],
            [{ key: "ft_document_number", constraint_type: "text contains", value: q }],
          ]);
          const tSets = [[{ key: "workorder_no", constraint_type: "text contains", value: q }]];
          if (ccIds.length) tSets.push([{ key: "company", constraint_type: "in", value: ccIds }]);
          tengs = await searchUnion("TengellaWorkorder", tSets);
        } else { miras = await pageOf("MiraOrder"); forts = await pageOf("FortnoxOrder"); tengs = await pageOf("TengellaWorkorder"); }
        rows = [
          ...miras.map((r) => nOrderM(r, m)),
          ...forts.map(nOrderF),
          ...tengs.filter((r) => !r.is_deleted).map((r) => nWorkorder(r, m)),
        ].sort((a, b) => _ts(b.date) - _ts(a.date)).slice(0, limit);
        total = q ? rows.length : ((await bubbleCount("MiraOrder")) + (await bubbleCount("FortnoxOrder")) + (await bubbleCount("TengellaWorkorder")));
      }
      else {
        return res.status(400).json({ ok: false, error: "okänd_typ", hint: "type=lead|aktivitet|offert|order|faktura|avtal|affar" });
      }

      return res.json({ ok: true, type, page, limit, q, total, count: rows.length, has_more: rows.length >= limit, rows });
    } catch (e) {
      console.error("[/admin/affar/list]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/lead/:id/assign — tilldela lead till kollega (User) ──
  // body {user_id}. Kollegor hämtas via befintliga /admin/approval/users-by-company
  // (Users där Associated_company contains current users company).
  app.options("/admin/affar/lead/:id/assign", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/lead/:id/assign", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const id = req.params.id;
      const userId = _str((req.body || {}).user_id).trim();
      await bubblePatch("Lead", id, { tilldelad: userId || null });
      let name = "";
      if (userId) { const um = await userMap(); name = um.get(userId) || ""; }
      return res.json({ ok: true, lead_id: id, tilldelad: userId ? { id: userId, name } : null });
    } catch (e) {
      console.error("[/admin/affar/lead/:id/assign]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  console.log("[affar_api] routes registered (/admin/affar/*)");
}
