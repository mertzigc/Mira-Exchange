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
   * ⚠️ UTFALL 2026-08-19: samtliga åtta kandidatvägar gav **404, ingen 401/403**.
   * Det är alltså inte ett behörighetsproblem — vägarna finns inte. API-ytan mot
   * vår integration är genuint bara `/gridreport/{id}/{lang}`. **Rapport-id måste
   * läsas ur Intelliplans UI** (vyn "Report templates", fyrsiffrigt nummer under
   * ikonen, växlaren på "Both"). Kör inte om det här i tron att något ändrats —
   * be Intelliplan om en list-endpoint i stället, lämpligen samtidigt som
   * skrivendpointsen kommer i vinter.
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

// ────────────────────────────────────────────────────────────────────────────
// NORMALISERARE — rapport 1058 "Intäkt totalt (ink kund och uppdrag)"
// ────────────────────────────────────────────────────────────────────────────
// CSV-kolumner (verifierade 2026-08-19): DeliveryOffice1/2 · Account1/2 ·
// Order1/2 · SalesPerson1/2 · Revenue1 · Cost1 · Hours1 · GrossMargin1 ·
// GrossMarginPercentage1. `1` = id, `2` = visningsnamn.
//
// Kornighet: EN RAD PER ORDER OCH PERIOD (Order1 distinct_ratio 1.0) → nyckeln
// (period, order_id) gör periodomläsning idempotent utan rad-id.
//
// ⚠️ `GrossMarginPercentage1` är en ANDEL (max 1), inte procent. UI:t visar 27 %
// där CSV:n har 0,27. Vi lagrar andelen rå och låter presentationslagret formatera.
//
// ⚠️ En rad saknar order/kund/kontor ("No connection" i UI:t) men bär ändå
// omsättning. Den BEHÅLLS med order_id=null — droppas den stämmer inte totalen.
//
// ⚠️ `AccountCompanyOrgNo1` läses medvetet INTE: kolumnen finns men innehåller
// Carottes EGET orgnummer (ett distinkt värde på 231 rader), inte kundens.
// Intelliplan modellerar "Legal Company" som den egna juridiska personen i alla
// dimensioner. Kundkopplingen går därför via Account1 + manuell mappning.
export const IP_ORDER_MONTH_REPORT = 1058;

/** "412 - Arena Sergel" → "Arena Sergel". Order2 inleds med Order1 + " - ". */
function stripOrderPrefix(label, orderId) {
  const s2 = String(label == null ? "" : label).trim();
  if (orderId == null) return s2;
  const pre = String(orderId) + " - ";
  return s2.startsWith(pre) ? s2.slice(pre.length) : s2;
}

export function normalizeOrderMonth(csvText, opts = {}) {
  const strict = opts.strict !== false;
  const periodKey = String(opts.periodKey || "").trim();          // "2026-06"
  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    const e = new Error("period_key_krävs_som_YYYY-MM"); e.status = 400; throw e;
  }
  const rows = parseCsv(csvText, { delimiter: sniffDelimiter(csvText) });
  const header = (rows[0] || []).map((h) => String(h || "").trim());
  const idx = (n) => header.indexOf(n);
  const NEED = ["Account1", "Account2", "Order1", "Order2", "Revenue1", "Cost1", "Hours1", "GrossMargin1"];
  const missing = NEED.filter((n) => idx(n) < 0);
  if (missing.length) {
    const e = new Error("intelliplan_unexpected_columns: saknar " + missing.join(", ") + " (fick: " + header.join(",") + ")");
    e.status = 502; throw e;
  }
  const i = Object.fromEntries(header.map((h, k) => [h, k]));
  const num = (v) => { const t = String(v == null ? "" : v).trim().replace(",", "."); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
  const txt = (v) => { const t = String(v == null ? "" : v).trim(); return t || null; };

  const out = [], warnings = [], seen = new Map(), accounts = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some((v) => String(v || "").trim() !== "")) continue;
    const orderId = num(row[i.Order1]);
    const accountId = num(row[i.Account1]);
    const key = periodKey + "|" + (orderId == null ? "none" : String(orderId));
    if (seen.has(key)) {
      const msg = `dubbel nyckel ${key} (rad ${seen.get(key)} och ${r}) — kornigheten är inte (period, order)`;
      if (strict) { const e = new Error("intelliplan_duplicate_key: " + msg); e.status = 502; throw e; }
      warnings.push({ row: r, reason: "duplicate_key", value: msg });
      continue;
    }
    seen.set(key, r);

    const accountName = txt(row[i.Account2]);
    if (accountId != null && !accounts.has(accountId)) accounts.set(accountId, accountName);

    out.push({
      key, period_key: periodKey,
      order_id: orderId, order_name: stripOrderPrefix(row[i.Order2], orderId), order_label: txt(row[i.Order2]),
      account_id: accountId, account_name: accountName,
      office_id: i.DeliveryOffice1 != null ? num(row[i.DeliveryOffice1]) : null,
      office: i.DeliveryOffice2 != null ? txt(row[i.DeliveryOffice2]) : null,
      salesperson_id: i.SalesPerson1 != null ? num(row[i.SalesPerson1]) : null,
      salesperson: i.SalesPerson2 != null ? txt(row[i.SalesPerson2]) : null,
      revenue: num(row[i.Revenue1]) || 0,
      cost: num(row[i.Cost1]) || 0,
      hours: num(row[i.Hours1]) || 0,
      gross_margin: num(row[i.GrossMargin1]) || 0,
      // Andel, inte procent — se kommentaren överst.
      gross_margin_ratio: i.GrossMarginPercentage1 != null ? num(row[i.GrossMarginPercentage1]) : null,
    });
  }

  const sum = (f) => Number(out.reduce((a, b) => a + (b[f] || 0), 0).toFixed(4));
  return {
    report_id: IP_ORDER_MONTH_REPORT, period_key: periodKey,
    rows: out, count: out.length,
    revenue_total: sum("revenue"), cost_total: sum("cost"), hours_total: sum("hours"),
    gross_margin_total: sum("gross_margin"),
    accounts: [...accounts.entries()].map(([id, name]) => ({ ip_account_id: id, ip_account_name: name }))
      .sort((a, b) => a.ip_account_id - b.ip_account_id),
    rows_without_order: out.filter((r) => r.order_id == null).length,
    warnings,
  };
}

// ── Namnmatchning Account → ClientCompany (förslag, aldrig automatik) ───────
// Bolagsformer och skiljetecken bort, gemener, kollapsade blanksteg. Så att
// "Gothia Towers AB" och "gothia-towers" hamnar på samma normalform.
const _CO_SUFFIX = /\b(ab|hb|kb|ekonomisk förening|ek för|handelsbolag|aktiebolag|publ|ltd|inc|as|oy)\b/g;
export function normalizeCompanyName(v) {
  return String(v == null ? "" : v).toLowerCase()
    .replace(/[.,()\/]/g, " ").replace(/[-–—]/g, " ")
    .replace(_CO_SUFFIX, " ")
    .replace(/\s+/g, " ").trim();
}

/**
 * Föreslår ClientCompany per Intelliplan-konto. Returnerar ALLTID förslag med
 * poäng — aldrig en automatisk koppling. En felaktig automatmatchning är dyrare
 * att upptäcka än en manuell bekräftelse är att göra.
 * companies: [{id, name}]
 */
export function suggestAccountMatches(accounts, companies, opts = {}) {
  const limit = opts.limit || 3;
  const norm = (companies || []).map((c) => ({ id: c.id, name: c.name, n: normalizeCompanyName(c.name) }))
    .filter((c) => c.n);
  const tokens = (s2) => new Set(String(s2).split(" ").filter((t) => t.length > 2));

  const raw = (s2) => String(s2 == null ? "" : s2);
  // Kontona är ANLÄGGNINGAR, inte bolag: "Gothia Towers - Heaven 23",
  // "Gothia Towers - Mässan", "Gothia Towers- Seasons" är fem konton hos samma
  // kund. Mappningen är därför många-till-en. Vi poängsätter både hela namnet
  // och prefixet före separatorn, så att enhetsnamnen hamnar rätt i förslagen.
  const prefixOf = (s2) => {
    const m = raw(s2).split(/\s*-\s+|\s+-\s*/)[0];   // " - " eller "- " / " -"
    return m && m !== raw(s2) ? m : "";
  };
  const scoreOne = (an, at, c) => {
    if (!an) return 0;
    if (c.n === an) return 1;
    if (c.n.startsWith(an) || an.startsWith(c.n)) return 0.85;
    const ct = tokens(c.n);
    const inter = [...at].filter((t) => ct.has(t)).length;
    const uni = new Set([...at, ...ct]).size;
    return uni ? inter / uni : 0;
  };

  return (accounts || []).map((a) => {
    const an = normalizeCompanyName(a.ip_account_name);
    const at = tokens(an);
    const pn = normalizeCompanyName(prefixOf(a.ip_account_name));
    const pt = tokens(pn);

    let exactFull = false;
    const scored = norm.map((c) => {
      const full = scoreOne(an, at, c);
      // Prefixträff väger tungt men NÅGOT mindre än hela namnet — den säger
      // "kontot hör till den kundens grupp", inte "kontot ÄR kunden".
      const pre = pn ? scoreOne(pn, pt, c) * 0.95 : 0;
      const score = Math.max(full, pre);
      if (full === 1) exactFull = true;
      return { client_company_id: c.id, name: c.name, score: Number(score.toFixed(3)),
               via: pre > full ? "prefix" : "namn" };
    }).filter((x) => x.score > 0.3).sort((a2, b) => b.score - a2.score).slice(0, limit);

    return {
      ip_account_id: a.ip_account_id, ip_account_name: a.ip_account_name,
      suggestions: scored,
      // ⚠️ `confident` kräver att HELA namnet matchar exakt — en prefixträff
      // föreslås men kopplas aldrig automatiskt. "Gothia Towers - Heaven 23" är
      // sannolikt Gothia Towers, men det ska en människa få säga.
      confident: exactFull && scored.length > 0 && scored[0].score === 1 && scored[0].via === "namn"
                 && (scored.length === 1 || scored[1].score < 0.9),
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// MALL-SPANING — hitta rapporten med pass/schema-kornighet
// ────────────────────────────────────────────────────────────────────────────
//
// ⚠️ Intelliplan har INGEN endpoint som listar mallar (verifierat 2026-08-19:
// åtta kandidatvägar, alla 404 — inte 401/403, alltså finns vägarna inte).
// Id:n står inte heller i deras UI på ett sätt Christian hittar.
//
// MEN: vi vet att Carotte har 23 mallar i intervallet 1027–1080. Det är 54
// kandidater. Tidigare noterat "blind skanning är meningslös" gällde hela
// heltalsrymden — med känt intervall är det tvärtom den enda vägen.
//
// Ett existerande id svarar 200 med en rubrikrad. Ett obefintligt svarar 503
// med "Could not find GridReportTemplateDto" (Intelliplans felinpackning —
// tolka det INTE som att tjänsten är nere).
//
// ⚠️ PERSONDATA: skanningen läser BARA kolumnnamn, aldrig rader. Rapporterna
// bär konsultnamn och lönekostnader (1063). `describeReportPayload` utan
// `sample` utelämnar dataraderna — den grinden får aldrig öppnas i en skanning.

const _norm = (s) => String(s || "").toLowerCase();

// Vad en pass-/schemarapport MÅSTE innehålla för att vara användbar:
// datum, tid, vem, och för vilken kund.
const SCHEMA_SIGNALER = {
  datum:   [/^date/, /datum/, /day/, /week/, /vecka/],
  tid:     [/time/, /start/, /end/, /slut/, /from/, /^to$/, /hour(?!s\d)/, /klock/, /pass/, /shift/],
  konsult: [/consultant/, /employee/, /konsult/, /resource/, /person/, /staff/],
  kund:    [/account/, /customer/, /client/, /kund/, /order/],
};

/**
 * Poängsätter en rapports kolumnlista mot pass/schema-behovet.
 * Ren funktion — ingen I/O, inga rader, bara namn.
 *
 * ⚠️ `hours` (summa timmar) är INTE tidsupplösning. 1058 har `Hours1` men är
 * order×månad. Därför kräver `kandidat` att BÅDE datum och tid finns — annars
 * skulle varje intäktsrapport se ut som ett schema.
 */
export function scoreScheduleColumns(columns) {
  const cols = (columns || []).map(_norm);
  // ⚠️ INGA KOLUMNER = OBEDÖMBAR, INTE FÖRKASTAD.
  // Skarpt 2026-08-20 svarade 14 av 53 mallar 200 OK men utan rubrikrad — troligen
  // för att sonderingsdagen saknade data. De rapporterades som "hittad, score 0,
  // saknar datumkolumn", alltså precis som en mall vi FAKTISKT bedömt och
  // förkastat. En av dem kan vara schemarapporten. Slutsatsen "ingen mall har
  // datum + tid" blir osann om 14 aldrig lästes.
  if (!cols.length) {
    return { score: 0, traffar: { datum: [], tid: [], konsult: [], kund: [] },
      kandidat: false, bedombar: false, kolumner_totalt: 0,
      varfor: "⚠️ OBEDÖMBAR — svarade utan rubrikrad (troligen ingen data på sonderingsdagen). Kör om med ett bredare datumfönster innan du drar slutsatser." };
  }
  const traffar = {};
  for (const [nyckel, monster] of Object.entries(SCHEMA_SIGNALER)) {
    traffar[nyckel] = (columns || []).filter((c) => monster.some((m) => m.test(_norm(c))));
  }
  const har = (k) => traffar[k].length > 0;
  const score = ["datum", "tid", "konsult", "kund"].filter(har).length;
  return {
    score,
    traffar,
    bedombar: true,
    // Datum UTAN tid = dagsrapport (t.ex. 1081), inte ett schema.
    kandidat: har("datum") && har("tid") && har("konsult"),
    varfor: !har("datum") ? "saknar datumkolumn"
      : !har("tid") ? "har datum men ingen tid — dagsrapport, inte pass"
      : !har("konsult") ? "har datum+tid men ingen konsult/person"
      : !har("kund") ? "⭐ datum+tid+konsult finns men ingen tydlig kundkolumn — titta ändå"
      : "⭐⭐ datum + tid + konsult + kund — starkaste kandidaten",
    kolumner_totalt: cols.length,
  };
}

/** Är felet "mallen finns inte" (503) eller något annat? Avgör om id:t är tomt. */
export function malFinnsInte(err) {
  const body = String((err && (err.body || err.detail)) || "");
  return /Could not find GridReportTemplateDto/i.test(body);
}

// ────────────────────────────────────────────────────────────────────────────
// NORMALISERARE — rapport 1082 "mira-pass-1": PASS per konsult, kund och dag
// ────────────────────────────────────────────────────────────────────────────
//
// Byggd av Christian 2026-08-20 i Intelliplans Reporting-vy. Kolumner
// verifierade mot skarp CSV (juli 2026: 3 420 rader).
//
// ⚠️ TRE RADTYPER, bevisade ur datan — de överlappar ALDRIG:
//
//   pass      1 202 rader  har WorkdayBookedFrom/ToTime · bara PlacementHours
//   installt  1 146 rader  BARA LostHours, ingen tid
//   franvaro  1 072 rader  PlacementHours + AbsenceHours, ingen tid
//
// Därför är `PlacementHours` SCHEMALAGD tid, inte arbetad: totalen 17 663 =
// 9 267 (utfört) + 8 396 (frånvarande men schemalagt). Att summera den som
// "arbetade timmar" vore fel med nästan en faktor två.
//
// ⚠️ KLOCKTID ≠ TIMMAR. (slut − start) − PlacementHours = RAST:
// 1,0 h på 704 pass · 0,5 h på 163 · 0 h på 272. Kalenderblocket är
// start→slut (inkl rast), betald tid är PlacementHours. **Försök aldrig
// härleda det ena ur det andra** — de mäter olika saker.
//
// ⚠️ 36 pass passerar midnatt (slut < start) → slutdatum +1 dygn.
//
// ⚠️ PunchIn/PunchOutTimeRounded var 0 av 3 420 ifyllda — stämpelklocka
// används inte. Faktisk kontra bokad tid går alltså INTE att visa.
export const IP_PASS_REPORT = 1082;

const _t2min = (t) => {
  const p = String(t || "").trim().replace(".", ":").split(":");
  if (p.length < 2) return null;
  const h = Number(p[0]), m = Number(p[1]);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const _isoAt = (dateIso, minutes) => {
  const base = Date.parse(dateIso + "T00:00:00.000Z");
  if (!Number.isFinite(base) || minutes == null) return null;
  return new Date(base + minutes * 60000).toISOString();
};

/** Radtyp ur måtten. Ren funktion — testbar utan CSV. */
export function passRadtyp({ harTid, placement, lost, absence }) {
  if (harTid) return "pass";
  if (lost != null && placement == null && absence == null) return "installt";
  if (absence != null) return "franvaro";
  return "okand";
}

export function normalizePass(csvText, opts = {}) {
  const strict = opts.strict !== false;
  const rows = parseCsv(csvText, { delimiter: sniffDelimiter(csvText) });
  const header = (rows[0] || []).map((h) => String(h || "").trim());
  const i = Object.fromEntries(header.map((h, n) => [h, n]));

  // Ändrar någon mallens kolumner ska synken STANNA, inte tyst lagra nollor.
  const NEED = ["Date2", "Consultant2", "ConsultantNo1", "Account1", "Account2",
    "FinancialItemId1", "OrderNo1", "WorkdayBookedFromTime1", "WorkdayBookedToTime1",
    "PlacementHours1", "LostHours1", "AbsenceHours1"];
  const missing = NEED.filter((n) => i[n] == null);
  if (missing.length) {
    const e = new Error("intelliplan_unexpected_columns: saknar " + missing.join(", ") + " (fick: " + header.join(",") + ")");
    e.status = 502; throw e;
  }

  const num = (v) => { const s2 = String(v == null ? "" : v).trim().replace(",", "."); if (!s2) return null; const n = Number(s2); return Number.isFinite(n) ? n : null; };
  const txt = (v) => String(v == null ? "" : v).trim();
  const out = [], warnings = [], seen = new Map();
  const typer = { pass: 0, installt: 0, franvaro: 0, okand: 0 };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some((v) => String(v || "").trim() !== "")) continue;

    const iso = txt(row[i.Date2]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) { warnings.push({ row: r, reason: "ogiltigt_datum", value: iso.slice(0, 20) }); continue; }

    const itemId = num(row[i.FinancialItemId1]);
    if (itemId == null) { warnings.push({ row: r, reason: "saknar_FinancialItemId" }); continue; }
    const key = String(itemId);
    // ⚠️ FinancialItemId var 3 420 distinkta av 3 420 rader. Dubbletter betyder
    // att kornighetsantagandet inte håller — det ska aldrig tystas.
    if (seen.has(key)) {
      const msg = `dubbel nyckel ${key} (rad ${seen.get(key)} och ${r})`;
      if (strict) { const e = new Error("intelliplan_duplicate_key: " + msg); e.status = 502; throw e; }
      warnings.push({ row: r, reason: "duplicate_key", value: msg }); continue;
    }
    seen.set(key, r);

    const fromMin = _t2min(row[i.WorkdayBookedFromTime1]);
    const toMinRaw = _t2min(row[i.WorkdayBookedToTime1]);
    const harTid = fromMin != null && toMinRaw != null;
    const placement = num(row[i.PlacementHours1]);
    const lost = num(row[i.LostHours1]);
    const absence = num(row[i.AbsenceHours1]);
    const typ = passRadtyp({ harTid, placement, lost, absence });
    typer[typ] = (typer[typ] || 0) + 1;
    if (typ === "okand") warnings.push({ row: r, reason: "okand_radtyp", value: key });

    // Midnattspassering: slut före start ⇒ nästa dygn.
    let toMin = toMinRaw, passerarMidnatt = false;
    if (harTid && toMinRaw <= fromMin) { toMin = toMinRaw + 1440; passerarMidnatt = true; }

    const start = harTid ? _isoAt(iso, fromMin) : _isoAt(iso, 0);
    const slut = harTid ? _isoAt(iso, toMin) : _isoAt(iso, 1439);

    // Klocktid minus betald tid = rast. Negativt = något stämmer inte (37 rader
    // i juli) — varna, blockera inte; det är data vi inte äger.
    let rast = null;
    if (harTid && placement != null) {
      rast = Number((((toMin - fromMin) / 60) - placement).toFixed(2));
      if (rast < 0) warnings.push({ row: r, reason: "negativ_rast", value: `${key}: klocktid ${(toMin - fromMin) / 60} h < PlacementHours ${placement}` });
    }

    out.push({
      key, typ, date: iso,
      start, slut, passerar_midnatt: passerarMidnatt,
      consultant_no: num(row[i.ConsultantNo1]),
      consultant: txt(row[i.Consultant2]),
      account_id: num(row[i.Account1]),
      account: txt(row[i.Account2]),
      order_no: txt(row[i.OrderNo1]),
      order_desc: i.OrderDescription1 != null ? txt(row[i.OrderDescription1]) : "",
      note: i.FinancialItemNote1 != null ? txt(row[i.FinancialItemNote1]) : "",
      placement_hours: placement, lost_hours: lost, absence_hours: absence,
      rast_hours: rast,
    });
  }

  const sum = (f) => Number(out.reduce((a, b) => a + (f(b) || 0), 0).toFixed(2));
  return {
    report_id: IP_PASS_REPORT, rows: out, count: out.length, typer, warnings,
    // Redovisa BÅDA — schemalagt och faktiskt utfört. Att bara visa den ena
    // vore missvisande, och det är hela poängen med radtyperna.
    placement_total: sum((r) => r.placement_hours),
    // ⚠️ HETTE `utfort_total` — MISSVISANDE FÖR FRAMTIDA PERIODER.
    // Måttet är summan av PlacementHours på rader som ÄR pass (har bokad tid).
    // För en passerad period ≈ utförd tid. För en FRAMTIDA period är det
    // BOKAD tid — inget är utfört än. Skarpt 2026-08-20 gav fönstret
    // 21 aug–31 okt 25 468 h, som med det gamla namnet hade lästs som utfört
    // arbete i en period som inte hänt. Samma klass av fel som att kalla
    // PlacementHours "arbetade timmar".
    pass_timmar_total: Number(out.filter((r) => r.typ === "pass").reduce((a, b) => a + (b.placement_hours || 0), 0).toFixed(2)),
    lost_total: sum((r) => r.lost_hours),
    absence_total: sum((r) => r.absence_hours),
    dates: [...new Set(out.map((r) => r.date))].sort(),
    consultants: new Set(out.map((r) => r.consultant_no)).size,
    accounts: [...new Set(out.map((r) => r.account_id).filter((x) => x != null))].sort((a, b) => a - b),
  };
}
