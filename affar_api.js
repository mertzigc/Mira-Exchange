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
    bubbleFind, bubbleFindAll, bubbleGet, bubbleCount, bubblePatch, bubbleCreate, bubbleDelete, bubbleId,
    planningAuthed, planningCors, publicRateLimited, clientIp,
    FE_CONNECTION_ID, TENGELLA_CONNECTION_ID, CONNECTION_NAMES, offertConvert, renderOrderPdf,
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
  // Delad förvärmd CC-cache (deps.companyMap/OwnerMap) om injicerad, annars lokal _loadCC.
  async function companyMap() { if (deps.companyMap) return deps.companyMap(); return (await _loadCC()).name; }
  async function companyOwnerMap() { if (deps.companyOwnerMap) return deps.companyOwnerMap(); return (await _loadCC()).owner; }
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
      const last  = _str(u["Last Name"]  || u["Efternamn"] || u["Surname"]);   // User-efternamn = Surname
      const nm = (first + " " + last).trim() || _str(u.email || u.Email);
      m.set(id, nm);
    }
    _uCache = { map: m, ts: Date.now() };
    return m;
  }

  // ── Deal-cache (id → titel / ägar-namn / kategori) ────────────────
  let _dCache = { map: null, owner: null, ownerId: null, cat: null, ts: 0 };
  async function _loadDeals() {
    if (_dCache.map && (Date.now() - _dCache.ts) < CC_TTL) return _dCache;
    const all = await bubbleFindAll("deal", {}).catch(() => []);
    const um = await userMap();
    const map = new Map(), owner = new Map(), ownerId = new Map(), cat = new Map();
    for (const d of all) {
      const id = bubbleId(d); if (!id) continue;
      map.set(id, _str(d.titel) || _str(d.Namn) || _str(d.name));
      const ow = Array.isArray(d.deal_owner) ? d.deal_owner[0] : d.deal_owner;   // deal_owner = List of Users
      const owId = _ref(ow); if (owId) { owner.set(id, um.get(owId) || ""); ownerId.set(id, owId); }
      const kat = Array.isArray(d.Kategori) ? d.Kategori[0] : d.Kategori;          // affärens kategori (Category-OS)
      if (kat) cat.set(id, _str(kat));
    }
    _dCache = { map, owner, ownerId, cat, ts: Date.now() };
    return _dCache;
  }
  async function dealMap() { return (await _loadDeals()).map; }
  async function dealOwnerMap() { return (await _loadDeals()).owner; }
  async function dealCatMap() { return (await _loadDeals()).cat; }
  // Affärs-id:n ägda av en viss användare (för person-filter på dok-typer via kopplad affär)
  async function dealsOwnedBy(userId) { if (!userId) return []; const om = (await _loadDeals()).ownerId; const ids = []; for (const [did, uid] of om) if (uid === userId) ids.push(did); return ids; }
  // Affärs-id:n med en viss kategori (för kategori-filter på avtal via kopplad affär)
  async function dealsWithCategory(cat) { if (!cat) return []; const cm = (await _loadDeals()).cat; const ids = []; for (const [did, c] of cm) if (c === cat) ids.push(did); return ids; }
  // Fortnox-anslutnings-id:n som mappar till en kategori (Staff→Service & People, Group→Other facility services)
  const NAME_TO_CAT = { "Food & Event": "Food & Event", "Housekeeping": "Housekeeping", "Staff": "Service & People", "Group": "Other facility services" };
  function connIdsForCat(cat) { const cn = CONNECTION_NAMES || {}; const ids = []; for (const id in cn) { if (NAME_TO_CAT[cn[id]] === cat) ids.push(id); } return ids; }

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

  // ── Todo-cache (id → {title, company-ref}) — för koppla-sök + prefill ──
  let _tCache = { map: null, ts: 0 };
  async function todoMap() {
    if (_tCache.map && (Date.now() - _tCache.ts) < CC_TTL) return _tCache.map;
    const all = await bubbleFindAll("Todo", {}).catch(() => []);
    const m = new Map();
    for (const t of all) { const id = bubbleId(t); if (id) m.set(id, { title: _str(t.Titel), company: _ref(t["Företag"]) }); }
    _tCache = { map: m, ts: Date.now() };
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
  function nLead(r, m) { return { type: "Lead", source: "mira", company: cname(m, r.Company) || _str(r.Name), number: "", amount: null, date: _day(r["Created Date"]), status: "Ny", status_cls: "wait", deal_id: _ref(r.deal) || null, id: bubbleId(r) }; }
  function nAkt(r, m)  { const [lbl] = pick({}, _str(r.kundm_te_option_kundm_te), ["Aktivitet", "wait"]); return { type: "Aktivitet", source: "mira", company: cname(m, r.clientcompany), number: "", amount: null, date: _day(r.datum_bokning_date || r["Created Date"]), status: lbl || "Aktivitet", status_cls: "wait", deal_id: _ref(r.deal) || null, id: bubbleId(r) }; }
  function nDeal(r, m) { const [lbl, cls] = pick(DEAL_STATUS, _str(r.Status), ["—", "wait"]); return { type: "Affär", source: "mira", company: cname(m, r["kundföretag"]), number: _str(r.titel), amount: _num(r.value_brutto) || null, date: _day(r["Created Date"]), status: lbl, status_cls: cls, deal_id: _ref(r.deal) || null, id: bubbleId(r) }; }
  // ⚠️ BORTTAGET 2026-08-20: `_woRows` / `nWorkorder` / `_liveWO` läste den
  // PENSIONERADE typen `TengellaWorkorder` (fryst 2026-06-04 av §9-cutovern).
  // Kommentaren här påstod "kanonisk källa … färsk sync" om data som redan då
  // var två månader gammal — och det påståendet är hela orsaken till att
  // affärsvyn visade elva veckor gammal Housekeeping-data.
  // HK läses nu ur FortnoxOrder (connection=TENGELLA) via `nOrderF`, med rader
  // ur FortnoxOrderRow via `fyllHkRader`. Koden är borttagen i stället för
  // utkommenterad: död kod som ser levande ut var precis felet.
  function nOffertM(r, m, durl) { const [lbl, cls] = pick(OFFER_STATUS, _str(r.status), ["Utkast", "wait"]); const d0 = (Array.isArray(r.dokument) ? r.dokument[0] : null); return { type: "Offert", source: "mira", kind: _str(r.kind) || "strukturerad", company: cname(m, r.kundforetag), number: _str(r.offertnr), amount: _num(r.total) || null, date: _day(r.offertdatum || r["Created Date"]), status: lbl, status_cls: cls, url: (durl && d0) ? (durl.get(_ref(d0)) || "") : "", deal_id: _ref(r.deal) || null, order_id: null, order_nr: "", id: bubbleId(r) }; }
  // Batch: vilka Mira-offerter har redan en MiraOrder? → id→{id,nr} (för Konvertera-status i affär-vyn).
  async function orderMapForOfferts(offRecs) {
    const ids = (offRecs || []).map(bubbleId).filter(Boolean);
    const map = new Map();
    if (!ids.length) return map;
    const orders = await bubbleFindAll("MiraOrder", { constraints: [{ key: "offert", constraint_type: "in", value: ids }] }).catch(() => []);
    for (const o of orders) { const oid = _ref(o.offert); if (oid && !map.has(oid)) map.set(oid, { id: bubbleId(o), nr: _str(o.ordernr) }); }
    return map;
  }
  // Sätt order_id/order_nr på nOffertM-rader utifrån orderMapForOfferts.
  function applyOrderStatus(rows, omap) { for (const row of rows) { if (row && row.source === "mira" && row.type === "Offert") { const os = omap.get(row.id); if (os) { row.order_id = os.id; row.order_nr = os.nr; } } } return rows; }
  function nOffertF(r) { const st = r.ft_cancelled ? ["Avbruten", "red"] : (r.ft_sent ? ["Skickad", "open"] : ["Öppen", "open"]); return { type: "Offert", source: "fortnox", kind: "fortnox", company: _str(r.ft_customer_name), number: _str(r.ft_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_offer_date || r.ft_delivery_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf), deal_id: _ref(r.deal) || null, id: bubbleId(r) }; }
  function nOrderM(r, m) { const [lbl, cls] = pick(ORDER_STATUS, _str(r.orderstatus), ["Bekräftad", "open"]); return { type: "Order", source: "mira", company: cname(m, r.kundforetag), number: _str(r.ordernr), amount: _num(r.total) || null, date: _day(r.orderdatum || r["Created Date"]), status: lbl, status_cls: cls, klar_for_leverans: (r.klar_for_leverans === true), levererad: (_str(r.orderstatus) === "Levererad"), deal_id: _ref(r.deal) || null, id: bubbleId(r) }; }
  // Avtal (Contract) i affärskedjan. Status härleds enkelt (affar_api saknar _deriveContractStatus):
  // status_override först, annars slutdatum-passerat → Avslutad, annars Aktiv. Belopp = månadskostnad.
  function nAvtal(r, m) {
    var ov = _str(r.status_override);
    var slutTs = _ts(r.slutdatum);
    var st = ov ? [ov, "wait"] : (slutTs && slutTs < Date.now() ? ["Avslutad", "red"] : ["Aktiv", "ok"]);
    return { type: "Avtal", source: "mira", company: cname(m, r["kundföretag"]), number: _str(r.contract_title) || _str(r.kategori) || "Avtal", amount: _num(r["månadskostnad"]) || null, date: _day(r.startdatum || r.signed_at || r["Created Date"]), contract_type: _str(r.contract_type) || null, status: st[0], status_cls: st[1], deal_id: _ref(r.deal) || null, id: bubbleId(r) };
  }
  // OBS: FortnoxOrder kan ha connection=TENGELLA (§9d mappar workorders hit) → tagga
  // källa efter anslutning (som nInvoice), annars märks HK-order fel som "fortnox" och
  // Visa-knappen försöker (fåfängt) hämta Fortnox-order-PDF från Tengella-anslutningen.
  // ⚠️ HK OCH F&E BOR I SAMMA TABELL MEN BÄR OLIKA DATUM.
  // §9-cutovern (LIVE 2026-06-08) flyttade Tengella-workordrar till unified
  // `FortnoxOrder` (connection=TENGELLA, source="tengella-workorder").
  // v2-adaptern sätter `ft_order_date` men ALDRIG `ft_delivery_date` — workordern
  // har bara OrderDate. Att datera HK på ft_delivery_date gav fallback till
  // Created Date och gjorde raderna osynliga i varje datumfilter.
  // Status: för HK vet vi inte om något levererats (inget leveransdatum finns),
  // så vi behåller den neutrala "Workorder"-etiketten från den gamla vyn i
  // stället för att gissa "Levererad".
  function nOrderF(r) {
    const src = connSource(r.connection);
    const hk = src === "tengella";
    const d = hk ? r.ft_order_date : r.ft_delivery_date;
    const past = !hk && _ts(r.ft_delivery_date) && _ts(r.ft_delivery_date) < Date.now();
    return { type: "Order", source: src, company: _str(r.ft_customer_name),
      number: _str(r.ft_document_number || r.ft_order_document_number),
      amount: _num(r.ft_total) || null, date: _day(d || r["Created Date"]),
      status: hk ? "Workorder" : (past ? "Levererad" : "Bekräftad"),
      status_cls: hk ? "wait" : (past ? "ok" : "open"),
      url: _httpsUrl(r.ft_pdf), deal_id: _ref(r.deal) || null,
      ...(hk ? { wo: 1, rows: [] } : {}),   // rows fylls efter paginering (ingen N+1)
      id: bubbleId(r) };
  }

  // HK-orderrader ligger i `FortnoxOrderRow` (egen typ), till skillnad från den
  // pensionerade TengellaWorkorder där de låg inbäddade i workorder_rows_json.
  // ⚠️ Hämtas EFTER paginering, i EN batchfråga för hela sidan — annars N+1.
  async function fyllHkRader(items) {
    const hk = (items || []).filter((x) => x && x.wo && x.number);
    if (!hk.length) return items;
    const docNos = [...new Set(hk.map((x) => x.number))];
    // Låt frågan braka — en tom lista här skulle tyst visa "0 rader".
    const rows = await bubbleFindAll("FortnoxOrderRow", { constraints: [
      { key: "ft_order_document_number", constraint_type: "in", value: docNos } ] });
    const byDoc = new Map();
    for (const r of rows) {
      const k = _str(r.ft_order_document_number); if (!k) continue;
      if (!byDoc.has(k)) byDoc.set(k, []);
      byDoc.get(k).push(r);
    }
    for (const x of hk) {
      const rs = (byDoc.get(x.number) || []).sort((a, b) => (_num(a.ft_row_index) || 0) - (_num(b.ft_row_index) || 0));
      x.rows = rs.map((r) => {
        const qty = _num(r.ft_quantity), price = _num(r.ft_price);
        return { name: _str(r.ft_description), art: _str(r.ft_article_number),
          qty, price, sum: _num(r.ft_total) != null ? _num(r.ft_total) : (qty || 0) * (price || 0),
          note: "" };
      });
    }
    return items;
  }
  // ⚠️ ft_url är Fortnox API-URL (JSON, EJ PDF) på order/Fortnox-faktura → aldrig som Visa-länk.
  // Bara Tengella-fakturans ft_url är en riktig (temporär) PDF-länk. Order utan ft_pdf → lazy-knapp.
  function nInvoice(r) { const src = connSource(r.connection); const bal = _num(r.ft_balance); const due = _ts(r.ft_due_date); let st = ["Obetald", "open"]; if (bal === 0) st = ["Betald", "ok"]; else if (due && due < Date.now()) st = ["Förfallen", "red"]; return { type: "Faktura", source: src, company: _str(r.ft_customer_name), number: _str(r.ft_document_number), amount: _num(r.ft_total) || null, date: _day(r.ft_invoice_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf) || (src === "tengella" ? _httpsUrl(r.ft_url) : ""), deal_id: _ref(r.deal) || null, ansvarig: _str(r.ft_our_reference), id: bubbleId(r) }; }

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
      belopp: _num(r.estimated_service_cost_monthly) || null,   // prel. ca-värde (kr/mån)
      formular: _ref(r["Formulär"]) ? "Ja" : "",
      status: lbl, status_cls: cls,
      kundansvarig: kaId ? (um.get(kaId) || "") : "",
      ansvarig: (_ref(r["Created By"]) ? (um.get(_ref(r["Created By"])) || "") : ""),   // skapare
      tilldelad: tId ? { id: tId, name: um.get(tId) || "" } : null,
      // edit-prefill (koppla-fält): leadets EGNA Kundansvarig (ej företags-fallback) + todo
      kundansvarig_id: _ref(r.Kundansvarig) || null,
      todo_id: _ref(r.todo) || null,
      todo_title: "",
      deal_id: _ref(r.deal) || null,
    };
  }
  // Aktivitet-kolumner: skapad/leverantör/typ/fas/mötesdatum/företag/affär/meddelande/vår användare.
  function nAktFull(r, m, um, sm, dm) {
    const levs = Array.isArray(r["Leverantör"]) ? r["Leverantör"] : (r["Leverantör"] ? [r["Leverantör"]] : []);
    const dId = _ref(r.deal);
    const wId = _ref(r.writer) || _ref(r["Created By"]);
    return {
      // ⚠️ LÄSNYCKLAR = display-namn (skarpt bekräftat 2026-08-07): Datum_bokning/Kundmöte,
      // EJ slug-formerna datum_bokning_date/kundm_te_option_kundm_te (slug = bara för constraints).
      type: "Aktivitet", source: "mira", id: bubbleId(r), date: _day(r["Datum_bokning"] || r["Created Date"]),
      created: _day(r["Created Date"]),
      leverantor: levs.map((x) => sm.get(_ref(x)) || "").filter(Boolean).join(", "),
      typ: _str(r.activity_type), fas: _str(r["Kundmöte"]),
      motesdatum: _day(r["Datum_bokning"]),
      company: cname(m, r.company), company_id: _ref(r.company) || null,
      affar: dId ? (dm.get(dId) || "") : "", affar_id: dId || null,
      meddelande: _str(r.beskrivning) || _str(r["mötesantecking"]),
      var_anvandare: wId ? (um.get(wId) || "") : "",
      ansvarig: wId ? (um.get(wId) || "") : "",   // skapare (writer||Created By)
      // edit-prefill: råvärden för inline-redigering (skrivnycklar = dessa läsnycklar)
      beskrivning: _str(r.beskrivning),
      motesanteckning: _str(r["mötesantecking"]),
      motesdatum_iso: _day(r["Datum_bokning"]),
      genomfort: r["genomfört"] === true,
    };
  }
  // Företags-id:n vars namn matchar q (för ref-företags-sök som Bubble ej klarar direkt)
  function ccIdsMatching(m, q) {
    const ql = String(q || "").toLowerCase(); const ids = [];
    for (const [id, nm] of m) { if (nm && String(nm).toLowerCase().indexOf(ql) !== -1) ids.push(id); }
    return ids;
  }
  // Union av flera constraint-set → deduped rader (samma mönster som /list, men modul-scope
  // så doc-search kan återanvända det). text-contains + q≥2 → små resultat, findAll ok.
  async function searchUnionAll(type, sets) {
    const all = await Promise.all(sets.map((cs) => bubbleFindAll(type, { constraints: cs }).catch(() => [])));
    const seen = new Map();
    for (const arr of all) for (const r of arr) { const id = bubbleId(r); if (id && !seen.has(id)) seen.set(id, r); }
    return [...seen.values()];
  }
  // Todo-titlar för lead-rader (koppla-fältets förifyllning) via todoMap-cache.
  async function todoTitleMap(leadRecs) {
    const need = leadRecs.some((r) => _ref(r.todo));
    if (!need) return new Map();
    const tm = await todoMap();
    const map = new Map();
    for (const r of leadRecs) { const t = _ref(r.todo); if (t && tm.has(t)) map.set(t, tm.get(t).title); }
    return map;
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

      // ⚠️ RÄTTAT 2026-08-20. Stod tidigare: "HK/Tengella-order = raw
      // TengellaWorkorder (kanonisk källa, Fas 1 2026-08-07 — färsk sync)".
      // Den kommentaren PÅSTOD färsk sync om en typ som varit fryst sedan
      // 2026-06-04, och kallade den kanoniska källan för "ev. sync_v2-spegel".
      // Följden: affärsvyn visade elva veckor gammal HK-data.
      // Sanningen: §9-cutovern (LIVE 2026-06-08) gjorde FortnoxOrder med
      // connection=TENGELLA till kanonisk källa för HK. Ingen exkludering längre.
      const [
        cLead, cAkt, cDeal, cOffM, cOffF, cOrdM, cOrdF, cInv, cAvtal,
        m, leads, akts, deals, offMs, offFs, ordMs, ordFs, invs, avtals,
      ] = await Promise.all([
        bubbleCount("Lead"), bubbleCount("activitet_crm"), bubbleCount("deal"),
        bubbleCount("Offert", feMira), bubbleCount("FortnoxOffer"),
        bubbleCount("MiraOrder"), bubbleCount("FortnoxOrder"),
        bubbleCount("FortnoxInvoice"), bubbleCount("Contract"),
        companyMap(),
        recent("Lead", limit), recent("activitet_crm", limit), recent("deal", limit),
        recent("Offert", limit, feMira), recent("FortnoxOffer", limit),
        recent("MiraOrder", limit), recent("FortnoxOrder", limit),
        recent("FortnoxInvoice", limit), recent("Contract", limit),
      ]);

      const offMapFeed = await orderMapForOfferts(offMs);
      const rows = [
        ...leads.map((r) => nLead(r, m)),
        ...akts.map((r) => nAkt(r, m)),
        ...deals.map((r) => nDeal(r, m)),
        ...applyOrderStatus(offMs.map((r) => nOffertM(r, m)), offMapFeed),
        ...offFs.map(nOffertF),
        ...avtals.map((r) => nAvtal(r, m)),
        ...ordMs.map((r) => nOrderM(r, m)),
        ...ordFs.map(nOrderF),   // HK ingår (connection=TENGELLA) — ingen exkludering
        ...invs.map(nInvoice),
      ].filter((r) => r.id);
      rows.sort((a, b) => (_ts(b.date) - _ts(a.date)));

      return res.json({
        ok: true,
        funnel: {
          lead: cLead, aktivitet: cAkt, affar: cDeal,
          // ⚠️ `cWO` (TengellaWorkorder-räknaren) togs bort 2026-08-20 när HK
          // flyttades till FortnoxOrder. HK ingår nu i `cOrdF` — att addera en
          // separat workorder-räknare här hade dubbelräknat dem.
          offert: cOffM + cOffF, avtal: cAvtal, order: cOrdM + cOrdF, faktura: cInv,
        },
        counts_detail: { offert_mira: cOffM, offert_fortnox: cOffF, avtal: cAvtal, order_mira: cOrdM, order_fortnox: cOrdF },
        rows,
        note: "Order = MiraOrder + FortnoxOrder (HK ingår: connection=TENGELLA, daterad på ft_order_date). TengellaWorkorder pensionerad 2026-06-04. Sortering på visnings-datum.",
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

      // Kedjan läser BÅDE Deals list-fält (legacy) OCH reverse-lookup på varje typs `deal`-fält
      // (P3 manuell koppling) — deduped på id. Så manuellt kopplade dok tänds i affärskortet.
      const did = req.params.id;
      const rev = (type) => bubbleFind(type, { constraints: [{ key: "deal", constraint_type: "equals", value: did }], limit: 25 }).catch(() => []);
      const dedup = (arr) => { const mp = new Map(); (arr || []).forEach((o) => { const id = bubbleId(o); if (id && !mp.has(id)) mp.set(id, o); }); return [...mp.values()]; };

      const [leadRow, akts, aktRev, offList, offRev, offFRev, ordList, ordFRev, invList, invRev, avtalRows, leadRev] = await Promise.all([
        deal.lead ? bubbleGet("Lead", _ref(deal.lead)).catch(() => null) : null,
        getList("activitet_crm", deal.historik),
        rev("activitet_crm"),
        getList("Offert", deal.offert),
        rev("Offert"),
        rev("FortnoxOffer"),
        getList("FortnoxOrder", deal.order),
        rev("FortnoxOrder"),
        getList("FortnoxInvoice", deal.invoice),
        rev("FortnoxInvoice"),
        rev("Contract"),
        rev("Lead"),
      ]);

      const offRows = dedup([...offList, ...(offRev || [])]);       // Mira-offert (lista + reverse)
      const miraOrders = [];
      for (const off of offRows) {
        const mo = await bubbleFind("MiraOrder", { constraints: [{ key: "offert", constraint_type: "equals", value: bubbleId(off) }], limit: 5 }).catch(() => []);
        miraOrders.push(...(mo || []));
      }
      const aktRows   = dedup([...(akts || []), ...(aktRev || [])]);
      const offFRows  = dedup(offFRev);                             // FortnoxOffer via deal
      const fortOrders = dedup([...(ordList || []), ...(ordFRev || [])]);
      const invRowsAll = dedup([...(invList || []), ...(invRev || [])]);
      const leadUnion = dedup([...(leadRow ? [leadRow] : []), ...(leadRev || [])]);
      const leadPrimary = leadUnion[0] || null;

      // `linked` = dok nådde kortet via P3 reverse-lookup på sitt `deal`-fält (manuell koppling),
      // INTE via Deals egna listfält (offert/order/invoice). Driver "kopplad"-markören i kortet.
      const offListIds = new Set((offList || []).map(bubbleId).filter(Boolean));
      const ordListIds = new Set((ordList || []).map(bubbleId).filter(Boolean));
      const invListIds = new Set((invList || []).map(bubbleId).filter(Boolean));
      const tag = (x, isLinked) => { x.linked = !!isLinked; return x; };

      const akItems = aktRows.map((r) => nAkt(r, m)).sort((a, b) => _ts(b.date) - _ts(a.date));
      const offOmap = await orderMapForOfferts(offRows);
      const offItems = applyOrderStatus([
        ...offRows.map((r) => tag(nOffertM(r, m), !offListIds.has(bubbleId(r)))),
        ...offFRows.map((r) => tag(nOffertF(r), true)),   // FortnoxOffer når kortet bara via reverse
      ], offOmap);
      const avtalItems = (avtalRows || []).map((r) => tag(nAvtal(r, m), true));  // Contract: bara reverse
      const ordItems = [
        // HK ingår nu — samma tabell, connSource skiljer dem åt i display.
        ...fortOrders.map(nOrderF).map((x) => tag(x, !ordListIds.has(x.id))),
        ...miraOrders.map((r) => tag(nOrderM(r, m), false)),   // via offert-kedjan, ej manuell
      ];
      await fyllHkRader(ordItems);   // HK-rader ur FortnoxOrderRow, batchat
      const invItems = invRowsAll.map((r) => tag(nInvoice(r), !invListIds.has(bubbleId(r))));

      // ── redigerbara deal-fält (förifyllning) ──
      const cwName = (c) => ((_str(c["Förnamn"] || c["First Name"]) + " " + _str(c["Efternamn"] || c["Last Name"])).trim() || _str(c.Email || c.email));
      const kpRows = await getList("Coworker", deal.kontaktpersoner);
      const kontaktpersoner = kpRows.map((c) => ({ id: bubbleId(c), name: cwName(c) }));
      const tmap = await todoMap();
      const todoIdsD = Array.isArray(deal.todo) ? deal.todo : (deal.todo ? [deal.todo] : []);
      const todos = todoIdsD.map((t) => { const id = _ref(t); return { id, title: (tmap.get(id) ? tmap.get(id).title : "") }; }).filter((x) => x.id);
      const kategori = Array.isArray(deal.Kategori) ? deal.Kategori.map(_str) : (deal.Kategori ? [_str(deal.Kategori)] : []);

      return res.json({
        ok: true,
        deal: {
          id: bubbleId(deal), titel: _str(deal.titel), company: cname(m, deal["kundföretag"]),
          status: _str(deal.Status), value: _num(deal.value_brutto) || null, sannolikhet: _num(deal.sannolikhet) || null,
        },
        edit: {
          titel: _str(deal.titel), beskrivning: _str(deal.beskrivning),
          status: _str(deal.Status), region: _str(deal.Region),
          sannolikhet: (deal.sannolikhet == null || deal.sannolikhet === "") ? "" : _str(deal.sannolikhet),
          kategori: kategori,
          value_brutto: (deal.value_brutto == null || deal.value_brutto === "") ? null : _num(deal.value_brutto),
          value_netto: (deal.value_netto == null || deal.value_netto === "") ? null : _num(deal.value_netto),
          kundforetag_id: _ref(deal["kundföretag"]) || null,
          kundforetag_name: cname(m, deal["kundföretag"]),
          kontaktpersoner: kontaktpersoner,
          todo: todos,
        },
        chain: {
          lead: leadPrimary ? { name: (_str(leadPrimary.Name) || _str(leadPrimary.titel) || cname(m, leadPrimary.Company)), date: _day(leadPrimary["Created Date"]) } : null,
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

      // ── Datum-filter (skapat): Created Date-range, enhetligt över alla typer. Order-specifika
      // datum (orderdatum/leveransdatum) + Person/Kategori = nästa steg. Bubble date-constraints
      // på Created Date; verifiera reliabilitet via curl (string-datum-constraints är opålitliga).
      // DATUM-FILTER på respektive typs AFFÄRSDATUM (samma fält som visas i Datum-kolumnen), INTE
      // Created Date/synktid — annars dyker t.ex. juli-fakturor synkade i aug upp i ett aug-filter.
      // Bubble har BARA "greater than"/"less than" (ej ...or equal to). Inklusiv: från −1ms, till +1 dygn.
      // Multi-källa (offert/order) filtreras per källa på sitt fält (offertdatum/ft_offer_date etc.).
      const _from = _str(req.query.from), _to = _str(req.query.to);
      const _fromV = _from ? new Date(new Date(_from + "T00:00:00.000Z").getTime() - 1).toISOString() : null;
      const _toV   = _to   ? new Date(new Date(_to   + "T00:00:00.000Z").getTime() + 86400000).toISOString() : null;
      const dateC = (field) => { const c = []; if (_fromV) c.push({ key: field, constraint_type: "greater than", value: _fromV }); if (_toV) c.push({ key: field, constraint_type: "less than", value: _toV }); return c; };
      const DATE_FIELD = { lead: "Created Date", aktivitet: "Created Date", affar: "Created Date", faktura: "ft_invoice_date", avtal: "startdatum" };
      const dateBase = (type === "offert" || type === "order") ? [] : dateC(DATE_FIELD[type] || "Created Date");

      // ── PERSON- + KATEGORI-filter ──
      const _person = _str(req.query.person), _kategori = _str(req.query.kategori);
      const filtersActive = !!(q || _from || _to || _person || _kategori);
      const personDealIds = _person ? await dealsOwnedBy(_person) : null;   // dok-typer: via kopplad affär
      const katDealIds    = _kategori ? await dealsWithCategory(_kategori) : null;  // avtal: via kopplad affär
      const katConnIds    = _kategori ? connIdsForCat(_kategori) : null;    // Fortnox-dok: via anslutning
      // person-constraint per typ (direkt fält där det finns, annars via affär)
      const personC = (kind) => {
        if (!_person) return [];
        if (kind === "lead")  return [{ key: "Created By", constraint_type: "equals", value: _person }];
        if (kind === "akt")   return [{ key: "writer", constraint_type: "equals", value: _person }];
        if (kind === "deal")  return [{ key: "deal_owner", constraint_type: "contains", value: _person }];
        return [{ key: "deal", constraint_type: "in", value: personDealIds || [] }];   // dok via affär
      };
      // Mira/Tengella-källa relevant för vald kategori? (F&E resp. Housekeeping). Fortnox = connection-constraint.
      const miraCatOk = (!_kategori || _kategori === "Food & Event");
      const tengCatOk = (!_kategori || _kategori === "Housekeeping");
      const fortKatC = _kategori ? [{ key: "connection", constraint_type: "in", value: katConnIds }] : [];
      const invKatC  = _kategori ? [{ key: "connection_id", constraint_type: "in", value: katConnIds }] : [];   // FortnoxInvoice = connection_id
      // filtrerad total per typ (grand_total = ofiltrerat; total = efter filter)
      const sumCounts = async (pairs) => { let n = 0; for (const [t, cs] of pairs) n += await bubbleCount(t, cs).catch(() => 0); return n; };

      const pageOf = (t, extra = []) => bubbleFind(t, { constraints: [...dateBase, ...extra], limit, cursor, sort_field: "Created Date", descending: true }).catch(() => []);
      async function searchUnion(t, sets) {
        const all = await Promise.all(sets.map((cs) => bubbleFindAll(t, { constraints: [...dateBase, ...cs] }).catch(() => [])));
        const seen = new Map();
        for (const arr of all) for (const r of arr) { const id = bubbleId(r); if (id && !seen.has(id)) seen.set(id, r); }
        return [...seen.values()];
      }
      const byCreated = (a, b) => _ts(b["Created Date"]) - _ts(a["Created Date"]);

      let rows = [], total = null, grand_total = null;

      if (type === "lead") {
        const m = await companyMap(), um = await userMap(), ownerMap = await companyOwnerMap();
        const extra = personC("lead");   // lead saknar kategori-begrepp → kategori-filter ignoreras här
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [
            [...extra, { key: "Name",  constraint_type: "text contains", value: q }],
            [...extra, { key: "Email", constraint_type: "text contains", value: q }],
            [...extra, { key: "Phone", constraint_type: "text contains", value: q }],
            [...extra, { key: "Company", constraint_type: "text contains", value: q }],
          ];
          if (ccIds.length) sets.push([...extra, { key: "client_company", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("Lead", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("Lead", extra); total = filtersActive ? await bubbleCount("Lead", [...dateBase, ...extra]) : await bubbleCount("Lead"); }
        grand_total = await bubbleCount("Lead");
        rows = recs.map((r) => nLeadFull(r, m, um, ownerMap));
        const tmap = await todoTitleMap(recs);
        for (let i = 0; i < rows.length; i++) { const tid = rows[i].todo_id; rows[i].todo_title = tid ? (tmap.get(tid) || "") : ""; }
      }
      else if (type === "aktivitet") {
        const m = await companyMap(), um = await userMap(), sm = await supplierMap(), dm = await dealMap();
        const extra = personC("akt");   // aktivitet saknar kategori-begrepp
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [[...extra, { key: "beskrivning", constraint_type: "text contains", value: q }]];
          if (ccIds.length) sets.push([...extra, { key: "company", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("activitet_crm", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("activitet_crm", extra); total = filtersActive ? await bubbleCount("activitet_crm", [...dateBase, ...extra]) : await bubbleCount("activitet_crm"); }
        grand_total = await bubbleCount("activitet_crm");
        rows = recs.map((r) => nAktFull(r, m, um, sm, dm));
      }
      else if (type === "faktura") {
        const extra = [...personC("doc"), ...invKatC];   // person via affär + kategori via connection_id
        let recs;
        if (q) {
          recs = (await searchUnion("FortnoxInvoice", [
            [...extra, { key: "ft_customer_name", constraint_type: "text contains", value: q }],
            [...extra, { key: "ft_document_number", constraint_type: "text contains", value: q }],
          ])).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("FortnoxInvoice", extra); total = filtersActive ? await bubbleCount("FortnoxInvoice", [...dateBase, ...extra]) : await bubbleCount("FortnoxInvoice"); }
        grand_total = await bubbleCount("FortnoxInvoice");
        rows = recs.map(nInvoice);
      }
      else if (type === "avtal") {
        const m = await companyMap();
        const extra = [...personC("doc"), ...(_kategori ? [{ key: "deal", constraint_type: "in", value: katDealIds || [] }] : [])];   // kategori via kopplad affär
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [[...extra, { key: "contract_title", constraint_type: "text contains", value: q }]];
          if (ccIds.length) sets.push([...extra, { key: "kundföretag", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("Contract", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("Contract", extra); total = filtersActive ? await bubbleCount("Contract", [...dateBase, ...extra]) : await bubbleCount("Contract"); }
        grand_total = await bubbleCount("Contract");
        rows = recs.map((r) => nAvtal(r, m));
      }
      else if (type === "affar") {
        const m = await companyMap();
        const extra = [...personC("deal"), ...(_kategori ? [{ key: "Kategori", constraint_type: "contains", value: _kategori }] : [])];
        let recs;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          const sets = [[...extra, { key: "titel", constraint_type: "text contains", value: q }]];
          if (ccIds.length) sets.push([...extra, { key: "kundföretag", constraint_type: "in", value: ccIds }]);
          recs = (await searchUnion("deal", sets)).sort(byCreated); total = recs.length; recs = recs.slice(cursor, cursor + limit);
        } else { recs = await pageOf("deal", extra); total = filtersActive ? await bubbleCount("deal", [...dateBase, ...extra]) : await bubbleCount("deal"); }
        grand_total = await bubbleCount("deal");
        rows = recs.map((r) => nDeal(r, m));
      }
      else if (type === "offert") {
        const m = await companyMap();
        const dMira = dateC("offertdatum"), dFort = dateC("ft_offer_date"), pDoc = personC("doc");   // affärsdatum + person via affär
        const mBase = [...feMira, ...dMira, ...pDoc], fBase = [...dFort, ...pDoc, ...fortKatC];   // Mira=F&E (skip om annan kategori)
        let miras, forts;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          if (miraCatOk) {
            const mSets = [[...mBase, { key: "offertnr", constraint_type: "text contains", value: q }]];
            if (ccIds.length) mSets.push([...mBase, { key: "kundforetag", constraint_type: "in", value: ccIds }]);
            miras = await searchUnion("Offert", mSets);
          } else miras = [];
          forts = await searchUnion("FortnoxOffer", [
            [...fBase, { key: "ft_customer_name", constraint_type: "text contains", value: q }],
            [...fBase, { key: "ft_document_number", constraint_type: "text contains", value: q }],
          ]);
        } else { miras = miraCatOk ? await pageOf("Offert", mBase) : []; forts = await pageOf("FortnoxOffer", fBase); }
        const durl = await dokUrlMap(miras);
        const omap = await orderMapForOfferts(miras);
        const miraRows = applyOrderStatus(miras.map((r) => nOffertM(r, m, durl)), omap);
        rows = [...miraRows, ...forts.map(nOffertF)].sort((a, b) => _ts(b.date) - _ts(a.date)).slice(0, limit);
        grand_total = (await bubbleCount("Offert", feMira)) + (await bubbleCount("FortnoxOffer"));
        total = !filtersActive ? grand_total : (q ? (miras.length + forts.length)
          : ((miraCatOk ? await bubbleCount("Offert", mBase) : 0) + await bubbleCount("FortnoxOffer", fBase)));
      }
      else if (type === "order") {
        // Order = MiraOrder + FortnoxOrder. HK ligger i FortnoxOrder med
        // connection=TENGELLA sedan §9-cutovern (LIVE 2026-06-08) — den
        // pensionerade `TengellaWorkorder` läses INTE längre (fryst 2026-06-04).
        //
        // ⚠️ TVÅ FRÅGOR MOT SAMMA TABELL, olika datumfält: F&E m.fl. daterar på
        // `ft_delivery_date`, HK på `ft_order_date` (v2-adaptern sätter aldrig
        // leveransdatum). Ett gemensamt datumfönster hade tappat HK helt så fort
        // ett datumfilter var aktivt.
        const m = await companyMap();
        const dMira = dateC("orderdatum"), dFort = dateC("ft_delivery_date"), dHk = dateC("ft_order_date"), pDoc = personC("doc");
        const HK_CONN = [{ key: "connection", constraint_type: "equals", value: TENGELLA_CONNECTION_ID }];
        const EJ_HK = [{ key: "connection", constraint_type: "not in", value: [TENGELLA_CONNECTION_ID] }];
        const mBase = [...dMira, ...pDoc];
        const fBase = [...dFort, ...pDoc, ...fortKatC, ...EJ_HK];    // allt UTOM HK
        const hBase = [...dHk, ...pDoc, ...HK_CONN];                 // bara HK
        const useMira = miraCatOk;
        const useHk = tengCatOk;                                     // kategori Housekeeping
        const useFort = (!_kategori || _kategori !== "Housekeeping");
        let miras, forts, hks;
        if (q) {
          const ccIds = ccIdsMatching(m, q);
          if (useMira) { const mSets = [[...mBase, { key: "ordernr", constraint_type: "text contains", value: q }]]; if (ccIds.length) mSets.push([...mBase, { key: "kundforetag", constraint_type: "in", value: ccIds }]); miras = await searchUnion("MiraOrder", mSets); } else miras = [];
          const fritext = (base) => [
            [...base, { key: "ft_customer_name", constraint_type: "text contains", value: q }],
            [...base, { key: "ft_document_number", constraint_type: "text contains", value: q }],
          ];
          forts = useFort ? await searchUnion("FortnoxOrder", fritext(fBase)) : [];
          hks = useHk ? await searchUnion("FortnoxOrder", fritext(hBase)) : [];
        } else {
          miras = useMira ? await pageOf("MiraOrder", mBase) : [];
          forts = useFort ? await pageOf("FortnoxOrder", fBase) : [];
          hks = useHk ? await pageOf("FortnoxOrder", hBase) : [];
        }
        const combined = [
          ...miras.map((r) => nOrderM(r, m)),
          ...forts.map(nOrderF),
          ...hks.map(nOrderF),
        ].sort((a, b) => _ts(b.date) - _ts(a.date));
        rows = await fyllHkRader(combined.slice(0, limit));   // rader EFTER paginering
        grand_total = (await bubbleCount("MiraOrder")) + (await bubbleCount("FortnoxOrder"));
        total = !filtersActive ? grand_total : (q ? combined.length
          : ((useMira ? await bubbleCount("MiraOrder", mBase) : 0) + (useFort ? await bubbleCount("FortnoxOrder", fBase) : 0) + (useHk ? await bubbleCount("FortnoxOrder", hBase) : 0)));
      }
      else {
        return res.status(400).json({ ok: false, error: "okänd_typ", hint: "type=lead|aktivitet|offert|order|faktura|avtal|affar" });
      }

      // ── ANSVARIG/SKAPARE-berikning ──
      // lead=skapare(Created By), aktivitet=writer (satta i normaliseraren), faktura=ft_our_reference.
      // affär=deal_owner (egen id); offert/order/avtal=affärens ansvarige via kopplat deal (fallback tom).
      const ownerMap = await dealOwnerMap();
      for (const r of rows) {
        if (r.ansvarig) continue;                    // redan satt (lead/akt/faktura)
        if (type === "affar") r.ansvarig = ownerMap.get(r.id) || "";
        else r.ansvarig = (r.deal_id ? (ownerMap.get(r.deal_id) || "") : "");
      }

      return res.json({ ok: true, type, page, limit, q, total, grand_total, filtered: filtersActive, count: rows.length, has_more: rows.length >= limit, from: _from || null, to: _to || null, person: _person || null, kategori: _kategori || null, rows });
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

  // ── NÄSTA STEG (2026-08-21) ────────────────────────────────────────────────
  // Speglar companies_api (kundkortet) — samma grind måste gälla oavsett var man
  // markerar mötet genomfört, annars är kravet bara en UI-artighet i ena vyn.
  // ⚠️ `nasta_steg` är ett NYTT text-fält på activitet_crm. Modulen får RÅ bubblePatch
  // → okänt fält = 400 på HELA skrivningen. Mjuk nedgradering nedan så att mötet
  // alltid sparas även om fältet ännu inte finns i Bubble.
  // ⚠️ TREDJE SKRIVAREN: `salj_api.js` (mötesbokningsvyn) patchar också `genomfört`
  // och har INGEN grind — se handoff. Kravet är alltså inte heltäckande förrän den
  // dörren också stängs.
  const NASTA_STEG = ["aktivitet", "todo", "avslutat"];
  // ⚠️ FÄLTNAMN + TYP verifierade mot Bubble-editorn 2026-08-21 (Christians skärmdump):
  // fältet heter **`aktivitet_nasta_steg`** och är ett **Option Set** med samma namn,
  // värden `aktivitet` · `todo` · `avslutat`. Inte `nasta_steg`, inte text.
  const NASTA_FIELD = "aktivitet_nasta_steg";
  // ⚠️ Option sets läses tillbaka som STRÄNG **eller** som `{display}`-OBJEKT. Ett
  // rakt `String(v)` på objekt-formen ger "[object Object]" — då hade läs-tillbaka-
  // verifieringen nedan flaggat fältet som saknat fast allt sparats rätt. Samma
  // klass av fel som fastighetsnamnen 2026-08-21. Se [[reference-bubble-option-sets]].
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
      console.warn("[nasta_steg] fältet saknas på activitet_crm i Bubble — aktiviteten sparas utan det");
      return { value: await fn(q), missing: true };
    }
  }
  function _nastaStegError(p, wasDone) {
    const nowDone = p["genomfört"] === true;
    if (!nowDone || wasDone) return null;
    const v = _str(p[NASTA_FIELD]).trim();
    if (!v) return { error: "nasta_steg_krävs", allowed: NASTA_STEG,
                     hint: "En aktivitet som markeras genomförd måste ha ett nästa steg: ny aktivitet, todo eller avslutat." };
    if (NASTA_STEG.indexOf(v) < 0) return { error: "okänt_nasta_steg", value: v, allowed: NASTA_STEG };
    return null;
  }

  // ── POST /admin/affar/aktivitet/:id/patch — redigera aktivitet inline ──
  // body {activity_type?, fas?, motesdatum?(YYYY-MM-DD), genomfort?(bool), motesanteckning?, beskrivning?}
  // Skrivnycklar = display-namn (skarpt bekräftat via round-trip 2026-08-07). Patchar bara skickade fält.
  app.options("/admin/affar/aktivitet/:id/patch", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/aktivitet/:id/patch", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const id = req.params.id;
      const b = req.body || {};
      const p = {};
      if (b.activity_type   !== undefined) p["activity_type"]  = _str(b.activity_type) || null;
      if (b.beskrivning     !== undefined) p["beskrivning"]    = _str(b.beskrivning);
      if (b.fas             !== undefined) p["Kundmöte"]       = _str(b.fas) || null;
      if (b.motesdatum      !== undefined) p["Datum_bokning"]  = b.motesdatum ? new Date(_str(b.motesdatum) + "T00:00:00.000Z").toISOString() : null;
      if (b.genomfort       !== undefined) p["genomfört"]      = (b.genomfort === true || b.genomfort === "true");
      if (b.motesanteckning !== undefined) p["mötesantecking"] = _str(b.motesanteckning);
      if (b.nasta_steg      !== undefined) p[NASTA_FIELD]      = _str(b.nasta_steg).trim() || null;
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "inga_fält" });
      // Grinden gäller ÖVERGÅNGEN ej→genomförd → läs radens nuvarande läge först.
      const cur = await bubbleGet("activitet_crm", id).catch(() => null);
      const gErr = _nastaStegError(p, !!(cur && cur["genomfört"] === true));
      if (gErr) return res.status(400).json(Object.assign({ ok: false }, gErr));
      const pw = await _writeOptional((q) => bubblePatch("activitet_crm", id, q), p, NASTA_FIELD);
      const fresh = await bubbleGet("activitet_crm", id).catch(() => null);
      // Läs tillbaka: null = kunde inte verifieras, inte "saknas".
      const verified = fresh ? (_osStr(fresh[NASTA_FIELD]) === _str(p[NASTA_FIELD] || "")) : null;
      const row = fresh ? nAktFull(fresh, await companyMap(), await userMap(), await supplierMap(), await dealMap()) : null;
      return res.json({ ok: true, id, patched: p, row,
                        nasta_steg_field_missing: pw.missing || (verified === false && !!p[NASTA_FIELD]) });
    } catch (e) {
      console.error("[/admin/affar/aktivitet/:id/patch]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/aktivitet/create — ny aktivitet (ersätter Bubble-native-popup) ──
  // body {activity_type, beskrivning, genomfort?, company_id?, deal_id?, fas?, motesdatum?(YYYY-MM-DD), motesanteckning?}
  // Skrivnycklar = display-namn (bekräftade via inline-edit-round-trip 2026-08-07). Koppling
  // (company/deal) valfri → generell skapa; förifylls från affärskortet för deal-koppling.
  app.options("/admin/affar/aktivitet/create", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/aktivitet/create", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubbleCreate) return res.status(501).json({ ok: false, error: "create_not_wired" });
      const b = req.body || {};
      const p = {};
      p["activity_type"] = _str(b.activity_type) || null;
      p["beskrivning"]   = _str(b.beskrivning);
      if (b.company_id !== undefined && _str(b.company_id)) p["company"] = _str(b.company_id);
      if (b.deal_id !== undefined && _str(b.deal_id))       p["deal"]    = _str(b.deal_id);
      if (_str(b.activity_type) === "Kundmöte") {
        if (b.fas !== undefined)             p["Kundmöte"]      = _str(b.fas) || null;
        if (b.motesdatum !== undefined && _str(b.motesdatum)) p["Datum_bokning"] = new Date(_str(b.motesdatum) + "T00:00:00.000Z").toISOString();
        p["genomfört"] = (b.genomfort === true || b.genomfort === "true");
        if (p["genomfört"] && b.motesanteckning !== undefined) p["mötesantecking"] = _str(b.motesanteckning);
      } else if (b.genomfort !== undefined) {
        p["genomfört"] = (b.genomfort === true || b.genomfort === "true");
      }
      // ⚠️ ÄGARSKAP (2026-08-17): se companies_api historik/create. `writer` (User) är
      // enda användbara ägarfältet — "Created By" blir API-nyckelns user via Data API.
      // Utan den saknar mötet ansvarig i mötestratten (salj_api aktRep = writer||Created By).
      const byUser = _str(b.by_user);
      if (byUser) p["writer"] = byUser;
      if (b.nasta_steg !== undefined) p[NASTA_FIELD] = _str(b.nasta_steg).trim() || null;
      if (!p["beskrivning"] && !p["activity_type"]) return res.status(400).json({ ok: false, error: "tom_aktivitet", hint: "kräver minst beskrivning eller typ" });
      const gErr = _nastaStegError(p, false);   // nyskapad som genomförd = en övergång
      if (gErr) return res.status(400).json(Object.assign({ ok: false }, gErr));
      const cw = await _writeOptional((q) => bubbleCreate("activitet_crm", q), p, NASTA_FIELD);
      const id = cw.value;
      if (!id) return res.status(500).json({ ok: false, error: "create_returned_no_id" });
      const fresh = await bubbleGet("activitet_crm", id).catch(() => null);
      const verified = fresh ? (_osStr(fresh[NASTA_FIELD]) === _str(p[NASTA_FIELD] || "")) : null;
      const row = fresh ? nAktFull(fresh, await companyMap(), await userMap(), await supplierMap(), await dealMap()) : null;
      return res.json({ ok: true, id, created: p, row,
                        nasta_steg_field_missing: cw.missing || (verified === false && !!p[NASTA_FIELD]) });
    } catch (e) {
      console.error("[/admin/affar/aktivitet/create]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/todo/create — ny todo/att-göra (ersätter Bubble-native-popup) ──
  // body {titel, beskrivning?, kategori?, status?, starttid?, sluttid?, company_id?, coworker_id?,
  //       user_id?, lead_id?, deal_id?}. Todo-fält bekräftade via skärmdump 2026-08-07.
  // OBS: Todo har INGET deal-fält → affär-koppling sker via Deal.todo-listfält (append).
  app.options("/admin/affar/todo/create", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/todo/create", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubbleCreate) return res.status(501).json({ ok: false, error: "create_not_wired" });
      const b = req.body || {};
      const isoDT = (v) => { const s = _str(v); if (!s) return null; const t = Date.parse(s.length <= 10 ? (s + "T00:00:00.000Z") : s); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
      const p = { "Titel": _str(b.titel) };
      if (!p["Titel"]) return res.status(400).json({ ok: false, error: "titel_krävs" });
      if (b.beskrivning !== undefined) p["Beskrivning"] = _str(b.beskrivning);
      if (_str(b.kategori))    p["Kategori"] = _str(b.kategori);          // Category-OS (display-sträng)
      if (_str(b.status))      p["Status"]   = _str(b.status);           // status_reminder-OS (display-sträng)
      const st = isoDT(b.starttid); if (st) p["Starttid"] = st;
      const en = isoDT(b.sluttid);  if (en) p["Sluttid"]  = en;
      if (_str(b.company_id))  p["Företag"]     = _str(b.company_id);
      if (_str(b.coworker_id)) p["Medarbetare"] = _str(b.coworker_id);
      if (_str(b.user_id))     p["user"]        = _str(b.user_id);
      if (_str(b.lead_id))     p["lead"]        = _str(b.lead_id);
      const id = await bubbleCreate("Todo", p);
      if (!id) return res.status(500).json({ ok: false, error: "create_returned_no_id" });
      // affär-koppling: append till Deal.todo-listfältet (Todo saknar eget deal-fält)
      let deal_linked = false;
      const dealId = _str(b.deal_id);
      if (dealId && bubblePatch) {
        try {
          const deal = await bubbleGet("deal", dealId).catch(() => null);
          if (deal) {
            const cur = Array.isArray(deal.todo) ? deal.todo.map(_ref).filter(Boolean) : (deal.todo ? [_ref(deal.todo)].filter(Boolean) : []);
            if (cur.indexOf(id) === -1) cur.push(id);
            await bubblePatch("deal", dealId, { todo: cur });
            deal_linked = true;
          }
        } catch (e) { /* mjuk-fela: todo skapad även om deal-append fallerar */ }
      }
      return res.json({ ok: true, id, created: p, deal_linked });
    } catch (e) {
      console.error("[/admin/affar/todo/create]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/lead/:id/link — koppla kundföretag / kundansvarig / todo ──
  // body {company_id?, kundansvarig_id?, todo_id?} — tom sträng nollställer fältet.
  app.options("/admin/affar/lead/:id/link", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/lead/:id/link", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const id = req.params.id;
      const b = req.body || {};
      const p = {};
      if (b.company_id      !== undefined) p["client_company"] = _str(b.company_id) || null;
      if (b.kundansvarig_id !== undefined) p["Kundansvarig"]   = _str(b.kundansvarig_id) || null;
      if (b.todo_id         !== undefined) p["todo"]           = _str(b.todo_id) || null;
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "inga_fält" });
      await bubblePatch("Lead", id, p);
      const fresh = await bubbleGet("Lead", id).catch(() => null);
      let row = null;
      if (fresh) {
        row = nLeadFull(fresh, await companyMap(), await userMap(), await companyOwnerMap());
        const tid = row.todo_id;
        if (tid) { const td = await bubbleGet("Todo", tid).catch(() => null); row.todo_title = td ? _str(td.Titel) : ""; }
      }
      return res.json({ ok: true, id, patched: p, row });
    } catch (e) {
      console.error("[/admin/affar/lead/:id/link]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/affar/companies?q= — företagssök via companyMap-cache (koppla) ──
  // Egen route (ej /admin/planning/companies) → samma auth/CORS/cache som feed = pålitligt.
  app.options("/admin/affar/companies", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/companies", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const q = _str(req.query.q).trim().toLowerCase();
      if (q.length < 2) return res.json({ ok: true, rows: [] });
      const m = await companyMap();
      const rows = [];
      for (const [id, nm] of m) { if (nm && String(nm).toLowerCase().indexOf(q) !== -1) rows.push({ id, name: nm }); }
      rows.sort((a, b) => String(a.name).localeCompare(String(b.name), "sv"));
      return res.json({ ok: true, rows: rows.slice(0, 20) });
    } catch (e) {
      console.error("[/admin/affar/companies]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/affar/todos?q= — Todo-titelsök via todoMap-cache (koppla till lead) ──
  // Cache + client-side-filter → ingen constraint-nyckel-gissning (Titel-slug osäker).
  app.options("/admin/affar/todos", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/todos", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const q = _str(req.query.q).trim().toLowerCase();
      if (q.length < 2) return res.json({ ok: true, rows: [] });
      const tm = await todoMap(), cm = await companyMap();
      const rows = [];
      for (const [id, t] of tm) { if (t.title && t.title.toLowerCase().indexOf(q) !== -1) rows.push({ id, title: t.title, company: t.company ? (cm.get(t.company) || "") : "" }); }
      rows.sort((a, b) => String(a.title).localeCompare(String(b.title), "sv"));
      return res.json({ ok: true, rows: rows.slice(0, 20) });
    } catch (e) {
      console.error("[/admin/affar/todos]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/deal/:id/patch — redigera affär (deal) inline ──
  // Scalars + OS(single/list) + refs. Skrivnycklar = display-namn (deal-round-trip 2026-08-07).
  // OS-list Kategori = array av display-strängar; ref-listor kontaktpersoner/todo = array av id.
  app.options("/admin/affar/deal/:id/patch", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/deal/:id/patch", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const id = req.params.id;
      const b = req.body || {};
      const asList = (v) => (Array.isArray(v) ? v.map(_str).filter(Boolean) : (v ? [_str(v)] : []));
      const asNum = (v) => ((v === "" || v == null) ? null : _num(v));
      const p = {};
      if (b.titel        !== undefined) p["titel"]        = _str(b.titel);
      if (b.beskrivning  !== undefined) p["beskrivning"]  = _str(b.beskrivning);
      if (b.status       !== undefined) p["Status"]       = _str(b.status) || null;
      if (b.region       !== undefined) p["Region"]       = _str(b.region) || null;
      if (b.sannolikhet  !== undefined) p["sannolikhet"]  = _str(b.sannolikhet) || null;
      if (b.kategori     !== undefined) p["Kategori"]     = asList(b.kategori);
      if (b.value_brutto !== undefined) p["value_brutto"] = asNum(b.value_brutto);
      if (b.value_netto  !== undefined) p["value_netto"]  = asNum(b.value_netto);
      if (b.kundforetag_id  !== undefined) p["kundföretag"]     = _str(b.kundforetag_id) || null;
      if (b.kontaktpersoner !== undefined) p["kontaktpersoner"] = asList(b.kontaktpersoner);
      if (b.todo            !== undefined) p["todo"]            = asList(b.todo);
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "inga_fält" });
      await bubblePatch("deal", id, p);
      return res.json({ ok: true, id, patched: p });
    } catch (e) {
      console.error("[/admin/affar/deal/:id/patch]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/deal/create — skapa ny affär (deal) + koppla källrad (lead/aktivitet) ──
  // body {titel(obl), beskrivning, kundforetag_id, kategori[], value_brutto, deal_owner, region,
  //       source_type: lead|aktivitet, source_id}. Sätter källradens deal-fält. lead → status Delegerad.
  app.options("/admin/affar/deal/create", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/deal/create", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubbleCreate) return res.status(501).json({ ok: false, error: "create_not_wired" });
      const b = req.body || {};
      const titel = _str(b.titel).trim();
      if (!titel) return res.status(400).json({ ok: false, error: "titel_krävs" });
      const asList = (v) => (Array.isArray(v) ? v.map(_str).filter(Boolean) : (v ? [_str(v)] : []));
      const asNum = (v) => ((v === "" || v == null) ? null : _num(v));
      // deal-payload (skrivnycklar = display-namn, som deal/:id/patch)
      const p = { titel, Status: _str(b.status) || "Kundkontakt" };
      if (b.beskrivning !== undefined) p["beskrivning"] = _str(b.beskrivning);
      const ccId = _str(b.kundforetag_id).trim(); if (ccId) p["kundföretag"] = ccId;
      const kat = asList(b.kategori); if (kat.length) p["Kategori"] = kat;
      const vb = asNum(b.value_brutto); if (vb != null) p["value_brutto"] = vb;
      const owner = _str(b.deal_owner).trim(); if (owner) p["deal_owner"] = [owner];   // deal_owner = List of Users
      const region = _str(b.region).trim(); if (region) p["Region"] = region;

      const dealId = await bubbleCreate("deal", p);
      if (!dealId) return res.status(500).json({ ok: false, error: "deal_create_failed" });
      _dCache.ts = 0;   // invalidera deal-cache → nya affären syns i sök/kedja/kategori

      // koppla källraden (lead/aktivitet) → nya affären (enhetlig deal-modell, som /link)
      const sourceType = _str(b.source_type).toLowerCase();
      const sourceId = _str(b.source_id).trim();
      const SRC_TYPE = { lead: "Lead", aktivitet: "activitet_crm" };
      const bt = SRC_TYPE[sourceType];
      let linked = false, lead_status_set = false;
      if (bt && sourceId && bubblePatch) {
        try { await bubblePatch(bt, sourceId, { deal: dealId }); linked = true; }
        catch (e) { console.warn("[deal/create] koppling misslyckades:", e?.message); }
      }
      // lead → Delegerad (best-effort; ogiltigt OS-värde droppas tyst av Bubble/patch)
      if (sourceType === "lead" && sourceId && bubblePatch) {
        try { await bubblePatch("Lead", sourceId, { status: "Delegerad" }); lead_status_set = true; }
        catch (e) { console.warn("[deal/create] lead-status ej satt:", e?.message); }
      }
      return res.json({ ok: true, deal_id: dealId, titel, linked, lead_status_set });
    } catch (e) {
      console.error("[/admin/affar/deal/create]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/affar/coworkers?company=&q= — kontaktpersoner på ett kundföretag ──
  // Scope:at till affärens kundföretag (Coworker.Kundföretag equals) → snabbt, ingen jättecache.
  app.options("/admin/affar/coworkers", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/coworkers", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const cc = _str(req.query.company).trim();
      const q = _str(req.query.q).trim().toLowerCase();
      if (!cc) return res.json({ ok: true, rows: [], hint: "kräver company-id (koppla kundföretag först)" });
      const recs = await bubbleFind("Coworker", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: cc }], limit: 200 }).catch(() => []);
      let rows = (recs || []).map((c) => ({
        id: bubbleId(c),
        name: ((_str(c["Förnamn"] || c["First Name"]) + " " + _str(c["Efternamn"] || c["Last Name"])).trim() || _str(c.Email || c.email)),
        email: _str(c.Email || c.email),
      }));
      if (q) rows = rows.filter((r) => r.name.toLowerCase().indexOf(q) !== -1 || r.email.toLowerCase().indexOf(q) !== -1);
      rows.sort((a, b) => String(a.name).localeCompare(String(b.name), "sv"));
      return res.json({ ok: true, rows: rows.slice(0, 30) });
    } catch (e) {
      console.error("[/admin/affar/coworkers]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/affar/deals?q= — affärssök för manuell koppling (P3) ──
  app.options("/admin/affar/deals", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/deals", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const q = _str(req.query.q).trim();
      if (q.length < 2) return res.json({ ok: true, rows: [] });
      const m = await companyMap();
      const ccIds = ccIdsMatching(m, q);
      const sets = [[{ key: "titel", constraint_type: "text contains", value: q }]];
      if (ccIds.length) sets.push([{ key: "kundföretag", constraint_type: "in", value: ccIds }]);
      const all = await Promise.all(sets.map((cs) => bubbleFind("deal", { constraints: cs, limit: 20 }).catch(() => [])));
      const seen = new Map();
      for (const arr of all) for (const d of (arr || [])) { const id = bubbleId(d); if (id && !seen.has(id)) seen.set(id, d); }
      const rows = [...seen.values()].slice(0, 20).map((d) => ({
        id: bubbleId(d),
        title: _str(d.titel) || _str(d.Namn) || _str(d.name) || "(namnlös affär)",
        company: cname(m, d["kundföretag"]),
      }));
      return res.json({ ok: true, rows });
    } catch (e) {
      console.error("[/admin/affar/deals]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /admin/affar/doc-search?type=&q= — kandidatdok att koppla in från affärskortet ──
  // Söker EN dok-typ → lättviktiga kandidater {id, source, number, company, amount, deal_id,
  // deal_name, linkable}. Återanvänder samma sök-konstruktion som /list. Mira-order = linkable:false
  // (kopplas via sin offert). FortnoxOrder(TENGELLA) exkluderas (som i liggaren; source→tengella
  // pekar fel bubble-typ). Kopplingen görs sen via POST /admin/affar/link med kortets deal_id.
  app.options("/admin/affar/doc-search", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/doc-search", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const type = _str(req.query.type).toLowerCase();
      const q = _str(req.query.q).trim();
      if (q.length < 2) return res.json({ ok: true, rows: [] });
      const cap = 15;
      const m = await companyMap();
      const dm = await dealMap();
      const ccIds = ccIdsMatching(m, q);
      const feMira = [{ key: "source", constraint_type: "equals", value: SOURCE_MIRA_FE }];
      const out = [];
      const push = (it, linkable) => {
        const did = it.deal_id || null;
        out.push({ id: it.id, source: it.source, number: _str(it.number), company: _str(it.company), amount: (it.amount == null ? null : it.amount), deal_id: did, deal_name: did ? (dm.get(did) || "") : "", linkable: linkable !== false });
      };

      if (type === "offert") {
        const mSets = [[...feMira, { key: "offertnr", constraint_type: "text contains", value: q }]];
        if (ccIds.length) mSets.push([...feMira, { key: "kundforetag", constraint_type: "in", value: ccIds }]);
        const miras = await searchUnionAll("Offert", mSets);
        const forts = await searchUnionAll("FortnoxOffer", [
          [{ key: "ft_customer_name", constraint_type: "text contains", value: q }],
          [{ key: "ft_document_number", constraint_type: "text contains", value: q }],
        ]);
        miras.map((r) => nOffertM(r, m)).forEach((x) => push(x, true));
        forts.map(nOffertF).forEach((x) => push(x, true));
      } else if (type === "order") {
        const mSets = [[{ key: "ordernr", constraint_type: "text contains", value: q }]];
        if (ccIds.length) mSets.push([{ key: "kundforetag", constraint_type: "in", value: ccIds }]);
        const miras = await searchUnionAll("MiraOrder", mSets);
        const forts = await searchUnionAll("FortnoxOrder", [
          [{ key: "ft_customer_name", constraint_type: "text contains", value: q }],
          [{ key: "ft_document_number", constraint_type: "text contains", value: q }],
        ]);
        // HK ingår i `forts` (FortnoxOrder, connection=TENGELLA) sedan §9-cutovern
        // — ingen separat TengellaWorkorder-sökning och ingen exkludering.
        miras.map((r) => nOrderM(r, m)).forEach((x) => push(x, false));           // Mira-order: via offert
        forts.map(nOrderF).forEach((x) => push(x, true));
      } else if (type === "faktura") {
        const forts = await searchUnionAll("FortnoxInvoice", [
          [{ key: "ft_customer_name", constraint_type: "text contains", value: q }],
          [{ key: "ft_document_number", constraint_type: "text contains", value: q }],
        ]);
        forts.map(nInvoice).forEach((x) => push(x, true));
      } else if (type === "avtal") {
        const sets = [[{ key: "contract_title", constraint_type: "text contains", value: q }]];
        if (ccIds.length) sets.push([{ key: "kundföretag", constraint_type: "in", value: ccIds }]);
        const recs = await searchUnionAll("Contract", sets);
        recs.map((r) => nAvtal(r, m)).forEach((x) => push(x, true));
      } else if (type === "lead") {
        const sets = [
          [{ key: "Name", constraint_type: "text contains", value: q }],
          [{ key: "Email", constraint_type: "text contains", value: q }],
          [{ key: "Company", constraint_type: "text contains", value: q }],
        ];
        if (ccIds.length) sets.push([{ key: "client_company", constraint_type: "in", value: ccIds }]);
        const recs = await searchUnionAll("Lead", sets);
        recs.map((r) => nLead(r, m)).forEach((x) => { x.number = _str(x.company) || "Lead"; push(x, true); });
      } else if (type === "aktivitet") {
        const sets = [[{ key: "beskrivning", constraint_type: "text contains", value: q }]];
        if (ccIds.length) sets.push([{ key: "company", constraint_type: "in", value: ccIds }]);
        const recs = await searchUnionAll("activitet_crm", sets);
        recs.map((r) => nAkt(r, m)).forEach((x, i) => { x.number = _str(recs[i].beskrivning).slice(0, 40) || "Aktivitet"; push(x, true); });
      } else {
        return res.status(400).json({ ok: false, error: "okänd_typ", hint: "type=offert|order|faktura|avtal|lead|aktivitet" });
      }

      out.sort((a, b) => String(a.company || "").localeCompare(String(b.company || ""), "sv"));
      return res.json({ ok: true, type, q, rows: out.slice(0, cap) });
    } catch (e) {
      console.error("[/admin/affar/doc-search]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/link — manuell koppling av dok → affär (P3) ──
  // body {row_type, source, id, deal_id}. Sätter dok:ens `deal`-fält (enhetlig modell).
  // tom deal_id = koppla bort. MiraOrder kopplas via sin offert (inget eget deal-fält).
  const LINK_MAP = {
    lead: () => "Lead",
    aktivitet: () => "activitet_crm",
    avtal: () => "Contract",
    faktura: () => "FortnoxInvoice",
    offert: (src) => (src === "fortnox" ? "FortnoxOffer" : "Offert"),
    // ⚠️ HK (src "tengella") pekade tidigare på "TengellaWorkorder" — pensionerad
    // typ. HK-ordrar ÄR FortnoxOrder efter §9-cutovern, så kopplingen ska skrivas
    // på FortnoxOrder. Pekade man fel skrevs deal-kopplingen på en rad som
    // affärsvyn inte längre läser.
    order: (src) => (src === "mira" ? null : "FortnoxOrder"),
  };
  app.options("/admin/affar/link", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/link", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const b = req.body || {};
      const rowType = _str(b.row_type).toLowerCase();
      const source = _str(b.source).toLowerCase();
      const id = _str(b.id).trim();
      const dealId = _str(b.deal_id).trim();
      if (!id) return res.status(400).json({ ok: false, error: "saknar_id" });
      const mapper = LINK_MAP[rowType];
      if (!mapper) return res.status(400).json({ ok: false, error: "okänd_typ", hint: "row_type=lead|aktivitet|offert|avtal|order|faktura" });
      const bubbleType = mapper(source);
      if (!bubbleType) return res.status(400).json({ ok: false, error: "mira_order_via_offert", hint: "Koppla Mira-orderns offert istället." });
      await bubblePatch(bubbleType, id, { deal: dealId || null });
      let deal_name = "";
      if (dealId) { const dm = await dealMap(); deal_name = dm.get(dealId) || ""; }
      return res.json({ ok: true, row_type: rowType, bubble_type: bubbleType, id, deal_id: dealId || null, deal_name });
    } catch (e) {
      console.error("[/admin/affar/link]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/affar/offert/:id/convert — Mira offert → MiraOrder (idempotent) ──
  // Wrappar offert_api:s convertOffertToOrder (samma motor som auto-convert vid signering).
  // Bara Mira-offerter (source=mira_fe); Fortnox hanteras separat (beslut 2026-08-08: avvakta).
  app.options("/admin/affar/offert/:id/convert", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/offert/:id/convert", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!offertConvert) return res.status(501).json({ ok: false, error: "convert_not_wired" });
      const id = req.params.id;
      const off = await bubbleGet("Offert", id).catch(() => null);
      if (!off) return res.status(404).json({ ok: false, error: "offert_not_found" });
      if (_str(off.source) !== SOURCE_MIRA_FE) return res.status(400).json({ ok: false, error: "ej_mira_offert", hint: "Bara Mira-offerter kan konverteras här; Fortnox-offert hanteras i Fortnox." });
      const result = await offertConvert(id);
      if (!result || !result.ok) return res.status(500).json({ ok: false, error: (result && result.error) || "convert_failed" });
      let order_nr = "";
      if (result.order_id) { const mo = await bubbleGet("MiraOrder", result.order_id).catch(() => null); if (mo) order_nr = _str(mo.ordernr); }
      return res.json({ ok: true, order_id: result.order_id || null, order_nr, created: !!result.created, reason: result.reason || null });
    } catch (e) {
      console.error("[/admin/affar/offert/:id/convert]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── ORDER-REDIGERING (Fas 1 produktionsmodul) ────────────────────────────────
  // MiraOrder är redigerbar utan cutoff (beslut #5). Bara source=mira_fe (Fortnox/Tengella=läskopior).
  // Radberäkning speglar offert_api: radsumma = antal*apris*(1-rabatt/100) ex moms; moms = procent.
  const _round2 = (n) => Math.round(_num(n) * 100) / 100;
  const _radsumma = (antal, apris, rabatt) => _round2(_num(antal) * _num(apris) * (1 - _num(rabatt) / 100));
  const STATUS_MIRA_ORDER = ["Bekräftad", "I produktion", "Levererad", "Fakturerad"];
  const _pickAddr = (raw) => { if (raw == null) return ""; if (typeof raw === "string") return raw; return _str(raw.address || raw.Address || raw.formatted_address || raw.name || ""); };

  // Kök-register (id→namn) för kök-väljaren + rad-visning. Cachas som övriga.
  let _kokCache = { rows: null, ts: 0 };
  async function kokList() {
    if (_kokCache.rows && (Date.now() - _kokCache.ts) < CC_TTL) return _kokCache.rows;
    const all = await bubbleFindAll("Kok", {}).catch(() => []);
    const rows = all.map((k) => ({ id: bubbleId(k), namn: _str(k.namn) || _str(k.Namn) || _str(k.name) || "(kök)", aktiv: k.aktiv !== false })).filter((k) => k.id);
    rows.sort((a, b) => String(a.namn).localeCompare(String(b.namn), "sv"));
    _kokCache = { rows, ts: Date.now() };
    return rows;
  }
  async function kokNameMap() { const m = new Map(); for (const k of await kokList()) m.set(k.id, k.namn); return m; }

  // Räkna om orderns totaler ur dess rader (litar aldrig på klienten).
  async function recomputeOrderTotals(orderId) {
    const rows = await bubbleFind("MiraOrderRad", { constraints: [{ key: "order", constraint_type: "equals", value: orderId }], limit: 300 }).catch(() => []);
    let summa = 0, moms = 0;
    for (const r of rows) { const rs = _num(r.radsumma) || _radsumma(r.antal, r.apris, r.rabatt); summa += rs; moms += rs * (_num(r.moms) / 100); }
    summa = _round2(summa); moms = _round2(moms); const total = _round2(summa + moms);
    if (bubblePatch) await bubblePatch("MiraOrder", orderId, { summa, moms_belopp: moms, total }).catch(() => {});
    return { summa, moms_belopp: moms, total };
  }
  async function ensureMiraOrder(id, res) {
    const o = await bubbleGet("MiraOrder", id).catch(() => null);
    if (!o) { res.status(404).json({ ok: false, error: "order_not_found" }); return null; }
    if (_str(o.source) !== SOURCE_MIRA_FE) { res.status(400).json({ ok: false, error: "ej_mira_order", hint: "Bara Mira-ordrar kan redigeras; Fortnox/Tengella är läskopior." }); return null; }
    return o;
  }

  // GET /admin/affar/koks — aktiva kök för kök-väljaren
  app.options("/admin/affar/koks", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/koks", async (req, res) => {
    if (!guard(req, res)) return;
    try { return res.json({ ok: true, rows: await kokList() }); }
    catch (e) { console.error("[/admin/affar/koks]", e?.message); return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // GET /admin/affar/order/:id — order (redigerbart huvud) + rader + kök-lista + status-val
  app.options("/admin/affar/order/:id", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/affar/order/:id", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const o = await ensureMiraOrder(req.params.id, res); if (!o) return;
      const rows = await bubbleFind("MiraOrderRad", { constraints: [{ key: "order", constraint_type: "equals", value: req.params.id }], limit: 300 }).catch(() => []);
      rows.sort((a, b) => _num(a.radnr) - _num(b.radnr));
      const m = await companyMap(); const km = await kokNameMap(); const um = await userMap();
      // Vår referens (#1): MiraOrder.var_referens (User) om satt, annars offert→deal→ägare som default.
      const vrId = _ref(o.var_referens) || "";
      let defOwnerId = "";
      if (!vrId && _ref(o.offert)) {
        const off = await bubbleGet("Offert", _ref(o.offert)).catch(() => null);
        const did = off ? _ref(off.deal) : "";
        if (did) defOwnerId = (await _loadDeals()).ownerId.get(did) || "";
      }
      const usersArr = [...um.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "sv"));
      return res.json({
        ok: true,
        order: {
          id: bubbleId(o), ordernr: _str(o.ordernr), orderdatum: _day(o.orderdatum),
          orderstatus: _str(o.orderstatus) || "Bekräftad", company: cname(m, o.kundforetag),
          leveransdatum: _day(o.leveransdatum), leveranstid: _str(o.leveranstid),
          leveransadress: _pickAddr(o.leveransadress),   // read-only (geo-skriv via API opålitligt)
          betalningsvillkor: _str(o.betalningsvillkor), momstyp: _str(o.momstyp), valuta: _str(o.valuta) || "SEK",
          villkor_text: _str(o.villkor_text), intern_instruktion: _str(o.intern_instruktion),
          summa: _num(o.summa), moms_belopp: _num(o.moms_belopp), total: _num(o.total),
          var_referens: vrId, var_referens_name: (vrId ? (um.get(vrId) || "") : ""),
          var_referens_default: defOwnerId, var_referens_default_name: (defOwnerId ? (um.get(defOwnerId) || "") : ""),
          klar_for_leverans: (o.klar_for_leverans === true),   // Bubble-fält: MiraOrder.klar_for_leverans (yes/no)
        },
        users: usersArr,
        rows: rows.map((r) => ({
          id: bubbleId(r), radnr: _num(r.radnr), artikelnr: _str(r.artikelnr), benamning: _str(r.benamning),
          beskrivning_long: _str(r.beskrivning_long), antal: _num(r.antal), enhet: _str(r.enhet),
          apris: _num(r.apris), rabatt: _num(r.rabatt), moms: _num(r.moms), radsumma: _num(r.radsumma),
          kok_id: _ref(r.kok) || "", kok_namn: (_ref(r.kok) ? (km.get(_ref(r.kok)) || "") : ""), prep_kategori: _str(r.prep_kategori),
        })),
        status_options: STATUS_MIRA_ORDER, koks: await kokList(),
      });
    } catch (e) { console.error("[/admin/affar/order/:id]", e?.message, e?.detail); return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // POST /admin/affar/order/:id/patch — huvudfält. Ändrat leveransdatum → uppdatera radernas leverans_ts.
  app.options("/admin/affar/order/:id/patch", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/order/:id/patch", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const id = req.params.id; const b = req.body || {};
      const o = await ensureMiraOrder(id, res); if (!o) return;
      const p = {}; let levChanged = false, newTs = null;
      if (b.leveransdatum !== undefined) {
        if (_str(b.leveransdatum)) { const iso = new Date(_str(b.leveransdatum) + "T00:00:00.000Z").toISOString(); p["leveransdatum"] = iso; newTs = Date.parse(iso); p["leverans_ts"] = newTs; }
        else { p["leveransdatum"] = null; p["leverans_ts"] = null; }
        levChanged = true;
      }
      if (b.leveranstid !== undefined)      p["leveranstid"]      = _str(b.leveranstid);
      if (b.orderstatus !== undefined)      p["orderstatus"]      = _str(b.orderstatus) || null;
      if (b.betalningsvillkor !== undefined) p["betalningsvillkor"] = _str(b.betalningsvillkor);
      if (b.momstyp !== undefined)          p["momstyp"]          = _str(b.momstyp);
      if (b.valuta !== undefined)           p["valuta"]           = _str(b.valuta);
      if (b.villkor_text !== undefined)     p["villkor_text"]     = _str(b.villkor_text);
      if (b.intern_instruktion !== undefined) p["intern_instruktion"] = _str(b.intern_instruktion);   // Bubble-fält: MiraOrder.intern_instruktion (text)
      if (b.var_referens !== undefined)     p["var_referens"]     = (_str(b.var_referens) || null);   // Bubble-fält: MiraOrder.var_referens (User)
      if (b.klar_for_leverans !== undefined) p["klar_for_leverans"] = (b.klar_for_leverans === true || b.klar_for_leverans === "true");   // Bubble-fält: MiraOrder.klar_for_leverans (yes/no)
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "inga_fält" });
      await bubblePatch("MiraOrder", id, p);
      let rows_touched = 0;
      if (levChanged) {
        const rows = await bubbleFind("MiraOrderRad", { constraints: [{ key: "order", constraint_type: "equals", value: id }], limit: 300 }).catch(() => []);
        for (const r of rows) { await bubblePatch("MiraOrderRad", bubbleId(r), { leverans_ts: newTs }).catch(() => {}); rows_touched++; }
      }
      return res.json({ ok: true, patched: p, rows_touched });
    } catch (e) { console.error("[/admin/affar/order/:id/patch]", e?.message, e?.detail); return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // POST /admin/affar/order/row/:rowId/patch — redigera rad (inkl kök + prep). Räknar om rad + totaler.
  app.options("/admin/affar/order/row/:rowId/patch", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/order/row/:rowId/patch", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubblePatch) return res.status(501).json({ ok: false, error: "patch_not_wired" });
      const rowId = req.params.rowId; const b = req.body || {};
      const rad = await bubbleGet("MiraOrderRad", rowId).catch(() => null);
      if (!rad) return res.status(404).json({ ok: false, error: "rad_not_found" });
      const orderId = _ref(rad.order);
      const p = {};
      if (b.benamning !== undefined)        p["benamning"]        = _str(b.benamning);
      if (b.beskrivning_long !== undefined) p["beskrivning_long"] = _str(b.beskrivning_long);
      if (b.enhet !== undefined)            p["enhet"]            = _str(b.enhet);
      if (b.antal !== undefined)            p["antal"]            = _num(b.antal);
      if (b.apris !== undefined)            p["apris"]            = _num(b.apris);
      if (b.rabatt !== undefined)           p["rabatt"]           = _num(b.rabatt);
      if (b.moms !== undefined)             p["moms"]             = _num(b.moms);
      if (b.kok_id !== undefined)           p["kok"]              = _str(b.kok_id) || null;
      if (b.prep_kategori !== undefined)    p["prep_kategori"]    = _str(b.prep_kategori) || null;
      const antal = b.antal !== undefined ? _num(b.antal) : _num(rad.antal);
      const apris = b.apris !== undefined ? _num(b.apris) : _num(rad.apris);
      const rabatt = b.rabatt !== undefined ? _num(b.rabatt) : _num(rad.rabatt);
      p["radsumma"] = _radsumma(antal, apris, rabatt);
      await bubblePatch("MiraOrderRad", rowId, p);
      const totals = orderId ? await recomputeOrderTotals(orderId) : null;
      const km = await kokNameMap();
      return res.json({ ok: true, radsumma: p.radsumma, kok_namn: (p.kok ? (km.get(p.kok) || "") : ""), totals });
    } catch (e) { console.error("[/admin/affar/order/row/:rowId/patch]", e?.message, e?.detail); return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // POST /admin/affar/order/:id/row/add — lägg till rad (valfri product/benämning). Räknar om totaler.
  app.options("/admin/affar/order/:id/row/add", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/order/:id/row/add", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubbleCreate) return res.status(501).json({ ok: false, error: "create_not_wired" });
      const id = req.params.id; const b = req.body || {};
      const o = await ensureMiraOrder(id, res); if (!o) return;
      const existing = await bubbleFind("MiraOrderRad", { constraints: [{ key: "order", constraint_type: "equals", value: id }], limit: 300 }).catch(() => []);
      const maxRad = existing.reduce((mx, r) => Math.max(mx, _num(r.radnr)), 0);
      const antal = _num(b.antal) || 1, apris = _num(b.apris), rabatt = 0;
      const p = {
        order: id, offert: _ref(o.offert) || null, radnr: maxRad + 1, product: _str(b.product_id) || null,
        artikelnr: _str(b.artikelnr), benamning: _str(b.benamning), beskrivning_long: _str(b.beskrivning_long),
        antal, enhet: _str(b.enhet), apris, rabatt, moms: (b.moms !== undefined ? _num(b.moms) : 12),
        radsumma: _radsumma(antal, apris, rabatt), konto: null, ks: null,
        kok: _str(b.kok_id) || null, prep_kategori: _str(b.prep_kategori) || null, leverans_ts: _num(o.leverans_ts) || null,
      };
      const rowId = await bubbleCreate("MiraOrderRad", p);
      const totals = await recomputeOrderTotals(id);
      return res.json({ ok: true, row_id: rowId, radnr: maxRad + 1, radsumma: p.radsumma, totals });
    } catch (e) { console.error("[/admin/affar/order/:id/row/add]", e?.message, e?.detail); return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // POST /admin/affar/order/row/:rowId/delete — ta bort rad + räkna om totaler
  app.options("/admin/affar/order/row/:rowId/delete", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/order/row/:rowId/delete", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!bubbleDelete) return res.status(501).json({ ok: false, error: "delete_not_wired" });
      const rowId = req.params.rowId;
      const rad = await bubbleGet("MiraOrderRad", rowId).catch(() => null);
      if (!rad) return res.status(404).json({ ok: false, error: "rad_not_found" });
      const orderId = _ref(rad.order);
      await bubbleDelete("MiraOrderRad", rowId);
      const totals = orderId ? await recomputeOrderTotals(orderId) : null;
      return res.json({ ok: true, totals });
    } catch (e) { console.error("[/admin/affar/order/row/:rowId/delete]", e?.message, e?.detail); return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // POST /admin/affar/order/:id/render-pdf?kind=order|pm — kund-order-PDF resp. kök-PM.
  app.options("/admin/affar/order/:id/render-pdf", (req, res) => { planningCors && planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/affar/order/:id/render-pdf", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!renderOrderPdf) return res.status(501).json({ ok: false, error: "render_not_wired" });
      const kind = (_str(req.query.kind) || _str((req.body || {}).kind) || "order").toLowerCase() === "pm" ? "pm" : "order";
      const o = await ensureMiraOrder(req.params.id, res); if (!o) return;
      const result = await renderOrderPdf(req.params.id, kind);
      if (!result || !result.ok) return res.status(500).json({ ok: false, error: (result && result.error) || "render_failed" });
      return res.json({ ok: true, kind, file_url: String(result.file_url || "").replace(/^\/\//, "https://") });
    } catch (e) {
      console.error("[/admin/affar/order/:id/render-pdf]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  console.log("[affar_api] routes registered (/admin/affar/*)");
}
