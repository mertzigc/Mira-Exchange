// Smoke: Intelliplan-klienten (steg 1–2).
//   node intelliplan_smoke.mjs
//
// Mockad fetch → vi kan verifiera exakt vad som går på tråden: URL-mönster,
// token-cache, förnyelse, 401-retry, cookie-hantering och att client_secret
// aldrig läcker ut i något svar.
import { createIntelliplanClient, describeReportPayload, parseCsv, profileCsvColumns, normalizeRevenueDay, IP_REVENUE_DAY_REPORT } from "./intelliplan.js";
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
  ok("läser befintliga CONSTRAINTAT på datum, inte helsvep", /constraint_type: "greater than or equal"/.test(syncBlock));
  ok("saknad datatyp → 502 med läsbar orsak", /kunde_inte_lasa_befintliga/.test(syncBlock));
  // Bubble droppar okända fält TYST — utan läs-tillbaka ser synken lyckad ut.
  ok("verifierar att fälten persisterade", /fields_missing_on_type/.test(syncBlock));
  ok("föräldralösa rader rapporteras", /orphans/.test(syncBlock));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
