// Smoke: paketavtal → master + delavtal (Contract.master_contract).
//   node avtal_split_smoke.mjs
//
// Bakgrund (2026-08-27, Planhat): ett HK-avtal innehöll fem tjänster i EN
// prisbild — Lokalvård 25 100 · Tillsyn 13 856 · Växter 7 691 · Entrèmatta 450
// (= 47 097) plus Frukt 45 kr/kg. Importen gjorde ETT Contract med ETT
// erbjudande, så kund-dashboarden tände bara Housekeeping-tile:n, med hela
// paketets belopp, och Växter fanns inte alls.
//
// Sviten vaktar fyra saker som var för sig kan förstöra kundens siffror:
//   1. avstämningen (delraderna MÅSTE summera till avtalets månadskostnad)
//   2. att mastern inte dubbelräknas mot sina barn på dashboarden
//   3. att rörliga rader (45 kr/kg) tänder tile men inte bidrar med 0 kr
//   4. att en halvfärdig split rullas tillbaka
//
// index.js är för sidoeffektsfylld att importera → route-handlern klipps ut ur
// källan och körs mot en mockad Bubble (samma teknik som avtal_signering_smoke).
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
function slice(src, a, b, label) {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i);
  if (i < 0 || j < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${a}"`); return ""; }
  return src.slice(i, j + b.length);
}
async function group(label, fn) {
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ [${label} kraschade] ${e && e.message}`); }
}
// Plockar ut en funktion ur en källfil och gör den anropbar. Saknas den (t.ex.
// mot äldre kod under mutationstest) returneras null i stället för att kasta —
// en krasch här skulle ta med sig resten av gruppens assertions.
function fnFrom(src, start, end, label, argNames = [], args = []) {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) return null;
  const name = /function\s+([A-Za-z0-9_$]+)/.exec(start)?.[1];
  try { return new Function(...argNames, src.slice(i, j + end.length) + "\nreturn " + name + ";")(...args); }
  catch (_) { return null; }
}

const SRC  = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
// ⚠️ TVÅ block bär samma panel och måste ändras ihop:
//   mira-foretag-lista.html   — LIVE kundkort + avtal (native kortet dött 2026-08-27)
//                               OCH portens KÄLLA. Panelen är INPORTAD där
//                               (.ab-wrap-markup + egen modul), inte monterad.
//   mira-abonnemang-deal.html — namnrymdsklon i affärs-popupen (.ad-wrap).
// Klonen kan INTE regenereras ur källan: den har egen logik (DEAL_LIVE,
// miraAvtalModal, AS_MODAL_D, keepDeal). Den måste portas riktat — därför
// vaktas båda mot samma kravlista här.
// (mira-abonnemang-kund.html raderad 2026-08-27 — var en strikt delmängd.)
const DEAL = fs.readFileSync(new URL("./mira-abonnemang-deal.html", import.meta.url), "utf8");
const GRID = fs.readFileSync(new URL("./mira-kund-dashboard-tjanster.html", import.meta.url), "utf8");
const FORETAG = fs.readFileSync(new URL("./mira-foretag-lista.html", import.meta.url), "utf8");
const COMPAPI = fs.readFileSync(new URL("./companies_api.js", import.meta.url), "utf8");

// Fältnamnen läses ur källan — testet ska inte ha en egen sanning om Bubble-
// slugar (fel namn = tysta nollresultat, inte röda tester).
const SERVICES = (() => {
  const blk = slice(SRC, "  CT_COMPANY:     \"kundföretag\",", "  TYPE_HYBRID:              \"Hybrid\",", "SERVICES");
  const o = {};
  for (const m of blk.matchAll(/(\w+):\s*"([^"]*)"/g)) o[m[1]] = m[2];
  o.CONTRACT_TYPE = "Contract";
  return o;
})();

// ── Planhat §5, kronorna ur det riktiga avtalet ───────────────────────────
// ⚠️ Erbjudande-id:na speglar den RIKTIGA katalogen (hämtad live 2026-08-27).
// Katalogen har ingen `entrematta`-slug, och Christian har beslutat att Tillsyn
// hör till Housekeeping → TRE rader pekar på SAMMA erbjudande. Det är precis
// den kollisionen som en fixtur med fem unika id:n aldrig kunde fånga.
const OFFER_HK    = "1782395223010x689078291907920800";
const OFFER_VAX   = "1782809947795x913565829062136700";
const OFFER_FRUKT = "1782810241005x966476239136509600";
const PLANHAT_LINES = [
  { label: "Lokalvård",         offer_id: OFFER_HK,    monthly_cost: 25100, category: "Housekeeping", contract_title: "housekeeping planhat" },
  { label: "Tillsyn 2 h/dag",   offer_id: OFFER_HK,    monthly_cost: 13856, category: "Housekeeping" },
  { label: "Entrémattor",       offer_id: OFFER_HK,    monthly_cost: 450,   category: "Housekeeping" },
  { label: "Växtservice 25 st", offer_id: OFFER_VAX,   monthly_cost: 7691,  category: "Other facility services", setup_cost: 1590 },
  { label: "Frukt",             offer_id: OFFER_FRUKT, unit: "per kg", unit_price: 45, category: "Other facility services" },
];
const PLANHAT_TOTAL = 47097;
const HK_MERGED     = 25100 + 13856 + 450;   // 39 406

// ── Mockad Bubble ─────────────────────────────────────────────────────────
function makeBubble(rows) {
  const db = new Map(Object.entries(rows));
  let seq = 0;
  const calls = { create: [], patch: [], del: [] };
  let failCreateAt = -1;
  return {
    calls,
    db,
    failCreateAfter(n) { failCreateAt = n; },
    api: {
      bubbleGet: async (t, id) => db.get(id) || null,
      bubbleFindAll: async (t, { constraints = [] } = {}) => {
        const c = constraints[0];
        if (!c) return [...db.values()];
        return [...db.values()].filter((r) => {
          const v = r[c.key];
          return (v && typeof v === "object" ? v._id : v) === c.value;
        });
      },
      bubbleCreate: async (t, payload) => {
        if (failCreateAt >= 0 && calls.create.length >= failCreateAt) throw new Error("bubbleCreate failed");
        const id = "child" + (++seq);
        calls.create.push({ id, payload });
        db.set(id, { _id: id, ...payload });
        return id;
      },
      bubblePatch: async (t, id, payload) => { calls.patch.push({ id, payload }); Object.assign(db.get(id) || {}, payload); },
      bubbleDelete: async (t, id) => { calls.del.push(id); db.delete(id); },
      bubbleId: (r) => r && (r._id || r.id),
      _ffIdOf: (v) => (v && typeof v === "object" ? v._id || null : v || null),
      _ffIdsOf: (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? x._id : x)).filter(Boolean) : []),
    },
  };
}

// Klipper ut split-handlern och kör den som en vanlig funktion (req,res).
function loadSplitHandler(api) {
  const body = slice(SRC, 'app.post("/admin/contracts/:id/split", async (req, res) => {', "\n});", "split-handler")
    .replace('app.post("/admin/contracts/:id/split", async (req, res) => {', "")
    .replace(/\n\}\);$/, "");
  const helpers = slice(SRC, "const SPLIT_FIXED_UNITS", "\n}\n", "split-helpers")
    + slice(SRC, "function _splitChildRateCard(line) {", "\n}", "_splitChildRateCard")
    + "\nasync function _splitChildrenOf(masterId){ return await bubbleFindAll(SERVICES.CONTRACT_TYPE, { constraints:[{key:SERVICES.CT_MASTER, constraint_type:'equals', value:masterId}] }); }\n";
  const fn = new Function(
    "SERVICES", "PLANNING_ADMIN_TOKEN", "_approvalCors", "console",
    "bubbleGet", "bubbleFindAll", "bubbleCreate", "bubblePatch", "bubbleDelete", "bubbleId", "_ffIdOf", "_ffIdsOf",
    helpers + "\nreturn async (req, res) => {" + body + "\n};"
  );
  return fn(SERVICES, "tok", () => {}, { log() {}, warn() {}, error() {} },
    api.bubbleGet, api.bubbleFindAll, api.bubbleCreate, api.bubblePatch, api.bubbleDelete,
    api.bubbleId, api._ffIdOf, api._ffIdsOf);
}
function mkRes() {
  const r = { code: 200, body: null, sent: false };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; r.sent = true; return r; };
  r.sendStatus = () => r;
  return r;
}
const mkReq = (id, body) => ({ params: { id }, headers: { "x-admin-token": "tok" }, body });

const masterRow = () => ({
  _id: "m1",
  [SERVICES.CT_COMPANY]: "cc1",
  [SERVICES.CT_OFFER]: "o_hk",
  [SERVICES.CT_OFFICE]: "off1",
  [SERVICES.CT_MONTHLY]: PLANHAT_TOTAL,
  [SERVICES.CT_KATEGORI]: "Housekeeping",
  [SERVICES.CT_TYPE]: "Hybrid",
  [SERVICES.CT_START]: "2026-05-25",
  [SERVICES.CT_END]: "2027-05-24",
  [SERVICES.CT_BINDING]: 12,
  [SERVICES.CT_NOTICE]: 3,
  [SERVICES.CT_AUTO_RENEW]: 12,
  [SERVICES.CT_PRICE_REG_TYPE]: "index_cleaning",
  [SERVICES.CT_SIGNED_AT]: "2026-05-25",
  [SERVICES.CT_SIGNED_PDF]: "https://cdn/planhat.pdf",
  [SERVICES.CT_ATTACHMENTS]: ["dok1"],
  [SERVICES.CT_TITLE]: "housekeeping ox2 ab",
});

// Kraven som ALLA tre panelblock måste uppfylla. En ny funktion läggs till här
// EN gång och vaktas då i alla tre — det är enda skyddet mot att ett block
// glöms bort vid nästa ändring.
const PANEL_FEATURES = [
  ["nästlar paketavtal",             /function nestPackages\(contracts\) \{/],
  ["styckpris på rörlig delrad",     /function variableRateOf\(ct\) \{/],
  ["masterrad namngiven av avtalet", /headName = ct\.contract_title \|\| ct\.service_name/],
  ["paket-pill",                     /ab-pill t-pkg/],
  ["delradernas summa mot totalen",  /ab-kids-sum/],
  ["raduppdelning vid import",       /function renderSplitPanel\(\)/],
  ["split kedjad efter commit",      /SPLIT_STATE\.on && data\.contract_id/],
  ["panelen nollas i resetForm",     /SPLIT_STATE = \{ lines: \[\], reconciliation: null, on: false \};\n    var splitPanel/],
  ["bilagor bara på mastern",        /ct\.is_child \? '' :/],
  ["totalen hoppar över barnen",     /allCt\.filter\(function \(c\) \{ return !c\.master_contract_id; \}\)/],
  ["månadstotal utan typfilter",     /\.filter\(function \(c\) \{ return c\.status === 'aktiv' \|\| c\.status === 'utgar_snart'; \}\)\s*\n\s*\.reduce/],
  ["inget Subscription-filter kvar",  (s) => !/contract_type === 'Subscription' && \(c\.status === 'aktiv'/.test(s)],
  ["expand-selektor är barn-komb.",  /\.ab-row\.open > \.ab-rowbody \{ display:block; \}/],
  ["chevron-selektor scopad",        /\.ab-row\.open > \.ab-rowhead \.ab-chev/],
  ["CATALOG bär slug",               /slug: svc\.slug \|\| null,/],
];
const PANEL_CSS_ONCE = ["ab-svcname-pkg::first-letter", ".ab-split {", ".ab-kid-var", ".ab-pill.t-pkg"];

const run = async () => {

  // ════════════════════════════════════════════════════════════════════════
  sec("Avstämning — delraderna måste summera till avtalets månadskostnad");
  // ════════════════════════════════════════════════════════════════════════
  await group("reconciliation", async () => {
    // Det HÄR är spärren som gör att ett dåligt LLM-svar inte tyst blir fem
    // felaktiga avtal. Planhats fyra fasta rader ska gå exakt jämnt ut.
    {
      const bb = makeBubble({ m1: masterRow() });
      const h = loadSplitHandler(bb.api);
      const res = mkRes();
      await h(mkReq("m1", { lines: PLANHAT_LINES, dry_run: true }), res);
      ok("Planhats fyra fasta rader summerar till 47 097 exakt",
         res.code === 200 && res.body.lines_sum === PLANHAT_TOTAL && res.body.diff === 0 && res.body.reconciled === true);
      ok("Frukt (45 kr/kg) räknas INTE in i den fasta totalen",
         res.body.plan.find((p) => p.label === "Frukt").monthly_cost === 0);
      ok("dry_run skriver ingenting", bb.calls.create.length === 0 && bb.calls.patch.length === 0);
      // Operatören måste SE sammanslagningen innan den sker — annars upptäcks
      // den först som ett saknat belopp på kundens dashboard.
      const prev = res.body.children_preview || [];
      const hkPrev = prev.find((p) => p.offer_id === OFFER_HK) || {};
      ok("dry_run visar de grupperade delavtalen, inte bara raderna", prev.length === 3);
      ok("förhandsvyn namnger vilka rader som slogs ihop",
         (hkPrev.merged_lines || []).join() === "Lokalvård,Tillsyn 2 h/dag,Entrémattor");
      ok("förhandsvyn visar det sammanslagna beloppet", hkPrev.monthly_cost === HK_MERGED);
    }
    {
      // Växter borttappade — precis den bugg produktionen hade.
      const bb = makeBubble({ m1: masterRow() });
      const h = loadSplitHandler(bb.api);
      const res = mkRes();
      await h(mkReq("m1", { lines: PLANHAT_LINES.filter((l) => l.label !== "Växtservice 25 st") }), res);
      ok("saknad rad (Växter 7 691) → 400 reconciliation_failed, inget skrivet",
         res.code === 400 && res.body.error === "reconciliation_failed" && bb.calls.create.length === 0);
      ok("felet säger vad differensen är", res.body.diff === -7691 && res.body.lines_sum === 39406);
    }
    {
      const bb = makeBubble({ m1: masterRow() });
      const h = loadSplitHandler(bb.api);
      const res = mkRes();
      await h(mkReq("m1", { lines: PLANHAT_LINES.filter((l) => l.label !== "Växtservice 25 st"), force: true }), res);
      ok("force: true går förbi avstämningen", res.code === 200 && bb.calls.create.length === 2);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Split — barnen ärver dokumentet men duplicerar det inte");
  // ════════════════════════════════════════════════════════════════════════
  await group("split", async () => {
    const bb = makeBubble({ m1: masterRow() });
    const h = loadSplitHandler(bb.api);
    const res = mkRes();
    await h(mkReq("m1", { lines: PLANHAT_LINES, master_title: "serviceavtal planhat ab" }), res);
    // ⚠️ FEM rader men TRE delavtal — annars krockar de tre HK-raderna på
    // dashboarden (activeByOffice[office][slug] skriver över) och tile:n hade
    // visat 450 kr i stället för 39 406.
    ok("fem rader → tre delavtal (ett per erbjudande)",
       res.code === 200 && bb.calls.create.length === 3);

    const kids = bb.calls.create.map((c) => c.payload);
    ok("alla barn pekar på mastern", kids.every((k) => k[SERVICES.CT_MASTER] === "m1"));
    ok("varje barn har ett UNIKT erbjudande (= sin egen tile, ingen överskrivning)",
       new Set(kids.map((k) => k[SERVICES.CT_OFFER])).size === 3);
    const hk = kids.find((k) => k[SERVICES.CT_OFFER] === OFFER_HK);
    ok("Lokalvård + Tillsyn + Entrémattor slås ihop till 39 406 kr",
       hk[SERVICES.CT_MONTHLY] === HK_MERGED);
    ok("den sammanslagna radens uppdelning sparas i volume_json",
       /Tillsyn/.test(hk[SERVICES.CT_VOLUME_JSON] || "") && /25100/.test(hk[SERVICES.CT_VOLUME_JSON] || ""));
    ok("sammanslagen rad ärver den första radens titel",
       hk[SERVICES.CT_TITLE] === "housekeeping planhat");
    ok("delavtalens summa är fortfarande avtalets total",
       kids.reduce((s, k) => s + Number(k[SERVICES.CT_MONTHLY] || 0), 0) === PLANHAT_TOTAL);
    ok("barnen ärver bindning/uppsägning/prisreglering",
       kids.every((k) => k[SERVICES.CT_BINDING] === 12 && k[SERVICES.CT_NOTICE] === 3
                      && k[SERVICES.CT_PRICE_REG_TYPE] === "index_cleaning"));
    ok("barnen ärver signed_at (de ÄR påskrivna — av samma dokument)",
       kids.every((k) => k[SERVICES.CT_SIGNED_AT] === "2026-05-25"));
    // ⚠️ Kärnan i master/child: dokumentet ska finnas på EXAKT ett ställe.
    ok("barnen ärver INTE signed_pdf", kids.every((k) => !k[SERVICES.CT_SIGNED_PDF]));
    ok("barnen ärver INTE bilagorna", kids.every((k) => !k[SERVICES.CT_ATTACHMENTS]));
    ok("barnen ärver INTE offer_approval", kids.every((k) => !k[SERVICES.CT_OFFER_APPROVAL]));

    const vax = kids.find((k) => k[SERVICES.CT_OFFER] === OFFER_VAX);
    ok("Växter får sin egen månadskostnad 7 691", vax[SERVICES.CT_MONTHLY] === 7691);
    ok("Växters leveransavgift 1 590 hamnar som engångspost i rate_card",
       /"unit":"engång"/.test(vax[SERVICES.CT_RATE_CARD_JSON] || "") && /1590/.test(vax[SERVICES.CT_RATE_CARD_JSON] || ""));

    const frukt = kids.find((k) => k[SERVICES.CT_OFFER] === OFFER_FRUKT);
    ok("Frukt blir RateCard med 0 kr/mån", frukt[SERVICES.CT_TYPE] === "RateCard" && !frukt[SERVICES.CT_MONTHLY]);
    ok("Frukts styckpris 45 kr/kg sparas i rate_card",
       /"price_per_h":45/.test(frukt[SERVICES.CT_RATE_CARD_JSON]) && /"unit":"per kg"/.test(frukt[SERVICES.CT_RATE_CARD_JSON]));
    ok("fasta rader blir Subscription", kids.filter((k) => k[SERVICES.CT_MONTHLY] > 0).every((k) => k[SERVICES.CT_TYPE] === "Subscription"));
    ok("mastern döps om (importen ärvde promptens exempelnamn 'ox2')",
       bb.calls.patch.length === 1 && bb.calls.patch[0].payload[SERVICES.CT_TITLE] === "serviceavtal planhat ab");
    // Mastern får INTE tömmas på erbjudande/belopp — dashboarden hoppar över
    // den på relationen, inte på ett städat fält. Det gör splitten reversibel.
    ok("masterns erbjudande och belopp är orörda",
       bb.db.get("m1")[SERVICES.CT_OFFER] === "o_hk" && bb.db.get("m1")[SERVICES.CT_MONTHLY] === PLANHAT_TOTAL);
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Spärrar");
  // ════════════════════════════════════════════════════════════════════════
  await group("guards", async () => {
    {
      const bb = makeBubble({ m1: masterRow(), c1: { _id: "c1", [SERVICES.CT_MASTER]: "m1" } });
      const res = mkRes();
      await loadSplitHandler(bb.api)(mkReq("m1", { lines: PLANHAT_LINES }), res);
      ok("redan splittat → 409 already_split", res.code === 409 && res.body.error === "already_split");
    }
    {
      const bb = makeBubble({ c1: { _id: "c1", [SERVICES.CT_MASTER]: "m1", [SERVICES.CT_MONTHLY]: 100 } });
      const res = mkRes();
      await loadSplitHandler(bb.api)(mkReq("c1", { lines: PLANHAT_LINES }), res);
      ok("splitta ett barn → 409 is_child (trädet får inte bli två nivåer)",
         res.code === 409 && res.body.error === "is_child");
    }
    {
      const bb = makeBubble({ m1: masterRow() });
      const res = mkRes();
      await loadSplitHandler(bb.api)(mkReq("m1", { lines: [{ label: "Lokalvård", monthly_cost: PLANHAT_TOTAL }] }), res);
      ok("rad utan erbjudande → 400 (utan erbjudande tänds ingen tile)",
         res.code === 400 && res.body.error === "rad_saknar_erbjudande");
    }
    {
      const bb = makeBubble({ m1: masterRow() });
      const res = mkRes();
      await loadSplitHandler(bb.api)(mkReq("m1", { lines: [] }), res);
      ok("tomma rader → 400 inga_rader", res.code === 400 && res.body.error === "inga_rader");
    }
    {
      const bb = makeBubble({});
      const res = mkRes();
      await loadSplitHandler(bb.api)(mkReq("saknas", { lines: PLANHAT_LINES }), res);
      ok("okänt avtal → 404", res.code === 404);
    }
    {
      const bb = makeBubble({ m1: masterRow() });
      const res = mkRes();
      await loadSplitHandler(bb.api)({ params: { id: "m1" }, headers: {}, body: { lines: PLANHAT_LINES } }, res);
      ok("utan admin-token → 401", res.code === 401);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Rollback — halvfärdig split lämnar inga föräldralösa delavtal");
  // ════════════════════════════════════════════════════════════════════════
  await group("rollback", async () => {
    const bb = makeBubble({ m1: masterRow() });
    bb.failCreateAfter(2);                      // två delavtal skapas, tredje smäller
    const res = mkRes();
    await loadSplitHandler(bb.api)(mkReq("m1", { lines: PLANHAT_LINES }), res);
    ok("felet propagerar som 500", res.code === 500);
    ok("de skapade delavtalen raderas igen", bb.calls.del.length === 2 && res.body.rolled_back === 2);
    ok("inga barn ligger kvar i databasen", [...bb.db.keys()].join() === "m1");
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Kund-dashboard — mastern dubbelräknas inte, rörlig tjänst tänds");
  // ════════════════════════════════════════════════════════════════════════
  await group("dashboard", () => {
    const dash = slice(SRC, "async function _buildServicesDashboard(companyId) {", "\n}\n", "_buildServicesDashboard");
    ok("masters härleds ur relationen (ingen extra Bubble-fråga, inget fält att städa)",
       /const masterIds = new Set\(\);/.test(dash) && /_ffIdOf\(ct\[SERVICES\.CT_MASTER\]\)/.test(dash));
    ok("masteravtal hoppas över i tile-loopen",
       /if \(masterIds\.has\(bubbleId\(ct\)\)\) continue;/.test(dash));
    // Styckpris-utvinningen KÖRS, inte bara regex:as — en `if (false)` runt
    // tilldelningen lämnar alla söksträngar på plats och skulle annars passera.
    const rcSnippet = slice(SRC, "    let unit = null, unitPrice = null;",
                            "catch (_) { /* ogiltig JSON → ingen styckprisvisning */ }", "rate_card-utvinning");
    const extractRate = new Function("SERVICES", "ct", rcSnippet + "\nreturn { unit, unitPrice };");
    {
      const frukt = extractRate(SERVICES, {
        [SERVICES.CT_RATE_CARD_JSON]: JSON.stringify([{ role: "Frukt", price_per_h: 45, unit: "per kg" }]) });
      ok("styckpris plockas ur rate_card till tile-entryn", frukt.unit === "per kg" && frukt.unitPrice === 45);
      const eng = extractRate(SERVICES, {
        [SERVICES.CT_RATE_CARD_JSON]: JSON.stringify([{ role: "Uppstart", price_per_h: 10000, unit: "engång" }]) });
      ok("engångsposter räknas INTE som styckpris (uppstart är inget löpande pris)",
         eng.unit === null && eng.unitPrice === null);
      ok("ogiltig rate_card-JSON kraschar inte tile-bygget",
         extractRate(SERVICES, { [SERVICES.CT_RATE_CARD_JSON]: "{trasig" }).unit === null);
      ok("avtal utan rate_card ger inget styckpris", extractRate(SERVICES, {}).unit === null);
    }

    // Frontend: en aktiv tile med 0 kr/mån får inte bli tom. Funktionen körs.
    const partsFn = fnFrom(GRID, "  function activePriceParts(item, act){", "\n  }", "activePriceParts",
      ["num", "adaptedUnitPrice"],
      [(v) => (v === null || v === undefined || isNaN(v) ? 0 : Number(v)), () => 1610]);
    ok("activePriceParts finns i gridet", !!partsFn);
    if (partsFn) {
      const item = { options: [{ id: "o_frukt" }] };
      const fast = partsFn(item, { option_id: "o_hk", monthly_cost: 25100 });
      ok("aktiv tjänst med fast pris → avtalspriset", fast.kind === "fast" && fast.monthly === 25100);
      const rorlig = partsFn(item, { option_id: "o_frukt", monthly_cost: 0, unit_price: 45, unit: "per kg" });
      ok("gridet visar styckpris när avtalet saknar fast månadskostnad",
         rorlig.kind === "rorlig" && rorlig.rate === 45 && rorlig.unit === "per kg");
      ok("gridet kompletterar med prismotorns månadsuppskattning (frukt-kalkylen)", rorlig.est === 1610);
      ok("aktiv tjänst helt utan pris ger ingen prisrad", partsFn(item, { option_id: "o_x", monthly_cost: 0 }) === null);
    }
    ok("renderTile anropar faktiskt prisuppdelningen", /var pp = activePriceParts\(item, act\);/.test(GRID));
    ok("tile-foten renderar den rörliga varianten", /pp\.kind === 'fast'/.test(GRID) && /mt-foot-est/.test(GRID));
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Admin-panelen — delraderna nästlas, inte sidoställs");
  // ════════════════════════════════════════════════════════════════════════
  await group("admin-panel", () => {
    // nestPackages är ren → körs på riktigt. Ett borttaget ANROP fångas separat.
    const nest = fnFrom(FORETAG, "  function nestPackages(contracts) {", "\n  }", "nestPackages");
    ok("nestPackages finns i panelen", !!nest);
    if (nest) {
      const rows = [
        { id: "m1" }, { id: "c1", master_contract_id: "m1" }, { id: "c2", master_contract_id: "m1" },
        { id: "fri" }, { id: "orphan", master_contract_id: "borta" },
      ];
      const out = nest(rows);
      ok("barn plockas ur toppnivån och skickas in i sin master",
         out.length === 3 && out[0].ct.id === "m1" && out[0].kids.map((k) => k.id).join() === "c1,c2");
      ok("fristående avtal påverkas inte", (out.find((n) => n.ct.id === "fri") || {}).kids?.length === 0);
      // ⚠️ Ett barn vars master ligger i en annan sektion får ALDRIG bara försvinna.
      ok("barn vars master saknas renderas fristående (försvinner aldrig tyst)",
         !!out.find((n) => n.ct.id === "orphan"));
      ok("inget avtal tappas bort totalt sett",
         out.length + out.reduce((s, n) => s + n.kids.length, 0) === rows.length);
    }
    ok("sectionHtml anropar faktiskt nästlingen",
       /var rows = nestPackages\(contracts\)\.map\(function \(n\) \{ return rowHtml\(n\.ct, n\.kids\); \}\)/.test(FORETAG));
    ok("masterraden får en 'N tjänster'-pill", /ab-pill t-pkg/.test(FORETAG));
    // Masterraden namnges av AVTALET, inte av tjänsten — annars står
    // "Housekeeping" både som paket och som delrad och avtalstiteln syns aldrig.
    ok("masterraden namnges av contract_title, inte service_name",
       /headName = ct\.contract_title \|\| ct\.service_name/.test(FORETAG));
    ok("masterns underrubrik listar delradernas tjänster",
       /headSub  = kids\.map\(function \(k\) \{ return k\.service_name/.test(FORETAG));
    ok("delrader namnges fortfarande av tjänsten",
       /var headName = ct\.service_name, headSub = ct\.variant;/.test(FORETAG));
    ok("rubriken renderas från headName\/headSub, inte direkt från ct",
       /esc\(headName\)/.test(FORETAG) && /esc\(headSub\)/.test(FORETAG));
    // Gement lagrad titel versaliseras bara på första tecknet — capitalize
    // hade gett "Serviceavtal Planhat Ab".
    ok("gement contract_title versaliseras på första tecknet vid visning",
       /\.ab-svcname-pkg::first-letter \{ text-transform:uppercase; \}/.test(FORETAG));
    ok("panelen visar delradernas summa mot avtalets total", /ab-kids-sum/.test(FORETAG) && /ab-kids-diff/.test(FORETAG));
    // ⚠️ Descendant-selektorn hade fällt ut ALLA barns paneler när mastern öppnas.
    ok("expand-selektorn är barn-kombinator (annars öppnas barnens paneler med masterns)",
       /\.ab-row\.open > \.ab-rowbody \{ display:block; \}/.test(FORETAG));
    ok("chevron-rotationen är också scopad till egen rubrikrad",
       /\.ab-row\.open > \.ab-rowhead \.ab-chev/.test(FORETAG));
    ok("bilagor visas bara på mastern (dokumentet finns på ETT ställe)",
       /ct\.is_child \? '' :/.test(FORETAG));
    ok("totalen räknar mastern och hoppar över barnen",
       /allCt\.filter\(function \(c\) \{ return !c\.master_contract_id; \}\)/.test(FORETAG));
    ok("månadstotalen filtrerar inte på avtalstyp (Hybrid har en fast bas)",
       !/contract_type === 'Subscription' && \(c\.status === 'aktiv'/.test(FORETAG));
    // ⚠️ Det raderade kund-blocket får inte återuppstå tyst: två filer är redan
    // en för många, tre var det som gjorde att affärsvyn hann släpa efter.
    ok("mira-abonnemang-kund.html är borta (en källa, en klon)",
       !fs.existsSync(new URL("./mira-abonnemang-kund.html", import.meta.url)));
    const varRate = fnFrom(FORETAG, "  function variableRateOf(ct) {", "\n  }", "variableRateOf");
    ok("variableRateOf finns i panelen", !!varRate);
    ok("rörlig delrad visar styckpris i stället för 0 kr/mån",
       !!varRate && (varRate({ rate_card_json: JSON.stringify([{ role: "Frukt", price_per_h: 45, unit: "per kg" }]) }) || {}).price === 45);
    ok("engångspost räknas inte som styckpris i panelen",
       !!varRate && varRate({ rate_card_json: JSON.stringify([{ role: "Uppstart", price_per_h: 10000, unit: "engång" }]) }) === null);
    ok("rowHtml anropar faktiskt styckprisuppslaget", /var vr = variableRateOf\(ct\);/.test(FORETAG));
    // Backend måste flagga master/child, annars har frontend inget att nästla på.
    const byc = slice(SRC, 'app.get("/admin/contracts/by-company"', "\n});", "by-company");
    ok("by-company flaggar is_master/is_child/child_count",
       /e\.is_master   = e\.child_count > 0;/.test(byc) && /e\.is_child    = !!e\.master_contract_id;/.test(byc));
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Import A — lines[] ur prisbilagan + katalog-hintar");
  // ════════════════════════════════════════════════════════════════════════
  await group("import-lines", () => {
    const tool = slice(SRC, "const CONTRACT_EXTRACT_TOOL", "\n};", "CONTRACT_EXTRACT_TOOL");
    ok("verktyget har ett lines-fält", /lines: \{\s*\n\s*type: "array"/.test(tool));
    ok("varje rad har enhet med engång som giltigt värde",
       /enum: \["per månad", "per kg", "per timme", "per tillfälle", "engång"\]/.test(tool));
    ok("raden bär service_hint för slug-gissningen", /service_hint:/.test(tool));
    ok("prompten säger att raderna ska summera till monthly_cost",
       /MÅSTE summera till monthly_cost/.test(tool));
    const sys = slice(SRC, "const CONTRACT_EXTRACT_SYSTEM", "§-paragrafer.`;", "CONTRACT_EXTRACT_SYSTEM");
    // ⚠️ §3:s kryssrutor finns inte i textlagret — läser modellen dem gissar den.
    ok("systemprompten pekar på PRISSEKTIONEN, inte omfattningslistan",
       /aldrig ur omfattningslistans kryssrutor/.test(sys));
    ok("systemprompten ber om kontrollräkning innan svar", /Kontrollräkna innan du svarar/.test(sys));

    // ⚠️ sort_field skulle tyst utelämna katalogposter utan display_order.
    const hints = slice(SRC, "async function _importCatalogHints()", "\n}", "_importCatalogHints");
    ok("katalog-hintarna hämtas UTAN sort_field (annars tappas poster tyst)",
       /bubbleFindAll\(SERVICES\.CATALOG_TYPE, \{\}\)/.test(hints) && !/sort_field/.test(hints));

    const sysFn = new Function("CONTRACT_EXTRACT_SYSTEM",
      slice(SRC, "function _contractExtractSystem(hints)", "\n}", "_contractExtractSystem")
      + "\nreturn _contractExtractSystem;")("BAS");
    ok("katalogens slugar injiceras i prompten",
       /- vaxter \(Växter\)/.test(sysFn([{ slug: "vaxter", name: "Växter" }])));
    ok("tom katalog → oförändrad prompt (import stupar inte på otillgänglig katalog)",
       sysFn([]) === "BAS");
    ok("prompten säger att tillsyn/entrémattor hör till housekeeping",
       /Tillsyn, entrémattor.*housekeeping/.test(sysFn([{ slug: "housekeeping", name: "HK" }])));
  });

  await group("import-enrich", () => {
    const HINTS = [
      { slug: "housekeeping", name: "Housekeeping", offer_id: OFFER_HK },
      { slug: "vaxter",       name: "Växter",       offer_id: OFFER_VAX },
      { slug: "frukt",        name: "Frukt",        offer_id: OFFER_FRUKT },
    ];
    const enrich = new Function(
      slice(SRC, "const SPLIT_FIXED_UNITS", "\n}\n", "SPLIT_FIXED_UNITS")
      + slice(SRC, "const IMPORT_SLUG_KEYWORDS", "\n];", "IMPORT_SLUG_KEYWORDS")
      + slice(SRC, "function _importSlugFor(line, hints)", "\n}", "_importSlugFor")
      + slice(SRC, "function _importEnrichLines(parsed, hints)", "\n}", "_importEnrichLines")
      + "\nreturn _importEnrichLines;")();

    // Planhats §5, precis som Haiku förväntas returnera den.
    const parsed = { monthly_cost: 47097, lines: [
      { label: "Lokalvård", amount: 25100, unit: "per månad", service_hint: "housekeeping", included_in_monthly_total: true },
      { label: "Tillsyn 2 h/dag", amount: 13856, unit: "per månad", included_in_monthly_total: true },
      { label: "Entrèmatta", amount: 450, unit: "per månad", included_in_monthly_total: true },
      { label: "Växter inkl service av 25 stycken", amount: 7691, unit: "per månad", included_in_monthly_total: true },
      { label: "Frukt", amount: 45, unit: "per kg", included_in_monthly_total: false },
      { label: "Uppstartskostnad städmaterial", amount: 10000, unit: "engång", included_in_monthly_total: false },
      { label: "Leveransavgift växter", amount: 1590, unit: "engång", included_in_monthly_total: false },
    ] };
    const out = enrich(parsed, HINTS);
    const by = (n) => out.lines.find((l) => l.label.startsWith(n));

    ok("avstämningen går ihop mot 47 097", out.reconciliation.ok && out.reconciliation.diff === 0);
    ok("bara de fasta raderna räknas in", out.reconciliation.fixed_lines === 4 && out.reconciliation.lines_sum === 47097);
    // Christians beslut, kodat som nyckelordsfallback — inte överlämnat till modellen.
    ok("Tillsyn mappas till housekeeping utan hint", by("Tillsyn").service_slug === "housekeeping");
    ok("Entrèmatta mappas till housekeeping utan hint", by("Entrèmatta").service_slug === "housekeeping");
    ok("Växter mappas till vaxter", by("Växter").service_slug === "vaxter");
    ok("varje mappad rad får ett föreslaget erbjudande",
       by("Lokalvård").suggested_offer_id === OFFER_HK && by("Frukt").suggested_offer_id === OFFER_FRUKT);
    ok("tre HK-rader pekar på SAMMA erbjudande (slås ihop av /split)",
       [by("Lokalvård"), by("Tillsyn"), by("Entrèmatta")].every((l) => l.suggested_offer_id === OFFER_HK));
    ok("engångsposter ingår inte i månadstotalen",
       by("Uppstartskostnad").included_in_monthly_total === false && by("Leveransavgift").included_in_monthly_total === false);

    // ⚠️ Enheten vinner över modellens flagga: en per-kg-rad kan aldrig ingå i
    // en fast månadsavgift, hur säker Haiku än låter.
    const lying = enrich({ monthly_cost: 100, lines: [
      { label: "Frukt", amount: 45, unit: "per kg", included_in_monthly_total: true },
      { label: "Städ", amount: 100, unit: "per månad", included_in_monthly_total: true }] }, HINTS);
    ok("rörlig enhet kan inte flaggas in i månadstotalen",
       lying.reconciliation.lines_sum === 100 && lying.reconciliation.ok);

    const missing = enrich({ monthly_cost: 47097, lines: parsed.lines.filter((l) => !/Växter/.test(l.label)) }, HINTS);
    ok("tappad rad → avstämningen faller med rätt differens",
       !missing.reconciliation.ok && missing.reconciliation.diff === -7691);
    ok("okänd rad listas som omappad så operatören måste välja",
       enrich({ monthly_cost: 0, lines: [{ label: "Skoputsmaskin", amount: 300, unit: "per månad" }] }, HINTS)
         .reconciliation.unmapped.join() === "Skoputsmaskin");
    // ⚠️ Måste testas med monthly_cost 0 — annars faller diff-kontrollen ändå
    // och testet bevisar inget om längdvillkoret. (Ett RateCard-avtal har
    // just 0 kr och inga rader, och skulle annars rapportera "avstämt".)
    ok("inga rader → avstämningen är inte 'ok' (tomt är aldrig ett svar)",
       enrich({ monthly_cost: 0, lines: [] }, HINTS).reconciliation.ok === false);
    ok("okänd service_hint faller tillbaka på nyckelorden",
       enrich({ monthly_cost: 0, lines: [{ label: "Lokalvård", amount: 1, unit: "per månad", service_hint: "hittepå" }] }, HINTS)
         .lines[0].service_slug === "housekeeping");
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Import B — raduppdelning i granskningsmodalen");
  // ════════════════════════════════════════════════════════════════════════
  await group("import-panel", () => {
    ok("parse-svaret bär avstämningen till frontend", /reconciliation,\n      method,/.test(SRC));
    ok("panelen renderas bara i import-läge med minst två rader",
       /if \(MODAL_MODE !== 'import' \|\| L\.length < 2\)/.test(FORETAG));
    ok("uppdelningen är förvald PÅ bara när avstämningen går ihop",
       /SPLIT_STATE\.on = !!\(d\.reconciliation && d\.reconciliation\.ok && SPLIT_STATE\.lines\.length > 1\)/.test(FORETAG));
    ok("varje rad får en erbjudande-dropdown förvald på förslaget",
       /splitOfferOptions\(l\.suggested_offer_id\)/.test(FORETAG));
    ok("antalet delavtal räknas om live vid dropdown-ändring",
       /function splitChildCount/.test(FORETAG) && /renderSplitFoot\(\); return;/.test(FORETAG));
    ok("panelen nollas i resetForm (läcker inte till create/edit)",
       /SPLIT_STATE = \{ lines: \[\], reconciliation: null, on: false \};\n    var splitPanel/.test(FORETAG));
    // ⚠️ Splitten körs EFTER commit — misslyckas den ska avtalet finnas kvar.
    ok("splitten körs efter commit, inte i stället för",
       /if \(MODAL_MODE === 'import' && SPLIT_STATE\.on && data\.contract_id\)/.test(FORETAG));
    ok("misslyckad split lämnar avtalet kvar och säger det",
       /Avtalet ligger kvar som ett enda avtal/.test(FORETAG));

    const payloadFn = fnFrom(FORETAG, "  function splitPayloadLines() {", "\n  }", "splitPayloadLines");
    ok("splitPayloadLines finns", !!payloadFn);
    // Buggen: en engångsrad som ÄVEN skickar unit_price får beloppet inlagt
    // två gånger av _splitChildRateCard (en gång rörligt, en gång som uppstart).
    ok("engångsrad skickar setup_cost men INTE unit_price (annars dubblas beloppet)",
       /unit_price: \(fixed \|\| engang\) \? null : l\.amount,/.test(FORETAG)
       && /setup_cost: engang \? l\.amount : null/.test(FORETAG));
    ok("raden skickar ingen kategori — backend härleder ur erbjudandet",
       !/category: readSelectedCategory\(\) \|\| IMPORT_STATE\.category/.test(FORETAG));

    // Backend: växtraden ska INTE ärva huvudavtalets Housekeeping.
    const sp = slice(SRC, 'app.post("/admin/contracts/:id/split", async (req, res) => {', "\n});", "split");
    ok("split slår upp kategori per erbjudande", /const catByOffer = new Map\(\);/.test(sp));
    ok("uppslaget hoppas över när anroparen skickat en giltig kategori",
       /if \(lines\.some\(\(l\) => String\(l\.offer_id\) === oid && VALID_CATEGORIES\.includes\(l\.category\)\)\) continue;/.test(sp));
    ok("härledd kategori går före masterns", /catByOffer\.get\(String\(l\.offer_id \|\| ""\)\.trim\(\)\) \|\| masterCat/.test(sp));
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Deal-klonen — affärsvyn får inte släpa efter kundkortet");
  // ════════════════════════════════════════════════════════════════════════
  await group("deal-klon", () => {
    // Affärs-popupen kör en egen klon av panelen. Glöms den bort visar
    // affärsvyn paketavtal platt, dubbelräknar totalen och saknar
    // raduppdelningen vid import — utan att något test blir rött.
    const both = PANEL_FEATURES;
    const _unused = [
      ["nästlar paketavtal",            /function nestPackages\(contracts\) \{/],
      ["styckpris på rörlig delrad",    /function variableRateOf\(ct\) \{/],
      ["masterrad namngiven av avtalet", /headName = ct\.contract_title \|\| ct\.service_name/],
      ["paket-pill",                    /ab-pill t-pkg/],
      ["delradernas summa mot totalen", /ab-kids-sum/],
      ["raduppdelning vid import",      /function renderSplitPanel\(\)/],
      ["split kedjad efter commit",     /SPLIT_STATE\.on && data\.contract_id/],
      ["panelen nollas i resetForm",    /SPLIT_STATE = \{ lines: \[\], reconciliation: null, on: false \};\n    var splitPanel/],
      ["bilagor bara på mastern",       /ct\.is_child \? '' :/],
      ["totalen hoppar över barnen",    /allCt\.filter\(function \(c\) \{ return !c\.master_contract_id; \}\)/],
      ["Hybrid i månadstotalen",        /c\.contract_type !== 'RateCard'/],
      ["expand-selektor är barn-komb.", /\.ab-row\.open > \.ab-rowbody \{ display:block; \}/],
      ["chevron-selektor scopad",       /\.ab-row\.open > \.ab-rowhead \.ab-chev/],
      ["CATALOG bär slug",              /slug: svc\.slug \|\| null,/],
    ];
    for (const [what, re] of both) {
      ok("deal-klonen har " + what, typeof re === "function" ? re(DEAL) : re.test(DEAL));
    }

    // CSS får inte dubbleras av en slarvig port (två .ab-split-block = drift).
    const once = PANEL_CSS_ONCE;
    for (const c of once) {
      ok("deal-klonen har '" + c + "' exakt en gång", DEAL.split(c).length - 1 === 1);
    }

    // ⚠️ Namnrymden ÄR isoleringen (gotcha 11: två block på samma sida krockar
    // via delade ID:n/window-fn). Läcker den är felet osynligt tills båda
    // blocken råkar ligga på samma Bubble-sida.
    ok("deal-klonen använder inte kund-blockets wrapper", !/class="ab-wrap/.test(DEAL));
    ok("deal-klonen har inga _k-suffixade globaler", !/window\.\w+_k\b/.test(DEAL));
    ok("källblocket har inga _d-suffixade globaler", !/window\.\w+_d\b/.test(FORETAG));
    ok("deal-klonens egen logik är orörd av porten",
       /var DEAL_LIVE = WIZ_DEAL_ID;/.test(DEAL) && /window\.miraAvtalModal = \{/.test(DEAL)
       && /function keepDeal\(c\)/.test(DEAL));
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Företagskortets KPI — backend får inte dubbelräkna paketavtal");
  // ════════════════════════════════════════════════════════════════════════
  await group("kort-kpi", () => {
    // ⚠️ Kortets rubrikrad ("Avtal / mån", "Aktiva avtal") räknas i BACKEND, inte
    // i HTML-blocket. Efter Planhat-splitten visade den 94 194 kr · 4 st i stället
    // för 47 097 kr · 1 st — mastern OCH dess tre delrader summerades.
    const loop = slice(COMPAPI, "      let mrr = 0, active = 0;",
      'if (isActive) { active++; mrr += Math.round(Number(ct["månadskostnad"] || 0)); }\n      }', "kort-KPI-loop");
    const kpi = new Function("contracts", "now",
      loop + "\nreturn { mrr, active };");

    const now = Date.now();
    const future = new Date(now + 300 * 864e5).toISOString();
    const planhat = [
      { _id: "m1",  "månadskostnad": 47097, slutdatum: future },
      { _id: "c1",  "månadskostnad": 39406, slutdatum: future, master_contract: "m1" },
      { _id: "c2",  "månadskostnad": 7691,  slutdatum: future, master_contract: "m1" },
      { _id: "c3",  "månadskostnad": 0,     slutdatum: future, master_contract: "m1" },
    ];
    const r = kpi(planhat, now);
    ok("splittat paketavtal räknas som ETT avtal", r.active === 1);
    // ⚠️ Motsatt regel mot _buildServicesDashboard: där hoppas MASTERN över (tiles
    // kommer från delraderna), här hoppas DELRADERNA över (pengar hör till
    // dokumentet). Inverteras den här blir antalet 3 fast summan råkar stämma.
    ok("det är DELRADERNA som hoppas över, inte mastern",
       /const parent = ct\["master_contract"\];/.test(COMPAPI)
       && !/masterIds\.has\(String\(ct\._id\)\)/.test(COMPAPI));
    ok("beloppet är avtalets total, inte summan av master + delrader", r.mrr === 47097);

    // Ref-fält kommer som objekt ELLER sträng ur Bubble beroende på väg.
    const asObj = kpi([{ _id: "m1", "månadskostnad": 100, slutdatum: future },
                       { _id: "c1", "månadskostnad": 100, slutdatum: future, master_contract: { _id: "m1" } }], now);
    ok("master_contract som objekt känns igen (inte bara sträng)", asObj.active === 1 && asObj.mrr === 100);

    const plain = kpi([{ _id: "a", "månadskostnad": 1000, slutdatum: future },
                       { _id: "b", "månadskostnad": 2000, slutdatum: future }], now);
    ok("osplittade avtal räknas som förr", plain.active === 2 && plain.mrr === 3000);

    const expired = kpi([{ _id: "a", "månadskostnad": 1000, slutdatum: "2020-01-01" }], now);
    ok("utgångna avtal räknas fortfarande bort", expired.active === 0 && expired.mrr === 0);
  });

  // ════════════════════════════════════════════════════════════════════════
  sec("Företagslistan — LIVE kundkortet sedan native-kortet dog");
  // ════════════════════════════════════════════════════════════════════════
  await group("foretag-lista", () => {
    // ⚠️ Christian pensionerade Bubbles native kundkort 2026-08-27: kundkort
    // OCH avtalsfliken går nu genom mira-foretag-lista.html. Den har panelen
    // INPORTAD ("allt annat är verbatim", 2026-08-17) — egen .ab-wrap-markup,
    // egen modul, egen rowHtml. Släpar den efter är det DEN kunden ser.
    ok("företagslistan bär panelens markup själv", /<div class="ab-wrap">/.test(FORETAG));
    ok("företagslistan registrerar panelmodulen", /FKAVTAL\.ab = \{/.test(FORETAG));
    // Anropas via map(rowHtml) — INTE rowHtml(...). En grep på "rowHtml(" missar
    // det och gav 2026-08-27 slutsatsen "död kod", vilket var fel.
    ok("dess rowHtml anropas via map(rowHtml)", /\.map\(function \(n\) \{ return rowHtml\(n\.ct, n\.kids\); \}\)/.test(FORETAG));

    for (const [what, re] of PANEL_FEATURES) {
      ok("företagslistan har " + what, typeof re === "function" ? re(FORETAG) : re.test(FORETAG));
    }
    for (const c of PANEL_CSS_ONCE) {
      ok("företagslistan har '" + c + "' exakt en gång", FORETAG.split(c).length - 1 === 1);
    }
    // Företagslistan är NYARE än kund-blocket på en punkt — porten får inte
    // ha slagit ihjäl den.
    // ⚠️ Bilage-porten grep:ade ursprungligen fram till '<div class="ab-rowact">'
    // och RADERADE send-for-signing-UI:t som ligger däremellan i den här filen
    // (kund-blocket har inget där). Två assertions så det inte kan upprepas.
    ok("signeringsrutan 'Signering pågår' överlevde porten",
       /ct\.awaiting_signature\n\s*\? '<div class="ab-sign"><h4>Signering pågår<\/h4>'/.test(FORETAG));
    ok("signeringsformulärets fäste överlevde porten",
       /'<div data-signwrap="' \+ esc\(ct\.id\) \+ '"><\/div>'/.test(FORETAG));
    ok("is_signed-kryssrutan överlevde porten",
       /var signedBox = \$\('f-is-signed'\);/.test(FORETAG) && /if \(signedBox\) signedBox\.checked = true;/.test(FORETAG));
    ok("mountPanes flyttar fortfarande in panelen", /mount\.appendChild\(pane\);/.test(FORETAG));
  });

  console.log(`\n${fail === 0 ? "✅" : "❌"}  ${pass} pass · ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
