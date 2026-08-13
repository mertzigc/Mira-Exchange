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

export function registerCompaniesRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleGet, bubbleId, bubblePatch,
    companyFullMap, companyRevenueMap, companyPatchEntry,
    planningAuthed, planningCors, publicRateLimited, clientIp,
  } = deps;

  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : bubbleId(v)));
  const _num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const _low = (v) => _str(v).toLowerCase();

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

  async function _ctx() {
    const [full, rev, u, g, f] = await Promise.all([
      companyFullMap(), companyRevenueMap(), _users(), _groups(), _fastigheter(),
    ]);
    return { full, rev, users: u.map, groups: g.map, fast: f.map };
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
