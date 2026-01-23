import express from "express";
import cors from "cors";
import crypto from "node:crypto";

// ────────────────────────────────────────────────────────────
// .env lokalt (Render injicerar env i production)
if (process.env.NODE_ENV !== "production") {
  try {
    const { config } = await import("dotenv");
    config();
  } catch (e) {
    console.warn("[dotenv] not loaded (dev only):", e?.message || e);
  }
}

// ────────────────────────────────────────────────────────────
// App & JSON
const app = express();
app.use(express.json({ type: ["application/json", "application/*+json"] }));
app.use(cors());

// ────────────────────────────────────────────────────────────
// ENV resolution (stöd båda namnscheman och smart redirect)
const pick = (...vals) => vals.find(v => !!v && String(v).trim()) || null;

const NODE_ENV       = process.env.NODE_ENV || "production";
const BUBBLE_API_KEY =
  pick(process.env.BUBBLE_API_KEY, process.env.MIRAGPT_API_KEY);

const CLIENT_ID =
  pick(process.env.MS_CLIENT_ID, process.env.MS_APP_CLIENT_ID);
const CLIENT_SECRET =
  pick(process.env.MS_CLIENT_SECRET, process.env.MS_APP_CLIENT_SECRET);

// Välj redirect i ordning: explicit → live i prod → dev → live (fallback)
const REDIRECT_URI = pick(
  process.env.MS_REDIRECT_URI,
  NODE_ENV === "production" ? process.env.MS_REDIRECT_LIVE : null,
  process.env.MS_REDIRECT_DEV,
  process.env.MS_REDIRECT_LIVE
);

const MS_SCOPE  = pick(
  process.env.MS_SCOPE,
  "User.Read Calendars.ReadWrite Mail.Read Mail.Read.Shared offline_access openid profile email"
);
const MS_TENANT = pick(process.env.MS_TENANT, "common");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PORT       = process.env.PORT || 10000;

// ────────────────────────────────────────────────────────────
// Render API key guard (Bubble -> Render)
const RENDER_API_KEY =
  pick(process.env.MIRA_RENDER_API_KEY, process.env.MIRA_EXCHANGE_API_KEY);

// Fortnox envs
const FORTNOX_CLIENT_ID     = process.env.FORTNOX_CLIENT_ID;
const FORTNOX_CLIENT_SECRET = process.env.FORTNOX_CLIENT_SECRET;

// Rekommenderat när Render hanterar allt:
// - Sätt i Render: FORTNOX_REDIRECT_URI=https://mira-exchange.onrender.com/fortnox/callback
// - Om env saknas: fallback till den gamla
const FORTNOX_REDIRECT_URI  =
  process.env.FORTNOX_REDIRECT_URI || "https://api.mira-fm.com/fortnox/callback";

// Bubble: spara till MIRA först, sen version-test
const BUBBLE_BASES = [
  "https://mira-fm.com/version-test",
];
console.log("[BOOT] BUBBLE_BASES =", BUBBLE_BASES);
console.log("[BOOT] INDEX_FINGERPRINT = 2025-12-21_15:40_v1");

const BASE_URL =
  pick(process.env.BASE_URL, process.env.BUBBLE_BASE_URL) ||
  (Array.isArray(BUBBLE_BASES) && BUBBLE_BASES[0]) ||
  null;

const BUBBLE_BASE_URL = BASE_URL; // ✅ BACKWARD COMPAT

if (!BASE_URL) {
  console.warn("[BOOT] No BASE_URL resolved. endpoints will fail.");
}
if (!BUBBLE_API_KEY) {
  console.warn("[BOOT] No BUBBLE_API_KEY resolved. Bubble calls will fail.");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Helpers ────────────────────────────────────────────────────────────
function decodeHtmlEntities(s = "") {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtmlToText(html = "") {
  let s = String(html);

  // Byt vanliga radbrytare till \n innan vi strippar taggar
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<\/td>/gi, " ");
  s = s.replace(/<\/div>/gi, "\n");

  // Ta bort head/style/script helt
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Strip alla resterande taggar
  s = s.replace(/<[^>]+>/g, "");

  // Decode entities + städa whitespace
  s = decodeHtmlEntities(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

// Plocka "bästa" body-texten från Graph message
function getMessageBodyText(msg) {
  const ct = String(msg?.body?.contentType || "").toLowerCase();
  const content = msg?.body?.content || "";
  if (content) {
    return ct === "html" ? stripHtmlToText(content) : String(content).trim();
  }
  return String(msg?.bodyPreview || "").trim();
}
// Helpers
const log = (msg, data) =>
  console.log(msg, data ? JSON.stringify(data, null, 2) : "");

// "YYYY-MM-DD HH:mm[:ss]" → "YYYY-MM-DDTHH:mm:ss"
const fixDateTime = (s) => {
  if (!s) return s;
  let v = String(s).trim();
  v = v.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(:\d{2})?)$/, "$1T$2");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v += ":00";
  return v;
};

function toGraphDateTime(local) {
  if (!local) return null;
  const s = String(local).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s + ":00";
  return s;
}

// IANA → Windows time zone (vanliga fall)
const IANA_TO_WINDOWS_TZ = {
  "Europe/Stockholm": "W. Europe Standard Time",
  "Europe/Paris": "Romance Standard Time",
  "Europe/Berlin": "W. Europe Standard Time",
  "Europe/Amsterdam": "W. Europe Standard Time",
  "Europe/Madrid": "Romance Standard Time",
  "Europe/London": "GMT Standard Time",
  "UTC": "UTC",
  "Etc/UTC": "UTC"
};
function toWindowsTz(tz) {
  if (!tz) return "W. Europe Standard Time";
  const t = String(tz).trim();
  if (/Standard Time$/i.test(t)) return t;
  return IANA_TO_WINDOWS_TZ[t] || "W. Europe Standard Time";
}

// Safe helpers (utan template literals)
const mask = (v) => {
  if (!v) return null;
  const s = String(v);
  return s.slice(0, 3) + "..." + s.slice(-3);
};
const sha  = (v) => {
  if (!v) return null;
  const h = crypto.createHash("sha256").update(String(v)).digest("hex");
  return h.slice(0, 16) + "…";
};

// ────────────────────────────────────────────────────────────
// Helper: normalizeRedirect – cleans up double slashes like "//ms_consent_callback"
function normalizeRedirect(u) {
  try {
    const url = new URL(u);
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return u;
  }
}
// ────────────────────────────────────────────────────────────
// HTML-escape helper (för att säkert kunna skriva värden i en liten callback-HTML)
function escapeHtml(input = "") {
  const s = String(input);
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#x60;"
  };
  return s.replace(/[&<>"'`]/g, (ch) => map[ch] || ch);
}
// ────────────────────────────────────────────────────────────
// API key guard – allow health + OAuth redirect/callback endpoints without key
function requireApiKey(req, res, next) {
  // Exakta paths (utan querystring)
  const openPaths = new Set([
    "/health",

    // Fortnox OAuth
    "/fortnox/authorize",
    "/fortnox/callback",

    // Microsoft OAuth (browser hits these WITHOUT x-api-key)
    "/ms/authorize",
    "/ms/callback",
  ]);

  // Tillåt även om du råkar lägga under-routes senare (bra säkerhetsmarginal)
  const openPrefixes = [
    // ex: om du senare lägger /ms/callback/...
  ];

  if (openPaths.has(req.path) || openPrefixes.some(p => req.path.startsWith(p))) {
    return next();
  }

  if (!RENDER_API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "Missing MIRA_RENDER_API_KEY on server" });
  }

  const key = req.headers["x-api-key"];
  if (!key || String(key).trim() !== String(RENDER_API_KEY).trim()) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad x-api-key)" });
  }

  return next();
}

app.use(requireApiKey);
// ────────────────────────────────────────────────────────────
// Bubble helpers (User + Data API)
async function fetchBubbleUser(user_unique_id) {
  const variants = [
    ...BUBBLE_BASES.map(b => b + "/api/1.1/obj/user/" + user_unique_id)
  ];
  for (const url of variants) {
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + BUBBLE_API_KEY } });
      const j = await r.json().catch(() => ({}));
      if (j && j.response) return j.response;
    } catch {}
  }
  return null;
}

async function upsertTokensToBubble(user_unique_id, tokenJson, fallbackRefresh) {
  const refresh = tokenJson.refresh_token || fallbackRefresh || null;
  const expiresIn = Number(tokenJson.expires_in || 0);
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  const patchPayload = {
    ms_access_token: tokenJson.access_token || null,
    ms_refresh_token: refresh,
    ms_scope: tokenJson.scope || "",
    ms_token_type: tokenJson.token_type || "Bearer",
    ms_expires_at: expiresAt,
    ms_last_refresh_at: new Date().toISOString(),};

  // 1) Primary: Data API patch user (Fortnox-lik metodik)
  try {
    const patched = await bubblePatch("user", user_unique_id, patchPayload);
    log("[save] user patch OK", { user_unique_id, patched: !!patched });
    return { ok: true, method: "data_api_patch" };
  } catch (e) {
    log("[save] user patch FAILED", {
      user_unique_id,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }

  // 2) Fallback: WF ms_token_upsert (din befintliga väg)
  const wfPayload = {
    bubble_user_id: user_unique_id,
    access_token: tokenJson.access_token,
    refresh_token: refresh,
    expires_in: tokenJson.expires_in,
    token_type: tokenJson.token_type,
    scope: tokenJson.scope,
    server_now_iso: new Date().toISOString(),
  };

  for (const base of BUBBLE_BASES) {
    const wf = base + "/api/1.1/wf/ms_token_upsert";
    try {
      const r = await fetch(wf, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY,
        },
        body: JSON.stringify(wfPayload),
      });

      const text = await r.text().catch(() => "");
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }

      log("[save] try WF", { base, status: r.status, ok: r.ok, body });

      if (r.ok) return { ok: true, method: "wf_ms_token_upsert", base };
    } catch (e) {
      log("[save] WF error", { base, e: e?.message || String(e), detail: e?.detail || null });
    }
  }

  return { ok: false, method: "none" };
}
async function tokenExchange({ code, refresh_token, scope, tenant, redirect_uri }) {
  const tokenEndpoint = "https://login.microsoftonline.com/" + (tenant || MS_TENANT) + "/oauth2/v2.0/token";
  const form = new URLSearchParams();
  form.set("client_id", CLIENT_ID);
  form.set("client_secret", CLIENT_SECRET);
  if (code) {
    form.set("grant_type", "authorization_code");
    form.set("code", code);
  } else if (refresh_token) {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refresh_token);
  } else {
    throw new Error("Missing code or refresh_token");
  }
  form.set("redirect_uri", redirect_uri || REDIRECT_URI);
  form.set("scope", scope || MS_SCOPE);

  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.access_token, status: r.status, data: j };
}
// ────────────────────────────────────────────────────────────
// Delegated MS token helpers (for Mail polling)
// We store tokens on Bubble User (same as your calendar delegated flow)

async function getDelegatedTokenForUser(user_unique_id, { tenant = null, scope = null } = {}) {
  if (!user_unique_id) throw new Error("Missing user_unique_id for delegated token");

  const u = await fetchBubbleUser(user_unique_id);
  if (!u) throw new Error("Bubble user not found: " + user_unique_id);

  // Support both naming schemes (your create-event reads ms_access_token/ms_refresh_token)
  let accessToken =
    u?.ms_access_token ||
    u?.access_token ||
    null;

  let refreshToken =
    u?.ms_refresh_token ||
    u?.refresh_token ||
    null;

  const dbScope =
    u?.ms_scope ||
    u?.scope ||
    null;

  // If no access token, try refresh
  if (!accessToken && refreshToken) {
    const ref = await tokenExchange({
      refresh_token: refreshToken,
      scope: scope || dbScope || MS_SCOPE,
      tenant: tenant || MS_TENANT
    });

    if (ref.ok) {
      accessToken = ref.data.access_token;
      const newRefresh = ref.data.refresh_token || refreshToken;

      // Persist back to Bubble (your WF maps this to ms_access_token etc)
      await upsertTokensToBubble(user_unique_id, ref.data, newRefresh);
      refreshToken = newRefresh;
    }
  }


  // If access token exists but is expired (JWT exp), refresh it
  if (accessToken && refreshToken && isJwtExpired(accessToken)) {
    const ref = await tokenExchange({
      refresh_token: refreshToken,
      scope: scope || dbScope || MS_SCOPE,
      tenant: tenant || MS_TENANT
    });

    if (ref.ok) {
      accessToken = ref.data.access_token;
      const newRefresh = ref.data.refresh_token || refreshToken;
      await upsertTokensToBubble(user_unique_id, ref.data, newRefresh);
      refreshToken = newRefresh;
    }
  }

  // If we have access token but want to be safer, you can still refresh on demand later.
  if (!accessToken) {
    throw new Error("No delegated ms_access_token available (and refresh missing/failed) for user: " + user_unique_id);
  }

  return { access_token: accessToken, refresh_token: refreshToken, scope: dbScope || scope || null };
}

// JWT helpers (to refresh delegated tokens proactively)
function _b64urlToStr(b64url) {
  try {
    const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
    const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function jwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const json = _b64urlToStr(parts[1]);
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function isJwtExpired(token, skewSeconds = 60) {
  const p = jwtPayload(token);
  const exp = Number(p?.exp || 0);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return (exp - skewSeconds) <= now;
}
// ────────────────────────────────────────────────────────────
// Helpers (deklarera EN gång)
const asTextOrEmpty = (v) => (v === undefined || v === null) ? "" : String(v);

// Telefon/orgnr: plocka siffror ur sträng (+46, mellanslag, bindestreck osv)
const asNumberOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;

  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;

  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
};

// ────────────────────────────────────────────────────────────
// Bubble Data API helpers (object-CRUD)
async function bubbleFind(typeName, { constraints = [], limit = 1, cursor = 0, sort_field = null, descending = false } = {}) {
  const qs = new URLSearchParams();
  if (limit != null) qs.set("limit", String(limit));
  if (cursor != null) qs.set("cursor", String(cursor));
  if (sort_field) qs.set("sort_field", String(sort_field));
  if (descending) qs.set("descending", "true");

  if (constraints && constraints.length) {
    qs.set("constraints", JSON.stringify(
      constraints.map(c => ({
        key: c.key,
        constraint_type: c.constraint_type || "equals",
        value: c.value
      }))
    ));
  }

  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}?${qs.toString()}`;
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + BUBBLE_API_KEY } });
      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        lastErr = { base, status: r.status, body: j, url };
        continue;
      }
      return Array.isArray(j?.response?.results) ? j.response.results : [];
    } catch (e) {
      lastErr = { base, error: String(e?.message || e), url };
    }
  }

  const err = new Error("bubbleFind failed");
  err.detail = lastErr;
  throw err;
}

async function bubbleFindAll(typeName, { constraints = [], sort_field = null, descending = false } = {}) {
  const out = [];
  let cursor = 0;
  const limit = 100;

  while (true) {
    const batch = await bubbleFind(typeName, { constraints, limit, cursor, sort_field, descending });
    out.push(...batch);
    if (batch.length < limit) break;
    cursor += limit;
  }
  return out;
}

async function bubbleFindOne(type, constraints) {
  const arr = await bubbleFind(type, {
    constraints: Array.isArray(constraints) ? constraints : [],
    limit: 1
  });
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

// ────────────────────────────────────────────────────────────
// Skapa (eller hitta) ClientCompany baserat på orgnr (primärt)
// + sätter/patchar ft_customer_number (number) från Fortnox CustomerNumber
async function ensureClientCompanyForFortnoxCustomer(cust) {
  const orgNo = asTextOrEmpty(
    cust?.OrganisationNumber || cust?.organisation_number || cust?.organisationNumber
  ).trim();

  if (!orgNo) return null;

  const customerNoText = asTextOrEmpty(
    cust?.CustomerNumber || cust?.customer_number || cust?.customerNumber
  ).trim();

  const customerNoNum = asNumberOrNull(customerNoText);

  const name  = asTextOrEmpty(cust?.Name || cust?.name).trim();
  const email = asTextOrEmpty(cust?.Email || cust?.email).trim();
  const phone = cust?.Phone || cust?.phone;

  // 1) hitta befintligt ClientCompany på Org_Number
  const existing = await bubbleFindOne("ClientCompany", [
    { key: "Org_Number", constraint_type: "equals", value: orgNo }
  ]);

  if (existing?._id) {
    // Patcha bara om fält saknas (så vi inte skriver över manuellt CRM-data)
    const patch = {};

    if (customerNoNum !== null && (existing.ft_customer_number === undefined || existing.ft_customer_number === null)) {
      patch.ft_customer_number = customerNoNum;
    }

    if (name && !existing.Name_company) patch.Name_company = name;
    if (email && !existing.Email) patch.Email = email;

    const phoneNum = asNumberOrNull(phone);
    if (phoneNum !== null && (existing.Telefon === undefined || existing.Telefon === null)) {
      patch.Telefon = phoneNum;
    }

    if (Object.keys(patch).length) {
      await bubblePatch("ClientCompany", existing._id, patch);
    }

    return existing._id;
  }

  // 2) skapa nytt ClientCompany
  const ccFields = {
    Name_company: name || orgNo,
    Org_Number: orgNo
  };

  if (email) ccFields.Email = email;

  const phoneNum = asNumberOrNull(phone);
  if (phoneNum !== null) ccFields.Telefon = phoneNum;

  if (customerNoNum !== null) ccFields.ft_customer_number = customerNoNum;

  const ccId = await bubbleCreate("ClientCompany", ccFields);
  return ccId || null;
}
// ────────────────────────────────────────────────────────────
// B) Fetch all FortnoxConnections (version-test)
async function getAllFortnoxConnections() {
  const results = await bubbleFind("FortnoxConnection", {
    constraints: [],
    limit: 1000
  });

  // säker filtrering
  return (Array.isArray(results) ? results : []).filter(c =>
    c?._id &&
    c?.access_token &&
    c?.is_active !== false
  );
}
async function bubbleGet(typeName, id) {
  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}/${id}`;
    try {
      const r = await fetch(url, {
        headers: { Authorization: "Bearer " + BUBBLE_API_KEY }
      });
      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        lastErr = { base, status: r.status, body: j };
        continue;
      }
      return j?.response || null;
    } catch (e) {
      lastErr = { base, error: String(e?.message || e) };
    }
  }

  const err = new Error("bubbleGet failed");
  err.detail = lastErr;
  throw err;
}

async function bubbleCreate(typeName, payload) {
  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY
        },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        lastErr = { base, status: r.status, body: j };
        continue;
      }
      return j?.id || j?.response?.id || null;
    } catch (e) {
      lastErr = { base, error: String(e?.message || e) };
    }
  }

  const err = new Error("bubbleCreate failed");
  err.detail = lastErr;
  throw err;
}

async function bubblePatch(typeName, id, payload) {
  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}/${id}`;
    try {
      const r = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY
        },
        body: JSON.stringify(payload)
      });

      // Bubble PATCH ger ofta 204 utan body
      if (r.status === 204) return true;

      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = { base, status: r.status, body: j };
        continue;
      }
      return true;
    } catch (e) {
      lastErr = { base, error: String(e?.message || e) };
    }
  }
  // Om vi kommer hit: alla BUBBLE_BASES misslyckades
  console.error("[bubblePatch] failed across all bases", lastErr);

  const err = new Error("bubblePatch failed");
  err.detail = lastErr;
  throw err;
}
// ────────────────────────────────────────────────────────────
// Fortnox helpers (legacy token upsert to User – kept for compatibility)
async function fortnoxTokenExchange(code) {
  if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET || !FORTNOX_REDIRECT_URI) {
    throw new Error("Fortnox env saknas (client_id/secret/redirect_uri)");
  }

  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", FORTNOX_CLIENT_ID);
  form.set("client_secret", FORTNOX_CLIENT_SECRET);
  form.set("code", code);
  form.set("redirect_uri", FORTNOX_REDIRECT_URI);

  const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const j = await r.json().catch(() => ({}));

  return {
    ok: r.ok && !!j.access_token,
    status: r.status,
    data: j,
  };
}

async function upsertFortnoxTokensToBubble(bubble_user_id, tokenJson) {
  const payload = {
    // Keys that exist in your Bubble type TengellaWorkorder (per your screenshot)
    workorder_id,
    workorder_no: workOrder?.WorkOrderNo ?? "",
    customer_id: Number(workOrder?.CustomerId ?? 0) || null,
    project_id: Number(workOrder?.ProjectId ?? 0) || null,

    description: workOrder?.WorkOrderDescription ?? "",
    internal_note: workOrder?.InternalNote ?? "",
    is_deleted: normalizeBool(workOrder?.IsDeleted),
    order_date: toBubbleDate(workOrder?.OrderDate),
    work_address_id: Number(workOrder?.WorkAddressId ?? 0) || null,

    // Optional: if you pass these in request body AND you have these fields in Bubble type
    company: bubbleCompanyId ?? null,
    commission: bubbleCommissionId ?? null,
    parsed_commission_uid: parsedCommissionUid ?? ""
  };

  for (const base of BUBBLE_BASES) {
    try {
      const wf = base + "/api/1.1/wf/fortnox_token_upsert";
      const r = await fetch(wf, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY,
        },
        body: JSON.stringify(payload),
      });
      const ok = r.ok;
      log("[fortnox_save] WF", { base, status: r.status, ok });
      if (ok) return true;
    } catch (e) {
      log("[fortnox_save] WF error", { base, e: String(e) });
    }
  }
  return false;
}
const numOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Hämtar FortnoxConnection och plockar en next_page-nyckel (fallback=1)
async function getConnNextPage(connectionId, key, fallback = 1) {
  const conn = await bubbleGet("FortnoxConnection", connectionId);
  const v = Number(conn?.[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Sätter paging-fält på FortnoxConnection (men krascha inte hela run om fält saknas)
async function safeSetConnPaging(connectionId, patchObj) {
  try {
    await bubblePatch("FortnoxConnection", connectionId, patchObj);
    return true;
  } catch (e) {
    console.warn("[nightly] safeSetConnPaging failed (ignored)", {
      connectionId,
      patchObj,
      err: e?.message || String(e),
      detail: e?.detail || null
    });
    return false;
  }
}
// POST internt med timeout
async function postInternalJson(path, payload, timeoutMs = 180000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${SELF_BASE_URL}${path}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      const err = new Error(`internal call failed: ${path}`);
      err.detail = { path, status: r.status, body: j };
      throw err;
    }
    return j;
  } finally {
    clearTimeout(t);
  }
}
// ────────────────────────────────────────────────────────────
// Fortnox (Render-first) – connection-based token refresh + API fetch
function nowIso() { return new Date().toISOString(); }

function needsRefresh(expiresAtIso, minutes = 2) {
  if (!expiresAtIso) return true;
  const t = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(t)) return true;
  return (t - Date.now()) < minutes * 60 * 1000;
}

async function fortnoxRefresh(refreshToken) {
  if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET) {
    return { ok: false, status: 500, data: { error: "Missing Fortnox client envs" } };
  }

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", FORTNOX_CLIENT_ID);
  form.set("client_secret", FORTNOX_CLIENT_SECRET);

  const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });

  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.access_token, status: r.status, data: j };
}

async function getConnectionOrThrow(connection_id) {
  if (!connection_id) throw new Error("Missing connection_id");
  const conn = await bubbleGet("FortnoxConnection", connection_id);
  if (!conn) throw new Error("FortnoxConnection not found in Bubble: " + connection_id);
  return conn;
}

async function ensureFortnoxAccessToken(connection_id) {
  const conn = await getConnectionOrThrow(connection_id);

  const access = conn.access_token || null;
  const refresh = conn.refresh_token || null;
  const expiresAt = conn.expires_at || null;

  if (access && !needsRefresh(expiresAt, 2)) {
    return { ok: true, access_token: access, connection: conn, refreshed: false };
  }

  if (!refresh) {
    await bubblePatch("FortnoxConnection", connection_id, {
      last_error: "Missing refresh_token on connection",
      is_active: false,
      last_refresh_at: nowIso()
    });
    return { ok: false, error: "Missing refresh_token on connection" };
  }

  const rr = await fortnoxRefresh(refresh);

  if (!rr.ok) {
    await bubblePatch("FortnoxConnection", connection_id, {
      last_error: "Refresh failed: " + JSON.stringify(rr.data || {}),
      is_active: false,
      last_refresh_at: nowIso()
    });
    return { ok: false, error: "Refresh failed", detail: rr };
  }

  const newAccess = rr.data.access_token;
  const newRefresh = rr.data.refresh_token || refresh;
  const expiresIn = Number(rr.data.expires_in || 0);
  const newExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  await bubblePatch("FortnoxConnection", connection_id, {
    access_token: newAccess,
    refresh_token: newRefresh,
    expires_at: newExpiresAt,
    last_refresh_at: nowIso(),
    last_error: "",
    is_active: true,
    scope: rr.data.scope || conn.scope || ""
  });

  const conn2 = await getConnectionOrThrow(connection_id);

  return { ok: true, access_token: newAccess, connection: conn2, refreshed: true };
}

// Fortnox v3 API fetch helper
async function fortnoxGet(path, accessToken, query = {}) {
  const base = "https://api.fortnox.se/3";
  const qs = new URLSearchParams();
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });

  const url = base + path + (qs.toString() ? `?${qs.toString()}` : "");

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Client-Secret": String(FORTNOX_CLIENT_SECRET || ""),  // ✅ KRITISK
      "Accept": "application/json"
    }
  });

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, url };
}
// ────────────────────────────────────────────────────────────
//  lock (in-memory, survives within same Node process)
const getLock = () => {
  if (!globalThis.__miraNightlyLock) {
    globalThis.__miraNightlyLock = {
      running: false,
      started_at: 0,
      finished_at: 0,
      connection_id: null,
      run_id: null
    };
  }
  return globalThis.__miraNightlyLock;
};

// ✅ alias så dina routes funkar (du kan använda båda namnen)
const getNightlyLock = getLock;

app.get("/fortnox/nightly/status", requireApiKey, async (req, res) => {
  const lock = getNightlyLock();
  return res.json({ ok: true, lock });
});

app.post("/fortnox/nightly/unlock", requireApiKey, async (req, res) => {
  const lock = getNightlyLock();
  const was = { ...lock };
  lock.running = false;
  lock.started_at = 0;
  lock.connection_id = null;
  lock.run_id = null;
  return res.json({ ok: true, unlocked: true, was });
});
// ────────────────────────────────────────────────────────────
// Internal self-calls: använd localhost by default (stabilt, snabbt)
const SELF_BASE_URL = pick(process.env.SELF_BASE_URL) || `http://127.0.0.1:${PORT}`;
console.log("[BOOT] SELF_BASE_URL =", SELF_BASE_URL);

async function renderPostJson(path, body) {
  const url = SELF_BASE_URL.replace(/\/$/, "") + path;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.MIRA_RENDER_API_KEY
    },
    body: JSON.stringify(body || {})
  });

  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }

  if (!r.ok || j?.ok === false) {
    const err = new Error(`POST ${path} failed (${r.status})`);
    err.status = r.status;
    err.detail = j;
    throw err;
  }
  return j;
}
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/debug/bubble-bases", (req, res) => {
  res.json({ ok: true, bubble_bases: BUBBLE_BASES });
});

app.get("/debug/routes", (req, res) => {
  const routes = [];
  (app._router?.stack || []).forEach(l => {
    if (l.route?.path) {
      const methods = Object.keys(l.route.methods || {}).map(m => m.toUpperCase());
      routes.push({ methods, path: l.route.path });
    }
  });
  res.json({ ok: true, count: routes.length, routes });
});
// ────────────────────────────────────────────────────────────
app.get("/fortnox/authorize", (req, res) => {
  const u = req.query.u && String(req.query.u).trim();     // legacy: bubble user id
  const c = req.query.c && String(req.query.c).trim();     // NEW: FortnoxConnection id

  const state =
    c ? "c:" + c :
    u ? "u:" + u :
    crypto.randomUUID();

  const url =
    "https://apps.fortnox.se/oauth-v1/auth" +
    `?client_id=${encodeURIComponent(FORTNOX_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(FORTNOX_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("customer order  offer")}` +
    `&state=${encodeURIComponent(state)}`;

  log("[/fortnox/authorize] redirect", { state, have_u: !!u, have_c: !!c, redirect_uri: FORTNOX_REDIRECT_URI });
  res.redirect(url);
});

// Callback + token exchange
app.get("/fortnox/callback", async (req, res) => {
  const { code, state } = req.query || {};

  const connectionId =
    typeof state === "string" && state.startsWith("c:")
      ? state.slice(2)
      : null;

  const bubbleUserId =
    typeof state === "string" && state.startsWith("u:")
      ? state.slice(2)
      : null;

  if (!code) return res.status(400).send("Missing code from Fortnox");

  try {
    const tokenRes = await fetch("https://apps.fortnox.se/oauth-v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: FORTNOX_REDIRECT_URI,
        client_id: FORTNOX_CLIENT_ID,
        client_secret: FORTNOX_CLIENT_SECRET
      })
    });

    const tokenJson = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error("[Fortnox OAuth] token error", tokenJson);
      return res.status(400).json(tokenJson);
    }

    const expiresIn = Number(tokenJson.expires_in || 0);
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    console.log("[Fortnox OAuth] token OK", {
      has_access_token: !!tokenJson.access_token,
      has_refresh_token: !!tokenJson.refresh_token,
      connectionId,
      bubbleUserId,
      raw_scope: tokenJson.scope
    });

    // ✅ NEW: spara på FortnoxConnection om vi har connectionId
    if (connectionId) {
      const patched = await bubblePatch("FortnoxConnection", connectionId, {
        access_token: tokenJson.access_token || null,
        refresh_token: tokenJson.refresh_token || null,
        expires_at: expiresAt,
        token_type: tokenJson.token_type || "Bearer",
        scope: tokenJson.scope || "",
        is_active: true,
        last_error: "",
        last_refresh_at: new Date().toISOString()
      });

      log("[Fortnox OAuth] saved to FortnoxConnection", { connectionId, patched });

      if (!patched) return res.status(502).send("Failed to save tokens to FortnoxConnection");
    }

    // Legacy: om du fortfarande vill stödja user-flödet parallellt
    if (!connectionId && bubbleUserId) {
      const saved = await upsertFortnoxTokensToBubble(bubbleUserId, tokenJson);
      log("[Fortnox OAuth] saved to User legacy", { bubbleUserId, saved });
      if (!saved) return res.status(502).send("Failed to save Fortnox tokens to Bubble user");
    }

    // Redirect tillbaka (lägg gärna med connectionId så du kan visa “connected” per leverantör)
    const redirectTo =
      connectionId
        ? "https://mira-fm.com/fortnox-connected?connection_id=" + encodeURIComponent(connectionId)
        : "https://mira-fm.com/fortnox-connected";

    return res.redirect(redirectTo);

  } catch (err) {
    console.error("[Fortnox OAuth] callback error", err);
    return res.status(500).send("Fortnox OAuth failed");
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: refresh token PER CONNECTION (ny arkitektur)
app.post("/fortnox/connection/refresh", async (req, res) => {
  const { connection_id } = req.body || {};
  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Hämta FortnoxConnection från Bubble
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    }

    const rt = conn.refresh_token || null;
    if (!rt) {
      return res.status(400).json({ ok: false, error: "Missing refresh_token on connection" });
    }

    // 2) Refresh mot Fortnox
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", rt);
    form.set("client_id", FORTNOX_CLIENT_ID);
    form.set("client_secret", FORTNOX_CLIENT_SECRET);

    const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.access_token) {
      await bubblePatch("FortnoxConnection", connection_id, {
        last_error: JSON.stringify(j || {}),
        last_refresh_at: new Date().toISOString()
      });
      return res.status(400).json({ ok: false, status: r.status, error: j });
    }

    const expiresIn = Number(j.expires_in || 0);
    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // 3) Spara nya tokens på FortnoxConnection
    const patched = await bubblePatch("FortnoxConnection", connection_id, {
      access_token: j.access_token || null,
      refresh_token: j.refresh_token || rt,
      expires_at: expiresAt,
      scope: j.scope || conn.scope || "",
      last_error: "",
      last_refresh_at: new Date().toISOString(),
      is_active: true
    });

    return res.json({
      ok: true,
      patched,
      connection_id,
      expires_at: expiresAt,
      has_new_refresh_token: !!j.refresh_token
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: sync customers (Render-first, read-only)
app.post("/fortnox/sync/customers", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Hämta FortnoxConnection
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    }

    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    // 2) Auto-refresh om token saknas eller är expired
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch("https://mira-exchange.onrender.com/fortnox/connection/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id })
      });
      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) {
        return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });
      }

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }

    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "No access_token available" });
    }

    // 3) Call Fortnox Customers
    const url =
      "https://api.fortnox.se/3/customers" +
      `?page=${encodeURIComponent(page)}` +
      `&limit=${encodeURIComponent(limit)}`;

    const r = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        "Accept": "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Fortnox API error",
        detail: data
      });
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      meta: data?.MetaInformation || null,
      customers: data?.Customers || []
    });

  } catch (e) {
    console.error("[/fortnox/sync/customers] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: sync orders (Render-first, read-only) with months_back filter
app.post("/fortnox/sync/orders", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,
    months_back = 12
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Load FortnoxConnection
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    }

    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    // 2) Auto-refresh token
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch("https://mira-exchange.onrender.com/fortnox/connection/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id })
      });

      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) {
        return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });
      }

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }

    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "No access_token available" });
    }

    // 3) Date window
    const mb = Math.max(1, Number(months_back) || 12);
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - mb);

    const fmt = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const fromDate = fmt(from);
    const toDate   = fmt(to);

    // 4) Fetch orders filtered by ORDER DATE (server-side)
    const url =
      "https://api.fortnox.se/3/orders" +
      `?page=${encodeURIComponent(page)}` +
      `&limit=${encodeURIComponent(limit)}` +
      `&fromdate=${encodeURIComponent(fromDate)}` +
      `&todate=${encodeURIComponent(toDate)}`;

    const r = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        "Accept": "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Fortnox API error",
        detail: data
      });
    }

    const list = Array.isArray(data?.Orders) ? data.Orders : [];

    // 5) Render-side filter:  >= cutoff
    const cutoff = new Date(fromDate + "T00:00:00Z").getTime();

    const filtered = list.filter(o => {
      const d = String(o?.DeliveryDate || "").trim();
      if (!d) return false;
      const t = new Date(d + "T00:00:00Z").getTime();
      return Number.isFinite(t) && t >= cutoff;
    });

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      sent_filters: {
        months_back: mb,
        orderDateFrom: fromDate,
        orderDateTo: toDate,
        deliveryDateCutoff: fromDate
      },
      meta: data?.MetaInformation || null,
      orders: filtered,
      debug_counts: {
        fetched: list.length,
        kept_by_deliverydate: filtered.length
      }
    });

  } catch (e) {
    console.error("[/fortnox/sync/orders] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert orders into Bubble (one page)
app.post("/fortnox/upsert/orders", async (req, res) => {
  const { connection_id, page = 1, limit = 100, months_back = 12 } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let firstError = null;

  try {
    const syncRes = await fetch("https://mira-exchange.onrender.com/fortnox/sync/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });

    const syncText = await syncRes.text();
    let syncJson = {};
    try { syncJson = syncText ? JSON.parse(syncText) : {}; } catch { syncJson = { raw: syncText }; }

    if (!syncRes.ok || !syncJson.ok) {
      return res.status(400).json({ ok: false, error: "sync/orders failed", http_status: syncRes.status, detail: syncJson });
    }

    const orders = Array.isArray(syncJson.orders) ? syncJson.orders : [];

    for (const o of orders) {
      const docNo = String(o?.DocumentNumber || "").trim();
      if (!docNo) { skipped++; continue; }

      const payload = {
        connection: connection_id,
        ft_document_number: docNo,
        ft_customer_number: String(o?.CustomerNumber || ""),
        ft_customer_name: String(o?.CustomerName || ""),
        ft_your_reference: String(o?.YourReference || ""),
        ft_order_date: toIsoDate(o?.OrderDate),
        ft_delivery_date: toIsoDate(o?.DeliveryDate),
        ft_last_seen_at: new Date().toISOString(),
        ft_total: o?.Total == null ? "" : String(o.Total),
        ft_cancelled: !!o?.Cancelled,
        ft_sent: !!o?.Sent,
        ft_currency: String(o?.Currency || ""),
        ft_url: String(o?.["@url"] || ""),
        ft_raw_json: JSON.stringify(o || {}),
        needs_rows_sync: true
      };

      try {
        const search = await bubbleFind("FortnoxOrder", {
          constraints: [
            { key: "connection", constraint_type: "equals", value: connection_id },
            { key: "ft_document_number", constraint_type: "equals", value: docNo }
          ],
          limit: 1
        });

        const existing = Array.isArray(search) && search.length ? search[0] : null;
        const foundDoc = String(existing?.ft_document_number || "").trim();

        if (existing?._id && foundDoc === docNo) {
          await bubblePatch("FortnoxOrder", existing._id, payload);
          updated++;
        } else {
          await bubbleCreate("FortnoxOrder", payload);
          created++;
        }
      } catch (e) {
        errors++;
        if (!firstError) firstError = { docNo, message: e?.message || String(e), status: e?.status || null, detail: e?.detail || null };
      }
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      months_back,
      meta: syncJson.meta || null,
      counts: { created, updated, skipped, errors },
      first_error: firstError
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert orders - batch loop (N pages per run)
app.post("/fortnox/upsert/orders/all", async (req, res) => {
  const {
    connection_id,
    start_page = 1,
    limit = 100,
    max_pages = 10,
    months_back = 12
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  const start = Number(start_page) || 1;
  const maxP  = Math.max(1, Number(max_pages) || 10);
  const lim   = Math.max(1, Math.min(500, Number(limit) || 100));

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let page = start;
  let totalPages = null;

  try {
    for (let i = 0; i < maxP; i++) {
      const r = await fetch(`${SELF_BASE_URL}/fortnox/upsert/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, page, limit: lim, months_back })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        return res.status(400).json({ ok: false, error: "upsert/orders failed", detail: j, page });
      }

      created += j.counts?.created || 0;
      updated += j.counts?.updated || 0;
      skipped += j.counts?.skipped || 0;
      errors  += j.counts?.errors  || 0;

      const meta = j.meta || null;
      const cur  = Number(meta?.["@CurrentPage"] || page);
      const tot  = Number(meta?.["@TotalPages"] || 0);
      if (tot) totalPages = tot;

      if (tot && cur >= tot) {
        return res.json({
          ok: true, connection_id, done: true,
          start_page: start, end_page: cur, total_pages: tot,
          counts: { created, updated, skipped, errors },
          next_page: null
        });
      }

      page = cur + 1;
    }

    return res.json({
      ok: true, connection_id, done: false,
      start_page: start, end_page: page - 1, total_pages: totalPages,
      counts: { created, updated, skipped, errors },
      next_page: page
    });
  } catch (e) {
    console.error("[/fortnox/upsert/orders/all] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: sync ONE order (fetch order detail incl YourReference)
app.post("/fortnox/sync/orders/one", requireApiKey, async (req, res) => {
  try {
    const { connection_id, order_docno } = req.body || {};
    const docNo = String(order_docno || "").trim();
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
    if (!docNo) return res.status(400).json({ ok: false, error: "Missing order_docno" });

    const tok = await ensureFortnoxAccessToken(connection_id);
    if (!tok?.ok) {
      return res.status(401).json({ ok: false, error: tok?.error || "Token error", detail: tok?.detail || null });
    }

    const r = await fortnoxGet("/orders/" + encodeURIComponent(docNo), tok.access_token);
    if (!r.ok) {
      return res.status(r.status || 500).json({ ok: false, status: r.status || 500, data: r.data || null, url: r.url || null });
    }

    const order = r.data?.Order || r.data?.order || null;
    return res.json({ ok: true, connection_id, order_docno: docNo, order });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Alias (valfritt, men nice)
app.post("/fortnox/sync/order", requireApiKey, async (req, res) => {
  const r = await fetch(`${SELF_BASE_URL.replace(/\/$/, "")}/fortnox/sync/orders/one`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
    body: JSON.stringify(req.body || {})
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  return res.status(r.status).json(j);
});
// ────────────────────────────────────────────────────────────
// Fortnox: fetch + upsert customers into Bubble (FortnoxCustomer)
app.post("/fortnox/upsert/customers", requireApiKey, async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,
    skip_without_orgnr = true,
    link_company = true
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let first_error = null;

  try {
    const r = await fetch(`${SELF_BASE_URL}/fortnox/sync/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify({ connection_id, page, limit })
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) {
      return res.status(400).json({ ok: false, error: "sync/customers failed", http_status: r.status, detail: j });
    }

    const list = Array.isArray(j.customers) ? j.customers : [];

    for (const c of list) {
      const customerNumber = asTextOrEmpty(c?.CustomerNumber).trim();
      const orgnr = asTextOrEmpty(c?.OrganisationNumber).trim();

      if (!customerNumber) { skipped++; continue; }
      if (skip_without_orgnr && !orgnr) { skipped++; continue; }

      const basePayload = {
        connection_id: asTextOrEmpty(connection_id),
        customer_number: customerNumber,
        name: asTextOrEmpty(c?.Name),
        organisation_number: orgnr,
        email: asTextOrEmpty(c?.Email),
        phone: asTextOrEmpty(c?.Phone),
        address1: asTextOrEmpty(c?.Address1),
        address2: asTextOrEmpty(c?.Address2),
        zip: asTextOrEmpty(c?.ZipCode),
        city: asTextOrEmpty(c?.City),
        ft_url: asTextOrEmpty(c?.["@url"]),
        last_seen_at: new Date().toISOString(),
        raw_json: JSON.stringify(c || {}),
        fortnox_json: JSON.stringify(c || {})
      };

      try {
        const existing = await bubbleFindOne("FortnoxCustomer", [
          { key: "connection_id", constraint_type: "equals", value: connection_id },
          { key: "customer_number", constraint_type: "equals", value: customerNumber }
        ]);

        let ccId = null;
const hasLinkedAlready = !!(existing && (existing.linked_company || existing.linked_company?._id));

// ✅ Kör alltid (så ClientCompany kan patchas med ft_customer_number även om den redan är länkad)
if (link_company && orgnr) {
  ccId = await ensureClientCompanyForFortnoxCustomer(c);
}

        if (existing?._id) {
          const patchPayload = { ...basePayload };
          if (ccId && !hasLinkedAlready) patchPayload.linked_company = ccId;

          await bubblePatch("FortnoxCustomer", existing._id, patchPayload);
          updated++;
        } else {
          const createPayload = { ...basePayload };
          if (ccId) createPayload.linked_company = ccId;

          const id = await bubbleCreate("FortnoxCustomer", createPayload);
          if (id) created++;
          else {
            errors++;
            if (!first_error) first_error = { step: "bubbleCreate", customerNumber, message: "bubbleCreate returned null id" };
          }
        }
      } catch (e) {
        errors++;
        if (!first_error) first_error = {
          step: "bubbleUpsert",
          customerNumber,
          message: e?.message || String(e),
          detail: e?.detail || null
        };
      }
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      skip_without_orgnr,
      link_company,
      meta: j.meta || null,
      counts: { created, updated, skipped, errors },
      first_error
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// Fortnox: upsert customers - batch loop (N pages per run)
app.post("/fortnox/upsert/customers/all", requireApiKey, async (req, res) => {
  const {
    connection_id,
    start_page = 1,
    limit = 100,
    max_pages = 10,
    pause_ms = 0,
    skip_without_orgnr = true,
    link_company = true
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  const start = Number(start_page) || 1;
  const maxP  = Math.max(1, Number(max_pages) || 10);
  const lim   = Math.max(1, Math.min(500, Number(limit) || 100));
  const pause = Math.max(0, Number(pause_ms) || 0);

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let page = start;
  let totalPages = null;
  let first_error = null;

  try {
    for (let i = 0; i < maxP; i++) {
      const r = await fetch(`${SELF_BASE_URL}/fortnox/upsert/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({
          connection_id,
          page,
          limit: lim,
          skip_without_orgnr,
          link_company
        })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        return res.status(400).json({ ok: false, error: "upsert/customers failed", detail: j, page });
      }

      created += j.counts?.created || 0;
      updated += j.counts?.updated || 0;
      skipped += j.counts?.skipped || 0;
      errors  += j.counts?.errors  || 0;

      if (!first_error && j.first_error) first_error = j.first_error;

      const meta = j.meta || null;
      const cur  = Number(meta?.["@CurrentPage"] || page);
      const tot  = Number(meta?.["@TotalPages"] || 0);
      if (tot) totalPages = tot;

      if (tot && cur >= tot) {
        return res.json({
          ok: true,
          connection_id,
          done: true,
          start_page: start,
          end_page: cur,
          total_pages: tot,
          counts: { created, updated, skipped, errors },
          first_error,
          next_page: null
        });
      }

      page = cur + 1;
      if (pause) await sleep(pause);
    }

    return res.json({
      ok: true,
      connection_id,
      done: false,
      start_page: start,
      end_page: page - 1,
      total_pages: totalPages,
      counts: { created, updated, skipped, errors },
      first_error,
      next_page: page
    });

  } catch (e) {
    console.error("[/fortnox/upsert/customers/all] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: refresh + spara token (legacy to User)
app.post("/fortnox/refresh-save", async (req, res) => {
  const {
    bubble_user_id,
    u,
    refresh_token
  } = req.body || {};

  const userId = bubble_user_id || u || null;

  log("[/fortnox/refresh-save] hit", {
    has_body: !!req.body,
    has_user: !!userId,
    has_refresh_token: !!refresh_token
  });

  if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "Fortnox client envs missing"
    });
  }

  try {
    let rt = refresh_token || null;

    if (!rt && userId) {
      const uResp = await fetchBubbleUser(userId);
      rt = uResp?.ft_refresh_token || null;
      log("[/fortnox/refresh-save] fetched user", {
        has_user: !!uResp,
        has_ft_refresh_token: !!rt
      });
    }

    if (!rt) {
      return res.status(400).json({
        ok: false,
        error: "Missing refresh_token (and could not load from Bubble)"
      });
    }

    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", rt);
    form.set("client_id", FORTNOX_CLIENT_ID);
    form.set("client_secret", FORTNOX_CLIENT_SECRET);

    const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.access_token) {
      console.error("[/fortnox/refresh-save] token error", {
        status: r.status,
        body: j
      });
      return res.status(400).json({
        ok: false,
        status: r.status,
        error: j
      });
    }

    let saved = false;
    if (userId) {
      saved = await upsertFortnoxTokensToBubble(userId, j);
      log("[/fortnox/refresh-save] upsert", { userId, saved });
      if (!saved) {
        return res.status(502).json({
          ok: false,
          error: "Failed to save refreshed Fortnox tokens to Bubble"
        });
      }
    }

    return res.json({
      ok: true,
      saved_for_user: userId,
      access_token_preview: (j.access_token || "").slice(0, 12) + "...",
      has_refresh_token: !!j.refresh_token,
      raw_scope: j.scope || null
    });
  } catch (e) {
    console.error("[/fortnox/refresh-save] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
const toIsoDate = (d) => {
  const s = String(d || "").trim(); // "YYYY-MM-DD"
  if (!s) return null;
  // Bubble brukar gilla ISO
  return s + "T00:00:00.000Z";
};
const toNumOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function parseFtDateToTs(v) {
  const s = String(v || "").trim();
  if (!s) return NaN;

  // "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(s + "T00:00:00Z").getTime();
  }

  // "YYYY-MM-DDTHH:mm:ss"
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    return new Date(s).getTime();
  }

  // "/Date(1234567890)/"
  const m = s.match(/Date\((\d+)\)/);
  if (m) return Number(m[1]);

  return NaN;
}
// ────────────────────────────────────────────────────────────
// Fortnox: sync invoices (Render-first, read-only) with months_back filter on InvoiceDate
app.post("/fortnox/sync/invoices", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,
    months_back = 12
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Hämta FortnoxConnection
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });

    // PAUS: om du stänger av is_active stoppar vi här
    if (conn.is_active === false) {
      return res.json({ ok: true, paused: true, connection_id });
    }

    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    // 2) Auto-refresh om token saknas/expired
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch(`${SELF_BASE_URL}/fortnox/connection/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id })
      });

      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) {
        return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });
      }

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }

    if (!accessToken) return res.status(401).json({ ok: false, error: "No access_token available" });

    // 3) months_back window (cutoff = today - months_back)
    const mb = Math.max(1, Number(months_back) || 12);
    const now = new Date();
    const from = new Date(now);
    from.setMonth(from.getMonth() - mb);

    const fmt = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const cutoffDate = fmt(from);      // fromdate
    const toDate = fmt(now);           // todate
    const cutoffTs = new Date(cutoffDate + "T00:00:00Z").getTime();

    // 4) Hämta invoices (LÅT FORTNOX FILTRERA via fromdate/todate)
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      fromdate: cutoffDate,
      todate: toDate
    });

    const url = `https://api.fortnox.se/3/invoices?${qs.toString()}`;

    const r = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        "Accept": "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Fortnox API error",
        detail: data
      });
    }

    const list = Array.isArray(data?.Invoices) ? data.Invoices : [];

    // Safety net: client-side filter också (ska normalt vara redundant nu)
    const pickInvoiceDateTs = (inv) => {
      const candidates = [
        inv?.InvoiceDate,
        inv?.invoiceDate,
        inv?.DocumentDate,
        inv?.documentDate,
        inv?.Created,
        inv?.created,
        inv?.DueDate,
        inv?.dueDate
      ];
      for (const c of candidates) {
        const ts = parseFtDateToTs(c);
        if (Number.isFinite(ts)) return ts;
      }
      return NaN;
    };

    const filtered = list.filter(inv => {
      const ts = pickInvoiceDateTs(inv);
      return Number.isFinite(ts) && ts >= cutoffTs;
    });

    // DEBUG: visa sample så vi ser exakt vilka fält som kommer
    const sample = list[0] || null;
    const sampleKeys = sample ? Object.keys(sample) : [];
    const samplePickedTs = sample ? pickInvoiceDateTs(sample) : null;

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      sent_filters: {
        months_back: mb,
        fromdate: cutoffDate,
        todate: toDate,
        invoiceDateCutoff: cutoffDate
      },
      meta: data?.MetaInformation || null,
      invoices: filtered,
      debug_counts: { fetched: list.length, kept_by_date: filtered.length },
      debug_sample: {
        keys: sampleKeys,
        invoiceDate: sample?.InvoiceDate || sample?.invoiceDate || null,
        documentDate: sample?.DocumentDate || sample?.documentDate || null,
        created: sample?.Created || sample?.created || null,
        dueDate: sample?.DueDate || sample?.dueDate || null,
        picked_ts: samplePickedTs,
        cutoff_ts: cutoffTs,
        request_url: url
      }
    });
  } catch (e) {
    console.error("[/fortnox/sync/invoices] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert invoices (NO invoice rows) – uses /fortnox/sync/invoices
// Upsert key: connection_id + ft_document_number
app.post("/fortnox/upsert/invoices", requireApiKey, async (req, res) => {
  try {
    const {
      connection_id,
      page = 1,
      limit = 100,
      months_back = 12,
      pause_ms = 0
    } = req.body || {};

    if (!connection_id) {
      return res.status(400).json({ ok: false, error: "Missing connection_id" });
    }

    // 1) Hämta invoices via din sync-endpoint (filtrerar på datum)
    const syncRes = await fetch(`${SELF_BASE_URL}/fortnox/sync/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });

    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncJson.ok) {
      return res.status(400).json({ ok: false, error: "sync/invoices failed", detail: syncJson });
    }

    const invoices = Array.isArray(syncJson.invoices) ? syncJson.invoices : [];
    const TYPE = "FortnoxInvoice";

    let created = 0, updated = 0, skipped = 0, errors = 0;
    let first_error = null;

    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i] || {};
      const docNo = String(inv.DocumentNumber || inv.documentNumber || "").trim();
      if (!docNo) { skipped++; continue; }

      const fields = {
        connection_id: connection_id,                           // ✅ matchar ditt relationsfält
        ft_document_number: docNo,

        ft_invoice_date: toIsoDate(inv.InvoiceDate),            // ✅ date-fält
        ft_due_date: toIsoDate(inv.DueDate),                    // ✅ date-fält

        ft_customer_number: asTextOrEmpty(inv.CustomerNumber),  // ✅ text
        ft_customer_name: asTextOrEmpty(inv.CustomerName),      // ✅ text

        ft_total: asTextOrEmpty(inv.Total),                     // ✅ text
        ft_balance: asTextOrEmpty(inv.Balance),                 // ✅ text
        ft_currency: asTextOrEmpty(inv.Currency),               // ✅ text
        ft_ocr: asTextOrEmpty(inv.OCR),                         // ✅ text

        ft_cancelled: inv.Cancelled === true,                   // ✅ yes/no
        ft_sent: inv.Sent === true,                             // ✅ yes/no

        ft_url: asTextOrEmpty(inv["@url"]),                     // ✅ text
        ft_raw_json: JSON.stringify(inv || {})
      };

      try {
        const existing = await bubbleFindOne(TYPE, [
          { key: "connection_id", constraint_type: "equals", value: connection_id },
          { key: "ft_document_number", constraint_type: "equals", value: docNo }
        ]);

        if (existing?._id) {
          await bubblePatch(TYPE, existing._id, fields);
          updated++;
        } else {
          const id = await bubbleCreate(TYPE, fields);
          if (id) created++;
          else {
            errors++;
            if (!first_error) first_error = { step: "bubbleCreate", docNo, detail: "bubbleCreate returned null id" };
          }
        }
      } catch (e) {
        errors++;
        if (!first_error)
          first_error = {
            step: "bubbleUpsert",
            docNo,
            message: e?.message || String(e),
            status: e?.status || null,
            detail: e?.detail || null
          };
      }

      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      months_back,
      meta: syncJson.meta || null,
      counts: { created, updated, skipped, errors },
      first_error,
      docs: invoices.length
    });
  } catch (e) {
    console.error("[/fortnox/upsert/invoices] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
const bubbleFindAllCursor = async (type, constraints, pageSize = 100) => {
  const out = [];
  let cursor = 0;
  let safety = 0;

  while (true) {
    safety++;
    if (safety > 500) break; // skydd

    const resp = await bubbleFind(type, {
      constraints,
      limit: pageSize,
      cursor
    });

    const list = Array.isArray(resp) ? resp : (resp?.results || []);
    if (!Array.isArray(list) || list.length === 0) break;

    out.push(...list);

    if (list.length < pageSize) break;
    cursor += pageSize;
  }

  return out;
};

// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows (per order docno)  ✅ WU-optimerad
app.post("/fortnox/upsert/order-rows", requireApiKey, async (req, res) => {
  const { connection_id, order_docno } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
  if (!order_docno) return res.status(400).json({ ok: false, error: "Missing order_docno" });

  try {
    // 0) Connection + paused?
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    if (conn.is_active === false) return res.json({ ok: true, paused: true, connection_id });

    // 1) Access token (behåll ditt befintliga refresh-mönster, men utan hardcoded onrender)
    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch(`${SELF_BASE_URL}/fortnox/connection/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id })
      });
      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });

      const updatedConn = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updatedConn?.access_token || null;
    }
    if (!accessToken) return res.status(401).json({ ok: false, error: "No access_token available" });

    // 2) Hämta order från Fortnox
    const docNoReq = String(order_docno).trim();
    const url = `https://api.fortnox.se/3/orders/${encodeURIComponent(docNoReq)}`;

    const r = await fetch(url, {
      headers: {
        Authorization: "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        Accept: "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ ok: false, error: "Fortnox API error", detail: data });

    const order = data?.Order || data?.order || null;
    const rows = Array.isArray(order?.OrderRows) ? order.OrderRows : [];

    const ordDocNo = String(order?.DocumentNumber || docNoReq).trim();

    // ✅ Fix: YourReference kommer från ORDER, inte "o" (som inte finns här)
    const orderYourRef = String(order?.YourReference || order?.YourReferenceNumber || "");

    // 3) Hitta parent order i Bubble
    const searchOrd = await bubbleFind("FortnoxOrder", {
      constraints: [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "ft_document_number", constraint_type: "equals", value: ordDocNo }
      ],
      limit: 1
    });

    const ordObj = Array.isArray(searchOrd) && searchOrd.length ? searchOrd[0] : null;
    if (!ordObj?._id) {
      return res.status(404).json({ ok: false, error: "Parent FortnoxOrder not found in Bubble", ordDocNo });
    }

    // 4) ✅ NYTT: Hämta alla befintliga rader för just denna order (1 gång) och indexera på ft_unique_key
    const existingRows = await bubbleFindAllCursor(
      "FortnoxOrderRow",
      [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "order", constraint_type: "equals", value: ordObj._id }
      ],
      100
    );

    const existingByKey = {};
    for (const er of existingRows) {
      if (er?.ft_unique_key && er?._id) existingByKey[String(er.ft_unique_key)] = er._id;
    }

    // 5) Upsert rows utan bubbleFind per rad
    let created = 0, updated = 0, errors = 0;
    let firstError = null;
    const debug = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = i + 1;

      const rowNo = Number(row?.RowNumber ?? row?.RowNo ?? row?.Row ?? rowIndex);
      const rowId = row?.RowId ?? row?.rowId ?? null;

      // Samma “säker” uniqueKey som du redan kör (för kompatibilitet)
      const uniqueKey = rowId
        ? `ROWID_${rowId}__CONN_${connection_id}__ORDDOC_${ordDocNo}`
        : `FALLBACK__CONN_${connection_id}__ORDDOC_${ordDocNo}__IDX_${String(rowIndex).padStart(3, "0")}`;

      const payload = {
        connection: connection_id,
        order: ordObj._id,

        ft_order_document_number: ordDocNo,
        ft_row_index: rowIndex,
        ft_row_no: rowNo,

        ft_article_number: String(row?.ArticleNumber || ""),
        ft_description: String(row?.Description || ""),

        // ✅ fix: använd orderns YourReference (inte o?.)
        ft_your_reference: orderYourRef,

        ft_quantity: row?.DeliveredQuantity ?? row?.Quantity ?? null,
        ft_unit: String(row?.Unit || ""),

        // Behåll samma “string/empty” typ som din befintliga kod för att inte riskera Bubble field-type errors
        ft_price: row?.Price == null ? "" : String(row.Price),
        ft_discount: row?.Discount == null ? "" : String(row.Discount),
        ft_vat: row?.VAT == null ? "" : String(row.VAT),
        ft_total: row?.Total == null ? "" : String(row.Total),

        ft_unique_key: uniqueKey,
        ft_raw_json: JSON.stringify(row || {})
      };

      try {
        const existingId = existingByKey[uniqueKey];

        if (debug.length < 5) {
          debug.push({
            rowIndex,
            uniqueKey,
            existing_id: existingId || null
          });
        }

        if (existingId) {
          await bubblePatch("FortnoxOrderRow", existingId, payload);
          updated++;
        } else {
          await bubbleCreate("FortnoxOrderRow", payload);
          created++;
        }
      } catch (e) {
        errors++;
        if (!firstError) firstError = { uniqueKey, message: e?.message || String(e), detail: e?.detail || null };
      }
    }

    // 6) Markera parent som synkad (samma som du gör idag)
    if (errors === 0) {
      await bubblePatch("FortnoxOrder", ordObj._id, {
        needs_rows_sync: false,
        rows_last_synced_at: new Date().toISOString()
      });
    }

    return res.json({
      ok: true,
      connection_id,
      order_docno: ordDocNo,
      rows_count: rows.length,
      existing_rows_in_bubble: existingRows.length,
      counts: { created, updated, errors },
      first_error: firstError,
      debug_samples: debug
    });

  } catch (e) {
    console.error("[/fortnox/upsert/order-rows] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows for FLAGGED orders (needs_rows_sync=true)
app.post("/fortnox/upsert/order-rows/flagged", requireApiKey, async (req, res) => {
  try {
    const { connection_id, limit = 30, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    const flagged = await bubbleFind("FortnoxOrder", {
      constraints: [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "needs_rows_sync", constraint_type: "equals", value: true }
      ],
      limit: Number(limit) || 30
    });

    const orders = Array.isArray(flagged) ? flagged : [];
    const results = [];
    let ok_count = 0, fail_count = 0;

    for (const o of orders) {
      const docNo = String(o?.ft_document_number || "").trim();
      if (!docNo) continue;

      const rr = await fetch(`${SELF_BASE_URL}/fortnox/upsert/order-rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, order_docno: docNo })
      });

      const j = await rr.json().catch(() => ({}));
      const ok = !!j.ok;

      results.push({
        docNo,
        ok,
        http_status: rr.status,
        counts: j.counts || null,
        first_error: j.first_error || j.error || j.detail || null
      });

      ok ? ok_count++ : fail_count++;
      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({ ok: true, connection_id, flagged_found: orders.length, ok_count, fail_count, results });
  } catch (e) {
    console.error("[/fortnox/upsert/order-rows/flagged] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows for ALL orders on one orders page
app.post("/fortnox/upsert/order-rows/page", requireApiKey, async (req, res) => {
  try {
    const { connection_id, page = 1, limit = 50, months_back = 12, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    // ✅ Byt bort hardcoded onrender och kör mot SELF_BASE_URL (rätt miljö alltid)
    const syncRes = await fetch(`${SELF_BASE_URL}/fortnox/sync/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });

    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncJson.ok) {
      return res.status(400).json({ ok: false, error: "sync/orders failed", detail: syncJson });
    }

    const docs = Array.isArray(syncJson.orders) ? syncJson.orders : [];
    const results = [];
    let ok_count = 0, fail_count = 0;

    for (let i = 0; i < docs.length; i++) {
      const docNo = String(docs[i]?.DocumentNumber || "").trim();
      if (!docNo) continue;

      const rr = await fetch(`${SELF_BASE_URL}/fortnox/upsert/order-rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, order_docno: docNo })
      });

      const j = await rr.json().catch(() => ({}));
      const ok = !!j.ok;

      results.push({ docNo, ok, counts: j.counts || null, first_error: j.first_error || j.error || null });
      ok ? ok_count++ : fail_count++;

      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({ ok: true, connection_id, page, limit, months_back, docs: docs.length, ok_count, fail_count, results });
  } catch (e) {
    console.error("[/fortnox/upsert/order-rows/page] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox (Render-first) endpoints – use FortnoxConnection in Bubble
app.post("/fortnox/debug/connection", async (req, res) => {
  try {
    const { connection_id } = req.body || {};
    const conn = await getConnectionOrThrow(connection_id);

    return res.json({
      ok: true,
      connection_id,
      has_access_token: !!conn.access_token,
      has_refresh_token: !!conn.refresh_token,
      expires_at: conn.expires_at || null,
      needs_refresh: needsRefresh(conn.expires_at, 2),
      is_active: conn.is_active ?? null,
      last_error: conn.last_error || ""
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
      detail: e.detail || null
    });
  }
});
app.get("/fortnox/debug/connections", requireApiKey, async (req, res) => {
  try {
    const onlyActive = String(req.query.only_active ?? "true") !== "false";
    const list = await getAllFortnoxConnections({ onlyActive });

    const slim = list.map(c => ({
      id: c?._id,
      is_active: c?.is_active,
      supplier: c?.supplier ?? null,
      expires_at: c?.expires_at ?? null,
      has_access_token: !!c?.access_token,
      has_refresh_token: !!c?.refresh_token
    }));

    res.json({ ok: true, count: slim.length, connections: slim });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});
// ────────────────────────────────────────────────────────────
// fortnox/sync/offers  (Render-first, read-only)
app.post("/fortnox/sync/offers", async (req, res) => {
  const { connection_id, page = 1, limit = 100 } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok:false, error:"Missing connection_id" });

  const tok = await ensureFortnoxAccessToken(connection_id);
  if (!tok.ok) return res.status(401).json(tok);

  const r = await fortnoxGet("/offers", tok.access_token, { page, limit });
  if (!r.ok) return res.status(r.status).json(r);

  return res.json({
    ok: true,
    connection_id,
    meta: r.data?.MetaInformation || null,
    offers: r.data?.Offers || []
  });
});
// ────────────────────────────────────────────────────────────
// /fortnox/upsert/offers
app.post("/fortnox/upsert/offers", async (req, res) => {
  const { connection_id, page = 1, limit = 100 } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let firstError = null;
  let meta = null;

  try {
    // 1) Hämta offers via sync-route (robust)
    let sync = null;

    if (typeof renderPostJson === "function") {
      sync = await renderPostJson("/fortnox/sync/offers", { connection_id, page, limit });
    } else {
      const syncRes = await fetch(`${SELF_BASE_URL}/fortnox/sync/offers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id, page, limit })
      });

      const text = await syncRes.text();
      try { sync = text ? JSON.parse(text) : null; }
      catch { sync = { raw: text }; }

      if (!syncRes.ok || !sync || sync.ok === false) {
        return res.status(400).json({
          ok: false,
          error: "sync/offers failed",
          http_status: syncRes.status,
          detail: sync
        });
      }
    }

    // 2) Normalisera
    const offers = Array.isArray(sync?.offers) ? sync.offers : [];
    meta = sync?.meta || null;

    // 3) Upsert per offer
    for (const o of offers) {
      const docNo = String(o?.DocumentNumber || "").trim();
      if (!docNo) { skipped++; continue; }

      const payload = {
        connection: connection_id,
        ft_document_number: docNo,
        ft_customer_number: String(o?.CustomerNumber || ""),
        ft_customer_name: String(o?.CustomerName || ""),
        ft_your_reference: String(o?.YourReference || ""),
        ft_offer_date: toIsoDate(o?.OfferDate),
        ft_delivery_date: toIsoDate(o?.DeliveryDate),
        ft_valid_until: toIsoDate(o?.ValidUntil),
        ft_total: toNumOrNull(o?.Total),
        ft_currency: String(o?.Currency || ""),
        ft_sent: !!o?.Sent,
        ft_cancelled: !!o?.Cancelled,
        ft_url: String(o?.["@url"] || ""),
        ft_raw_json: JSON.stringify(o || {}),
        needs_rows_sync: true
      };

      try {
        const found = await bubbleFind("FortnoxOffer", {
          constraints: [
            { key: "connection", constraint_type: "equals", value: connection_id },
            { key: "ft_document_number", constraint_type: "equals", value: docNo }
          ],
          limit: 1
        });

        const existing = Array.isArray(found) && found.length ? found[0] : null;

        if (existing?._id) {
          await bubblePatch("FortnoxOffer", existing._id, payload);
          updated++;
        } else {
          await bubbleCreate("FortnoxOffer", payload);
          created++;
        }
      } catch (e) {
        errors++;
        if (!firstError) {
          firstError = {
            docNo,
            message: e?.message || String(e),
            detail: e?.detail || null
          };
        }
      }
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      meta,
      counts: { created, updated, skipped, errors },
      first_error: firstError
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }
});


// ────────────────────────────────────────────────────────────
// /fortnox/upsert/offer-rows  (WU-optimerad: bulk fetch av befintliga rows)
app.post("/fortnox/upsert/offer-rows", requireApiKey, async (req, res) => {
  const t0 = Date.now();

  try {
    const { connection_id, offer_docno } = req.body || {};
    const docNo = String(offer_docno || "").trim();

    if (!connection_id || !docNo) {
      return res.status(400).json({ ok: false, error: "Missing connection_id or offer_docno" });
    }

    const tok = await ensureFortnoxAccessToken(connection_id);
    const r = await fortnoxGet(`/offers/${encodeURIComponent(docNo)}`, tok.access_token);
    if (!r.ok) {
      return res.status(r.status || 500).json({ ok: false, error: "fortnoxGet failed", detail: r });
    }

    const offer = r.data?.Offer;
    const rows = Array.isArray(offer?.OfferRows) ? offer.OfferRows : [];

    const parent = await bubbleFindOne("FortnoxOffer", [
      { key: "connection", constraint_type: "equals", value: connection_id },
      { key: "ft_document_number", constraint_type: "equals", value: docNo }
    ]);

    if (!parent?._id) {
      return res.status(404).json({
        ok: false,
        error: "Parent FortnoxOffer not found in Bubble (run /fortnox/upsert/offers first for this docNo)",
        connection_id,
        offer_docno: docNo
      });
    }

    // ---- NEW: Bulk-hämta alla befintliga rows för den här offerten ----
    // Detta ersätter N st bubbleFind(ft_unique_key=...) (dyrt i WU).
    const PAGE_SIZE = 100;
    const MAX_PAGES = 2000; // safety
    const existingByKey = {};
    let bulk_ok = false;

    try {
      let cursor = 0;
      let pages = 0;
      let prevFirstId = null;

      while (pages < MAX_PAGES) {
        pages++;

        // OBS: om din bubbleFind inte stödjer cursor så kan den ignorera cursor,
        // därför har vi "repeat detection" nedan som breaks.
        const page = await bubbleFind("FortnoxOfferRow", {
          constraints: [{ key: "offer", constraint_type: "equals", value: parent._id }],
          limit: PAGE_SIZE,
          cursor
        });

        if (!Array.isArray(page) || page.length === 0) break;

        const firstId = page?.[0]?._id || null;
        if (prevFirstId && firstId && firstId === prevFirstId) {
          // cursor verkar ignoreras → bryt och fall tillbaka till legacy-metod
          throw new Error("bubbleFind cursor seems unsupported (repeated first record)");
        }
        prevFirstId = firstId;

        for (const it of page) {
          if (it?.ft_unique_key && it?._id) {
            existingByKey[String(it.ft_unique_key)] = it._id;
          }
        }

        if (page.length < PAGE_SIZE) break;
        cursor += PAGE_SIZE;
      }

      bulk_ok = true;
    } catch (e) {
      bulk_ok = false;
      console.warn("[/fortnox/upsert/offer-rows] bulk prefetch failed, fallback to per-row find:", e?.message || e);
    }

    let created = 0, updated = 0, errors = 0;
    let first_error = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const uniqueKey = `OFFERROW_${row.RowId || i}_${connection_id}_${docNo}`;

      const payload = {
        connection: connection_id,
        offer: parent._id,
        ft_offer_document_number: docNo,
        ft_row_index: i + 1,
        ft_article_number: row.ArticleNumber || "",
        ft_description: row.Description || "",
        ft_quantity: row.Quantity ?? null,
        ft_unit: row.Unit || "",
        ft_price: toNumOrNull(row?.Price),
        ft_total: toNumOrNull(row?.Total),
        ft_unique_key: uniqueKey,
        ft_raw_json: JSON.stringify(row || {})
      };

      try {
        let existingId = null;

        if (bulk_ok) {
          existingId = existingByKey[uniqueKey] || null;
        } else {
          // legacy fallback (exakt som tidigare beteende)
          const found = await bubbleFind("FortnoxOfferRow", {
            constraints: [{ key: "ft_unique_key", constraint_type: "equals", value: uniqueKey }],
            limit: 1
          });
          if (found?.[0]?._id) existingId = found[0]._id;
        }

        if (existingId) {
          await bubblePatch("FortnoxOfferRow", existingId, payload);
          updated++;
        } else {
          await bubbleCreate("FortnoxOfferRow", payload);
          created++;
        }
      } catch (e) {
        errors++;
        if (!first_error) {
          first_error = {
            row_index: i + 1,
            message: e?.message || String(e),
            detail: e?.detail || null
          };
        }
      }
    }

    try {
      await bubblePatch("FortnoxOffer", parent._id, {
        rows_last_synced_at: new Date().toISOString(),
        needs_rows_sync: false
      });
    } catch (e) {
      errors++;
      if (!first_error) first_error = { message: "Failed to patch parent offer", detail: e?.detail || null };
    }

    return res.json({
      ok: true,
      connection_id,
      offer_docno: docNo,
      rows_count: rows.length,
      counts: { created, updated, errors },
      first_error,
      bulk_prefetch: { ok: bulk_ok, keys: bulk_ok ? Object.keys(existingByKey).length : 0 },
      ms: Date.now() - t0
    });
  } catch (e) {
    console.error("[/fortnox/upsert/offer-rows] fatal", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


// ────────────────────────────────────────────────────────────
// Fortnox: sync ONE offer (fetch offer + OfferRows)
app.post("/fortnox/sync/offers/one", requireApiKey, async (req, res) => {
  try {
    const { connection_id, offer_docno } = req.body || {};
    const docNo = String(offer_docno || "").trim();

    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
    if (!docNo) return res.status(400).json({ ok: false, error: "Missing offer_docno" });

    const tok = await ensureFortnoxAccessToken(connection_id);
    if (!tok.ok) {
      return res.status(401).json({
        ok: false,
        error: tok.error || "Token error",
        detail: tok.detail || null
      });
    }

    const r = await fortnoxGet("/offers/" + encodeURIComponent(docNo), tok.access_token);
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false,
        status: r.status || 500,
        data: r.data || null,
        url: r.url || null
      });
    }

    const offer = r.data?.Offer || r.data?.offer || null;
    const rows = Array.isArray(offer?.OfferRows) ? offer.OfferRows : [];

    return res.json({
      ok: true,
      connection_id,
      offer_docno: docNo,
      rows_count: rows.length,
      offer,
      rows
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Alias så att dina gamla kommandon funkar
app.post("/fortnox/sync/offer", requireApiKey, async (req, res) => {
  try {
    const r = await fetch(`${SELF_BASE_URL}/fortnox/sync/offers/one`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify(req.body || {})
    });

    const text = await r.text();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }

    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────
// Fortnox: upsert ALL invoices pages (NO rows) – pages via /fortnox/upsert/invoices meta
app.post("/fortnox/upsert/invoices/all", requireApiKey, async (req, res) => {
  try {
    const {
      connection_id,
      start_page = 1,
      limit = 100,
      months_back = 12,
      max_pages = 9999,
      pause_ms = 250
    } = req.body || {};

    if (!connection_id) {
      return res.status(400).json({ ok: false, error: "Missing connection_id" });
    }

    const mb = Math.max(1, Number(months_back) || 12);
    const perPage = Math.max(1, Math.min(500, Number(limit) || 100));
    const maxPages = Math.max(1, Number(max_pages) || 9999);
    const pauseMs = Math.max(0, Number(pause_ms) || 0);

    // Robust ORIGIN för self-calls
    const ORIGIN =
      (typeof SELF_BASE_URL !== "undefined" && SELF_BASE_URL) ||
      (typeof BASE_URL !== "undefined" && BASE_URL) || // sista fallback (brukar vara Bubble – men bättre än null)
      `http://127.0.0.1:${process.env.PORT || 10000}`;

    const apiKey =
      (typeof RENDER_API_KEY !== "undefined" && RENDER_API_KEY) ||
      process.env.MIRA_RENDER_API_KEY ||
      process.env.MIRA_EXCHANGE_API_KEY ||
      null;

    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "No Render API key resolved (RENDER_API_KEY/MIRA_RENDER_API_KEY)" });
    }

    let page = Math.max(1, Number(start_page) || 1);
    let pages_done = 0;

    let created = 0, updated = 0, skipped = 0, errors = 0;
    let first_error = null;

    const callUpsertInvoicesPage = async (body) => {
      const controller = new AbortController();
      const timeoutMs = 180000; // 3 min per sida (justera vid behov)
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const url = String(ORIGIN).replace(/\/+$/, "") + "/fortnox/upsert/invoices";

      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.ok) {
          return { ok: false, status: r.status, detail: j };
        }
        return j;
      } finally {
        clearTimeout(timer);
      }
    };

    while (pages_done < maxPages) {
      const j = await callUpsertInvoicesPage({
        connection_id,
        page,
        limit: perPage,
        months_back: mb,
        pause_ms: 0 // undvik dubbel-paus (vi pausar här i /all)
      });

      if (!j?.ok) {
        return res.status(400).json({
          ok: false,
          error: "upsert/invoices failed",
          connection_id,
          page,
          detail: j
        });
      }

      created += Number(j?.counts?.created || 0);
      updated += Number(j?.counts?.updated || 0);
      skipped += Number(j?.counts?.skipped || 0);
      errors += Number(j?.counts?.errors || 0);
      if (!first_error && j?.first_error) first_error = j.first_error;

      pages_done++;

      const meta = j?.meta || null;
      const totalPagesRaw = meta?.["@TotalPages"] ?? meta?.TotalPages ?? null;
      const totalPages = totalPagesRaw ? Number(totalPagesRaw) : null;

      // docs på sidan – robust om j.docs saknas
      const docsThisPage =
        Number(
          j?.docs ??
          j?.debug_counts?.fetched ??
          j?.debug_counts?.kept_by_date ??
          (Array.isArray(j?.invoices) ? j.invoices.length : 0) ??
          0
        ) || 0;

      // Stopvillkor #1: Fortnox total pages och vi är klara
      if (totalPages && page >= totalPages) break;

      // Stopvillkor #2: inga docs på denna sida (vanligt vid filter)
      if (!docsThisPage) break;

      page++;

      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    }

    const done = pages_done >= maxPages ? false : true; // "true" betyder "vi stannade pga stopvillkor", inte pga max_pages

    return res.json({
      ok: true,
      connection_id,
      months_back: mb,
      start_page: Math.max(1, Number(start_page) || 1),
      limit: perPage,
      pages_done,
      next_page: page,          // nästa sida att köra om du fortsätter senare
      done,                     // true om vi stoppade naturligt (slut/0 docs), annars false om vi nådde max_pages
      counts: { created, updated, skipped, errors },
      first_error
    });
  } catch (e) {
    console.error("[/fortnox/upsert/invoices/all] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────
// Fortnox: upsert offers - batch loop (N pages per run)
app.post("/fortnox/upsert/offers/all", async (req, res) => {
  const {
    connection_id,
    start_page = 1,
    limit = 100,
    max_pages = 10
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok:false, error:"Missing connection_id" });

  const start = numOr(start_page, 1);
  const lim = Math.max(1, Math.min(500, numOr(limit, 100)));
  const maxP = Math.max(1, numOr(max_pages, 10));

  let page = start;
  let created = 0, updated = 0, errors = 0;
  let totalPages = null;

  try {
    for (let i = 0; i < maxP; i++) {
      const r = await fetch(`${SELF_BASE_URL}/fortnox/upsert/offers`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, page, limit: lim })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        return res.status(400).json({ ok:false, error:"upsert/offers failed", page, detail:j });
      }

      created += j.counts?.created || 0;
      updated += j.counts?.updated || 0;

      // meta kommer från sync/offers -> MetaInformation
      const meta = j.meta || null;
      const cur = numOr(meta?.["@CurrentPage"], page);
      const tot = numOr(meta?.["@TotalPages"], 0);
      if (tot) totalPages = tot;

      if (tot && cur >= tot) {
        return res.json({
          ok: true,
          connection_id,
          done: true,
          start_page: start,
          end_page: cur,
          total_pages: tot,
          counts: { created, updated, errors },
          next_page: 1
        });
      }

      // fallback om meta saknas: om vi skapade/uppdaterade 0 och limit är fullt osäkert -> vi fortsätter ändå
      page = cur + 1;
    }

    return res.json({
      ok: true,
      connection_id,
      done: false,
      start_page: start,
      end_page: page - 1,
      total_pages: totalPages,
      counts: { created, updated, errors },
      next_page: page
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
});
// ────────────────────────────────────────────────────────────
app.post("/fortnox/nightly/delta", requireApiKey, async (req, res) => {
  const lock = getLock();
  const now = Date.now();
  const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

  const { connection_id = null, only_connection_id = null, months_back = 12 } = req.body || {};
  const onlyId = (only_connection_id || connection_id || null);
  const mb = Math.max(1, Number(months_back) || 12);

  // stale lock clear
  if (lock.running && lock.started_at && (now - lock.started_at > LOCK_TTL_MS)) {
    console.warn("[nightly/delta] stale lock cleared", { ...lock, age_ms: now - lock.started_at });
    lock.running = false;
    lock.started_at = 0;
    lock.finished_at = 0;
    lock.connection_id = null;
    lock.run_id = null;
  }
  if (lock.running) return res.status(409).json({ ok: false, error: "Nightly already running", lock });

  lock.running = true;
  lock.started_at = now;
  lock.finished_at = 0;
  lock.connection_id = onlyId;
  lock.run_id = `${now}-${Math.random().toString(16).slice(2)}`;

  try {
    const connections = await getAllFortnoxConnections();
    const pick = onlyId
      ? connections.filter(c => String(c?._id || "") === String(onlyId))
      : connections;

    const results = [];

    for (const conn of pick) {
      const cid = conn._id;
      const one = { connection_id: cid, ok: false, steps: {} };

      try {
        // 1) customers (1 sida delta)
        const customersJ = await postInternalJson("/fortnox/upsert/customers", {
          connection_id: cid, page: 1, limit: 100
        }, 120000);

        one.steps.customers = { ok: true, counts: customersJ.counts || null };

        // 2) orders (1 sida delta, months_back)
        const ordersJ = await postInternalJson("/fortnox/upsert/orders", {
          connection_id: cid, months_back: mb, page: 1, limit: 50
        }, 180000);

        one.steps.orders = { ok: true, counts: ordersJ.counts || null };

        // 3) order rows flagged (några varv)
        for (let round = 0; round < 5; round++) {
          const rowsJ = await postInternalJson("/fortnox/upsert/order-rows/flagged", {
            connection_id: cid, limit: 30, pause_ms: 250
          }, 180000);
          if (!rowsJ.flagged_found) break;
        }
        one.steps.order_rows = { ok: true };

        // 4) offers (call once, persist next_page)
        const startOffers = await getConnNextPage(cid, "offers_next_page", 1);
        const offersJ = await postInternalJson("/fortnox/upsert/offers/all", {
          connection_id: cid, start_page: startOffers, limit: 100, max_pages: 5
        }, 15 * 60 * 1000);

        one.steps.offers = { ok: true, done: !!offersJ.done, next_page: offersJ.next_page ?? null, counts: offersJ.counts || null };

        await safeSetConnPaging(cid, {
          offers_next_page: offersJ?.next_page || 1,
          offers_last_progress_at: nowIso(),
          ...(offersJ?.done ? { offers_last_full_sync_at: nowIso() } : {})
        });

        // 5) offer rows flagged
        for (let round = 0; round < 5; round++) {
          const rowsJ = await postInternalJson("/fortnox/upsert/offer-rows/flagged", {
            connection_id: cid, limit: 30, pause_ms: 250
          }, 180000);
          if (!rowsJ.flagged_found) break;
        }
        one.steps.offer_rows = { ok: true };

        // 6) invoices (call once, persist next_page)
        const startInv = await getConnNextPage(cid, "invoices_next_page", 1);
        const invoicesJ = await postInternalJson("/fortnox/upsert/invoices/all", {
          connection_id: cid, start_page: startInv, limit: 50, max_pages: 5, months_back: mb
        }, 15 * 60 * 1000);

        one.steps.invoices = { ok: true, done: !!invoicesJ.done, next_page: invoicesJ.next_page ?? null, counts: invoicesJ.counts || null };

        await safeSetConnPaging(cid, {
          invoices_next_page: invoicesJ?.next_page || 1,
          invoices_last_progress_at: nowIso(),
          ...(invoicesJ?.done ? { invoices_last_full_sync_at: nowIso() } : {})
        });

        one.ok = true;
        await safeSetConnPaging(cid, { nightly_last_run_at: nowIso(), nightly_last_error: "" });

      } catch (e) {
        one.ok = false;
        one.error = e?.message || String(e);
        console.error("[nightly/delta] conn error", { connection_id: cid, error: one.error, detail: e?.detail || null });
        await safeSetConnPaging(cid, { nightly_last_run_at: nowIso(), nightly_last_error: one.error });
      }

      results.push(one);
    }

    return res.json({ ok: true, run_id: lock.run_id, months_back: mb, results });

  } catch (e) {
    console.error("[nightly/delta] fatal", e);
    return res.status(500).json({ ok: false, run_id: lock.run_id, error: e?.message || String(e) });
  } finally {
    lock.running = false;
    lock.finished_at = Date.now();
    console.log("[nightly/delta] finished", { run_id: lock.run_id, finished_at: lock.finished_at });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: Nightly orchestrator – kör ALLA connections i rätt ordning
app.post("/fortnox/nightly/run", requireApiKey, async (req, res) => {
  const lock = getLock();
  const now = Date.now();
  const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

  let acquired = false;
  let myRunId = null;

  try {
    if (lock.running && lock.started_at && (now - lock.started_at > LOCK_TTL_MS)) {
      console.warn("[nightly/run] stale lock cleared", { ...lock, age_ms: now - lock.started_at });
      lock.running = false;
      lock.started_at = 0;
      lock.finished_at = 0;
      lock.connection_id = null;
      lock.run_id = null;
    }
    if (lock.running) return res.status(409).json({ ok: false, error: "Nightly already running", lock });

    myRunId = `${now}-${Math.random().toString(16).slice(2)}`;
    lock.running = true;
    lock.started_at = now;
    lock.finished_at = 0;
    lock.connection_id = null;
    lock.run_id = myRunId;
    acquired = true;

    const body = req.body || {};
    const months_back = Math.max(1, Number(body.months_back ?? 12) || 12);

    const cfg = {
      customers: {
        limit: Number(body?.customers?.limit ?? 500) || 500,
        max_pages: Number(body?.customers?.max_pages ?? 30) || 30,
        pause_ms: Number(body?.customers?.pause_ms ?? 50) || 50,
        skip_without_orgnr: true,
        link_company: true
      },
      orders: {
        limit: Number(body?.orders?.limit ?? 200) || 200,
        pages_per_call: Number(body?.orders?.max_pages ?? 5) || 5,
        pause_ms: Number(body?.orders?.pause_ms ?? 150) || 150
      },
      offers: {
        limit: Number(body?.offers?.limit ?? 200) || 200,
        pages_per_call: Number(body?.offers?.max_pages ?? 5) || 5,
        pause_ms: Number(body?.offers?.pause_ms ?? 150) || 150
      },
      invoices: {
        limit: Number(body?.invoices?.limit ?? 200) || 200,
        pages_per_call: Number(body?.invoices?.max_pages ?? 5) || 5,
        pause_ms: Number(body?.invoices?.pause_ms ?? 150) || 150
      },
      rows: {
        limit: Number(body?.rows?.limit ?? 30) || 30,
        passes: Number(body?.rows?.passes ?? 20) || 20,
        pause_ms: Number(body?.rows?.pause_ms ?? 250) || 250
      }
    };

    const conns = await getAllFortnoxConnections();
    const results = [];

    for (const c of conns) {
      const connection_id = c._id;
      const one = { connection_id, customers: null, orders: null, offers: null, invoices: null, errors: [] };

      try {
        // CUSTOMERS (call once + persist)
        const startCustomers = await getConnNextPage(connection_id, "customers_next_page", 1);
        const customersJ = await postInternalJson("/fortnox/upsert/customers/all", {
          connection_id,
          start_page: startCustomers,
          limit: cfg.customers.limit,
          max_pages: cfg.customers.max_pages,
          pause_ms: cfg.customers.pause_ms,
          skip_without_orgnr: cfg.customers.skip_without_orgnr,
          link_company: cfg.customers.link_company
        }, 180000);

        one.customers = { done: !!customersJ.done, next_page: customersJ.next_page ?? null, counts: customersJ.counts || null };

        await safeSetConnPaging(connection_id, {
          customers_next_page: customersJ?.next_page || 1,
          customers_last_progress_at: nowIso(),
          ...(customersJ?.done ? { customers_last_full_sync_at: nowIso() } : {})
        });

        // ORDERS (call once + persist)
        const startOrders = await getConnNextPage(connection_id, "orders_next_page", 1);
        const ordersJ = await postInternalJson("/fortnox/upsert/orders/all", {
          connection_id,
          start_page: startOrders,
          limit: cfg.orders.limit,
          max_pages: cfg.orders.pages_per_call,
          months_back
        }, 180000);

        one.orders = { done: !!ordersJ.done, next_page: ordersJ.next_page ?? null, counts: ordersJ.counts || null };

        await safeSetConnPaging(connection_id, {
          orders_next_page: ordersJ?.next_page || 1,
          orders_last_progress_at: nowIso(),
          ...(ordersJ?.done ? { orders_last_full_sync_at: nowIso() } : {})
        });

        // ORDER ROWS (flagged)
        for (let p = 0; p < cfg.rows.passes; p++) {
          const rowsJ = await postInternalJson("/fortnox/upsert/order-rows/flagged", {
            connection_id, limit: cfg.rows.limit, pause_ms: cfg.rows.pause_ms
          }, 180000);
          if (!rowsJ.flagged_found) break;
          if (cfg.rows.pause_ms) await sleep(Number(cfg.rows.pause_ms));
        }

        // OFFERS (call once + persist)
        const startOffers = await getConnNextPage(connection_id, "offers_next_page", 1);
        const offersJ = await postInternalJson("/fortnox/upsert/offers/all", {
          connection_id,
          start_page: startOffers,
          limit: cfg.offers.limit,
          max_pages: cfg.offers.pages_per_call
        }, 180000);

        one.offers = { done: !!offersJ.done, next_page: offersJ.next_page ?? null, counts: offersJ.counts || null };

        await safeSetConnPaging(connection_id, {
          offers_next_page: offersJ?.next_page || 1,
          offers_last_progress_at: nowIso(),
          ...(offersJ?.done ? { offers_last_full_sync_at: nowIso() } : {})
        });

        // OFFER ROWS (flagged)
        for (let p = 0; p < cfg.rows.passes; p++) {
          const rowsJ = await postInternalJson("/fortnox/upsert/offer-rows/flagged", {
            connection_id, limit: cfg.rows.limit, pause_ms: cfg.rows.pause_ms
          }, 180000);
          if (!rowsJ.flagged_found) break;
          if (cfg.rows.pause_ms) await sleep(Number(cfg.rows.pause_ms));
        }

        // INVOICES (call once + persist)
        const startInv = await getConnNextPage(connection_id, "invoices_next_page", 1);
        const invoicesJ = await postInternalJson("/fortnox/upsert/invoices/all", {
          connection_id,
          start_page: startInv,
          limit: cfg.invoices.limit,
          max_pages: cfg.invoices.pages_per_call,
          months_back
        }, 180000);

        one.invoices = { done: !!invoicesJ.done, next_page: invoicesJ.next_page ?? null, counts: invoicesJ.counts || null };

        await safeSetConnPaging(connection_id, {
          invoices_next_page: invoicesJ?.next_page || 1,
          invoices_last_progress_at: nowIso(),
          ...(invoicesJ?.done ? { invoices_last_full_sync_at: nowIso() } : {})
        });

      } catch (e) {
        one.errors.push({ message: e?.message || String(e), detail: e?.detail || null });
      }

      results.push(one);
      if (cfg.customers.pause_ms) await sleep(Number(cfg.customers.pause_ms));
    }

    return res.json({ ok: true, run_id: myRunId, months_back, config: cfg, connections: conns.length, results });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
  } finally {
    if (acquired && lock.run_id === myRunId) {
      lock.running = false;
      lock.finished_at = Date.now();
      console.log("[nightly/run] finished", { run_id: lock.run_id, finished_at: lock.finished_at });
    }
  }
});
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
// HTML → text (för Lead.Description m.m.)
// (Använder befintlig decodeHtmlEntities() som redan finns i din fil)
function htmlToText(input, { maxLen = 8000 } = {}) {
  if (input == null) return "";
  let s = String(input);

  s = s.replace(/\r\n/g, "\n");

  // Ta bort Outlook mobile signature-block om det finns
  s = s.replace(/<div[^>]+id=["']ms-outlook-mobile-signature["'][\s\S]*?<\/div>/gi, "");

  // Byt ut radbrytande taggar → \n
  s = s
    .replace(/<(br|br\/)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<\/td>/gi, "  ");

  // Ta bort scripts/styles
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Ta bort alla övriga taggar
  s = s.replace(/<[^>]+>/g, "");

  // Decode entities (din befintliga funktion)
  s = decodeHtmlEntities(s);

  // Städa whitespace
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Klipp längd
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen - 1).trim() + "…";
  return s;
}
// ────────────────────────────────────────────────────────────
// Render-first Mail Polling (Graph delta) → Bubble Data API
// Bubble types (EXACT):
//  - MailPollState: mailbox_upn (text), delta_link (text), last_run_at (date), last_error (text)
//  - InboundEmail : graph_message_id (text), mailbox_upn (text), from_email (text), received_at (date), subject (text), lead (Lead)
//  - Lead         : Name (text), Email (text), Phone (text), Company (text), Description (text)

// Small helpers
const normEmail = (s) => String(s || "").trim().toLowerCase();
const safeText = (s, max = 5000) => {
  const t = String(s || "").replace(/\u0000/g, "").trim();
  return t.length > max ? t.slice(0, max) : t;
};

function resolveTenantFromBodyOrReq(req) {
  // Prefer body.tenant, then header/query, else your existing DEFAULT_TENANT
  return pick(
    req.body?.tenant,
    req.query?.tenant,
    req.headers["x-tenant-id"],
    DEFAULT_TENANT
  );
}
function guessCompanyFromEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return "";

  // plocka domän
  let domain = e.split("@").pop() || "";
  domain = domain.replace(/^mail\./, "").replace(/^m\./, "").replace(/^smtp\./, "");

  // om det är en vanlig privat maildomän -> lämna tomt
  const publicDomains = new Set([
    "gmail.com","googlemail.com","icloud.com","me.com",
    "outlook.com","hotmail.com","live.com","msn.com",
    "yahoo.com","yahoo.se",
    "proton.me","protonmail.com",
    "aol.com",
    "telia.com","telia.se","comhem.se","bahnhof.se",
    "bredband.net","ownit.se"
  ]);
  if (publicDomains.has(domain)) return "";

  // ta "företagsnamn" från domänen (första labeln)
  const label = (domain.split(".")[0] || "").trim();
  if (!label) return "";

  // lite snyggare display
  const pretty = label
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return pretty ? (pretty.charAt(0).toUpperCase() + pretty.slice(1)) : "";
}
function extractPhoneNumber(input) {
  const s = String(input || "");
  if (!s) return "";

  // Leta efter något som liknar ett telefonnummer (svenskt + internationellt)
  // Ex: 070-123 45 67, +46 70 123 45 67, 08-123456, 031 840850
  const m = s.match(/(\+?\d[\d\s().-]{6,}\d)/);
  if (!m) return "";

  let raw = m[1];

  // Rensa bort allt utom siffror och + i början
  raw = raw.replace(/[^\d+]/g, "");

  // Normalisera "00" -> "+"
  if (raw.startsWith("00")) raw = "+" + raw.slice(2);

  // Om den börjar med +, behåll + och siffror
  if (raw.startsWith("+")) {
    // säkerhetsklipp
    return raw.slice(0, 20);
  }

  // Annars: bara siffror, klipp rimligt
  const digits = raw.replace(/\D/g, "");
  return digits.slice(0, 20);
}
// -------------------------
// Bubble: MailPollState
async function getOrCreateMailPollState(mailbox_upn) {
  const mb = normEmail(mailbox_upn);
  if (!mb) throw new Error("mailbox_upn is required");

  const existing = await bubbleFindOne("MailPollState", [
    { key: "mailbox_upn", constraint_type: "equals", value: mb }
  ]);

  if (existing?._id) return existing;

  const id = await bubbleCreate("MailPollState", {
    mailbox_upn: mb,
    delta_link: "",
    last_run_at: new Date().toISOString(),
    last_error: ""
  });

  const created = await bubbleGet("MailPollState", id);
  return created;
}

async function updateMailPollState(id, patch) {
  if (!id) throw new Error("updateMailPollState: missing id");
  if (!patch || typeof patch !== "object") return;

  // Bubble kan ge 400 "Unrecognized field: X" om datatypen saknar fältet.
  // Vi gör därför en liten "self-heal": droppa okända fält och försök igen 1 gång.
  const attempt = async (p) => bubblePatch("MailPollState", id, p);

  let r = await attempt(patch);
  if (r?.ok) return r;

  const msg = r?.detail?.body?.body?.message || r?.detail?.body?.message || "";
  const m = String(msg).match(/Unrecognized field:\s*([A-Za-z0-9_]+)/);
  if (m?.[1]) {
    const bad = m[1];
    const p2 = { ...patch };
    delete p2[bad];
    if (Object.keys(p2).length === 0) return r;
    const r2 = await attempt(p2);
    return r2;
  }
  return r;
}

// -------------------------
// Bubble: InboundEmail (idempotens)
async function findInboundEmailByMessageId(mailbox_upn, graph_message_id) {
  const mb = normEmail(mailbox_upn);
  const mid = String(graph_message_id || "").trim();
  if (!mb || !mid) return null;

  const existing = await bubbleFindOne("InboundEmail", [
    { key: "mailbox_upn", constraint_type: "equals", value: mb },
    { key: "graph_message_id", constraint_type: "equals", value: mid }
  ]);

  return existing || null;
}

async function createInboundEmail(mailbox_upn, msg) {
  const from_email = normEmail(msg?.from?.emailAddress?.address || msg?.sender?.emailAddress?.address || "");
  const subject = safeText(msg?.subject || "", 500);
  const received_at = msg?.receivedDateTime || null;
  const graph_message_id = String(msg?.id || "");

  // Raw body fields (for debugging + better parsing later)
  const body_preview = safeText(msg?.bodyPreview || "", 5000);
  const body_type = safeText(msg?.body?.contentType || "", 50);
  const body_content = safeText(msg?.body?.content || "", 50000);

  const payload = {
    mailbox_upn: normEmail(mailbox_upn),
    from_email,
    subject,
    received_at,
    graph_message_id,
    body_preview,
    body_type,
    body_content
  };

  const id = await bubbleCreate("InboundEmail", payload);
  return id;
}

// -------------------------
// Lead parsing (enkelt men robust)
// ---- Lead extraction + normalization (email -> Lead)

// Convert raw HTML/text body into readable plain text (keep it robust and not too aggressive)
function normalizeMailBodyToText({ contentType, content, fallbackPreview }) {
  const ct = String(contentType || "").toLowerCase();
  let raw = String(content || "");

  // Prefer full body if present, else fallback to preview
  if (!raw.trim()) raw = String(fallbackPreview || "");

  let txt = raw;
  if (ct === "html" || /<\w+[^>]*>/.test(raw)) {
    txt = htmlToText(raw);
  }

  // Normalize whitespace
  txt = txt.replace(/\r\n/g, "\n");
  txt = txt.replace(/[\t\f\v]+/g, " ");
  txt = txt.replace(/\n{3,}/g, "\n\n");
  return txt.trim();
}

function stripCommonSignature(text) {
  const t = String(text || "");
  if (!t) return "";

  const markers = [
    "Vänliga hälsningar",
    "Med vänlig hälsning",
    "Med vänliga hälsningar",
    "Mvh",
    "MVH",
    "Regards",
    "Best regards",
    "Kind regards",
    "Sent from my",
    "Skickat från",
    "--"
  ];

  // Cut at first marker occurrence that is not too early
  let cutAt = -1;
  for (const mk of markers) {
    const i = t.indexOf(mk);
    if (i >= 0) {
      if (cutAt === -1 || i < cutAt) cutAt = i;
    }
  }

  if (cutAt >= 0 && cutAt > 40) {
    return t.slice(0, cutAt).trim();
  }
  return t.trim();
}

function pickFirstRealEmail(text, mailbox_upn) {
  const hay = String(text || "");
  const mb = normEmail(mailbox_upn);
  const matches = hay.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const e of matches) {
    const ne = normEmail(e);
    if (!ne) continue;
    // Avoid picking the shared mailbox address itself
    if (mb && ne === mb) continue;
    return ne;
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// Extract fields for new Lead based on inbound email
function extractLeadFieldsFromMessage(msg) {
  if (!msg) return {};

  const subject = safeText(msg?.subject || "", 300);
  const bodyPreview = msg?.bodyPreview || "";
  const bodyContent = msg?.body?.content || "";
  const bodyType = msg?.body?.contentType || "";
  const fromEmail = normEmail(msg?.from?.emailAddress?.address);
  const fromName = safeText(msg?.from?.emailAddress?.name || "", 200);

  // Clean up the HTML body to readable text
  const core =
    bodyType === "html"
      ? decodeHtmlEntities(
          bodyContent
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<\/?[^>]+(>|$)/g, " ")
        )
      : decodeHtmlEntities(bodyContent || bodyPreview || "");

  const description = safeText(core, 8000);
  const name = fromName || fromEmail?.split("@")[0] || "Okänd";
  const company = guessCompanyFromEmail(fromEmail);
  const leadEmail = fromEmail || "";
  const phone = extractPhoneNumber(core);

  // Short description = body_preview (or fallback) – tightened & clean
  const description_short = tightenShort(bodyPreview || core, 220);

  return {
    Name: name,
    Email: leadEmail,
    Phone: phone,
    Company: company,
    Description: description,
    Description_short: description_short,
    // Option set value (Display) – assumes Lead has field "Source" (type: lead_source)
    Source: "info@carotte.se"
  };
}

// ────────────────────────────────────────────────────────────
// Helper: clean up and shorten description text
function tightenShort(str, maxLen = 220) {
  if (!str) return "";
  return safeText(String(str), maxLen * 3)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?p[^>]*>/gi, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}
// Bubble: Create NEW Lead for every inbound (no upsert)
async function createLeadAlways(fields) {
  const email = normEmail(fields?.Email);
  if (!email) return { ok: false, error: "Lead Email missing" };

  const base = {
    Name: safeText(fields?.Name || "", 200),
    Email: email,
    Phone: safeText(fields?.Phone || "", 100),
    Company: safeText(fields?.Company || "", 200),

    // Långa beskrivningen (som du redan bygger)
    Description: safeText(fields?.Description || "", 8000),

    // Kort beskrivning (du bad om body_preview -> Description_short)
    Description_short: safeText(fields?.Description_short || "", 500),

    // Option set "lead_source" - sätt displayvärdet exakt som i option set
    Source: safeText(fields?.Source || "info@carotte.se", 200),
  };

  const id = await bubbleCreate("Lead", base);
  return { ok: true, lead_id: id, created: true };
}
// -------------------------
// Graph: delta fetch (delegated) with pagination
async function graphDeltaFetchAll({ tenant, mailbox_upn, delta_link, top = 25, auth_user_id }) {
  const mailbox = normEmail(mailbox_upn);
  if (!mailbox) throw new Error("mailbox_upn is required");
  if (!auth_user_id) throw new Error("auth_user_id is required for delegated mail polling");

  // ✅ DELEGATED token (from Bubble user)
  const tok = await getDelegatedTokenForUser(auth_user_id, {
    tenant: tenant || MS_TENANT,
    scope: MS_SCOPE
  });

  const token = tok.access_token;

  let url = delta_link && String(delta_link).trim()
    ? String(delta_link).trim()
    : `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages/delta?$top=${encodeURIComponent(top)}&$select=id,receivedDateTime,subject,from,sender,bodyPreview,body`;

  const all = [];
  let next = null;
  let finalDelta = null;

  while (true) {
    const data = await graphFetch("GET", url, token);

    const value = Array.isArray(data?.value) ? data.value : [];
    all.push(...value);

    next = data?.["@odata.nextLink"] || null;
    finalDelta = data?.["@odata.deltaLink"] || finalDelta;

    if (next) {
      url = next;
      continue;
    }
    break;
  }

  return { messages: all, delta_link: finalDelta || "" };
}

// Fetch a single message (full body) by Graph message id
async function graphGetMessageById({ tenant, mailbox_upn, message_id, auth_user_id }) {
  const mb = encodeURIComponent(String(mailbox_upn || "").trim());
  const mid = encodeURIComponent(String(message_id || "").trim());
  if (!mb) throw new Error("mailbox_upn required");
  if (!mid) throw new Error("message_id required");

  const url = `https://graph.microsoft.com/v1.0/users/${mb}/messages/${mid}?$select=id,receivedDateTime,subject,from,sender,bodyPreview,body`;
  return await graphDelegatedFetchJson({ tenant, auth_user_id, url });
}

// Delegated Graph fetch with one refresh+retry on 401
async function graphDelegatedFetchJson({ tenant, auth_user_id, url, method = "GET", headers = {}, body = null }) {
  const tok = await getDelegatedTokenForUser(auth_user_id, { tenant });
  const doFetch = async (accessToken) => {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...headers
      },
      body
    });
    const text = await r.text().catch(() => "");
    let j = null
    try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
    return { r, j };
  };

  // First try
  let out = await doFetch(tok.access_token);

  // If token expired/invalid, try refresh once and retry
  if (out.r.status === 401 && tok.refresh_token) {
    const ref = await tokenExchange({
      refresh_token: tok.refresh_token,
      scope: tok.scope || MS_SCOPE,
      tenant: tenant || MS_TENANT
    });

    if (ref.ok) {
      const newRefresh = ref.data.refresh_token || tok.refresh_token;
      await upsertTokensToBubble(auth_user_id, ref.data, newRefresh);
      out = await doFetch(ref.data.access_token);
    }
  }

  if (!out.r.ok) {
    const err = new Error(`Graph ${method} ${url} failed ${out.r.status}`);
    err.detail = out.j;
    throw err;
  }

  return out.j;
}
// ────────────────────────────────────────────────────────────
// Routes: Jobs
function isMsTokenExpiredError(e) {
  const msg = String(e?.message || "").toLowerCase();
  const innerMsg = String(e?.detail?.error?.message || "").toLowerCase();
  return (
    e?.status === 401 ||
    msg.includes("failed 401") ||
    msg.includes("token is expired") ||
    innerMsg.includes("token is expired") ||
    innerMsg.includes("lifetime validation failed") ||
    innerMsg.includes("invalidauthenticationtoken")
  );
}

// Hämtar delegated token för auth_user_id från Bubble och refreshar vid behov
async function getDelegatedAccessTokenForUser({ auth_user_id, tenant, force_refresh = false }) {
  const u = await fetchBubbleUser(auth_user_id);
  const accessToken = u?.ms_access_token || null;
  const refreshToken = u?.ms_refresh_token || null;
  const scope = u?.ms_scope || u?.scope || null;

  if (!refreshToken) {
    const err = new Error("User has no ms_refresh_token in Bubble (cannot refresh)");
    err.status = 401;
    throw err;
  }

  if (accessToken && !force_refresh) {
    return { access_token: accessToken, refresh_token: refreshToken, scope };
  }

  const ref = await tokenExchange({ refresh_token: refreshToken, scope, tenant });
  if (!ref.ok) {
    const err = new Error("Delegated refresh failed");
    err.status = ref.status || 401;
    err.detail = ref.data || null;
    throw err;
  }

  const newRefresh = ref.data.refresh_token || refreshToken;
  await upsertTokensToBubble(auth_user_id, ref.data, newRefresh);

  return { access_token: ref.data.access_token, refresh_token: newRefresh, scope: ref.data.scope || scope };
}

// Hämtar inbox-messages via delta och följer ev. paging (nextLink)
async function graphMailDeltaFetchAll({ mailbox_upn, top, delta_link, access_token }) {
  const mailboxEnc = encodeURIComponent(String(mailbox_upn).trim().toLowerCase());

  // Start-URL: antingen delta_link (om vi har) eller första delta-call
  let url = (delta_link && String(delta_link).trim())
    ? String(delta_link).trim()
    : `${GRAPH_BASE}/users/${mailboxEnc}/mailFolders('Inbox')/messages/delta?$top=${encodeURIComponent(String(top || 25))}`
      + `&$select=id,receivedDateTime,subject,from,sender,bodyPreview,body`;

  const messages = [];
  let safety = 0;
  let finalDelta = "";

  while (url && safety < 20) { // säkerhetsbälte
    safety++;

    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + access_token }
    });
    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      const err = new Error(`Graph GET ${url} failed ${r.status}`);
      err.status = r.status;
      err.detail = j;
      throw err;
    }

    if (Array.isArray(j?.value)) messages.push(...j.value);

    // nästa sida eller deltaLink
    url = j["@odata.nextLink"] || "";
    finalDelta = j["@odata.deltaLink"] || finalDelta || "";
  }

  return { messages, delta_link: finalDelta };
}
// POST /jobs/mail/poll
// Body: { mailbox_upn:"info@carotte.se", auth_user_id:"<Bubble user id>", top?:25 }
app.post("/jobs/mail/poll", requireApiKey, async (req, res) => {
  const t0 = Date.now();

  const mailbox_upn = normEmail(req.body?.mailbox_upn);
  const auth_user_id =
    req.body?.auth_user_id ||
    req.body?.user_unique_id ||
    req.body?.u ||
    null;

  const top = Number(req.body?.top || 25);
  const tenant = resolveTenantFromBodyOrReq(req);

  if (!mailbox_upn) {
    return res.status(400).json({ ok: false, error: "mailbox_upn is required" });
  }
  if (!auth_user_id) {
    return res.status(400).json({ ok: false, error: "auth_user_id is required (Bubble user id that owns delegated token)" });
  }

  let state = null;
  let createdInbound = 0;
  let skippedInbound = 0;
  let createdLeads = 0;
  let updatedLeads = 0;
  let linked = 0;
  let errors = 0;
  let first_error = null;

  try {
    state = await getOrCreateMailPollState(mailbox_upn);

    // 1) Hämta delta (med auto-refresh + retry på 401 expired)
    let deltaRes = null;

    const runDelta = async ({ force_refresh = false } = {}) => {
      const tok = await getDelegatedAccessTokenForUser({ auth_user_id, tenant, force_refresh });
      return await graphMailDeltaFetchAll({
        tenant,
        mailbox_upn,
        delta_link: state?.delta_link || "",
        top: Number.isFinite(top) && top > 0 ? top : 25,
        access_token: tok.access_token
      });
    };

    try {
      deltaRes = await runDelta({ force_refresh: false });
    } catch (e) {
      // om expired → refresh + retry EN gång
      if (isMsTokenExpiredError(e)) {
        deltaRes = await runDelta({ force_refresh: true });
      } else {
        // om delta-state invalid (Graph 410 m.fl.) → spara fel och fail denna körning
        await updateMailPollState(state._id, {
          last_run_at: new Date().toISOString(),
          last_error: "Delta fetch failed: " + (e?.message || String(e))
        });
        throw e;
      }
    }

    const messages = Array.isArray(deltaRes?.messages) ? deltaRes.messages : [];

    // 2) Processa varje message idempotent via InboundEmail
    for (const msg of messages) {
      try {
        const graphId = String(msg?.id || "").trim();
        if (!graphId) { skippedInbound++; continue; }

        const existingInbound = await findInboundEmailByMessageId(mailbox_upn, graphId);
        if (existingInbound?._id) {
          skippedInbound++;
          continue;
        }

        // (Optional but recommended) fetch full message body again by id (delta can be truncated)
        let fullMsg = msg;
        try {
          fullMsg = await graphGetMessageById({ tenant, mailbox_upn, message_id: graphId, auth_user_id });
        } catch (e) {
          // If this fails, we still create the inbound from delta payload
          fullMsg = msg;
        }

        const inboundId = await createInboundEmail(mailbox_upn, fullMsg);
        createdInbound++;

        // Lead upsert
        const leadFields = extractLeadFieldsFromMessage(fullMsg, mailbox_upn);
        if (leadFields?.Email) {
          const up = await createLeadAlways(leadFields);
if (up.ok && up.lead_id) {
  createdLeads++; // alltid ny
  await bubblePatch("InboundEmail", inboundId, { lead: up.lead_id });
  linked++;
}
        }
      } catch (e) {
        errors++;
        if (!first_error) first_error = { message: e?.message || String(e), detail: e?.detail || null };
      }
    }

    // 3) Spara ny delta_link + last_run_at
    const newDelta = String(deltaRes?.delta_link || "").trim();
    await updateMailPollState(state._id, {
      delta_link: newDelta || state?.delta_link || "",
      last_run_at: new Date().toISOString(),
      last_error: errors ? (state?.last_error || "") : ""
    });

    return res.json({
      ok: true,
      mailbox_upn,
      tenant,
      auth_user_id,
      processed: messages.length,
      counts: {
        inbound_created: createdInbound,
        inbound_skipped_existing: skippedInbound,
        leads_created: createdLeads,
        leads_updated_or_appended: updatedLeads,
        inbound_linked_to_lead: linked,
        errors
      },
      first_error,
      ms: Date.now() - t0
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      mailbox_upn,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }
});


// POST /jobs/mail/message
// Body: { mailbox_upn, auth_user_id, graph_message_id, inbound_id?: "<Bubble InboundEmail id>" }
// Fetches a single message from Graph and (optionally) patches the Bubble InboundEmail with raw body fields.
app.post("/jobs/mail/message", requireApiKey, async (req, res) => {
  const mailbox_upn = normEmail(req.body?.mailbox_upn);
  const auth_user_id = req.body?.auth_user_id || req.body?.user_unique_id || req.body?.u || null;
  const graph_message_id = String(req.body?.graph_message_id || "").trim();
  const inbound_id = String(req.body?.inbound_id || "").trim();
  const tenant = resolveTenantFromBodyOrReq(req);

  if (!mailbox_upn) return res.status(400).json({ ok: false, error: "mailbox_upn is required" });
  if (!auth_user_id) return res.status(400).json({ ok: false, error: "auth_user_id is required" });
  if (!graph_message_id) return res.status(400).json({ ok: false, error: "graph_message_id is required" });

  try {
    const msg = await graphGetMessageById({ tenant, mailbox_upn, message_id: graph_message_id, auth_user_id });

    const patch = {
      body_preview: safeText(msg?.bodyPreview || "", 5000),
      body_type: safeText(msg?.body?.contentType || "", 50),
      body_content: safeText(msg?.body?.content || "", 50000)
    };

    if (inbound_id) {
      await bubblePatch("InboundEmail", inbound_id, patch);
    }

    return res.json({
      ok: true,
      mailbox_upn,
      auth_user_id,
      graph_message_id,
      inbound_id: inbound_id || null,
      patch,
      sample: {
        subject: safeText(msg?.subject || "", 500),
        receivedDateTime: msg?.receivedDateTime || null,
        from: msg?.from?.emailAddress?.address || null
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, mailbox_upn, graph_message_id, error: e?.message || String(e), detail: e?.detail || null });
  }
});

// GET /jobs/mail/status?mailbox_upn=info@carotte.se
app.get("/jobs/mail/status", requireApiKey, async (req, res) => {
  try {
    const mailbox_upn = normEmail(req.query?.mailbox_upn);
    if (!mailbox_upn) return res.status(400).json({ ok: false, error: "mailbox_upn is required" });

    const existing = await bubbleFindOne("MailPollState", [
      { key: "mailbox_upn", constraint_type: "equals", value: mailbox_upn }
    ]);

    return res.json({ ok: true, mailbox_upn, state: existing || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
  }
});

// POST /jobs/mail/reset { mailbox_upn: "info@carotte.se" }
app.post("/jobs/mail/reset", requireApiKey, async (req, res) => {
  try {
    const mailbox_upn = normEmail(req.body?.mailbox_upn);
    if (!mailbox_upn) return res.status(400).json({ ok: false, error: "mailbox_upn is required" });

    const st = await getOrCreateMailPollState(mailbox_upn);
    await updateMailPollState(st._id, {
      delta_link: "",
      last_run_at: new Date().toISOString(),
      last_error: ""
    });

    return res.json({ ok: true, mailbox_upn, reset: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
  }
});
// Microsoft helpers / routes (din befintliga kod – oförändrad)
function buildAuthorizeUrl({ user_id, redirect }) {
  const authBase = "https://login.microsoftonline.com/" + MS_TENANT + "/oauth2/v2.0/authorize";
  const url = new URL(authBase);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MS_SCOPE);
  url.searchParams.set("redirect_uri", redirect || REDIRECT_URI);
  if (user_id) url.searchParams.set("state", "u:" + user_id);
  return url.toString();
}

app.post("/ms/auth", async (req, res) => {
  try {
    const { user_id, u, redirect } = req.body || {};
    const uid = user_id || u;
    log("[/ms/auth] incoming body", req.body);
    if (!uid) return res.status(400).json({ error: "Missing user_id" });

    const cleanRedirect = normalizeRedirect(redirect || REDIRECT_URI);
    const url = buildAuthorizeUrl({ user_id: uid, redirect: cleanRedirect });

    log("[/ms/auth] → built url", {
      have_clientId: !!CLIENT_ID,
      redirect: cleanRedirect
    });
    res.json({ ok: true, url });
  } catch (err) {
    console.error("[/ms/auth] error", err);
    res.status(500).json({ error: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// Fortnox-lik OAuth-flöde (Render äger callbacken)
// - /ms/authorize redirectar till Microsoft
// - /ms/callback tar emot code, växlar token och sparar direkt i Bubble (User)
// OBS: du måste lägga till redirect URI i Azure App Registration:
//      https://mira-exchange.onrender.com/ms/callback   (och ev din api-subdomän senare)
function publicBaseFromReq(req) {
  // Render/Cloudflare kan sätta X-Forwarded-*; vi bygger en stabil "public base"
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"]  || req.get("host") || "").toString().split(",")[0].trim();
  if (!host) return null;
  return `${proto}://${host}`;
}

app.get("/ms/authorize", async (req, res) => {
  try {
    const userId = pick(req.query.user_unique_id, req.query.u, req.query.user_id);
    if (!userId) return res.status(400).send("Missing user id (?u=... or ?user_unique_id=...)");

    const base = publicBaseFromReq(req) || pick(process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL);
    if (!base) return res.status(500).send("Could not determine public base url");

    const redirectUri = normalizeRedirect(`${base}/ms/callback`);

    // stöd även custom scopes om du vill, annars tar vi MS_SCOPE (som du redan använder)
    const scope = pick(req.query.scope, MS_SCOPE);

    const authBase = "https://login.microsoftonline.com/" + MS_TENANT + "/oauth2/v2.0/authorize";
    const url = new URL(authBase);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", scope);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", "u:" + userId);

    // valfritt: efter success kan du skicka användaren tillbaka till Bubble
    const next = pick(req.query.next, req.query.redirect_after);
    if (next) url.searchParams.set("state", "u:" + userId + "|next:" + encodeURIComponent(next));

    return res.redirect(url.toString());
  } catch (e) {
    console.error("[/ms/authorize] error", e);
    res.status(500).send(e.message || "error");
  }
});

app.get("/ms/callback", async (req, res) => {
  try {
    const code  = req.query.code;
    const state = String(req.query.state || "");
    if (!code) return res.status(400).send("Missing code");

    // state: "u:<bubbleUserId>" eller "u:<id>|next:<urlencoded>"
    const m = state.match(/^u:([^|]+)(?:\|next:(.+))?$/);
    const userId = m?.[1] || null;
    const next = m?.[2] ? decodeURIComponent(m[2]) : null;
    if (!userId) return res.status(400).send("Missing/invalid state");

    const base = publicBaseFromReq(req) || pick(process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL);
    const redirectUri = normalizeRedirect(`${base}/ms/callback`);

    const result = await tokenExchange({ code, redirect_uri: redirectUri });

    if (!result.ok) {
      return res.status(400).send("Token exchange failed: " + (result.data?.error_description || result.data?.error || "unknown"));
    }

    const saved = await upsertTokensToBubble(userId, result.data, null);
    if (!saved) return res.status(502).send("Bubble save failed");

    // Om du skickar ?next=... kan du landa tillbaka i Bubble
    if (next) return res.redirect(next);

    // annars visa en enkel OK-sida
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<html><body><h3>Microsoft connected ✅</h3><p>User: ${escapeHtml(userId)}</p><p>Du kan stänga detta fönster.</p></body></html>`);
  } catch (e) {
    console.error("[/ms/callback] error", e);
    res.status(500).send(e.message || "error");
  }
});


/** Exchange CODE or REFRESH TOKEN and save to Bubble */
app.post("/ms/refresh-save", async (req, res) => {
  const {
    user_unique_id,
    u,
    refresh_token,
    code,
    scope: incomingScope,
    tenant,
    redirect
  } = req.body || {};

  const userId = user_unique_id || u;

  log("[/ms/refresh-save] hit", {
    auth: BUBBLE_API_KEY ? "ok" : "missing",
    has_body: !!req.body,
    has_code: !!code,
    has_refresh_token: !!refresh_token,
    has_user: !!userId,
    has_scope: !!incomingScope
  });

  if (!userId) return res.status(400).json({ error: "Missing user id (u or user_unique_id)" });

  try {
    const result = await tokenExchange({
      code,
      refresh_token,
      scope: incomingScope,
      tenant,
      redirect_uri: normalizeRedirect(redirect || REDIRECT_URI)
    });

    log("[/ms/refresh-save] ms token response", {
      ok: result.ok,
      status: result.status,
      has_access_token: !!result.data?.access_token,
      has_refresh_token: !!result.data?.refresh_token
    });

    if (!result.ok) {
      const j = result.data || {};
      logMsTokenError("/ms/refresh-save", result, {
        sent: {
          have_code: !!code,
          have_refresh_token: !!refresh_token,
          redirect_used: normalizeRedirect(redirect || REDIRECT_URI),
          scope_used: incomingScope || MS_SCOPE,
          tenant_used: tenant || MS_TENANT
        }
      });

      return res.status(400).json({
        ok: false,
        stage: "token_exchange",
        status: result.status,
        ms_error: j.error,
        ms_error_description: j.error_description,
        sent: {
          have_code: !!code,
          have_refresh_token: !!refresh_token,
          redirect_used: normalizeRedirect(redirect || REDIRECT_URI),
          scope_used: incomingScope || MS_SCOPE,
          tenant_used: tenant || MS_TENANT
        }
      });
    }

    const saved = await upsertTokensToBubble(userId, result.data, result.data.refresh_token || refresh_token);
if (!saved?.ok) return res.status(502).json({ ok: false, error: "Bubble save failed", detail: saved });

    return res.json({
      ok: true,
      saved_for_user: userId,
      access_token: result.data.access_token || null,
      refresh_token: result.data.refresh_token || refresh_token || null,
      expires_in: result.data.expires_in || null,
      scope: result.data.scope || incomingScope || null,
      token_type: result.data.token_type || "Bearer",
      access_token_preview: (result.data.access_token || "").slice(0, 12) + "..."
    });

  } catch (err) {
    console.error("[/ms/refresh-save] error", err);
    res.status(500).json({ error: err.message });
  }
});

// CREATE EVENT (med stöd för room_email / resource-attendee)
app.post("/ms/create-event", async (req, res) => {
  const {
    user_unique_id,
    attendees_emails,
    event,
    ms_access_token,
    ms_refresh_token,
    room_email
  } = req.body || {};

  log("[/ms/create-event] hit", {
    has_user: !!user_unique_id,
    has_event: !!event,
    attendees_count: Array.isArray(attendees_emails)
      ? attendees_emails.length
      : (typeof attendees_emails === "string" && attendees_emails.trim()
          ? attendees_emails.split(",").length
          : 0),
    body_has_access: !!ms_access_token,
    body_has_refresh: !!ms_refresh_token,
    has_room_email: !!room_email
  });

  if (!user_unique_id || !event) {
    return res.status(400).json({ error: "Missing user_unique_id or event" });
  }

  try {
    let accessToken = ms_access_token || null;
    let refreshToken = ms_refresh_token || null;
    let scope = null;

    if (!accessToken || !refreshToken) {
      const u = await fetchBubbleUser(user_unique_id);
      log("[/ms/create-event] user snapshot", {
        has_response: !!u,
        has_ms_access_token: !!u?.ms_access_token,
        has_ms_refresh_token: !!u?.ms_refresh_token,
        scope: u?.ms_scope ? u.ms_scope.split(" ").slice(0,3).join(" ") + "…" : null
      });
      const dbAccess = u?.ms_access_token || null;
      const dbRefresh = u?.ms_refresh_token || null;
      scope = u?.ms_scope || u?.scope || null;

      accessToken = accessToken || dbAccess || null;
      refreshToken = refreshToken || dbRefresh || null;
    }

    if (!accessToken && refreshToken) {
      const ref = await tokenExchange({ refresh_token: refreshToken, scope });
      log("[/ms/create-event] auto-refresh", { ok: ref.ok, status: ref.status });
      if (ref.ok) {
        accessToken = ref.data.access_token;
        const newRefresh = ref.data.refresh_token || refreshToken;
        await upsertTokensToBubble(user_unique_id, ref.data, newRefresh);
      }
    }

    if (!accessToken) {
      return res.status(401).json({ error: "User has no ms_access_token (and refresh missing/failed)" });
    }

    const normalizedAttendees = [];
    const seen = new Set();
    const push = (raw, type = "required") => {
      const e = String(raw || "").trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      normalizedAttendees.push({
        emailAddress: { address: e },
        type
      });
    };

    const allAtt =
      Array.isArray(attendees_emails) ? attendees_emails :
      typeof attendees_emails === "string" ? attendees_emails.split(",") :
      Array.isArray(event?.attendees_emails) ? event.attendees_emails :
      typeof event?.attendees_emails === "string" ? event.attendees_emails.split(",") :
      [];
    allAtt.forEach(e => push(e, "required"));

    const roomEmailFromEvent =
      event?.room_email ||
      event?.location_email ||
      event?.locationEmailAddress ||
      null;
    const roomEmail = room_email || roomEmailFromEvent || null;

    if (roomEmail) {
      push(roomEmail, "resource");
    }

    const tzInput = event?.tz || event?.start?.timeZone || "Europe/Stockholm";
    const ev = {
      subject: event?.subject || "Untitled event",
      body: {
        contentType: "HTML",
        content: event?.body_html || "",
      },
      start: {
        dateTime: toGraphDateTime(
          event?.start_iso_local ||
          event?.start?.dateTime ||
          fixDateTime(event?.start_iso_local)
        ),
        timeZone: toWindowsTz(tzInput),
      },
      end: {
        dateTime: toGraphDateTime(
          event?.end_iso_local ||
          event?.end?.dateTime ||
          fixDateTime(event?.end_iso_local)
        ),
        timeZone: toWindowsTz(tzInput),
      },
      location: {
        displayName: event?.location_name || event?.location?.displayName || "",
        locationEmailAddress: roomEmail || roomEmailFromEvent || undefined
      },
      isOnlineMeeting: true,
      allowNewTimeProposals: true,
      onlineMeetingProvider: "teamsForBusiness",
    };
    if (normalizedAttendees.length > 0) ev.attendees = normalizedAttendees;

    const graphRes = await fetch(GRAPH_BASE + "/me/events", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ev),
    });
    const graphData = await graphRes.json().catch(() => ({}));

    log("[/ms/create-event] graph response", {
      ok: graphRes.ok,
      status: graphRes.status,
      id: graphData?.id,
      webLink: graphData?.webLink,
      hasOnline: !!graphData?.onlineMeeting,
      joinUrl: (graphData?.onlineMeeting && graphData.onlineMeeting.joinUrl) || graphData?.onlineMeetingUrl,
      error: !graphRes.ok ? graphData?.error : undefined,
      tzSent: ev?.start?.timeZone,
      startSent: ev?.start?.dateTime,
      endSent: ev?.end?.dateTime,
    });

    if (!graphRes.ok) {
      return res.status(graphRes.status).json({
        ok: false,
        status: graphRes.status,
        error: graphData?.error || graphData
      });
    }

    res.json({
      ok: true,
      id: graphData.id,
      webLink: graphData.webLink,
      joinUrl: (graphData?.onlineMeeting && graphData.onlineMeeting.joinUrl) || graphData?.onlineMeetingUrl || null,
      raw: graphData,
    });
  } catch (err) {
    console.error("[/ms/create-event] error", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/ms/debug-env", (_req, res) => {
  res.json({
    has_CLIENT_ID: !!CLIENT_ID,
    has_CLIENT_SECRET: !!CLIENT_SECRET,
    has_REDIRECT_URI: !!REDIRECT_URI,
    client_id: mask(CLIENT_ID),
    client_secret: mask(CLIENT_SECRET),
    client_secret_sha256_prefix: sha(CLIENT_SECRET),
    redirect_uri: REDIRECT_URI || null,
    node_env: NODE_ENV
  });
});

// ────────────────────────────────────────────────────────────
// Helpers for app-only (client_credentials) Graph calls
const DEFAULT_TENANT = pick(process.env.MS_TENANT, "common");

async function graphFetch(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": body ? "application/json" : undefined
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = json || { text, status: res.status };
    const err = new Error("Graph " + method + " " + url + " failed " + res.status);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return json;
}

function resolveTenant(req) {
  return pick(
    req.query.tenant,
    req.headers["x-tenant-id"],
    DEFAULT_TENANT
  );
}

async function getAppToken(tenant) {
  const t = tenant || DEFAULT_TENANT;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID/CLIENT_SECRET for app-only flow");
  }
  const form = new URLSearchParams();
  form.set("client_id", CLIENT_ID);
  form.set("client_secret", CLIENT_SECRET);
  form.set("grant_type", "client_credentials");
  form.set("scope", "https://graph.microsoft.com/.default");

  const tokenEndpoint = "https://login.microsoftonline.com/" + t + "/oauth2/v2.0/token";
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  const j = await r.json();
  if (!r.ok) {
    const err = new Error("App token fetch failed");
    err.status = r.status;
    err.detail = j;
    throw err;
  }
  if (!j.access_token) {
    const err = new Error("No access_token in app token response");
    err.detail = j;
    throw err;
  }
  return j.access_token;
}

app.get("/ms/app-token/debug", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    res.json({
      ok: true,
      tenant,
      client_id: mask(CLIENT_ID),
      has_token: !!token,
      token_hash: sha(token)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

app.get("/ms/places/rooms", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    const base = "https://graph.microsoft.com/v1.0/places/microsoft.graph.room?$top=999";
    const data = await graphFetch("GET", base, token);
    const rooms = (data?.value || []).map(r => ({
      id: r.id || null,
      displayName: r.displayName || null,
      emailAddress: r.emailAddress || null,
      floorLabel: r.floorLabel || r.floor || null,
      building: r.building || null,
      capacity: r.capacity || null
    }));
    res.json({ ok: true, tenant, count: rooms.length, rooms });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

app.post("/ms/rooms/availability", async (req, res) => {
  try {
    const {
      room_emails = [],
      start,
      end,
      timezone = "Europe/Stockholm",
      intervalMinutes = 30
    } = req.body || {};

    if (!Array.isArray(room_emails) || room_emails.length === 0) {
      return res.status(400).json({ ok: false, error: "room_emails (array) saknas" });
    }
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: "start och/eller end saknas (ISO)" });
    }

    const tenant = resolveTenant(req);
    const token  = await getAppToken(tenant);

    const anchor = encodeURIComponent(room_emails[0]);
    const url = `${GRAPH_BASE}/users/${anchor}/calendar/getSchedule`;

    const body = {
      schedules: room_emails,
      startTime: { dateTime: start, timeZone: timezone },
      endTime:   { dateTime: end,   timeZone: timezone },
      availabilityViewInterval: intervalMinutes
    };

    const data = await graphFetch("POST", url, token, body);

    const items = [];
    const arr = Array.isArray(data?.value) ? data.value : [];
    for (const sched of arr) {
      const scheduleId = sched?.scheduleId || null;
      const list = Array.isArray(sched?.scheduleItems) ? sched.scheduleItems : [];
      for (const it of list) {
        items.push({
          scheduleId,
          status: it?.status || "busy",
          subject: it?.subject || "",
          start: it?.start?.dateTime || null,
          end:   it?.end?.dateTime   || null,
          start_tz: it?.start?.timeZone || timezone,
          end_tz:   it?.end?.timeZone   || timezone
        });
      }
    }

    return res.json({ ok: true, tenant, count: items.length, items });
  } catch (e) {
    console.error("[/ms/rooms/availability] error:", e);
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

app.get("/ms/rooms/:roomEmail/calendar", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    const { roomEmail } = req.params;
    const { start, end } = req.query;

    if (!roomEmail) return res.status(400).json({ ok: false, error: "roomEmail is required" });
    if (!start || !end) return res.status(400).json({ ok: false, error: "start & end ISO required" });

    const params = new URLSearchParams({
      startDateTime: String(start),
      endDateTime: String(end),
      "$select": "id,subject,organizer,start,end,location,attendees,isAllDay,webLink"
    });

    const url = "https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(roomEmail) + "/calendarView?" + params.toString();
    const data = await graphFetch("GET", url, token);

    res.json({ ok: true, tenant, events: data?.value || [] });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

function logMsTokenError(where, result, extra = {}) {
  try {
    console.error(`[${where}] MS token error`, {
      status: result?.status,
      ms_error: result?.data?.error,
      ms_error_description: result?.data?.error_description,
      extra
    });
  } catch {}
}

app.get("/ms/routes", (req, res) => {
  const routes = [];
  (app._router?.stack || []).forEach(l => {
    if (l.route?.path) {
      const method = Object.keys(l.route.methods || {})[0]?.toUpperCase();
      routes.push({ method, path: l.route.path });
    }
  });
  res.json({ routes });
});
function normalizeBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").toLowerCase().trim();
  if (!s) return false;
  return ["true", "yes", "1", "y"].includes(s);
}
app.post("/tengella/auth/test", async (req, res) => {
  try {
    const orgNo = req.body?.orgNo;
    const token = await tengellaLogin(orgNo);
    res.json({
      ok: true,
      orgNo,
      token_preview: token ? token.slice(0, 6) + "..." + token.slice(-6) : null,
    });
  } catch (e) {
    console.error("[tengella/auth/test] error:", e?.message || e, e?.details || "");
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      details: e?.details || null,
    });
  }
});
function safeJsonStringify(obj, maxLen = 250000) {
  try {
    const s = JSON.stringify(obj ?? null);
    if (s && s.length > maxLen) return s.slice(0, maxLen) + "…";
    return s;
  } catch {
    return "";
  }
}
// ────────────────────────────────────────────────────────────
// Tengella – WorkOrders sync (Render → Tengella → Bubble Data API)
//
// Env (required):
//   TENGELLA_APP_KEY          (header: X-TengellaApp)
//   TENGELLA_USERNAME         (ex: 746-0509)
//   TENGELLA_USER_API_KEY     (din långa API-nyckel)
//
// Optional:
//   TENGELLA_BASE_URL         (default: https://api.tengella.se/public)
//
// Notes:
// - Login endpoint: POST /v2/Login (requires application/json)
// - List endpoints return { Data: [...], Next: "cursor", ExistsMoreData: true/false }.
// - This implementation logs in per sync run.
//
// Routes:
//   GET  /tengella/debug-env
//   POST /tengella/workorders/sync
// ────────────────────────────────────────────────────────────

const TENGELLA_BASE_URL = pick(process.env.TENGELLA_BASE_URL, "https://api.tengella.se/public");
const TENGELLA_APP_KEY  = pick(process.env.TENGELLA_APP_KEY);

function redacted(str, keep = 4) {
  const s = String(str || "");
  if (!s) return "";
  if (s.length <= keep) return "***";
  return s.slice(0, keep) + "…" + s.slice(-keep);
}

async function tengellaFetch(
  path,
  {
    method = "GET",
    token = null,
    query = null,
    body = null,
    headers: extraHeaders = null,
    contentType = "application/json",
  } = {}
) {
  if (!TENGELLA_APP_KEY) throw new Error("Missing env TENGELLA_APP_KEY (Tengella ApiKey header)");

  const url = new URL(path.startsWith("http") ? path : `${TENGELLA_BASE_URL}${path}`);

  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === null || v === undefined || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    "Content-Type": contentType,
    // ✅ VIKTIGT: exakt som i Bubble
    "X-TengellaApiKey": TENGELLA_APP_KEY,
    ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
  };

  if (token) headers["Authorization"] = `Bearer ${token}`;

  const hasBody = !(body === null || body === undefined);
  const finalBody = !hasBody ? undefined : (typeof body === "string" ? body : JSON.stringify(body));

  const res = await fetch(url.toString(), { method, headers, body: finalBody });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const err = new Error(
      `Tengella ${method} ${url.pathname} failed (${res.status}): ` +
      (json ? JSON.stringify(json) : (text || `EMPTY_BODY (${res.statusText})`))
    );
    err.status = res.status;
    err.details = {
      status: res.status,
      statusText: res.statusText,
      url: url.toString(),
      sentContentType: headers["Content-Type"],
      bodyText: text || null,
      bodyJson: json || null,
    };
    throw err;
  }

  return json ?? text ?? null;
}

async function tengellaLogin(orgNo) {
  if (!orgNo) throw new Error('Missing orgNo for Tengella login (ex: "746-0509")');

  // ✅ Exakt som i Bubble: Body är en JSON-string => måste vara med citattecken
  // dvs skickas som: "746-0509"
  const body = JSON.stringify(String(orgNo).trim());

  // ✅ Exakt path/case som i Bubble
  const data = await tengellaFetch(`/v2/login`, {
    method: "POST",
    // vi skickar redan stringify:ad JSON-string (inkl quotes), så här vill vi INTE stringify:a igen
    body,
    contentType: "application/json",
  });

  // Stöd flera varianter: kan vara {Token:"..."} eller {token:"..."} eller ren string
  const token =
    (typeof data === "string" ? data : null) ||
    pick(data?.Token, data?.token, data?.access_token, data?.accessToken);

  if (!token) {
    throw new Error(`Tengella login returned no token. Response keys: ${typeof data === "object" && data ? Object.keys(data).join(", ") : typeof data}`);
  }

  return token;
}
// ────────────────────────────────────────────────────────────
// Bubble upsert: WorkOrder
// ────────────────────────────────────────────────────────────
async function upsertTengellaWorkorderToBubble(
  workOrder,
  { bubbleCompanyId = null, bubbleCommissionId = null, parsedCommissionUid = "", saveRowsJson = true } = {}
) {
  const type = "TengellaWorkorder";

  const workorder_id = Number(workOrder?.WorkOrderId ?? 0) || null;
  if (!workorder_id) return { ok: false, reason: "Missing WorkOrderId" };

  const existing = await bubbleFindOne(type, [
    { key: "workorder_id", constraint_type: "equals", value: workorder_id }
  ]);

  const payload = {
    workorder_id,
    project_id: Number(workOrder?.ProjectId ?? 0) || null,
    customer_id: Number(workOrder?.CustomerId ?? 0) || null,
    workorder_no: workOrder?.WorkOrderNo ?? "",
    description: workOrder?.WorkOrderDescription ?? "",
    invoice_address_id: Number(workOrder?.InvoiceAddressId ?? 0) || null,
    work_address_id: Number(workOrder?.WorkAddressId ?? 0) || null,
    order_date: toBubbleDate(workOrder?.OrderDate),
    is_deleted: normalizeBool(workOrder?.IsDeleted),
    note: workOrder?.Note ?? "",
    internal_note: workOrder?.InternalNote ?? "",
    note_for_schedule: workOrder?.NoteForSchedule ?? "",
    desired_schedule_note: workOrder?.DesiredScheduleNote ?? "",
    general_schedule_note: workOrder?.GeneralScheduleNote ?? "",
    workorder_rows_json: saveRowsJson ? safeJsonStringify(workOrder?.WorkOrderRows ?? []) : ""
  };

  if (existing?.id) {
    await bubbleUpdate(type, existing.id, payload);
    return { ok: true, mode: "update", id: existing.id };
  } else {
    const created = await bubbleCreate(type, payload);
    return { ok: true, mode: "create", id: created?.id || null };
  }
}

// Bubble date helper
function toBubbleDate(v) {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ────────────────────────────────────────────────────────────
// Bubble upsert: WorkOrderRow
// ────────────────────────────────────────────────────────────
async function upsertTengellaWorkorderRowToBubble(
  row,
  { workorderBubbleId = null, workorderId = null, projectId = null, customerId = null, company = null, commission = null } = {}
) {
  const type = "TengellaWorkorderRow";
  if (!row) return { ok: false, reason: "missing_row" };

  const workOrderRowId = Number(row.WorkOrderRowId ?? row.workOrderRowId ?? 0) || null;
  if (!workOrderRowId) return { ok: false, reason: "missing_workOrderRowId" };

  const existing = await bubbleFindOne(type, [
    { key: "workorder_row_id", constraint_type: "equals", value: workOrderRowId },
  ]);

  const payload = {
    workorder_row_id: workOrderRowId,
    workorder_id: Number(row.WorkOrderId ?? row.workOrderId ?? workorderId ?? 0) || null,
    ...(workorderBubbleId ? { workorder: workorderBubbleId } : {}),
    project_id: Number(projectId ?? 0) || null,
    customer_id: Number(customerId ?? 0) || null,

    item_id: Number(row.ItemId ?? 0) || null,
    item_no: row.ItemNo ?? null,
    item_name: row.ItemName ?? null,

    quantity: Number(row.Quantity ?? 0) || null,
    note: row.Note ?? null,

    price: Number(row.Price ?? 0) || null,
    cost_price: Number(row.CostPrice ?? 0) || null,
    total_cost_price: Number(row.TotalCostPrice ?? 0) || null,

    invoiced: normalizeBool(row.Invoiced),
    workorder_row_invoice_status_id: Number(row.WorkOrderRowInvoiceStatusId ?? 0) || null,
    approx_working_time: Number(row.ApproxWorkingTime ?? 0) || null,
    material_to_project_row_id: Number(row.MaterialToProjectRowId ?? 0) || null,
    desired_schedule_is_handled: normalizeBool(row.DesiredScheduleIsHandled),
    item_invoice_type_id: Number(row.ItemInvoiceTypeId ?? 0) || null,
    invoice_status_change_datetime: toBubbleDate(row.WorkOrderRowInvoiceStatusChangeDatetime),
    cant_be_scheduled: normalizeBool(row.CantBeScheduled),
    time_spent_for_tax_reduction: Number(row.TimeSpentForTaxReduction ?? 0) || null,
    unit_of_measure_id: Number(row.UnitOfMeasureId ?? 0) || null,
    allowed_minutes: Number(row.AllowedMinutes ?? 0) || null,
    order_by: Number(row.OrderBy ?? 0) || null,
    workorder_rounding_id: Number(row.WorkOrderRoundingId ?? 0) || null,
    approved_working_time: Number(row.ApprovedWorkingTime ?? 0) || null,
    first_timetable_event_start: toBubbleDate(row.FirstTimeTableEventStart),
    last_timetable_event_start: toBubbleDate(row.LastTimeTableEventStart),

    ...(company ? { company } : {}),
    ...(commission ? { commission } : {}),

    raw_json: safeJsonStringify(row),
  };

  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  if (existing?.id) {
    await bubbleUpdate(type, existing.id, payload);
    return { ok: true, mode: "update", id: existing.id };
  } else {
    const created = await bubbleCreate(type, payload);
    return { ok: true, mode: "create", id: created?.id || null };
  }
}

// ────────────────────────────────────────────────────────────
// Tengella list WorkOrders
// ────────────────────────────────────────────────────────────
async function listTengellaWorkOrders({ token, limit = 100, cursor = null, customerId = null, projectId = null } = {}) {
  return tengellaFetch(`/v2/WorkOrders`, {
    method: "GET",
    token,
    query: { limit, cursor, customerId, projectId }
  });
}

// ────────────────────────────────────────────────────────────
// Debug env
// ────────────────────────────────────────────────────────────
app.get("/tengella/debug-env", (req, res) => {
  res.json({
    ok: true,
    base_url: TENGELLA_BASE_URL,
    has_app_key: !!TENGELLA_APP_KEY,
    app_key_preview: TENGELLA_APP_KEY ? redacted(TENGELLA_APP_KEY, 6) : null,
    has_username: !!pick(process.env.TENGELLA_USERNAME, process.env.TENGELLA_USER),
    has_user_api_key: !!pick(process.env.TENGELLA_USER_API_KEY, process.env.TENGELLA_API_KEY),
  });
});

// ────────────────────────────────────────────────────────────
// Sync endpoint
// ────────────────────────────────────────────────────────────
app.post("/tengella/workorders/sync", async (req, res) => {
  try {
    const orgNo = req.body?.orgNo;
    const limit = Number(req.body?.limit ?? 100) || 100;
    const cursor = req.body?.cursor ?? null;
    const customerId = req.body?.customerId ?? null;
    const projectId = req.body?.projectId ?? null;
    const maxPages = Number(req.body?.maxPages ?? 50) || 50;

    const saveRowsJson =
      req.body?.saveRowsJson === undefined ? true : normalizeBool(req.body?.saveRowsJson);

    const upsertRows =
      req.body?.upsertRows === undefined ? true : normalizeBool(req.body?.upsertRows);

    const bubbleCompanyId = req.body?.bubbleCompanyId ?? null;
    const bubbleCommissionId = req.body?.bubbleCommissionId ?? null;
    const parsedCommissionUid = req.body?.parsedCommissionUid ?? "";

    const token = await tengellaLogin(orgNo, {
      username: req.body?.username,
      apiKey: req.body?.apiKey,
    });

    let page = 0;
    let nextCursor = cursor;
    let existsMoreData = true;

    let fetched = 0;
    let upserted = 0;
    let workorderRowsUpserted = 0;
    let workorderRowsErrors = 0;
    let errors = [];

    while (existsMoreData && page < maxPages) {
      page += 1;

      const resp = await listTengellaWorkOrders({
        token,
        limit,
        cursor: nextCursor,
        customerId,
        projectId
      });

      const data = Array.isArray(resp?.Data) ? resp.Data : [];
      fetched += data.length;

      for (const wo of data) {
        const result = await upsertTengellaWorkorderToBubble(wo, {
          bubbleCompanyId,
          bubbleCommissionId,
          parsedCommissionUid,
          saveRowsJson
        });

        if (result?.ok) {
          upserted += 1;

          if (upsertRows && Array.isArray(wo?.WorkOrderRows) && wo.WorkOrderRows.length) {
            for (const row of wo.WorkOrderRows) {
              try {
                const rr = await upsertTengellaWorkorderRowToBubble(row, {
                  workorderBubbleId: result.id,
                  workorderId: wo.WorkOrderId,
                  projectId: wo.ProjectId,
                  customerId: wo.CustomerId,
                  company: bubbleCompanyId,
                  commission: bubbleCommissionId,
                });

                if (rr?.ok) workorderRowsUpserted += 1;
                else {
                  workorderRowsErrors += 1;
                  errors.push({ workOrderRowId: row?.WorkOrderRowId, reason: rr?.reason || "row_upsert_failed" });
                }
              } catch (e) {
                workorderRowsErrors += 1;
                errors.push({ workOrderRowId: row?.WorkOrderRowId, reason: e?.message || String(e) });
              }
            }
          }
        }
      }

      nextCursor = resp?.Next || null;
      existsMoreData = normalizeBool(resp?.ExistsMoreData) && !!nextCursor;

      // Safety: if API says more data but Next is missing, break to avoid loops.
      if (normalizeBool(resp?.ExistsMoreData) && !nextCursor) {
        existsMoreData = false;
      }
    }

    res.json({
      ok: true,
      pages: page,
      fetched,
      upserted,
      workorderRowsUpserted,
      workorderRowsErrors,
      nextCursor,
      existsMoreData,
      errors: Array.isArray(errors) ? errors.slice(0, 50) : []
    });
  } catch (e) {
    console.error("[tengella/workorders/sync] error:", e?.message || e, e?.details || "");
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      details: {
  details: e?.details || null,
  detail: e?.detail || null
}
    });
  }
});
app.listen(PORT, () => console.log("🚀 Mira Exchange running on port " + PORT));
