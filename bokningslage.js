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
  // ⚠️ Summan över FÄLT, inte över RADER — en order med både leveransdatum och
  // orderdatum räknas en gång per fält. Skarpt 2026-08-20 blev "1 rad totalt"
  // till "2 träffar", vilket läses som två rader. Används bara som
  // "träffade något alls" (> 0), och redovisas per fält i texten.
  const wideTotal = w.reduce((a, x) => a + x.count, 0);
  const perField = w.map((x) => `${x.field}: ${x.count}`).join(", ");
  if (wideTotal === 0) {
    return { status: "datumfält_misstänkt", type, text:
      `⚠️ ${type} har ${typeTotal} rader men INGET av datumfälten (${fields}) ger en enda träff i det breda fönstret. Det är sannolikt ett fel fältnamn eller datumformat, inte ett datafaktum. Verifiera mot hur kodbasen SKRIVER raden innan du tolkar nollan.` };
  }
  if (periodCount === 0) {
    return { status: "period_tom", type, text:
      `${type} har ${typeTotal} rad${typeTotal === 1 ? "" : "er"} totalt och träffar i det breda fönstret (${perField} — räknat per fält, samma rad kan ligga i flera) men noll i perioden. Det är ett verkligt datafaktum för perioden.${typeTotal <= 5 ? ` ⚠️ Men ${typeTotal} rad${typeTotal === 1 ? "" : "er"} TOTALT betyder att typen knappt är i drift — behandla nollan som "ännu inte i bruk", inte som "affärsområdet omsatte inget". Den dagen typen tas i drift ändras svaret utan att någon rör koden.` : ""}` };
  }
  return { status: "har_data", type, text: `${type}: ${periodCount} rader i perioden.` };
}

// ────────────────────────────────────────────────────────────────────────────
// SAMMANSTÄLLNING — de tre affärsområdena bredvid varandra
// ────────────────────────────────────────────────────────────────────────────
//
// ⚠️ DET HÄR ÄR INTE TRE JÄMFÖRBARA TAL. De mäter olika saker:
//
//   S&P  (Intelliplan)  = INTJÄNAT för arbete som UTFÖRTS i månaden.
//   HK   (FortnoxOrder) = ORDERVÄRDE, hela ordern daterad på leveransmånaden.
//   F&E  (FortnoxOrder) = samma sak som HK.
//
// En Fortnox-order på 500 kkr med leverans 3 juni ligger med sitt fulla värde i
// juni så fort den lagts — även om den lades i mars. Intelliplans junisiffra
// däremot fylls på under och efter juni allteftersom arbete utförs och
// rapporteras. Att lägga ihop dem ger ett tal utan innebörd.
//
// Därför: `summa` finns, men den är MÄRKT, och varje post bär sin egen
// `matt`-etikett. Den som vill ha en koncernsiffra måste läsa vad den betyder.
//
// ⚠️ MOMS: allt här är EXKL moms (bekräftat av Christian 2026-08-20 för
// Intelliplan). Fortnox-sidan använder därför `ft_net`, aldrig `ft_total`.
// Saknas ft_net på rader blir summan för låg → posten flaggas `ofullstandig`.

const MATT = {
  intjanat: "Intjänat för arbete utfört i perioden (periodiserad intäkt)",
  ordervarde: "Ordervärde, hela ordern daterad på LEVERANSDATUM i perioden",
  // ⚠️ TREDJE MÅTTET. Workordern har bara `OrderDate`, och v2-adaptern
  // (invoice_sync.js tengellaWorkorderAdapter) sätter därför `ft_order_date` men
  // ALDRIG `ft_delivery_date`. HK svarar på "ordrar DATERADE i månaden", inte
  // "levererat i månaden". För löpande städuppdrag ligger de nära varandra, men
  // det är inte samma fråga och får inte etiketteras som om det vore det.
  ordervarde_orderdatum: "Ordervärde, HK-order daterad på ORDERDATUM i perioden (Tengella saknar leveransdatum — INTE samma sak som levererat i perioden)",
};

/** TengellaWorkorder → belopp. Summan av rad-Quantity × Price, exkl moms. */
export function workorderBelopp(r) {
  let rows = [];
  try { rows = JSON.parse(_str(r.workorder_rows_json) || "[]"); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  let sum = 0;
  for (const x of rows) sum += (_num(x.Quantity) || 0) * (_num(x.Price) || 0);
  return { belopp: Number(sum.toFixed(2)), rader: rows.length };
}

/** TengellaWorkorder → jämförbar form. `is_deleted` motsvarar makulerad. */
export function normWorkorder(r) {
  const { belopp, rader } = workorderBelopp(r);
  return {
    source: "TengellaWorkorder", id: _id(r),
    order_no: _str(r.workorder_no), date: _day(r.order_date),
    belopp, rader,
    // Bubble kan ge boolean ELLER "ja"/"true" beroende på väg — täck båda.
    borttagen: r.is_deleted === true || ["ja", "true", "yes", "1"].includes(_str(r.is_deleted).toLowerCase()),
  };
}

// ⚠️⚠️ KÄND TÄCKNINGSLUCKA — F&E (Christian, 2026-08-20)
//
// Samtliga enheter på Food & Event har ännu inte gått över till Caspeco. Tills
// migreringen är klar saknas **ca 30 %** av bolagets intäkter i våra källor.
// Migreringen startar **Q1 2027**.
//
// Det här är den farligaste sortens fel: talet SER komplett ut. Inget saknas,
// inget failar, ingen rad är tom — F&E är bara systematiskt ~30 % för lågt.
// En vy som visar det utan att säga det ljuger, och den som jämför F&E mot S&P
// drar fel slutsats om vilket bolag som går bäst.
//
// Därför bär F&E-posten `tackning` + en uttalad not, och den uppräknade
// siffran hålls SKILD från det uppmätta beloppet (`uppskattad_full_belopp`,
// `uppskattad: true`). Den är en linjär uppräkning ur ett antagande, inte en
// mätning — blanda dem aldrig.
//
// 🔁 TA BORT när migreringen är klar. Sätt `tackning: 1` och radera noten —
// en kvarglömd uppräkning som lever vidare efter Q1-27 blir ett tyst 43 %-fel
// åt andra hållet.
const TACKNING = {
  food_event: {
    andel: 0.70,
    note: "⚠️ Ca 30 % av F&E:s intäkter saknas i källorna tills samtliga enheter gått över till Caspeco (migrering startar Q1 2027). Det uppmätta beloppet är systematiskt för LÅGT — jämför inte F&E mot de andra bolagen utan att räkna med det.",
    ses_over: "2027-Q1",
  },
};

/**
 * @param sp   IntelliplanOrderMonth-rader för perioden (fält `revenue`, exkl moms)
 * @param hk   FortnoxOrder-rader, connection = TENGELLA
 * @param fe   FortnoxOrder-rader, connection = FE
 * @param miraCount  antal MiraOrder i perioden — styr F&E-varningen
 * @param opts { periodPagaende: bool }  innevarande månad är alltid ofullständig
 */
export function bokningslageSummary({ sp, hk, fe, miraCount = 0, opts = {} }) {
  const spRows = sp || [];
  const spTotal = Number(spRows.reduce((a, r) => a + (_num(r.revenue) || 0), 0).toFixed(2));

  // Fortnox-sidan: net (exkl moms), makulerade bort, saknat ft_net redovisas.
  const fxArea = (rows) => {
    const live = (rows || []).map(normFortnoxOrder).filter((r) => !r.cancelled);
    const medNet = live.filter((r) => r.net != null);
    const utanNet = live.filter((r) => r.net == null);
    return {
      antal: live.length,
      antal_makulerade: (rows || []).length - live.length,
      belopp: Number(medNet.reduce((a, r) => a + r.net, 0).toFixed(2)),
      matt: MATT.ordervarde,
      ofullstandig: utanNet.length > 0,
      utan_net: utanNet.length,
      utan_net_varde_inkl_moms: Number(utanNet.reduce((a, r) => a + (r.total || 0), 0).toFixed(2)),
    };
  };

  // ⚠️ PENSIONERAD VÄG — behålls för historiska TengellaWorkorder-rader (frysta
  // 2026-06-04 av §9-cutovern). Används INTE av bokningsläget längre; HK läses
  // ur FortnoxOrder(connection=TENGELLA). Radera först när ingen läser typen.
  const hkArea = (rows) => {
    const alla = (rows || []).map(normWorkorder);
    const live = alla.filter((r) => !r.borttagen);
    return {
      antal: live.length,
      antal_makulerade: alla.length - live.length,
      belopp: Number(live.reduce((a, r) => a + r.belopp, 0).toFixed(2)),
      matt: MATT.ordervarde_orderdatum,
      // Beloppet räknas ur workorder_rows_json. Saknas raderna blir ordern
      // värd 0 kr utan att något failar — samma tysta nolla som saknat ft_net.
      ofullstandig: live.some((r) => r.rader === 0),
      utan_net: live.filter((r) => r.rader === 0).length,
      utan_net_varde_inkl_moms: 0,
    };
  };

  const omraden = [
    { nyckel: "service_people", namn: "Service & People", kalla: "IntelliplanOrderMonth",
      antal: spRows.length, antal_makulerade: 0, belopp: spTotal, matt: MATT.intjanat,
      ofullstandig: false, utan_net: 0, utan_net_varde_inkl_moms: 0 },
    // ⚠️ HK och F&E kommer från SAMMA tabell (FortnoxOrder, olika connection) men
    // bär OLIKA datum: HK har bara ft_order_date, F&E har ft_delivery_date.
    // Därför samma beloppslogik (ft_net) men olika mått-etikett.
    Object.assign({ nyckel: "housekeeping", namn: "Housekeeping", kalla: "FortnoxOrder (TENGELLA, source=tengella-workorder)" },
      fxArea(hk), { matt: MATT.ordervarde_orderdatum }),
    Object.assign({ nyckel: "food_event", namn: "Food & Event", kalla: "FortnoxOrder (FE)" }, fxArea(fe)),
  ];

  // Känd täckningslucka → posten bär den, och uppräkningen hålls SKILD från
  // mätningen. `belopp` är alltid det UPPMÄTTA — aldrig det uppräknade.
  for (const o of omraden) {
    const t = TACKNING[o.nyckel];
    o.tackning = t ? t.andel : 1;
    if (t) {
      o.tackning_note = t.note;
      o.tackning_ses_over = t.ses_over;
      o.uppskattad_full_belopp = Number((o.belopp / t.andel).toFixed(2));
      o.uppskattad = true;   // ⚠️ uppskattad_full_belopp är INTE en mätning
    }
  }

  const varningar = [];
  // ⚠️ Innevarande månad är ALLTID ofullständig i Intelliplan — arbete utfört i
  // månaden rapporteras in efter månadsskiftet. Juli mitt i månaden hade 1 024
  // rader mot junis 2 315. Utan den här varningen ser varje pågående månad ut
  // som ett ras.
  if (opts.periodPagaende) {
    varningar.push("⚠️ Perioden pågår. Service & People växer efter periodens slut allteftersom utfört arbete rapporteras in — jämför mot SAMMA DAG i tidigare perioder, aldrig mot deras slutsummor.");
  }
  for (const o of omraden) {
    if (o.ofullstandig && o.nyckel === "housekeeping") {
      varningar.push(`⚠️ ${o.namn}: ${o.utan_net} workorder saknar rader i workorder_rows_json och räknas därför som 0 kr. Beloppet är för LÅGT — kör Tengella-synken med rader innan talet används.`);
    } else if (o.ofullstandig) {
      varningar.push(`⚠️ ${o.namn}: ${o.utan_net} order saknar ft_net (skrivs bara vid detail-fetch) — beloppet är för LÅGT med upp till ${o.utan_net_varde_inkl_moms} kr inkl moms. Presentera det inte som en total.`);
    }
  }
  for (const o of omraden) {
    if (o.tackning < 1) varningar.push(`${o.tackning_note} (${o.namn}: uppmätt ${o.belopp} kr, uppräknat till full täckning ≈ ${o.uppskattad_full_belopp} kr — uppräkningen är ett ANTAGANDE, inte en mätning. Ses över ${o.tackning_ses_over}.)`);
  }
  // ⚠️ F&E har två möjliga källor. Idag ger bara den ena data — men det ändras
  // utan kodändring den dagen mira-native offert/orderflödet tas i drift.
  // ⚠️ Ordalydelsen har betydelse. Vid 1 rad påstod den tidigare "Mira-native
  // flödet är i drift" — falskt, det var testordern (skarpt 2026-08-20).
  // Varna alltid, men påstå bara det som faktiskt är uppmätt.
  if (miraCount > 0) {
    varningar.push(miraCount <= 5
      ? `⚠️ F&E: ${miraCount} MiraOrder i perioden. Så få tyder på TESTDATA, inte att mira-native flödet tagits i drift — men kontrollera, för när det väl går i drift kan samma affär finnas som BÅDE MiraOrder och FortnoxOrder. Kör /admin/bokningslage/fe-overlap innan F&E-talet används.`
      : `⚠️ F&E: ${miraCount} MiraOrder i perioden — mira-native flödet ser ut att vara i drift. Samma affär kan finnas som BÅDE MiraOrder och FortnoxOrder. Kör /admin/bokningslage/fe-overlap och deduppa innan F&E-talet används.`);
  }

  // En känd täckningslucka gör summan lika ofullständig som ett saknat fält gör.
  const allaFullstandiga = omraden.every((o) => !o.ofullstandig && o.tackning >= 1);
  return {
    omraden,
    summa: {
      belopp: Number(omraden.reduce((a, o) => a + o.belopp, 0).toFixed(2)),
      // ⚠️ Etiketten är inte dekoration — den är hela poängen.
      matt: "BLANDADE MÅTT — intjänat (S&P) + ordervärde (HK, F&E). Talet är en storleksordning, inte en koncernintäkt."
        + (omraden.some((o) => o.tackning < 1) ? " ⚠️ Dessutom för LÅGT: minst ett bolag har känd täckningslucka (se varningar)." : ""),
      fullstandig: allaFullstandiga && !opts.periodPagaende,
    },
    moms: "Samtliga belopp EXKL moms.",
    varningar,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// KÄLLFÄRSKHET — en inaktuell källa är farligare än en tom
// ────────────────────────────────────────────────────────────────────────────
//
// ⚠️ Skarpt 2026-08-20: Housekeeping rapporterades som `antal: 1, belopp: 2880,
// ofullstandig: false` för augusti. Talet SÅG friskt ut. Sanningen var att inga
// TengellaWorkorders skapats sedan 4 juni — synken hade slutat leverera.
//
// En TOM källa fångas av `describeEmptySide`. En INAKTUELL källa gör det inte:
// den ger ett litet, plausibelt tal som passerar varje nollkontroll. Det är
// därför den här kontrollen finns, och därför den kollar TVÅ saker:
//
//   senaste_skapad  — senaste NYA raden. Gammal ⇒ inget nytt kommer in.
//   senaste_rord    — senaste ÄNDRADE raden. Gammal ⇒ synken rör ingenting
//                     alls, alltså kör den sannolikt inte.
//
// De betyder olika saker: en källa kan sakna nya rader men uppdatera gamla
// (friskt, lugn period), men rörs INGET är synken död.

/**
 * @param type          typnamn, för texten
 * @param senasteSkapad ISO-sträng eller null (null = kunde inte mätas)
 * @param senasteRord   ISO-sträng eller null
 * @param nu            ISO-sträng, "nu"
 * @param maxDagar      hur gammal en källa får vara innan den kallas inaktuell
 */
export function kallaFarskhet({ type, senasteSkapad, senasteRord, nu, maxDagar = 3 }) {
  const dagar = (iso) => {
    if (!iso) return null;
    const t = Date.parse(iso), n = Date.parse(nu);
    if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
    return Math.floor((n - t) / 864e5);
  };
  const dSkapad = dagar(senasteSkapad), dRord = dagar(senasteRord);

  // ⚠️ Omätt är inte färskt. Kunde vi inte läsa får vi inte påstå något.
  if (dSkapad == null && dRord == null) {
    return { status: "okänt", type, dagar_sedan_skapad: null, dagar_sedan_rord: null,
      text: `${type}: kunde inte avgöra hur färsk källan är. Behandla talet som overifierat.` };
  }
  // Rörs ingenting alls är synken död — det väger tyngre än utebliven nyskapning.
  if (dRord != null && dRord > maxDagar) {
    return { status: "inaktuell", type, dagar_sedan_skapad: dSkapad, dagar_sedan_rord: dRord,
      text: `⚠️ ${type}: ingen rad har ÄNDRATS på ${dRord} dagar (gräns ${maxDagar}). Synken rör ingenting — den kör sannolikt inte. Talet för perioden är då inte ett affärsfaktum utan en rest av senaste lyckade körning.` };
  }
  if (dSkapad != null && dSkapad > maxDagar) {
    return { status: "inga_nya", type, dagar_sedan_skapad: dSkapad, dagar_sedan_rord: dRord,
      text: `⚠️ ${type}: ingen NY rad på ${dSkapad} dagar (befintliga rader rördes för ${dRord} dagar sedan). Antingen en lugn period eller en synk som slutat skapa. Kontrollera innan talet används.` };
  }
  return { status: "farsk", type, dagar_sedan_skapad: dSkapad, dagar_sedan_rord: dRord,
    text: `${type}: färsk (ny rad för ${dSkapad} dagar sedan, ändrad för ${dRord} dagar sedan).` };
}
