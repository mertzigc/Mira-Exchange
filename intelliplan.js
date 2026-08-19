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
      e.status = res.status; e.body = text.slice(0, 1000); e.url = url;
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

  return { config, ensureAccessToken, tokenInfo, request, getGridReport,
           _cookies, _reset: () => { _tok = { token: null, expiresAt: 0, scope: null }; _cookies.clear(); } };
}

/**
 * Rekognosering: beskriv ett okänt svar utan att dumpa allt.
 * Guiden säger ingenting om svarsformatet, så steg 2 handlar om att ta reda på
 * det — form, storlek, kolumnnamn — innan vi designar någon datamodell.
 */
export function describeReportPayload(result) {
  const out = { parsed: !!(result && result.parsed), content_type: (result && result.content_type) || null,
                bytes: result && result.raw ? Buffer.byteLength(result.raw, "utf8") : 0 };
  const d = result && result.data;
  if (!result || !result.parsed || d == null) {
    out.shape = "raw";
    out.preview = result && result.raw ? String(result.raw).slice(0, 800) : null;
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
    out.first_row = first ? JSON.parse(JSON.stringify(first)) : (rows.length ? rows[0] : null);
  } else if (typeof d === "object") {
    out.shape = "object";
    out.top_level_keys = Object.keys(d).slice(0, 40);
    out.preview = JSON.stringify(d).slice(0, 800);
  } else {
    out.shape = typeof d;
    out.preview = String(d).slice(0, 400);
  }
  return out;
}
