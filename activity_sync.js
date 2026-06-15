// ════════════════════════════════════════════════════════════════════════════
// activity_sync.js — Materialisering till den enhetliga kalendertypen `Activity`
// ────────────────────────────────────────────────────────────────────────────
// Render håller ALL intelligens (inga Bubble backend-workflows). Två vägar håller
// Activity i synk med källorna:
//   • write-through : skapa-förfrågan / kalender-popup anropar upsert* direkt.
//   • modified-sweep: nattlig syncForSource() läser källor (ev. Modified Date ≥ x)
//                     och upsertar Activity. Backfill = sweep med fullt fönster.
//
// Diff-läge är DEFAULT (skriver INGENTING). mode:"write" krävs explicit.
// Upsert-nyckel = Activity.source_id (källans unique id, eller "tengella:<EventId>").
//
// VERIFIERA dessa fältnamn mot din Bubble-schema (case-sensitivt). Avviker något
// → rätta HÄR, inget annat behöver röras.
// ════════════════════════════════════════════════════════════════════════════

export const ACTIVITY_CONFIG = {
  ACTIVITY_TYPE: "Activity",

  // Källtyper
  COMISSION_TYPE: "Comission",
  MATTER_TYPE:    "Matter",
  TODO_TYPE:  "Todo",            // datatypen (f.d. "Kom ihåg - Remember") döptes om till Todo 2026-06-15
  TENGELLA_CUSTOMER_TYPE: "TengellaCustomer",

  // ActivityType-värden (option set) — exakt som inlagda i Bubble
  AT_BOKNING:     "Bokning",
  AT_ARENDE:      "Ärende",
  AT_TODO:    "Kom ihåg",        // OBS: ActivityType-OPTION SET-värdet (oförändrat i Bubble). Vill du att det också ska heta "Todo": byt option set-värdet + säg till.
  AT_HOUSEKEEPING:"Housekeeping",

  // Comission-fält
  C_TITLE:   "commission_title",
  C_DELIVERY:"delivery_date",
  C_END:     "Slutdatum",           // bekräftat mot /forfragan/schema 2026-06-15 (EJ "delivery_date_end" — fanns aldrig → commission-Activities fick noll-längd)
  C_CATEGORY:"Category",
  C_STATUS:  "commission_status",
  C_COMPANY: "Company",
  C_DESC:    "Description",
  C_ADDRESS: "delivery_address",

  // Matter-fält
  M_TITLE:   "Rubrik",              // bekräftat (emailer.js)
  M_CATEGORY:"Category",            // Christian la till samma 4-familjs-Category på Matter 2026-06-15
  M_STATUS:  "status",
  M_COMPANY: "Kundföretag",
  M_DESC:    "Beskrivning",
  M_CLOSED:  "closed_date",
  M_STATUS_DONE: "Avslutat",        // status-värde som triggar closed_date

  // Todo-fält (datatyp Todo) — bekräftade mot Bubble-schemat 2026-06-15
  TODO_TITLE:   "Titel",
  TODO_START:   "Starttid",
  TODO_END:     "Sluttid",
  TODO_CATEGORY:"Kategori",       // typ = Category option set (4-familj) → colorFor funkar
  TODO_STATUS:  "Status",         // typ = status_reminder option set
  TODO_COMPANY: "Företag",        // typ = ClientCompany
  TODO_THREAD:  "Tråd",           // list of texts (för popup-kommentarer senare)

  // ClientCompany-fält på Activity — EXAKT casing krävs vid skrivning (Data types: "Clientcompany").
  A_COMPANY: "Clientcompany",

  // Tengella
  TENGELLA_TIMETABLE_PATH: "/v2/TimeTableEvent",
  TC_CUSTOMER_ID: "tengella_customer_id",
  TC_COMPANY:     "company",
};

// Category → color_hex (Christians nuvarande koder)
export const CATEGORY_COLORS = {
  "Food & Event":            "#F47B30",
  "Housekeeping":            "#4C9AFF",
  "Staff":                   "#9F77DD",
  "Other facility services": "#4CAF7D",
};
export const FALLBACK_COLOR = "#888888";

export function createActivityEngine(deps) {
  const {
    bubbleFindOne, bubbleFindAll, bubbleCreate, bubblePatch, bubbleDelete, bubbleGet, bubbleId,
    tengella,                 // { login, fetch }  (fetch = tengellaFetch)
    helpers,                  // { toBubbleDate }
    constants = {},           // { TENGELLA_DEFAULT_ORGNO }
    config = ACTIVITY_CONFIG,
    log = (...a) => console.log("[activity_sync]", ...a),
  } = deps;

  const C = config;
  const toBubbleDate = helpers.toBubbleDate;
  const orgNo = constants.TENGELLA_DEFAULT_ORGNO;

  const colorFor = (cat) => CATEGORY_COLORS[cat] || FALLBACK_COLOR;
  // Skriv bara giltiga Activity.Category-värden (4-familj). Okänt/skräp → null (grå),
  // annars 400 "could not parse this as a Category" på enstaka rader med dålig källdata.
  const knownCat = (cat) => (cat && CATEGORY_COLORS[cat] ? cat : null);
  const idOf     = (x) => (typeof x === "string" ? x : bubbleId(x));   // refs kan vara id-sträng eller objekt
  const str      = (v) => (v === null || v === undefined ? null : String(v));
  const num      = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

  // Fält som jämförs vid sweep för noop-detektering (skriv bara vid faktisk ändring).
  const COMPARE = ["ActivityType", "Title", "Startdatum", "Slutdatum", "Category", "color_hex",
                   "status", C.A_COMPANY, "Beskrivning", "creator_company"];

  // Todo filtreras på skaparens företag (kund-läge + Carotte) ELLER Företag (CRM mot kund).
  // Därför lagras BÅDA: Clientcompany = Todo.Företag, creator_company = Creator-userns Company.
  const _userCoCache = new Map();
  async function resolveCreatorCompany(r) {
    const uid = r["Created By"] || r.Creator || (r.user ? idOf(r.user) : null) || null;
    if (!uid) return null;
    const key = String(uid);
    if (_userCoCache.has(key)) return _userCoCache.get(key);
    let co = null;
    try { const u = await bubbleGet("User", key); co = u ? (idOf(u.Company) || null) : null; } catch (_) { /* lämna null */ }
    _userCoCache.set(key, co);
    return co;
  }
  const COMPARE_TENGELLA = ["ActivityType", "Title", "Startdatum", "Slutdatum", "Category",
                   "color_hex", C.A_COMPANY, "tengella_employee_name", "tengella_region_name",
                   "tengella_project_name", "tengella_supervisor_name"];

  function changed(existing, payload, fields) {
    if (!existing) return true;
    for (const k of fields) {
      const a = existing[k] === undefined ? null : existing[k];
      const b = payload[k]  === undefined ? null : payload[k];
      if (String(a ?? "") !== String(b ?? "")) return true;
    }
    return false;
  }

  // ── Generisk upsert på source_id ──────────────────────────────────────────
  async function upsertBySourceId(sourceId, payload, { write, compareFields }) {
    payload.source_id = sourceId;
    const existing = await bubbleFindOne(C.ACTIVITY_TYPE, [
      { key: "source_id", constraint_type: "equals", value: sourceId },
    ]);

    if (existing) {
      const id = bubbleId(existing);
      if (!changed(existing, payload, compareFields)) return { mode: "noop", id };
      if (write) await bubblePatch(C.ACTIVITY_TYPE, id, payload);
      return { mode: "update", id };
    }
    let id = null;
    if (write) id = await bubbleCreate(C.ACTIVITY_TYPE, payload);
    return { mode: "create", id };
  }

  // ── Index-baserad upsert (för sweeps) ──────────────────────────────────────
  // Läs ALLA Activity en gång → Map(source_id → rad). Då slipper vi en
  // bubbleFindOne per källrad (N+1, långsamt + rate-limit) och frågar aldrig
  // Bubble på source_id (det anropet failade när fältet saknades i live).
  async function loadActivityIndex() {
    const all = await bubbleFindAll(C.ACTIVITY_TYPE, {});
    const map = new Map();
    for (const a of all) {
      const sid = a.source_id;
      if (sid) map.set(String(sid), a);
    }
    return map;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function upsertViaIndex(index, sourceId, payload, { write, compareFields, throttleMs = 0 }) {
    payload.source_id = sourceId;
    const key = String(sourceId);
    const existing = index.get(key) || null;
    if (existing) {
      const id = bubbleId(existing);
      if (!changed(existing, payload, compareFields)) return { mode: "noop", id };
      if (write) { await bubblePatch(C.ACTIVITY_TYPE, id, payload); if (throttleMs) await sleep(throttleMs); }
      index.set(key, { ...existing, ...payload });
      return { mode: "update", id };
    }
    let id = null;
    if (write) { id = await bubbleCreate(C.ACTIVITY_TYPE, payload); if (throttleMs) await sleep(throttleMs); }
    index.set(key, { ...payload, _id: id });   // dedup inom samma körning
    return { mode: "create", id };
  }

  // ── Mappers ───────────────────────────────────────────────────────────────
  function mapComission(c) {
    const cat = knownCat(c[C.C_CATEGORY]);
    return {
      ActivityType: C.AT_BOKNING,
      Title:        c[C.C_TITLE] || c.Title || "Bokning",
      Startdatum:   toBubbleDate(c[C.C_DELIVERY]),
      Slutdatum:    toBubbleDate(c[C.C_END] || c[C.C_DELIVERY]),
      Category:     cat,
      color_hex:    colorFor(cat),
      status:       c[C.C_STATUS] || null,
      [C.A_COMPANY]: idOf(c[C.C_COMPANY]) || null,
      Beskrivning:  c[C.C_DESC] || null,
      // OBS: Activity.plats är "geographic address" i Bubble — skriv inte rå text dit
      // (400-risk). Hanteras separat när vi mappar geo korrekt.
    };
  }

  function mapMatter(m) {
    const cat = knownCat(m[C.M_CATEGORY]);
    const closed = m[C.M_CLOSED] || null;
    return {
      ActivityType: C.AT_ARENDE,
      Title:        m[C.M_TITLE] || m.Title || m.title || "Ärende",
      Startdatum:   toBubbleDate(m["Created Date"]),
      Slutdatum:    closed ? toBubbleDate(closed) : null,   // tomt = öppet → frontend ritar t.o.m. idag
      Category:     cat,
      color_hex:    colorFor(cat),
      status:       m[C.M_STATUS] || null,
      [C.A_COMPANY]: idOf(m[C.M_COMPANY]) || null,
      Beskrivning:  m[C.M_DESC] || null,
    };
  }

  function mapTodo(r) {
    const cat = knownCat(r[C.TODO_CATEGORY]);
    return {
      ActivityType: C.AT_TODO,
      Title:        r[C.TODO_TITLE] || "Todo",
      // Saknas både Starttid och Sluttid → fall tillbaka till Created Date (annars osynlig i kalendern)
      Startdatum:   toBubbleDate(r[C.TODO_START] || r[C.TODO_END] || r["Created Date"]),
      Slutdatum:    toBubbleDate(r[C.TODO_END] || r[C.TODO_START] || r["Created Date"]),
      Category:     cat,
      color_hex:    colorFor(cat),
      status:       r[C.TODO_STATUS] || null,
      Beskrivning:  r["Beskrivning"] || null,
      [C.A_COMPANY]: idOf(r[C.TODO_COMPANY]) || null,
    };
  }

  function mapTimeTableEvent(ev, ccId) {
    return {
      ActivityType: C.AT_HOUSEKEEPING,
      Title:        ev.ItemName || "Housekeeping",
      Startdatum:   toBubbleDate(ev.StartDateTime),
      Slutdatum:    toBubbleDate(ev.EndDateTime),
      Category:     "Housekeeping",
      color_hex:    CATEGORY_COLORS["Housekeeping"],
      [C.A_COMPANY]: ccId || null,
      tengella_company:        ccId || null,
      tengella_event_id:       num(ev.EventId),
      tengella_employee_id:    num(ev.EmployeeId),
      tengella_employee_name:  str(ev.EmployeeName),
      tengella_project_id:     num(ev.ProjectId),
      tengella_project_name:   str(ev.ProjectName),
      tengella_region_id:      str(ev.RegionId),        // Bubble-fält = text
      tengella_region_name:    str(ev.RegionName),
      tengella_supervisor_id:  str(ev.SupervisorId),    // Bubble-fält = text
      tengella_supervisor_name:str(ev.SupervisorName),
      tengella_item_name:      str(ev.ItemName),
      tengella_raw_json:       JSON.stringify(ev),
      tengella_last_synced:    toBubbleDate(new Date().toISOString()),
    };
  }

  // ── Write-through (anropas av skapa-förfrågan / popup) ─────────────────────
  const upsertActivityForComission = (c, { write = true } = {}) =>
    upsertBySourceId(bubbleId(c), mapComission(c), { write, compareFields: COMPARE });
  const upsertActivityForMatter = (m, { write = true } = {}) =>
    upsertBySourceId(bubbleId(m), mapMatter(m), { write, compareFields: COMPARE });
  const upsertActivityForTodo = async (r, { write = true } = {}) => {
    const p = mapTodo(r);
    p.creator_company = await resolveCreatorCompany(r);
    return upsertBySourceId(bubbleId(r), p, { write, compareFields: COMPARE });
  };

  // ── Constraint-byggare ─────────────────────────────────────────────────────
  // Default: bara innevarande år och framåt (filtrerar på KÄLLANS egna datum, ej
  // Modified Date — annars drar en gammal-men-nyligen-ändrad post med). Override
  // med sinceDate / untilDate. modifiedDaysBack/modifiedSince läggs till (AND) för
  // nattlig inkrementell körning.
  function defaultSince() {
    return `${new Date().getFullYear()}-01-01T00:00:00.000Z`;
  }
  function buildConstraints(opts, dateField) {
    const cons = [];
    const since = opts.sinceDate === null ? null : (opts.sinceDate || defaultSince());
    if (since && dateField) cons.push({ key: dateField, constraint_type: "greater than", value: since });
    if (opts.untilDate && dateField) cons.push({ key: dateField, constraint_type: "less than", value: opts.untilDate });
    if (opts.modifiedSince) cons.push({ key: "Modified Date", constraint_type: "greater than", value: opts.modifiedSince });
    else if (opts.modifiedDaysBack) {
      cons.push({ key: "Modified Date", constraint_type: "greater than", value: new Date(Date.now() - opts.modifiedDaysBack * 86400000).toISOString() });
    }
    return cons;
  }
  function tally(report, r) {
    if (!r) { report.errors++; return; }
    report[r.mode] = (report[r.mode] || 0) + 1;
  }

  // ── Sweeps ──────────────────────────────────────────────────────────────────
  // Felinfo: bubbleFind kastar Error med .detail = { status, body, url } — ta med
  // den så ETT curl-svar visar Bubbles riktiga felmeddelande (ej bara "bubbleFind failed").
  const errInfo = (e) => (e?.detail ? `${e?.message} | ${JSON.stringify(e.detail)}` : (e?.message || String(e)));

  async function syncComissions(opts, sharedIndex) {
    const write = !!opts.write;
    const report = { source: "comission", scanned: 0, create: 0, update: 0, noop: 0, errors: 0 };
    let rows, index;
    try {
      index = sharedIndex || await loadActivityIndex();
      rows = await bubbleFindAll(C.COMISSION_TYPE, { constraints: buildConstraints(opts, C.C_DELIVERY) });
    } catch (e) { return { ...report, scan_error: errInfo(e) }; }
    report.scanned = rows.length;
    for (const c of rows) {
      try { tally(report, await upsertViaIndex(index, bubbleId(c), mapComission(c), { write, compareFields: COMPARE, throttleMs: opts.throttleMs ?? (write ? 120 : 0) })); }
      catch (e) { report.errors++; report.last_error = errInfo(e); log("comission err", bubbleId(c), errInfo(e)); }
    }
    return report;
  }

  async function syncMatters(opts, sharedIndex) {
    const write = !!opts.write;
    const report = { source: "matter", scanned: 0, create: 0, update: 0, noop: 0, errors: 0, closed_set: 0 };
    let rows, index;
    try {
      index = sharedIndex || await loadActivityIndex();
      rows = await bubbleFindAll(C.MATTER_TYPE, { constraints: buildConstraints(opts, "Created Date") });
    } catch (e) { return { ...report, scan_error: errInfo(e) }; }
    report.scanned = rows.length;
    for (const m of rows) {
      try {
        // closed_date: sätt när status=Avslutat och fältet är tomt (Render gör Bubbles trigger-jobb)
        if (m[C.M_STATUS] === C.M_STATUS_DONE && !m[C.M_CLOSED]) {
          const closedAt = m["Modified Date"] || new Date().toISOString();
          if (write) await bubblePatch(C.MATTER_TYPE, bubbleId(m), { [C.M_CLOSED]: toBubbleDate(closedAt) });
          m[C.M_CLOSED] = closedAt;
          report.closed_set++;
        }
        tally(report, await upsertViaIndex(index, bubbleId(m), mapMatter(m), { write, compareFields: COMPARE, throttleMs: opts.throttleMs ?? (write ? 120 : 0) }));
      } catch (e) { report.errors++; report.last_error = errInfo(e); log("matter err", bubbleId(m), errInfo(e)); }
    }
    return report;
  }

  async function syncTodos(opts, sharedIndex) {
    const write = !!opts.write;
    const report = { source: "todo", scanned: 0, create: 0, update: 0, noop: 0, errors: 0 };
    let rows, index;
    try {
      index = sharedIndex || await loadActivityIndex();
      rows = await bubbleFindAll(C.TODO_TYPE, { constraints: buildConstraints(opts, C.TODO_START) });
    } catch (e) { return { ...report, skipped: `typ "${C.TODO_TYPE}" ej läsbar — verifiera TODO_TYPE`, scan_error: errInfo(e) }; }
    report.scanned = rows.length;
    for (const r of rows) {
      try {
        const p = mapTodo(r);
        p.creator_company = await resolveCreatorCompany(r);
        tally(report, await upsertViaIndex(index, bubbleId(r), p, { write, compareFields: COMPARE, throttleMs: opts.throttleMs ?? (write ? 120 : 0) }));
      } catch (e) { report.errors++; report.last_error = errInfo(e); log("todo err", bubbleId(r), errInfo(e)); }
    }
    return report;
  }

  // Tengella TimeTableEvent → Activity, per företag som har tengella_customer_id.
  async function syncTengella(opts, sharedIndex) {
    const write = !!opts.write;
    const report = { source: "tengella", companies: 0, events: 0, create: 0, update: 0, noop: 0, errors: 0 };

    const fromDate = opts.fromDate || new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const toDate   = opts.toDate   || new Date(Date.now() + 92 * 86400000).toISOString().slice(0, 10);

    // Filtrera i JS (Bubbles "is not empty"-constraint är opålitlig för list/text).
    let allCustomers, index;
    try {
      index = sharedIndex || await loadActivityIndex();
      allCustomers = await bubbleFindAll(C.TENGELLA_CUSTOMER_TYPE, {});
    } catch (e) { return { ...report, scan_error: errInfo(e) }; }
    const customers = allCustomers.filter((tc) => tc[C.TC_CUSTOMER_ID] != null && tc[C.TC_CUSTOMER_ID] !== "");

    let token;
    try { token = await tengella.login(orgNo); }
    catch (e) { return { ...report, login_error: errInfo(e) }; }

    for (const tc of customers) {
      const ccId = idOf(tc[C.TC_COMPANY]);
      const customerId = num(tc[C.TC_CUSTOMER_ID]);
      if (!ccId || !customerId) continue;   // utan ClientCompany hamnar passet ingenstans
      report.companies++;

      let cursor = null, guard = 0;
      do {
        const resp = await tengella.fetch(C.TENGELLA_TIMETABLE_PATH, {
          method: "GET", token,
          query: { limit: 100, fromDate, toDate, customerId, cursor },
        });
        const data = resp?.Data || resp?.data || resp?.results || (Array.isArray(resp) ? resp : []);
        for (const ev of data) {
          report.events++;
          try {
            const sid = "tengella:" + ev.EventId;
            tally(report, await upsertViaIndex(index, sid, mapTimeTableEvent(ev, ccId), { write, compareFields: COMPARE_TENGELLA, throttleMs: opts.throttleMs ?? (write ? 120 : 0) }));
          } catch (e) { report.errors++; report.last_error = errInfo(e); log("tengella ev err", ev?.EventId, errInfo(e)); }
        }
        const more = resp?.ExistsMoreData ?? resp?.existsMoreData ?? false;
        cursor = more ? (resp?.cursor ?? resp?.Cursor ?? resp?.NextCursor ?? null) : null;
      } while (cursor && ++guard < 200);
    }
    return report;
  }

  // ── Purge: ta bort materialiserade Activity-rader före ett datum ────────────
  // Rör BARA våra materialiserade rader (source_id satt + vår ActivityType).
  // MS-/manuella Activity lämnas orörda. Diff-läge listar bara (would_delete).
  async function purgeOld(opts) {
    const write = !!opts.write;
    const before = opts.before || defaultSince();
    const ours = new Set([C.AT_BOKNING, C.AT_ARENDE, C.AT_TODO, C.AT_HOUSEKEEPING]);
    const report = { source: "purge", before, candidates: 0, deleted: 0, would_delete: 0, errors: 0 };
    let all;
    try { all = await bubbleFindAll(C.ACTIVITY_TYPE, {}); }
    catch (e) { return { ...report, scan_error: errInfo(e) }; }
    const victims = all.filter((a) =>
      a.source_id && ours.has(a.ActivityType) && a.Startdatum && String(a.Startdatum) < before);
    report.candidates = victims.length;
    for (const v of victims) {
      try {
        if (write) { await bubbleDelete(C.ACTIVITY_TYPE, bubbleId(v)); if (opts.throttleMs) await sleep(opts.throttleMs); report.deleted++; }
        else report.would_delete++;
      } catch (e) { report.errors++; report.last_error = errInfo(e); }
    }
    return report;
  }

  // ── Dispatcher ───────────────────────────────────────────────────────────────
  async function syncForSource(source, opts = {}) {
    switch (source) {
      case "comission": return syncComissions(opts);
      case "matter":    return syncMatters(opts);
      case "todo":  return syncTodos(opts);
      case "tengella":  return syncTengella(opts);
      case "purge":     return purgeOld(opts);
      case "all": {
        // Ett delat Activity-index för hela körningen (en läsning, inte fyra).
        let index = null;
        try { index = await loadActivityIndex(); }
        catch (e) { return { fatal: "loadActivityIndex: " + errInfo(e) }; }
        const safe = async (fn, label) => { try { return await fn(opts, index); } catch (e) { return { source: label, fatal: errInfo(e) }; } };
        return {
          comission: await safe(syncComissions, "comission"),
          matter:    await safe(syncMatters, "matter"),
          todo:  await safe(syncTodos, "todo"),
          tengella:  await safe(syncTengella, "tengella"),
        };
      }
      default:
        throw Object.assign(new Error(`Unknown activity source: ${source}`), { status: 400 });
    }
  }

  return {
    syncForSource,
    // write-through
    upsertActivityForComission,
    upsertActivityForMatter,
    upsertActivityForTodo,
    // exponerade delar (för create-chain/popup-endpoints)
    mapComission, mapMatter, mapTodo, mapTimeTableEvent, colorFor,
  };
}
