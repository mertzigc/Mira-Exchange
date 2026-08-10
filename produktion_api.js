// produktion_api.js
// ─────────────────────────────────────────────────────────────────────────────
// Produktionsmodul (F&E) — Fas 1: dagsvy per kök. Läser MiraOrderRad date-bounded
// på numeriskt leverans_ts (§5.2, undviker 100-cap + opålitliga string-datum), för
// ordrar med orderstatus ∈ {Bekräftad, I produktion}. Grupperar per kök + prep-kategori
// och aggregerar SUM(antal). Design: OFFERT_PRODUKTION_HANDOFF.md §5.
//
// Endpoint:
//   GET /admin/produktion/dag?date=YYYY-MM-DD  → { date, koks:[{kok, prep:[{kategori,total,items}]}], ... }
//   POST /admin/produktion/rad/:id/kok {kok_id} → flytta en orderrad till annat kök (fördelning)
// ─────────────────────────────────────────────────────────────────────────────

export function registerProduktionRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleGet, bubbleId, bubblePatch,
    planningAuthed, planningCors, publicRateLimited, clientIp,
  } = deps;

  const _str = (v) => (v == null ? "" : String(v));
  const _num = (v) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : (v._id || bubbleId(v) || null)));
  const STATUS_PROD = ["Bekräftad", "I produktion"];   // endast dessa produceras
  const CC_TTL = 5 * 60 * 1000;

  // ── caches: ClientCompany-namn + Kok-namn ──
  let _cc = { map: null, ts: 0 };
  async function ccMap() {
    if (_cc.map && (Date.now() - _cc.ts) < CC_TTL) return _cc.map;
    const all = await bubbleFindAll("ClientCompany", {}).catch(() => []);
    const m = new Map();
    for (const c of all) { const id = bubbleId(c); if (id) m.set(id, _str(c.Name_company) || _str(c.name)); }
    _cc = { map: m, ts: Date.now() };
    return m;
  }
  let _kk = { rows: null, ts: 0 };
  async function kokList() {
    if (_kk.rows && (Date.now() - _kk.ts) < CC_TTL) return _kk.rows;
    const all = await bubbleFindAll("Kok", {}).catch(() => []);
    const rows = all.map((k) => ({ id: bubbleId(k), namn: _str(k.namn) || _str(k.Namn) || _str(k.name) || "(kök)", aktiv: (k.aktiv !== false && k.Aktiv !== false) })).filter((k) => k.id);
    rows.sort((a, b) => String(a.namn).localeCompare(String(b.namn), "sv"));
    _kk = { rows, ts: Date.now() };
    return rows;
  }
  async function kokNameMap() { const m = new Map(); for (const k of await kokList()) m.set(k.id, k.namn); return m; }

  function guard(req, res) {
    planningCors && planningCors(req, res);
    if (!planningAuthed(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
    if (publicRateLimited && clientIp && publicRateLimited("prod:" + clientIp(req), 120)) { res.status(429).json({ ok: false, error: "rate_limited" }); return false; }
    return true;
  }

  // ── GET /admin/produktion/dag?date=YYYY-MM-DD ──
  app.options("/admin/produktion/dag", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/produktion/dag", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const date = _str(req.query.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: "date_krävs", hint: "?date=YYYY-MM-DD" });
      const dayStart = new Date(date + "T00:00:00.000Z").getTime();
      const dayEnd = dayStart + 86400000;

      // Ordrar för dagen (numeriskt leverans_ts, pålitligt) + rätt status
      const orders = await bubbleFind("MiraOrder", { constraints: [
        { key: "leverans_ts", constraint_type: "greater than", value: dayStart - 1 },
        { key: "leverans_ts", constraint_type: "less than", value: dayEnd },
        { key: "orderstatus", constraint_type: "in", value: STATUS_PROD },
      ], limit: 300 }).catch(() => []);

      const cm = await ccMap(), km = await kokNameMap();
      const orderMeta = new Map();   // orderId → {ordernr, company, leveranstid, status}
      for (const o of orders) orderMeta.set(bubbleId(o), { ordernr: _str(o.ordernr), company: (cm.get(_ref(o.kundforetag)) || ""), leveranstid: _str(o.leveranstid), status: _str(o.orderstatus) });

      // Alla rader för dagens ordrar
      const allRads = [];
      for (const o of orders) {
        const rads = await bubbleFind("MiraOrderRad", { constraints: [{ key: "order", constraint_type: "equals", value: bubbleId(o) }], limit: 300 }).catch(() => []);
        for (const r of rads) allRads.push(r);
      }

      // Gruppera: kök → prep-kategori → {total, items}
      const KOK_UNASSIGNED = "__none__";
      const koks = new Map();   // kokId → { kok_id, kok_namn, prep: Map(kat → {total, items}), row_count }
      const ensureKok = (kid, knamn) => { if (!koks.has(kid)) koks.set(kid, { kok_id: kid === KOK_UNASSIGNED ? "" : kid, kok_namn: knamn, prep: new Map(), row_count: 0 }); return koks.get(kid); };
      for (const r of allRads) {
        const kid = _ref(r.kok) || KOK_UNASSIGNED;
        const knamn = kid === KOK_UNASSIGNED ? "Ej tilldelat kök" : (km.get(kid) || "(okänt kök)");
        const g = ensureKok(kid, knamn);
        const kat = _str(r.prep_kategori) || "Ej kategoriserad";
        if (!g.prep.has(kat)) g.prep.set(kat, { kategori: kat, total_antal: 0, items: [] });
        const pk = g.prep.get(kat);
        const antal = _num(r.antal);
        const meta = orderMeta.get(_ref(r.order)) || {};
        pk.total_antal += antal;
        pk.items.push({ benamning: _str(r.benamning), antal, enhet: _str(r.enhet), beskrivning: _str(r.beskrivning_long), order_nr: meta.ordernr || "", company: meta.company || "", rad_id: bubbleId(r), kok_id: _ref(r.kok) || "" });
        g.row_count++;
      }

      // Sortera: kök alfabetiskt (Ej tilldelat sist), prep-kategori alfabetiskt
      const koksArr = [...koks.values()].sort((a, b) => {
        if (a.kok_id === "" && b.kok_id !== "") return 1;
        if (b.kok_id === "" && a.kok_id !== "") return -1;
        return String(a.kok_namn).localeCompare(String(b.kok_namn), "sv");
      }).map((g) => ({
        kok_id: g.kok_id, kok_namn: g.kok_namn, row_count: g.row_count,
        prep: [...g.prep.values()].sort((a, b) => String(a.kategori).localeCompare(String(b.kategori), "sv")),
      }));

      return res.json({
        ok: true, date, order_count: orders.length, row_count: allRads.length,
        koks: koksArr,
        koklist: await kokList(),   // för fördelning (flytta rad → annat kök)
      });
    } catch (e) {
      console.error("[/admin/produktion/dag]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/produktion/rad/:id/kok {kok_id} — flytta orderrad till annat kök ──
  app.options("/admin/produktion/rad/:id/kok", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/produktion/rad/:id/kok", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const id = _str(req.params.id);
      const kokId = _str((req.body || {}).kok_id).trim();
      await bubblePatch("MiraOrderRad", id, { kok: kokId || null });
      let kok_namn = "";
      if (kokId) { const km = await kokNameMap(); kok_namn = km.get(kokId) || ""; }
      return res.json({ ok: true, rad_id: id, kok_id: kokId || null, kok_namn });
    } catch (e) {
      console.error("[/admin/produktion/rad/:id/kok]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  console.log("[produktion_api] routes registered (/admin/produktion/*)");
}
