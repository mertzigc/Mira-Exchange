// behovsanalys_api.js
// ─────────────────────────────────────────────────────────────────────────────
// Behovsanalys — säljstödets snabbchecklista som ligger till grund för offert.
// Kan hakas på både en Deal (från affärsvyn) och en ClientCompany (från kortet).
// DI-mönster som affar_api.js / companies_api.js.
//
// Bubble-typ som krävs: `BehovsAnalys` med fälten:
//   clientcompany  (ClientCompany)  obligatoriskt
//   deal           (Deal)           nullable — sätts när skapad från affär
//   writer         (User)           senast sparad av
//   data           (text)           JSON-blob med SCHEMA nedan (~2 KB)
//   updated_at     (date)           senaste patch
//   status         (text)           "Utkast" | "Klar"
//
// ⚠️ Varför JSON i st.f. 22 separata Bubble-fält:
//   • Snabbversionens fält kan ändras utan schema-migration.
//   • Djupversionen (senare) staplar bara mer nycklar i samma blob.
//   • Om vi någon gång behöver rapportera på enskilda fält (kvm-fördelning,
//     genomsnittlig arbetsplatstäthet etc.) bryter vi ut just de fälten då.
//   • Rader läses ändå ur cachen per-kort/affär, aldrig som sökbar tabell.
//
// Endpoints (alla x-admin-token-grindade):
//   GET  /admin/behovsanalys/schema           → snabbversionens fält (UI läser härifrån)
//   GET  /admin/behovsanalys/for-deal/:id     → senaste analys för affären (eller null)
//   GET  /admin/behovsanalys/for-company/:id  → alla analyser för kunden, nyast först
//   GET  /admin/behovsanalys/:id              → en specifik analys (raw + parsed data)
//   POST /admin/behovsanalys/create           → skapa ny (body: clientcompany_id, deal_id?, by_user, data, status?)
//   POST /admin/behovsanalys/:id/patch        → uppdatera (body: data?, status?, by_user)
// ─────────────────────────────────────────────────────────────────────────────

export function registerBehovsanalysRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleGet, bubbleId, bubblePatch, bubbleCreate,
    planningAuthed, planningCors,
  } = deps;

  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : (v._id || bubbleId(v) || null)));
  const _day = (v) => (v ? _str(v).slice(0, 10) : "");
  const _ts  = (v) => { if (!v) return 0; const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };

  function guard(req, res) {
    planningCors && planningCors(req, res);
    if (!planningAuthed(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCHEMA — snabbversionen (~10 min). UI:t läser detta för att rita fälten
  // så vi kan lägga till/ändra frågor utan att röra HTML-blocken.
  // ─────────────────────────────────────────────────────────────────────────
  // ⚠️ Nya fält: LÄGG TILL SIST. Frontenden kan visa okända nycklar från
  // gammal data (om vi någon gång ändrar id:t) men den kan inte gissa NYA
  // fälts placering. Byt aldrig ett `id` som redan finns i skarp data —
  // migrera i så fall med en engångs-script.
  const SCHEMA = [
    { section: "Kunden", fields: [
      { id: "fastighetslage",        label: "Fastighetsläge",              type: "select", options: ["Egen fastighet", "Hyresgäst", "Coworking", "Delad lokal"] },
      { id: "medarbetare_totalt",    label: "Medarbetare totalt (bolaget)", type: "number" },
      { id: "medarbetare_kontor",    label: "Medarbetare på detta kontor",  type: "number" },
    ]},
    { section: "Lokalen", fields: [
      { id: "kvm",                   label: "Yta (kvm)",                   type: "number" },
      { id: "arbetsplatser",         label: "Antal arbetsplatser",         type: "number" },
      { id: "motesrum",              label: "Antal mötesrum",              type: "number" },
    ]},
    { section: "Närvaromönster", fields: [
      { id: "dagar_per_vecka",       label: "Dagar på plats / vecka (snitt)", type: "number", min: 0, max: 7 },
      { id: "peak_dagar",            label: "Peak-dagar",                    type: "multi", options: ["Mån", "Tis", "Ons", "Tor", "Fre"] },
      { id: "kontor_syfte",          label: "Kontorets primära syfte",        type: "multi", options: ["Samarbete", "Koncentration", "Kundmöten", "Rekrytering", "Kultur & community"] },
    ]},
    { section: "Erbjudande — behov idag / önskat", fields: [
      { id: "food",                  label: "Food & Event",                type: "multi", options: ["Frukost", "Frukt & grönt", "Fika", "Lunch", "Kaffe & dryck", "Middagar / events"] },
      { id: "housekeeping",          label: "Housekeeping",                type: "multi", options: ["Städ (löpande)", "Storstädning", "Fönsterputs", "Textilrengöring", "Golvvård", "Sopor & återvinning", "Växter"] },
      { id: "sp",                    label: "Service & People",            type: "multi", options: ["Reception", "Kontorsvärd", "Vaktmästare / handyman", "Mötesbokning", "IT-support (basic)", "Postgång & paket"] },
    ]},
    { section: "Frekvenser", fields: [
      { id: "stad_frekvens",         label: "Städ-frekvens (önskad)",      type: "select", options: ["Daglig", "3 ggr/vecka", "2 ggr/vecka", "1 gång/vecka", "Varannan vecka", "Vid behov"] },
      { id: "events_per_ar",         label: "Antal events / år (grovt)",    type: "number" },
    ]},
    { section: "Nuläge & smärta", fields: [
      { id: "nuvarande_leverantor",  label: "Nuvarande leverantör(er)",    type: "text" },
      { id: "smarta",                label: "Största smärtan i nuläget",   type: "textarea", rows: 3 },
    ]},
    { section: "Ekonomi & avtalsform", fields: [
      { id: "budget_typ",            label: "Budget-modell",               type: "select", options: ["Rambelopp / månad", "Per medarbetare / månad", "Öppet"] },
      { id: "budget_belopp",         label: "Budget-belopp (kr)",           type: "number" },
      { id: "avtalsform",            label: "Önskad avtalsform",           type: "select", options: ["Fast abonnemang", "Hybrid", "Timme-baserat", "Rent event"] },
      { id: "startdatum",            label: "Önskat startdatum",           type: "date" },
    ]},
    { section: "Beslutsprocess", fields: [
      { id: "beslutsfattare",        label: "Beslutsfattare (namn + roll)", type: "text" },
      { id: "deadline",              label: "Deadline för beslut",         type: "date" },
    ]},
  ];
  // Alla giltiga id:n — ignorera okända i inkommande data-blob (skydd mot
  // klient-skräp; men vi kastar aldrig — bara tystar bort dem).
  const FIELD_IDS = new Set();
  const FIELD_TYPES = {};
  const FIELD_OPTS  = {};
  for (const sec of SCHEMA) for (const f of sec.fields) {
    FIELD_IDS.add(f.id); FIELD_TYPES[f.id] = f.type;
    if (f.options) FIELD_OPTS[f.id] = new Set(f.options);
  }

  // Sanera inkommande data-blob mot schemat. Okända fält droppas TYST (de
  // kunde annars grumla djup-versionen senare); ogiltiga option-set-värden
  // droppas också tyst (skulle Bubble-native aldrig ha vetat om ändå).
  function _sanitize(raw) {
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!FIELD_IDS.has(k)) continue;
      const t = FIELD_TYPES[k];
      if (v == null || v === "") continue;
      if (t === "number") { const n = Number(v); if (Number.isFinite(n)) out[k] = n; continue; }
      if (t === "date")   { out[k] = _day(v); continue; }
      if (t === "multi")  {
        const arr = Array.isArray(v) ? v : [v];
        const allowed = FIELD_OPTS[k];
        const kept = arr.map(_str).map((s) => s.trim()).filter((s) => s && (!allowed || allowed.has(s)));
        if (kept.length) out[k] = kept;
        continue;
      }
      if (t === "select") { const s = _str(v).trim(); const allowed = FIELD_OPTS[k]; if (s && (!allowed || allowed.has(s))) out[k] = s; continue; }
      out[k] = _str(v);   // text / textarea
    }
    return out;
  }

  // Räkna hur många FÄLT (av totalt) som är ifyllda → "3 av 22 klara"-badge.
  function _completeness(data) {
    let filled = 0, total = 0;
    for (const id of FIELD_IDS) {
      total++;
      const v = data ? data[id] : undefined;
      if (v == null) continue;
      if (Array.isArray(v)) { if (v.length) filled++; continue; }
      if (String(v).trim() !== "") filled++;
    }
    return { filled, total, pct: total ? Math.round((filled / total) * 100) : 0 };
  }

  // Normalisera en rå Bubble-post → svarsformat. `data`-blobben JSON-parsas.
  // ⚠️ INGEN `.catch(() => "")` på JSON.parse — en trasig blob är ett fel
  // vi vill se, inte tolka som "tomt formulär". Sätt data:{}, parse_error:true.
  function nBA(r) {
    let data = {}, parseErr = false;
    try { if (r.data) data = JSON.parse(r.data); }
    catch (e) { parseErr = true; console.warn("[behovsanalys " + bubbleId(r) + "] data JSON parse error:", e && e.message); }
    return {
      id: bubbleId(r),
      clientcompany_id: _ref(r.clientcompany) || null,
      deal_id: _ref(r.deal) || null,
      writer_id: _ref(r.writer) || null,
      status: _str(r.status) || "Utkast",
      updated_at: _day(r.updated_at) || _day(r["Modified Date"]) || _day(r["Created Date"]),
      created_at: _day(r["Created Date"]),
      data,
      parse_error: parseErr,
      completeness: _completeness(data),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /admin/behovsanalys/schema
  // ─────────────────────────────────────────────────────────────────────────
  app.options("/admin/behovsanalys/schema", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/behovsanalys/schema", (req, res) => {
    if (!guard(req, res)) return;
    return res.json({ ok: true, sections: SCHEMA, total_fields: FIELD_IDS.size });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /admin/behovsanalys/for-deal/:id — senaste analys på affären (eller null)
  // ─────────────────────────────────────────────────────────────────────────
  app.options("/admin/behovsanalys/for-deal/:id", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/behovsanalys/for-deal/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const rows = await bubbleFindAll("BehovsAnalys", { constraints: [{ key: "deal", constraint_type: "equals", value: id }] });
      const items = (rows || []).map(nBA).sort((a, b) => _ts(b.updated_at) - _ts(a.updated_at));
      return res.json({ ok: true, deal_id: id, latest: items[0] || null, count: items.length });
    } catch (e) {
      console.error("[/admin/behovsanalys/for-deal/:id]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /admin/behovsanalys/for-company/:id — alla analyser för kunden
  // ─────────────────────────────────────────────────────────────────────────
  app.options("/admin/behovsanalys/for-company/:id", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/behovsanalys/for-company/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const rows = await bubbleFindAll("BehovsAnalys", { constraints: [{ key: "clientcompany", constraint_type: "equals", value: id }] });
      const items = (rows || []).map(nBA).sort((a, b) => _ts(b.updated_at) - _ts(a.updated_at));
      return res.json({ ok: true, company_id: id, items, count: items.length, latest: items[0] || null });
    } catch (e) {
      console.error("[/admin/behovsanalys/for-company/:id]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /admin/behovsanalys/:id
  // ─────────────────────────────────────────────────────────────────────────
  app.options("/admin/behovsanalys/:id", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/behovsanalys/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const r = await bubbleGet("BehovsAnalys", id);
      if (!r) return res.status(404).json({ ok: false, error: "not_found" });
      return res.json({ ok: true, item: nBA(r) });
    } catch (e) {
      console.error("[/admin/behovsanalys/:id]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /admin/behovsanalys/create — body: {clientcompany_id, deal_id?, by_user?, data?, status?}
  // ⚠️ INGA `.catch(() => "")` — låt Bubble-fel braka. Typen kan saknas i
  // Bubble (första deploy) → 400 Unrecognized field: writer OR type. Svaret
  // säger då direkt vad som är fel.
  // ─────────────────────────────────────────────────────────────────────────
  app.options("/admin/behovsanalys/create", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/behovsanalys/create", async (req, res) => {
    if (!guard(req, res)) return;
    if (!bubbleCreate) return res.status(501).json({ ok: false, error: "create_not_wired" });
    const b = req.body || {};
    const ccId = _str(b.clientcompany_id).trim();
    if (!ccId) return res.status(400).json({ ok: false, error: "clientcompany_id_krävs" });
    try {
      const cleanData = _sanitize(b.data);
      const payload = {
        "clientcompany": ccId,
        "data": JSON.stringify(cleanData),
        "updated_at": new Date().toISOString(),
        "status": _str(b.status) || "Utkast",
      };
      const dealId = _str(b.deal_id).trim(); if (dealId) payload["deal"] = dealId;
      const byUser = _str(b.by_user).trim();  if (byUser) payload["writer"] = byUser;
      const newId = await bubbleCreate("BehovsAnalys", payload);
      // Läs tillbaka så svaret bär den normaliserade formen. En misslyckad
      // läsning betyder inte att raden inte skapades → svara ok + item:null
      // med en hint, aldrig med felinformation som ser ut som en 500a.
      const fresh = await bubbleGet("BehovsAnalys", newId).catch(() => null);
      return res.json({ ok: true, id: newId, item: fresh ? nBA(fresh) : null,
        completeness: _completeness(cleanData) });
    } catch (e) {
      console.error("[/admin/behovsanalys/create]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null,
        hint: "Kontrollera att Bubble-typen BehovsAnalys finns med fälten: clientcompany, deal, writer, data, updated_at, status." });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /admin/behovsanalys/:id/patch — body: {data?, status?, by_user?}
  // ⚠️ MERGAR data-fältet mot befintlig blob — annars kan en partiell
  // formulär-save tyst radera fält som ligger på en annan sektion. Klienten
  // ska kunna skicka bara "detta ändrades" utan att förlora resten.
  // ─────────────────────────────────────────────────────────────────────────
  app.options("/admin/behovsanalys/:id/patch", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/behovsanalys/:id/patch", async (req, res) => {
    if (!guard(req, res)) return;
    if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    const b = req.body || {};
    try {
      const cur = await bubbleGet("BehovsAnalys", id);
      if (!cur) return res.status(404).json({ ok: false, error: "not_found" });
      const payload = { "updated_at": new Date().toISOString() };
      const byUser = _str(b.by_user).trim(); if (byUser) payload["writer"] = byUser;
      if (b.status !== undefined) payload["status"] = _str(b.status) || "Utkast";
      if (b.data !== undefined) {
        let old = {}; try { if (cur.data) old = JSON.parse(cur.data); } catch (_) { old = {}; }
        const clean = _sanitize(b.data);
        // ⚠️ FULL merge — nya nycklar vinner, oförändrade behålls. Ett fält
        // som klienten uttryckligen NOLLADE måste skickas som "" eller [] och
        // sanitize:as bort → försvinner ur bloben. Det är avsiktligt.
        const merged = Object.assign({}, old, clean);
        payload["data"] = JSON.stringify(merged);
      }
      await bubblePatch("BehovsAnalys", id, payload);
      const fresh = await bubbleGet("BehovsAnalys", id).catch(() => null);
      return res.json({ ok: true, id, item: fresh ? nBA(fresh) : null });
    } catch (e) {
      console.error("[/admin/behovsanalys/:id/patch]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  console.log("[behovsanalys_api] routes registered (/admin/behovsanalys/*)");
}
