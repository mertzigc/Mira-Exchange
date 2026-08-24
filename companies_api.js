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
    bubbleFind, bubbleFindAll, bubbleGet, bubbleId, bubblePatch, bubbleCount, bubbleCreate, bubbleDelete,
    bubbleUploadFile, photoUpload,
    companyFullMap, companyRevenueMap, companyRevenueMapWarm, companyTouchMapWarm, companyBolagMapWarm, companyPatchEntry, companyForget,
    assignTempPassword, createUserAccount, appBaseUrl, pwResetTemplateId, welcomeTemplateId,
    planningAuthed, planningCors, publicRateLimited, clientIp,
    // ⚠️ Behövs för att skilja HK från F&E i FortnoxOrder. Sedan §9-cutovern
    // (LIVE 2026-06-08) ligger Tengella-workordrar i FortnoxOrder med
    // connection=TENGELLA — och de bär `ft_order_date`, aldrig ft_delivery_date.
    TENGELLA_CONNECTION_ID,
    // ⚠️ Onboarding "Carotte-medarbetare knuten"-checken. En User räknas som
    // Carotte-medarbetare om User.Company == CAROTTE_COMPANY_ID. Utan env-varen
    // kan checken inte skilja Carotte-users från kundens egna → svaret bär
    // `staff.ok:false` + hint, aldrig ett tyst noll. Env finns i Render.
    CAROTTE_COMPANY_ID,
  } = deps;
  const _connId = (v) => (v == null ? null : (typeof v === "string" ? v : (v._id || v.id || null)));
  // multer .single-middleware (memory) för foto-upload; no-op om ej injicerat (smoke/mock).
  const _photoMw = (typeof photoUpload === "function" && typeof photoUpload.single === "function")
    ? photoUpload.single("file") : (req, res, next) => next();

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
  // deal_id (2026-08-18): kortet erbjuder "skapa affär av leadet" bara när raden inte
  // redan är kopplad — samma deal-fält som affärsvyns /admin/affar/deal/create sätter.
  function nLead(r)  { return { type: "Lead", source: "mira", title: _str(r.Name) || "Lead", amount: _num(r.estimated_service_cost_monthly), date: _day(r["Created Date"]), status: _str(r.status) || "Ny", status_cls: "wait", url: "", id: bubbleId(r), deal_id: _ref(r.deal) || null }; }
  function nOffM(r)  { const s = _str(r.status); const cls = s === "Approved" ? "ok" : ((s === "Expired" || s === "Revoked") ? "red" : "open"); return { type: "Offert", source: "mira", title: _str(r.offertnr) || "Offert", amount: _num(r.total), date: _day(r.offertdatum || r["Created Date"]), status: s || "Utkast", status_cls: cls, url: "", id: bubbleId(r) }; }
  function nOffF(r)  { const st = r.ft_cancelled ? ["Avbruten", "red"] : (r.ft_sent ? ["Skickad", "open"] : ["Öppen", "open"]); return { type: "Offert", source: "fortnox", title: _str(r.ft_document_number), amount: _num(r.ft_total), date: _day(r.ft_offer_date || r.ft_delivery_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf), id: bubbleId(r) }; }
  function nOrdM(r)  { const s = _str(r.orderstatus); const cls = (s === "Levererad" || s === "Fakturerad") ? "ok" : "open"; return { type: "Order", source: "mira", title: _str(r.ordernr) || "Order", amount: _num(r.total), date: _day(r.orderdatum || r["Created Date"]), status: s || "Bekräftad", status_cls: cls, url: "", id: bubbleId(r) }; }
  // ⚠️ HK OCH F&E DELAR TABELL MEN INTE DATUMFÄLT.
  // Housekeeping-ordrar (connection=TENGELLA, source="tengella-workorder") har
  // bara `ft_order_date` — v2-adaptern sätter aldrig ft_delivery_date. Tidigare
  // daterades de därför på Created Date (= synkdatum, inte affärsdatum) och
  // märktes "fortnox"/"Levererad" fast vi inte vet något om leverans.
  function nOrdF(r)  {
    const hk = TENGELLA_CONNECTION_ID && _connId(r.connection) === TENGELLA_CONNECTION_ID;
    const d = hk ? r.ft_order_date : r.ft_delivery_date;
    const t = (!hk && r.ft_delivery_date) ? Date.parse(r.ft_delivery_date) : 0;
    const past = t && t < Date.now();
    return { type: "Order", source: hk ? "tengella" : "fortnox",
      title: _str(r.ft_document_number || r.ft_order_document_number),
      amount: _num(r.ft_total), date: _day(d || r["Created Date"]),
      status: hk ? "Workorder" : (past ? "Levererad" : "Bekräftad"),
      status_cls: hk ? "wait" : (past ? "ok" : "open"),
      url: _httpsUrl(r.ft_pdf), id: bubbleId(r) };
  }
  function nInv(r)   { const bal = _num(r.ft_balance); const due = r.ft_due_date ? Date.parse(r.ft_due_date) : 0; let st = ["Obetald", "open"]; if (bal === 0) st = ["Betald", "ok"]; else if (due && due < Date.now()) st = ["Förfallen", "red"]; return { type: "Faktura", source: "fortnox", title: _str(r.ft_document_number), amount: _num(r.ft_total), date: _day(r.ft_invoice_date || r["Created Date"]), status: st[0], status_cls: st[1], url: _httpsUrl(r.ft_pdf) || _httpsUrl(r.ft_url), id: bubbleId(r) }; }
  function nContract(r) { const end = r["slutdatum"] ? Date.parse(r["slutdatum"]) : 0; const active = !(end && !Number.isNaN(end) && end < Date.now()); return { type: "Avtal", source: "mira", title: _str(r.contract_title) || _str(r["kategori"]) || "Avtal", contract_type: _str(r.contract_type) || "Subscription", amount: _num(r["månadskostnad"]), date: _day(r["slutdatum"]), status: active ? "Aktiv" : "Avslutad", status_cls: active ? "ok" : "wait", id: bubbleId(r) }; }
  function nApproval(r) { const s = _str(r.status); const cls = s === "Approved" ? "ok" : ((s === "Expired" || s === "Revoked") ? "red" : "open"); return { type: "Signering", source: "mira", title: _str(r.rubrik) || "Signering", status: s || "Utkast", status_cls: cls, signed: _num(r.signed_count) || 0, recipients: _num(r.recipients_count) || 0, date: _day(r["Created Date"]), id: bubbleId(r) }; }

  // ── Hjälp-cachar för namn-resolvning (egen TTL) ──────────
  // ⚠️ WU: dessa är HELSVEP av hela typen (User är inte liten — flera tusen rader).
  // TTL var 5 min → varje aktiv arbetstimme kostade upp till 12 User-helsvep bara för
  // att resolva namn. Namn ändras i praktiken aldrig under en session → 60 min.
  // Färskhetskritiska frågor (has_user, personal-pool) kör EGNA constraintade queries,
  // så den här cachen påverkar bara namnvisning. (WU-städning 2026-08-17.)
  const AUX_TTL = 60 * 60 * 1000;
  let _uCache = { list: null, map: null, ts: 0 };
  // User-e-post normaliserad. Bubble lägger inloggningsmejlet på authentication-objektet
  // på vissa konton och i ett eget fält på andra — läs båda, annars tappas hälften.
  const _userEmail = (u) => _str(
    u.email || u.Email ||
    (u.authentication && u.authentication.email && u.authentication.email.email) || ""
  ).trim().toLowerCase();
  // Option-set-värden läses som display-strängar; vissa Bubble-svar ger objekt.
  const _osVal = (v) => (v == null ? "" : (typeof v === "string" ? v : _str(v.display || v.Display || v)));
  async function _users() {
    if (_uCache.map && (Date.now() - _uCache.ts) < AUX_TTL) return _uCache;
    const all = await bubbleFindAll("User", {}).catch(() => []);
    const map = new Map(), byEmail = new Map(), list = [], roleSet = new Set();
    for (const u of all) {
      // User_role härleds UR DATAN (som _matterStatuses) i st.f. att hårdkodas —
      // vi gissar aldrig option-set-värden (jfr Avslutad→Avslutat, Internal_room).
      // Gratis: samma svep som redan görs för namnen. (2026-08-18)
      const role = _osVal(u.User_role); if (role) roleSet.add(role);
      const id = bubbleId(u); if (!id) continue;
      const first = _str(u["First Name"] || u["Förnamn"]);
      const last  = _str(u["Last Name"]  || u["Efternamn"] || u["Surname"]);
      const nm = (first + " " + last).trim() || _str(u.email || u.Email);
      if (!nm) continue;
      const em = _userEmail(u);
      map.set(id, nm); list.push({ id, name: nm, email: em });
      if (em) byEmail.set(em, id);
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    const roles = Array.from(roleSet).sort((a, b) => a.localeCompare(b, "sv"));
    _uCache = { list, map, byEmail, roles, ts: Date.now() };
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

  // ── Fastighetsnamn ────────────────────────────────────────────────────────
  // ⚠️ BUGG 2026-08-21: namnet hämtades med `_str(f.Namn || … || f.Adress || …)`.
  // Fastighet-typen har INGET `Namn`-fält — namnet ligger i **`Titel`** — och
  // `Adress` är ett **geographic address-OBJEKT**. Kedjan träffade därför Adress
  // före Titel, och `String({address:…})` blev **"[object Object]"**: filtret,
  // Fastighet-kolumnen och kortets chips visade det rakt av.
  // (Schema verifierat mot Bubble-editorn: Adress·Bild·Bildspel·Coworker·
  //  Hyresgäster·Kluster·Kontor·Leverantör·Medarbetare·Region·Titel·Ägare.)
  //
  // Två regler som följer: **Titel först**, och ett objekt får ALDRIG bli ett namn
  // via implicit stringifiering — geo-objektet plockas isär explicit (`.address`),
  // allt annat objekt-aktigt förkastas av `_cleanName`.
  function _cleanName(v) {
    if (v == null) return "";
    if (typeof v === "object") return "";        // aldrig "[object Object]"
    const s = _str(v).trim();
    return s === "[object Object]" ? "" : s;     // bältet: redan stringifierat objekt
  }
  function _fastighetName(f) {
    const t = _cleanName(f.Titel) || _cleanName(f.titel) || _cleanName(f.Namn) ||
              _cleanName(f.name) || _cleanName(f.Name) || _cleanName(f.title);
    if (t) return t;
    // Fallback: adressen — men bara textdelen ur geo-objektet.
    const a = f.Adress || f.adress || f.address;
    if (a) return _cleanName(typeof a === "string" ? a : a.address);
    return "";
  }
  let _fCache = { list: null, map: null, ts: 0 };
  async function _fastigheter() {
    if (_fCache.map && (Date.now() - _fCache.ts) < AUX_TTL) return _fCache;
    const all = await bubbleFindAll("Fastighet", {}).catch(() => []);
    const map = new Map(), list = [];
    let unnamed = 0;
    for (const f of all) {
      const id = bubbleId(f); if (!id) continue;
      const nm = _fastighetName(f);
      // ⚠️ Namnlösa fastigheter hoppas över (de går inte att välja i en dropdown),
      // men räknas och loggas — tyst bortfall är hur "[object Object]" kunde leva
      // vidare oupptäckt.
      if (!nm) { unnamed++; continue; }
      map.set(id, nm); list.push({ id, name: nm });
    }
    if (unnamed) console.log("[fastigheter] " + unnamed + " av " + (all || []).length + " saknar namn (Titel/Adress tomma) — utelämnade ur listan");
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    _fCache = { list, map, ts: Date.now() };
    return _fCache;
  }

  // ── Option-set-fält: distinkta värden härledda ur datan (för filter + write-validering) ──
  // Nyckel = fältnamn i list-projektionen; label = svensk kolumnrubrik.
  const OPTIONSET_FIELDS = ["kundstatus", "potential", "lojalitet", "region", "bransch", "customer_type"];

  // ── SEED ur Bubbles option-set (medvetet avsteg — läs varför) ──────────────
  // Härledningen ovan har ett moment 22 för glesa fält: finns värdet inte på NÅGOT
  // företag saknas det i facetterna → det går varken att filtrera på eller att
  // SKRIVA (PATCH validerar mot samma facetter → `unknown_optionset_value`). Alltså
  // kan ett tomt fält aldrig fyllas via listan. `Bransch` var precis så: tomt rakt
  // igenom i produktion 2026-08-21, alltså ett dött filter och en oskrivbar kolumn.
  // Seeden bryter dödläget. Den är UNION med datan — värden som finns i Bubble men
  // inte här faller aldrig ur (motsatt fälla: en kort seed som tyst gömmer data).
  // ⚠️ Speglar option-setet `Bransch` i Bubble-editorn (skärmdump 2026-08-21,
  // 14 värden, Bank först → Övriga tjänster sist). Case-sensitive, `&` inte "och".
  // Ändras option-setet i Bubble måste listan uppdateras här — annars kan man inte
  // sätta det nya värdet förrän något företag redan har det.
  const OPTIONSET_SEED = {
    bransch: ["Bank", "Investmentbolag", "Fastigheter", "Mat & dryck", "Fordon", "Bygg",
              "Tillverkning", "Konsumentvaror", "IT-tjänster", "Digitala program",
              "Offentlig verksamhet", "Konsulttjänster", "Hotell", "Övriga tjänster"],
  };

  // ── VÅRA BOLAG: vilka fakturerar kunden? ────────────────────────────────────
  // Kartan (companyId → {bolag: senaste fakturadatum}) byggs i index.js ur SAMMA
  // faktura-scan som omsättningen → noll extra WU. Här läggs bara FÖNSTRET på.
  //
  // ⚠️ "Fakturerar idag" = minst en icke-makulerad faktura de senaste 12 månaderna
  // (Christians beslut 2026-08-21). Rullande fönster, inte kalenderår — annars
  // nollställs alla badgar vid varje årsskifte och en kund fakturerad i november
  // ser passiv ut i januari. Ändras gränsen räcker det att ändra här; kartan bär
  // datum, inte flaggor.
  // ⚠️ `Staff` är ANSLUTNINGENS namn (bolaget Carotte Staff AB), inte kategorin —
  // kategorin heter `Service & People`. Blanda aldrig ihop dem, se
  // [[reference-bubble-option-sets]] "namnkrocken".
  const BOLAG_ORDER = ["Staff", "Food & Event", "Housekeeping", "Group"];
  const BOLAG_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
  function _bolagSort(a, b) {
    const ia = BOLAG_ORDER.indexOf(a), ib = BOLAG_ORDER.indexOf(b);
    // Okända anslutningar (t.ex. en ny Fortnox-connection) sorteras sist men
    // döljs ALDRIG — annars försvinner ny fakturering tyst ur både filter och kort.
    if (ia < 0 && ib < 0) return a.localeCompare(b, "sv");
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  }
  // → { active: ["Staff", …], all: [{ name, last: "YYYY-MM-DD", active: bool }, …] }
  function _bolagOf(entry, nowTs) {
    if (!entry) return { active: [], all: [] };
    const names = Object.keys(entry).sort(_bolagSort);
    const all = names.map((n) => {
      const ts = entry[n];
      return { name: n, last: ts ? new Date(ts).toISOString().slice(0, 10) : "", active: !!ts && (nowTs - ts) <= BOLAG_WINDOW_MS };
    });
    return { active: all.filter((x) => x.active).map((x) => x.name), all };
  }

  // Filtrets värdelista: de fyra bolagen ALLTID (så filtret inte är tomt medan
  // faktura-cachen värms) unionat med vad som faktiskt förekommer — en ny
  // Fortnox-anslutning dyker då upp i stället för att tyst saknas.
  function _bolagList(bolagMap) {
    const set = new Set(BOLAG_ORDER);
    if (bolagMap) for (const e of bolagMap.values()) for (const k in e) set.add(k);
    return [...set].sort(_bolagSort);
  }

  function _facets(full) {
    const sets = {}; for (const f of OPTIONSET_FIELDS) sets[f] = new Set();
    for (const c of full.values()) for (const f of OPTIONSET_FIELDS) { const v = c[f]; if (v) sets[f].add(v); }
    const out = {};
    for (const f of OPTIONSET_FIELDS) {
      const seed = OPTIONSET_SEED[f];
      if (seed) for (const v of seed) sets[f].add(v);
      out[f] = [...sets[f]].sort((a, b) => a.localeCompare(b, "sv"));
    }
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
    // ⚠️ Fastighet är en LISTA (List of Fastighet) — inte ett enkelvärde. `reflist`
    // skriver hela arrayen (samma mönster som Leverantör.Kundföretag /
    // Hyresvärd.Hyresgäster). Frontenden lägger till/tar bort en chip i taget och
    // skickar hela den nya listan, så ett företag med två fastigheter aldrig tappar
    // den ena tyst — vilket en enkel dropdown hade gjort.
    fastighet:     { bubbleField: "Fastighet",    type: "reflist",  ref: "fastighet" },
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
    const bol = _bolagOf(ctx.bolag.get(c.id), ctx.nowTs);
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
      // Våra bolag: `bolag` = fakturerar nu (12 mån), `bolag_all` = även tidigare
      // (med senaste fakturadatum) så kortet kan visa "tidigare kund hos X".
      bolag: bol.active,
      bolag_all: bol.all,
      // ── Senast ändrad ──────────────────────────────────────────────
      // MAX(företagets egen Modified Date, senaste relaterade rad). `modified_src`
      // säger VAD som rörde det ("aktivitet"/"person"/"ärende"/"lead"/"affär"/"todo"
      // eller "grunddata") så listan kan visa varför raden ligger högt.
      ...(function () {
        const own = Date.parse(c.modified || "") || 0;
        const t = ctx.touch.get(c.id);
        const rel = t ? t.ts : 0;
        const ts = Math.max(own, rel);
        return {
          modified_ts: ts || null,
          modified: ts ? new Date(ts).toISOString() : "",
          modified_src: !ts ? "" : (rel > own ? t.src : "grunddata"),
        };
      })(),
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
    // Lista → sortera på den sammanslagna etiketten (samma sträng som cellen visar).
    fastighet:  (r) => (r.fastigheter || []).join(", "),
    nki:        (r) => r.nki,
    oms_now:    (r) => r.oms_now,
    oms_prev:   (r) => r.oms_prev,
    modified:   (r) => r.modified_ts,
  };
  const NUMERIC_SORT = new Set(["nki", "oms_now", "oms_prev", "modified"]);
  // Sorteras man på "senast ändrad" vill man nyast först → desc som default.
  // (Bokstavsordning fortsätter defaulta till asc.)
  const DEFAULT_DESC = new Set(["modified"]);

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
    // "Senast ändrad": icke-blockerande som omsättningen. null → touchReady=false,
    // listan faller tillbaka på företagets egen Modified Date tills svepen är klara.
    const touch = companyTouchMapWarm ? companyTouchMapWarm() : null;
    // Bolagskartan kommer ur SAMMA svep som omsättningen → egen readiness behövs inte:
    // är rev null är bolag det också, och frontenden visar redan "beräknar…".
    const bolag = companyBolagMapWarm ? companyBolagMapWarm() : null;
    return { full, rev: rev || new Map(), revenueReady: !!rev,
             touch: touch || new Map(), touchReady: !!touch,
             bolag: bolag || new Map(), nowTs: Date.now(),
             users: u.map, groups: g.map, fast: f.map };
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
        bolag: _bolagList(companyBolagMapWarm ? companyBolagMapWarm() : null),
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
  //   &customer_type= &group= &fastighet= &bolag= &unassigned=1
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
      const bolagF = _str(req.query.bolag).trim() || null;
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
        // ⚠️ Bolagsfiltret kan INTE ligga i continue-kedjan ovan: `bolag` finns inte i
        // cache-projektionen utan härleds ur faktura-kartan + fönstret. Filtrera på den
        // färdiga raden i stället — och se `bolag_ready` nedan: är kartan kall betyder
        // 0 träffar "inte beräknat än", aldrig "ingen kund har det bolaget".
        const row = _rowOf(c, ctx, yearNow, yearPrev);
        if (bolagF && row.bolag.indexOf(bolagF) < 0) continue;
        rows.push(row);
      }

      // Sortering (tomma alltid sist, oavsett riktning)
      const sortKey = SORT_GETTERS[_str(req.query.sort)] ? _str(req.query.sort) : "name";
      const dirQ = _str(req.query.dir);
      // Ingen explicit riktning → asc, utom för nycklar där desc är det naturliga (modified).
      const dir = (dirQ === "desc" || (!dirQ && DEFAULT_DESC.has(sortKey))) ? -1 : 1;
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
        // Samma svep som omsättningen. ⚠️ Frontenden MÅSTE skilja "0 träffar" från
        // "inte beräknat än" när bolagsfiltret är på — annars läser en kall cache som
        // "ingen kund faktureras av Staff".
        bolag_ready: ctx.revenueReady,
        touch_ready: ctx.touchReady,       // false = "senast ändrad"-svepen värms → visar bara grunddata-datum tills klart
        rows: pageRows,
      };
      if (_str(req.query.meta) === "1" || page === 1) {
        const [u, g, f] = await Promise.all([_users(), _groups(), _fastigheter()]);
        out.meta = {
          facets: _facets(ctx.full),
          bolag: _bolagList(ctx.bolag),
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
      // ⚠️ Cachen kan ligga FÖRE verkligheten: delta-refreshen ser inte raderingar,
      // så ett företag som raderats i Bubble finns kvar i `full` upp till 12 h. Då
      // 400:ar varje referens-constraintad query på id:t (se _deadRefId i index.js)
      // och kortet blir ett tomt skal. Verifiera mot Bubble och glöm det i stället.
      const recProbe = await bubbleGet("ClientCompany", id).catch(() => null);
      if (!recProbe) {
        if (companyForget) companyForget(id);
        return res.status(404).json({ ok: false, error: "company_not_found", stale_cache: true });
      }
      const [rec, u, g, f] = await Promise.all([
        Promise.resolve(recProbe),
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
      // ⚠️ Aktivitetsraderna hämtades redan för histCount — återanvänd dem för
      // "levande" i st.f. att fråga en gång till. Todo är den ENDA nya frågan (+1 anrop).
      const aktRowsP = _companyActivityRows(id).then((r) => r || null).catch(() => null);
      const todoRowsP = bubbleFindAll("Todo", { constraints: eqc("Företag") }).then((r) => r || null).catch((e) => {
        console.error("[/admin/companies/:id/card] Todo-hämtning föll:", e?.message);
        return null;   // ⚠️ null = OKÄNT, aldrig [] — se nasta.ok nedan
      });
      const [histCount, dealCount, leadCount, offMC, offFC, ordMC, ordFC, invCount, persCount, driftCount] = await Promise.all([
        aktRowsP.then((r) => (r ? r.length : null)),
        bubbleCount("deal", eqc("kundföretag")).catch(() => null),
        bubbleCount("Lead", eqc("client_company")).catch(() => null),
        bubbleCount("Offert", eqc("kundforetag")).catch(() => null),
        bubbleCount("FortnoxOffer", eqc("linked_company")).catch(() => null),
        bubbleCount("MiraOrder", eqc("kundforetag")).catch(() => null),
        bubbleCount("FortnoxOrder", eqc("linked_company")).catch(() => null),
        bubbleCount("FortnoxInvoice", eqc("linked_company")).catch(() => null),
        bubbleCount("Coworker", eqc("Kundföretag")).catch(() => null),
        bubbleCount("Matter", [{ key: "Kundföretag", constraint_type: "equals", value: id }, { key: "status", constraint_type: "equals", value: "Pågående" }]).catch(() => null),   // öppna ärenden
      ]);
      const sumC = (a, b) => ((a == null && b == null) ? null : (Number(a || 0) + Number(b || 0)));

      // ── Levande aktivitet/todo ──
      // ⚠️ TOM DATA ÄR ALDRIG ETT SVAR: föll någon av frågorna är svaret OKÄNT, inte
      // "inget bokat". `nasta.ok:false` → kortet säger det rakt ut i st.f. att visa
      // skapa-knappar som om kunden vore utan uppföljning.
      const [aktRows, todoRows] = await Promise.all([aktRowsP, todoRowsP]);
      const nowTs = Date.now();
      const nasta = (aktRows === null || todoRows === null)
        ? { ok: false, aktiviteter: [], todos: [] }
        : { ok: true, aktiviteter: _liveAkt(aktRows, nowTs), todos: _liveTodo(todoRows, nowTs) };

      const adr = rec && rec.Adress;
      const address = adr ? (typeof adr === "string" ? adr : (adr.address || "")) : "";
      const grundat = rec && rec["Grundat_år"] ? _str(rec["Grundat_år"]).slice(0, 4) : "";

      const bolMap = companyBolagMapWarm ? companyBolagMapWarm() : null;
      const bol = _bolagOf(bolMap ? bolMap.get(id) : null, Date.now());
      const company = Object.assign({}, proj, {
        // Våra bolag som fakturerar kunden. ⚠️ Läs tillsammans med `revenue_ready`:
        // är svepet kallt är listan tom för att den inte är beräknad, inte för att
        // ingen fakturerar. Kortet visar "beräknar…" i det läget.
        bolag: bol.active,
        bolag_all: bol.all,
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
        nasta,
        counts: {
          avtal: (contracts || []).length, historik: histCount, deals: dealCount,
          leads: leadCount, offerter: sumC(offMC, offFC), ordrar: sumC(ordMC, ordFC), fakturor: invCount,
          personer: persCount, drift: driftCount,
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

  // ── GET /admin/companies/:id/chain?type=deals|leads|offerter|ordrar|fakturor|avtal|signeringar|historik ──
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
      } else if (type === "historik") {
        const [raw, uc] = await Promise.all([_companyActivityRows(id), _users().catch(() => null)]);   // union company+clientcompany
        rows = raw.map((r) => nActivity(r, uc && uc.map));
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
          foto: _httpsUrl(co.Foto || co.foto),
          kontor_id: kontorId || null,
          kontor: kontorId ? (officeMap.get(kontorId) || "") : "",
          has_user: !!uid,
          user_id: uid || null,
        };
      });
      rows.sort((a, b) => (a.last || a.first).localeCompare(b.last || b.first, "sv") || a.first.localeCompare(b.first, "sv"));
      // roles = distinkta User_role ur datan → fyller roll-väljaren i "Skapa konto".
      // Tom lista betyder att ingen User har en roll satt ännu (då döljs väljaren).
      const uc0 = await _users().catch(() => null);
      return res.json({ ok: true, count: rows.length, rows, offices, departments: DEPARTMENTS, roles: (uc0 && uc0.roles) || [] });
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
      // ⚠️ role: utan User_role kastar dashboard_crm ut användaren till /index vid
      // page load ("Current User's User_role is empty"-guard). Varje konto som
      // skapades härifrån föddes trasigt innan detta. (2026-08-18)
      const role = _str((req.body && req.body.role) || "");
      const r = await createUserAccount({ email, password: pw, firstname, surname, company, coworker_id: id, role });
      if (!r || !r.ok) return res.status(502).json({ ok: false, error: (r && r.error) || "create_failed", hint: (r && r.hint) || null, email });
      // välkomstmail (samma som ny-user-flödet)
      const m = await _sendSetPassword({ email, coworkerId: id, toName: name, templateId: welcomeTemplateId || pwResetTemplateId });
      return res.json({ ok: true, email, user_id: r.user_id || null, role: role || null, mail: m.ok === true });
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

  // ── POST /admin/companies/coworker/:id/photo — sätt/ta bort profilfoto (Coworker.Foto) ──
  // Multipart: fält "file" (bild) → laddas upp till Bubble file storage → Foto=url.
  // Rensa: skicka fält "clear"=1 (utan fil) → Foto="". Foto är ett Bubble image-fält (URL-sträng).
  app.options("/admin/companies/coworker/:id/photo", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/coworker/:id/photo", _photoMw, async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const co = await bubbleGet("Coworker", id).catch(() => null);
      if (!co) return res.status(404).json({ ok: false, error: "coworker_not_found" });
      const clear = req.body && (req.body.clear === "1" || req.body.clear === 1 || req.body.clear === true || req.body.clear === "true");
      const file = req.file;
      if (clear && !file) {
        await bubblePatch("Coworker", id, { Foto: "" });
        return res.json({ ok: true, url: "" });
      }
      if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ ok: false, error: "no_file" });
      const ct = _str(file.mimetype || "image/jpeg");
      if (!/^image\//i.test(ct)) return res.status(400).json({ ok: false, error: "not_image" });
      if (file.buffer.length > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: "too_large" });
      if (typeof bubbleUploadFile !== "function") return res.status(501).json({ ok: false, error: "not_configured" });
      const ext = /png/i.test(ct) ? "png" : (/webp/i.test(ct) ? "webp" : "jpg");
      const filename = ("coworker_" + id + "_foto." + ext).replace(/[^\w.\-]/g, "_");
      const url = _httpsUrl(await bubbleUploadFile({ filename, contentType: ct, buffer: file.buffer }));
      if (!url) return res.status(502).json({ ok: false, error: "upload_failed" });
      await bubblePatch("Coworker", id, { Foto: url });
      return res.json({ ok: true, url });
    } catch (e) {
      console.error("[/admin/companies/coworker/:id/photo]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── GET /admin/companies/coworker/:id/activities — aktiviteter där personen är taggad ──
  // Söker activitet_crm där taggade_personer (List of Coworker) contains personen. Nyast först.
  // activitet_crm länkas till kunden via fältet `company` (ClientCompany) — bekräftat i Bubble-schemat
  // 2026-08-14 (INGET clientcompany-fält finns; det var ett felaktigt tidigt antagande). Native
  // "Historik" + affär använder `company`. (Hoistad function-declaration → nåbar i card-counten ovan.)
  // ── LEVANDE AKTIVITET / TODO (2026-08-21) ─────────────────────────────────
  // "Levande" = något är faktiskt bokat framåt på kunden. Christians definition
  // (2026-08-21): datum i framtiden OCH inte avklarat.
  //   Aktivitet: `Datum_bokning` > nu OCH `genomfört` !== true
  //   Todo:      `Starttid` ELLER `Sluttid` > nu OCH `Status` !== "Avslutad"
  // ⚠️ Todo-fälten är verifierade (skärmdump 2026-08-07, [[reference-bubble-todo-fields]]):
  // `Företag`(ClientCompany) · `Starttid`/`Sluttid`(date) · `Status`(status_reminder-OS:
  // Pågående·Avslutad·Försenad·Planerad) · `Titel`. Gissa aldrig här — fel fältnamn ger
  // tyst noll, och noll läses som "inget bokat" = raka motsatsen till sanningen.
  const TODO_KLAR = "Avslutad";
  function _liveAkt(rows, nowTs) {
    const out = [];
    for (const r of (rows || [])) {
      if (r["genomfört"] === true) continue;
      const t = Date.parse(_str(r["Datum_bokning"]) || "");
      if (!Number.isFinite(t) || t <= nowTs) continue;
      out.push({ id: bubbleId(r), typ: _str(r.activity_type) || "Aktivitet", fas: _str(r["Kundmöte"]),
                 datum: _day(r["Datum_bokning"]), text: _str(r.beskrivning) });
    }
    return out.sort((a, b) => Date.parse(a.datum) - Date.parse(b.datum));
  }
  function _liveTodo(rows, nowTs) {
    const out = [];
    for (const r of (rows || [])) {
      if (_str(r["Status"]) === TODO_KLAR) continue;
      const st = Date.parse(_str(r["Starttid"]) || "");
      const en = Date.parse(_str(r["Sluttid"]) || "");
      const future = (Number.isFinite(st) && st > nowTs) || (Number.isFinite(en) && en > nowTs);
      if (!future) continue;
      out.push({ id: bubbleId(r), titel: _str(r["Titel"]) || "Att-göra", status: _str(r["Status"]),
                 start: _day(r["Starttid"]), slut: _day(r["Sluttid"]) });
    }
    // Sortera på den tidigaste framtida tidpunkten (start om den finns, annars slut).
    const key = (x) => Date.parse(x.start || x.slut || "") || 0;
    return out.sort((a, b) => key(a) - key(b));
  }

  async function _companyActivityRows(id) {
    return bubbleFindAll("activitet_crm", { constraints: [{ key: "company", constraint_type: "equals", value: id }] }).catch(() => []);
  }

  // um (valfri Map id→namn) resolvar skapare (writer||Created By) → ansvarig. Rå edit-prefill-fält
  // (beskrivning/motesanteckning/motesdatum_iso) = SKRIVNYCKLAR (display-namn) för inline-redigering.
  function nActivity(r, um) {
    const wId = _ref(r.writer) || _ref(r["Created By"]);
    return {
      id: bubbleId(r),
      date: _day(r["Datum_bokning"] || r["Created Date"]),
      created: _day(r["Created Date"]),
      typ: _str(r.activity_type),
      fas: _str(r["Kundmöte"]),
      motesdatum_iso: _day(r["Datum_bokning"]),
      meddelande: _str(r.beskrivning) || _str(r["mötesantecking"]),
      beskrivning: _str(r.beskrivning),
      motesanteckning: _str(r["mötesantecking"]),
      genomfort: r["genomfört"] === true,
      nasta_steg: _osStr(r[NASTA_FIELD]),
      ansvarig: (um && wId) ? (um.get(wId) || "") : "",
      // Affärskoppling (2026-08-18): kortet erbjuder "skapa affär av aktiviteten"
      // bara när raden INTE redan är kopplad. Samma deal-fält som affärsvyn sätter.
      deal_id: _ref(r.deal) || null,
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

  // ── Historik-skrivning (activitet_crm) — lånar affär-mönstret (affar_api.js).
  // SKRIVNYCKLAR = display-namn (bekräftat 2026-08-07): activity_type/beskrivning/Kundmöte(fas)/
  // Datum_bokning/genomfört/mötesantecking. Kundmöte-typen bär fas/datum/genomfört/anteckning.
  const AKT_TYPES = ["Säljsamtal", "Kommentar", "Kundmöte", "Utbildning", "Pratat med", "Skickat e-post", "Fått e-post", "Sökt, ej på plats", "Mötesanteckningar"];
  const AKT_FASER = ["Fas 1", "Fas 2", "Fas 3", "Fas 4", "Övrigt"];

  // ── NÄSTA STEG (2026-08-21) ────────────────────────────────────────────────
  // En genomförd aktivitet får inte lämnas utan beslut: antingen bokas en ny
  // aktivitet, en todo skapas, eller så avslutas spåret medvetet.
  // ⚠️ `nasta_steg` är ett NYTT text-fält på `activitet_crm` som Christian skapar i
  // Bubble. Modulen får RÅ `bubbleCreate`/`bubblePatch` (inte `safeCreate`) → ett
  // okänt fält ger 400 och **hela skrivningen** avvisas. Deployas Render före fältet
  // finns hade användaren alltså blockerats från att spara sitt möte. Därför den
  // mjuka nedgraderingen nedan: mötet sparas alltid, `nasta_steg` rapporteras saknat.
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
  // ⚠️ Matchar SMALT (400 + exakt fältnamnet) — precis som `_deadRefId`. Fel typnamn,
  // andra okända fält och 5xx måste fortsätta braka, annars döljer vi äkta buggar.
  function _isUnknownField(e, field) {
    const d = e && e.detail;
    if (!d || d.status !== 400) return false;
    const body = typeof d.body === "string" ? d.body : JSON.stringify(d.body || "");
    return body.indexOf("Unrecognized field: " + field) > -1;
  }
  // Kör skrivningen med fältet; faller den på just det fältet skrivs den om utan.
  // Returnerar { value, missing } — `missing:true` går hela vägen ut i svaret.
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
  // Grinden. Returnerar ett felobjekt eller null.
  // ⚠️ REGELN ÄNDRAD 2026-08-21 (Christian såg att en redan genomförd aktivitet inte
  // grindades): kravet gäller inte bara ÖVERGÅNGEN utan **frånvaron av ett beslut**.
  // Grindar om resultatet är genomfört OCH inget nästa steg finns — varken i det som
  // skickas nu eller redan lagrat på raden. Konsekvens: de hundratals redan genomförda
  // aktiviteterna får sitt beslut nästa gång någon sparar dem, i st.f. att aldrig
  // omfattas. Har raden redan ett värde frågas man INTE igen (stavfelsrättning ska
  // inte kräva ett nytt beslut).
  // ⚠️ Grinden gäller sparningar som handlar om AVKLARANDET — d.v.s. som rör
  // `genomfört` eller mötesanteckningen ("när en aktivitet är genomförd och
  // anteckning innan vill vi ha ett nästa steg"). En patch som bara ändrar
  // beskrivning, fas eller kopplar en affär blockeras INTE; att kräva ett
  // uppföljningsbeslut för att rätta ett stavfel vore ren friktion.
  const NASTA_TRIGGERS = ["genomfört", "mötesantecking"];
  function _nastaStegError(p, cur) {
    const incoming = _str(p[NASTA_FIELD]).trim();
    if (incoming && NASTA_STEG.indexOf(incoming) < 0) {
      return { error: "okänt_nasta_steg", value: incoming, allowed: NASTA_STEG };
    }
    if (!NASTA_TRIGGERS.some((k) => p[k] !== undefined)) return null;   // rör inte avklarandet
    const curDone = !!(cur && cur["genomfört"] === true);
    const nowDone = (p["genomfört"] !== undefined) ? (p["genomfört"] === true) : curDone;
    if (!nowDone) return null;
    if (incoming) return null;
    // ⚠️ Redan beslutat → fråga inte igen. Läs OS-medvetet: `{display}`-objektet
    // hade annars alltid sett ut som ett värde ("[object Object]") och tyst
    // avaktiverat grinden för rader som saknar beslut.
    const existing = _osStr(cur && cur[NASTA_FIELD]).trim();
    if (existing) return null;
    return { error: "nasta_steg_krävs", allowed: NASTA_STEG,
             hint: "En genomförd aktivitet måste ha ett nästa steg: ny aktivitet, todo eller avslutat." };
  }

  function _aktWrite(p, b) {
    // gemensam fält-mappning för create+patch (bara skickade fält). p muteras.
    if (b.activity_type   !== undefined) p["activity_type"]  = _str(b.activity_type) || null;
    if (b.beskrivning     !== undefined) p["beskrivning"]    = _str(b.beskrivning);
    if (b.fas             !== undefined) p["Kundmöte"]       = _str(b.fas) || null;
    if (b.motesdatum      !== undefined) p["Datum_bokning"]  = _str(b.motesdatum) ? new Date(_str(b.motesdatum) + "T00:00:00.000Z").toISOString() : null;
    if (b.genomfort       !== undefined) p["genomfört"]      = (b.genomfort === true || b.genomfort === "true");
    if (b.motesanteckning !== undefined) p["mötesantecking"] = _str(b.motesanteckning);
    if (b.nasta_steg      !== undefined) p[NASTA_FIELD]      = _str(b.nasta_steg).trim() || null;
    return p;
  }

  // ── POST /admin/companies/:id/historik/create — ny aktivitet på företaget ──
  app.options("/admin/companies/:id/historik/create", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/:id/historik/create", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim();
    if (!cid) return res.status(400).json({ ok: false, error: "missing_id" });
    if (typeof bubbleCreate !== "function") return res.status(501).json({ ok: false, error: "not_configured" });
    try {
      const b = req.body || {};
      // company (ClientCompany) = det ENDA kund-fältet på activitet_crm → native/affär/kort läser detta.
      const p = { company: cid };
      _aktWrite(p, b);
      // ⚠️ ÄGARSKAP (2026-08-17): `writer` (User) är ENDA användbara ägarfältet.
      // Bubbles "Created By" blir API-nyckelns user för allt vi skapar via Data API
      // → oanvändbart. Utan writer saknar aktiviteten ansvarig i mötestratten
      // (salj_api: `_ref(r.writer) || _ref(r["Created By"])`) och i kort/affärsvy.
      // Sätts BARA vid create — en senare redigering ska inte flytta ägarskapet.
      const byUser = _str(b.by_user);
      if (byUser) p["writer"] = byUser;
      if (!p["beskrivning"] && !p["activity_type"]) return res.status(400).json({ ok: false, error: "tom_aktivitet", hint: "kräver minst beskrivning eller typ" });
      // Nyskapad som genomförd → wasDone=false, alltså en övergång: nästa steg krävs.
      const gErr = _nastaStegError(p, null);   // ny rad → inget lagrat beslut
      if (gErr) return res.status(400).json(Object.assign({ ok: false }, gErr));
      const cw = await _writeOptional((q) => bubbleCreate("activitet_crm", q), p, NASTA_FIELD);
      const id = cw.value;
      if (!id) return res.status(500).json({ ok: false, error: "create_returned_no_id" });
      const [fresh, uc] = await Promise.all([bubbleGet("activitet_crm", id).catch(() => null), _users().catch(() => null)]);
      // ⚠️ Läs TILLBAKA fältet — Bubble kan ha tagit emot skrivningen utan att spara
      // värdet. `null` = kunde inte verifieras (läsningen föll), inte "saknas".
      const verified = fresh ? (_osStr(fresh[NASTA_FIELD]) === _str(p[NASTA_FIELD] || "")) : null;
      return res.json({ ok: true, id, row: fresh ? nActivity(fresh, uc && uc.map) : null,
                        nasta_steg_field_missing: cw.missing || (verified === false && !!p[NASTA_FIELD]) });
    } catch (e) {
      console.error("[/admin/companies/:id/historik/create]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── POST /admin/companies/historik/:id/patch — redigera aktivitet inline ──
  app.options("/admin/companies/historik/:id/patch", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/historik/:id/patch", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const cur = await bubbleGet("activitet_crm", id).catch(() => null);
      if (!cur) return res.status(404).json({ ok: false, error: "activity_not_found" });
      const p = _aktWrite({}, req.body || {});
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "no_fields" });
      // Grinden gäller ÖVERGÅNGEN ej→genomförd. Redan genomförd rad kan redigeras fritt.
      const gErr = _nastaStegError(p, cur);
      if (gErr) return res.status(400).json(Object.assign({ ok: false }, gErr));
      const pw = await _writeOptional((q) => bubblePatch("activitet_crm", id, q), p, NASTA_FIELD);
      const [fresh, uc] = await Promise.all([bubbleGet("activitet_crm", id).catch(() => null), _users().catch(() => null)]);
      const verified = fresh ? (_osStr(fresh[NASTA_FIELD]) === _str(p[NASTA_FIELD] || "")) : null;
      return res.json({ ok: true, id, patched: p, row: fresh ? nActivity(fresh, uc && uc.map) : null,
                        nasta_steg_field_missing: pw.missing || (verified === false && !!p[NASTA_FIELD]) });
    } catch (e) {
      console.error("[/admin/companies/historik/:id/patch]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ══════════════ INSTÄLLNINGAR — KONTOR (Office) ══════════════
  // Office-fält (Bubble-schema verifierat 2026-08-15): Office_title(text), Kundföretag(ClientCompany),
  // Fastighet(ref), Kontorsansvarig(List of Coworker), office_address(geo), Yta(number),
  // Arbetsplatser(number), Budget(number), Mötesrum(List of MeetingRoom), intern_lokal(List of Internal_room).
  // Vid nytt kontor auto-skapas en default-rumsuppsättning (för kvalitetskontroller): 1 MeetingRoom +
  // 8 Internal_room. Rummen bär tillbaka-ref (office/kontor + Company/kundföretag) OCH appendas till
  // Office-listorna (Mötesrum/intern_lokal) så native-vyerna hittar dem.
  const DEFAULT_INTERNAL_ROOMS = ["Toaletter", "Kopieringsutrymme/Förråd", "Pentry", "Reception/Lounge", "Korridor", "Dusch", "Städförråd", "Kontorsrum"];
  async function _companyCoworkerMap(companyId) {
    const cos = await bubbleFindAll("Coworker", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: companyId }] }).catch(() => []);
    const map = new Map(), list = [];
    for (const co of (cos || [])) {
      const id = bubbleId(co); if (!id) continue;
      const nm = (_str(co["Förnamn"] || co["First Name"]) + " " + _str(co["Efternamn"] || co["Last Name"])).trim() || _str(co.Email || co.email);
      if (!nm) continue;
      map.set(id, nm); list.push({ id, name: nm });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    return { map, list };
  }
  function nOffice(o, fMap, coMap) {
    const ansvarigIds = (Array.isArray(o.Kontorsansvarig) ? o.Kontorsansvarig : (o.Kontorsansvarig ? [o.Kontorsansvarig] : [])).map(_ref).filter(Boolean);
    const adr = o.office_address;
    const fid = _ref(o.Fastighet);
    return {
      id: bubbleId(o),
      name: _str(o.Office_title),
      fastighet_id: fid || null,
      fastighet: fid ? (fMap.get(fid) || "") : "",
      ansvarig_ids: ansvarigIds,
      ansvariga: ansvarigIds.map((id) => ({ id, name: (coMap.get(id) || "") })).filter((x) => x.name),
      adress: adr ? (typeof adr === "string" ? adr : _str(adr.address)) : "",
      yta: _num(o.Yta),
      arbetsplatser: _num(o.Arbetsplatser),
      budget: _num(o.Budget),
      motesrum: (Array.isArray(o["Mötesrum"]) ? o["Mötesrum"] : []).length,
      intern: (Array.isArray(o.intern_lokal) ? o.intern_lokal : []).length,
    };
  }
  function _officeWrite(p, b, isCreate) {
    if (b.name !== undefined) p["Office_title"] = _str(b.name);
    if (b.fastighet_id !== undefined) { const v = _ref(b.fastighet_id); if (v || !isCreate) p["Fastighet"] = v || ""; }
    if (b.ansvarig_ids !== undefined) { const a = Array.isArray(b.ansvarig_ids) ? b.ansvarig_ids.filter(Boolean) : []; if (a.length || !isCreate) p["Kontorsansvarig"] = a; }
    for (const [k, f] of [["yta", "Yta"], ["arbetsplatser", "Arbetsplatser"], ["budget", "Budget"]]) {
      if (b[k] !== undefined) { const n = _num(b[k]); if (n != null) p[f] = n; else if (!isCreate) p[f] = null; }
    }
    return p;
  }
  async function _createDefaultRooms(officeId, companyId) {
    const meetingIds = [], internalIds = [];
    const mr = await bubbleCreate("MeetingRoom", { Name: "Mötesrum", office: officeId, Company: companyId }).catch(() => null);
    if (mr) meetingIds.push(mr);
    for (const namn of DEFAULT_INTERNAL_ROOMS) {
      const il = await bubbleCreate("Internal_room", { Namn: namn, kontor: officeId, "kundföretag": companyId }).catch(() => null);
      if (il) internalIds.push(il);
    }
    const patch = {};
    if (meetingIds.length) patch["Mötesrum"] = meetingIds;
    if (internalIds.length) patch["intern_lokal"] = internalIds;
    if (Object.keys(patch).length) await bubblePatch("Office", officeId, patch).catch(() => {});
    return { meeting: meetingIds.length, internal: internalIds.length };
  }

  // ── GET /admin/companies/:id/offices — Kontor-listan + dropdown-data (fastigheter, medarbetare) ──
  app.options("/admin/companies/:id/offices", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/offices", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const [offs, f, cw] = await Promise.all([
        bubbleFindAll("Office", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: id }] }).catch(() => []),
        _fastigheter().catch(() => ({ map: new Map(), list: [] })),
        _companyCoworkerMap(id),
      ]);
      const rows = (offs || []).map((o) => nOffice(o, f.map, cw.map)).sort((a, b) => a.name.localeCompare(b.name, "sv"));
      return res.json({ ok: true, count: rows.length, rows, fastigheter: f.list, coworkers: cw.list });
    } catch (e) {
      console.error("[/admin/companies/:id/offices]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /admin/companies/:id/office/create — nytt kontor + auto-rumsuppsättning ──
  app.options("/admin/companies/:id/office/create", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/:id/office/create", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim();
    if (!cid) return res.status(400).json({ ok: false, error: "missing_id" });
    if (typeof bubbleCreate !== "function") return res.status(501).json({ ok: false, error: "not_configured" });
    try {
      const b = req.body || {};
      if (!_str(b.name).trim()) return res.status(400).json({ ok: false, error: "namn_krävs" });
      const payload = _officeWrite({ "Kundföretag": cid }, b, true);
      const officeId = await bubbleCreate("Office", payload);
      if (!officeId) return res.status(500).json({ ok: false, error: "create_returned_no_id" });
      const rooms = await _createDefaultRooms(officeId, cid);   // default-rum för kvalitetskontroller
      const [fresh, f, cw] = await Promise.all([bubbleGet("Office", officeId).catch(() => null), _fastigheter().catch(() => ({ map: new Map() })), _companyCoworkerMap(cid)]);
      return res.json({ ok: true, id: officeId, rooms, row: fresh ? nOffice(fresh, f.map, cw.map) : null });
    } catch (e) {
      console.error("[/admin/companies/:id/office/create]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── PATCH /admin/companies/office/:id — redigera kontor (grundfält) ──
  app.options("/admin/companies/office/:id", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.patch("/admin/companies/office/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const cur = await bubbleGet("Office", id).catch(() => null);
      if (!cur) return res.status(404).json({ ok: false, error: "office_not_found" });
      const p = _officeWrite({}, req.body || {}, false);
      if (!Object.keys(p).length) return res.status(400).json({ ok: false, error: "no_fields" });
      await bubblePatch("Office", id, p);
      const companyId = _ref(cur["Kundföretag"]) || "";
      const [fresh, f, cw] = await Promise.all([bubbleGet("Office", id).catch(() => null), _fastigheter().catch(() => ({ map: new Map() })), _companyCoworkerMap(companyId)]);
      return res.json({ ok: true, id, patched: p, row: fresh ? nOffice(fresh, f.map, cw.map) : null });
    } catch (e) {
      console.error("[/admin/companies/office/:id PATCH]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── POST /admin/companies/:id/logo — sätt/ta bort företagets logotyp (ClientCompany.logotyp) ──
  // Multipart: fält "file" (bild) → Bubble file storage → logotyp=url. Rensa: fält "clear"=1.
  app.options("/admin/companies/:id/logo", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/:id/logo", _photoMw, async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const cc = await bubbleGet("ClientCompany", id).catch(() => null);
      if (!cc) return res.status(404).json({ ok: false, error: "company_not_found" });
      const clear = req.body && (req.body.clear === "1" || req.body.clear === 1 || req.body.clear === true || req.body.clear === "true");
      const file = req.file;
      if (clear && !file) {
        await bubblePatch("ClientCompany", id, { logotyp: "" });
        return res.json({ ok: true, url: "" });
      }
      if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ ok: false, error: "no_file" });
      const ct = _str(file.mimetype || "image/png");
      if (!/^image\//i.test(ct)) return res.status(400).json({ ok: false, error: "not_image" });
      if (file.buffer.length > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: "too_large" });
      if (typeof bubbleUploadFile !== "function") return res.status(501).json({ ok: false, error: "not_configured" });
      const ext = /png/i.test(ct) ? "png" : (/webp/i.test(ct) ? "webp" : (/svg/i.test(ct) ? "svg" : "jpg"));
      const filename = ("logo_" + id + "." + ext).replace(/[^\w.\-]/g, "_");
      const url = _httpsUrl(await bubbleUploadFile({ filename, contentType: ct, buffer: file.buffer }));
      if (!url) return res.status(502).json({ ok: false, error: "upload_failed" });
      await bubblePatch("ClientCompany", id, { logotyp: url });
      return res.json({ ok: true, url });
    } catch (e) {
      console.error("[/admin/companies/:id/logo]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── Rum i ett kontor (Kontor 1b): MeetingRoom (office) + Internal_room (kontor) ──
  const _ROOM = { meeting: { type: "MeetingRoom", ref: "office", nameKey: "Name", companyKey: "Company", list: "Mötesrum" },
                  internal: { type: "Internal_room", ref: "kontor", nameKey: "Namn", companyKey: "kundföretag", list: "intern_lokal" } };
  function _byName(a, b) { return _str(a.name).localeCompare(_str(b.name), "sv"); }

  // Rummen hittas via TVÅ vägar (native-skapade rum saknar ofta tillbaka-ref, de ligger bara i
  // Office-LISTAN Mötesrum/intern_lokal): (1) per-id ur Office-listan, (2) ref-query (office/kontor).
  // Union + dedup → komplett oavsett hur rummet kopplades. (Rums-antal/kontor är litet → per-id ok.)
  function _dedupRooms(arr) { const seen = new Set(), out = []; for (const r of arr) { if (!r) continue; const id = bubbleId(r); if (id && !seen.has(id)) { seen.add(id); out.push(r); } } return out; }
  async function _officeRooms(office, oid) {
    const mrIds = (Array.isArray(office["Mötesrum"]) ? office["Mötesrum"] : []).map(_ref).filter(Boolean);
    const ilIds = (Array.isArray(office["intern_lokal"]) ? office["intern_lokal"] : []).map(_ref).filter(Boolean);
    const [mrList, ilList, mrRef, ilRef] = await Promise.all([
      Promise.all(mrIds.map((id) => bubbleGet("MeetingRoom", id).catch(() => null))),
      Promise.all(ilIds.map((id) => bubbleGet("Internal_room", id).catch(() => null))),
      bubbleFindAll("MeetingRoom", { constraints: [{ key: "office", constraint_type: "equals", value: oid }] }).catch(() => []),
      bubbleFindAll("Internal_room", { constraints: [{ key: "kontor", constraint_type: "equals", value: oid }] }).catch(() => []),
    ]);
    return { mrs: _dedupRooms([].concat(mrList, mrRef || [])), ils: _dedupRooms([].concat(ilList, ilRef || [])) };
  }

  // GET /admin/companies/office/:id/rooms — mötesrum + interna lokaler för kontoret
  app.options("/admin/companies/office/:id/rooms", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/office/:id/rooms", async (req, res) => {
    if (!guard(req, res)) return;
    const oid = _str(req.params.id).trim();
    if (!oid) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const office = await bubbleGet("Office", oid).catch(() => null);
      if (!office) return res.status(404).json({ ok: false, error: "office_not_found" });
      const { mrs, ils } = await _officeRooms(office, oid);
      const meetingrooms = mrs.map((r) => ({ id: bubbleId(r), name: _str(r.Name), email: _str(r.room_email) })).sort(_byName);
      const internals = ils.map((r) => ({ id: bubbleId(r), name: _str(r.Namn) })).sort(_byName);
      return res.json({ ok: true, meetingrooms, internals });
    } catch (e) {
      console.error("[/admin/companies/office/:id/rooms]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // POST /admin/companies/office/:id/room {type:meeting|internal, name} — lägg till rum
  app.options("/admin/companies/office/:id/room", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/office/:id/room", async (req, res) => {
    if (!guard(req, res)) return;
    const oid = _str(req.params.id).trim();
    if (!oid) return res.status(400).json({ ok: false, error: "missing_id" });
    if (typeof bubbleCreate !== "function") return res.status(501).json({ ok: false, error: "not_configured" });
    const b = req.body || {};
    const spec = _ROOM[_str(b.type)];
    if (!spec) return res.status(400).json({ ok: false, error: "bad_type" });
    const name = _str(b.name).trim();
    if (!name) return res.status(400).json({ ok: false, error: "namn_krävs" });
    try {
      const office = await bubbleGet("Office", oid).catch(() => null);
      if (!office) return res.status(404).json({ ok: false, error: "office_not_found" });
      const companyId = _ref(office["Kundföretag"]) || "";
      const payload = { [spec.nameKey]: name, [spec.ref]: oid };
      if (companyId) payload[spec.companyKey] = companyId;
      const id = await bubbleCreate(spec.type, payload);
      if (!id) return res.status(500).json({ ok: false, error: "create_returned_no_id" });
      const cur = (Array.isArray(office[spec.list]) ? office[spec.list] : []).map(_ref).filter(Boolean);
      cur.push(id);
      await bubblePatch("Office", oid, { [spec.list]: cur }).catch(() => {});
      return res.json({ ok: true, id, type: _str(b.type) });
    } catch (e) {
      console.error("[/admin/companies/office/:id/room]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // DELETE /admin/companies/office/:oid/room/:rid?type=meeting|internal — radera rum
  app.options("/admin/companies/office/:oid/room/:rid", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.delete("/admin/companies/office/:oid/room/:rid", async (req, res) => {
    if (!guard(req, res)) return;
    const oid = _str(req.params.oid).trim(), rid = _str(req.params.rid).trim();
    const spec = _ROOM[_str(req.query.type)];
    if (!oid || !rid) return res.status(400).json({ ok: false, error: "missing_id" });
    if (!spec) return res.status(400).json({ ok: false, error: "bad_type" });
    if (typeof bubbleDelete !== "function") return res.status(501).json({ ok: false, error: "not_configured" });
    try {
      const office = await bubbleGet("Office", oid).catch(() => null);
      await bubbleDelete(spec.type, rid).catch((e) => { throw e; });
      if (office) {
        const cur = (Array.isArray(office[spec.list]) ? office[spec.list] : []).map(_ref).filter((x) => x && x !== rid);
        await bubblePatch("Office", oid, { [spec.list]: cur }).catch(() => {});
      }
      return res.json({ ok: true, id: rid });
    } catch (e) {
      console.error("[/admin/companies/office/:oid/room/:rid DELETE]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ══════════════ INSTÄLLNINGAR — LEVERANTÖRER (dotterbolag) ══════════════
  // Koppling ligger på leverantören: `Leverantör - Supplier`.`Kundföretag` (List of ClientCompany).
  // "Våra dotterbolag" = leverantörer där Kundföretag contains företaget. Add/remove = patcha den listan.
  const SUPPLIER_TYPE = "Leverantör - Supplier";
  function nSupplier(s) { return { id: bubbleId(s), name: _str(s["Företagsnamn"] || s.name || s.Name), category: _str(s.Kategori || s.Category || s.kategori) }; }
  // WU: hela leverantörstabellen sveptes tidigare TVÅ gånger per anrop (här + _supplierNameMap),
  // ocachat. Add/remove skriver bara leverantörens Kundföretag-lista och påverkar inte den här
  // id+namn-listan → säkert att cacha. Nyskapade leverantörer syns inom AUX_TTL. (2026-08-17.)
  let _supCache = { rows: null, ts: 0 };
  async function _allSuppliers() {
    if (_supCache.rows && (Date.now() - _supCache.ts) < AUX_TTL) return _supCache.rows;
    const rows = await bubbleFindAll(SUPPLIER_TYPE, {}).catch(() => []);
    _supCache = { rows, ts: Date.now() };
    return rows;
  }
  async function _suppliers(companyId) {
    const [linked, all] = await Promise.all([
      bubbleFindAll(SUPPLIER_TYPE, { constraints: [{ key: "Kundföretag", constraint_type: "contains", value: companyId }] }).catch(() => []),
      _allSuppliers(),
    ]);
    const linkedIds = new Set((linked || []).map(bubbleId));
    const suppliers = (linked || []).map(nSupplier).sort(_byName);
    const available = (all || []).filter((s) => !linkedIds.has(bubbleId(s))).map(nSupplier).sort(_byName);
    return { suppliers, available };
  }

  // Personal-koppling: User.`Associated_company` (List of ClientCompany) — styr notiser m.m.
  // "Vår personal" = Users där Associated_company contains företaget. Add-pool = Users vars
  // Company == inloggad Carotte-users company (skickas som ?user_company= från blocket).
  function nStaff(u) { return { id: bubbleId(u), name: (_str(u["First Name"] || u["Förnamn"]) + " " + _str(u["Surname"] || u["Last Name"] || u["Efternamn"])).trim() || _str(u.email || u.Email), email: _str(u.email || u.Email) }; }
  // ⚠️ BARA VÅRA EGNA (2026-08-22). `Associated_company contains X` matchar ALLA
  // users med företaget i sin lista — även kundens egna. Listan visade därför både
  // Carottare och kundens medarbetare. "Vår personal" ska bara vara Carottare:
  // `Company` == den inloggade Carotte-userns company. Kundens folk finns under
  // Personer-fliken (Coworker), inte här.
  // ⚠️ Utan `user_company` går det INTE att skilja dem åt. Då filtreras inget bort,
  // och svaret bär `personnel_unfiltered:true` så UI:t kan säga varför listan kan
  // innehålla kundens users — tyst fel filter vore värre än en synlig varning.
  // ⚠️ INGET `.catch(() => [])`: en fallen fråga skulle läsas som "ingen personal
  // kopplad". Faller den blir svaret `personnel_ok:false`.
  async function _personnel(companyId, userCompanyId) {
    const fail = (what) => (e) => { console.error("[_personnel] " + what + " föll:", e?.message); return null; };
    const [linked, pool] = await Promise.all([
      bubbleFindAll("User", { constraints: [{ key: "Associated_company", constraint_type: "contains", value: companyId }] }).catch(fail("kopplade")),
      userCompanyId ? bubbleFindAll("User", { constraints: [{ key: "Company", constraint_type: "equals", value: userCompanyId }] }).catch(fail("pool")) : Promise.resolve([]),
    ]);
    if (linked === null || pool === null) {
      return { personnel: [], personnel_available: [], personnel_ok: false, personnel_unfiltered: false };
    }
    const mine = userCompanyId
      ? linked.filter((u) => _ref(u.Company) === userCompanyId)
      : linked;
    const linkedIds = new Set(linked.map(bubbleId));   // dedup mot ALLA kopplade, inte bara våra
    const personnel = mine.map(nStaff).sort(_byName);
    const personnel_available = pool.filter((u) => !linkedIds.has(bubbleId(u))).map(nStaff).sort(_byName);
    return { personnel, personnel_available, personnel_ok: true, personnel_unfiltered: !userCompanyId };
  }

  // GET /admin/companies/:id/leverantorer?user_company= — dotterbolag + personal (+ tillgängliga)
  app.options("/admin/companies/:id/leverantorer", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/leverantorer", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const [sup, staff] = await Promise.all([_suppliers(id), _personnel(id, _str(req.query.user_company).trim())]);
      return res.json({ ok: true, suppliers: sup.suppliers, available: sup.available,
        personnel: staff.personnel, personnel_available: staff.personnel_available,
        personnel_ok: staff.personnel_ok, personnel_unfiltered: staff.personnel_unfiltered });
    } catch (e) {
      console.error("[/admin/companies/:id/leverantorer]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // POST /admin/companies/:id/personal {user_id} — koppla Carotte-personal (append company → user.Associated_company)
  app.options("/admin/companies/:id/personal", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/:id/personal", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim();
    const uid = _str((req.body || {}).user_id).trim();
    if (!cid || !uid) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const u = await bubbleGet("User", uid).catch(() => null);
      if (!u) return res.status(404).json({ ok: false, error: "user_not_found" });
      const cur = (Array.isArray(u["Associated_company"]) ? u["Associated_company"] : []).map(_ref).filter(Boolean);
      if (cur.indexOf(cid) === -1) cur.push(cid);
      await bubblePatch("User", uid, { "Associated_company": cur });
      return res.json({ ok: true, id: uid, user: nStaff(u) });
    } catch (e) {
      console.error("[/admin/companies/:id/personal]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // DELETE /admin/companies/:id/personal/:uid — koppla bort personal (remove company ur Associated_company)
  app.options("/admin/companies/:id/personal/:uid", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.delete("/admin/companies/:id/personal/:uid", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim(), uid = _str(req.params.uid).trim();
    if (!cid || !uid) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const u = await bubbleGet("User", uid).catch(() => null);
      if (!u) return res.status(404).json({ ok: false, error: "user_not_found" });
      const cur = (Array.isArray(u["Associated_company"]) ? u["Associated_company"] : []).map(_ref).filter((x) => x && x !== cid);
      await bubblePatch("User", uid, { "Associated_company": cur });
      return res.json({ ok: true, id: uid });
    } catch (e) {
      console.error("[/admin/companies/:id/personal/:uid DELETE]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // POST /admin/companies/:id/leverantor {supplier_id} — koppla dotterbolag (append company → supplier.Kundföretag)
  app.options("/admin/companies/:id/leverantor", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/:id/leverantor", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim();
    const sid = _str((req.body || {}).supplier_id).trim();
    if (!cid || !sid) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const sup = await bubbleGet(SUPPLIER_TYPE, sid).catch(() => null);
      if (!sup) return res.status(404).json({ ok: false, error: "supplier_not_found" });
      const cur = (Array.isArray(sup["Kundföretag"]) ? sup["Kundföretag"] : []).map(_ref).filter(Boolean);
      if (cur.indexOf(cid) === -1) cur.push(cid);
      await bubblePatch(SUPPLIER_TYPE, sid, { "Kundföretag": cur });
      return res.json({ ok: true, id: sid, supplier: nSupplier(sup) });
    } catch (e) {
      console.error("[/admin/companies/:id/leverantor]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // DELETE /admin/companies/:id/leverantor/:sid — koppla bort (remove company ur supplier.Kundföretag)
  app.options("/admin/companies/:id/leverantor/:sid", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.delete("/admin/companies/:id/leverantor/:sid", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim(), sid = _str(req.params.sid).trim();
    if (!cid || !sid) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const sup = await bubbleGet(SUPPLIER_TYPE, sid).catch(() => null);
      if (!sup) return res.status(404).json({ ok: false, error: "supplier_not_found" });
      const cur = (Array.isArray(sup["Kundföretag"]) ? sup["Kundföretag"] : []).map(_ref).filter((x) => x && x !== cid);
      await bubblePatch(SUPPLIER_TYPE, sid, { "Kundföretag": cur });
      return res.json({ ok: true, id: sid });
    } catch (e) {
      console.error("[/admin/companies/:id/leverantor/:sid DELETE]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ══════════════ ONBOARDING — kundresans status sign → leveransklar ══════════════
  // Fem-stegs-modell för affärsvyn + kundkortet. Steg 1 (Avtal) + steg 2 (Mira teknisk
  // setup) är SKARPA — resten (Kick-off / Utbildning / Leveransklar) är MOCK i denna
  // omgång, dokumenterade i frontend som "Ej live". Utbildningsspåret ligger dock på
  // riktigt i activitet_crm med activity_type="Utbildning" (nytt värde i Bubbles
  // Option Set, tillagt 2026-08-24 av Christian) → så snart flödet börjar användas
  // slår `training.done` om utan kodändring.
  //
  // ⚠️ REGEL: tom data är ALDRIG ett svar. Faller en delfråga bär respektive check
  // `ok:false` — kortet säger "kunde inte kontrolleras", inte "ej klart". Samma
  // mönster som revenue_ready / bolag_ready / personnel_ok.
  //
  // Fältnamnen är verifierade mot hur koden faktiskt skriver/läser raderna:
  // Office.Kundföretag, ClientCompany.logotyp, User.Company (singular = kundens
  // egen user), Leverantör-Supplier.Kundföretag, User.Associated_company (list, för
  // Carotte-personal). Se HANDOFF "Företagsfält per typ" + [[reference-activitet-crm-company-fields]].
  //
  // WU: 4 constraintade queries (Office, User×2, activity_crm) + befintlig _suppliers
  // (cachad). Logo läses ur den redan warm-a CC-cachen (0 anrop).
  app.options("/admin/companies/:id/onboarding", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/onboarding", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    // CC-cacheträff: företaget finns + vi läser logotyp gratis.
    const full = await companyFullMap().catch(() => new Map());
    const proj = full.get(id);
    if (!proj) return res.status(404).json({ ok: false, error: "company_not_found", stale_cache: true });

    // Fem parallella frågor. Faller EN → egen check bär ok:false, resten fortsätter.
    // ⚠️ INGEN `.catch(() => 0)` som skulle förvandla ett fall till tyst "ingen".
    // Vi vill kunna skilja "verkligen 0" från "kunde inte kontrolleras".
    const _q = (fn) => fn().then((v) => ({ ok: true, v })).catch((e) => { console.error("[onboarding] " + id + ":", e?.message); return { ok: false, err: e?.message || String(e) }; });
    const eqc = (field) => [{ key: field, constraint_type: "equals", value: id }];

    const carotteId = _str(CAROTTE_COMPANY_ID).trim();
    const [officesR, custUsersR, suppliersR, staffR, trainingR] = await Promise.all([
      _q(() => bubbleFindAll("Office", { constraints: eqc("Kundföretag") })),
      _q(() => bubbleFindAll("User",   { constraints: eqc("Company") })),                            // kundens egna users
      _q(() => _suppliers(id)),                                                                       // {suppliers, available}
      // Carotte-medarbetare = User.Associated_company contains id AND User.Company == CAROTTE_COMPANY_ID
      // Utan env-id kan vi INTE skilja Carotte-users från kundens egna → checken bär då ok:false + hint.
      _q(async () => {
        if (!carotteId) { const e = new Error("carotte_company_id_missing"); e.hint = "sätt CAROTTE_COMPANY_ID i env"; throw e; }
        const all = await bubbleFindAll("User", { constraints: [{ key: "Associated_company", constraint_type: "contains", value: id }] });
        return (all || []).filter((u) => _ref(u.Company) === carotteId);
      }),
      // Utbildning genomförd = activitet_crm.company=id AND activity_type=Utbildning AND genomfört=yes.
      // ⚠️ activity_type är Option Set (case-sensitive) — värdet "Utbildning" MÅSTE
      // finnas i Bubbles Option Set activity_crm_type, annars ger constraintet 0.
      _q(() => bubbleFindAll("activitet_crm", { constraints: [
        { key: "company",       constraint_type: "equals", value: id },
        { key: "activity_type", constraint_type: "equals", value: "Utbildning" },
        { key: "genomfört",     constraint_type: "equals", value: true },
      ] })),
    ]);

    const officeCount   = officesR.ok    ? (officesR.v    || []).length : null;
    const custUserCount = custUsersR.ok  ? (custUsersR.v  || []).length : null;
    const supplierCount = suppliersR.ok  ? ((suppliersR.v && suppliersR.v.suppliers) || []).length : null;
    const staffCount    = staffR.ok      ? (staffR.v      || []).length : null;
    const trainingCount = trainingR.ok   ? (trainingR.v   || []).length : null;
    const logoUrl       = proj && proj.logotyp ? _httpsUrl(proj.logotyp) : "";

    // Mira teknisk setup (5 delkrav).
    const mira_checks = [
      { id: "office",   label: "Minst ett kontor skapat",     ok: officesR.ok,   done: officesR.ok   && officeCount   > 0, count: officeCount,   tab: "kontor" },
      { id: "logo",     label: "Logotyp uppladdad",           ok: true,          done: !!logoUrl,                                                  tab: "logo" },
      { id: "user",     label: "Minst en kund-user",          ok: custUsersR.ok, done: custUsersR.ok && custUserCount > 0, count: custUserCount, tab: "personer" },
      { id: "supplier", label: "Minst en leverantör",         ok: suppliersR.ok, done: suppliersR.ok && supplierCount > 0, count: supplierCount, tab: "leverantorer" },
      { id: "staff",    label: "Carotte-medarbetare knuten", ok: staffR.ok,     done: staffR.ok     && staffCount    > 0, count: staffCount,    tab: "leverantorer", hint: staffR.err },
    ];
    const done_count  = mira_checks.filter((c) => c.done).length;
    const total_count = mira_checks.length;
    // score/total tar INTE med checks som är ok:false — annars skulle en tekniskt
    // fungerande setup se ofullständig ut bara för att en Bubble-fråga föll.
    // "score_uncertain" flaggar att vi inte kan visa 5/5 ännu.
    const uncertain   = mira_checks.some((c) => !c.ok);

    // ── Övriga steg (mock i UI, men riktig data när flödet börjar användas) ──
    // Avtal: minst ett aktivt Contract räknas som "signat". Vi läser inte
    // approval-loggen här — Contract SKAPAS bara efter signat avtal och det
    // räcker för denna check. Alternativt: OfferApprovalRequest.status=Approved
    // per kund; kan läggas till senare utan att bryta kontraktet.
    const contractsR = await _q(() => bubbleFindAll("Contract", { constraints: eqc("kundföretag") }));
    const contracts  = contractsR.ok ? (contractsR.v || []) : [];
    const nowMs      = Date.now();
    const activeCount = contracts.filter((c) => { const e = c["slutdatum"] ? Date.parse(c["slutdatum"]) : 0; return !(e && !Number.isNaN(e) && e < nowMs); }).length;

    return res.json({
      ok: true,
      company_id: id,
      mira: {
        done_count, total_count,
        ready: !uncertain && done_count === total_count,
        uncertain,
        checks: mira_checks,
      },
      steps: {
        avtal:      { done: contractsR.ok && activeCount > 0, ok: contractsR.ok, count: activeCount,          mock: false },
        mira:       { done: !uncertain && done_count === total_count, ok: !uncertain, score: done_count, total: total_count, mock: false },
        kickoff:    { done: null, mock: true, label: "Kick-off-möte" },
        utbildning: { done: trainingR.ok && trainingCount > 0, ok: trainingR.ok, count: trainingCount, mock: false, label: "Utbildning genomförd" },
        leverans:   { done: null, mock: true, label: "Leveransklar" },
      },
      meta: {
        carotte_company_id_set: !!carotteId,
      },
    });
  });

  // ══════════════ INSTÄLLNINGAR — FASTIGHETSÄGARE (Hyresvärd) ══════════════
  // Koppling ligger på hyresvärden: `Hyresvärd`.`Hyresgäster` (List of ClientCompany). Att knyta
  // företaget som hyresgäst → append company till hyresvärdens Hyresgäster-lista. Styr t.ex. vilka
  // erbjudanden som visas för en fastighetsägares hyresgäster (Vasakronan etc.).
  const HYRESVARD_TYPE = "Hyresvärd";
  function nLandlord(h) { return { id: bubbleId(h), name: _str(h.Namn || h.name || h.Name) }; }
  // WU: samma mönster som _allSuppliers — add/remove skriver Hyresgäster-listan, inte id+namn.
  let _hvCache = { rows: null, ts: 0 };
  async function _allLandlords() {
    if (_hvCache.rows && (Date.now() - _hvCache.ts) < AUX_TTL) return _hvCache.rows;
    const rows = await bubbleFindAll(HYRESVARD_TYPE, {}).catch(() => []);
    _hvCache = { rows, ts: Date.now() };
    return rows;
  }
  async function _landlords(companyId) {
    const [linked, all] = await Promise.all([
      bubbleFindAll(HYRESVARD_TYPE, { constraints: [{ key: "Hyresgäster", constraint_type: "contains", value: companyId }] }).catch(() => []),
      _allLandlords(),
    ]);
    const linkedIds = new Set((linked || []).map(bubbleId));
    return { landlords: (linked || []).map(nLandlord).sort(_byName), available: (all || []).filter((h) => !linkedIds.has(bubbleId(h))).map(nLandlord).sort(_byName) };
  }

  // GET /admin/companies/:id/fastighetsagare — kopplade hyresvärdar + tillgängliga
  app.options("/admin/companies/:id/fastighetsagare", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/fastighetsagare", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const ll = await _landlords(id);
      return res.json({ ok: true, landlords: ll.landlords, available: ll.available });
    } catch (e) {
      console.error("[/admin/companies/:id/fastighetsagare]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // POST /admin/companies/:id/fastighetsagare {landlord_id} — knyt som hyresgäst (append company → Hyresvärd.Hyresgäster)
  app.post("/admin/companies/:id/fastighetsagare", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim();
    const hid = _str((req.body || {}).landlord_id).trim();
    if (!cid || !hid) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const h = await bubbleGet(HYRESVARD_TYPE, hid).catch(() => null);
      if (!h) return res.status(404).json({ ok: false, error: "landlord_not_found" });
      const cur = (Array.isArray(h["Hyresgäster"]) ? h["Hyresgäster"] : []).map(_ref).filter(Boolean);
      if (cur.indexOf(cid) === -1) cur.push(cid);
      await bubblePatch(HYRESVARD_TYPE, hid, { "Hyresgäster": cur });
      return res.json({ ok: true, id: hid, landlord: nLandlord(h) });
    } catch (e) {
      console.error("[/admin/companies/:id/fastighetsagare]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // DELETE /admin/companies/:id/fastighetsagare/:hid — koppla bort (remove company ur Hyresgäster)
  app.options("/admin/companies/:id/fastighetsagare/:hid", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.delete("/admin/companies/:id/fastighetsagare/:hid", async (req, res) => {
    if (!guard(req, res)) return;
    const cid = _str(req.params.id).trim(), hid = _str(req.params.hid).trim();
    if (!cid || !hid) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const h = await bubbleGet(HYRESVARD_TYPE, hid).catch(() => null);
      if (!h) return res.status(404).json({ ok: false, error: "landlord_not_found" });
      const cur = (Array.isArray(h["Hyresgäster"]) ? h["Hyresgäster"] : []).map(_ref).filter((x) => x && x !== cid);
      await bubblePatch(HYRESVARD_TYPE, hid, { "Hyresgäster": cur });
      return res.json({ ok: true, id: hid });
    } catch (e) {
      console.error("[/admin/companies/:id/fastighetsagare/:hid DELETE]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ══════════════ DRIFT — ärenden (Matter) + kvalitetskontroller (QualityControl) ══════════════
  // Fas 1 = LÄS på kundkortet. Båda kopplade till kund via Kundföretag(ClientCompany).
  // Ärende: status Pågående=öppen; Avvikelse=yes → Avvikelser. QC: varje yta (Mötesrum/Internal_room)
  // = en "Kommentar - Comment" (kvalitetskontroll==QC) m. Betyg(Grade.Värde)/Bild/Beskrivning.
  // Snittbetyg = medel av Grade.Värde där kvalitetskontroll==QC.
  const _img1 = (v) => { if (Array.isArray(v)) return _httpsUrl(v[0]); return _httpsUrl(v); };
  // Trådkommentarer: tvätta native-datumstämpeln (YYMMDD,HH:MM / YYMMDD HH:MM) → "D mmm YYYY · HH:MM"
  const _MONTHS_SV = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  function _prettyStamp(yy, mm, dd, hh, mi) {
    const year = 2000 + Number(yy), mon = _MONTHS_SV[Number(mm) - 1] || String(mm);
    return Number(dd) + " " + mon + " " + year + " · " + String(hh).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  }
  function _cleanTrad(line) {
    line = _str(line);
    // Format B (datum-först m. snedstreck): "YY/MM/DD, HH:MM:SS / Namn: kommentar" → "Namn · D mmm YYYY · HH:MM: kommentar"
    const b = line.match(/^\s*(\d{2})\/(\d{2})\/(\d{2}),?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*\/\s*([^:]+?):\s*([\s\S]*)$/);
    if (b) return b[6].trim() + " · " + _prettyStamp(b[1], b[2], b[3], b[4], b[5]) + ": " + b[7].trim();
    // Format A (namn-först): reformatera YYMMDD,HH:MM-token inline
    return line.replace(/\b(\d{2})(\d{2})(\d{2})[,\s]+(\d{1,2})[:.](\d{2})\b/g, (m, yy, mm, dd, hh, mi) => _prettyStamp(yy, mm, dd, hh, mi)).replace(/,\s*·/g, " ·");
  }
  function _nowStampSV() {
    try {
      const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      const p = {}; for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
      return _prettyStamp(String(p.year).slice(2), p.month, p.day, p.hour, p.minute);
    } catch (_) { return ""; }
  }
  const _imgs = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(_httpsUrl).filter(Boolean);
  async function _officeNameMap(companyId) {
    const offs = await bubbleFindAll("Office", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: companyId }] }).catch(() => []);
    const m = new Map(); for (const o of (offs || [])) { const id = bubbleId(o); if (id) m.set(id, _str(o.Office_title || o.name || o.Name)); } return m;
  }
  async function _contractNameMap(companyId) {
    const cs = await bubbleFindAll("Contract", { constraints: [{ key: "kundföretag", constraint_type: "equals", value: companyId }] }).catch(() => []);
    const m = new Map(); for (const c of (cs || [])) { const id = bubbleId(c); if (id) m.set(id, _str(c.contract_title || c["kategori"] || c.title)); } return m;
  }
  async function _supplierNameMap() {
    const all = await _allSuppliers();   // WU: delad, cachad leverantörslista (se _allSuppliers)
    const m = new Map(); for (const s of (all || [])) { const id = bubbleId(s); if (id) m.set(id, _str(s["Företagsnamn"] || s.name || s.Name)); } return m;
  }
  async function _roomNameMap(ids) {
    const uniq = Array.from(new Set((ids || []).filter(Boolean)));
    const m = new Map();
    await Promise.all(uniq.map(async (id) => {
      let r = await bubbleGet("Internal_room", id).catch(() => null);
      if (r) { m.set(id, _str(r.Namn || r.name)); return; }
      r = await bubbleGet("MeetingRoom", id).catch(() => null);
      if (r) m.set(id, _str(r.Name || r.Namn));
    }));
    return m;
  }
  // Status Ärende-OS: distinkta värden ur datan (cachad första-sida) → status-dropdown utan att gissa OS.
  let _statusCache = { list: null, ts: 0 };
  async function _matterStatuses() {
    if (_statusCache.list && (Date.now() - _statusCache.ts) < 10 * 60 * 1000) return _statusCache.list;
    const rows = await bubbleFind("Matter", {}).catch(() => []);
    const set = new Set();
    for (const r of (rows || [])) { const st = _str(r.status); if (st) set.add(st); }
    set.add("Pågående");
    const list = Array.from(set).sort();
    _statusCache = { list, ts: Date.now() };
    return list;
  }
  function nMatter(r, um, om) {
    const refId = _ref(r.Referens), kid = _ref(r.Kontor);
    const st = _str(r.status) || "Pågående";
    return {
      id: bubbleId(r),
      company_id: _ref(r["Kundföretag"]) || null,
      rubrik: _str(r.Rubrik) || _str(r.case_title) || "Ärende",
      beskrivning: _str(r.Beskrivning) || _str(r.case_description_clean),
      datum: _day(r.reported_at || r["Created Date"]),
      referens: (refId && um) ? (um.get(refId) || "") : _str(r.reported_by_name),
      prioritet: _str(r.Prioritet),
      kontor: (kid && om) ? (om.get(kid) || "") : "",
      status: st,
      open: st === "Pågående",
      avvikelse: r.Avvikelse === true,
      bild: _img1(r.Bild),
      kategori: _str(r.case_category),
    };
  }
  function nQC(r, um, om, cm, sm) {
    const kid = _ref(r.Kontor), avId = _ref(r.Avtal), leId = _ref(r.Leverantör), ktId = _ref(r.Kontrollant);
    return {
      id: bubbleId(r),
      company_id: _ref(r["Kundföretag"]) || null,
      titel: _str(r.Titel) || "Kvalitetskontroll",
      datum: _day(r.kontrolldatum || r["Created Date"]),
      kontor: (kid && om) ? (om.get(kid) || "") : "",
      avtal: (avId && cm) ? (cm.get(avId) || "") : "",
      snittbetyg: _num(r.Betyg_lev),
      leverantor: (leId && sm) ? (sm.get(leId) || "") : "",
      kontrollant: (ktId && um) ? (um.get(ktId) || "") : "",
    };
  }

  // GET /admin/companies/:id/matters — alla ärenden för kunden (frontend delar öppna/avslutade/avvikelser)
  app.options("/admin/companies/:id/matters", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/matters", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const [raw, uc, om] = await Promise.all([
        bubbleFindAll("Matter", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: id }] }).catch(() => []),
        _users().catch(() => null),
        _officeNameMap(id),
      ]);
      const rows = (raw || []).map((r) => nMatter(r, uc && uc.map, om)).sort((a, b) => (Date.parse(b.datum) || 0) - (Date.parse(a.datum) || 0));
      return res.json({ ok: true, count: rows.length, rows });
    } catch (e) {
      console.error("[/admin/companies/:id/matters]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // GET /admin/companies/matter/:id — ärende-detalj (läs)
  app.options("/admin/companies/matter/:id", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/matter/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const m = await bubbleGet("Matter", id).catch(() => null);
      if (!m) return res.status(404).json({ ok: false, error: "matter_not_found" });
      const companyId = _ref(m["Kundföretag"]) || "";
      const [uc, om, cw, statusOptions] = await Promise.all([_users().catch(() => null), _officeNameMap(companyId), _companyCoworkerMap(companyId), _matterStatuses().catch(() => ["Pågående"])]);
      const base = nMatter(m, uc && uc.map, om);
      const internIds = (Array.isArray(m["Team åtgärd intern"]) ? m["Team åtgärd intern"] : (m["Team åtgärd intern"] ? [m["Team åtgärd intern"]] : [])).map(_ref).filter(Boolean);
      const team_intern = internIds.map((cid) => cw.map.get(cid) || "").filter(Boolean);
      // extern team (Konsult) → best-effort namn
      const externIds = (Array.isArray(m["Team åtgärd extern"]) ? m["Team åtgärd extern"] : (m["Team åtgärd extern"] ? [m["Team åtgärd extern"]] : [])).map(_ref).filter(Boolean);
      const externRows = await Promise.all(externIds.map((kid) => bubbleGet("Konsult - Consultant", kid).catch(() => null)));
      const team_extern = externRows.filter(Boolean).map((k) => (_str(k["Förnamn"] || k["First Name"]) + " " + _str(k["Efternamn"] || k["Last Name"])).trim() || _str(k.Email || k.email || k["Företagsnamn"])).filter(Boolean);
      const trad = (Array.isArray(m["Tråd"]) ? m["Tråd"] : (m["Tråd"] ? [m["Tråd"]] : [])).map(_str).filter(Boolean).map(_cleanTrad);
      const detail = Object.assign(base, {
        team_intern, team_extern, trad,
        feedback: _str(m.Feedback), forbattring: _str(m["Förbättring"]),
        internservice: m.Internservice === true,
        bilder: _imgs(m.Bild),
        status_options: statusOptions,
      });
      return res.json({ ok: true, matter: detail });
    } catch (e) {
      console.error("[/admin/companies/matter/:id]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // POST /admin/companies/matter/:id/status {status} — uppdatera ärendets status
  app.options("/admin/companies/matter/:id/status", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/matter/:id/status", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    const status = _str((req.body || {}).status).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    if (!status) return res.status(400).json({ ok: false, error: "missing_status" });
    try {
      const m = await bubbleGet("Matter", id).catch(() => null);
      if (!m) return res.status(404).json({ ok: false, error: "matter_not_found" });
      const patch = { status };
      if (status !== "Pågående") patch["closed_date"] = new Date().toISOString();
      await bubblePatch("Matter", id, patch);
      return res.json({ ok: true, id, status });
    } catch (e) {
      console.error("[/admin/companies/matter/:id/status]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // POST /admin/companies/matter/:id/comment {text, author} — lägg inlägg i tråden (Tråd = List of texts)
  app.options("/admin/companies/matter/:id/comment", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/matter/:id/comment", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    const text = _str((req.body || {}).text).trim();
    const author = _str((req.body || {}).author).trim() || "Carotte";
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    if (!text) return res.status(400).json({ ok: false, error: "tom_kommentar" });
    try {
      const m = await bubbleGet("Matter", id).catch(() => null);
      if (!m) return res.status(404).json({ ok: false, error: "matter_not_found" });
      const cur = (Array.isArray(m["Tråd"]) ? m["Tråd"] : (m["Tråd"] ? [m["Tråd"]] : [])).map(_str);
      const line = author + " · " + _nowStampSV() + ": " + text;
      cur.push(line);
      await bubblePatch("Matter", id, { "Tråd": cur });
      return res.json({ ok: true, id, line: _cleanTrad(line) });
    } catch (e) {
      console.error("[/admin/companies/matter/:id/comment]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // GET /admin/companies/:id/qc — alla kvalitetskontroller för kunden
  app.options("/admin/companies/:id/qc", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/:id/qc", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const [raw, uc, om, cm, sm] = await Promise.all([
        bubbleFindAll("QualityControl", { constraints: [{ key: "Kundföretag", constraint_type: "equals", value: id }] }).catch(() => []),
        _users().catch(() => null), _officeNameMap(id), _contractNameMap(id), _supplierNameMap(),
      ]);
      const rows = (raw || []).map((r) => nQC(r, uc && uc.map, om, cm, sm)).sort((a, b) => (Date.parse(b.datum) || 0) - (Date.parse(a.datum) || 0));
      return res.json({ ok: true, count: rows.length, rows });
    } catch (e) {
      console.error("[/admin/companies/:id/qc]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // GET /admin/companies/qc/:id — kvalitetskontroll-detalj (ytorna + snittbetyg + summering + kundutvärdering)
  app.options("/admin/companies/qc/:id", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/companies/qc/:id", async (req, res) => {
    if (!guard(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const qc = await bubbleGet("QualityControl", id).catch(() => null);
      if (!qc) return res.status(404).json({ ok: false, error: "qc_not_found" });
      const companyId = _ref(qc["Kundföretag"]) || "";
      const [uc, om, cm, sm, komments, grades, full] = await Promise.all([
        _users().catch(() => null), _officeNameMap(companyId), _contractNameMap(companyId), _supplierNameMap(),
        bubbleFindAll("Kommentar - Comment", { constraints: [{ key: "kvalitetskontroll", constraint_type: "equals", value: id }] }).catch(() => []),
        bubbleFindAll("Grade", { constraints: [{ key: "kvalitetskontroll", constraint_type: "equals", value: id }] }).catch(() => []),
        companyFullMap().catch(() => new Map()),
      ]);
      const gradeVal = new Map(); const gvals = [];
      for (const g of (grades || [])) { const gid = bubbleId(g); const v = _num(g["Värde"]); if (gid != null) gradeVal.set(gid, v); if (v != null) gvals.push(v); }
      // surface-namn: samla intern_lokal + mötesrum-refs ur kommentarerna, resolva
      const surfIds = []; for (const k of (komments || [])) { const il = _ref(k.Intern_lokal); const mr = _ref(k["Mötesrum"]); if (il) surfIds.push(il); if (mr) surfIds.push(mr); }
      const roomNames = await _roomNameMap(surfIds);
      const surfaces = (komments || []).map((k) => {
        const il = _ref(k.Intern_lokal), mr = _ref(k["Mötesrum"]);
        const betygId = _ref(k.Betyg);
        return {
          namn: (il && roomNames.get(il)) || (mr && roomNames.get(mr)) || "Yta",
          betyg: betygId != null ? (gradeVal.get(betygId) != null ? gradeVal.get(betygId) : null) : null,
          bild: _img1(k.Bild),
          kommentar: _str(k.Beskrivning),
          godkand: k["Godkänd"] === true,
        };
      });
      const snitt = gvals.length ? Math.round((gvals.reduce((a, b) => a + b, 0) / gvals.length) * 100) / 100 : (_num(qc.Betyg_lev));
      const kid = _ref(qc.Kontor), avId = _ref(qc.Avtal), leId = _ref(qc.Leverantör), ktId = _ref(qc.Kontrollant);
      const krIds = (Array.isArray(qc["Kundreferens"]) ? qc["Kundreferens"] : (qc["Kundreferens"] ? [qc["Kundreferens"]] : [])).map(_ref).filter(Boolean);
      const cwMap = (await _companyCoworkerMap(companyId)).map;
      return res.json({
        ok: true,
        qc: {
          id, titel: _str(qc.Titel) || "Kvalitetskontroll",
          datum: _day(qc.kontrolldatum || qc["Created Date"]),
          kontor: (kid && om.get(kid)) || "",
          avtal: (avId && cm.get(avId)) || "",
          leverantor: (leId && sm.get(leId)) || "",
          kontrollant: (ktId && uc && uc.map.get(ktId)) || "",
          kund: (full.get(companyId) && full.get(companyId).name) || "",
          kundreferens: krIds.map((c) => cwMap.get(c) || "").filter(Boolean),
          snittbetyg: snitt,
          summering: { arbetsklader: qc["arbetskläder"] === true, servicekort: qc.servicekort === true, stadforrad: qc["städförråd"] === true, meddelande: _str(qc.Meddelande) },
          kundutvardering: { betyg: _str(qc.betyg_client), feedback: _str(qc.feedback_client) },
          surfaces,
        },
      });
    } catch (e) {
      console.error("[/admin/companies/qc/:id]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── DRIFT stå-alone (Fas 4): aggregerar ärenden/QC över ALLA kunder + sök/filter/paginering ──
  // Per-request Bubble-sök m. constraints (WU-bundet via scope-default Pågående). Detalj återanvänder
  // /admin/companies/matter/:id + /qc/:id. Namn: företag via delad companyFullMap, kontor via bubbleGet
  // på sidans Kontor-ids (bounded), referens/kontrollant via _users, leverantör/avtal via små mappar.
  async function _officeNamesByIds(ids) {
    const uniq = Array.from(new Set((ids || []).filter(Boolean)));
    const m = new Map();
    await Promise.all(uniq.map(async (id) => { const o = await bubbleGet("Office", id).catch(() => null); if (o) m.set(id, _str(o.Office_title || o.name || o.Name)); }));
    return m;
  }
  app.options("/admin/drift/list", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.get("/admin/drift/list", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const type = _str(req.query.type).trim() || "matters";
      const q = _str(req.query.q).trim().toLowerCase();
      const companyQ = _str(req.query.company).trim().toLowerCase();
      const prio = _str(req.query.prio).trim();
      const scope = _str(req.query.scope).trim() || "open";
      const page = Math.max(1, parseInt(_str(req.query.page), 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(_str(req.query.limit), 10) || 40));
      const full = await companyFullMap().catch(() => new Map());
      // företagsnamn-sök → id-set
      let companyIds = null;
      if (companyQ) { companyIds = new Set(); for (const [id, c] of full) { if (c && c.name && c.name.toLowerCase().indexOf(companyQ) > -1) companyIds.add(id); } }

      // WU: filtrera/sortera/paginera på RÅDATAN och resolva kontorsnamn först för den
      // sida vi faktiskt returnerar. Tidigare kördes `_officeNamesByIds` över HELA
      // resultatet → en bubbleGet per distinkt Kontor i hela tabellen (dolt N+1).
      // Nu ≤ `limit` distinkta kontor per request. (2026-08-17.)
      const _rawCompany = (r) => _ref(r["Kundföretag"]) || null;
      const _pageOf = (arr) => arr.slice((page - 1) * limit, page * limit);

      if (type === "qc") {
        // `q` går ner i Bubble som constraint (samma mönster som matters) i st.f. helsvep + filter i minnet.
        const qcConstraints = [];
        if (q) qcConstraints.push({ key: "Titel", constraint_type: "text contains", value: q });
        let raw = await bubbleFindAll("QualityControl", { constraints: qcConstraints }).catch(() => []);
        if (companyIds) raw = raw.filter((r) => { const cid = _rawCompany(r); return cid && companyIds.has(cid); });
        raw.sort((a, b) => (Date.parse(_str(b.kontrolldatum || b["Created Date"])) || 0) - (Date.parse(_str(a.kontrolldatum || a["Created Date"])) || 0));
        const total = raw.length, pages = Math.max(1, Math.ceil(total / limit));
        const pageRaw = _pageOf(raw);
        const [uc, sm, okIds] = await Promise.all([
          _users().catch(() => null), _supplierNameMap(),
          _officeNamesByIds(pageRaw.map((r) => _ref(r.Kontor))),
        ]);
        const rows = pageRaw.map((r) => {
          const o = nQC(r, uc && uc.map, okIds, new Map(), sm);
          o.company = (o.company_id && full.get(o.company_id)) ? full.get(o.company_id).name : "";
          return o;
        });
        return res.json({ ok: true, type, total, pages, page, rows });
      }

      // matters
      const constraints = [];
      if (scope === "open") constraints.push({ key: "status", constraint_type: "equals", value: "Pågående" });
      else if (scope === "closed") constraints.push({ key: "status", constraint_type: "equals", value: "Avslutat" });   // Status Ärende-OS: Pågående/Avslutat/Utkast — Utkast hamnar korrekt i varken öppet/avslutat
      else if (scope === "avvikelser") constraints.push({ key: "Avvikelse", constraint_type: "equals", value: "true" });
      if (prio) constraints.push({ key: "Prioritet", constraint_type: "equals", value: prio });
      if (q) constraints.push({ key: "Rubrik", constraint_type: "text contains", value: q });
      let raw = await bubbleFindAll("Matter", { constraints }).catch(() => []);
      if (companyIds) raw = raw.filter((r) => { const cid = _rawCompany(r); return cid && companyIds.has(cid); });
      raw.sort((a, b) => (Date.parse(_str(b.reported_at || b["Created Date"])) || 0) - (Date.parse(_str(a.reported_at || a["Created Date"])) || 0));
      const mTotal = raw.length, mPages = Math.max(1, Math.ceil(mTotal / limit));
      const mPageRaw = _pageOf(raw);
      const [uc, okIds] = await Promise.all([
        _users().catch(() => null),
        _officeNamesByIds(mPageRaw.map((r) => _ref(r.Kontor))),
      ]);
      let rows = mPageRaw.map((r) => {
        const o = nMatter(r, uc && uc.map, okIds);
        o.company = (o.company_id && full.get(o.company_id)) ? full.get(o.company_id).name : "";
        return o;
      });
      // Prioritet-facetten måste räknas på HELA träffmängden (raw), inte bara sidan.
      const prioSet = Array.from(new Set(raw.map((r) => _str(r.Prioritet)).filter(Boolean))).sort();
      return res.json({ ok: true, type, scope, total: mTotal, pages: mPages, page, prioriteter: prioSet, rows });
    } catch (e) {
      console.error("[/admin/drift/list]", e?.message);
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
      // ⚠️ BRÄNN TOKEN — måste lyckas innan vi lämnar ut ett temp-lösenord.
      // PasswordReset-typen har BARA {email, coworker, token_hash, expires_at, used}.
      // Tidigare patchades även `used_at` (finns inte) → Bubble avvisade HELA patchen,
      // så `used` sattes aldrig och länken gick att återanvända i 24 h. Felet doldes
      // dessutom av ett .catch(() => {}). Fail-closed: kan vi inte bränna token så
      // delar vi inte ut lösenord. (2026-08-18)
      try {
        await bubblePatch("PasswordReset", bubbleId(row), { used: true });
      } catch (e) {
        console.error("[/admin/reset-password/exchange] kunde inte bränna token:", e?.message, e?.detail);
        return res.status(500).json({ ok: false, error: "burn_failed", hint: "token ej markerad som använd — inget lösenord utlämnat" });
      }
      const r = await assignTempPassword({ email: _str(row.email) });
      if (!r || !r.ok || !r.temp_password) return res.status(502).json({ ok: false, error: (r && r.error) || "assign_failed", hint: (r && r.hint) || null });
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
  // ══════════════ MASS-SÄTT REGION UTIFRÅN KUNDANSVARIG ══════════════
  // POST /admin/companies/region-bulk
  //   { mapping: {"andriette@carotte.se":"Öst", ...} | [{email,region}], dry_run, force, limit }
  //
  // Bakgrund: regionsindelningen är gles på ClientCompany, men kundansvarig är satt.
  // Ansvarig → region är därför en tillräckligt bra härledning för att fylla luckorna.
  //
  // ⚠️ FYLLER BARA TOMMA (Christians beslut 2026-08-19). Bolag som redan har ett
  // regionvärde rörs ALDRIG — men rapporteras som `conflict` när värdet avviker från
  // det mappningen skulle satt, så avvikelserna går att titta på separat.
  // ⚠️ Målregionerna valideras mot de värden som FAKTISKT förekommer i datan (samma
  // `_facets`-härledning som inline-editen) — vi gissar aldrig option-set-värden.
  // Behöver man införa ett helt nytt regionvärde krävs `force:true`, medvetet.
  // Default är `dry_run:true`: man måste be om att skriva.
  app.options("/admin/companies/region-bulk", (req, res) => { if (planningCors) planningCors(req, res); res.sendStatus(204); });
  app.post("/admin/companies/region-bulk", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = req.body || {};
      const dryRun = body.dry_run !== false;                 // default: torrkörning
      const force = body.force === true;
      const limit = Math.min(5000, Math.max(1, parseInt(body.limit, 10) || 2000));

      // Mappning: objekt {email: region} ELLER array [{email, region}]
      const pairs = [];
      if (Array.isArray(body.mapping)) {
        for (const m of body.mapping) if (m) pairs.push([_low(m.email).trim(), _str(m.region).trim()]);
      } else if (body.mapping && typeof body.mapping === "object") {
        for (const [k, v] of Object.entries(body.mapping)) pairs.push([_low(k).trim(), _str(v).trim()]);
      }
      const clean = pairs.filter(([e, r]) => e && r);
      if (!clean.length) return res.status(400).json({ ok: false, error: "empty_mapping" });

      const [full, uc] = await Promise.all([companyFullMap(), _users()]);
      const facets = _facets(full);
      const knownRegions = facets.region || [];

      // Okända regionvärden → stopp med listan på vad som finns, om inte force.
      const unknownRegions = [...new Set(clean.map(([, r]) => r))].filter((r) => !knownRegions.includes(r));
      if (unknownRegions.length && !force) {
        return res.status(400).json({
          ok: false, error: "unknown_region_value", unknown: unknownRegions, known_regions: knownRegions,
          hint: "Regionvärdet finns inte på något företag idag. Kontrollera stavningen mot known_regions, eller skicka force:true om det är ett nytt värde i option-setet.",
        });
      }

      // E-post → User-id. Okända mejl stoppar INTE körningen, men rapporteras —
      // annars ser en felstavad adress ut som "0 bolag" och tystnar.
      const byEmail = uc.byEmail || new Map();
      const owners = [], unknownEmails = [];
      for (const [email, region] of clean) {
        const uid = byEmail.get(email);
        if (!uid) { unknownEmails.push(email); continue; }
        owners.push({ email, region, user_id: uid, name: uc.map.get(uid) || email });
      }
      if (!owners.length) {
        return res.status(400).json({ ok: false, error: "no_matching_users", unknown_emails: unknownEmails });
      }

      // Gruppera företagen per ansvarig. Läser ur den delade CC-cachen → NOLL nya
      // Bubble-svep (både Kundansvarig och Region ligger i _projectCompany).
      const byOwner = new Map(owners.map((o) => [o.user_id, o]));
      const plan = new Map();   // user_id → { ...owner, total, would_set:[], already:0, conflict:[] }
      for (const o of owners) plan.set(o.user_id, Object.assign({}, o, { total: 0, would_set: [], already: 0, conflict: [] }));
      let noOwner = 0;
      for (const c of full.values()) {
        const oid = c.ansvarig_id;
        if (!oid) { noOwner++; continue; }
        const o = byOwner.get(oid); if (!o) continue;
        const p = plan.get(oid);
        p.total++;
        const cur = _str(c.region).trim();
        if (!cur) p.would_set.push({ id: c.id, name: c.name });
        else if (cur === o.region) p.already++;
        else p.conflict.push({ id: c.id, name: c.name, region: cur });
      }

      const report = [...plan.values()].map((p) => ({
        email: p.email, name: p.name, user_id: p.user_id, region: p.region,
        companies: p.total, would_set: p.would_set.length, already_correct: p.already,
        conflicts: p.conflict.length,
        // Namn på de som skulle ändras / avviker — så man kan stickprova innan skarp körning.
        would_set_examples: p.would_set.slice(0, 10).map((x) => x.name),
        conflict_examples: p.conflict.slice(0, 10).map((x) => x.name + " (" + x.region + ")"),
      })).sort((a, b) => b.would_set - a.would_set);

      const targets = [].concat(...[...plan.values()].map((p) => p.would_set.map((x) => ({ id: x.id, name: x.name, region: p.region }))));
      const totals = {
        would_set: targets.length,
        already_correct: report.reduce((n, r) => n + r.already_correct, 0),
        conflicts: report.reduce((n, r) => n + r.conflicts, 0),
        companies_without_owner: noOwner,
      };

      if (dryRun) {
        return res.json({ ok: true, dry_run: true, known_regions: knownRegions, unknown_emails: unknownEmails, unknown_regions: unknownRegions, owners: report, totals, capped: targets.length > limit ? limit : null });
      }

      // ── Skarp körning ──────────────────────────────────────────────
      // Sekventiellt i små klumpar: Bubbles Data API blir ostabilt vid hög parallellism
      // och en halvskriven mängd är svårare att reda ut än en långsam körning.
      const slice = targets.slice(0, limit);
      const failed = [];
      let updated = 0;
      for (let i = 0; i < slice.length; i += 5) {
        const chunk = slice.slice(i, i + 5);
        await Promise.all(chunk.map(async (t) => {
          try {
            await bubblePatch("ClientCompany", t.id, { Region: t.region });
            updated++;
            // Håll den delade cachen i takt så listan/kortet visar nya regionen direkt.
            if (companyPatchEntry) {
              const fresh = await bubbleGet("ClientCompany", t.id).catch(() => null);
              if (fresh) companyPatchEntry(t.id, fresh);
            }
          } catch (e) {
            failed.push({ id: t.id, name: t.name, error: e?.message || String(e) });
          }
        }));
      }
      console.log("[region-bulk] uppdaterade " + updated + "/" + slice.length + " företag, " + failed.length + " fel");
      return res.json({ ok: true, dry_run: false, updated, attempted: slice.length, failed, remaining: Math.max(0, targets.length - slice.length), known_regions: knownRegions, unknown_emails: unknownEmails, owners: report, totals });
    } catch (e) {
      console.error("[/admin/companies/region-bulk]", e?.message, e?.detail);
      return res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

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
      const refMaps = {};   // lat: referens-listor hämtas bara om ett reflist-fält skrivs
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
        } else if (spec.type === "reflist") {
          // Hela listan skickas varje gång (add/remove sker i frontenden). Tar array,
          // kommaseparerad sträng eller "" (= töm listan).
          const arr = Array.isArray(val) ? val : (_str(val).trim() === "" ? [] : _str(val).split(","));
          // ⚠️ Bubble svarar 400 MISSING_DATA på ett referens-id som inte finns (se
          // _deadRefId i index.js). Validera mot Fastighet-cachen och svara begripligt
          // i stället för att låta Bubble braka på ett id vi själva kunde ha stoppat.
          const LOADERS = { fastighet: async () => (await _fastigheter()).map };
          if (!LOADERS[spec.ref]) return res.status(500).json({ ok: false, error: `unsupported_reflist:${key}` });
          if (!refMaps[spec.ref]) refMaps[spec.ref] = await LOADERS[spec.ref]();
          const known = refMaps[spec.ref];
          const ids = [];
          for (const raw of arr) {
            const rid = _ref(_str(raw).trim());
            if (!rid) continue;
            if (!known.has(rid)) return res.status(400).json({ ok: false, error: `unknown_ref_id:${key}`, value: rid });
            if (ids.indexOf(rid) < 0) ids.push(rid);   // dubbletter i en Bubble-lista är meningslösa
          }
          payload[spec.bubbleField] = ids;
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

  // Delas med index.js (kommunikationsmodulens kundansvarig-väljare). Återanvänder
  // den redan cachade User-svepningen — utan detta hade comms-modulen behövt ett
  // EGET helsvep av User (flera tusen rader) för att få namn/e-post.
  return {
    async userDirectory() {
      const uc = await _users();
      return (uc.list || []).map((u) => ({ id: u.id, name: u.name, email: u.email || "" }));
    },
  };
}
