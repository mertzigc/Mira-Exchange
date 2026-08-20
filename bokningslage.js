// ────────────────────────────────────────────────────────────────────────────
// bokningslage.js — samlat orderläge över Carottes tre affärsområden
//
//   Service & People → IntelliplanOrderMonth      (intjänat per order och månad)
//   Housekeeping     → FortnoxOrder, connection = TENGELLA   (workorder, §9d)
//   Food & Event     → FortnoxOrder, connection = FE  + MiraOrder (Miras egen offertväg)
//
// ⚠️ TALEN ÄR INTE SAMMA SORT. Intelliplan ger intjänat för arbete UTFÖRT i
// månaden. En FortnoxOrder har ett ordervärde och ett leveransdatum — hela
// ordern landar på leveransmånaden. Summera dem aldrig utan att säga vad summan
// betyder.
//
// ⚠️ INNEVARANDE MÅNAD ÄR OFULLSTÄNDIG i Intelliplan (juli mitt i månaden hade
// 1 024 rader mot junis 2 315). Jämför den mot SAMMA DAG i tidigare månader —
// aldrig mot deras slutsummor, då ser varje pågående månad ut som ett ras.
//
// Rena funktioner här, routes i index.js (samma uppdelning som intelliplan.js).
// ────────────────────────────────────────────────────────────────────────────

const _num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const _str = (v) => (v == null ? "" : String(v)).trim();
const _day = (v) => { const s = _str(v); return s ? s.slice(0, 10) : null; };
const _id = (v) => (v == null ? null : (typeof v === "string" ? v : (v._id || v.id || null)));

/** Ordernummer jämförbart: versaler, bara alfanumeriskt. "MO-1042 " → "MO1042" */
export function normOrderNo(v) {
  return _str(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** MiraOrder → jämförbar form. leveransdatum styr perioden, inte orderdatum. */
export function normMiraOrder(r) {
  return {
    source: "MiraOrder", id: _id(r),
    order_no: _str(r.ordernr), order_no_n: normOrderNo(r.ordernr),
    company: _id(r.kundforetag), date: _day(r.leveransdatum || r.orderdatum),
    total: _num(r.total) || 0, status: _str(r.orderstatus), offert: _id(r.offert),
  };
}

/**
 * FortnoxOrder → jämförbar form.
 *
 * ⚠️ MOMS. `ft_total` är Fortnox `Total` = **inklusive moms** (Total = Net +
 * TotalVAT). `ft_net` är beloppet **exklusive** moms. Det spelar ingen roll för
 * MATCHNINGEN — `MiraOrder.total` är också inkl moms (`total = summa +
 * moms_belopp`, affar_api.js recomputeOrderTotals), så total↔total är rätt par.
 * Men det spelar all roll för en VY: Intelliplans intäkt är exkl moms, och att
 * ställa 8,1 Mkr inkl moms bredvid 6,85 Mkr exkl moms överdriver F&E med ~25 %.
 * Kodbasens egen avstämning mot bokföringen summerar `ft_net`, inte `ft_total`
 * (/kpi/sales/reconcile: "net_sum_active: summa ft_net").
 *
 * ⚠️ `ft_net` skrivs BARA vid detail-fetch (index.js: "List-svar saknar dessa").
 * Rader utan det får `net: null` — INTE 0. Ett saknat värde som blir en nolla
 * drar ner en summa tyst, och det är precis den sortens tystnad vi jagar.
 */
export function normFortnoxOrder(r) {
  return {
    source: "FortnoxOrder", id: _id(r),
    order_no: _str(r.ft_document_number), order_no_n: normOrderNo(r.ft_document_number),
    company: _id(r.linked_company), date: _day(r.ft_delivery_date || r["Created Date"]),
    total: _num(r.ft_total) || 0, net: _num(r.ft_net), connection: _id(r.connection_id),
    cancelled: r.ft_cancelled === true || _str(r.ft_cancelled).toLowerCase() === "ja",
  };
}

/**
 * Mäter överlappet mellan MiraOrder (F&E via Miras offertväg) och FortnoxOrder
 * med FE-connection. Vi VET inte att de överlappar — Fortnox sätter egna
 * dokumentnummer — så tre strategier provas i fallande säkerhet och utfallet
 * redovisas per strategi. Ingen summering sker här; det här är underlag för
 * beslutet om hur F&E ska räknas, inte ett facit.
 *
 * 1. `exact_no`   — ordernr === ft_document_number (starkast)
 * 2. `company_date_total` — samma kund, samma dag, samma belopp (inom tolerans)
 * 3. `company_total` — samma kund, samma belopp, datum inom `dayWindow`
 */
export function feOverlap(miraRows, fortnoxRows, opts = {}) {
  const tol = opts.tolerance != null ? opts.tolerance : 1;      // kr
  const dayWindow = opts.dayWindow != null ? opts.dayWindow : 31;
  const mira = (miraRows || []).map(normMiraOrder);
  const fx = (fortnoxRows || []).map(normFortnoxOrder).filter((r) => !r.cancelled);

  const byNo = new Map();
  for (const f of fx) if (f.order_no_n) { if (!byNo.has(f.order_no_n)) byNo.set(f.order_no_n, []); byNo.get(f.order_no_n).push(f); }

  const daysApart = (a, b) => {
    if (!a || !b) return Infinity;
    return Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5;
  };
  const usedFx = new Set();
  const matches = { exact_no: [], company_date_total: [], company_total: [] };
  const unmatchedMira = [];

  for (const m of mira) {
    let hit = null, via = null;
    const cand = (m.order_no_n && byNo.get(m.order_no_n)) || [];
    hit = cand.find((f) => !usedFx.has(f.id));
    if (hit) via = "exact_no";
    if (!hit) {
      hit = fx.find((f) => !usedFx.has(f.id) && f.company && f.company === m.company
        && f.date && f.date === m.date && Math.abs(f.total - m.total) <= tol);
      if (hit) via = "company_date_total";
    }
    if (!hit) {
      hit = fx.find((f) => !usedFx.has(f.id) && f.company && f.company === m.company
        && Math.abs(f.total - m.total) <= tol && daysApart(f.date, m.date) <= dayWindow);
      if (hit) via = "company_total";
    }
    if (hit) { usedFx.add(hit.id); matches[via].push({ mira: m, fortnox: hit }); }
    else unmatchedMira.push(m);
  }

  const unmatchedFx = fx.filter((f) => !usedFx.has(f.id));
  const sum = (arr, f) => Number(arr.reduce((a, b) => a + (f ? f(b) : b.total || 0), 0).toFixed(2));
  const matchedCount = Object.values(matches).reduce((a, b) => a + b.length, 0);

  return {
    mira_count: mira.length, fortnox_count: fx.length,
    mira_total: sum(mira), fortnox_total: sum(fx),
    // ⚠️ MOMSBAS — se normFortnoxOrder. *_total är INKL moms, *_net EXKL.
    // En vy som ställer F&E bredvid Intelliplan måste använda net-basen.
    // Täckningen redovisas: saknas ft_net på rader är net-summan för LÅG, och
    // då ska den inte presenteras som om den vore fullständig.
    moms_bas: {
      fortnox_total_inkl_moms: sum(fx),
      fortnox_net_exkl_moms: sum(fx.filter((f) => f.net != null), (f) => f.net),
      fortnox_utan_net: fx.filter((f) => f.net == null).length,
      fortnox_utan_net_varde_inkl_moms: sum(fx.filter((f) => f.net == null)),
      mira_total_inkl_moms: sum(mira),
      note: fx.filter((f) => f.net == null).length
        ? "⚠️ ft_net saknas på minst en order (skrivs bara vid detail-fetch) → net-summan är OFULLSTÄNDIG. Presentera den inte som en total."
        : "ft_net finns på samtliga ordrar → net-summan är fullständig.",
    },
    matched: matchedCount,
    matched_by: Object.fromEntries(Object.entries(matches).map(([k, v]) => [k, v.length])),
    // Beloppet som skulle DUBBELRÄKNAS om båda källorna summerades rakt av.
    overlap_value: sum(Object.values(matches).flat(), (p) => p.mira.total),
    unmatched_mira: unmatchedMira.length, unmatched_mira_value: sum(unmatchedMira),
    unmatched_fortnox: unmatchedFx.length, unmatched_fortnox_value: sum(unmatchedFx),
    // Exempel att stickprova. Företagsnamn/ordernummer är affärsdata, inte
    // persondata — men vi tar bara en handfull.
    examples: {
      exact_no: matches.exact_no.slice(0, 5).map((p) => `${p.mira.order_no} ↔ ${p.fortnox.order_no} (${p.mira.total} kr)`),
      company_date_total: matches.company_date_total.slice(0, 5).map((p) => `${p.mira.order_no} ≈ ${p.fortnox.order_no} ${p.mira.date} (${p.mira.total} kr)`),
      company_total: matches.company_total.slice(0, 5).map((p) => `${p.mira.order_no} ≈ ${p.fortnox.order_no} ${p.mira.date}/${p.fortnox.date} (${p.mira.total} kr)`),
      unmatched_mira: unmatchedMira.slice(0, 5).map((m) => `${m.order_no} ${m.date} ${m.total} kr (${m.status || "utan status"})`),
    },
    // Tolkningshjälp — inte ett beslut.
    // ⚠️ TOMT ≠ SLUTSATS. Med noll rader på båda sidor vet vi ingenting om
    // överlapp — då är svaret "inget att jämföra", inte "de är disjunkta".
    // Att dra den slutsatsen ur tom data var precis vad den här raden gjorde
    // första gången den kördes skarpt (2026-08-19), och det hade lett till att
    // två källor summerades utan grund.
    // `fx` är redan filtrerad på icke-makulerade. Är alla makulerade ser det ut
    // som "inga ordrar" — därför redovisas råantalet separat, annars letar man
    // efter ett datafel som inte finns.
    verdict: (mira.length === 0 && fx.length === 0)
      ? `INGET ATT JÄMFÖRA: båda källorna gav noll användbara rader (MiraOrder ${(miraRows || []).length}, FortnoxOrder ${(fortnoxRows || []).length} varav ${(fortnoxRows || []).length - fx.length} makulerade). Det säger ingenting om överlapp — kontrollera att perioden har ordrar och att fältnamnen stämmer.`
      : (mira.length === 0 || fx.length === 0)
      ? `BARA EN KÄLLA HAR DATA (MiraOrder ${mira.length}, FortnoxOrder ${fx.length} icke-makulerade av ${(fortnoxRows || []).length}). Överlapp går inte att mäta — kontrollera den tomma sidan innan du drar slutsatser.`
      : matchedCount === 0
      ? "Inget överlapp hittat: källorna verkar beskriva olika ordrar. Båda kan summeras."
      : (matches.exact_no.length === matchedCount
          ? "Överlapp på exakt ordernummer — dedup är tillförlitlig."
          : "Överlapp finns men bara via belopp/datum. Dedupen blir en gissning; stickprova exemplen innan du litar på den."),
  };
}

/**
 * ⚠️ TOM SIDA ÄR INTE ETT SVAR — den är en fråga.
 *
 * `mira_count: 0` kan betyda tre helt olika saker, och skillnaden avgör om
 * F&E får summeras ur två källor eller bara en:
 *
 *   a) MiraOrder-typen är tom överhuvudtaget  → Miras offertväg har aldrig gett
 *      en order. Ingen dubbelräkningsrisk finns, men det är ett påstående om
 *      systemet, inte om perioden.
 *   b) Typen HAR rader, men inget av datumfälten ger träff ens i ett brett
 *      fönster → fältnamnet eller datumformatet är fel. Nollan är en BUGG.
 *   c) Typen har rader i det breda fönstret men noll i perioden → verkligt
 *      datafaktum för just den perioden.
 *
 * Att svara "båda kan summeras" utan att veta vilket av a/b/c som gäller var
 * precis felet 2026-08-19. Den här funktionen tvingar fram valet.
 *
 * @param type        typnamn, för texten
 * @param periodCount rader i den efterfrågade perioden
 * @param typeTotal   TOTALT antal rader av typen (strikt räknat — aldrig en
 *                    sväljd nolla), eller null om räkningen inte gick att göra
 * @param wide        [{field, count}] träffar per datumfält i det breda fönstret;
 *                    count === null betyder "frågan gick inte att ställa"
 */
export function describeEmptySide({ type, periodCount, typeTotal, wide }) {
  const w = wide || [];
  const fields = w.map((x) => x.field).join(", ") || "(inga fält probade)";
  // Kunde vi inte mäta får vi INTE landa i någon av a/b/c.
  if (typeTotal == null || w.some((x) => x.count == null)) {
    return { status: "okänt", type, text:
      `${type}: gick inte att avgöra varför perioden är tom — själva diagnosfrågan failade. Behandla nollan som omätt, inte som noll.` };
  }
  if (typeTotal === 0) {
    return { status: "typen_tom", type, text:
      `${type} har noll rader TOTALT. Perioden är tom därför att typen är tom — det säger inget om just den här perioden, och en framtida order gör påståendet ogiltigt.` };
  }
  const wideTotal = w.reduce((a, x) => a + x.count, 0);
  if (wideTotal === 0) {
    return { status: "datumfält_misstänkt", type, text:
      `⚠️ ${type} har ${typeTotal} rader men INGET av datumfälten (${fields}) ger en enda träff i det breda fönstret. Det är sannolikt ett fel fältnamn eller datumformat, inte ett datafaktum. Verifiera mot hur kodbasen SKRIVER raden innan du tolkar nollan.` };
  }
  if (periodCount === 0) {
    return { status: "period_tom", type, text:
      `${type} har ${typeTotal} rad${typeTotal === 1 ? "" : "er"} totalt och ${wideTotal} träff${wideTotal === 1 ? "" : "ar"} i det breda fönstret (${fields}) — men noll i perioden. Det är ett verkligt datafaktum för perioden.${typeTotal <= 5 ? ` ⚠️ Men ${typeTotal} rad${typeTotal === 1 ? "" : "er"} TOTALT betyder att typen knappt är i drift — behandla nollan som "ännu inte i bruk", inte som "affärsområdet omsatte inget". Den dagen typen tas i drift ändras svaret utan att någon rör koden.` : ""}` };
  }
  return { status: "har_data", type, text: `${type}: ${periodCount} rader i perioden.` };
}
