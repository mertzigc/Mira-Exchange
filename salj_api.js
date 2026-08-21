// salj_api.js
// ─────────────────────────────────────────────────────────────────────────────
// Sälj — mötesbokningstratt (Kundmöte-aktiviteter per fas) + säljmål (SalesBudget)
// + attribution möte→affär (aktivitetens deal-fält, satt via "skapa affär från
// aktivitet"). DI-mönster som affar_api.js / produktion_api.js.
//
// Endpoints (alla x-admin-token-grindade via planningAuthed):
//   GET  /admin/salj/moten?from=&to=&person=   — mötestratt grupperad per fas + summering
//   GET  /admin/salj/budget?month=YYYY-MM       — säljare (Users med SalesBudget) + mål + utfall
//   POST /admin/salj/budget                     — sätt/uppdatera SalesBudget för User + månad
//
// Läsnycklar (bekräftade): activitet_crm.activity_type="Kundmöte", .Kundmöte (=fas
// "Fas 1"–"Fas 4"|"Övrigt"), .Datum_bokning (mötesdatum), .genomfört (yes/no),
// .writer||"Created By" (ansvarig), .deal (attribution), .company.
// SalesBudget: User, Startdatum, Slutdatum, total_kundmote, total_invoice,
// total_affar, active, Godkänd, kommentar.
// ─────────────────────────────────────────────────────────────────────────────

export function registerSaljRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleGet, bubbleCreate, bubblePatch, bubbleId,
    planningAuthed, planningCors, publicRateLimited, clientIp,
  } = deps;

  const _str = (v) => (v == null ? "" : String(v));
  const _num = (v) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : (v._id || bubbleId(v) || null)));
  const _day = (v) => (v ? _str(v).slice(0, 10) : "");
  const _ts = (v) => { if (!v) return 0; const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };

  const FASER = ["Fas 1", "Fas 2", "Fas 3", "Fas 4", "Övrigt"];
  // Per-fas mötesmål → Bubble-fält på SalesBudget (number). total_kundmote hålls = summan.
  const FAS_FIELD = { "Fas 1": "mal_fas1", "Fas 2": "mal_fas2", "Fas 3": "mal_fas3", "Fas 4": "mal_fas4", "Övrigt": "mal_ovrigt" };
  const normFas = (v) => { const s = _str(v).trim(); return FASER.indexOf(s) > -1 ? s : "Övrigt"; };
  const zeroFas = () => { const o = {}; for (const f of FASER) o[f] = 0; return o; };
  const CC_TTL = 5 * 60 * 1000;

  function guard(req, res) {
    planningCors && planningCors(req, res);
    if (!planningAuthed(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
    if (publicRateLimited && clientIp && publicRateLimited("salj:" + clientIp(req), 120)) { res.status(429).json({ ok: false, error: "rate_limited" }); return false; }
    return true;
  }

  // ── caches ──────────────────────────────────────────────────────────
  let _uCache = { map: null, ts: 0 };
  async function userMap() {
    if (_uCache.map && (Date.now() - _uCache.ts) < CC_TTL) return _uCache.map;
    const all = await bubbleFindAll("User", {}).catch(() => []);
    const m = new Map();
    for (const u of all) {
      const id = bubbleId(u); if (!id) continue;
      const nm = ((_str(u["First Name"] || u["Förnamn"]) + " " + _str(u["Last Name"] || u["Efternamn"] || u["Surname"])).trim()) || _str(u.email || u.Email);
      m.set(id, nm);
    }
    _uCache = { map: m, ts: Date.now() };
    return m;
  }
  let _ccCache = { map: null, ts: 0 };
  async function companyMap() {
    if (deps.companyMap) return deps.companyMap();   // delad förvärmd CC-cache
    if (_ccCache.map && (Date.now() - _ccCache.ts) < CC_TTL) return _ccCache.map;
    const all = await bubbleFindAll("ClientCompany", {}).catch(() => []);
    const m = new Map();
    for (const c of all) { const id = bubbleId(c); if (id) m.set(id, _str(c.Name_company) || _str(c.name)); }
    _ccCache = { map: m, ts: Date.now() };
    return m;
  }
  // deal id → { titel, value } (bara ~få deals; laddas som helhet)
  let _dCache = { map: null, ts: 0 };
  async function dealMap() {
    if (_dCache.map && (Date.now() - _dCache.ts) < CC_TTL) return _dCache.map;
    const all = await bubbleFindAll("deal", {}).catch(() => []);
    const m = new Map();
    for (const d of all) { const id = bubbleId(d); if (id) m.set(id, { titel: _str(d.titel) || _str(d.Namn) || _str(d.name) || "(namnlös affär)", value: _num(d.value_brutto), status: _str(d.Status) }); }
    _dCache = { map: m, ts: Date.now() };
    return m;
  }
  const cname = (m, ref) => { const id = _ref(ref); return id ? (m.get(id) || "") : ""; };

  // Alla Kundmöte-aktiviteter (activity_type=Kundmöte). Datumfiltrering client-side
  // (Datum_bokning = datum-sträng; numerisk constraint saknas → filtrera i JS).
  async function loadKundmoten() {
    return bubbleFindAll("activitet_crm", { constraints: [{ key: "activity_type", constraint_type: "equals", value: "Kundmöte" }] }).catch(() => []);
  }
  const aktRep = (r) => _ref(r.writer) || _ref(r["Created By"]);   // ansvarig säljare

  // Normaliserat mötes-objekt (för tratt + utfall)
  function nMote(r, um, cm, dm) {
    const repId = aktRep(r);
    const dId = _ref(r.deal);
    const d = dId ? (dm.get(dId) || null) : null;
    return {
      id: bubbleId(r),
      fas: normFas(r["Kundmöte"]),
      datum: _day(r["Datum_bokning"]),
      datum_ts: _ts(r["Datum_bokning"]),
      company: cname(cm, r.company),
      // ⚠️ Kund-ID:t behövs för att kunna skapa uppföljaren (aktivitet/todo) knuten
      // till RÄTT företag direkt ur mötesbokningsvyn. `company` är enda kund-fältet
      // på activitet_crm (schema-verifierat) — det finns alltid när mötet är kopplat.
      company_id: _ref(r.company) || null,
      ansvarig: repId ? (um.get(repId) || "") : "",
      ansvarig_id: repId || null,
      genomfort: r["genomfört"] === true,
      // Nästa steg-beslutet. Frontenden grindar bara när det saknas (annars skulle
      // varje redigering av ett avklarat möte kräva ett nytt beslut).
      nasta_steg: _osStr(r["aktivitet_nasta_steg"]),
      meddelande: _str(r.beskrivning),
      motesanteckning: _str(r["mötesantecking"]),   // Bubble-fält misstavat (mötesantecking)
      deal_id: dId || null,
      deal_name: d ? d.titel : "",
      deal_value: d ? d.value : 0,
      blev_affar: !!dId,
    };
  }

  // ── GET /admin/salj/moten?from=&to=&person= — mötestratt per fas ──
  app.options("/admin/salj/moten", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/salj/moten", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const from = _str(req.query.from).slice(0, 10), to = _str(req.query.to).slice(0, 10);
      const person = _str(req.query.person).trim();
      const fromTs = /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(from + "T00:00:00.000Z").getTime() : null;
      const toTs = /^\d{4}-\d{2}-\d{2}$/.test(to) ? (new Date(to + "T00:00:00.000Z").getTime() + 86400000) : null;

      const [um, cm, dm] = [await userMap(), await companyMap(), await dealMap()];
      let rows = (await loadKundmoten()).map((r) => nMote(r, um, cm, dm));
      if (fromTs != null) rows = rows.filter((r) => r.datum_ts && r.datum_ts >= fromTs);
      if (toTs != null) rows = rows.filter((r) => r.datum_ts && r.datum_ts < toTs);
      if (person) rows = rows.filter((r) => r.ansvarig_id === person);

      // gruppera per fas + sortera på datum inom fas
      const groups = FASER.map((f) => ({ fas: f, moten: [] }));
      const byFas = new Map(groups.map((g) => [g.fas, g]));
      for (const r of rows) byFas.get(r.fas).moten.push(r);
      for (const g of groups) g.moten.sort((a, b) => (a.datum_ts || 0) - (b.datum_ts || 0));

      // summering
      const total = rows.length;
      const genomforda = rows.filter((r) => r.genomfort).length;
      const blev_affar = rows.filter((r) => r.blev_affar).length;
      const affarsvarde = rows.reduce((s, r) => s + (r.blev_affar ? r.deal_value : 0), 0);
      const per_fas = {}; for (const g of groups) per_fas[g.fas] = g.moten.length;

      // personer (för filter-dropdown): unika ansvariga i datasetet
      const persSeen = new Map();
      for (const r of rows) if (r.ansvarig_id && !persSeen.has(r.ansvarig_id)) persSeen.set(r.ansvarig_id, r.ansvarig);
      const personer = [...persSeen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "sv"));

      return res.json({
        ok: true,
        groups, per_fas,
        summary: { total, genomforda, blev_affar, affarsvarde, konvertering: total ? Math.round((blev_affar / total) * 100) : 0 },
        personer,
        filtered: !!(fromTs != null || toTs != null || person),
      });
    } catch (e) {
      console.error("[/admin/salj/moten]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Månads-gränser ur "YYYY-MM" (default innevarande månad om ogiltigt).
  function monthBounds(month) {
    const mm = /^\d{4}-\d{2}$/.test(_str(month)) ? _str(month) : null;
    if (!mm) return null;
    const y = parseInt(mm.slice(0, 4), 10), m = parseInt(mm.slice(5, 7), 10) - 1;
    const start = Date.UTC(y, m, 1);
    const end = Date.UTC(y, m + 1, 1);
    const iso = (t) => new Date(t).toISOString();
    const lastDay = new Date(end - 86400000).toISOString().slice(0, 10);
    return { month: mm, start, end, startISO: iso(start), slutISO: iso(end - 86400000), startDay: mm + "-01", slutDay: lastDay };
  }

  // ── GET /admin/salj/budget?month=YYYY-MM — säljare (SalesBudget) + mål + utfall ──
  app.options("/admin/salj/budget", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/salj/budget", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const mb = monthBounds(req.query.month);
      if (!mb) return res.status(400).json({ ok: false, error: "month_krävs", hint: "?month=YYYY-MM" });

      const um = await userMap(), dm = await dealMap();

      // SalesBudgets för månaden: Startdatum inom månaden (en budget per User+månad).
      const allBudgets = await bubbleFindAll("SalesBudget", {}).catch(() => []);
      const monthBudgets = allBudgets.filter((b) => { const t = _ts(b.Startdatum); return t >= mb.start && t < mb.end; });

      // Kundmöten i månaden (utfall) → gruppera per ansvarig
      const [cm] = [await companyMap()];
      const moten = (await loadKundmoten()).map((r) => nMote(r, um, cm, dm))
        .filter((r) => r.datum_ts && r.datum_ts >= mb.start && r.datum_ts < mb.end);
      const utfallByRep = new Map();
      for (const m of moten) {
        if (!m.ansvarig_id) continue;
        if (!utfallByRep.has(m.ansvarig_id)) utfallByRep.set(m.ansvarig_id, { moten: 0, genomforda: 0, blev_affar: 0, affarsvarde: 0, moten_fas: zeroFas() });
        const u = utfallByRep.get(m.ansvarig_id);
        u.moten++; u.moten_fas[m.fas] = (u.moten_fas[m.fas] || 0) + 1;
        if (m.genomfort) u.genomforda++; if (m.blev_affar) { u.blev_affar++; u.affarsvarde += m.deal_value; }
      }

      // Egen-scope: icke-chef ser bara sin egen rad (frontend skickar user_id=Current User).
      const onlyUser = _str(req.query.user_id).trim();
      const budgetsToShow = onlyUser ? monthBudgets.filter((b) => _ref(b.User) === onlyUser) : monthBudgets;

      const rows = budgetsToShow.map((b) => {
        const uid = _ref(b.User);
        const u = utfallByRep.get(uid) || { moten: 0, genomforda: 0, blev_affar: 0, affarsvarde: 0, moten_fas: zeroFas() };
        const malFas = {}; let malMoten = 0;
        for (const f of FASER) { const v = _num(b[FAS_FIELD[f]]); malFas[f] = v; malMoten += v; }
        if (malMoten === 0 && _num(b.total_kundmote) > 0) malMoten = _num(b.total_kundmote);   // äldre poster utan per-fas
        return {
          budget_id: bubbleId(b),
          user_id: uid,
          name: uid ? (um.get(uid) || "") : "(okänd)",
          mal: { moten: malMoten, moten_fas: malFas, affar: _num(b.total_affar), invoice: _num(b.total_invoice) },
          utfall: { moten: u.moten, moten_fas: u.moten_fas, genomforda: u.genomforda, blev_affar: u.blev_affar, affarsvarde: u.affarsvarde },
          active: b.active === true,
          godkand: b["Godkänd"] === true,
          kommentar: _str(b.kommentar),
        };
      }).sort((a, b) => a.name.localeCompare(b.name, "sv"));

      // Users att kunna lägga till som säljare (alla; frontend filtrerar bort redan tillagda)
      const users = [...um.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "sv"));
      const takenIds = new Set(rows.map((r) => r.user_id));

      // grupp-summa
      const tot = rows.reduce((s, r) => ({
        mal_moten: s.mal_moten + r.mal.moten, mal_affar: s.mal_affar + r.mal.affar, mal_invoice: s.mal_invoice + r.mal.invoice,
        moten: s.moten + r.utfall.moten, blev_affar: s.blev_affar + r.utfall.blev_affar, affarsvarde: s.affarsvarde + r.utfall.affarsvarde,
      }), { mal_moten: 0, mal_affar: 0, mal_invoice: 0, moten: 0, blev_affar: 0, affarsvarde: 0 });

      return res.json({ ok: true, month: mb.month, rows, total: tot, users, taken: [...takenIds] });
    } catch (e) {
      console.error("[/admin/salj/budget GET]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/salj/budget — sätt/uppdatera mål för User + månad ──
  // body {user_id, month:YYYY-MM, total_kundmote, total_affar, total_invoice, active?, godkand?, kommentar?, budget_id?}
  app.options("/admin/salj/budget/set", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/salj/budget/set", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubbleCreate || !bubblePatch) return res.status(501).json({ ok: false, error: "write_not_wired" });
      const b = req.body || {};
      const userId = _str(b.user_id).trim();
      const mb = monthBounds(b.month);
      if (!userId) return res.status(400).json({ ok: false, error: "user_id_krävs" });
      if (!mb) return res.status(400).json({ ok: false, error: "month_krävs", hint: "month=YYYY-MM" });

      // Soft admin-guard: bara salesmanager får SÄTTA mål. by_user = Current User (skickas av blocket).
      // UI-gating är primärt; detta blockar casual skrivning från icke-chefs-vyn. Utelämnat by_user
      // (curl/admin) släpps igenom (admin-token räcker). Bekräftat icke-chef → 403.
      const byUser = _str(b.by_user).trim();
      if (byUser) {
        const bu = await bubbleGet("User", byUser).catch(() => null);
        if (bu && bu.salesmanager !== true) return res.status(403).json({ ok: false, error: "ej_salesmanager", hint: "Bara säljchef kan sätta mål." });
      }

      // Per-fas mötesmål: skriv de 5 fälten + total_kundmote = summan (bakåtkomp). Fallback total_kundmote.
      const malFas = (b.mal_fas && typeof b.mal_fas === "object") ? b.mal_fas : null;
      const p = {
        User: userId,
        Startdatum: mb.startISO,
        Slutdatum: mb.slutISO,
        total_affar: _num(b.total_affar),      // Bubble-fält: SalesBudget.total_affar (number, NYTT)
        total_invoice: _num(b.total_invoice),
      };
      if (malFas) { let sum = 0; for (const f of FASER) { const v = _num(malFas[f]); p[FAS_FIELD[f]] = v; sum += v; } p.total_kundmote = sum; }
      else { p.total_kundmote = _num(b.total_kundmote); }
      if (b.active !== undefined) p["active"] = (b.active === true || b.active === "true");
      if (b.godkand !== undefined) p["Godkänd"] = (b.godkand === true || b.godkand === "true");
      if (b.kommentar !== undefined) p["kommentar"] = _str(b.kommentar);

      // Uppdatera befintlig (budget_id el. hitta User+månad) annars skapa
      let budgetId = _str(b.budget_id).trim();
      if (!budgetId) {
        const existing = await bubbleFindAll("SalesBudget", { constraints: [{ key: "User", constraint_type: "equals", value: userId }] }).catch(() => []);
        const hit = existing.find((x) => { const t = _ts(x.Startdatum); return t >= mb.start && t < mb.end; });
        if (hit) budgetId = bubbleId(hit);
      }
      let created = false;
      if (budgetId) { await bubblePatch("SalesBudget", budgetId, p); }
      else { budgetId = await bubbleCreate("SalesBudget", p); created = true; }

      _dCache.ts = 0;   // (deals kan ha ändrats separat; ofarligt)
      return res.json({ ok: true, budget_id: budgetId, created, month: mb.month });
    } catch (e) {
      console.error("[/admin/salj/budget/set]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── NÄSTA STEG-GRINDEN (2026-08-21) ───────────────────────────────────────
  // TREDJE skrivaren av `genomfört`, vid sidan av companies_api (kundkortet) och
  // affar_api (affärsvyn). Utan grind här hade kravet "en genomförd aktivitet måste
  // ha ett nästa steg" varit en UI-artighet i två vyer av tre — mötesbokningsvyn
  // hade fortsatt bocka av möten utan beslut.
  // ⚠️ Bubble-fält: `aktivitet_nasta_steg` (Option Set, samma namn), värden
  // `aktivitet` · `todo` · `avslutat`. Läses tillbaka som sträng ELLER {display}-objekt
  // → `_osStr`. Se [[reference-bubble-option-sets]].
  const NASTA_STEG = ["aktivitet", "todo", "avslutat"];
  const NASTA_FIELD = "aktivitet_nasta_steg";
  const _osStr = (v) => {
    if (v == null) return "";
    if (typeof v === "object") return _str(v.display || v.Display || "");
    return _str(v);
  };
  function _isUnknownField(e, field) {
    const d = e && e.detail;
    if (!d || d.status !== 400) return false;
    const body = typeof d.body === "string" ? d.body : JSON.stringify(d.body || "");
    return body.indexOf("Unrecognized field: " + field) > -1;
  }
  async function _writeOptional(fn, payload, field) {
    if (payload[field] === undefined) return { value: await fn(payload), missing: false };
    try { return { value: await fn(payload), missing: false }; }
    catch (e) {
      if (!_isUnknownField(e, field)) throw e;
      const q = Object.assign({}, payload); delete q[field];
      console.warn("[nasta_steg] fältet saknas på activitet_crm i Bubble — mötet sparas utan det");
      return { value: await fn(q), missing: true };
    }
  }
  // ⚠️ Grinden gäller sparningar som handlar om AVKLARANDET — d.v.s. som rör
  // `genomfört` eller mötesanteckningen. En patch som bara ändrar beskrivning eller
  // fas blockeras INTE; att kräva ett uppföljningsbeslut för ett stavfel vore friktion.
  const NASTA_TRIGGERS = ["genomfört", "mötesantecking"];
  function _nastaStegError(p, cur) {
    const incoming = _str(p[NASTA_FIELD]).trim();
    if (incoming && NASTA_STEG.indexOf(incoming) < 0) {
      return { error: "okänt_nasta_steg", value: incoming, allowed: NASTA_STEG };
    }
    if (!NASTA_TRIGGERS.some((k) => p[k] !== undefined)) return null;
    const curDone = !!(cur && cur["genomfört"] === true);
    const nowDone = (p["genomfört"] !== undefined) ? (p["genomfört"] === true) : curDone;
    if (!nowDone) return null;
    if (incoming) return null;
    // ⚠️ Läs OS-medvetet — `{display}`-objektet hade annars alltid sett ut som ett
    // värde och tyst avaktiverat grinden för rader som saknar beslut.
    const existing = _osStr(cur && cur[NASTA_FIELD]).trim();
    if (existing) return null;
    return { error: "nasta_steg_krävs", allowed: NASTA_STEG,
             hint: "En genomförd aktivitet måste ha ett nästa steg: ny aktivitet, todo eller avslutat." };
  }

  // ── POST /admin/salj/mote/:id/patch — redigera Kundmöte inline i tratten ──
  // Behörighet (soft, UI primärt): by_user måste vara mötets ägare (writer||Created By)
  // ELLER salesmanager. Utelämnat by_user (admin/curl) släpps igenom. Speglar affärsvyns
  // aktivitet-patch (fas→Kundmöte, motesdatum→Datum_bokning, genomfort→genomfört,
  // motesanteckning→mötesantecking). Genomfört=bock → frontend visar Mötesanteckning-fält.
  app.options("/admin/salj/mote/:id/patch", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/salj/mote/:id/patch", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const id = _str(req.params.id); const b = req.body || {};
      const akt = await bubbleGet("activitet_crm", id).catch(() => null);
      if (!akt) return res.status(404).json({ ok: false, error: "möte_not_found" });
      const owner = _ref(akt.writer) || _ref(akt["Created By"]);
      const byUser = _str(b.by_user).trim();
      if (byUser) {
        const bu = await bubbleGet("User", byUser).catch(() => null);
        const isMgr = !!(bu && bu.salesmanager === true);
        if (!isMgr && byUser !== owner) return res.status(403).json({ ok: false, error: "ej_behörig", hint: "Bara mötets ägare eller säljchef kan redigera." });
      }
      const p = {};
      if (b.fas             !== undefined) p["Kundmöte"]       = _str(b.fas) || null;
      if (b.motesdatum      !== undefined) p["Datum_bokning"]  = b.motesdatum ? new Date(_str(b.motesdatum) + "T00:00:00.000Z").toISOString() : null;
      if (b.beskrivning     !== undefined) p["beskrivning"]    = _str(b.beskrivning);
      if (b.genomfort       !== undefined) p["genomfört"]      = (b.genomfort === true || b.genomfort === "true");
      if (b.motesanteckning !== undefined) p["mötesantecking"] = _str(b.motesanteckning);
      if (b.nasta_steg      !== undefined) p[NASTA_FIELD]      = _str(b.nasta_steg).trim() || null;
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "inga_fält" });
      // `akt` är redan hämtad ovan (ägarkontrollen) → ingen extra Bubble-läsning.
      const gErr = _nastaStegError(p, akt);
      if (gErr) return res.status(400).json(Object.assign({ ok: false }, gErr));
      const pw = await _writeOptional((q) => bubblePatch("activitet_crm", id, q), p, NASTA_FIELD);
      const fresh = await bubbleGet("activitet_crm", id).catch(() => null);
      // Läs tillbaka OS-medvetet: null = kunde inte verifieras, inte "saknas".
      const verified = fresh ? (_osStr(fresh[NASTA_FIELD]) === _str(p[NASTA_FIELD] || "")) : null;
      const um = await userMap(), cm = await companyMap(), dm = await dealMap();
      return res.json({ ok: true, id, mote: fresh ? nMote(fresh, um, cm, dm) : null,
                        nasta_steg_field_missing: pw.missing || (verified === false && !!p[NASTA_FIELD]) });
    } catch (e) {
      console.error("[/admin/salj/mote/:id/patch]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  console.log("[salj_api] routes registered (/admin/salj/*)");
}
