// ────────────────────────────────────────────────────────────────────────────
// intelliplan.js — klient mot Intelliplans Rapport-API (steg 1–2)
//
// Fjärde datakällan jämte Fortnox/Tengella/Caspeco. Just nu BARA läsning av
// gridreports; skrivendpoints kommer från Intelliplan i vinter och växer in i
// samma modul (därför `request()` som generell väg, inte bara getGridReport).
//
// Två olika värdmönster — bekräftade mot integrationsguiden:
//   token:   https://{tenant}.idp.intelliplan.eu/connect/token
//   rapport: https://integrations-{tenant}.api.intelliplan.eu/gridreport/{id}/{lang}
//
// ⚠️ COOKIES: guidens curl-exempel skickar med `ARRAffinity`-cookies. Det är
// Azure App Services instans-stickiness och är bundet till EN instans hos dem —
// hårdkodar man värdet ur exemplet fungerar det tills instansen byts, sen blir
// det svårfelsökta fel. Vi hårdkodar därför ingenting: klienten fångar
// `set-cookie` från svaren och skickar tillbaka dem på följande anrop, precis
// som en webbläsare. Behövs de inte händer ingenting.
//
// ⚠️ HEMLIGHETER: client_secret kommer ur env och får aldrig loggas eller
// returneras. `config()` exponerar bara närvaro + ett kort fingeravtryck.
// ────────────────────────────────────────────────────────────────────────────
import crypto from "node:crypto";

const DEFAULT_SCOPE = "processengine";
// Förnya i god tid före utgång. Intelliplan ger 3600 s → ~6 min marginal.
const REFRESH_RATIO = 0.9;
const MIN_MARGIN_MS = 60 * 1000;

export function createIntelliplanClient(deps = {}) {
  const {
    tenant       = process.env.INTELLIPLAN_TENANT || "",
    clientId     = process.env.INTELLIPLAN_CLIENT_ID || "",
    clientSecret = process.env.INTELLIPLAN_CLIENT_SECRET || "",
    scope        = process.env.INTELLIPLAN_SCOPE || DEFAULT_SCOPE,
    // Bas-URL:erna går att överstyra via env om Intelliplan flyttar värdarna,
    // och injiceras av testerna. `{tenant}` ersätts.
    idpBase      = process.env.INTELLIPLAN_IDP_BASE || "https://{tenant}.idp.intelliplan.eu",
    apiBase      = process.env.INTELLIPLAN_API_BASE || "https://integrations-{tenant}.api.intelliplan.eu",
    fetchImpl    = globalThis.fetch,
    now          = () => Date.now(),
    log          = (...a) => console.log(...a),
  } = deps;

  const _sub = (t) => String(t || "").replace("{tenant}", tenant);
  const IDP = () => _sub(idpBase).replace(/\/+$/, "");
  const API = () => _sub(apiBase).replace(/\/+$/, "");

  // Aldrig hemligheten själv — bara nog för att se ATT rätt värde är deployat.
  const fingerprint = (v) =>
    v ? crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 8) : null;

  function config() {
    return {
      tenant: tenant || null,
      idp_base: tenant ? IDP() : idpBase,
      api_base: tenant ? API() : apiBase,
      scope,
      has_tenant: !!tenant,
      has_client_id: !!clientId,
      has_client_secret: !!clientSecret,
      client_id: clientId || null,                  // inte hemlig
      client_secret_fingerprint: fingerprint(clientSecret),
      ready: !!(tenant && clientId && clientSecret),
    };
  }

  // ── Cookie-jar (ARRAffinity m.fl.) ────────────────────────────────────────
  const _cookies = new Map();   // namn → värde
  function _absorbCookies(res) {
    if (!res || !res.headers) return;
    // Node 18+: getSetCookie() ger en array. Äldre: en sammanslagen sträng.
    const list = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get && res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    for (const raw of list || []) {
      const first = String(raw).split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) _cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  const _cookieHeader = () =>
    (_cookies.size ? [..._cookies.entries()].map(([k, v]) => k + "=" + v).join("; ") : null);

  // ── Token ─────────────────────────────────────────────────────────────────
  let _tok = { token: null, expiresAt: 0, scope: null };
  let _inflight = null;   // dedup: två samtidiga rapportanrop ska ge EN token-hämtning

  async function ensureAccessToken(opts = {}) {
    const force = opts.force === true;
    if (!force && _tok.token && now() < _tok.expiresAt) return _tok.token;
    if (_inflight) return _inflight;
    _inflight = (async () => {
      const cfg = config();
      if (!cfg.ready) {
        const missing = [!tenant && "INTELLIPLAN_TENANT", !clientId && "INTELLIPLAN_CLIENT_ID",
                         !clientSecret && "INTELLIPLAN_CLIENT_SECRET"].filter(Boolean);
        const e = new Error("intelliplan_env_missing: " + missing.join(", "));
        e.status = 503;
        throw e;
      }
      const url = IDP() + "/connect/token";
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      });
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      _absorbCookies(res);
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        // Ta med kroppen: IdentityServer svarar med {error:"invalid_client"} o.dyl.
        // och utan den blir felsökningen ren gissning.
        const e = new Error(`intelliplan_token_failed: HTTP ${res.status}`);
        e.status = res.status;
        e.body = text.slice(0, 500);
        throw e;
      }
      let j = {};
      try { j = JSON.parse(text); } catch (_) {
        const e = new Error("intelliplan_token_unparsable");
        e.status = 502; e.body = text.slice(0, 500);
        throw e;
      }
      const token = j.access_token;
      if (!token) {
        const e = new Error("intelliplan_token_missing_access_token");
        e.status = 502; e.body = text.slice(0, 500);
        throw e;
      }
      const lifeMs = (Number(j.expires_in) || 3600) * 1000;
      const margin = Math.max(MIN_MARGIN_MS, lifeMs * (1 - REFRESH_RATIO));
      _tok = { token, expiresAt: now() + lifeMs - margin, scope: j.scope || scope };
      log(`[intelliplan] ny access_token (scope=${_tok.scope}, giltig ${Math.round(lifeMs / 1000)}s)`);
      return token;
    })().finally(() => { _inflight = null; });
    return _inflight;
  }

  /** Utgångstid m.m. — för /auth/test. Aldrig själva token. */
  function tokenInfo() {
    return {
      cached: !!_tok.token,
      scope: _tok.scope,
      // Sekunder tills VI förnyar (inte tills Intelliplan går ut — vi har marginal).
      refresh_in_seconds: _tok.token ? Math.max(0, Math.round((_tok.expiresAt - now()) / 1000)) : null,
      token_preview: _tok.token ? String(_tok.token).slice(0, 6) + "…" : null,
    };
  }

  // ── Generellt anrop mot API-värden ────────────────────────────────────────
  // 401 en gång → tvinga ny token och gör om. Skyddar mot att en cachad token
  // hunnit återkallas på deras sida.
  async function request(path, opts = {}) {
    const doCall = async () => {
      const token = await ensureAccessToken();
      const url = path.startsWith("http") ? path : API() + (path.startsWith("/") ? path : "/" + path);
      const headers = Object.assign({ Authorization: "Bearer " + token, Accept: "application/json" }, opts.headers || {});
      const ck = _cookieHeader();
      if (ck) headers.Cookie = ck;
      const res = await fetchImpl(url, { method: opts.method || "GET", headers, body: opts.body });
      _absorbCookies(res);
      return { res, url };
    };

    let { res, url } = await doCall();
    if (res.status === 401) {
      log("[intelliplan] 401 — förnyar token och försöker igen");
      await ensureAccessToken({ force: true });
      ({ res, url } = await doCall());
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const e = new Error(`intelliplan_request_failed: HTTP ${res.status}`);
      // Generöst tak: Intelliplans fel kommer inpackade i flera lager
      // ("Shuffler error -> ... -> with response: {...errors:[{userMessage}]}")
      // och den upplysande delen ligger LÄNGST IN. Kapar man för tidigt får man
      // bara höljet och står utan diagnos.
      e.status = res.status; e.body = text.slice(0, 4000); e.url = url;
      throw e;
    }
    const ctype = String((res.headers && res.headers.get && res.headers.get("content-type")) || "");
    let data = null, parsed = false;
    if (ctype.includes("json") || /^\s*[[{]/.test(text)) {
      try { data = JSON.parse(text); parsed = true; } catch (_) {}
    }
    return { ok: true, url, status: res.status, content_type: ctype, parsed, data, raw: text };
  }

  /**
   * GET /gridreport/{id}/{lang}
   * Datumfiltret kräver overrideDatePeriodFilter=true för att slå igenom —
   * annars använder rapporten sin egen sparade period (guidens exempel).
   */
  async function getGridReport({ id, lang = "sv", dateFrom = null, dateTo = null, extra = null } = {}) {
    const rid = String(id == null ? "" : id).trim();
    if (!rid) { const e = new Error("report_id_krävs"); e.status = 400; throw e; }
    const qs = new URLSearchParams();
    if (dateFrom || dateTo) {
      qs.set("overrideDatePeriodFilter", "true");
      if (dateFrom) qs.set("dateFrom", dateFrom);
      if (dateTo) qs.set("dateTo", dateTo);
    }
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") qs.set(k, String(v));
    }
    const q = qs.toString();
    return request(`/gridreport/${encodeURIComponent(rid)}/${encodeURIComponent(lang)}` + (q ? "?" + q : ""));
  }

  /**
   * Rekognosering: finns en endpoint som LISTAR rapportmallar?
   *
   * Integrationsguiden dokumenterar bara `/gridreport/{id}/{lang}` och säger
   * ingenting om hur man får tag på id:n — vilket har kostat oss två felsökningar
   * (1–8 och 219). Deras egna felmeddelanden avslöjar dock den interna vägen:
   *   "Shuffler error -> GET /grid-report/v2/download"
   * så `/grid-report/v2/...` är formen deras backend använder. Vi knackar på ett
   * fåtal rimliga kandidater och redovisar vad var och en svarar.
   *
   * Läser bara. Sekventiellt med paus — vi vet inget om deras rate limits.
   */
  async function discoverTemplates(opts = {}) {
    const paths = opts.paths || [
      "/gridreport",
      "/gridreport/list",
      "/gridreport/templates",
      "/gridreporttemplate",
      "/grid-report/v2/templates",
      "/grid-report/v2/list",
      "/grid-report/templates",
      "/gridreport/template/list",
    ];
    const out = [];
    for (const path of paths) {
      try {
        const r = await request(path);
        // Träff: redovisa formen, inte hela kroppen (kan vara stor).
        out.push({ path, status: r.status, ok: true, content_type: r.content_type,
                   bytes: Buffer.byteLength(r.raw || "", "utf8"),
                   preview: String(r.raw || "").slice(0, 400) });
      } catch (e) {
        out.push({ path, status: e?.status || null, ok: false,
                   error: String(e?.message || e).slice(0, 120),
                   detail: String(e?.body || "").slice(0, 200) });
      }
      await new Promise((r2) => setTimeout(r2, 400));
    }
    // 404 = vägen finns inte. 401/403 = den finns men vi saknar behörighet —
    // och DET är ett helt annat samtal med Intelliplan.
    const hits = out.filter((x) => x.ok);
    const forbidden = out.filter((x) => x.status === 401 || x.status === 403);
    return { tried: paths.length, hits: hits.length, forbidden: forbidden.length, results: out };
  }

  return { config, ensureAccessToken, tokenInfo, request, getGridReport, discoverTemplates,
           _cookies, _reset: () => { _tok = { token: null, expiresAt: 0, scope: null }; _cookies.clear(); } };
}

/**
 * Minimal CSV-parser: hanterar citerade fält, inbäddade kommatecken och "" som
 * escapad citattecken. Grid-reporten levererar CSV där textfält (kundnamn,
 * noteringar) mycket väl kan innehålla kommatecken — en split(",") skulle tysta
 * förskjuta alla kolumner efter det första sådana fältet.
 */
export function parseCsv(text, { limit = 0, delimiter = "," } = {}) {
  const rows = []; let row = []; let field = ""; let quoted = false; let i = 0;
  const s = String(text == null ? "" : text);
  const push = () => { row.push(field); field = ""; };
  const endRow = () => { push(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === delimiter) { push(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      endRow(); i++;
      if (limit && rows.length >= limit) return rows;
      continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/** Gissa avgränsare ur rubrikraden — Intelliplan kör komma, men semikolon är
 *  vanligt i svenska exporter och kostar inget att klara av. */
function sniffDelimiter(text) {
  const head = String(text || "").split(/\r?\n/)[0] || "";
  const counts = [[",", (head.match(/,/g) || []).length], [";", (head.match(/;/g) || []).length],
                  ["\t", (head.match(/\t/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * Kolumnprofil: beskriv VARJE kolumn utan att avslöja innehållet.
 *
 * Steg 4 kräver att man förstår kolumnerna — är `Consultant1`/`Consultant2` två
 * olika personer på samma rad, eller namn och id för samma? Är `Order1` ett
 * ordernummer eller en ordertext? Det går att svara på utan att läsa ett enda
 * riktigt värde: fyllnadsgrad, antal distinkta värden och FORMEN på värdena
 * räcker.
 *
 * Maskering: bokstäver → a/A, siffror → 9, allt annat behålls.
 *   "Natalie - reception" → "Aaaaaaa - aaaaaaaaa"
 *   "-1341.2800"          → "-9999.9999"
 * Mönstret visar strukturen, aldrig identiteten.
 *
 * Numeriska kolumner får min/max/summa. Det är aggregat på företagsnivå, inte
 * persondata, och behövs för att avgöra om en kolumn är belopp eller antal.
 */
export function profileCsvColumns(raw, opts = {}) {
  const topPatterns = opts.topPatterns || 3;
  const delim = sniffDelimiter(raw);
  const rows = parseCsv(raw, { delimiter: delim });
  const header = rows[0] || [];
  const body = rows.slice(1).filter((r) => r.some((v) => (v || "").trim() !== ""));

  // ⚠️ Unicode-medveten: en teckenklass som [a-zåäö] släpper igenom é, ü, ø, ł …
  // omaskerade — och då läcker delar av riktiga namn ut i "mönstret".
  // (Upptäckt 2026-08-19: juni-profilen visade "Aaaaaa/Aaaaé".)
  const maskOf = (v) => String(v)
    .replace(/\p{Lu}/gu, "A").replace(/\p{Ll}/gu, "a")
    .replace(/\p{Lo}|\p{Lt}|\p{Lm}/gu, "a")   // skript utan versal/gemen-skillnad
    .replace(/\p{Nd}/gu, "9");
  const numRe = /^-?\d+([.,]\d+)?$/;
  const dateRe = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

  const cols = header.map((name, ci) => {
    const vals = body.map((r) => (r[ci] == null ? "" : String(r[ci]).trim()));
    const filled = vals.filter((v) => v !== "");
    const distinct = new Set(filled);
    const nums = filled.filter((v) => numRe.test(v)).map((v) => Number(v.replace(",", ".")));
    const pat = new Map();
    for (const v of filled) { const m = maskOf(v); pat.set(m, (pat.get(m) || 0) + 1); }
    const patterns = [...pat.entries()].sort((a, b) => b[1] - a[1]).slice(0, topPatterns)
      .map(([pattern, count]) => ({ pattern: pattern.slice(0, 60), count }));

    const c = {
      name, filled: filled.length, empty: vals.length - filled.length,
      distinct: distinct.size,
      // Hög andel unika värden = fritext/identifierare; låg = kategori/dimension.
      distinct_ratio: filled.length ? Number((distinct.size / filled.length).toFixed(3)) : 0,
      numeric_share: filled.length ? Number((nums.length / filled.length).toFixed(3)) : 0,
      looks_date: filled.length ? filled.filter((v) => dateRe.test(v)).length / filled.length > 0.8 : false,
      min_len: filled.length ? Math.min(...filled.map((v) => v.length)) : 0,
      max_len: filled.length ? Math.max(...filled.map((v) => v.length)) : 0,
      top_patterns: patterns,
    };
    if (nums.length && nums.length === filled.length) {
      c.numeric = { min: Math.min(...nums), max: Math.max(...nums),
                    sum: Number(nums.reduce((a, b) => a + b, 0).toFixed(4)),
                    negatives: nums.filter((n) => n < 0).length, zeros: nums.filter((n) => n === 0).length };
    }
    return c;
  });

  // Kolumnpar med samma kardinalitet är kandidater för "id + namn för samma sak"
  // (t.ex. Consultant1/Consultant2). Bara en ledtråd — verifieras med Intelliplan.
  const pairs = [];
  for (let i = 0; i < cols.length; i++) {
    for (let k = i + 1; k < cols.length; k++) {
      if (cols[i].filled && cols[i].distinct === cols[k].distinct && cols[i].filled === cols[k].filled) {
        pairs.push([cols[i].name, cols[k].name]);
      }
    }
  }
  return { rows: body.length, columns: cols.length, delimiter: delim === "\t" ? "tab" : delim,
           same_cardinality_pairs: pairs, cols };
}

/**
 * Rekognosering: beskriv ett okänt svar utan att dumpa allt.
 * Guiden säger ingenting om svarsformatet, så steg 2 handlar om att ta reda på
 * det — form, storlek, kolumnnamn — innan vi designar någon datamodell.
 *
 * ⚠️ PERSONDATA: gridreport 1063 bär konsultnamn och lönekostnader. Därför
 * returneras ALDRIG innehållet i en datarad om inte anroparen uttryckligen ber
 * om det (`sample:true`). Kolumnnamn och radantal räcker för att designa en
 * datamodell — och de är ofarliga att logga.
 */
export function describeReportPayload(result, opts = {}) {
  const sample = opts.sample === true;
  const out = { parsed: !!(result && result.parsed), content_type: (result && result.content_type) || null,
                bytes: result && result.raw ? Buffer.byteLength(result.raw, "utf8") : 0 };
  const d = result && result.data;

  // CSV-grenen: oparsat svar som ändå har en vettig rubrikrad
  if (result && !result.parsed && result.raw && String(result.raw).trim()) {
    const raw = String(result.raw);
    const delim = sniffDelimiter(raw);
    const rows = parseCsv(raw, { delimiter: delim });
    const header = rows[0] || [];
    const body = rows.slice(1).filter((r) => r.length > 1 || (r[0] || "").trim() !== "");
    if (header.length > 1) {
      out.shape = "csv";
      out.delimiter = delim === "\t" ? "tab" : delim;
      out.columns = header;
      out.column_count = header.length;
      out.row_count = body.length;
      // Rader vars kolumnantal avviker → citering/avgränsare tolkas fel, eller
      // så har rapporten grupperade sektioner. Måste synas, inte döljas.
      const odd = body.filter((r) => r.length !== header.length).length;
      out.rows_with_other_column_count = odd;
      out.non_empty_columns = header.filter((_, ci) => body.some((r) => (r[ci] || "").trim() !== ""));
      if (sample) out.first_row = body.length ? Object.fromEntries(header.map((h, ci) => [h, body[0][ci] ?? null])) : null;
      else out.note = "Datarader utelämnade (persondata). Lägg till sample=1 för en exempelrad.";
      return out;
    }
  }

  if (!result || !result.parsed || d == null) {
    out.shape = "raw";
    out.preview = sample && result && result.raw ? String(result.raw).slice(0, 800) : null;
    if (!sample) out.note = "Innehåll utelämnat. Lägg till sample=1 för att se början av svaret.";
    return out;
  }
  const rowsOf = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      // Vanliga inpackningar: {rows:[]} {data:[]} {items:[]} {result:[]}
      for (const k of ["rows", "data", "items", "result", "records", "values"]) {
        if (Array.isArray(v[k])) return v[k];
      }
    }
    return null;
  };
  const rows = rowsOf(d);
  if (rows) {
    out.shape = Array.isArray(d) ? "array" : "wrapped_array";
    out.row_count = rows.length;
    out.top_level_keys = Array.isArray(d) ? null : Object.keys(d).slice(0, 30);
    const first = rows.find((r) => r && typeof r === "object" && !Array.isArray(r));
    out.columns = first ? Object.keys(first).slice(0, 60) : null;
    if (sample) out.first_row = first ? JSON.parse(JSON.stringify(first)) : (rows.length ? rows[0] : null);
    else out.note = "Datarader utelämnade (persondata). Lägg till sample=1 för en exempelrad.";
  } else if (typeof d === "object") {
    out.shape = "object";
    out.top_level_keys = Object.keys(d).slice(0, 40);
    if (sample) out.preview = JSON.stringify(d).slice(0, 800);
  } else {
    out.shape = typeof d;
    if (sample) out.preview = String(d).slice(0, 400);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// NORMALISERARE — rapport 1081 "mira-rapport-1": intäkt per dag och kontor
// ────────────────────────────────────────────────────────────────────────────
// CSV-kolumner (verifierade 2026-08-19): Date1, Date2, ConsultantOffice1,
// ConsultantOffice2, Revenue1. Samma id+namn-parmönster som övriga rapporter.
//
// `Date2` är ISO (YYYY-MM-DD) och den vi använder. `Date1` är dagar sedan
// 1970-01-01 (verifierat: 20605 = 2026-06-01, 20634 = 2026-06-30) och används
// som KORSKONTROLL — spretar de har vi tolkat fel kolumn, och det ska braka
// högljutt i stället för att tyst lagra fel datum.
//
// Kornighet: en rad per (datum, kontor). Kontor kan saknas ("No connection" i
// UI:t) → nyckeln får "none". 121 rader för juni 2026.
export const IP_REVENUE_DAY_REPORT = 1081;

export function normalizeRevenueDay(csvText, opts = {}) {
  const strict = opts.strict !== false;
  const rows = parseCsv(csvText, { delimiter: sniffDelimiter(csvText) });
  const header = (rows[0] || []).map((h) => String(h || "").trim());
  const idx = (name) => header.indexOf(name);
  const iDateSerial = idx("Date1"), iDateIso = idx("Date2");
  const iOfficeId = idx("ConsultantOffice1"), iOfficeName = idx("ConsultantOffice2");
  const iRevenue = idx("Revenue1");

  const missing = [["Date2", iDateIso], ["ConsultantOffice1", iOfficeId],
                   ["ConsultantOffice2", iOfficeName], ["Revenue1", iRevenue]]
    .filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) {
    // Ändrar någon mallens kolumner ska synken STANNA, inte tyst lagra nollor.
    const e = new Error("intelliplan_unexpected_columns: saknar " + missing.join(", ") + " (fick: " + header.join(",") + ")");
    e.status = 502; throw e;
  }

  const num = (v) => { const s2 = String(v == null ? "" : v).trim().replace(",", "."); if (!s2) return null; const n = Number(s2); return Number.isFinite(n) ? n : null; };
  const out = [], warnings = [];
  const seen = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some((v) => String(v || "").trim() !== "")) continue;
    const iso = String(row[iDateIso] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) { warnings.push({ row: r, reason: "ogiltigt_datum", value: iso.slice(0, 20) }); continue; }

    // Korskontroll mot dagnumret. Bara när serien finns — den är inte obligatorisk.
    if (iDateSerial >= 0) {
      const serial = num(row[iDateSerial]);
      if (serial != null) {
        const fromSerial = new Date(serial * 864e5).toISOString().slice(0, 10);
        if (fromSerial !== iso) {
          const msg = `datumkolumnerna spretar på rad ${r}: Date1=${serial} (${fromSerial}) vs Date2=${iso}`;
          if (strict) { const e = new Error("intelliplan_date_mismatch: " + msg); e.status = 502; throw e; }
          warnings.push({ row: r, reason: "date_mismatch", value: msg });
        }
      }
    }

    const officeId = num(row[iOfficeId]);
    const officeName = String(row[iOfficeName] || "").trim();
    const revenue = num(row[iRevenue]);
    const key = iso + "|" + (officeId == null ? "none" : String(officeId));

    // Dubblettnyckel = vår kornighetsantagande stämmer inte. Måste synas.
    if (seen.has(key)) {
      const msg = `dubbel nyckel ${key} (rad ${seen.get(key)} och ${r}) — kornigheten är inte (datum, kontor)`;
      if (strict) { const e = new Error("intelliplan_duplicate_key: " + msg); e.status = 502; throw e; }
      warnings.push({ row: r, reason: "duplicate_key", value: msg });
      continue;
    }
    seen.set(key, r);

    out.push({ key, date: iso, office_id: officeId, office: officeName || null, revenue: revenue == null ? 0 : revenue });
  }

  const total = out.reduce((a, b) => a + (b.revenue || 0), 0);
  return { report_id: IP_REVENUE_DAY_REPORT, rows: out, count: out.length,
           revenue_total: Number(total.toFixed(4)), warnings,
           dates: [...new Set(out.map((r) => r.date))].sort(),
           offices: [...new Set(out.map((r) => (r.office_id == null ? "none" : r.office_id + " " + r.office)))].sort() };
}
