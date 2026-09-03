// landlord_api.js — Mira Fastighet (/fastighet). Fastighetsägarens vy av servicelivet
// i sitt bestånd. DI-mönster som visitor_api.js / companies_api.js.
//
// ⚠️ SCOPE ÄR SÄKERHETEN. Varje endpoint:
//   1. landlordAuth.authed(req) → payload eller 401
//   2. resolveScope(payload, begärd fastighet) → lista eller 403
//   3. ALLA Bubble-frågor filtrerar mot den listan
// Lita ALDRIG på ett fastighets-id från klienten utan att skära mot tokenen.
// Utanför scope = 403, aldrig tom lista (tyst tomt döljer buggar).
//
// ⚠️ INTEGRITETSREGELN (handoff/FASTIGHETSAGARVYN.md §4) — den viktigaste regeln här:
//   Ägaren ser HUSET. Hyresgästen äger sitt eget innehåll.
//   • Ägarens EGNA ärenden (Matter.Kundföretag == ägarens egen ClientCompany): full detalj.
//   • Alla andras: BARA aggregat — volym, avvikelsegrad, kategori, lösttid.
//     Aldrig rubrik, aldrig beskrivning, aldrig person.
//   Hyresgästen är VÅR kund. Att skicka den relationens innehåll till hyresvärden är
//   att sälja den. `nMatterAgg()` nedan får aldrig växa med ett fritextfält.
//
// ⚠️ INGA BELOPP. Aldrig. Inte månadskostnad, inte ordervärde, inte avtalspris.
//   `Contract.månadskostnad` läses medvetet INTE — den finns i raden vi hämtar,
//   och det är precis därför regeln står här och inte bara i handoffen.
//
// ⚠️ INGEN TOTALSUMMA över de tre affärsområdena (BOKNINGSLAGE-regeln). Ett städpass,
//   en F&E-leverans och ett månadsuppdrag är olika enheter.
//
// WU: hela overviewen byggs EN gång per hyresvärd och cachas (SWR, OVERVIEW_TTL).
//   ⚠️ Lägg ALDRIG en setInterval på bygget — den fällan kostade ~13 000 WU/dygn i augusti.

// Bubble-fältnamn samlade. ⚠️ Case-sensitivt. Läs/skriv = DISPLAY-namn,
// constraints = SLUG — de skiljer sig (se `C_` nedan). [[reference-bubble-data-api-keys]]
export const LL = {
  F_TITEL: "Titel",              // Fastighet. ⚠️ INTE `Namn` — det fältet finns inte.
  F_ADRESS: "Adress",            // geografiskt OBJEKT, inte text
  CC_NAMN: "Name_company",
  CC_FASTIGHET: "Fastighet",     // List of Fastighet — den kanoniska vägen hus→hyresgäst
  O_TITEL: "Office_title",
  O_FASTIGHET: "Fastighet",
  O_YTA: "Yta",
  O_ARBETSPLATSER: "Arbetsplatser",
  M_RUBRIK: "Rubrik",
  M_PRIO: "Prioritet",
  M_STATUS: "status",            // lowercase s
  M_AVVIKELSE: "Avvikelse",
  M_KONTOR: "Kontor",
  QC_DATUM: "kontrolldatum",
  QC_KONTOR: "Kontor",
  K_BETYG: "Betyg",              // Kommentar - Comment → Grade
  K_QC: "kvalitetskontroll",
  K_INTERN: "Intern_lokal",
  K_MOTES: "Mötesrum",
  G_VARDE: "Värde",              // Grade
  CT_KATEGORI: "kategori",       // Contract. lowercase k
  CT_SLUT: "slutdatum",
};
// Constraint-nycklar (slugar). Verifierade i companies_api.js.
export const C = {
  CC_FASTIGHET: "Fastighet",     // ClientCompany, contains  (visitor_api.js, skarpt verifierad)
  O_KUND: "Kundföretag",         // Office            (companies_api.js:2540)
  M_KUND: "Kundföretag",         // Matter            (companies_api.js:2620)
  QC_KUND: "Kundföretag",        // QualityControl    (companies_api.js:2724)
  CT_KUND: "kundföretag",        // Contract — ⚠️ LOWERCASE k (companies_api.js:2546)
  K_QC: "kvalitetskontroll",     // Kommentar - Comment
};
const KOMMENTAR_TYPE = "Kommentar - Comment";   // ⚠️ typnamn med mellanslag OCH bindestreck

export function registerLandlordRoutes(app, deps) {
  const {
    bubbleFindAll, bubbleGet, bubbleId,
    landlordAuth, planningCors, publicRateLimited, clientIp,
  } = deps;

  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : bubbleId(v)));
  const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const _day = (v) => { const d = v ? new Date(v) : null; return (d && !isNaN(d.getTime())) ? d.toISOString().slice(0, 10) : ""; };
  const _list = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  // Option set kan komma som sträng ELLER {display}. Samma normalisering som _users().
  const _os = (v) => (v == null ? "" : (typeof v === "string" ? v : _str(v.display || v.Display)));
  // ⚠️ Geo-objekt får ALDRIG bli ett namn via implicit stringifiering — då står det
  //    "[object Object]" i vyn. Samma bugg som slog på Fastighet.Adress 2026-08-21.
  const _adr = (v) => { if (!v) return ""; return typeof v === "string" ? v : _str(v.address); };
  const _clean = (v) => { if (v == null || typeof v === "object") return ""; const s = _str(v).trim(); return s === "[object Object]" ? "" : s; };
  const fastighetName = (f) => _clean(f[LL.F_TITEL]) || _adr(f[LL.F_ADRESS]) || "";

  function cors(req, res) { if (planningCors) planningCors(req, res); }

  // Gate: token → payload. Returnerar null och svarar 401 om den saknas/är ogiltig.
  function gate(req, res) {
    cors(req, res);
    const p = landlordAuth && landlordAuth.authed ? landlordAuth.authed(req) : null;
    if (!p) { res.status(401).json({ ok: false, error: "unauthorized" }); return null; }
    if (publicRateLimited && clientIp && publicRateLimited("landlord:" + clientIp(req), 600, 60 * 60 * 1000, "landlord")) {
      res.status(429).json({ ok: false, error: "rate_limited" }); return null;
    }
    return p;
  }
  // Scope: begärd fastighet måste ligga i tokenen. Utanför → 403 (aldrig tom lista).
  function scope(p, req, res) {
    const list = landlordAuth.resolveScope(p, _str(req.query.fastighet).trim());
    if (!list || !list.length) { res.status(403).json({ ok: false, error: "outside_scope" }); return null; }
    return list;
  }
  const inC = (key, ids) => (ids.length === 1
    ? { key, constraint_type: "equals", value: ids[0] }
    : { key, constraint_type: "in", value: ids });

  // ── Hyresgäster per fastighet (TTL-cache) ─────────────────────────────────
  // ⚠️ Kundlistan HÄRLEDS ur `ClientCompany.Fastighet contains <id>` — INTE ur
  //    `Fastighet.Hyresgäster`. Det fältet finns i schemat men skrivs aldrig av vår
  //    kod → kan vara tomt/stale. Scopar man via det blir kundlistan tyst fel.
  //    Bubble saknar OR → en fråga per fastighet. Med 2–20 hus är det bundet.
  const TENANT_TTL = 10 * 60 * 1000;
  const _tenantCache = new Map();
  async function tenantsFor(fid) {
    const hit = _tenantCache.get(fid);
    if (hit && (Date.now() - hit.ts) < TENANT_TTL) return hit.list;
    // Ingen .catch(()=>[]) — ett trasigt svar ska braka, inte se ut som "inga hyresgäster".
    const rows = await bubbleFindAll("ClientCompany", { constraints: [{ key: C.CC_FASTIGHET, constraint_type: "contains", value: fid }] });
    const list = (rows || []).map((c) => ({ id: bubbleId(c), namn: _str(c[LL.CC_NAMN] || c.name || c.Name), fastighet: fid }))
      .filter((c) => c.id && c.namn);
    list.sort((a, b) => a.namn.localeCompare(b.namn, "sv"));
    _tenantCache.set(fid, { list, ts: Date.now() });
    return list;
  }
  function tenantsForget() { _tenantCache.clear(); }

  // ── Grade-skalan (liten typ, cachas hårt) ─────────────────────────────────
  let _gradeCache = { map: null, ts: 0 };
  async function gradeMap() {
    if (_gradeCache.map && (Date.now() - _gradeCache.ts) < 60 * 60 * 1000) return _gradeCache.map;
    const rows = await bubbleFindAll("Grade", {}).catch(() => []);
    const m = new Map();
    for (const g of (rows || [])) { const id = bubbleId(g); const v = _num(g[LL.G_VARDE]); if (id && v != null) m.set(id, v); }
    _gradeCache = { map: m, ts: Date.now() };
    return m;
  }

  // ── Ägarens EGNA ClientCompany ────────────────────────────────────────────
  // ⚠️ Fältet på Hyresvärd heter "Fastighetsägare - (1) för…" och är AVKLIPPT i
  //    Bubble-editorns inmatningsruta — det fulla namnet går inte att läsa av där
  //    ([[reference-bubble-id-truncation]], fast på ett fältnamn). Att hårdkoda en
  //    gissning hade gett `undefined` → ägaren såg noll egna ärenden, tyst.
  //    Vi letar därför upp nyckeln PÅ RADEN vid körning.
  function ownCompanyId(hvRow) {
    if (!hvRow) return null;
    for (const key of Object.keys(hvRow)) {
      if (key.toLowerCase().indexOf("fastighetsägare") !== 0) continue;
      const id = _ref(hvRow[key]);
      if (id) return id;
    }
    return null;
  }

  // ══════════════ GET /landlord/context ══════════════
  // Vem ägaren är + vilka hus tokenen bär. Billig: en bubbleGet per hus.
  app.options("/landlord/context", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/landlord/context", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    try {
      const hvRow = await bubbleGet("Hyresvärd", p.hv).catch(() => null);
      const fastigheter = [];
      for (const id of p.fast) {
        const f = await bubbleGet("Fastighet", id).catch(() => null);
        if (!f) continue;
        const t = await tenantsFor(id).catch(() => []);
        fastigheter.push({ id, namn: fastighetName(f) || "(namnlös fastighet)", adress: _adr(f[LL.F_ADRESS]), hyresgaster: t.length });
      }
      fastigheter.sort((a, b) => a.namn.localeCompare(b.namn, "sv"));
      return res.json({
        ok: true,
        hyresvard: { id: p.hv, namn: hvRow ? _str(hvRow.Namn || hvRow.name || hvRow.Name) : "" },
        user: _str(p.name),
        fastigheter,
        antal_hyresgaster: fastigheter.reduce((a, f) => a + f.hyresgaster, 0),
      });
    } catch (e) {
      console.error("[/landlord/context]", e && e.message);
      return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // ══════════════ Overview-bygget ══════════════
  // Byggs för HELA beståndet och filtreras sedan per hus i svaret. Skälet är WU:
  // ett bygge per hyresvärd cachas och betjänar både "hela beståndet" och varje
  // enskilt hus. Bygger man per urval blir det ett nytt svep varje gång ägaren
  // klickar en rad.
  const OVERVIEW_TTL = 10 * 60 * 1000;
  const _ovCache = new Map();    // hv → { data, ts, building }

  async function buildOverview(hv, fastIds) {
    const anrop = { bubbleGet: 0, bubbleFindAll: 0 };
    const hvRow = await bubbleGet("Hyresvärd", hv).catch(() => null); anrop.bubbleGet++;
    const agarCc = ownCompanyId(hvRow);

    // 1. Husen
    const hus = [];
    for (const id of fastIds) {
      const f = await bubbleGet("Fastighet", id).catch(() => null); anrop.bubbleGet++;
      if (f) hus.push({ id, namn: fastighetName(f) || "(namnlös fastighet)", adress: _adr(f[LL.F_ADRESS]) });
    }

    // 2. Hyresgäster per hus (cachad) → platt lista + hus-uppslag
    const husAvCc = new Map();          // cc-id → fastighet-id
    const tenants = [];
    for (const h of hus) {
      const list = await tenantsFor(h.id); anrop.bubbleFindAll++;
      for (const t of list) { if (!husAvCc.has(t.id)) husAvCc.set(t.id, h.id); tenants.push(t); }
    }
    const ccIds = Array.from(new Set(tenants.map((t) => t.id)));

    const tomt = {
      hus, tenants, husAvCc, agarCc,
      offices: [], matters: [], qcs: [], comments: [], contracts: [],
      gm: new Map(), rumNamn: new Map(), anrop,
    };
    if (!ccIds.length) return tomt;

    // 3. Ett anrop per typ, alla hyresgäster på en gång (`in`).
    const [offices, matters, qcs, contracts, gm] = await Promise.all([
      bubbleFindAll("Office", { constraints: [inC(C.O_KUND, ccIds)] }).catch(() => []),
      bubbleFindAll("Matter", { constraints: [inC(C.M_KUND, ccIds)] }).catch(() => []),
      bubbleFindAll("QualityControl", { constraints: [inC(C.QC_KUND, ccIds)] }).catch(() => []),
      bubbleFindAll("Contract", { constraints: [inC(C.CT_KUND, ccIds)] }).catch(() => []),
      gradeMap(),
    ]);
    anrop.bubbleFindAll += 4;

    // 4. Ytbetygen. ⚠️ Cappad: `in` med hundratals id:n är både långsamt och skört.
    //    De senaste 200 kontrollerna räcker för ett snitt — och svaret säger hur många
    //    som faktiskt låg till grund, så ingen tror att det är hela historiken.
    const qcSorted = (qcs || []).slice().sort((a, b) =>
      (Date.parse(b[LL.QC_DATUM] || b["Created Date"]) || 0) - (Date.parse(a[LL.QC_DATUM] || a["Created Date"]) || 0));
    const qcIds = qcSorted.slice(0, 200).map(bubbleId).filter(Boolean);
    let comments = [];
    if (qcIds.length) {
      comments = await bubbleFindAll(KOMMENTAR_TYPE, { constraints: [inC(C.K_QC, qcIds)] }).catch(() => []);
      anrop.bubbleFindAll++;
    }

    // 5. Rumsnamn för ytatyp-nedbrytningen. bubbleGet per unikt rum, cappat.
    //    Det är ett medvetet N — men N är antalet DISTINKTA rum i beståndet, en gång
    //    per cachefönster, inte per rad och inte per sidladdning.
    const rumIds = Array.from(new Set((comments || [])
      .map((k) => _ref(k[LL.K_INTERN]) || _ref(k[LL.K_MOTES])).filter(Boolean))).slice(0, 150);
    const rumNamn = new Map();
    await Promise.all(rumIds.map(async (id) => {
      let r = await bubbleGet("Internal_room", id).catch(() => null); anrop.bubbleGet++;
      if (r) { rumNamn.set(id, _str(r.Namn || r.name)); return; }
      r = await bubbleGet("MeetingRoom", id).catch(() => null); anrop.bubbleGet++;
      if (r) rumNamn.set(id, _str(r.Name || r.Namn));
    }));

    return { hus, tenants, husAvCc, agarCc, offices: offices || [], matters: matters || [],
             qcs: qcSorted, comments: comments || [], contracts: contracts || [], gm, rumNamn, anrop };
  }

  // SWR: stale serveras direkt, refresh i bakgrunden. ⚠️ ALDRIG en setInterval här.
  async function overview(hv, fastIds) {
    const hit = _ovCache.get(hv);
    const farsk = hit && (Date.now() - hit.ts) < OVERVIEW_TTL;
    if (farsk) return { data: hit.data, cache: "hit" };
    if (hit && !hit.building) {
      hit.building = buildOverview(hv, fastIds)
        .then((d) => { _ovCache.set(hv, { data: d, ts: Date.now(), building: null }); return d; })
        .catch(() => { const cur = _ovCache.get(hv); if (cur) cur.building = null; });
      return { data: hit.data, cache: "stale" };
    }
    if (hit && hit.building) return { data: hit.data, cache: "stale" };
    const d = await buildOverview(hv, fastIds);
    _ovCache.set(hv, { data: d, ts: Date.now(), building: null });
    return { data: d, cache: "miss" };
  }
  function overviewForget() { _ovCache.clear(); }

  // ── Projektioner ──────────────────────────────────────────────────────────
  const oppen = (m) => _str(m[LL.M_STATUS]).toLowerCase() === "pågående";
  const alderDgr = (m) => {
    const d = Date.parse(m["Created Date"]); if (!d) return 0;
    return Math.max(0, Math.round((Date.now() - d) / 86400000));
  };
  // Medeltid till stängning, i dagar. Bara på STÄNGDA ärenden — att räkna in öppna
  // hade blandat "hur snabbt vi löser" med "hur länge det legat".
  function mtts(list) {
    const d = [];
    for (const m of list) {
      if (oppen(m)) continue;
      const a = Date.parse(m["Created Date"]), b = Date.parse(m.closed_date || m["Modified Date"]);
      if (!a || !b || b < a) continue;
      d.push((b - a) / 86400000);
    }
    if (!d.length) return null;
    return Math.round((d.reduce((x, y) => x + y, 0) / d.length) * 10) / 10;
  }
  // Kategori ur prioritet/avvikelse — det grövsta vi kan säga UTAN att röja innehåll.
  const kategori = (m) => (m[LL.M_AVVIKELSE] === true ? "Avvikelse" : (_os(m[LL.M_PRIO]) || "Övrigt"));

  // Snittbetyg = medel av Grade.Värde. Samma sanning som kundkortet visar.
  // ⚠️ `Betyg_lev` används INTE — det fältet är aldrig verifierat mot skarp data
  //    (FORETAG-KUNDKORT-DRIFT.md). Ett osäkert fält är värre än ett saknat.
  function betygFor(qcIdSet, D) {
    const v = [];
    for (const k of D.comments) {
      const qid = _ref(k[LL.K_QC]); if (!qcIdSet.has(qid)) continue;
      const g = D.gm.get(_ref(k[LL.K_BETYG]));
      if (g != null) v.push(g);
    }
    if (!v.length) return { snitt: null, underlag: 0 };
    return { snitt: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10, underlag: v.length };
  }

  function project(D, scopeIds) {
    const inScope = new Set(scopeIds);
    const ccInScope = new Set();
    for (const [cc, f] of D.husAvCc) if (inScope.has(f)) ccInScope.add(cc);
    // ⚠️ Ägarens EGET bolag är inte en hyresgäst hos sig själv. Det ligger i
    //    `ClientCompany.Fastighet` för sina egna hus (så att receptionen och driften
    //    hittar det), men räknas man in det blir "hyresgäster" en för många,
    //    tjänstetäckningen utspädd och ägaren en rad i sin egen tjänstekarta.
    //    Det stannar i `ccInScope` — annars tappas ägarens egna ärenden.
    const hg = D.tenants.filter((t) => inScope.has(t.fastighet) && t.id !== D.agarCc);
    const hgIds = Array.from(new Set(hg.map((t) => t.id)));

    // Office → hus. `Office.Fastighet` läses, men huset härleds i första hand ur
    // hyresgästens fastighet — Office.Fastighet är inte alltid satt.
    // ⚠️ Kontor → hus byggs över HELA beståndet, inte över urvalet. Filtrerar man här
    //    tappar kartan de kontor som ligger utanför urvalet — och då faller ett ärende
    //    därifrån tillbaka på hyresgästens första hus och blir felbokfört PÅ det valda
    //    huset. Husfiltret hade sett ut att fungera medan det räknade fel.
    //    `Office.Fastighet` går före hyresgästens hus: kontoret vet var det står.
    const husAvKontor = new Map();
    for (const o of D.offices) {
      const fid = _ref(o[LL.O_FASTIGHET]) || D.husAvCc.get(_ref(o["Kundföretag"]));
      if (fid) husAvKontor.set(bubbleId(o), fid);
    }
    const kvmPerHus = new Map(), aplPerHus = new Map();
    for (const o of D.offices) {
      const cc = _ref(o["Kundföretag"]); if (!ccInScope.has(cc)) continue;
      const fid = husAvKontor.get(bubbleId(o));
      if (!fid || !inScope.has(fid)) continue;
      kvmPerHus.set(fid, (kvmPerHus.get(fid) || 0) + (_num(o[LL.O_YTA]) || 0));
      aplPerHus.set(fid, (aplPerHus.get(fid) || 0) + (_num(o[LL.O_ARBETSPLATSER]) || 0));
    }

    // Ärenden, delade enligt integritetsregeln.
    // ⚠️ Huset härleds i FÖRSTA hand ur `Matter.Kontor` → Office → Fastighet.
    //    Hyresgästens fastighetslista duger inte som enda väg: en hyresgäst med kontor
    //    i två hus hade då fått ALLA sina ärenden bokförda på det första huset — och
    //    ett husfilter som inte filtrerar ser ut att fungera.
    const egna = [], perHus = new Map();
    for (const m of D.matters) {
      const cc = _ref(m["Kundföretag"]); if (!ccInScope.has(cc)) continue;
      const fid = husAvKontor.get(_ref(m[LL.M_KONTOR])) || D.husAvCc.get(cc);
      if (!fid || !inScope.has(fid)) continue;
      let b = perHus.get(fid);
      if (!b) { b = { oppna: 0, avv: 0, kat: new Map(), alla: [] }; perHus.set(fid, b); }
      b.alla.push(m);
      if (oppen(m)) { b.oppna++; if (m[LL.M_AVVIKELSE] === true) b.avv++; }
      // ⚠️ ENDA stället där ett ärendes RUBRIK lämnar servern — och bara när raden
      //    tillhör ägarens egen ClientCompany. Villkoret får aldrig lättas upp.
      if (D.agarCc && cc === D.agarCc && oppen(m)) {
        egna.push({
          id: bubbleId(m), hus: fid, rubrik: _str(m[LL.M_RUBRIK]) || "(utan rubrik)",
          prio: _os(m[LL.M_PRIO]) || "—", status: _str(m[LL.M_STATUS]),
          avvikelse: m[LL.M_AVVIKELSE] === true, dgr: alderDgr(m),
        });
      }
    }
    egna.sort((a, b) => b.avvikelse - a.avvikelse || b.dgr - a.dgr);

    // Kvalitet per hus + per ytatyp.
    const qcPerHus = new Map();
    for (const q of D.qcs) {
      const cc = _ref(q["Kundföretag"]); if (!ccInScope.has(cc)) continue;
      const fid = husAvKontor.get(_ref(q[LL.QC_KONTOR])) || D.husAvCc.get(cc);
      if (!fid || !inScope.has(fid)) continue;
      let a = qcPerHus.get(fid); if (!a) { a = []; qcPerHus.set(fid, a); }
      a.push(bubbleId(q));
    }
    const ytaAgg = new Map();   // ytatyp → hus-id → [betyg]
    const qcHus = new Map();    // qc-id → hus
    for (const [fid, ids] of qcPerHus) for (const q of ids) qcHus.set(q, fid);
    for (const k of D.comments) {
      const fid = qcHus.get(_ref(k[LL.K_QC])); if (!fid) continue;
      const g = D.gm.get(_ref(k[LL.K_BETYG])); if (g == null) continue;
      const rn = D.rumNamn.get(_ref(k[LL.K_INTERN]) || _ref(k[LL.K_MOTES])) || "Övrigt";
      let per = ytaAgg.get(rn); if (!per) { per = new Map(); ytaAgg.set(rn, per); }
      let arr = per.get(fid); if (!arr) { arr = []; per.set(fid, arr); }
      arr.push(g);
    }

    // Tjänster per hyresgäst (aktiva avtal). ⚠️ Inga belopp — bara kategori.
    const tjPerCc = new Map(), katalog = new Set();
    for (const c of D.contracts) {
      const cc = _ref(c["kundföretag"]) || _ref(c["Kundföretag"]); if (!ccInScope.has(cc)) continue;
      const slut = c[LL.CT_SLUT] ? Date.parse(c[LL.CT_SLUT]) : 0;
      if (slut && !Number.isNaN(slut) && slut < Date.now()) continue;    // avslutat avtal
      const kat = _os(c[LL.CT_KATEGORI]) || _str(c.contract_title); if (!kat) continue;
      katalog.add(kat);
      let s = tjPerCc.get(cc); if (!s) { s = new Set(); tjPerCc.set(cc, s); }
      s.add(kat);
    }
    const katLista = Array.from(katalog).sort((a, b) => a.localeCompare(b, "sv"));

    // Beståndsraderna
    const bestand = D.hus.filter((h) => inScope.has(h.id)).map((h) => {
      const t = hg.filter((x) => x.fastighet === h.id);
      const b = perHus.get(h.id) || { oppna: 0, avv: 0, kat: new Map(), alla: [] };
      const bg = betygFor(new Set(qcPerHus.get(h.id) || []), D);
      const medTj = t.filter((x) => (tjPerCc.get(x.id) || new Set()).size > 0).length;
      return {
        id: h.id, namn: h.namn, adress: h.adress,
        hyresgaster: t.length,
        kvm: kvmPerHus.get(h.id) || 0,
        arbetsplatser: aplPerHus.get(h.id) || 0,
        oppna: b.oppna, avvikelser: b.avv,
        mtts: mtts(b.alla),
        betyg: bg.snitt, betyg_underlag: bg.underlag,
        kontroller: (qcPerHus.get(h.id) || []).length,
        tackning: t.length ? Math.round((medTj / t.length) * 100) / 100 : null,
      };
    }).sort((a, b) => a.namn.localeCompare(b.namn, "sv"));

    // Aggregat per hus för hyresgästernas ärenden — utan innehåll.
    const hgArenden = {};
    for (const h of bestand) {
      const b = perHus.get(h.id) || { oppna: 0, avv: 0, kat: new Map(), alla: [] };
      const egnaHar = new Set(egna.filter((e) => e.hus === h.id).map((e) => e.id));
      const hgAlla = b.alla.filter((m) => !egnaHar.has(bubbleId(m)));
      // ⚠️ Kategorierna räknas på HYRESGÄSTERNAS rader, inte på husets alla. Räknar man
      //    på `b.alla` hamnar ägarens egna ärenden i hyresgästaggregatet — chipsen hade
      //    då sagt en annan sak än siffran rakt ovanför dem.
      const kat = new Map();
      for (const m of hgAlla) { const k = kategori(m); kat.set(k, (kat.get(k) || 0) + 1); }
      hgArenden[h.id] = {
        oppna: hgAlla.filter(oppen).length,
        avv: hgAlla.filter((m) => oppen(m) && m[LL.M_AVVIKELSE] === true).length,
        mtts: mtts(hgAlla),
        kat: Array.from(kat.entries()).sort((a, b2) => b2[1] - a[1]).slice(0, 4),
      };
    }

    // Tjänstekartan — EN rad per hyresgäst, inte en per hus hen sitter i.
    // ⚠️ En hyresgäst med kontor i två hus ligger två gånger i `tenants`. Utan
    //    dedupningen dubbelräknas den i vitt utrymme och i tjänstetäckningen.
    const rader = hgIds.map((id) => {
      const forsta = hg.find((t) => t.id === id);
      return {
        id, namn: forsta.namn,
        hus: Array.from(new Set(hg.filter((t) => t.id === id).map((t) => t.fastighet))),
        tj: Array.from(tjPerCc.get(id) || []),
      };
    }).sort((a, b) => a.namn.localeCompare(b.namn, "sv"));
    const vitt = katLista.map((k) => {
      const har = rader.filter((r) => r.tj.indexOf(k) > -1).length;
      return { namn: k, har, utan: rader.length - har, tackning: rader.length ? Math.round((har / rader.length) * 100) / 100 : null };
    }).sort((a, b) => b.utan - a.utan);

    const ytatyper = Array.from(ytaAgg.entries()).map(([namn, per]) => {
      const rad = { namn, per_hus: {} };
      for (const [fid, arr] of per) rad.per_hus[fid] = Math.round((arr.reduce((a, b2) => a + b2, 0) / arr.length) * 10) / 10;
      return rad;
    }).sort((a, b) => a.namn.localeCompare(b.namn, "sv"));

    // Pulsremsan. ⚠️ Inga aktivitetsspår än — se `kallor` nedan.
    const totOppna = bestand.reduce((a, h) => a + h.oppna, 0);
    const totAvv = bestand.reduce((a, h) => a + h.avvikelser, 0);
    const bg = betygFor(new Set([].concat(...Array.from(qcPerHus.values()))), D);
    const medTjTot = rader.filter((r) => r.tj.length).length;

    return {
      puls: {
        arenden_oppna: totOppna, avvikelser: totAvv,
        kvalitet: bg.snitt, kvalitet_underlag: bg.underlag,
        kontroller: bestand.reduce((a, h) => a + h.kontroller, 0),
        tjanstetackning: rader.length ? Math.round((medTjTot / rader.length) * 100) / 100 : null,
        hyresgaster: rader.length,      // DISTINKTA hyresgäster, ägaren ej inräknad
      },
      bestand, egna_arenden: egna, hg_arenden: hgArenden,
      kvalitet: { ytatyper },
      tjanster: { katalog: katLista, rader, vitt },
      agarens_egen_kund: !!D.agarCc,
    };
  }

  // Källtäckning — mätt, inte påstått. ⚠️ Den här fliken är ett konstruktionskrav,
  // inte en trevlig extra: en tom kolumn ser ut som "inget händer" när den betyder
  // "vi mäter inte här än". Se handoff/FASTIGHETSAGARVYN.md §3.7.
  function kallor(D, proj) {
    const qcMed = proj.bestand.reduce((a, h) => a + (h.betyg_underlag ? 1 : 0), 0);
    return [
      { namn: "Ärenden och avvikelser", kalla: "Mira", status: "live",
        matt: proj.bestand.reduce((a, h) => a + h.oppna, 0) + " öppna i beståndet", not: "" },
      { namn: "Kvalitetskontroller", kalla: "Mira", status: proj.puls.kontroller ? "live" : "tom",
        matt: proj.puls.kontroller + " kontroller · " + proj.puls.kvalitet_underlag + " ytbetyg",
        not: qcMed < proj.bestand.length ? "Betyg saknas för " + (proj.bestand.length - qcMed) + " av " + proj.bestand.length + " hus." : "" },
      { namn: "Avtal och tjänster", kalla: "Mira", status: proj.tjanster.katalog.length ? "live" : "tom",
        matt: proj.tjanster.katalog.length + " tjänstekategorier", not: "" },
      { namn: "Ägarens egna ärenden", kalla: "Mira", status: proj.agarens_egen_kund ? "live" : "saknas",
        matt: proj.egna_arenden.length + " öppna",
        not: proj.agarens_egen_kund ? "" : "Hyresvärden är inte kopplad till en egen ClientCompany — därför visas inga ärenden i era egna ytor." },
      // ⚠️ Står som EJ I DRIFT med flit. Att utelämna raden hade dolt luckan.
      { namn: "Städpass (Housekeeping)", kalla: "Tengella", status: "ej_i_drift", matt: "—",
        not: "Aktivitetsspåret är inte inkopplat än. Tengella-kunder utan koppling till företagskortet får dessutom inga pass alls — se TENGELLA-HK.md." },
      { namn: "Leveranser (Food & Event)", kalla: "Fortnox", status: "ej_i_drift", matt: "—",
        not: "Ej inkopplat. Cirka 30 % av Food & Event går utanför Fortnox tills Caspeco-migreringen Q1-27." },
      { namn: "Uppdrag (Service & People)", kalla: "Intelliplan", status: "ej_i_drift", matt: "—",
        not: "Ej inkopplat. Månadsnivå — pass per dag saknas i källan." },
      { namn: "Besöksflöde", kalla: "Mira", status: "ej_i_drift", matt: "—",
        not: "Besöksloggen är inte i drift än. Kolumnen är tom tills receptionsmodulen rullar." },
    ];
  }

  // ══════════════ GET /landlord/overview ══════════════
  app.options("/landlord/overview", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/landlord/overview", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    const sc = scope(p, req, res); if (!sc) return;
    try {
      const t0 = Date.now();
      const { data, cache } = await overview(p.hv, p.fast);
      const proj = project(data, sc);
      return res.json(Object.assign({ ok: true, scope: sc, hela_bestandet: sc.length === p.fast.length }, proj, {
        kallor: kallor(data, proj),
        meta: { cache, ms: Date.now() - t0, anrop: data.anrop, hus_i_scope: sc.length, hus_totalt: p.fast.length },
      }));
    } catch (e) {
      console.error("[/landlord/overview]", e && e.message);
      return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  return { tenantsForget, overviewForget, _internal: { buildOverview, project, kallor, ownCompanyId, mtts } };
}
