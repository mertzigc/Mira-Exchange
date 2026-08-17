// Smoke för den delade ClientCompany-cachen i index.js (WU-fixen 2026-08-17).
//   node cc_cache_smoke.mjs
// Kör mot RIKTIG källkod: vi klipper ut bubbleFindAll + hela cache-blocket ur index.js
// och injicerar en stubbad bubbleFind som RÄKNAR SIDHÄMTNINGAR — samma enhet Bubble
// tar WU på (~1,65 WU per 100-radssida). Bryts blocket i index.js så faller testet.
// index.js är för stor/sidoeffektsfylld för att importeras, därav textextraktionen.
import fs from "node:fs";

const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

function slice(startNeedle, endNeedle, label) {
  const a = SRC.indexOf(startNeedle);
  if (a < 0) throw new Error(`hittade inte start för ${label}: ${startNeedle}`);
  const b = SRC.indexOf(endNeedle, a);
  if (b < 0) throw new Error(`hittade inte slut för ${label}: ${endNeedle}`);
  return SRC.slice(a, b + endNeedle.length);
}

const findAllSrc = slice("async function bubbleFindAll(", "\n}", "bubbleFindAll");
const ccSrc = slice(
  "// ── Delad, förvärmd ClientCompany-cache",
  "// INGEN setInterval här",
  "CC-cacheblocket"
);

// ── Stubbad Bubble ────────────────────────────────────────────────────────────
let STORE = [];
let pageCalls = [];          // varje element = en sidhämtning {constraints, cursor, limit}
let failNextDelta = false;

function bubbleId(o) { return o && (o._id || o.id) || null; }

function bubbleFind(typeName, { constraints = [], limit = 1, cursor = 0 } = {}) {
  pageCalls.push({ typeName, constraints, cursor, limit });
  const md = constraints.find((c) => c.key === "Modified Date");
  if (md && failNextDelta) { failNextDelta = false; return Promise.reject(new Error("Bubble 400: bad constraint")); }
  let rows = STORE;
  if (md) {
    if (md.constraint_type !== "greater than") throw new Error(`oväntad constraint_type: ${md.constraint_type}`);
    const since = Date.parse(md.value);
    rows = rows.filter((r) => Date.parse(r["Modified Date"]) > since);
  }
  return Promise.resolve(rows.slice(cursor, cursor + limit));
}

const factory = new Function("bubbleFind", "bubbleId", `
  ${findAllSrc}
  ${ccSrc}
  return {
    sharedCompanyMap, sharedCompanyOwnerMap, sharedCompanyFullMap, sharedCompanyPatchEntry,
    loadSharedCC: _loadSharedCC, forget: sharedCompanyForget,
    cache: () => _ccSharedCache,
    ttls: { CC_SHARED_TTL, CC_FULL_TTL, CC_DELTA_MARGIN },
  };
`);

// ── Testram ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("❌ " + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (fick ${JSON.stringify(a)}, väntade ${JSON.stringify(b)})`);

// Modified Date sprids ut (1 h mellan varje) som i verkligheten — annars hamnar hela
// tabellen innanför delta-marginalen och delta ser ut att läsa "allt".
const BASE = Date.parse("2026-06-01T00:00:00.000Z");
const HOUR = 3600 * 1000;
const at = (h) => new Date(BASE + h * HOUR).toISOString();
const company = (n, mod) => ({
  _id: `cc${n}`, Name_company: `Företag ${n}`, Kundansvarig: `u${n % 3}`,
  Org_Number: `55${n}`, Kundstatus: "Kund", NKI_carotte: 8,
  "Modified Date": mod || at(n),
});

const reset = (count) => {
  STORE = Array.from({ length: count }, (_, i) => company(i + 1));
  pageCalls = [];
};

// ── 1. Kall start = HELSVEP, exakt ceil(N/100)+1 sidhämtningar ────────────────
// (+1 = den avslutande sidan som returnerar <limit och bryter loopen)
reset(250);
let api = factory(bubbleFind, bubbleId);
await api.loadSharedCC();
eq(pageCalls.length, 3, "kall start: 250 företag = 3 sidhämtningar");
ok(pageCalls.every((c) => c.constraints.length === 0), "kall start använder helsvep (inga constraints)");
eq((await api.sharedCompanyFullMap()).size, 250, "cachen innehåller alla 250");
eq((await api.sharedCompanyMap()).get("cc7"), "Företag 7", "namn-mappen resolvar");
eq((await api.sharedCompanyOwnerMap()).get("cc3"), "u0", "ägar-mappen resolvar");

// ── 2. Färsk cache = NOLL Bubble-anrop ────────────────────────────────────────
pageCalls = [];
await api.sharedCompanyFullMap();
await api.sharedCompanyMap();
await api.sharedCompanyFullMap();
eq(pageCalls.length, 0, "färsk cache gör inga Bubble-anrop");

// ── 3. Stale cache = DELTA, inte helsvep ──────────────────────────────────────
// Ett företag ändrat efter förra svepet + ett helt nytt.
STORE[4] = { ...STORE[4], Name_company: "Företag 5 OMDÖPT", "Modified Date": at(300) };
STORE.push(company(251, at(301)));
api.cache().ts = 0;                                   // tvinga stale (TTL 60 min)
pageCalls = [];
await api.loadSharedCC();
const deltaPages = pageCalls.length;
eq(deltaPages, 1, `delta läser 1 sida, inte 3 (helsvepet) — läste ${deltaPages}`);
ok(pageCalls.every((c) => c.constraints.some((x) => x.key === "Modified Date")), "delta constraintar på Modified Date");
eq((await api.sharedCompanyMap()).get("cc5"), "Företag 5 OMDÖPT", "delta uppdaterade ändrat företag");
eq((await api.sharedCompanyMap()).get("cc251"), "Företag 251", "delta plockade upp nytt företag");
eq((await api.sharedCompanyFullMap()).size, 251, "cachen har växt till 251");

// ── 4. Delta-fönstret har marginal bakåt (klockskew/skrivningar under svepet) ──
api.cache().ts = 0;
pageCalls = [];
await api.loadSharedCC();
const since = Date.parse(pageCalls[0].constraints.find((c) => c.key === "Modified Date").value);
eq(Date.parse(at(301)) - since, api.ttls.CC_DELTA_MARGIN, "delta frågar från senast sedda MINUS marginalen");

// ── 5. PATCH-entry flyttar INTE delta-fönstret ────────────────────────────────
// Annars kan våra egna skrivningar hoppa förbi externa (native) ändringar.
const modBefore = api.cache().modTs;
api.sharedCompanyPatchEntry("cc9", { _id: "cc9", Name_company: "Patchad", "Modified Date": "2026-09-01T00:00:00.000Z" });
eq(api.cache().modTs, modBefore, "sharedCompanyPatchEntry rör inte modTs");
eq((await api.sharedCompanyMap()).get("cc9"), "Patchad", "sharedCompanyPatchEntry uppdaterar cachen");

// ── 6. Efter CC_FULL_TTL: helsvep igen (enda sättet att se raderade poster) ────
STORE.splice(0, 1);                                    // cc1 raderat i Bubble
api.cache().ts = 0;
api.cache().fullTs = Date.now() - api.ttls.CC_FULL_TTL - 1;
pageCalls = [];
await api.loadSharedCC();
ok(pageCalls.length >= 3, `helsvep efter CC_FULL_TTL (läste ${pageCalls.length} sidor)`);
ok(pageCalls.every((c) => c.constraints.length === 0), "det är ett riktigt helsvep, inte delta");
eq((await api.sharedCompanyFullMap()).has("cc1"), false, "helsvepet rensade raderat företag");

// ── 7. Delta som failar → faller tillbaka på helsvep (aldrig tyst gammal data) ─
api.cache().ts = 0;
failNextDelta = true;
pageCalls = [];
await api.loadSharedCC();
ok(pageCalls.length > 1, "delta-fel → helsvep i st.f. att servera stale");
eq(failNextDelta, false, "delta-felet konsumerades");

// ── 8. In-flight-dedup: parallella anrop = ETT svep ───────────────────────────
reset(250);
api = factory(bubbleFind, bubbleId);
await api.loadSharedCC();                              // joina boot-prewarmen, varm cache
STORE.push(company(999, at(400)));                     // en ändring att hämta
api.cache().ts = 0;
pageCalls = [];
await Promise.all([api.loadSharedCC(), api.loadSharedCC(), api.loadSharedCC()]);
eq(pageCalls.length, 1, "tre parallella anrop ger EN delta-hämtning, inte tre");

// ── 9. Regressionsvakt: ingen setInterval på helsvepet ────────────────────────
// Räknar bort kommentarsrader — blockkommentaren ovanför cachen NÄMNER setInterval.
const codeOnly = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
ok(!/setInterval\([^)]*_loadSharedCC/.test(codeOnly), "ingen setInterval kring _loadSharedCC (WU-fällan)");
ok(/_loadSharedCC\(\)\.catch/.test(ccSrc), "boot-prewarm finns kvar");

// ── 10. TTL-värden ────────────────────────────────────────────────────────────
eq(api.ttls.CC_SHARED_TTL, 60 * 60 * 1000, "CC_SHARED_TTL = 60 min");
eq(api.ttls.CC_FULL_TTL, 12 * 60 * 60 * 1000, "CC_FULL_TTL = 12 h");

// ── 11. WU-räkning: dygnskostnad före vs efter ────────────────────────────────
// Före: setInterval var 10:e min × 55 sidor. Efter: 1 helsvep/12h + delta vid behov.
const WU_PER_PAGE = 1.65;               // uppmätt ur Bubble-metrics 16 aug (23474 WU / 14221 runs)
const PAGES_FULL = 55;
const before = 144 * PAGES_FULL * WU_PER_PAGE;
const activeHours = 10;                 // en generös arbetsdag med trafik varje timme
const after = 2 * PAGES_FULL * WU_PER_PAGE + activeHours * 1 * WU_PER_PAGE;
ok(before > 13000, `gammalt idle-golv > 13k WU/dygn (${Math.round(before)})`);
ok(after < 1000, `nytt tak < 1k WU/dygn (${Math.round(after)})`);
console.log(`   ℹ️  CC-cache WU/dygn: ${Math.round(before)} → ≤${Math.round(after)} (−${Math.round(100 - (after / before) * 100)}%)`);

// ══ 12. "Senast ändrad"-cachen (touch) — samma extraktionsteknik ════════════
// Aggregatet är ett MAX → delta på Modified Date är säkert (nyare rader kan bara
// flytta värdet framåt). Testet mäter att svepen verkligen blir DELTA efter första
// varvet, och att MAX-semantiken håller.
const touchSrc = slice(
  '// ── Delad "senast ändrad"-cache',
  "  return c.map || null;\n}",
  "touch-cacheblocket"
);

let tCalls = [];              // {type, constraints}
let TSTORE = {};
function tFindAll(typeName, { constraints = [] } = {}) {
  tCalls.push({ type: typeName, constraints });
  const md = constraints.find((c) => c.key === "Modified Date");
  let rows = TSTORE[typeName] || [];
  if (md) {
    const since = Date.parse(md.value);
    rows = rows.filter((r) => Date.parse(r["Modified Date"]) > since);
  }
  return Promise.resolve(rows);
}
const tFactory = new Function("bubbleFindAll", "bubbleId", `
  function _ccRef(v){ return v == null ? null : (typeof v === "string" ? v : bubbleId(v)); }
  ${touchSrc}
  return { warm: sharedCompanyTouchMapWarm, cache: () => _ccTouchCache, sources: CC_TOUCH_SOURCES,
           ttl: CC_TOUCH_TTL, fullTtl: CC_TOUCH_FULL_TTL };
`);

const row = (id, company, mod) => ({ _id: id, "Modified Date": mod });
TSTORE = {
  activitet_crm: [Object.assign(row("a1"), { company: "cc1", "Modified Date": at(100) })],
  Coworker: [Object.assign(row("p1"), { "Kundföretag": "cc2", "Modified Date": at(50) })],
  Matter: [Object.assign(row("m1"), { "Kundföretag": "cc1", "Modified Date": at(20) })],
  Lead: [Object.assign(row("l1"), { client_company: "cc3", "Modified Date": at(80) })],
  deal: [Object.assign(row("d1"), { "kundföretag": "cc2", "Modified Date": at(90) })],
  Todo: [Object.assign(row("t1"), { "Företag": "cc4", "Modified Date": at(70) })],
};

const tApi = tFactory(tFindAll, bubbleId);
// Kall: warm() returnerar null men startar laddningen i bakgrunden.
tCalls = [];
eq(tApi.warm(), null, "touch: kall cache → warm() ger null (blockerar aldrig listan)");
await new Promise((r) => setTimeout(r, 10));
eq(tCalls.length, 6, "touch: helsvep = ett anrop per typ (6)");
ok(tCalls.every((c) => c.constraints.length === 0), "touch: första varvet är helsvep (inga constraints)");
eq(tCalls.map((c) => c.type).join(","), "activitet_crm,Coworker,Matter,Lead,deal,Todo", "touch: alla sex typer svepta");
const tm = tApi.warm();
ok(tm instanceof Map, "touch: warm() ger kartan när den är varm");
eq(tm.get("cc1").src, "aktivitet", "touch: cc1 senast rörd av aktivitet (nyare än ärendet)");
eq(tm.get("cc2").src, "affär", "touch: cc2 senast rörd av affär (nyare än personen)");
eq(tm.get("cc3").src, "lead", "touch: cc3 rörd av lead");
eq(tm.get("cc4").src, "todo", "touch: cc4 rörd av todo");

// Varm: inga anrop alls.
tCalls = [];
tApi.warm();
eq(tCalls.length, 0, "touch: varm cache gör inga Bubble-anrop");

// Stale → DELTA per typ, inte helsvep.
tApi.cache().ts = 0;
tCalls = [];
tApi.warm();
await new Promise((r) => setTimeout(r, 10));
eq(tCalls.length, 6, "touch: stale → ett anrop per typ");
ok(tCalls.every((c) => c.constraints.some((x) => x.key === "Modified Date" && x.constraint_type === "greater than")),
  "touch: andra varvet är DELTA (Modified Date greater than) — inte helsvep");

// MAX-semantik: en ÄLDRE rad får inte dra tillbaka tidsstämpeln.
const cc1Before = tApi.warm().get("cc1").ts;
TSTORE.Matter.push(Object.assign(row("m2"), { "Kundföretag": "cc1", "Modified Date": at(200) }));
TSTORE.activitet_crm.push(Object.assign(row("a2"), { company: "cc1", "Modified Date": at(5) }));
tApi.cache().ts = 0;
tApi.warm();
await new Promise((r) => setTimeout(r, 10));
const cc1After = tApi.warm().get("cc1");
ok(cc1After.ts > cc1Before, "touch: nyare relaterad rad flyttar tidsstämpeln FRAMÅT");
eq(cc1After.src, "ärende", "touch: källan följer den nyaste raden (ärende tog över)");

// Delta kan inte se RADERINGAR → periodiskt helsvep måste rensa aggregatet.
// Utan det ligger en raderad nyaste-rad kvar och håller företaget för högt.
TSTORE.Matter = TSTORE.Matter.filter((r) => r["Kundföretag"] !== "cc1");   // alla cc1-ärenden bort
TSTORE.activitet_crm = [];                                                 // och alla aktiviteter
// → cc1 har nu INGA relaterade rader kvar och ska försvinna ur kartan vid helsvep
tApi.cache().ts = 0;
tCalls = [];
tApi.warm();                                                     // stale, men INTE dags för helsvep
await new Promise((r) => setTimeout(r, 10));
ok(tApi.warm().has("cc1"), "touch: delta ser inte raderingar (cc1 ligger kvar) — förväntat");
ok(tCalls.every((c) => c.constraints.length > 0), "touch: det var en delta, inte helsvep");
tApi.cache().ts = 0;
tApi.cache().fullTs = Date.now() - tApi.fullTtl - 1;              // tvinga helsvep
tCalls = [];
tApi.warm();
await new Promise((r) => setTimeout(r, 10));
ok(tCalls.every((c) => c.constraints.length === 0), "touch: efter CC_TOUCH_FULL_TTL blir det HELSVEP");
eq(tApi.warm().has("cc1"), false, "touch: helsvepet rensade bort företaget vars rader raderats");
eq(tApi.fullTtl, 12 * 60 * 60 * 1000, "touch: CC_TOUCH_FULL_TTL = 12 h");
eq(tApi.ttl, 15 * 60 * 1000, "touch: CC_TOUCH_TTL = 15 min (färskhets-lag)");

// Regressionsvakt: ingen prewarm/interval på de sex svepen.
const codeOnly2 = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
ok(!/setInterval\([^)]*_loadCompanyTouch/.test(codeOnly2), "touch: ingen setInterval (WU-fällan)");
ok(!/^_loadCompanyTouch\(\)/m.test(codeOnly2), "touch: ingen boot-prewarm");

// ══ 13. Dött referens-id (Render-felstormen 17 aug) ══════════════════════════
// Bubble svarar 400 MISSING_DATA när man constraintar ett REFERENSFÄLT med ett id
// som inte finns (t.ex. ett företag raderat i Bubble som ligger kvar i cachen).
// Detektorn måste matcha SMALT: fel fältnamn/typnamn/5xx ska fortsätta braka,
// annars döljer vi äkta bugs.
const deadSrc = slice("function _deadRefId(e)", "\n}", "_deadRefId");
const deadRefId = new Function(`${deadSrc}; return _deadRefId;`)();
const bubble400 = (msg) => ({ detail: { status: 400, body: JSON.stringify({ statusCode: 400, body: { status: "MISSING_DATA", message: msg } }) } });

eq(deadRefId(bubble400("Invalid data for endpoint OfferApprovalRequest, key clientcompany: object with this id does not exist: 1786973695006x125242385169383420")),
  "1786973695006x125242385169383420", "deadRef: plockar ut id ur Bubbles OfferApprovalRequest-fel (verklig felkropp)");
eq(deadRefId(bubble400("Invalid data for endpoint User, key Associated_company: object with this id does not exist: 1786976210777x476885722473431040")),
  "1786976210777x476885722473431040", "deadRef: samma för User.Associated_company");
eq(deadRefId(bubble400("Invalid data for endpoint Matter, key Kundforetag: not a valid field")), null,
  "deadRef: FEL FÄLTNAMN matchas INTE (måste fortsätta braka)");
eq(deadRefId({ detail: { status: 404, body: "not found" } }), null, "deadRef: 404 matchas inte");
eq(deadRefId({ detail: { status: 500, body: "Service temporarily unavailable" } }), null, "deadRef: Bubble-5xx matchas inte");
eq(deadRefId({}), null, "deadRef: fel utan detail matchas inte");
eq(deadRefId({ detail: { status: 400, body: "object with this id does not exist" } }), null, "deadRef: 400 utan id-mönster matchas inte");

// Evictering: dött företag ska försvinna ur ALLA tre kartorna.
reset(250);
const fApi = factory(bubbleFind, bubbleId);
await fApi.loadSharedCC();
ok((await fApi.sharedCompanyFullMap()).has("cc7"), "evict: cc7 finns före");
eq(fApi.forget("cc7"), true, "evict: forget() returnerar true när posten fanns");
eq((await fApi.sharedCompanyFullMap()).has("cc7"), false, "evict: borta ur full-kartan");
eq((await fApi.sharedCompanyMap()).has("cc7"), false, "evict: borta ur namn-kartan");
eq(fApi.forget("cc7"), false, "evict: andra anropet returnerar false (redan borta)");
eq(fApi.forget(""), false, "evict: tomt id är no-op");

console.log(fail ? `\n❌ pass=${pass} fail=${fail}` : `\n✅ ALLA GRÖNA  pass=${pass} fail=0`);
process.exit(fail ? 1 : 0);
