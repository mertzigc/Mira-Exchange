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
    bubbleFind, bubbleFindAll, bubbleGet, bubbleCreate, bubblePatch, bubbleDelete, bubbleId,
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
    // ⚠️ INGET .catch(() => []) — en fallen User-fråga hade blivit "0 kundansvariga"
    // i filtret i st.f. ett fel. Tom data får aldrig bli ett svar.
    const all = await bubbleFindAll("User", {});
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
    const all = await bubbleFindAll("ClientCompany", {});
    const m = new Map();
    for (const c of all) { const id = bubbleId(c); if (id) m.set(id, _str(c.Name_company) || _str(c.name)); }
    _ccCache = { map: m, ts: Date.now() };
    return m;
  }
  // deal id → { titel, value } (bara ~få deals; laddas som helhet)
  let _dCache = { map: null, ts: 0 };
  async function dealMap() {
    if (_dCache.map && (Date.now() - _dCache.ts) < CC_TTL) return _dCache.map;
    const all = await bubbleFindAll("deal", {});
    const m = new Map();
    for (const d of all) { const id = bubbleId(d); if (id) m.set(id, { titel: _str(d.titel) || _str(d.Namn) || _str(d.name) || "(namnlös affär)", value: _num(d.value_brutto), status: _str(d.Status) }); }
    _dCache = { map: m, ts: Date.now() };
    return m;
  }
  const cname = (m, ref) => { const id = _ref(ref); return id ? (m.get(id) || "") : ""; };

  // Alla Kundmöte-aktiviteter (activity_type=Kundmöte). Datumfiltrering client-side
  // (Datum_bokning = datum-sträng; numerisk constraint saknas → filtrera i JS).
  async function loadKundmoten() {
    return bubbleFindAll("activitet_crm", { constraints: [{ key: "activity_type", constraint_type: "equals", value: "Kundmöte" }] });
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
      // Skapad-datum: när mötet REGISTRERADES, inte när det ska hållas. Två helt
      // olika frågor ("hur många möten bokades i augusti" vs "hur många hålls i
      // augusti") och de ska gå att filtrera var för sig.
      skapad: _day(r["Created Date"]),
      skapad_ts: _ts(r["Created Date"]),
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
      // Motiveringen bakom ett avslutat spår. Ren text (inget option set) — men
      // fältet kan saknas i Bubble, då blir den tom och UI:t säger det rakt ut.
      nasta_steg_kommentar: _str(r["nasta_steg_kommentar"]),
      // Markör: cronen har redan skapat en "lägg in mötesanteckning"-todo för raden.
      anteckning_todo_id: _ref(r["anteckning_todo"]),
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
      // Två OBEROENDE datumfilter: `from`/`to` på MÖTESDATUM (när mötet hålls) och
      // `cfrom`/`cto` på SKAPAD-datum (när det bokades). De kan kombineras.
      const dayTs = (v, slutOfDay) => {
        const d = _str(v).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
        return new Date(d + "T00:00:00.000Z").getTime() + (slutOfDay ? 86400000 : 0);
      };
      const person = _str(req.query.person).trim();
      const fromTs = dayTs(req.query.from, false), toTs = dayTs(req.query.to, true);
      const cFromTs = dayTs(req.query.cfrom, false), cToTs = dayTs(req.query.cto, true);

      const [um, cm, dm] = [await userMap(), await companyMap(), await dealMap()];
      let rows = (await loadKundmoten()).map((r) => nMote(r, um, cm, dm));

      // ⚠️ PERSONLISTAN BYGGS UR HELA DATASETET, inte ur den filtrerade mängden.
      // Byggdes den efteråt (som fram till 2026-08-26) kollapsade dropdownen till
      // den valda personen så fort man filtrerade — enda vägen tillbaka var "Rensa".
      // Akut nu när vyn ÖPPNAR med "kundansvarig = jag själv": man hade låsts inne
      // på sig själv utan synlig väg till en kollega.
      const persSeen = new Map();
      for (const r of rows) if (r.ansvarig_id && !persSeen.has(r.ansvarig_id)) persSeen.set(r.ansvarig_id, r.ansvarig);

      if (fromTs != null) rows = rows.filter((r) => r.datum_ts && r.datum_ts >= fromTs);
      if (toTs != null) rows = rows.filter((r) => r.datum_ts && r.datum_ts < toTs);
      // ⚠️ Ett möte UTAN skapad-datum får inte tyst passera ett skapad-filter — då
      // hade "möten skapade i augusti" innehållit rader vi inte vet något om.
      if (cFromTs != null) rows = rows.filter((r) => r.skapad_ts && r.skapad_ts >= cFromTs);
      if (cToTs != null) rows = rows.filter((r) => r.skapad_ts && r.skapad_ts < cToTs);
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

      // personer (för filter-dropdown) — härledd ovan, FÖRE filtren.
      const personer = [...persSeen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "sv"));

      return res.json({
        ok: true,
        groups, per_fas,
        summary: { total, genomforda, blev_affar, affarsvarde, konvertering: total ? Math.round((blev_affar / total) * 100) : 0 },
        personer,
        filtered: !!(fromTs != null || toTs != null || cFromTs != null || cToTs != null || person),
        // Vilka filter som är på — frontenden rubricerar totalen olika beroende på
        // om man tittar på möten som HÅLLS eller möten som SKAPATS i perioden.
        filter: { motesdatum: !!(fromTs != null || toTs != null), skapad: !!(cFromTs != null || cToTs != null) },
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
      const allBudgets = await bubbleFindAll("SalesBudget", {});
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
  // ⚠️ MOTIVERINGEN VID AVSLUTAT SPÅR (2026-08-26). Bubble-fält: `nasta_steg_kommentar`
  // (TEXT, inte option set — läses därför med _str, inte _osStr). "Avslutat" är det
  // enda beslutet som inte lämnar något spår efter sig i systemet: ingen aktivitet,
  // ingen todo. Utan motivering försvinner varför:et med personen som fattade det.
  const KOMM_FIELD = "nasta_steg_kommentar";
  const KOMM_MIN = 3;
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
  // ⚠️ TVÅ valfria Bubble-fält nu (beslutet OCH motiveringen). `bubblePatch` avvisar
  // HELA patchen vid ETT okänt fält — droppas de inte ETT i taget hade ett saknat
  // kommentarsfält tagit med sig beslutet, anteckningen och allt annat i fallet.
  // Matchningen är fortsatt SMAL (400 + exakt fältnamnet); andra okända fält och 5xx
  // måste braka. Returnerar `missing` som ett objekt: { <fält>: true }.
  async function _writeOptional(fn, payload, fields) {
    const list = (Array.isArray(fields) ? fields : [fields]).filter((f) => payload[f] !== undefined);
    const missing = {};
    const q = Object.assign({}, payload);
    for (let i = 0; i <= list.length; i++) {
      try { return { value: await fn(q), missing }; }
      catch (e) {
        const hit = list.find((f) => q[f] !== undefined && _isUnknownField(e, f));
        if (!hit) throw e;
        missing[hit] = true; delete q[hit];
        console.warn("[nasta_steg] fältet " + hit + " saknas på activitet_crm i Bubble — raden sparas utan det");
      }
    }
    throw new Error("write_failed_after_field_drop");
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
    // ⚠️ Kravet hänger på att `avslutat` SKRIVS — inte på om sparningen råkar röra
    // avklarandet. Låg kontrollen efter NASTA_TRIGGERS-utgången nedan hade en patch
    // som BARA sätter nasta_steg=avslutat sluppit igenom utan motivering.
    if (incoming === "avslutat") {
      const komm = _str(p[KOMM_FIELD]).trim();
      if (komm.length < KOMM_MIN) {
        return { error: "avslut_kommentar_krävs", min: KOMM_MIN,
                 hint: "Skriv varför spåret avslutas — minst " + KOMM_MIN + " tecken." };
      }
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
      if (b.nasta_steg_kommentar !== undefined) p[KOMM_FIELD]  = _str(b.nasta_steg_kommentar).trim() || null;
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "inga_fält" });
      // `akt` är redan hämtad ovan (ägarkontrollen) → ingen extra Bubble-läsning.
      const gErr = _nastaStegError(p, akt);
      if (gErr) return res.status(400).json(Object.assign({ ok: false }, gErr));
      const pw = await _writeOptional((q) => bubblePatch("activitet_crm", id, q), p, [NASTA_FIELD, KOMM_FIELD]);
      const fresh = await bubbleGet("activitet_crm", id).catch(() => null);
      // Läs tillbaka OS-medvetet: null = kunde inte verifieras, inte "saknas".
      const verified = fresh ? (_osStr(fresh[NASTA_FIELD]) === _str(p[NASTA_FIELD] || "")) : null;
      // ⚠️ Motiveringen är TEXT → _str, inte _osStr. Läses den med _osStr blir en sparad
      // sträng jämförd som objekt och verifieringen ljuger.
      const kVerified = fresh ? (_str(fresh[KOMM_FIELD]) === _str(p[KOMM_FIELD] || "")) : null;
      const um = await userMap(), cm = await companyMap(), dm = await dealMap();
      return res.json({ ok: true, id, mote: fresh ? nMote(fresh, um, cm, dm) : null,
                        nasta_steg_field_missing: !!pw.missing[NASTA_FIELD] || (verified === false && !!p[NASTA_FIELD]),
                        // ⚠️ Egen flagga: motiveringen kan gå förlorad utan att beslutet gör det.
                        // Slås de ihop säger UI:t "beslutet sparades inte" när det gjorde det.
                        avslut_kommentar_field_missing: !!pw.missing[KOMM_FIELD] || (kVerified === false && !!p[KOMM_FIELD]) });
    } catch (e) {
      console.error("[/admin/salj/mote/:id/patch]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });


  // ── POST /salj/anteckning-todo/cron — automatisk todo för passerade möten ────
  // MÅL: ingen ska missa att lägga in mötesanteckningar. Ett Kundmöte vars datum
  // passerat, som inte är avbockat och saknar anteckning, får en Todo tilldelad
  // mötets ÄGARE (`writer`).
  //
  // ⚠️ LIGGER MEDVETET UTANFÖR `/admin/salj`-prefixet. Det prefixet är undantaget
  // från index.js globala `requireApiKey` och grindas bara av PLANNING_ADMIN_TOKEN
  // — som ligger i KLARTEXT i Bubble-HTML-blocket. En skrivande massjobbs-endpoint
  // bakom den token hade kunnat triggas från vilken webbläsare som helst. Här
  // gäller `x-api-key` (MIRA_RENDER_API_KEY), samma grind som /fortnox/cron/v1.
  //
  // ⚠️ IDEMPOTENS hänger HELT på Bubble-fältet `anteckning_todo` (Todo-ref) på
  // activitet_crm. Saknas det skapas samma todo om igen VARJE natt, i allas
  // att-göra-listor. Därför fail-closed: går markören inte att skriva rullas todon
  // tillbaka och hela körningen avbryts med 500 — en högljudd stopp är oändligt
  // mycket bättre än N dubbletter per natt.
  //
  // Query: ?dry=1 (skriv inget) · ?days=14 (hur långt bak) · ?grace=1 (dygn efter
  // mötet innan vi tjatar) · ?limit=50 (tak per körning, aldrig tyst avhugget).
  const TODO_FIELD = "anteckning_todo";
  const TODO_DAYS = 14, TODO_GRACE = 1, TODO_LIMIT = 50;
  app.post("/salj/anteckning-todo/cron", async (req, res) => {
    try {
      if (!bubbleCreate || !bubblePatch) return res.status(501).json({ ok: false, error: "write_not_wired" });
      const q = req.query || {};
      const dry = _str(q.dry) === "1";
      const pInt = (v, d, min, max) => { const n = parseInt(_str(v), 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
      const days  = pInt(q.days,  TODO_DAYS,  1, 365);
      const grace = pInt(q.grace, TODO_GRACE, 0, 30);
      const limit = pInt(q.limit, TODO_LIMIT, 1, 500);

      const now = Date.now();
      const endTs   = now - grace * 86400000;   // mötet måste ligga FÖRE denna
      const startTs = now - days  * 86400000;   // ...men inte längre bak än denna
      const iso = (t) => new Date(t).toISOString();

      // ⚠️ FÖNSTRET ÄR ETT BACKFILL-SKYDD, inte en optimering. Utan bakre gräns hade
      // första körningen skapat en todo för VARJE gammalt oavbockat möte i basen.
      // ⚠️ Constraints = SLUG-form (`datum_bokning_date`), verifierad i index.js.
      // `activity_type` constraintas exakt som loadKundmoten redan gör i skarp drift.
      // ⚠️ Bubble saknar >= och <= — inklusivt intervall görs med exklusiva gränser.
      // ⚠️ INGET .catch(() => []) — en fallen fråga får aldrig bli "inga eftersläpande möten".
      const rows = await bubbleFindAll("activitet_crm", { constraints: [
        { key: "activity_type",      constraint_type: "equals",       value: "Kundmöte" },
        { key: "datum_bokning_date", constraint_type: "greater than", value: iso(startTs) },
        { key: "datum_bokning_date", constraint_type: "less than",    value: iso(endTs) },
      ] });

      const kandidater = [];
      for (const r of rows) {
        if (r["genomfört"] === true) continue;                       // redan avbockat
        if (_str(r["mötesantecking"]).trim()) continue;              // anteckning finns (OBS stavningen)
        if (_ref(r[TODO_FIELD])) continue;                           // todo redan skapad
        kandidater.push(r);
      }
      // ⚠️ `writer` är enda användbara ägarfältet — "Created By" är API-nyckelns user
      // och en todo tilldelad den når INGEN. Rader utan writer hoppas över och
      // RAPPORTERAS; ett tyst bortfall hade sett ut som "inga eftersläpande möten".
      const utan_agare = kandidater.filter((r) => !_ref(r.writer));
      const kan = kandidater.filter((r) => _ref(r.writer));
      const capped = kan.length > limit;
      const batch = kan.slice(0, limit);

      const cm = await companyMap();
      const plan = batch.map((r) => {
        const co = cname(cm, r.company), dag = _day(r["Datum_bokning"]);
        return {
          aktivitet_id: bubbleId(r), user_id: _ref(r.writer), company_id: _ref(r.company) || null,
          company: co, motesdatum: dag,
          titel: "Mötesanteckning saknas — " + (co || "(företag saknas)"),
        };
      });
      if (dry) {
        return res.json({ ok: true, dry: true, fonster: { fran: iso(startTs), till: iso(endTs), days, grace },
                          lasta: rows.length, kandidater: kandidater.length, skulle_skapas: plan.length,
                          utan_agare: utan_agare.length, utan_agare_ids: utan_agare.map(bubbleId).slice(0, 20),
                          capped, kvar: capped ? (kan.length - limit) : 0, limit, rader: plan });
      }

      const skapade = [];
      for (const item of plan) {
        const tp = {
          "Titel": item.titel,
          "Beskrivning": "Kundmötet " + (item.motesdatum || "(utan datum)") + (item.company ? (" med " + item.company) : "") +
                         " har passerat utan mötesanteckning. Fyll i anteckningen och sätt nästa steg i mötestratten.",
          "Status": "Pågående",                        // status_reminder-OS, verifierat värde
          // ⚠️ MINST ETT FRAMTIDA DATUM krävs — kundkortets levande-panel räknar
          // framtida start ELLER slut. Utan det hade todon varit osynlig som planerad.
          "Starttid": iso(now),
          "Sluttid": iso(now + 2 * 86400000),
          "user": item.user_id,                        // Tilldela = mötets ägare
        };
        if (item.company_id) tp["Företag"] = item.company_id;
        // ⚠️ Kategori sätts INTE: den går inte att härleda ur mötet, och ett gissat
        // Category-värde avvisas av Bubble (400) eller ljuger i datan.
        const todoId = await bubbleCreate("Todo", tp);
        if (!todoId) return res.status(500).json({ ok: false, error: "todo_utan_id", aktivitet_id: item.aktivitet_id, skapade });
        try {
          await bubblePatch("activitet_crm", item.aktivitet_id, { [TODO_FIELD]: todoId });
        } catch (e) {
          let rollback = "bubbleDelete ej inkopplad — todon ligger kvar och måste tas bort manuellt";
          if (bubbleDelete) {
            try { await bubbleDelete("Todo", todoId); rollback = "todon raderad"; }
            catch (de) { rollback = "todon kunde INTE raderas: " + (de && de.message); }
          }
          console.error("[salj/anteckning-todo] markören gick inte att skriva — avbryter", e && e.message);
          return res.status(500).json({
            ok: false, error: "anteckning_todo_markor_misslyckades", todo_id: todoId,
            aktivitet_id: item.aktivitet_id, rollback, skapade,
            hint: "Fältet `anteckning_todo` (typ Todo) saknas troligen på activitet_crm i Bubble. Utan markören skapas samma todo varje natt — körningen avbröts med flit.",
            detalj: (e && e.message) || String(e),
          });
        }
        skapade.push({ todo_id: todoId, aktivitet_id: item.aktivitet_id, user_id: item.user_id, titel: item.titel });
      }

      return res.json({ ok: true, dry: false, fonster: { fran: iso(startTs), till: iso(endTs), days, grace },
                        lasta: rows.length, kandidater: kandidater.length, skapade: skapade.length,
                        utan_agare: utan_agare.length, utan_agare_ids: utan_agare.map(bubbleId).slice(0, 20),
                        capped, kvar: capped ? (kan.length - limit) : 0, limit, rader: skapade });
    } catch (e) {
      console.error("[/salj/anteckning-todo/cron]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  console.log("[salj_api] routes registered (/admin/salj/* + /salj/anteckning-todo/cron)");
}
