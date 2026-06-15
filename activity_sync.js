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
  REMEMBER_TYPE:  "Remember",        // ⚠️ VERIFIERA exakt typnamn för "Kom ihåg"
  TENGELLA_CUSTOMER_TYPE: "TengellaCustomer",

  // ActivityType-värden (option set) — exakt som inlagda i Bubble
  AT_BOKNING:     "Bokning",
  AT_ARENDE:      "Ärende",
  AT_KOM_IHAG:    "Kom ihåg",
  AT_HOUSEKEEPING:"Housekeeping",

  // Comission-fält
  C_TITLE:   "commission_title",
  C_DELIVERY:"delivery_date",
  C_END:     "delivery_date_end",   // ⚠️ VERIFIERA Comissions "ev slutdatum"-fält (saknas → faller tillbaka till delivery_date)
  C_CATEGORY:"Category",
  C_STATUS:  "commission_status",
  C_COMPANY: "Company",
  C_DESC:    "Description",
  C_ADDRESS: "delivery_address",

  // Matter-fält
  M_TITLE:   "Rubrik",              // ⚠️ VERIFIERA Matter-titel (annars Title/title)
  M_CATEGORY:"Category",
  M_STATUS:  "status",
  M_COMPANY: "Kundföretag",
  M_DESC:    "Beskrivning",
  M_CLOSED:  "closed_date",
  M_STATUS_DONE: "Avslutat",        // status-värde som triggar closed_date

  // Remember-fält  ⚠️ VERIFIERA alla
  R_TITLE:   "Title",
  R_START:   "Startdatum",
  R_END:     "Slutdatum",
  R_CATEGORY:"Category",
  R_STATUS:  "Status",
  R_COMPANY: "clientcompany",

  // ClientCompany-fält på Activity (bekräftat i index.js CC_FIELD_OVERRIDES)
  A_COMPANY: "clientcompany",

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
    bubbleFindOne, bubbleFindAll, bubbleCreate, bubblePatch, bubbleDelete, bubbleId,
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
  const idOf     = (x) => (typeof x === "string" ? x : bubbleId(x));   // refs kan vara id-sträng eller objekt
  const str      = (v) => (v === null || v === undefined ? null : String(v));
  const num      = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

  // Fält som jämförs vid sweep för noop-detektering (skriv bara vid faktisk ändring).
  const COMPARE = ["ActivityType", "Title", "Startdatum", "Slutdatum", "Category", "color_hex",
                   "status", C.A_COMPANY, "Beskrivning"];
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

  // ── Mappers ───────────────────────────────────────────────────────────────
  function mapComission(c) {
    const cat = c[C.C_CATEGORY] || null;
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
      plats:        c[C.C_ADDRESS] || null,
    };
  }

  function mapMatter(m) {
    const cat = m[C.M_CATEGORY] || null;
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

  function mapRemember(r) {
    const cat = r[C.R_CATEGORY] || null;
    return {
      ActivityType: C.AT_KOM_IHAG,
      Title:        r[C.R_TITLE] || "Kom ihåg",
      Startdatum:   toBubbleDate(r[C.R_START]),
      Slutdatum:    toBubbleDate(r[C.R_END] || r[C.R_START]),
      Category:     cat,
      color_hex:    colorFor(cat),
      status:       r[C.R_STATUS] || null,
      [C.A_COMPANY]: idOf(r[C.R_COMPANY]) || null,
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
  const upsertActivityForRemember = (r, { write = true } = {}) =>
    upsertBySourceId(bubbleId(r), mapRemember(r), { write, compareFields: COMPARE });

  // ── Modified-constraint-byggare ────────────────────────────────────────────
  function modifiedConstraints(opts) {
    if (opts.modifiedSince) {
      return [{ key: "Modified Date", constraint_type: "greater than", value: opts.modifiedSince }];
    }
    if (opts.modifiedDaysBack) {
      const since = new Date(Date.now() - opts.modifiedDaysBack * 86400000).toISOString();
      return [{ key: "Modified Date", constraint_type: "greater than", value: since }];
    }
    return [];
  }
  function tally(report, r) {
    if (!r) { report.errors++; return; }
    report[r.mode] = (report[r.mode] || 0) + 1;
  }

  // ── Sweeps ──────────────────────────────────────────────────────────────────
  async function syncComissions(opts) {
    const write = !!opts.write;
    const rows = await bubbleFindAll(C.COMISSION_TYPE, { constraints: modifiedConstraints(opts) });
    const report = { source: "comission", scanned: rows.length, create: 0, update: 0, noop: 0, errors: 0 };
    for (const c of rows) {
      try { tally(report, await upsertBySourceId(bubbleId(c), mapComission(c), { write, compareFields: COMPARE })); }
      catch (e) { report.errors++; log("comission err", bubbleId(c), e?.message || e); }
    }
    return report;
  }

  async function syncMatters(opts) {
    const write = !!opts.write;
    const rows = await bubbleFindAll(C.MATTER_TYPE, { constraints: modifiedConstraints(opts) });
    const report = { source: "matter", scanned: rows.length, create: 0, update: 0, noop: 0, errors: 0, closed_set: 0 };
    for (const m of rows) {
      try {
        // closed_date: sätt när status=Avslutat och fältet är tomt (Render gör Bubbles trigger-jobb)
        if (m[C.M_STATUS] === C.M_STATUS_DONE && !m[C.M_CLOSED]) {
          const closedAt = m["Modified Date"] || new Date().toISOString();
          if (write) await bubblePatch(C.MATTER_TYPE, bubbleId(m), { [C.M_CLOSED]: toBubbleDate(closedAt) });
          m[C.M_CLOSED] = closedAt;
          report.closed_set++;
        }
        tally(report, await upsertBySourceId(bubbleId(m), mapMatter(m), { write, compareFields: COMPARE }));
      } catch (e) { report.errors++; log("matter err", bubbleId(m), e?.message || e); }
    }
    return report;
  }

  async function syncRemembers(opts) {
    const write = !!opts.write;
    const rows = await bubbleFindAll(C.REMEMBER_TYPE, { constraints: modifiedConstraints(opts) }).catch(() => null);
    if (rows === null) return { source: "remember", skipped: `typ "${C.REMEMBER_TYPE}" ej läsbar — verifiera REMEMBER_TYPE` };
    const report = { source: "remember", scanned: rows.length, create: 0, update: 0, noop: 0, errors: 0 };
    for (const r of rows) {
      try { tally(report, await upsertBySourceId(bubbleId(r), mapRemember(r), { write, compareFields: COMPARE })); }
      catch (e) { report.errors++; log("remember err", bubbleId(r), e?.message || e); }
    }
    return report;
  }

  // Tengella TimeTableEvent → Activity, per företag som har tengella_customer_id.
  async function syncTengella(opts) {
    const write = !!opts.write;
    const report = { source: "tengella", companies: 0, events: 0, create: 0, update: 0, noop: 0, errors: 0 };

    const fromDate = opts.fromDate || new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const toDate   = opts.toDate   || new Date(Date.now() + 92 * 86400000).toISOString().slice(0, 10);

    const customers = await bubbleFindAll(C.TENGELLA_CUSTOMER_TYPE, {
      constraints: [{ key: C.TC_CUSTOMER_ID, constraint_type: "is not empty" }],
    });

    const token = await tengella.login(orgNo);

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
            tally(report, await upsertBySourceId(sid, mapTimeTableEvent(ev, ccId), { write, compareFields: COMPARE_TENGELLA }));
          } catch (e) { report.errors++; log("tengella ev err", ev?.EventId, e?.message || e); }
        }
        const more = resp?.ExistsMoreData ?? resp?.existsMoreData ?? false;
        cursor = more ? (resp?.cursor ?? resp?.Cursor ?? resp?.NextCursor ?? null) : null;
      } while (cursor && ++guard < 200);
    }
    return report;
  }

  // ── Dispatcher ───────────────────────────────────────────────────────────────
  async function syncForSource(source, opts = {}) {
    switch (source) {
      case "comission": return syncComissions(opts);
      case "matter":    return syncMatters(opts);
      case "remember":  return syncRemembers(opts);
      case "tengella":  return syncTengella(opts);
      case "all": {
        return {
          comission: await syncComissions(opts),
          matter:    await syncMatters(opts),
          remember:  await syncRemembers(opts),
          tengella:  await syncTengella(opts),
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
    upsertActivityForRemember,
    // exponerade delar (för create-chain/popup-endpoints)
    mapComission, mapMatter, mapRemember, mapTimeTableEvent, colorFor,
  };
}
