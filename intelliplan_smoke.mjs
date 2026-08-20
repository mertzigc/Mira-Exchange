// Smoke: Intelliplan-klienten (steg 1–2).
//   node intelliplan_smoke.mjs
//
// Mockad fetch → vi kan verifiera exakt vad som går på tråden: URL-mönster,
// token-cache, förnyelse, 401-retry, cookie-hantering och att client_secret
// aldrig läcker ut i något svar.
import { createIntelliplanClient, describeReportPayload, parseCsv, profileCsvColumns, normalizeRevenueDay, IP_REVENUE_DAY_REPORT,
         normalizeOrderMonth, suggestAccountMatches, normalizeCompanyName, IP_ORDER_MONTH_REPORT,
         scoreScheduleColumns, malFinnsInte, normalizePass, passRadtyp, IP_PASS_REPORT } from "./intelliplan.js";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));

// Påhittad, men samma form som en riktig Intelliplan-secret. Den SKARPA
// hemligheten hör hemma i Render-env och ska aldrig checkas in — inte ens som
// testfixture.
const SECRET = "0000000000000000DEADBEEF00000000";
const BASE = {
  tenant: "carotte-se", clientId: "intelliplan-report-export", clientSecret: SECRET,
  idpBase: "https://{tenant}.idp.intelliplan.eu",
  apiBase: "https://integrations-{tenant}.api.intelliplan.eu",
};

// ── Mockad fetch ────────────────────────────────────────────────────────────
function mkFetch(plan) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    const step = typeof plan === "function" ? plan(url, opts, calls) : plan;
    const s = step || {};
    const headers = {
      get: (k) => (s.headers || {})[String(k).toLowerCase()] || null,
      getSetCookie: () => s.setCookie || [],
    };
    return { ok: s.status ? s.status < 400 : true, status: s.status || 200, headers,
             text: async () => (typeof s.body === "string" ? s.body : JSON.stringify(s.body || {})) };
  };
  f.calls = calls;
  return f;
}
const tokenBody = (over) => Object.assign({ access_token: "eyJTOKEN", expires_in: 3600, token_type: "Bearer", scope: "processengine" }, over || {});

// En grupp som kraschar ska bli ETT rött kryss, inte fälla hela körningen.
async function group(label, fn) {
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ [${label} kraschade] ${e && e.message}`); }
}

function slice(src, a, b, label) {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i);
  if (i < 0 || j < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${a}"`); return ""; }
  return src.slice(i, j + b.length);
}

const run = async () => {

  // ══════════════════════════════════════════════════════════════════════════
  sec("Konfiguration — hemligheten läcker aldrig");
  // ══════════════════════════════════════════════════════════════════════════
  let c = createIntelliplanClient(BASE);
  let cfg = c.config();
  ok("bygger IDP-URL ur tenant", cfg.idp_base === "https://carotte-se.idp.intelliplan.eu");
  ok("bygger API-URL ur tenant (annat värdmönster!)", cfg.api_base === "https://integrations-carotte-se.api.intelliplan.eu");
  ok("ready när alla tre env finns", cfg.ready === true);
  ok("client_id är inte hemligt och visas", cfg.client_id === "intelliplan-report-export");
  // ⚠️ Kärnan: hela config-objektet går ut över HTTP i /debug-env.
  ok("client_secret finns INTE någonstans i config", !JSON.stringify(cfg).includes(SECRET));
  ok("secret redovisas som kort fingeravtryck", /^[0-9a-f]{8}$/.test(cfg.client_secret_fingerprint));
  ok("fingeravtrycket är stabilt", createIntelliplanClient(BASE).config().client_secret_fingerprint === cfg.client_secret_fingerprint);
  ok("annan hemlighet → annat fingeravtryck",
     createIntelliplanClient({ ...BASE, clientSecret: "annan" }).config().client_secret_fingerprint !== cfg.client_secret_fingerprint);

  const bare = createIntelliplanClient({ tenant: "", clientId: "", clientSecret: "" });
  ok("saknad env → ready:false", bare.config().ready === false);
  let threw = null;
  try { await bare.ensureAccessToken(); } catch (e) { threw = e; }
  ok("saknad env → 503 som NAMNGER vad som saknas",
     threw && threw.status === 503 && /INTELLIPLAN_TENANT/.test(threw.message) && /INTELLIPLAN_CLIENT_SECRET/.test(threw.message));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Token");
  // ══════════════════════════════════════════════════════════════════════════
  let f = mkFetch({ body: tokenBody() });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  const t1 = await c.ensureAccessToken();
  ok("hämtar token", t1 === "eyJTOKEN" && f.calls.length === 1);
  ok("rätt token-URL", f.calls[0].url === "https://carotte-se.idp.intelliplan.eu/connect/token");
  ok("POST med form-urlencoded", f.calls[0].opts.method === "POST" && /x-www-form-urlencoded/.test(f.calls[0].opts.headers["Content-Type"]));
  const sent = new URLSearchParams(f.calls[0].opts.body);
  ok("grant_type=client_credentials", sent.get("grant_type") === "client_credentials");
  ok("scope=processengine", sent.get("scope") === "processengine");
  ok("secret skickas i kroppen (inte i URL:en)", sent.get("client_secret") === SECRET && !f.calls[0].url.includes(SECRET));

  await c.ensureAccessToken();
  ok("andra anropet använder cachen", f.calls.length === 1);
  await c.ensureAccessToken({ force: true });
  ok("force hämtar ny token", f.calls.length === 2);

  // Förnyelse med marginal: 3600 s → vi förnyar efter 3240 s, inte 3600.
  let clock = 0;
  f = mkFetch({ body: tokenBody() });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, now: () => clock, log: () => {} });
  await c.ensureAccessToken();
  clock = 3200 * 1000;
  await c.ensureAccessToken();
  ok("token återanvänds strax före marginalen", f.calls.length === 1);
  clock = 3300 * 1000;
  await c.ensureAccessToken();
  ok("förnyar 6 min FÖRE utgång (aldrig ett anrop med död token)", f.calls.length === 2);

  // Samtidiga anrop ska ge EN token-hämtning
  f = mkFetch(() => ({ body: tokenBody() }));
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  await Promise.all([c.ensureAccessToken(), c.ensureAccessToken(), c.ensureAccessToken()]);
  ok("samtidiga anrop dedupas till en hämtning", f.calls.length === 1);

  // Felvägar — kroppen måste med, annars är felsökning ren gissning
  f = mkFetch({ status: 401, body: { error: "invalid_client" } });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  threw = null;
  try { await c.ensureAccessToken(); } catch (e) { threw = e; }
  ok("401 från IdP → fel med status", threw && threw.status === 401);
  ok("IdP:ns felkropp bevaras", threw && /invalid_client/.test(threw.body));
  ok("felet läcker inte hemligheten", threw && !JSON.stringify({ m: threw.message, b: threw.body }).includes(SECRET));

  f = mkFetch({ body: "<html>gateway</html>", headers: { "content-type": "text/html" } });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  threw = null;
  try { await c.ensureAccessToken(); } catch (e) { threw = e; }
  ok("icke-JSON från IdP → tydligt fel, inte krasch", threw && /unparsable/.test(threw.message));

  f = mkFetch({ body: { expires_in: 3600 } });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  threw = null;
  try { await c.ensureAccessToken(); } catch (e) { threw = e; }
  ok("svar utan access_token → eget fel", threw && /missing_access_token/.test(threw.message));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Rapport-anrop");
  // ══════════════════════════════════════════════════════════════════════════
  const ROWS = { rows: [{ Konsult: "Anna", Timmar: 12, Kund: "NEXON" }, { Konsult: "Bo", Timmar: 8, Kund: "CMIAB" }] };
  f = mkFetch((url) => url.includes("/connect/token")
    ? { body: tokenBody() }
    : { body: ROWS, headers: { "content-type": "application/json" } });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  let r = await c.getGridReport({ id: 1, lang: "sv", dateFrom: "2024-01-01", dateTo: "2024-01-31" });
  const repUrl = f.calls[1].url;
  ok("rätt värd + path", repUrl.startsWith("https://integrations-carotte-se.api.intelliplan.eu/gridreport/1/sv"));
  // Utan overrideDatePeriodFilter använder rapporten sin egen sparade period —
  // datumen man skickar in blir då tysta no-ops.
  ok("datumfilter kräver overrideDatePeriodFilter=true", repUrl.includes("overrideDatePeriodFilter=true"));
  ok("dateFrom/dateTo med", repUrl.includes("dateFrom=2024-01-01") && repUrl.includes("dateTo=2024-01-31"));
  ok("Bearer-header satt", f.calls[1].opts.headers.Authorization === "Bearer eyJTOKEN");
  ok("svaret parsas", r.parsed === true && r.data.rows.length === 2);

  // Utan datum ska vi INTE tvinga override — då gäller rapportens egen period
  f.calls.length = 0;
  await c.getGridReport({ id: 7 });
  ok("utan datum: ingen override (rapportens egen period gäller)", !f.calls[0].url.includes("overrideDatePeriodFilter"));
  ok("default-språk sv", f.calls[0].url.includes("/gridreport/7/sv"));

  let e2 = null;
  try { await c.getGridReport({}); } catch (e) { e2 = e; }
  ok("saknat rapport-id → 400", e2 && e2.status === 400);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Cookies (ARRAffinity) — fångas, hårdkodas aldrig");
  // ══════════════════════════════════════════════════════════════════════════
  f = mkFetch((url) => url.includes("/connect/token")
    ? { body: tokenBody(), setCookie: ["ARRAffinity=abc123; Path=/; HttpOnly", "ARRAffinitySameSite=abc123; Path=/"] }
    : { body: ROWS, headers: { "content-type": "application/json" } });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  await c.getGridReport({ id: 1 });
  // Defensivt: saknas headern helt ska assertionen FALLA, inte krascha sviten
  // (en krasch gör mutationstestet tyst värdelöst).
  const ckHeader = (f.calls[1] && f.calls[1].opts.headers.Cookie) || "";
  ok("cookies från token-svaret skickas vidare", ckHeader.includes("ARRAffinity=abc123"));
  ok("båda affinity-cookiesarna med", ckHeader.includes("ARRAffinitySameSite=abc123"));
  // Kärnan: guidens exempel innehåller ETT specifikt instans-id. Hårdkodat hade
  // det fungerat tills Intelliplan byter instans.
  ok("inget hårdkodat cookie-värde i modulen",
     !fs.readFileSync(new URL("./intelliplan.js", import.meta.url), "utf8").includes("82114ef1feb862070f28d10a199"));

  c._reset();
  ok("reset tömmer cookie-jaren", c._cookies.size === 0);
  // Svarar servern utan set-cookie ska vi inte hitta på några.
  const f2 = mkFetch((url) => url.includes("/connect/token")
    ? { body: tokenBody() }
    : { body: ROWS, headers: { "content-type": "application/json" } });
  const c2 = createIntelliplanClient({ ...BASE, fetchImpl: f2, log: () => {} });
  await c2.getGridReport({ id: 1 });
  ok("inga cookies från servern → ingen Cookie-header", !f2.calls[1].opts.headers.Cookie);

  // ══════════════════════════════════════════════════════════════════════════
  sec("401 mitt i — förnya och gör om");
  // ══════════════════════════════════════════════════════════════════════════
  let reportHits = 0;
  f = mkFetch((url) => {
    if (url.includes("/connect/token")) return { body: tokenBody() };
    reportHits++;
    return reportHits === 1
      ? { status: 401, body: { error: "expired" } }
      : { body: ROWS, headers: { "content-type": "application/json" } };
  });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  r = await c.getGridReport({ id: 1 });
  ok("401 → ny token + omförsök, anroparen märker inget", r.parsed === true);
  ok("token hämtades två gånger", f.calls.filter((x) => x.url.includes("/connect/token")).length === 2);

  // Andra fel ska INTE försöka igen i all oändlighet
  f = mkFetch((url) => url.includes("/connect/token") ? { body: tokenBody() } : { status: 500, body: "boom" });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  threw = null;
  try { await c.getGridReport({ id: 1 }); } catch (e) { threw = e; }
  ok("500 kastar med status + kropp + URL", threw && threw.status === 500 && /boom/.test(threw.body) && !!threw.url);
  ok("500 försöker inte om", f.calls.filter((x) => !x.url.includes("/connect/token")).length === 1);

  // ══════════════════════════════════════════════════════════════════════════
  sec("describeReportPayload — rekognosering utan att dumpa allt");
  // ══════════════════════════════════════════════════════════════════════════
  let d = describeReportPayload({ parsed: true, data: ROWS, raw: JSON.stringify(ROWS), content_type: "application/json" }, { sample: true });
  ok("hittar rader i {rows:[]}", d.shape === "wrapped_array" && d.row_count === 2);
  ok("listar kolumnnamnen", JSON.stringify(d.columns) === JSON.stringify(["Konsult", "Timmar", "Kund"]));
  ok("visar en exempelrad", d.first_row.Konsult === "Anna");
  ok("redovisar storlek", d.bytes > 0);

  d = describeReportPayload({ parsed: true, data: [{ a: 1 }], raw: "[{}]" });
  ok("klarar toppnivå-array", d.shape === "array" && d.row_count === 1);
  d = describeReportPayload({ parsed: true, data: { data: [{ b: 2 }] }, raw: "{}" });
  ok("hittar rader i {data:[]}", d.row_count === 1);
  d = describeReportPayload({ parsed: true, data: { meta: 1 }, raw: "{}" });
  ok("objekt utan rader → nycklar i stället", d.shape === "object" && d.top_level_keys[0] === "meta");
  d = describeReportPayload({ parsed: false, raw: "inte ens en tabell", content_type: "text/plain" }, { sample: true });
  ok("oparsat utan tabellform → preview, ingen krasch", d.shape === "raw" && d.preview.includes("inte ens"));
  ok("tomt svar kraschar inte", describeReportPayload(null).shape === "raw");

  // ══════════════════════════════════════════════════════════════════════════
  sec("CSV — det format gridreport faktiskt svarar med");
  // ══════════════════════════════════════════════════════════════════════════
  // Bekräftat mot rapport 1063: rubrikrad + kommaseparerade rader, INTE JSON.
  const CSV = 'FinancialItemNote1,Article1,Consultant1,SalaryCost1\n'
            + 'Kan ej jobba,Arena Extrapersonal,Natalie - reception,-1341.2800\n'
            + '"Not, med komma",Kontorsarbete GBG,Anna Ek,0.0000\n'
            + '"Han sa ""hej""",Pentry,Bo Lund,-5640.0000\n';
  let csvRes = { parsed: false, raw: CSV, content_type: "text/csv" };
  let d2 = describeReportPayload(csvRes);
  ok("CSV känns igen (inte 'raw')", d2.shape === "csv");
  ok("kolumnnamnen läses ur rubrikraden",
     JSON.stringify(d2.columns) === JSON.stringify(["FinancialItemNote1", "Article1", "Consultant1", "SalaryCost1"]));
  ok("radantal exkl. rubrik", d2.row_count === 3);
  ok("avgränsare rapporteras", d2.delimiter === ",");
  // ⚠️ En split(",") hade förskjutit alla kolumner efter ett fält med komma i.
  ok("citerat fält med komma bryter inte kolumnerna", d2.rows_with_other_column_count === 0);
  ok("redovisar vilka kolumner som har data alls", d2.non_empty_columns.length === 4);

  // ── Persondata-grinden ──
  ok("INGEN datarad utan sample", d2.first_row === undefined && /persondata/.test(d2.note || ""));
  ok("ingen lönesiffra i svaret", !JSON.stringify(d2).includes("-1341.2800"));
  ok("inget konsultnamn i svaret", !JSON.stringify(d2).includes("Natalie"));
  let d3 = describeReportPayload(csvRes, { sample: true });
  ok("sample=true ger exempelrad", d3.first_row && d3.first_row.Consultant1 === "Natalie - reception");
  ok("citerade tecken avkodas", describeReportPayload(csvRes, { sample: true }).columns.length === 4
     && parseCsv(CSV)[3][0] === 'Han sa "hej"');

  ok("JSON-grenen döljer också rader utan sample",
     describeReportPayload({ parsed: true, data: ROWS, raw: "{}" }).first_row === undefined);
  ok("JSON-grenen visar rad med sample",
     describeReportPayload({ parsed: true, data: ROWS, raw: "{}" }, { sample: true }).first_row.Konsult === "Anna");
  ok("rå text döljs utan sample",
     describeReportPayload({ parsed: false, raw: "hemligt" }).preview === null);

  // Avvikande kolumnantal ska SYNAS, inte tystas
  d2 = describeReportPayload({ parsed: false, raw: "a,b,c\n1,2,3\n4,5\n" });
  ok("rader med annat kolumnantal rapporteras", d2.rows_with_other_column_count === 1);
  ok("semikolon-CSV klaras också", describeReportPayload({ parsed: false, raw: "a;b\n1;2\n" }).delimiter === ";");
  ok("en ensam rad utan avgränsare är inte CSV", describeReportPayload({ parsed: false, raw: "bara text" }).shape === "raw");

  // ══════════════════════════════════════════════════════════════════════════
  sec("Kolumnprofil — struktur utan innehåll");
  // ══════════════════════════════════════════════════════════════════════════
  const PROF = 'Note,Consultant,ConsultantId,Cost,Empty\n'
             + 'Kan ej jobba,Natalie Ek - reception,1001,-1341.2800,\n'
             + 'Förskott,Anna Lund - kontor,1002,0.0000,\n'
             + 'Förskott,Bo Berg - reception,1003,-5640.0000,\n';
  const pr = profileCsvColumns(PROF);
  ok("radantal", pr.rows === 3);
  ok("kolumnantal", pr.columns === 5);
  const byName = Object.fromEntries(pr.cols.map((c) => [c.name, c]));
  ok("tom kolumn syns som tom", byName.Empty.filled === 0 && byName.Empty.empty === 3);
  ok("kategorikolumn har låg unikhet", byName.Note.distinct === 2 && byName.Note.distinct_ratio < 0.7);
  ok("identifierarkolumn har hög unikhet", byName.ConsultantId.distinct_ratio === 1);
  ok("numerisk kolumn känns igen", byName.Cost.numeric_share === 1 && !!byName.Cost.numeric);
  ok("numeriska aggregat (företagsnivå, ej persondata)",
     byName.Cost.numeric.min === -5640 && byName.Cost.numeric.negatives === 2 && byName.Cost.numeric.zeros === 1);
  ok("id-kolumn är numerisk men får eget mönster", byName.ConsultantId.top_patterns[0].pattern === "9999");

  // ⚠️ HELA poängen: profilen får aldrig innehålla ett riktigt värde.
  const pj = JSON.stringify(pr);
  ok("inget konsultnamn i profilen", !pj.includes("Natalie") && !pj.includes("Anna") && !pj.includes("Bo Berg"));
  ok("ingen lönerad i profilen", !pj.includes("-1341.2800"));
  ok("ingen fritext i profilen", !pj.includes("Kan ej jobba"));
  ok("mönstret visar FORMEN, inte värdet",
     byName.Consultant.top_patterns[0].pattern === "Aaaaaaa Aa - aaaaaaaaa"
     || /^A/.test(byName.Consultant.top_patterns[0].pattern));
  ok("mönster räknas och sorteras", byName.Note.top_patterns[0].count === 2);
  ok("kolumner med samma kardinalitet flaggas som möjliga par",
     pr.same_cardinality_pairs.some((p) => p.includes("Consultant") && p.includes("ConsultantId")));

  const dp = profileCsvColumns('D\n2026-07-01\n2026-07-02\n');
  ok("datumkolumn känns igen", dp.cols[0].looks_date === true);

  // ⚠️ SKARP LÄCKA (juni-profilen 2026-08-19): [a-zåäö] släpper igenom é/ü/ø/ł
  // omaskerade, så delar av riktiga namn syntes i "mönstret".
  const uni = profileCsvColumns('N\nJosé Müller\nBjörn Ångström\nŁukasz Nowak\n');
  const upat = JSON.stringify(uni.cols[0].top_patterns);
  ok("accenttecken maskeras (é/ü/ø/ł läcker inte)", !/[éüøłöåÅÖ]/.test(upat));
  ok("bara A/a/9 och skiljetecken i mönstret", /^[Aa9 \-\/.,:;()"'\[\]{}+*&%#@!?_|\\]*$/.test(uni.cols[0].top_patterns[0].pattern));
  ok("versal/gemen-strukturen bevaras ändå", uni.cols[0].top_patterns[0].pattern.startsWith("A"));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Mall-discovery");
  // ══════════════════════════════════════════════════════════════════════════
  // Guiden dokumenterar ingen väg att LISTA mallar, och att gissa id:n har kostat
  // två felsökningar. Knacka på kandidatvägar i stället för att gissa vidare.
  let tried = [];
  f = mkFetch((url) => {
    if (url.includes("/connect/token")) return { body: tokenBody() };
    tried.push(url);
    return url.includes("/gridreport/list")
      ? { body: [{ id: 1058, name: "Intäkt totalt" }], headers: { "content-type": "application/json" } }
      : { status: 404, body: "not found" };
  });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  const disc = await c.discoverTemplates({ paths: ["/gridreport", "/gridreport/list", "/gridreport/templates"] });
  ok("provar alla kandidatvägar", disc.tried === 3 && tried.length === 3);
  ok("hittar den väg som svarar", disc.hits === 1 && (disc.results.find((x) => x.ok) || {}).path === "/gridreport/list");
  ok("404 räknas inte som träff", disc.results.filter((x) => x.status === 404).length === 2);
  // 401/403 = vägen FINNS men vi saknar behörighet — ett helt annat samtal med
  // Intelliplan än "vägen finns inte".
  f = mkFetch((url) => url.includes("/connect/token") ? { body: tokenBody() } : { status: 403, body: "nope" });
  c = createIntelliplanClient({ ...BASE, fetchImpl: f, log: () => {} });
  const forb = await c.discoverTemplates({ paths: ["/gridreport/list"] });
  ok("behörighetsfel särskiljs från saknad väg", forb.forbidden === 1 && forb.hits === 0);
  ok("en väg som kastar fäller inte hela svepet", forb.results.length === 1 && forb.results[0].ok === false);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Normaliserare 1081 — intäkt per dag och kontor");
  // ══════════════════════════════════════════════════════════════════════════
  // Kolumnnamn verifierade mot skarp data 2026-08-19.
  const H = "Date1,Date2,ConsultantOffice1,ConsultantOffice2,Revenue1\n";
  const REV = H
    + "20605,2026-06-01,3,Stockholm,451194.0000\n"
    + "20605,2026-06-01,,,0.0000\n"          // "No connection" — kontor saknas
    + "20606,2026-06-02,1,Göteborg,76664.5000\n"
    + "20606,2026-06-02,4,Malmö,-128555.9100\n";
  const n1 = normalizeRevenueDay(REV);
  ok("rapport-id exporteras", IP_REVENUE_DAY_REPORT === 1081);
  ok("alla rader normaliseras", n1.count === 4);
  ok("nyckeln är datum + kontor", n1.rows[0].key === "2026-06-01|3");
  // ⚠️ Utan "none" hade alla kontorslösa rader kolliderat på samma nyckel och
  // skrivit över varandra — "No connection"-raden finns varje dag.
  ok("kontorslös rad får nyckeln none", n1.rows[1].key === "2026-06-01|none" && n1.rows[1].office_id === null);
  ok("negativa belopp bevaras (krediteringar)", n1.rows[3].revenue === -128555.91);
  ok("summan stämmer", n1.revenue_total === Number((451194 + 0 + 76664.5 - 128555.91).toFixed(4)));
  ok("distinkta datum räknas", n1.dates.length === 2);
  ok("kontorslistan tar med none", n1.offices.includes("none"));
  ok("inga varningar på ren data", n1.warnings.length === 0);

  // ── Skyddsräcken ──
  let te = null;
  try { normalizeRevenueDay("Datum,Kontor,Belopp\n2026-06-01,Sthlm,100\n"); } catch (e) { te = e; }
  ok("ändrade kolumnnamn → STANNAR (lagrar inte nollor tyst)",
     te && /unexpected_columns/.test(te.message) && /Date2/.test(te.message));
  ok("felet listar vad som faktiskt kom", te && /fick: Datum,Kontor,Belopp/.test(te.message));

  // Date1 (dagar sedan epok) korskontrollerar Date2 — spretar de har vi läst fel kolumn
  te = null;
  try { normalizeRevenueDay(H + "20605,2026-09-09,3,Stockholm,100.0000\n"); } catch (e) { te = e; }
  ok("datumkolumnerna korskontrolleras", te && /date_mismatch/.test(te.message));
  const lax = normalizeRevenueDay(H + "20605,2026-09-09,3,Stockholm,100.0000\n", { strict: false });
  ok("strict:false varnar i stället för att kasta",
     lax.count === 1 && ((lax.warnings || [])[0] || {}).reason === "date_mismatch");

  te = null;
  try { normalizeRevenueDay(H + "20605,2026-06-01,3,Stockholm,100.0000\n20605,2026-06-01,3,Stockholm,200.0000\n"); } catch (e) { te = e; }
  ok("dubbel nyckel → STANNAR (kornigheten är inte den vi tror)", te && /duplicate_key/.test(te.message));

  const bad = normalizeRevenueDay(H + "20605,inte-ett-datum,3,Stockholm,100.0000\n20606,2026-06-02,1,GBG,50.0000\n", { strict: false });
  ok("ogiltigt datum hoppas över men RAPPORTERAS",
     bad.count === 1 && ((bad.warnings || [])[0] || {}).reason === "ogiltigt_datum");
  ok("tomt belopp blir 0, inte null", normalizeRevenueDay(H + "20605,2026-06-01,3,Sthlm,\n").rows[0].revenue === 0);
  ok("tom fil ger tomt resultat, ingen krasch", normalizeRevenueDay(H).count === 0);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Normaliserare 1058 — intäkt per kund och order/månad");
  // ══════════════════════════════════════════════════════════════════════════
  const OH = "DeliveryOffice1,DeliveryOffice2,Account1,Account2,Order1,Order2,SalesPerson1,SalesPerson2,"
           + "AccountCompanyOrgNo1,Revenue1,Cost1,Hours1,GrossMargin1,GrossMarginPercentage1\n";
  const OM = OH
    + "1,Göteborg,204,Gothia Towers AB,53,53 - Serveringspersonal,,,556858-0392,151078.0000,110000.0000,398.0000,41078.0000,0.2719\n"
    + "2,Stockholm,311,Arena Sergel,93,93 - Reception,6,Anna Ek,556858-0392,67055.0000,50157.0000,160.0000,16898.0000,0.2520\n"
    + ",,,,,,,,,0.0000,-228592.0000,,228592.0000,\n";
  const om = normalizeOrderMonth(OM, { periodKey: "2026-06" });
  ok("rapport-id exporteras", IP_ORDER_MONTH_REPORT === 1058);
  ok("nyckeln är period + order", om.rows[0].key === "2026-06|53");
  ok("ordernamnet strippas från id-prefixet", om.rows[0].order_name === "Serveringspersonal");
  ok("råa etiketten bevaras också", om.rows[0].order_label === "53 - Serveringspersonal");
  // ⚠️ Raden utan order bär ändå omsättning/kostnad — droppas den stämmer inte totalen.
  ok("raden utan order behålls med none-nyckel", om.rows[2].key === "2026-06|none" && om.rows_without_order === 1);
  ok("totalerna summerar ALLA rader", om.revenue_total === 218133 && om.cost_total === Number((110000 + 50157 - 228592).toFixed(4)));
  // ⚠️ Andel, inte procent. Multipliceras den två gånger blir TB 27 %→2700 %.
  ok("täckningsgraden lagras som ANDEL", om.rows[0].gross_margin_ratio === 0.2719);
  ok("kontona plockas ut distinkt", om.accounts.length === 2 && om.accounts[0].ip_account_id === 204);
  // ⚠️ Kolumnen finns i CSV:n men bär Carottes EGET orgnr — läses medvetet inte.
  ok("kundens orgnr-kolumn ignoreras (bär vårt eget nummer)",
     !JSON.stringify(om.rows[0]).includes("556858"));

  let oe = null;
  try { normalizeOrderMonth(OM, { periodKey: "2026-6" }); } catch (e) { oe = e; }
  ok("period_key måste vara YYYY-MM", oe && /period_key/.test(oe.message));
  oe = null;
  try { normalizeOrderMonth("A,B\n1,2\n", { periodKey: "2026-06" }); } catch (e) { oe = e; }
  ok("ändrade kolumnnamn → STANNAR", oe && /unexpected_columns/.test(oe.message));
  oe = null;
  try { normalizeOrderMonth(OH + "1,G,204,X,53,53 - A,,,,1,1,1,1,1\n1,G,204,X,53,53 - A,,,,2,2,2,2,1\n", { periodKey: "2026-06" }); } catch (e) { oe = e; }
  ok("dubbel order i samma period → STANNAR", oe && /duplicate_key/.test(oe.message));

  // ── Namnmatchning ──
  ok("bolagsform stryks vid normalisering", normalizeCompanyName("Gothia Towers AB") === "gothia towers");
  ok("bindestreck och punkt normaliseras", normalizeCompanyName("Gothia-Bankett, AB.") === "gothia bankett");
  const sug = suggestAccountMatches(om.accounts, [
    { id: "cc1", name: "Gothia Towers" }, { id: "cc2", name: "Arena Sergel AB" }, { id: "cc3", name: "Helt annat" }]);
  ok("exakt normaliserad träff ger poäng 1", (sug[0].suggestions[0] || {}).score === 1);
  ok("och markeras som trygg", sug[0].confident === true);
  ok("orelaterade företag filtreras bort", !JSON.stringify(sug).includes("Helt annat"));
  const amb = suggestAccountMatches([{ ip_account_id: 1, ip_account_name: "Gothia" }],
    [{ id: "a", name: "Gothia Towers" }, { id: "b", name: "Gothia Bankett" }]);
  // ⚠️ Två lika bra kandidater → ALDRIG confident. En felaktig automatkoppling är
  // dyrare att upptäcka än en manuell bekräftelse är att göra.
  ok("tvetydig match är aldrig confident", amb[0].confident === false);
  ok("men förslagen visas ändå", amb[0].suggestions.length >= 1);
  ok("konto utan namn kraschar inte", suggestAccountMatches([{ ip_account_id: 9, ip_account_name: null }], [{ id: "x", name: "Y" }])[0].confident === false);

  // ⚠️ SKARP DATA 2026-08-19: kontona är ANLÄGGNINGAR, inte bolag. Gothia Towers
  // har fem konton (Seasons, Imagine, Mässan, Heaven 23, Bankett) → mappningen
  // är många-till-en. Utan prefixmatchning hamnar de långt ned i förslagen.
  const sites = suggestAccountMatches(
    [{ ip_account_id: 4, ip_account_name: "Gothia Towers- Seasons" },
     { ip_account_id: 8, ip_account_name: "Gothia Towers - Heaven 23" },
     { ip_account_id: 17, ip_account_name: "Arena Sergel" }],
    [{ id: "cc1", name: "Gothia Towers AB" }, { id: "cc2", name: "Arena Sergel" }, { id: "cc3", name: "Annat" }]);
  ok("enhetsnamn matchas mot kunden via prefix", sites[0].suggestions[0].client_company_id === "cc1");
  ok("prefixträff får hög men inte full poäng", sites[0].suggestions[0].score === 0.95);
  ok("källan till träffen redovisas", sites[0].suggestions[0].via === "prefix");
  ok("separator utan mellanslag före hanteras ('Towers- Seasons')", sites[0].suggestions[0].score === 0.95);
  // ⚠️ Kärnan: prefixträff = "hör till kundens grupp", inte "ÄR kunden".
  // Den får aldrig kopplas automatiskt av apply_confident.
  ok("prefixträff är ALDRIG confident", sites[0].confident === false && sites[1].confident === false);
  ok("men exakt namnträff är det fortfarande", sites[2].confident === true && sites[2].suggestions[0].via === "namn");
  ok("flera konton kan peka på samma kund (många-till-en)",
     sites[0].suggestions[0].client_company_id === sites[1].suggestions[0].client_company_id);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Endpoints i index.js");
  // ══════════════════════════════════════════════════════════════════════════
  const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  ok("debug-env finns", SRC.includes('app.get("/admin/intelliplan/debug-env"'));
  ok("auth/test finns", SRC.includes('app.get("/admin/intelliplan/auth/test"'));
  ok("report finns", SRC.includes('app.get("/admin/intelliplan/report/:id"'));
  ok("probe finns", SRC.includes('app.get("/admin/intelliplan/probe"'));
  // ⚠️ Ligger de i openPrefixes kringgår de x-api-key-grinden och blir helt öppna.
  const gate = SRC.slice(SRC.indexOf("const openPrefixes = ["), SRC.indexOf("];", SRC.indexOf("const openPrefixes = [")));
  ok("INTE i openPrefixes (ska grindas av x-api-key)", !gate.includes("intelliplan"));
  const ipBlock = SRC.slice(SRC.indexOf("// INTELLIPLAN — Rapport-API"), SRC.indexOf('app.get("/tengella/debug-env"'));
  ok("steg 2 skriver ingenting till Bubble", !/bubbleCreate|bubblePatch|safeCreate/.test(ipBlock));
  ok("probe pausar mellan id:n (vi vet inget om rate limits)", /setTimeout\(r2, 300\)/.test(ipBlock));
  ok("felsvar bär status + detail för felsökning", /detail: e\?\.body/.test(ipBlock));
  // ⚠️ Rapporterna bär konsultnamn och lönekostnader — loggen får inte innehålla rader.
  ok("loggen skriver bara form och volym, aldrig radinnehåll",
     /shape\.shape.*row_count.*bytes/.test(ipBlock) && !/first_row|shape\.preview/.test(ipBlock));
  ok("datarader kräver uttryckligt sample=1/raw=1", /sample: req\.query\.sample === "1" \|\| req\.query\.raw === "1"/.test(ipBlock));
  ok("probe visar aldrig datarader", /describeReportPayload\(r\);\s*\/\/ aldrig sample/.test(ipBlock));
  ok("profile=1 finns och kräver INTE sample", /req\.query\.profile === "1"/.test(ipBlock) && /profileCsvColumns\(r\.raw\)/.test(ipBlock));

  const syncBlock = slice(SRC, "// INTELLIPLAN steg 4 —", "// ── Bilagor (Fas 2d)", "sync-blocket");
  ok("synk-endpoint finns", /app\.post\("\/admin\/intelliplan\/sync\/revenue-day"/.test(syncBlock));
  // ⚠️ En synk som skriver by default är en synk som skriver fel by default.
  ok("torrkörning är default", /const dryRun = b\.dry_run !== false/.test(syncBlock));
  ok("kräver ISO-datum", /from_och_to_krävs_som_YYYY-MM-DD/.test(syncBlock));
  ok("idempotent på ip_key", /byKey\.set\(k, r\)/.test(syncBlock) && /byKey\.get\(row\.key\)/.test(syncBlock));
  // Utan detta patchas 120 rader varje natt bara för att synced_at ändrats.
  ok("patchar bara när ett mätvärde ändrats", /if \(same\) \{ unchanged\+\+; continue; \}/.test(syncBlock));
  ok("läser befintliga CONSTRAINTAT på datum, inte helsvep",
     /constraint_type: "greater than"/.test(syncBlock) && /constraint_type: "less than"/.test(syncBlock));
  // ⚠️ SKARP BUGG 2026-08-19: Bubbles Data API stöder INTE "greater than or equal"
  // / "less than or equal" — en ogiltig constraint_type avvisar HELA frågan, och
  // felet kom tillbaka som ett intetsägande "bubbleFind failed.".
  // Kommentaren ovanför fixen nämner strängen — testa koden, inte prosan.
  const syncCode = syncBlock.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("använder INTE constraint-typer som Bubble saknar",
     !/greater than or equal|less than or equal/.test(syncCode));
  ok("intervallet görs inklusivt med dagen före/efter",
     /Date\.parse\(from \+ "T00:00:00Z"\) - 864e5/.test(syncBlock) && /Date\.parse\(to\s+\+ "T00:00:00Z"\) \+ 864e5/.test(syncBlock));
  ok("Bubbles egen felkropp når svaret", /detail: bubbleErr\?\.detail/.test(syncBlock));

  // Hela kodbasen ska hålla sig till de constraint-typer Bubble faktiskt har.
  const srcCode = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const badCt = (srcCode.match(/constraint_type: "(greater|less) than or equal"/g) || []).length;
  ok("inga 'or equal'-constraints någonstans i index.js", badCt === 0);
  ok("saknad datatyp → 502 med läsbar orsak", /kunde_inte_lasa_befintliga/.test(syncBlock));
  // Bubble droppar okända fält TYST — utan läs-tillbaka ser synken lyckad ut.
  ok("verifierar att fälten persisterade", /fields_missing_on_type/.test(syncBlock));
  // ⚠️ FALSK POSITIV 2026-08-19: Bubble lagrar inte null, så ett fält vi skickade
  // som null kommer tillbaka `undefined` fast fältet finns. Rapportens FÖRSTA rad
  // är "No connection" (kontor = null) → naiv koll på toCreate[0] flaggade
  // ip_office/ip_office_id som saknade trots att de var korrekt skapade.
  ok("probe-raden väljs efter flest ifyllda värden", /toCreate\.reduce\(\(best, r2\) => \(nonNull\(r2\) > nonNull\(best\)/.test(syncBlock));
  ok("bara fält vi skickade ett VÄRDE för verifieras", /sentKeys = Object\.keys\(probe\)\.filter\(\(k\) => probe\[k\] != null\)/.test(syncBlock));
  ok("kollar inte längre blint på första raden", !/Object\.keys\(toCreate\[0\]\)\.filter/.test(syncBlock));
  ok("föräldralösa rader rapporteras", /orphans/.test(syncBlock));

  const omBlock = slice(SRC, "// INTELLIPLAN steg 5 —", "// ── Bilagor (Fas 2d)", "order-month-blocket");
  ok("kundnivå-synk finns", /app\.post\("\/admin\/intelliplan\/sync\/order-month"/.test(omBlock));
  ok("torrkörning är default även här", /const dryRun = b\.dry_run !== false/.test(omBlock));
  // ⚠️ Kornigheten är månad. Ett spann över flera månader klumpas ihop av
  // Intelliplan och vår period_key skulle ljuga om vad raden avser.
  // Testa LOGIKEN, inte att funktionen råkar finnas — en oanvänd vakt vaktar inget.
  ok("grinden anropas i endpointen", /const bad = _ipMonthGuard\(from, to\)/.test(omBlock));
  ok("ogiltig period → 400", /if \(bad\) return res\.status\(400\)/.test(omBlock));
  await group("_ipMonthGuard", () => {
    const src = slice(SRC, "function _ipMonthGuard(from, to) {", "\n}", "_ipMonthGuard");
    const guard = new Function(src + "\nreturn _ipMonthGuard;")();
    ok("hel månad godkänns", guard("2026-06-01", "2026-06-30") === null);
    ok("februari 28 dagar godkänns", guard("2026-02-01", "2026-02-28") === null);
    ok("skottår: februari 29 dagar godkänns", guard("2024-02-01", "2024-02-29") === null);
    ok("spann över två månader nekas", /EN kalendermånad/.test(guard("2026-06-01", "2026-07-31") || ""));
    ok("start mitt i månaden nekas", /första dag/.test(guard("2026-06-15", "2026-06-30") || ""));
    ok("slut före månadens sista dag nekas", /sista dag/.test(guard("2026-06-01", "2026-06-29") || ""));
    ok("fel datumformat nekas", /YYYY-MM-DD/.test(guard("2026-06", "2026-06-30") || ""));
  });
  ok("nya konton skapas OMAPPADE", /newAccounts/.test(omBlock) && /accounts_unmapped/.test(omBlock));
  ok("omappade konton redovisas med exempel", /unmapped_examples/.test(omBlock));
  ok("kundkopplingen skrivs på faktaraden", /client_company: companyId/.test(omBlock));
  ok("samma läs-tillbaka-härdning som revenue-day", /fields_missing_on_type/.test(omBlock)
     && /nonNull\(r4\) > nonNull\(best\)/.test(omBlock));
  ok("saknad mappningstyp ger egen, läsbar orsak", /kunde_inte_lasa_kontomappning/.test(omBlock));

  ok("kontolistan finns", /app\.get\("\/admin\/intelliplan\/accounts"/.test(omBlock));
  // Företagsnamnen ska INTE kosta ett Bubble-svep — de finns i den delade cachen.
  ok("företagsnamn hämtas ur delade cachen, inte via Bubble", /sharedCompanyFullMap\(\)/.test(omBlock)
     && !/bubbleFindAll\("ClientCompany"/.test(omBlock));
  // ⚠️ SKARP BUGG 2026-08-19: sharedCompanyFullMap är ASYNC. Utan await blir
  // `full` ett Promise och felet "full.values is not a function" — kryptiskt nog
  // att man börjar leta på fel ställe. Kodbasen awaitar den överallt annars.
  const fullCalls = omBlock.match(/(await )?sharedCompanyFullMap\(\)/g) || [];
  ok("varje anrop av sharedCompanyFullMap är awaitat",
     fullCalls.length === 2 && fullCalls.every((m) => m.startsWith("await ")));
  // Gäller hela filen — samma miss någon annanstans ger samma kryptiska fel.
  // Lookbehind utesluter själva deklarationen (`async function sharedCompanyFullMap()`).
  const allFull = SRC.match(/(?<!function )(await )?sharedCompanyFullMap\(\)/g) || [];
  ok("inget oawaitat anrop någonstans i index.js",
     allFull.length >= 2 && allFull.every((m) => m.startsWith("await ")));
  ok("mappnings-endpoint finns", /app\.post\("\/admin\/intelliplan\/accounts\/map"/.test(omBlock));
  ok("apply_confident kopplar bara entydiga träffar", /s2\.confident && !pairs\.some/.test(omBlock));
  // Faktaraderna bär kopplingen från synktillfället — utan omkörning pekar
  // gamla rader fortfarande på ingenting.
  ok("svaret påminner om att köra om perioderna", /Kör om berörda perioder/.test(omBlock));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Mappningsskriptet");
  // ══════════════════════════════════════════════════════════════════════════
  const MAP_SH = fs.readFileSync(new URL("./intelliplan_map.sh", import.meta.url), "utf8");
  ok("fyra kommandon", ["status", "draft", "apply", "confident"].every((c) => MAP_SH.includes(c + ")")));
  ok("draft hämtar BARA omappade", /accounts\?unmapped=1/.test(MAP_SH));
  ok("draft sorterar bästa förslag först", /out\.sort\(key=lambda x: \(-\(x\['_poäng'\] or 0\)/.test(MAP_SH));
  // Tomt client_company_id = "hoppa över", inte "koppla till ingenting".
  ok("apply filtrerar bort tomma kopplingar", /if str\(r\.get\('client_company_id'\) or ''\)\.strip\(\)/.test(MAP_SH));
  ok("confident skickar apply_confident", /"apply_confident":true/.test(MAP_SH));
  // ⚠️ Den viktigaste raden i filen: många-till-en är förväntat.
  ok("dokumenterar att flera konton får peka på samma kund", /många-till-en|Gothia Towers har fem konton/.test(MAP_SH));
  ok("påminner om omkörning efter mappning", /kör om berörda perioder|Kör om berörda perioder/i.test(MAP_SH));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Mall-spaning — hitta rapporten med pass/schema-kornighet");
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ Intelliplan listar inte sina mallar och id:n syns inte i deras UI.
  // Intervallet är känt (23 mallar, 1027–1080) → rangeskanning är enda vägen.

  // 1058: order × månad. Har Hours1 — men det är en SUMMA, inte tidsupplösning.
  const s1058 = scoreScheduleColumns(["Account1","Account2","Order1","Order2","Revenue1","Cost1","Hours1","GrossMargin1"]);
  ok("1058 är ingen schemakandidat", s1058.kandidat === false);
  ok("och Hours1 förväxlas inte med tidsupplösning", !/tid/.test(s1058.varfor) || /saknar datumkolumn/.test(s1058.varfor));

  // 1081: dag × kontor. Har datum men ingen tid → dagsrapport, inte pass.
  const s1081 = scoreScheduleColumns(["Date1","Date2","ConsultantOffice1","ConsultantOffice2","Revenue1"]);
  ok("1081 har datum men är ingen kandidat", s1081.kandidat === false);
  ok("och skälet är att tid saknas", /dagsrapport, inte pass/.test(s1081.varfor));

  // 1063: lönekostnad. Konsult finns, men varken datum eller tid.
  const s1063 = scoreScheduleColumns(["FinancialItemNote1","Article1","Article2","Consultant1","Consultant2","Order1","Order2","SalaryCost1"]);
  ok("1063 är ingen kandidat trots konsultnamn", s1063.kandidat === false);
  ok("men konsultkolumnerna hittas", (s1063.traffar.konsult || []).length === 2);

  // Det vi FAKTISKT letar efter.
  const sPass = scoreScheduleColumns(["Date1","StartTime1","EndTime1","Consultant1","Consultant2","Account1","Account2"]);
  ok("datum + tid + konsult + kund är en kandidat", sPass.kandidat === true);
  ok("och får full poäng", sPass.score === 4);
  ok("och märks som starkaste kandidaten", /⭐⭐/.test(sPass.varfor));

  // Kandidat utan kundkolumn ska ändå flaggas — men svagare.
  const sUtanKund = scoreScheduleColumns(["Date1","StartTime1","EndTime1","Employee1"]);
  ok("datum+tid+konsult utan kund är fortfarande kandidat", sUtanKund.kandidat === true);
  ok("men får lägre poäng", sUtanKund.score === 3);

  // ⚠️ OBEDÖMBAR ≠ FÖRKASTAD. Skarpt 2026-08-20 svarade 14 av 53 mallar 200 OK
  // utan rubrikrad (ingen data på sonderingsdagen). De rapporterades som
  // "score 0, saknar datumkolumn" — omöjligt att skilja från en mall vi faktiskt
  // läst och förkastat. Slutsatsen "ingen mall har datum+tid" blev då osann.
  const sTom = scoreScheduleColumns([]);
  ok("tom kolumnlista är OBEDÖMBAR", sTom.bedombar === false);
  ok("och påstår INTE att datumkolumn saknas", !/saknar datumkolumn/.test(sTom.varfor));
  ok("utan säger att den ska köras om", /bredare datumfönster/.test(sTom.varfor));
  ok("obedömbar är aldrig en kandidat", sTom.kandidat === false);
  ok("en riktig kolumnlista är bedömbar", scoreScheduleColumns(["Account1"]).bedombar === true);
  ok("null hanteras som obedömbar", scoreScheduleColumns(null).bedombar === false);

  // ⚠️ Tomt id vs verkligt fel — får inte blandas ihop.
  ok("503 + GridReportTemplateDto = mallen finns inte",
     malFinnsInte({ status: 503, body: '{"error":"Could not find GridReportTemplateDto for id 1099"}' }) === true);
  ok("ett timeout-fel är INTE 'mallen finns inte'",
     malFinnsInte({ status: 504, body: "gateway timeout" }) === false);
  ok("tomt felsvar tolkas inte som saknad mall", malFinnsInte({}) === false);

  // ── Endpointen ────────────────────────────────────────────────────────────
  const IX = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const pStart = IX.indexOf('app.get("/admin/intelliplan/probe"');
  const pEp = IX.slice(pStart, IX.indexOf("\n});", pStart) + 4);
  const pCode = pEp.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("probe stödjer rangeskanning", /from_id/.test(pCode) && /to_id/.test(pCode));
  ok("spannet har ett tak", /spann_över_120_id/.test(pCode));
  ok("bakvänt spann avvisas", /to_id_före_from_id/.test(pCode));
  // ⚠️ PERSONDATA — skanningen får ALDRIG be om exempelrader.
  // ⚠️ PERSONDATA. Testa KODEN, inte texten: en efterföljande kommentar som
  // nämner "sample" gjorde första versionen av det här testet rött utan orsak.
  // Det som räknas är att describeReportPayload anropas UTAN options-objekt.
  const pRen = pCode.replace(/\/\/[^\n]*/g, "");           // strippa även radslutskommentarer
  ok("probe anropar describeReportPayload utan options", /describeReportPayload\(r\)\s*;/.test(pRen));
  ok("och begär aldrig en exempelrad", !/sample\s*:\s*true/.test(pRen) && !/sample=1/.test(pRen));
  ok("tomt id skiljs från verkligt fel", /finns_inte: tomt/.test(pCode) && /!r\.ok && !r\.finns_inte/.test(pCode));
  ok("failade anrop gör skanningen ofullständig", /OFULLSTÄNDIG/.test(pEp));
  ok("kandidater rankas och pekas ut", /schema_kandidater/.test(pCode) && /basta/.test(pCode));
  // ⚠️ Obedömda mallar får inte döljas i en "ingen kandidat"-slutsats.
  ok("obedömbara räknas separat", /mallar_obedombara/.test(pCode) && /obedombara_id/.test(pCode));
  ok("kandidater söks bara bland BEDÖMDA", /bedomda\.filter\(\(r\) => r\.schema_kandidat\)/.test(pCode));
  ok("slutsatsen nämner de obedömda när sådana finns", /är alltså OBEDÖMDA/.test(pEp));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Rapport 1082 — PASS per konsult, kund och dag");
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ Tre radtyper, bevisade ur skarp CSV (juli 2026: 1202 pass · 1146 inställda
  // · 1072 frånvaro). De överlappar ALDRIG, och det är hela grunden för att
  // PlacementHours inte får summeras som "arbetade timmar".
  ok("bokad tid → pass", passRadtyp({ harTid: true, placement: 8, lost: null, absence: null }) === "pass");
  ok("bara LostHours → inställt", passRadtyp({ harTid: false, placement: null, lost: 8, absence: null }) === "installt");
  ok("placement + absence → frånvaro", passRadtyp({ harTid: false, placement: 8, lost: null, absence: 8 }) === "franvaro");
  ok("inget av det → okänd, inte tyst pass", passRadtyp({ harTid: false, placement: null, lost: null, absence: null }) === "okand");
  // ⚠️ Ett inställt pass får ALDRIG klassas som genomfört — då blir 8 972 h
  // inställd tid till utförd tid.
  ok("inställt blir aldrig pass", passRadtyp({ harTid: false, placement: null, lost: 8, absence: null }) !== "pass");

  const PCSV = (rows) => "Date1,Date2,Consultant1,Consultant2,ConsultantNo1,Account1,Account2,"
    + "FinancialItemId1,OrderDescription1,OrderNo1,WorkdayBookedToTime1,FinancialItemNote1,"
    + "WorkdayBookedFromTime1,PlacementHours1,LostHours1,AbsenceHours1\n" + rows.join("\n");
  // fält:      d1,      d2, c1,   c2,  no,  a1, a2,  id, odesc, ono,  to, note, from, plac, lost, abs
  const prad = (o = {}) => ["20635", o.d || "2026-07-01", "9", o.c || "A B", o.no || "1037",
    o.a1 || "1015", o.a2 || "Arena Sergel", o.id || "1", o.odesc || "Reception", o.ono || "102",
    o.to || "", "", o.from || "", o.plac || "", o.lost || "", o.abs || ""].join(",");

  const pn1 = normalizePass(PCSV([
    prad({ id: "1", from: "08:00", to: "17:00", plac: "8.0000" }),          // pass, 1 h rast
    prad({ id: "2", lost: "8.0000" }),                                       // inställt
    prad({ id: "3", plac: "8.0000", abs: "8.0000" }),                        // frånvaro
  ]));
  ok("alla tre radtyper klassas rätt", JSON.stringify(pn1.typer) === JSON.stringify({ pass: 1, installt: 1, franvaro: 1, okand: 0 }));
  // ⚠️ Kärnan: placement_total INKLUDERAR frånvaro. utfort_total gör det inte.
  ok("placement_total inkluderar frånvaro", pn1.placement_total === 16);
  ok("utfort_total räknar BARA genomförda pass", pn1.utfort_total === 8);
  ok("de två är olika tal", pn1.placement_total !== pn1.utfort_total);
  ok("lost hålls separat", pn1.lost_total === 8);

  // ⚠️ Klocktid − betald tid = RAST (704 pass hade 1,0 h i juli). Att härleda
  // det ena ur det andra vore fel: de mäter olika saker.
  const pp1 = pn1.rows.find((r) => r.typ === "pass");
  ok("rasten räknas ut", pp1.rast_hours === 1);
  ok("start blir datum + bokad starttid", pp1.start === "2026-07-01T08:00:00.000Z");
  ok("slut blir datum + bokad sluttid", pp1.slut === "2026-07-01T17:00:00.000Z");

  // ⚠️ 36 pass i juli passerade midnatt. Utan +1 dygn blir slut FÖRE start.
  const pn2 = normalizePass(PCSV([prad({ id: "9", from: "22:00", to: "02:00", plac: "4.0000" })]));
  const pmid = pn2.rows[0];
  ok("midnattspass flaggas", pmid.passerar_midnatt === true);
  ok("och slutar dagen efter", pmid.slut === "2026-07-02T02:00:00.000Z");
  ok("slut ligger efter start", Date.parse(pmid.slut) > Date.parse(pmid.start));

  // Negativ rast = data vi inte äger → varna, blockera inte.
  const pn3 = normalizePass(PCSV([prad({ id: "7", from: "08:00", to: "12:00", plac: "8.0000" })]));
  ok("negativ rast varnas", (pn3.warnings || []).some((w) => w.reason === "negativ_rast"));
  ok("men raden behålls", pn3.count === 1);

  // ⚠️ Ändrade kolumner ska STANNA synken, inte lagra nollor.
  let stannade = false;
  try { normalizePass("Date2,Consultant2\n2026-07-01,A B"); } catch (e) { stannade = /unexpected_columns/.test(e.message); }
  ok("saknade kolumner stoppar synken", stannade);
  // Dubbel nyckel = kornighetsantagandet håller inte.
  let dubbel = false;
  try { normalizePass(PCSV([prad({ id: "5", plac: "8.0000", abs: "8.0000" }), prad({ id: "5", lost: "1.0000" })])); }
  catch (e) { dubbel = /duplicate_key/.test(e.message); }
  ok("dubbel FinancialItemId stoppar synken", dubbel);

  // ── Endpointen ────────────────────────────────────────────────────────────
  const ipStart = IX.indexOf('app.post("/admin/intelliplan/sync/pass"');
  const ipEp = IX.slice(ipStart, IX.indexOf("\n});", ipStart) + 4);
  const ipCode = ipEp.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("sync/pass finns", ipStart !== -1);
  ok("torrkörning är default", /dry_run !== false/.test(ipCode));
  // Prefixkonstanten ligger UTANFÖR routen → greppa hela filen för den, och
  // användningen inne i routen. (Första versionen greppade bara routen → rött.)
  ok("källnyckeln speglar Tengella-mönstret",
     /IP_PASS_SOURCE_PREFIX = "intelliplan:"/.test(IX) && /IP_PASS_SOURCE_PREFIX \+ r\.key/.test(ipCode));
  // ⚠️ Category-värdet är "Service & People", INTE "Staff".
  ok("Category är Service & People", /IP_PASS_CATEGORY = "Service & People"/.test(IX));
  ok("och inte Staff", !/IP_PASS_CATEGORY = "Staff"/.test(IX));
  // ⚠️ Helsvep på Activity (18 862 rader) = ~310 WU per körning.
  ok("befintliga läses constraintat på Startdatum", /key: "Startdatum", constraint_type: "greater than"/.test(ipCode));
  ok("inget okonstraintat Activity-svep", !/ACTIVITY_CONFIG\.ACTIVITY_TYPE, \{ \}\)/.test(ipCode));
  ok("patchar bara vid faktisk ändring", /const JMF = \[/.test(ipCode) && /unchanged\+\+/.test(ipCode));
  // ⚠️ Bubble droppar okända fält tyst.
  ok("läser tillbaka och rapporterar saknade fält", /fields_missing_on_type/.test(ipCode));
  ok("probe-raden väljs med flest ifyllda värden", /filter\(\(v\) => v != null\)\.length/.test(ipCode));
  ok("omappade konton redovisas", /konton_utan_clientcompany/.test(ipCode));
  ok("timmarna hålls isär per radtyp", /_ipPassTimmar/.test(ipCode));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
