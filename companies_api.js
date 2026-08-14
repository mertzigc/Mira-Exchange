// companies_api.js
// ─────────────────────────────────────────────────────────────────────────────
// Företagslista — render-baserad ersättning för Bubble-native företagsvyn.
// DI-mönster som affar_api.js / salj_api.js. All tung data kommer från delade
// förvärmda cachar i index.js (companyFullMap = CC-list-projektion,
// companyRevenueMap = FortnoxInvoice.ft_net per linked_company + år) → list-svaret
// gör INGA Bubble-anrop (bara Map-uppslag), bara PATCH:en skriver.
//
// Endpoints (alla x-admin-token = PLANNING_ADMIN_TOKEN):
//   GET   /admin/companies/list   — filtrerad/sorterad/paginerad lista + (meta på page 1)
//   GET   /admin/companies/meta   — filter-facetter + användar/grupp/fastighet-listor
//   PATCH /admin/companies/:id     — inline-edit (whitelistade fält), uppdaterar cachen
//
// Bubble-gotchas som gäller här:
//   • Data API läs/skriv = display-namn (Name_company, Kundstatus, …), constraints = slug.
//   • Option-set-värden är case-sensitive → felstavning ger tyst 400. Vi validerar
//     inkommande option-set-värden mot de värden som FAKTISKT finns i datan (facetterna)
//     innan write → tydligt 400 i st.f. Bubbles opaka fel.
//   • bubbleFindAll med sort_field fäller tomma → vi sorterar client-side här (på cachen).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";

export function registerCompaniesRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleGet, bubbleId, bubblePatch, bubbleCount, bubbleCreate,
    companyFullMap, companyRevenueMap, companyRevenueMapWarm, companyPatchEntry,
    assignTempPassword, createUserAccount, appBaseUrl, pwResetTemplateId, welcomeTemplateId,
    planningAuthed, planningCors, publicRateLimited, clientIp,
  } = deps;

  const _sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : bubbleId(v)));
  const _num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const _low = (v) => _str(v).toLowerCase();
  const _httpsUrl = (v) => { const s = _str(v); return s ? s.replace(/^\/\//, "https://") : ""; };
  const _day = (v) => (v ? _str(v).slice(0, 10) : "");

  // ── Kedje-normaliserare (kundkortets Deals/Leads/Offerter/Ordrar/Fakturor-flikar) ──
  // Speglar affar_api.js-normaliserarna men kompakt. status_cls: ok|open|wait|red.
  function nDeal(r)  { const s = _str(r.Status); const cls = s === "Avtal" ? "ok" : (s === "Offert" ? "open" : (s === "Avslutad" ? "red" : "wait")); return { type: "Deal", source: "mira", title: _str(r.titel) || "Affär", amount: _num(r.value_brutto), date: _day(r["Created Date"]), status: s || "—", status_cls: cls, url: "", id: bubbleId(r) }; }
  function nLead(r)  { return { type: "Lead", source: "mira", title: _str(r.Name) || "Lead", amount: _num(r.estimated_service_cost_monthly), date: _day(r["Created Date"]), status: _str(r.status) || "Ny", status_cls: "wait", url: "", id: bubbleId(r) }; }
  function nOffM(r)  { const s = _str(r.status); const cls = s === "Approved" ? "ok" : ((s === "Expired" || s === "Revoked") ? "red" : "open"); return { type: "Offert", source: "mira", title: _str(r.offertnr) || "Offert", amount: _num(r.total), date: _day(r.offertdatum || r["Created Date"]), status: s || "Utkast", status_cls: cls, url: "", id: bubbleId(r) }; }
  function nOffF(r)  { const st = r.ft_cancelled ? ["Avbruten", "red"] : (r.ft_sent ? ["Skickad", "open"] : ["Öppen", "open"]); return { type: "Offert", source: "fortnox", title: _str(r.ft_document_number), amount: _num(r.ft_total), date: _day(r.ft_offer_date || r.ft_delivery_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf), id: bubbleId(r) }; }
  function nOrdM(r)  { const s = _str(r.orderstatus); const cls = (s === "Levererad" || s === "Fakturerad") ? "ok" : "open"; return { type: "Order", source: "mira", title: _str(r.ordernr) || "Order", amount: _num(r.total), date: _day(r.orderdatum || r["Created Date"]), status: s || "Bekräftad", status_cls: cls, url: "", id: bubbleId(r) }; }
  function nOrdF(r)  { const t = r.ft_delivery_date ? Date.parse(r.ft_delivery_date) : 0; const past = t && t < Date.now(); return { type: "Order", source: "fortnox", title: _str(r.ft_document_number || r.ft_order_document_number), amount: _num(r.ft_total), date: _day(r.ft_delivery_date || r["Created Date"]), status: past ? "Levererad" : "Bekräftad", status_cls: past ? "ok" : "open", url: _httpsUrl(r.ft_pdf), id: bubbleId(r) }; }
  function nInv(r)   { const bal = _num(r.ft_balance); const due = r.ft_due_date ? Date.parse(r.ft_due_date) : 0; let st = ["Obetald", "open"]; if (bal === 0) st = ["Betald", "ok"]; else if (due && due < Date.now()) st = ["Förfallen", "red"]; return { type: "Faktura", source: "fortnox", title: _str(r.ft_document_number), amount: _num(r.ft_total), date: _day(r.ft_invoice_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf) || _httpsUrl(r.ft_url), id: bubbleId(r) }; }
  function nContract(r) { const end = r["slutdatum"] ? Date.parse(r["slutdatum"]) : 0; const active = !(end && !Number.isNaN(end) && end < Date.now()); return { type: "Avtal", source: "mira", title: _str(r.contract_title) || _str(r["kategori"]) || "Avtal", contract_type: _str(r.contract_type) || "Subscription", amount: _num(r["månadskostnad"]), date: _day(r["slutdatum"]), status: active ? "Aktiv" : "Avslutad", status_cls: active ? "ok" : "wait", id: bubbleId(r) }; }
  function nApproval(r) { const s = _str(r.status); const cls = s === "Approved" ? "ok" : ((s === "Expired" || s === "Revoked") ? "red" : "open"); return { type: "Signering", source: "mira", title: _str(r.rubrik) || "Signering", status: s || "Utkast", status_cls: cls, signed: _num(r.signed_count) || 0, recipients: _num(r.recipients_count) || 0, date: _day(r["Created Date"]), id: bubbleId(r) }; }

  // ── Hjälp-cachar för namn-resolvning (små typer, egen TTL) ──────────
  const AUX_TTL = 5 * 60 * 1000;
  let _uCache = { list: null, map: null, ts: 0 };
  async function _users() {
    if (_uCache.map && (Date.now() - _uCache.ts) < AUX_TTL) return _uCache;
    const all = await bubbleFindAll("User", {}).catch(() => []);
    const map = new Map(), list = [];
    for (const u of all) {
      const id = bubbleId(u); if (!id) continue;
      const first = _str(u["First Name"] || u["Förnamn"]);
      const last  = _str(u["Last Name"]  || u["Efternamn"] || u["Surname"]);
      const nm = (first + " " + last).trim() || _str(u.email || u.Email);
      if (!nm) continue;
      map.set(id, nm); list.push({ id, name: nm });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    _uCache = { list, map, ts: Date.now() };
    return _uCache;
  }

  let _gCache = { list: null, map: null, ts: 0 };
  async function _groups() {
    if (_gCache.map && (Date.now() - _gCache.ts) < AUX_TTL) return _gCache;
    const all = await bubbleFindAll("ClientGroup", {}).catch(() => []);
    const map = new Map(), list = [];
    for (const g of all) {
      const id = bubbleId(g); if (!id) continue;
      const nm = _str(g.name || g.Name || g.namn || g.slug);
      if (!nm) continue;
      map.set(id, nm); list.push({ id, name: nm });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    _gCache = { list, map, ts: Date.now() };
    return _gCache;
  }

  let _fCache = { list: null, map: null, ts: 0 };
  async function _fastigheter() {
    if (_fCache.map && (Date.now() - _fCache.ts) < AUX_TTL) return _fCache;
    const all = await bubbleFindAll("Fastighet", {}).catch(() => []);
    const map = new Map(), list = [];
    for (const f of all) {
      const id = bubbleId(f); if (!id) continue;
      const nm = _str(f.Namn || f.name || f.Name || f.Adress || f.address || f.title || f.Titel);
      if (!nm) continue;
      map.set(id, nm); list.push({ id, name: nm });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    _fCache = { list, map, ts: Date.now() };
    return _fCache;
  }

  // ── Option-set-fält: distinkta värden härledda ur datan (för filter + write-validering) ──
  // Nyckel = fältnamn i list-projektionen; label = svensk kolumnrubrik.
  const OPTIONSET_FIELDS = ["kundstatus", "potential", "lojalitet", "region", "bransch", "customer_type"];
  function _facets(full) {
    const sets = {}; for (const f of OPTIONSET_FIELDS) sets[f] = new Set();
    for (const c of full.values()) for (const f of OPTIONSET_FIELDS) { const v = c[f]; if (v) sets[f].add(v); }
    const out = {};
    for (const f of OPTIONSET_FIELDS) out[f] = [...sets[f]].sort((a, b) => a.localeCompare(b, "sv"));
    return out;
  }

  // ── Whitelist för inline-edit. type: "text" | "number" | "optionset" | "userref" | "groupref" ──
  // bubbleField = Bubble display-namn (Data API skriv-nyckel).
  const EDITABLE = {
    name:          { bubbleField: "Name_company", type: "text" },
    orgnr:         { bubbleField: "Org_Number",   type: "text" },
    kundstatus:    { bubbleField: "Kundstatus",   type: "optionset", facet: "kundstatus" },
    potential:     { bubbleField: "Potential",    type: "optionset", facet: "potential" },
    lojalitet:     { bubbleField: "Lojalitet",    type: "optionset", facet: "lojalitet" },
    region:        { bubbleField: "Region",       type: "optionset", facet: "region" },
    bransch:       { bubbleField: "Bransch",      type: "optionset", facet: "bransch" },
    customer_type: { bubbleField: "customer_type", type: "optionset", facet: "customer_type" },
    nki:           { bubbleField: "NKI_carotte",  type: "number" },
    ansvarig:      { bubbleField: "Kundansvarig", type: "userref" },
    group:         { bubbleField: "group",        type: "groupref" },
    // Kunddata-fält (kundkortets Hem-flik). Adress (geografiskt objekt) + Grundat_år (date) +
    // logotyp (image) redigeras EJ inline i denna omgång — läs-only tills egna kontroller byggs.
    email:              { bubbleField: "Email",        type: "text" },
    telefon:            { bubbleField: "Telefon",      type: "number" },   // Bubble-fält är number → tappar ev. inledande 0
    web:                { bubbleField: "hemsida_crm",  type: "text" },
    kundinformation:    { bubbleField: "kundinfo_crm", type: "text" },
    fakturainformation: { bubbleField: "Fakturainfo",  type: "text" },
  };

  // ── Bygg en list-rad ur cache-projektionen + resolvade namn + omsättning ──
  function _rowOf(c, ctx, yearNow, yearPrev) {
    const rev = ctx.rev.get(c.id) || {};
    return {
      id: c.id,
      name: c.name,
      orgnr: c.orgnr,
      kundstatus: c.kundstatus,
      bransch: c.bransch,
      potential: c.potential,
      lojalitet: c.lojalitet,
      region: c.region,
      customer_type: c.customer_type,
      nki: c.nki,
      antal_medarbetare: c.antal_medarbetare,
      ansvarig_id: c.ansvarig_id,
      ansvarig: c.ansvarig_id ? (ctx.users.get(c.ansvarig_id) || "") : "",
      group_id: c.group_id,
      group: c.group_id ? (ctx.groups.get(c.group_id) || "") : "",
      fastighet_ids: c.fastighet_ids,
      fastigheter: (c.fastighet_ids || []).map((id) => ctx.fast.get(id)).filter(Boolean),
      oms_now: rev[yearNow] != null ? rev[yearNow] : null,
      oms_prev: rev[yearPrev] != null ? rev[yearPrev] : null,
    };
  }

  // Sorterbara nycklar → hämtare (tomma alltid sist)
  const SORT_GETTERS = {
    name:       (r) => r.name,
    orgnr:      (r) => r.orgnr,
    kundstatus: (r) => r.kundstatus,
    bransch:    (r) => r.bransch,
    potential:  (r) => r.potential,
    lojalitet:  (r) => r.lojalitet,
    region:     (r) => r.region,
    ansvarig:   (r) => r.ansvarig,
    group:      (r) => r.group,
    nki:        (r) => r.nki,
    oms_now:    (r) => r.oms_now,
    oms_prev:   (r) => r.oms_prev,
  };
  const NUMERIC_SORT = new Set(["nki", "oms_now", "oms_prev"]);

  function guard(req, res) {
    if (planningCors) planningCors(req, res);
    if (!planningAuthed || !planningAuthed(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
    if (publicRateLimited && clientIp && publicRateLimited(clientIp(req), 600, 60 * 60 * 1000, "companies")) {
      res.status(429).json({ ok: false, error: "rate_limited" }); return false;
    }
    return true;
  }

  // Omsättning laddas ALDRIG blockerande i list-vägen (tung faktura-scan). Varm/stale → med,
  // kall → null (+ bg-laddning startad) → frontenden hämtar om när klar.
  async function _ctx() {
    const [full, u, g, f] = await Promise.all([
      companyFullMap(), _users(), _groups(), _fastigheter(),
    ]);
    const rev = companyRevenueMapWarm ? companyRevenueMapWarm() : (await companyRevenueMap());
    return { full, rev: rev || new Map(), revenueReady: !!rev, users: u.map, groups: g.map, fast: f.map };
  }

  // ── GET /admin/companies/meta ──────────────────────────────────────
  app.options("/admin/companies/meta", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/meta", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const [ctxFull, u, g, f] = await Promise.all([companyFullMap(), _users(), _groups(), _fastigheter()]);
      return res.json({
        ok: true,
        facets: _facets(ctxFull),
        users: u.list,
        groups: g.list,
        fastigheter: f.list,
        editable: Object.fromEntries(Object.entries(EDITABLE).map(([k, v]) => [k, v.type])),
      });
    } catch (e) {
      console.error("[/admin/companies/meta]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/companies/list ──────────────────────────────────────
  // ?q= &ansvarig= &kundstatus= &potential= &lojalitet= &region= &bransch=
  //   &customer_type= &group= &fastighet= &unassigned=1
  //   &sort=name &dir=asc &page=1 &limit=100 &year=2026 &prev=2025 &meta=1
  app.options("/admin/companies/list", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/list", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const ctx = await _ctx();
      const nowYear = new Date().getUTCFullYear();
      const yearNow  = Number(req.query.year) || nowYear;
      const yearPrev = Number(req.query.prev) || (yearNow - 1);

      const q = _low(req.query.q).trim();
      const fEq = {
        ansvarig_id:   _str(req.query.ansvarig).trim() || null,
        group_id:      _str(req.query.group).trim() || null,
        kundstatus:    _str(req.query.kundstatus).trim() || null,
        potential:     _str(req.query.potential).trim() || null,
        lojalitet:     _str(req.query.lojalitet).trim() || null,
        region:        _str(req.query.region).trim() || null,
        bransch:       _str(req.query.bransch).trim() || null,
        customer_type: _str(req.query.customer_type).trim() || null,
      };
      const fastighetId = _str(req.query.fastighet).trim() || null;
      const unassigned = _str(req.query.unassigned) === "1";

      // Bygg + filtrera rader (allt i minne från cachen)
      let rows = [];
      for (const c of ctx.full.values()) {
        if (fEq.ansvarig_id   && c.ansvarig_id   !== fEq.ansvarig_id)   continue;
        if (fEq.group_id      && c.group_id      !== fEq.group_id)      continue;
        if (fEq.kundstatus    && c.kundstatus    !== fEq.kundstatus)    continue;
        if (fEq.potential     && c.potential     !== fEq.potential)     continue;
        if (fEq.lojalitet     && c.lojalitet     !== fEq.lojalitet)     continue;
        if (fEq.region        && c.region        !== fEq.region)        continue;
        if (fEq.bransch       && c.bransch       !== fEq.bransch)       continue;
        if (fEq.customer_type && c.customer_type !== fEq.customer_type) continue;
        if (unassigned        && c.ansvarig_id)                        continue;
        if (fastighetId       && !(c.fastighet_ids || []).includes(fastighetId)) continue;
        if (q) {
          const hay = (c.name + " " + c.orgnr).toLowerCase();
          if (!hay.includes(q)) continue;
        }
        rows.push(_rowOf(c, ctx, yearNow, yearPrev));
      }

      // Sortering (tomma alltid sist, oavsett riktning)
      const sortKey = SORT_GETTERS[_str(req.query.sort)] ? _str(req.query.sort) : "name";
      const dir = _str(req.query.dir) === "desc" ? -1 : 1;
      const getv = SORT_GETTERS[sortKey];
      const isNum = NUMERIC_SORT.has(sortKey);
      rows.sort((a, b) => {
        const va = getv(a), vb = getv(b);
        const ea = (va == null || va === ""), eb = (vb == null || vb === "");
        if (ea && eb) return 0;
        if (ea) return 1;    // tomma sist
        if (eb) return -1;
        if (isNum) return (Number(va) - Number(vb)) * dir;
        return String(va).localeCompare(String(vb), "sv") * dir;
      });

      const total = rows.length;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const page  = Math.max(Number(req.query.page) || 1, 1);
      const start = (page - 1) * limit;
      const pageRows = rows.slice(start, start + limit);

      const out = {
        ok: true, total, page, limit,
        pages: Math.max(1, Math.ceil(total / limit)),
        year: yearNow, prev: yearPrev,
        revenue_ready: ctx.revenueReady,   // false = faktura-scanningen värms fortf. → oms-kolumnerna kommer strax
        rows: pageRows,
      };
      if (_str(req.query.meta) === "1" || page === 1) {
        const [u, g, f] = await Promise.all([_users(), _groups(), _fastigheter()]);
        out.meta = {
          facets: _facets(ctx.full),
          users: u.list, groups: g.list, fastigheter: f.list,
          editable: Object.fromEntries(Object.entries(EDITABLE).map(([k, v]) => [k, v.type])),
          cache_total: ctx.full.size,
        };
      }
      return res.json(out);
    } catch (e) {
      console.error("[/admin/companies/list]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/companies/:id/card ──────────────────────────────────
  // Kundkortets Hem-flik: kunddata (läs+edit) + KPI-aggregat + counts per flik + meta.
  // Återanvänder delade cacharna + omsättning (icke-blockerande). EN bubbleGet (extra CC-fält)
  // + EN Contract-hämtning (MRR/aktiva) + 2 counts. Counts som ännu kräver modul-specifik
  // fältmappning (personer/leads/offert/order/faktura) = null tills resp. flik byggs.
  app.options("/admin/companies/:id/card", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/card", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const full = await companyFullMap();
      const proj = full.get(id);
      if (!proj) return res.status(404).json({ ok: false, error: "company_not_found" });

      const nowYear = new Date().getUTCFullYear();
      const [rec, u, g, f] = await Promise.all([
        bubbleGet("ClientCompany", id).catch(() => null),
        _users(), _groups(), _fastigheter(),
      ]);
      const rev = companyRevenueMapWarm ? companyRevenueMapWarm() : (await companyRevenueMap());
      const revReady = !!rev;
      const revEntry = (rev && rev.get(id)) || {};

      // Contract-aggregat (aktiv = slutdatum tomt eller ≥ nu — speglar /services/dashboard)
      const contracts = await bubbleFindAll("Contract", {
        constraints: [{ key: "kundföretag", constraint_type: "equals", value: id }],
      }).catch(() => []);
      const now = Date.now();
      let mrr = 0, active = 0;
      for (const ct of (contracts || [])) {
        const endRaw = ct["slutdatum"];
        const end = endRaw ? new Date(endRaw).getTime() : null;
        const isActive = !(end != null && !Number.isNaN(end) && end < now);
        if (isActive) { active++; mrr += Math.round(Number(ct["månadskostnad"] || 0)); }
      }

      // Counts per flik (parallellt). Företagsfält per typ: Mira=kundföretag/kundforetag/client_company,
      // Fortnox=linked_company. Personer/drift byggs senare → null.
      const eqc = (field) => [{ key: field, constraint_type: "equals", value: id }];
      const [histCount, dealCount, leadCount, offMC, offFC, ordMC, ordFC, invCount, persCount] = await Promise.all([
        bubbleCount("activitet_crm", eqc("clientcompany")).catch(() => null),
        bubbleCount("deal", eqc("kundföretag")).catch(() => null),
        bubbleCount("Lead", eqc("client_company")).catch(() => null),
        bubbleCount("Offert", eqc("kundforetag")).catch(() => null),
        bubbleCount("FortnoxOffer", eqc("linked_company")).catch(() => null),
        bubbleCount("MiraOrder", eqc("kundforetag")).catch(() => null),
        bubbleCount("FortnoxOrder", eqc("linked_company")).catch(() => null),
        bubbleCount("FortnoxInvoice", eqc("linked_company")).catch(() => null),
        bubbleCount("Coworker", eqc("Kundföretag")).catch(() => null),
      ]);
      const sumC = (a, b) => ((a == null && b == null) ? null : (Number(a || 0) + Number(b || 0)));

      const adr = rec && rec.Adress;
      const address = adr ? (typeof adr === "string" ? adr : (adr.address || "")) : "";
      const grundat = rec && rec["Grundat_år"] ? _str(rec["Grundat_år"]).slice(0, 4) : "";

      const company = Object.assign({}, proj, {
        ansvarig: proj.ansvarig_id ? (u.map.get(proj.ansvarig_id) || "") : "",
        group: proj.group_id ? (g.map.get(proj.group_id) || "") : "",
        fastigheter: (proj.fastighet_ids || []).map((x) => f.map.get(x)).filter(Boolean),
        adress: address,
        email: rec ? _str(rec.Email) : "",
        telefon: (rec && rec.Telefon != null) ? _str(rec.Telefon) : "",
        web: rec ? _str(rec.hemsida_crm) : "",
        kundinformation: rec ? _str(rec.kundinfo_crm) : "",
        fakturainformation: rec ? _str(rec.Fakturainfo) : "",
        grundat: grundat,
        logotyp: rec ? _httpsUrl(rec.logotyp) : "",
      });

      return res.json({
        ok: true,
        revenue_ready: revReady,
        company,
        kpi: {
          mrr, active_contracts: active, contracts_total: (contracts || []).length,
          omsattning_now: revReady ? (revEntry[nowYear] != null ? revEntry[nowYear] : null) : null,
          omsattning_prev: revReady ? (revEntry[nowYear - 1] != null ? revEntry[nowYear - 1] : null) : null,
          year: nowYear, prev: nowYear - 1,
          nki: proj.nki, antal_medarbetare: proj.antal_medarbetare,
        },
        counts: {
          avtal: (contracts || []).length, historik: histCount, deals: dealCount,
          leads: leadCount, offerter: sumC(offMC, offFC), ordrar: sumC(ordMC, ordFC), fakturor: invCount,
          personer: persCount, drift: null,
        },
        meta: {
          facets: _facets(full), users: u.list, groups: g.list, fastigheter: f.list,
          editable: Object.fromEntries(Object.entries(EDITABLE).map(([k, v]) => [k, v.type])),
        },
      });
    } catch (e) {
      console.error("[/admin/companies/:id/card]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/companies/:id/chain?type=deals|leads|offerter|ordrar|fakturor ──
  // Reverse-lookup per företag (kundkortets liggar-flikar). Mira-typer via kundföretag/
  // kundforetag/client_company, Fortnox via linked_company. Rader sorteras nyast först.
  app.options("/admin/companies/:id/chain", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/chain", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    const type = _str(req.query.type).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    const eq = (field) => ({ constraints: [{ key: field, constraint_type: "equals", value: id }] });
    const find = (t, field) => bubbleFindAll(t, eq(field)).catch(() => []);
    try {
      let rows = [];
      if (type === "deals") {
        rows = (await find("deal", "kundföretag")).map(nDeal);
      } else if (type === "leads") {
        rows = (await find("Lead", "client_company")).map(nLead);
      } else if (type === "offerter") {
        const [a, b] = await Promise.all([find("Offert", "kundforetag"), find("FortnoxOffer", "linked_company")]);
        rows = a.map(nOffM).concat(b.map(nOffF));
      } else if (type === "ordrar") {
        const [a, b] = await Promise.all([find("MiraOrder", "kundforetag"), find("FortnoxOrder", "linked_company")]);
        rows = a.map(nOrdM).concat(b.map(nOrdF));
      } else if (type === "fakturor") {
        rows = (await find("FortnoxInvoice", "linked_company")).map(nInv);
      } else if (type === "avtal") {
        rows = (await find("Contract", "kundföretag")).map(nContract);
      } else if (type === "signeringar") {
        rows = (await find("OfferApprovalRequest", "clientcompany")).map(nApproval);
      } else {
        return res.status(400).json({ ok: false, error: "bad_type" });
      }
      rows.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      return res.json({ ok: true, type, count: rows.length, rows });
    } catch (e) {
      console.error("[/admin/companies/:id/chain]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/companies/:id/coworkers — Personer-fliken ──────────
  // Coworker (Kundföretag == id). has_user = coworkerns e-post matchar en User vars
  // Company (singular — EN per user; INTE Associated_company som är en lista) == företaget,
  // dvs har ett login-konto. Ren Coworker utan User = CRM-kontakt. Sorterat efternamn+förnamn.
  const _email = (v) => String(v == null ? "" : v).trim().toLowerCase();
  const DEPARTMENTS = ["Ekonomi", "Försäljning", "Ledning", "Leverans", "Marknad", "IT", "Kontor"];   // option set "Department"
  app.options("/admin/companies/:id/coworkers", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/coworkers", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const [cos, users, offs] = await Promise.all([
        bubbleFindAll("Coworker", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: id }] }).catch(() => []),
        bubbleFindAll("User", { constraints: [{ key: "Company", constraint_type: "equals", value: id }] }).catch(() => []),
        bubbleFindAll("Office", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: id }] }).catch(() => []),
      ]);
      // e-post → user-id (login-konto)
      const userByEmail = new Map();
      for (const u of (users || [])) {
        const em = _email(u.email || u.Email || (u.authentication && u.authentication.email && u.authentication.email.email));
        if (em) userByEmail.set(em, bubbleId(u));
      }
      const officeMap = new Map(), offices = [];
      for (const o of (offs || [])) { const oid = bubbleId(o); if (!oid) continue; const nm = _str(o.Office_title || o.name || o.Name); officeMap.set(oid, nm); offices.push({ id: oid, name: nm }); }
      offices.sort((a, b) => a.name.localeCompare(b.name, "sv"));
      const rows = (cos || []).map((co) => {
        const first = _str(co["Förnamn"] || co["First Name"] || co.first_name || co.fornamn);
        const last  = _str(co["Efternamn"] || co["Last Name"] || co.last_name || co.efternamn);
        const email = _str(co.Email || co.email || co.email_address);
        const uid   = email ? userByEmail.get(_email(email)) : null;
        const kontorId = _ref(co.Kontor);
        return {
          id: bubbleId(co),
          first, last,
          name: (first + " " + last).trim() || email,
          title: _str(co.Titel || co.title || co.Befattning || co.Roll || co.roll),
          email,
          phone: _str(co.Telefon || co.telefon || co.Phone || co.phone || co.Mobil || co.mobil),
          crm_info: _str(co.crm_info),
          avdelning: _str(co.Avdelning),
          kontor_id: kontorId || null,
          kontor: kontorId ? (officeMap.get(kontorId) || "") : "",
          has_user: !!uid,
          user_id: uid || null,
        };
      });
      rows.sort((a, b) => (a.last || a.first).localeCompare(b.last || b.first, "sv") || a.first.localeCompare(b.first, "sv"));
      return res.json({ ok: true, count: rows.length, rows, offices, departments: DEPARTMENTS });
    } catch (e) {
      console.error("[/admin/companies/:id/coworkers]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/companies/:id/coworker/create — ny person (Coworker) på företaget ──
  // Data API (Render kan skapa Coworker direkt). Login-konto skapas separat via create-account.
  app.options("/admin/companies/:id/coworker/create", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/:id/coworker/create", async (req, res) => {
    if (!guard(req, res)) return;
    const companyId = _str(req.params.id).trim();
    if (!companyId) return res.status(400).json({ ok: false, error: "missing_id" });
    if (typeof bubbleCreate !== "function") return res.status(501).json({ ok: false, error: "not_configured" });
    try {
      const b = req.body || {};
      const first = _str(b.first || b.first_name).trim();
      const last = _str(b.last || b.last_name).trim();
      const email = _str(b.email).trim();
      const title = _str(b.title).trim();
      const phoneDigits = _str(b.phone).replace(/\D/g, "");
      if (!first && !last && !email) return res.status(400).json({ ok: false, error: "missing_fields" });
      const payload = { "Förnamn": first, "Efternamn": last, "Kundföretag": companyId };
      if (email) payload.Email = email;
      if (title) payload.Titel = title;
      if (phoneDigits) payload.Telefon = Number(phoneDigits);   // Telefon = number-fält
      const id = await bubbleCreate("Coworker", payload);
      return res.json({ ok: true, id });
    } catch (e) {
      console.error("[/admin/companies/:id/coworker/create]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/companies/coworker/:id/create-account — skapa login-konto + välkomstmail ──
  // User-kontot skapas via Bubble-wf (auth ägs av Bubble); sen skickar vi välkomstmailet.
  app.options("/admin/companies/coworker/:id/create-account", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/coworker/:id/create-account", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const co = await bubbleGet("Coworker", id).catch(() => null);
      if (!co) return res.status(404).json({ ok: false, error: "coworker_not_found" });
      const email = _str(co.Email || co.email || co.email_address);
      if (!email) return res.status(400).json({ ok: false, error: "no_email" });
      const firstname = _str(co["Förnamn"] || co["First Name"]);
      const surname = _str(co["Efternamn"] || co["Last Name"]);
      const name = (firstname + " " + surname).trim();
      const company = _ref(co["Kundföretag"] || co.company || co.Company);
      if (typeof createUserAccount !== "function") {
        return res.status(501).json({ ok: false, error: "not_configured", hint: "Sätt env BUBBLE_CREATE_USER_WF + bygg Bubble-wf create_user_account.", email });
      }
      const pw = crypto.randomBytes(18).toString("hex") + "Aa1!";   // slump (Steg 1 använder ingen — ersätts vid reset)
      const r = await createUserAccount({ email, password: pw, firstname, surname, company, coworker_id: id });
      if (!r || !r.ok) return res.status(502).json({ ok: false, error: (r && r.error) || "create_failed", email });
      // välkomstmail (samma som ny-user-flödet)
      const m = await _sendSetPassword({ email, coworkerId: id, toName: name, templateId: welcomeTemplateId || pwResetTemplateId });
      return res.json({ ok: true, email, user_id: r.user_id || null, mail: m.ok === true });
    } catch (e) {
      console.error("[/admin/companies/coworker/:id/create-account]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── PATCH /admin/companies/coworker/:id — redigera person (Coworker) ──
  // Whitelistade fält (bekräftade Coworker-display-namn). Fler (Info/datum/avdelning) kan
  // läggas till när fältnamnen bekräftats.
  const CO_EDITABLE = {
    first:    { f: "Förnamn",   t: "text" },
    last:     { f: "Efternamn", t: "text" },
    title:    { f: "Titel",     t: "text" },
    email:    { f: "Email",     t: "text" },
    telefon:  { f: "Telefon",   t: "number" },
    crm_info: { f: "crm_info",  t: "text" },
    avdelning:{ f: "Avdelning", t: "optionset" },   // option set Department → skriv display-värde
    kontor:   { f: "Kontor",    t: "ref" },          // Office-referens → skriv id (tom = rensa)
  };
  app.options("/admin/companies/coworker/:id", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.patch("/admin/companies/coworker/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const co = await bubbleGet("Coworker", id).catch(() => null);
      if (!co) return res.status(404).json({ ok: false, error: "coworker_not_found" });
      const body = req.body || {};
      const fields = body.fields || (body.field ? { [body.field]: body.value } : null);
      if (!fields || !Object.keys(fields).length) return res.status(400).json({ ok: false, error: "no_fields" });
      const payload = {};
      for (const [k, v] of Object.entries(fields)) {
        const spec = CO_EDITABLE[k];
        if (!spec) return res.status(400).json({ ok: false, error: `field_not_editable:${k}` });
        if (spec.t === "number") { const d = _str(v).replace(/\D/g, ""); payload[spec.f] = d ? Number(d) : null; }
        else if (spec.t === "ref") { payload[spec.f] = _ref(v) || ""; }             // Office-id el. rensa
        else if (spec.t === "optionset") { const sv = _str(v).trim(); payload[spec.f] = sv; }   // "" rensar
        else payload[spec.f] = _str(v);
      }
      await bubblePatch("Coworker", id, payload);
      return res.json({ ok: true, id });
    } catch (e) {
      console.error("[/admin/companies/coworker/:id PATCH]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── GET /admin/companies/coworker/:id/activities — aktiviteter där personen är taggad ──
  // Söker activitet_crm där taggade_personer (List of Coworker) contains personen. Nyast först.
  function nActivity(r) {
    return {
      id: bubbleId(r),
      date: _day(r["Datum_bokning"] || r["Created Date"]),
      created: _day(r["Created Date"]),
      typ: _str(r.activity_type),
      fas: _str(r["Kundmöte"]),
      meddelande: _str(r.beskrivning) || _str(r["mötesantecking"]),
      genomfort: r["genomfört"] === true,
    };
  }
  app.options("/admin/companies/coworker/:id/activities", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/coworker/:id/activities", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const raw = await bubbleFindAll("activitet_crm", { constraints: [{ key: "taggade_personer", constraint_type: "contains", value: id }] }).catch(() => []);
      const rows = (raw || []).map(nActivity).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      return res.json({ ok: true, count: rows.length, rows });
    } catch (e) {
      console.error("[/admin/companies/coworker/:id/activities]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ══════════════ LÖSENORDS-RESET (eget token-flöde via vår motor) ══════════════
  // Bubble kan inte sätta ett valfritt lösenord via API → relä: vår token → reset_pw
  // loggar in användaren med ett engångs-temp (Bubble-wf assign_temp_password) och sätter
  // deras VALDA lösenord via "Update password". Användaren skriver aldrig nuvarande lösenord.
  //
  // 1) send-password: gen token → spara PasswordReset-rad (token_hash) → maila reset-länk via emailqueue.
  // 2) reset_pw-sidan POST:ar token+ → exchange: validera token → assign_temp_password → returnera temp.
  //    reset_pw kör sen Log the user in + Update password i Bubble.
  const PW_TTL_MS = 24 * 60 * 60 * 1000;

  // Delad kärna: gen token → spara PasswordReset → maila "sätt lösenord"-länk. Används av
  // BÅDE nyckelknappen (befintlig coworker) OCH ny-user-flödet (/admin/reset-password/send).
  async function _sendSetPassword({ email, coworkerId, toName, templateId }) {
    const tpl = templateId || pwResetTemplateId;
    if (!tpl || typeof bubbleCreate !== "function") return { ok: false, code: 501, error: "not_configured" };
    if (!email) return { ok: false, code: 400, error: "no_email" };
    const raw = crypto.randomBytes(24).toString("hex");
    const now = Date.now();
    const row = { email, token_hash: _sha256(raw), expires_at: new Date(now + PW_TTL_MS).toISOString(), used: false };
    if (coworkerId) row.coworker = coworkerId;
    await bubbleCreate("PasswordReset", row);
    const base = (appBaseUrl || "https://mira-fm.com").replace(/\/+$/, "");
    await bubbleCreate("emailqueue", {
      template_id: tpl,
      to_email: email,
      to_name: _str(toName || ""),
      entity_id: "",
      email_sent: false,
      extra_data: JSON.stringify({ reset_url: base + "/reset_pw?t=" + raw, sender_name: "Carotte" }),
    });
    return { ok: true, email };
  }

  // ── POST /admin/companies/coworker/:id/send-password (nyckelknappen) ──
  app.options("/admin/companies/coworker/:id/send-password", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/coworker/:id/send-password", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const co = await bubbleGet("Coworker", id).catch(() => null);
      if (!co) return res.status(404).json({ ok: false, error: "coworker_not_found" });
      const email = _str(co.Email || co.email || co.email_address);
      const toName = (_str(co["Förnamn"] || co["First Name"]) + " " + _str(co["Efternamn"] || co["Last Name"])).trim();
      const r = await _sendSetPassword({ email, coworkerId: id, toName });
      if (!r.ok) return res.status(r.code || 500).json({ ok: false, error: r.error, email });
      return res.json({ ok: true, email });
    } catch (e) {
      console.error("[/admin/companies/coworker/:id/send-password]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/reset-password/send {email, name?, coworker_id?} — nya användare ──
  // Admin-token-grindad (anropas server-side från Bubble efter user-skapande). Samma
  // mail + reset_pw-flöde som nyckelknappen. Kör detta direkt efter "Create a new user".
  app.options("/admin/reset-password/send", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/reset-password/send", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const b = req.body || {};
      const email = _str(b.email).trim();
      if (!email) return res.status(400).json({ ok: false, error: "no_email" });
      if (email === "__INIT__") return res.json({ ok: true, email: "init@example.com", sample: true });   // API Connector-init utan sidoeffekt
      // Nya användare → välkomstmallen (user_welcome) om satt, annars reset-mallen.
      const r = await _sendSetPassword({ email, coworkerId: _str(b.coworker_id) || null, toName: _str(b.name || b.to_name), templateId: welcomeTemplateId || pwResetTemplateId });
      if (!r.ok) return res.status(r.code || 500).json({ ok: false, error: r.error });
      return res.json({ ok: true, email });
    } catch (e) {
      console.error("[/admin/reset-password/send]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/reset-password/exchange — reset_pw-sidan byter token mot engångs-temp ──
  // PUBLIK (token-grindad, ingen admin-token). Rate-limitad. Validerar PasswordReset-token,
  // bränner den, tilldelar ett temp-lösenord via Bubble-wf och returnerar {email, temp_password}.
  app.options("/admin/reset-password/exchange", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/reset-password/exchange", async (req, res) => {
    if (planningCors) planningCors(req, res);
    if (publicRateLimited && clientIp && publicRateLimited(clientIp(req), 30, 60 * 60 * 1000, "pwreset")) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    try {
      const token = _str((req.body && (req.body.token || req.body.t)) || "").trim();
      if (!token) return res.status(400).json({ ok: false, error: "missing_token" });
      // Init-läge: låter Bubbles API Connector lära sig svarsformen utan att röra data/bränna token.
      if (token === "__INIT__") {
        return res.json({ ok: true, email: "init@example.com", temp_password: "INIT-SAMPLE-PW", sample: true });
      }
      if (typeof assignTempPassword !== "function") {
        return res.status(501).json({ ok: false, error: "not_configured", hint: "Sätt env BUBBLE_ASSIGN_TEMP_WF + bygg Bubble-wf assign_temp_password." });
      }
      const hash = _sha256(token);
      const rows = await bubbleFindAll("PasswordReset", { constraints: [{ key: "token_hash", constraint_type: "equals", value: hash }] }).catch(() => []);
      const now = Date.now();
      const row = (rows || []).find((r) => {
        if (r.used === true) return false;
        const exp = r.expires_at ? Date.parse(r.expires_at) : 0;
        return !(exp && exp < now);
      });
      if (!row) return res.status(400).json({ ok: false, error: "invalid_or_expired" });
      await bubblePatch("PasswordReset", bubbleId(row), { used: true, used_at: new Date(now).toISOString() }).catch(() => {});
      const r = await assignTempPassword({ email: _str(row.email) });
      if (!r || !r.ok || !r.temp_password) return res.status(502).json({ ok: false, error: (r && r.error) || "assign_failed" });
      return res.json({ ok: true, email: _str(row.email), temp_password: r.temp_password });
    } catch (e) {
      console.error("[/admin/reset-password/exchange]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── PATCH /admin/companies/:id ─────────────────────────────────────
  // body { fields: { <editable-key>: value, … } }  eller  { field, value } (enskilt)
  // Skriver till Bubble via display-namn, validerar option-set mot facetterna,
  // re-fetchar posten → uppdaterar delade cachen → returnerar färsk rad.
  app.options("/admin/companies/:id", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.patch("/admin/companies/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const body = req.body || {};
      const fields = body.fields || (body.field ? { [body.field]: body.value } : null);
      if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
        return res.status(400).json({ ok: false, error: "no_fields" });
      }

      // Verifiera att företaget finns i cachen (annars fel id)
      const full = await companyFullMap();
      if (!full.has(id)) return res.status(404).json({ ok: false, error: "company_not_found" });
      const facets = _facets(full);

      const payload = {};
      for (const [key, rawVal] of Object.entries(fields)) {
        const spec = EDITABLE[key];
        if (!spec) return res.status(400).json({ ok: false, error: `field_not_editable:${key}` });
        const val = rawVal;

        if (spec.type === "text") {
          payload[spec.bubbleField] = _str(val);
        } else if (spec.type === "number") {
          if (val === "" || val == null) payload[spec.bubbleField] = null;
          else { const n = Number(val); if (!Number.isFinite(n)) return res.status(400).json({ ok: false, error: `bad_number:${key}` }); payload[spec.bubbleField] = n; }
        } else if (spec.type === "optionset") {
          const sv = _str(val).trim();
          if (sv === "") { payload[spec.bubbleField] = ""; }   // rensa
          else {
            const known = facets[spec.facet] || [];
            if (!known.includes(sv)) return res.status(400).json({ ok: false, error: `unknown_optionset_value:${key}`, value: sv, allowed: known });
            payload[spec.bubbleField] = sv;
          }
        } else if (spec.type === "userref" || spec.type === "groupref") {
          const rid = _ref(val);
          payload[spec.bubbleField] = rid || "";   // "" rensar referensen
        }
      }

      await bubblePatch("ClientCompany", id, payload);
      const fresh = await bubbleGet("ClientCompany", id).catch(() => null);
      if (fresh && companyPatchEntry) companyPatchEntry(id, fresh);

      // Bygg färsk rad från uppdaterad cache
      const ctx = await _ctx();
      const nowYear = new Date().getUTCFullYear();
      const c = ctx.full.get(id);
      const row = c ? _rowOf(c, ctx, nowYear, nowYear - 1) : null;
      return res.json({ ok: true, id, row });
    } catch (e) {
      console.error("[/admin/companies/:id PATCH]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });
}
