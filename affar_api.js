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
    bubbleFind, bubbleFindAll, bubbleGet, bubbleId, bubbleCount,
    planningAuthed, planningCors, publicRateLimited, clientIp,
    FE_CONNECTION_ID, CONNECTION_NAMES,
  } = deps;

  const SOURCE_MIRA_FE = "mira_fe";
  const _num = (v) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : bubbleId(v)));
  const _ts = (v) => { if (!v) return 0; const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };
  const _day = (v) => (v ? _str(v).slice(0, 10) : "");

  // ── ClientCompany namn-cache (id → Name_company) ──────────────────
  let _ccCache = { map: null, ts: 0 };
  const CC_TTL = 5 * 60 * 1000;
  async function companyMap() {
    if (_ccCache.map && (Date.now() - _ccCache.ts) < CC_TTL) return _ccCache.map;
    const all = await bubbleFindAll("ClientCompany", {}).catch(() => []);
    const m = new Map();
    for (const c of all) { const id = bubbleId(c); if (id) m.set(id, c.Name_company || c.name || ""); }
    _ccCache = { map: m, ts: Date.now() };
    return m;
  }
  const cname = (m, ref) => { const id = _ref(ref); return id ? (m.get(id) || "") : ""; };

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
  function nOffertM(r, m) { const [lbl, cls] = pick(OFFER_STATUS, _str(r.status), ["Utkast", "wait"]); return { type: "Offert", source: "mira", company: cname(m, r.kundforetag), number: _str(r.offertnr), amount: _num(r.total) || null, date: _day(r.offertdatum || r["Created Date"]), status: lbl, status_cls: cls, id: bubbleId(r) }; }
  function nOffertF(r) { const st = r.ft_cancelled ? ["Avbruten", "red"] : (r.ft_sent ? ["Skickad", "open"] : ["Öppen", "open"]); return { type: "Offert", source: "fortnox", company: _str(r.ft_customer_name), number: _str(r.ft_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_offer_date || r.ft_delivery_date || r["Created Date"]), status: st[0], status_cls: st[1], id: bubbleId(r) }; }
  function nOrderM(r, m) { const [lbl, cls] = pick(ORDER_STATUS, _str(r.orderstatus), ["Bekräftad", "open"]); return { type: "Order", source: "mira", company: cname(m, r.kundforetag), number: _str(r.ordernr), amount: _num(r.total) || null, date: _day(r.orderdatum || r["Created Date"]), status: lbl, status_cls: cls, id: bubbleId(r) }; }
  function nOrderF(r) { const past = _ts(r.ft_delivery_date) && _ts(r.ft_delivery_date) < Date.now(); return { type: "Order", source: "fortnox", company: _str(r.ft_customer_name), number: _str(r.ft_document_number || r.ft_order_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_delivery_date || r["Created Date"]), status: past ? "Levererad" : "Bekräftad", status_cls: past ? "ok" : "open", id: bubbleId(r) }; }
  function nInvoice(r) { const bal = _num(r.ft_balance); const due = _ts(r.ft_due_date); let st = ["Obetald", "open"]; if (bal === 0) st = ["Betald", "ok"]; else if (due && due < Date.now()) st = ["Förfallen", "red"]; return { type: "Faktura", source: connSource(r.connection), company: _str(r.ft_customer_name), number: _str(r.ft_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_invoice_date || r["Created Date"]), status: st[0], status_cls: st[1], id: bubbleId(r) }; }

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
        cLead, cAkt, cDeal, cOffM, cOffF, cOrdM, cOrdF, cWO, cInv,
        m, leads, akts, deals, offMs, offFs, ordMs, ordFs, invs, tengWos,
      ] = await Promise.all([
        bubbleCount("Lead"), bubbleCount("activitet_crm"), bubbleCount("deal"),
        bubbleCount("Offert", feMira), bubbleCount("FortnoxOffer"),
        bubbleCount("MiraOrder"), bubbleCount("FortnoxOrder"), bubbleCount("TengellaWorkorder"),
        bubbleCount("FortnoxInvoice"),
        companyMap(),
        recent("Lead", limit), recent("activitet_crm", limit), recent("deal", limit),
        recent("Offert", limit, feMira), recent("FortnoxOffer", limit),
        recent("MiraOrder", limit), recent("FortnoxOrder", limit), recent("FortnoxInvoice", limit),
        recent("TengellaWorkorder", limit),
      ]);

      const rows = [
        ...leads.map((r) => nLead(r, m)),
        ...akts.map((r) => nAkt(r, m)),
        ...deals.map((r) => nDeal(r, m)),
        ...offMs.map((r) => nOffertM(r, m)),
        ...offFs.map(nOffertF),
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
          offert: cOffM + cOffF, order: cOrdM + cOrdF + cWO, faktura: cInv,
        },
        counts_detail: { offert_mira: cOffM, offert_fortnox: cOffF, order_mira: cOrdM, order_fortnox: cOrdF, order_tengella: cWO },
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

      const [leadRow, akts, offList, offRev, ordRows, invRows] = await Promise.all([
        deal.lead ? bubbleGet("Lead", _ref(deal.lead)).catch(() => null) : null,
        getList("activitet_crm", deal.historik),
        getList("Offert", deal.offert),                                                                  // legacy: Deal.offert-lista
        bubbleFind("Offert", { constraints: [{ key: "deal", constraint_type: "equals", value: req.params.id }], limit: 20 }).catch(() => []),  // Mira: Offert.deal reverse-lookup
        getList("FortnoxOrder", deal.order),
        getList("FortnoxInvoice", deal.invoice),
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
          order: { count: ordItems.length, items: ordItems },
          faktura: { count: invItems.length, items: invItems },
        },
      });
    } catch (e) {
      console.error("[/admin/affar/deal/:id]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  console.log("[affar_api] routes registered (/admin/affar/*)");
}
