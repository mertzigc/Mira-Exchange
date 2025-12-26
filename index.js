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
  "User.Read Calendars.ReadWrite offline_access openid profile email"
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
// (VIKTIGT: måste matcha fetchBubbleUser() som läser från mira-fm.com)
const BUBBLE_BASES = [
  "https://mira-fm.com/version-test",
];
console.log("[BOOT] BUBBLE_BASES =", BUBBLE_BASES);
console.log("[BOOT] INDEX_FINGERPRINT = 2025-12-21_15:40_v1");
const BASE_URL =
  pick(process.env.BASE_URL, process.env.BUBBLE_BASE_URL) ||
  (Array.isArray(BUBBLE_BASES) && BUBBLE_BASES[0]) ||
  null;

if (!BASE_URL) {
  console.warn("[BOOT] No BASE_URL resolved. Nightly endpoints will fail.");
}
// ────────────────────────────────────────────────────────────
// Helpers
const log = (msg, data) => console.log(msg, data ? JSON.stringify(data, null, 2) : "");

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
    url.pathname = url.pathname.replace(/\/{2,}/g, "/"); // collapse multiple slashes
    return url.toString();
  } catch {
    return u;
  }
}

// ────────────────────────────────────────────────────────────
// API key guard – allow health + OAuth endpoints without key
function requireApiKey(req, res, next) {
  const openPaths = [
    "/health",
    "/fortnox/authorize",
    "/fortnox/callback"
  ];

  // also allow /ms/debug-env without key if you want:
  // openPaths.push("/ms/debug-env");

  if (openPaths.includes(req.path)) return next();

  if (!RENDER_API_KEY) {
    return res.status(500).json({ ok: false, error: "Missing MIRA_RENDER_API_KEY on server" });
  }
  const key = req.headers["x-api-key"];
  if (!key || String(key).trim() !== String(RENDER_API_KEY).trim()) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad x-api-key)" });
  }
  next();
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
  const payload = {
    bubble_user_id: user_unique_id,
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token || fallbackRefresh || null,
    expires_in: tokenJson.expires_in,
    token_type: tokenJson.token_type,
    scope: tokenJson.scope,
    server_now_iso: new Date().toISOString(),
  };

  for (const base of BUBBLE_BASES) {
    try {
      const wf = base + "/api/1.1/wf/ms_token_upsert";
      const r = await fetch(wf, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY,
        },
        body: JSON.stringify(payload),
      });
      const ok = r.ok;
      log("[save] try WF", { base, status: r.status, ok });
      if (ok) return true;
    } catch (e) {
      log("[save] WF error", { base, e: String(e) });
    }
  }
  return false;
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
// Bubble: paginate "search" results for a thing
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
    bubble_user_id,
    ft_access_token:  tokenJson.access_token || null,
    ft_refresh_token: tokenJson.refresh_token || null,
    ft_expires_in:    tokenJson.expires_in || null,
    ft_scope:         tokenJson.scope || null,
    ft_token_type:    tokenJson.token_type || null,
    ft_received_at:   new Date().toISOString(),
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
  const url = new URL("https://api.fortnox.se/3" + path);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    url.searchParams.set(k, String(v));
  });

  const r = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Access-Token": accessToken,
      "Client-Secret": FORTNOX_CLIENT_SECRET,
      "Accept": "application/json"
    }
  });

  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j, url: url.toString() };
}
// ────────────────────────────────────────────────────────────
// Nightly lock (process-local, per Render instance)

let _nightlyRunning = false;
let _nightlyStartedAt = null;

function isNightlyRunning() {
  return _nightlyRunning === true;
}

function startNightly() {
  _nightlyRunning = true;
  _nightlyStartedAt = new Date().toISOString();
}

function stopNightly() {
  _nightlyRunning = false;
  _nightlyStartedAt = null;
}

function getNightlyStatus() {
  return {
    running: _nightlyRunning,
    started_at: _nightlyStartedAt
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ────────────────────────────────────────────────────────────
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
    `&scope=${encodeURIComponent("customer order invoice offer")}` +
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

    // 5) Render-side filter: DeliveryDate >= cutoff
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
  const {
    connection_id,
    page = 1,
    limit = 100,
    months_back = 12
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let firstError = null;

  try {
    // 1) Fetch filtered orders
    const syncRes = await fetch("https://mira-exchange.onrender.com/fortnox/sync/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });

    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncJson.ok) {
      return res.status(400).json({ ok: false, error: "sync/orders failed", detail: syncJson });
    }

    const orders = Array.isArray(syncJson.orders) ? syncJson.orders : [];

    for (const o of orders) {
      const docNo = String(o?.DocumentNumber || "").trim();
      if (!docNo) { skipped++; continue; }
  console.log("[upsert/orders] docNo", docNo);
      const payload = {
        connection: connection_id,
        ft_document_number: docNo,
        ft_customer_number: String(o?.CustomerNumber || ""),
        ft_customer_name: String(o?.CustomerName || ""),
        ft_order_date: toIsoDate(o?.OrderDate),
ft_delivery_date: toIsoDate(o?.DeliveryDate),
ft_last_seen_at: new Date().toISOString(),   // (detta är date i Bubble -> ISO funkar)
        ft_total: o?.Total == null ? "" : String(o.Total),
        ft_cancelled: !!o?.Cancelled,
        ft_sent: !!o?.Sent,
        ft_currency: String(o?.Currency || ""),
        ft_url: String(o?.["@url"] || ""),
        ft_raw_json: JSON.stringify(o),
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
  console.log("[upsert/orders] found", {
    docNo,
    found_id: existing?._id,
    found_doc: existing?.ft_document_number
  });
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
        if (!firstError) {
          firstError = {
            docNo,
            message: e.message,
            status: e.status || null,
            detail: e.detail || null
          };
        }
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
    console.error("[/fortnox/upsert/orders] error", e);
    return res.status(500).json({ ok: false, error: e.message });
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
      const r = await fetch(`${BASE_URL}/fortnox/upsert/orders`, {
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
// Fortnox: fetch + upsert customers into Bubble (FortnoxCustomer)
app.post("/fortnox/upsert/customers", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,
    skip_without_orgnr = true
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Hämta customers (återanvänd din sync-route internt)
    const r = await fetch("https://mira-exchange.onrender.com/fortnox/sync/customers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify({ connection_id, page, limit })
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      return res.status(400).json({ ok: false, error: "sync/customers failed", detail: j });
    }

    const list = Array.isArray(j.customers) ? j.customers : [];

    let created = 0, updated = 0, skipped = 0, errors = 0;

    for (const c of list) {
      const customerNumber = String(c?.CustomerNumber || "").trim();
      const orgnr = String(c?.OrganisationNumber || "").trim();

      if (!customerNumber) { skipped++; continue; }
      if (skip_without_orgnr && !orgnr) { skipped++; continue; }

      const payload = {
        connection_id,
        customer_number: customerNumber,
        name: c?.Name || "",
        organisation_number: orgnr || "",
        email: c?.Email || "",
        phone: c?.Phone || "",
        address1: c?.Address1 || "",
        address2: c?.Address2 || "",
        zip: c?.ZipCode || "",
        city: c?.City || "",
        ft_url: c?.["@url"] || "",
        last_seen_at: new Date().toISOString(),
        raw_json: JSON.stringify(c || {})
      };

      try {
        // 2) Find existing by (connection_id + customer_number)
        const existing = await bubbleFindOne("FortnoxCustomer", [
          { key: "connection_id", constraint_type: "equals", value: connection_id },
          { key: "customer_number", constraint_type: "equals", value: customerNumber }
        ]);

        if (existing?._id) {
          const ok = await bubblePatch("FortnoxCustomer", existing._id, payload);
          if (ok) updated++; else errors++;
        } else {
          const cr = await bubbleCreate("FortnoxCustomer", payload);
          if (cr.ok) created++; else errors++;
        }
      } catch {
        errors++;
      }
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      skip_without_orgnr,
      meta: j.meta || null,
      counts: { created, updated, skipped, errors }
    });

  } catch (e) {
    console.error("[/fortnox/upsert/customers] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert customers - batch loop (N pages per run)
app.post("/fortnox/upsert/customers/all", async (req, res) => {
  const {
    connection_id,
    start_page = 1,
    limit = 100,
    max_pages = 10,
    skip_without_orgnr = true
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
      const r = await fetch("https://mira-exchange.onrender.com/fortnox/upsert/customers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({
          connection_id,
          page,
          limit: lim,
          skip_without_orgnr
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

      const meta = j.meta || null;
      const cur  = Number(meta?.["@CurrentPage"] || page);
      const tot  = Number(meta?.["@TotalPages"] || 0);

      if (tot) totalPages = tot;

      // om vi nått sista sidan – klart
      if (tot && cur >= tot) {
        return res.json({
          ok: true,
          connection_id,
          done: true,
          start_page: start,
          end_page: cur,
          total_pages: tot,
          counts: { created, updated, skipped, errors },
          next_page: null
        });
      }

      // annars vidare
      page = cur + 1;
    }

    // inte klar ännu → returnera nästa sida att fortsätta på
    return res.json({
      ok: true,
      connection_id,
      done: false,
      start_page: start,
      end_page: page - 1,
      total_pages: totalPages,
      counts: { created, updated, skipped, errors },
      next_page: page
    });

  } catch (e) {
    console.error("[/fortnox/upsert/customers/all] error", e);
    return res.status(500).json({ ok: false, error: e.message });
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
    const cutoffDate = fmt(from); // "YYYY-MM-DD"
    const cutoffTs = new Date(cutoffDate + "T00:00:00Z").getTime();

    // 4) Hämta invoices (server-side filter kan vara olika — vi gör stabil client-side filter)
    const url =
      "https://api.fortnox.se/3/invoices" +
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

    const list = Array.isArray(data?.Invoices) ? data.Invoices : [];

const pickInvoiceDateTs = (inv) => {
  // prova flera vanliga Fortnox-fält (list-API kan skilja)
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
  sent_filters: { months_back: mb, invoiceDateCutoff: cutoffDate },
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
    cutoff_ts: cutoffTs
  }
});
      } catch (e) {
    console.error("[/fortnox/sync/invoices] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert invoices into Bubble (one page)
app.post("/fortnox/upsert/invoices", async (req, res) => {
  const createdIds = [];
const createdDebug = [];
  const {
    connection_id,
    page = 1,
    limit = 100,
    months_back = 12
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  try {
    // 1) reuse sync/invoices (refresh + filter)
    const syncRes = await fetch("https://mira-exchange.onrender.com/fortnox/sync/invoices", {
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
    if (syncJson.paused) {
      return res.json({ ok: true, paused: true, connection_id });
    }

    const invoices = Array.isArray(syncJson.invoices) ? syncJson.invoices : [];
const DEBUG_FORCE_CREATE = false; // TEMP: sätt false när det funkar
    let created = 0, updated = 0, skipped = 0, errors = 0;
    let firstError = null;

    for (const inv of invoices) {
      const docNo = String(inv?.DocumentNumber || "").trim();
      if (!docNo) { skipped++; continue; }

      // Bygg payload till Bubble (viktigt: ft_total ska vara STRING)
      const payload = {
        connection: connection_id,
        ft_document_number: docNo,
        ft_customer_number: String(inv?.CustomerNumber || ""),
        ft_customer_name: String(inv?.CustomerName || ""),
        ft_invoice_date: toIsoDate(inv?.InvoiceDate),
        ft_due_date: toIsoDate(inv?.DueDate),
        ft_total: inv?.Total == null ? "" : String(inv.Total),
        ft_balance: inv?.Balance == null ? "" : String(inv.Balance),
        ft_currency: String(inv?.Currency || ""),
        ft_cancelled: !!inv?.Cancelled,
        ft_unique_key: `${connection_id}::${docNo}`,
        ft_sent: !!inv?.Sent,
        ft_url: String(inv?.["@url"] || ""),
        ft_raw_json: JSON.stringify(inv),
        ft_last_seen_at: new Date().toISOString()
      };

      try {
        // Upsert-nyckel: (connection + ft_document_number)
        if (DEBUG_FORCE_CREATE) {
  const createdRes = await bubbleCreate("FortnoxInvoice", payload);
created++;

createdIds.push(createdRes?._id || createdRes?.id || null);
createdDebug.push({
  id: createdRes?._id || createdRes?.id || null,
  debug_base: createdRes?._debug_base || null
});
  continue;
}

// --- STEG 4: Upsert (BOMBSÄKER) ---
const uniqueKey = `${connection_id}::${docNo}`;

// 1) Hitta ev. befintlig invoice via ft_unique_key
const search = await bubbleFind("FortnoxInvoice", {
  constraints: [
    { key: "ft_unique_key", constraint_type: "equals", value: uniqueKey }
  ],
  limit: 1
});

const existing = Array.isArray(search) && search.length ? search[0] : null;

// 2) Patch om den finns, annars Create
if (existing && existing._id) {
  await bubblePatch("FortnoxInvoice", existing._id, payload);
  updated++;
} else {
  await bubbleCreate("FortnoxInvoice", payload);
  created++;
}

// ✅ BEVIS-DEBUG (kör bara ibland för att inte spamma)
if (Math.random() < 0.15) {
  console.log("[upsert/invoices] find-check", {
    docNo,
    found_id: existing?._id,
    found_doc: existing?.ft_document_number,
    found_conn: existing?.connection
  });
}

// ✅ SAFETY-GUARD: om Bubble returnerar “fel” record → behandla som “not found”
const matched =
  existing &&
  String(existing?.ft_document_number || "").trim() === docNo &&
  String(existing?.connection || "").trim() === String(connection_id);

if (matched) {
  await bubblePatch("FortnoxInvoice", existing._id, payload);
  updated++;
} else {
  await bubbleCreate("FortnoxInvoice", payload);
  created++;
}
      } catch (e) {
        errors++;
        if (!firstError) {
          firstError = {
            docNo,
            message: e.message,
            status: e.status || null,
            detail: e.detail || null
          };
        }
        console.error("[upsert/invoices] create/patch failed", { docNo, message: e.message });
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
  created_ids: createdIds,
  created_debug: createdDebug,
  first_error: firstError
});

  } catch (e) {
    console.error("[/fortnox/upsert/invoices] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert invoice rows (per invoice docno)
app.post("/fortnox/upsert/invoice-rows", async (req, res) => {
  const { connection_id, invoice_docno } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
  if (!invoice_docno) return res.status(400).json({ ok: false, error: "Missing invoice_docno" });

  try {
    // 1) Connection + pause
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    if (conn.is_active === false) return res.json({ ok: true, paused: true, connection_id });

    // 2) Token (refresh vid behov)
    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch("https://mira-exchange.onrender.com/fortnox/connection/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id })
      });
      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }
    if (!accessToken) return res.status(401).json({ ok: false, error: "No access_token available" });

    // 3) Hämta invoice detaljer (innehåller InvoiceRows)
    const url = `https://api.fortnox.se/3/invoices/${encodeURIComponent(String(invoice_docno))}`;
    const r = await fetch(url, {
      headers: {
        Authorization: "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        Accept: "application/json"
      }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ ok: false, error: "Fortnox API error", detail: data });

    const invoice = data?.Invoice || data?.invoice || null;
    const rows = Array.isArray(invoice?.InvoiceRows) ? invoice.InvoiceRows : [];

    // 4) Hitta parent invoice i Bubble (måste finnas)
    const invDocNo = String(invoice?.DocumentNumber || invoice_docno).trim();
    const searchInv = await bubbleFind("FortnoxInvoice", {
      constraints: [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "ft_document_number", constraint_type: "equals", value: invDocNo }
      ],
      limit: 1
    });
    const invObj = Array.isArray(searchInv) && searchInv.length ? searchInv[0] : null;
    if (!invObj?._id) {
      return res.status(404).json({ ok: false, error: "Parent FortnoxInvoice not found in Bubble", invDocNo });
    }

    // 5) Upsert rows med ft_unique_key
    let created = 0, updated = 0, errors = 0;
    let firstError = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = i + 1;
      const rowNo = Number(row?.RowNumber ?? row?.RowNo ?? row?.Row ?? rowIndex);
      const uniqueKey = `${connection_id}::INV::${invDocNo}::${rowIndex}`;
      const payload = {
        connection: connection_id,
        invoice: invObj._id,
        ft_invoice_document_number: invDocNo,
        ft_row_index: rowIndex,
        ft_article_number: String(row?.ArticleNumber || ""),
        ft_description: String(row?.Description || ""),
        ft_quantity: row?.DeliveredQuantity ?? row?.Quantity ?? null,
        ft_unit: String(row?.Unit || ""),
        ft_price: row?.Price == null ? "" : String(row.Price),
        ft_discount: row?.Discount == null ? "" : String(row.Discount),
        ft_vat: row?.VAT == null ? "" : String(row.VAT),
        ft_total: row?.Total == null ? "" : String(row.Total),
        ft_row_no: rowNo,
        ft_unique_key: uniqueKey,
        ft_raw_json: JSON.stringify(row),
        needs_rows_sync: true
      };

      try {
        const found = await bubbleFind("FortnoxInvoiceRow", {
          constraints: [{ key: "ft_unique_key", constraint_type: "equals", value: uniqueKey }],
          limit: 1
        });
        const existing = Array.isArray(found) && found.length ? found[0] : null;

        if (existing?._id) {
          await bubblePatch("FortnoxInvoiceRow", existing._id, payload);
          updated++;
        } else {
          await bubbleCreate("FortnoxInvoiceRow", payload);
          created++;
        }
      } catch (e) {
        errors++;
        if (!firstError) firstError = { uniqueKey, message: e.message, detail: e.detail || null };
      }
    }
// 6) Om alla rader gick bra → markera parent invoice som synkad
if (errors === 0) {
  await bubblePatch("FortnoxInvoice", invObj._id, {
    rows_last_synced_at: new Date().toISOString()
  });
}
    return res.json({ ok: true, connection_id, invoice_docno: invDocNo, counts: { created, updated, errors }, first_error: firstError });
  } catch (e) {
    console.error("[/fortnox/upsert/invoice-rows] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert invoice rows for ALL invoices on one invoices page
app.post("/fortnox/upsert/invoice-rows/page", async (req, res) => {
  try {
    const { connection_id, page = 1, limit = 50, months_back = 12, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    const syncRes = await fetch("https://mira-exchange.onrender.com/fortnox/sync/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });
    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncJson.ok) return res.status(400).json({ ok: false, error: "sync/invoices failed", detail: syncJson });

    const docs = Array.isArray(syncJson.invoices) ? syncJson.invoices : [];
    const results = [];
    let ok_count = 0, fail_count = 0;

    for (let i = 0; i < docs.length; i++) {
      const docNo = String(docs[i]?.DocumentNumber || "").trim();
      if (!docNo) continue;

      const r = await fetch("https://mira-exchange.onrender.com/fortnox/upsert/invoice-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, invoice_docno: docNo })
      });
      const j = await r.json().catch(() => ({}));
      const ok = !!j.ok;

      results.push({ docNo, ok, counts: j.counts || null, first_error: j.first_error || null });
      ok ? ok_count++ : fail_count++;

      if (pause_ms) await new Promise(r => setTimeout(r, pause_ms));
    }

    return res.json({ ok: true, connection_id, page, limit, months_back, docs: docs.length, ok_count, fail_count, results });
  } catch (e) {
    console.error("[/fortnox/upsert/invoice-rows/page] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows (per order docno)
app.post("/fortnox/upsert/order-rows", async (req, res) => {
  const { connection_id, order_docno } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
  if (!order_docno) return res.status(400).json({ ok: false, error: "Missing order_docno" });

  try {
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    if (conn.is_active === false) return res.json({ ok: true, paused: true, connection_id });

    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch("https://mira-exchange.onrender.com/fortnox/connection/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id })
      });
      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }
    if (!accessToken) return res.status(401).json({ ok: false, error: "No access_token available" });

    const url = `https://api.fortnox.se/3/orders/${encodeURIComponent(String(order_docno))}`;
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

    const ordDocNo = String(order?.DocumentNumber || order_docno).trim();

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

// 5) Upsert rows med säker identifiering
let created = 0, updated = 0, errors = 0;
let firstError = null;

const debug = [];

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const rowIndex = i + 1;

  const rowNo = Number(row?.RowNumber ?? row?.RowNo ?? row?.Row ?? rowIndex);

  // ✅ OBS: ORD + ordDocNo + rowIndex
  const rowId = row?.RowId ?? row?.rowId ?? null;

// Bara URL-säkra tecken (ingen : / backticks / etc)
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
    ft_quantity: row?.DeliveredQuantity ?? row?.Quantity ?? null,
    ft_unit: String(row?.Unit || ""),
    ft_price: row?.Price == null ? "" : String(row.Price),
    ft_discount: row?.Discount == null ? "" : String(row.Discount),
    ft_vat: row?.VAT == null ? "" : String(row.VAT),
    ft_total: row?.Total == null ? "" : String(row.Total),
    ft_unique_key: uniqueKey,
    ft_raw_json: JSON.stringify(row || {})
  };

  try {
    const found = await bubbleFind("FortnoxOrderRow", {
  constraints: [
    { key: "ft_unique_key", constraint_type: "equals", value: uniqueKey }
  ],
  limit: 1
});

    const existing = Array.isArray(found) && found.length ? found[0] : null;

    // debug (syns i response så vi slipper Render logs)
    if (debug.length < 5) {
      debug.push({
        rowIndex,
        uniqueKey,
        found_id: existing?._id || null,
        found_key: existing?.ft_unique_key || null,
        found_row_index: existing?.ft_row_index || null
      });
    }

    if (existing?._id) {
      await bubblePatch("FortnoxOrderRow", existing._id, payload);
      updated++;
    } else {
      await bubbleCreate("FortnoxOrderRow", payload);
      created++;
    }

  } catch (e) {
    errors++;
    if (!firstError) firstError = { uniqueKey, message: e.message, detail: e.detail || null };
  }
}
// ✅ efter rows lyckats utan errors: markera parent som synkad
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
  counts: { created, updated, errors },
  first_error: firstError,
  debug_samples: debug
});
      } catch (e) {
    console.error("[/fortnox/upsert/order-rows] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows for FLAGGED orders (needs_rows_sync=true)
app.post("/fortnox/upsert/order-rows/flagged", async (req, res) => {
  try {
    const { connection_id, limit = 30, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    // 1) Hämta flaggade orders i Bubble
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

    // 2) Kör rows per order (docno)
    for (const o of orders) {
      const docNo = String(o?.ft_document_number || "").trim();
      if (!docNo) continue;

      const r = await fetch(`${BASE_URL}/fortnox/upsert/order-rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, order_docno: docNo })
      });

      const j = await r.json().catch(() => ({}));
      const ok = !!j.ok;

results.push({
  docNo,
  ok,
  http_status: r.status,
  counts: j.counts || null,
  first_error: j.first_error || j.error || j.detail || null
});      ok ? ok_count++ : fail_count++;

      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({ ok: true, connection_id, flagged_found: orders.length, ok_count, fail_count, results });
  } catch (e) {
    console.error("[/fortnox/upsert/order-rows/flagged] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows for ALL orders on one orders page
app.post("/fortnox/upsert/order-rows/page", async (req, res) => {
  try {
    const { connection_id, page = 1, limit = 50, months_back = 12, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    const syncRes = await fetch("https://mira-exchange.onrender.com/fortnox/sync/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });
    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncJson.ok) return res.status(400).json({ ok: false, error: "sync/orders failed", detail: syncJson });

    const docs = Array.isArray(syncJson.orders) ? syncJson.orders : [];
    const results = [];
    let ok_count = 0, fail_count = 0;

    for (let i = 0; i < docs.length; i++) {
      const docNo = String(docs[i]?.DocumentNumber || "").trim();
      if (!docNo) continue;

      const r = await fetch("https://mira-exchange.onrender.com/fortnox/upsert/order-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, order_docno: docNo })
      });
      const j = await r.json().catch(() => ({}));
      const ok = !!j.ok;

      results.push({ docNo, ok, counts: j.counts || null, first_error: j.first_error || null });
      ok ? ok_count++ : fail_count++;

      if (pause_ms) await new Promise(r => setTimeout(r, pause_ms));
    }

    return res.json({ ok: true, connection_id, page, limit, months_back, docs: docs.length, ok_count, fail_count, results });
  } catch (e) {
    console.error("[/fortnox/upsert/order-rows/page] error", e);
    return res.status(500).json({ ok: false, error: e.message });
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
// C) Nightly delta sync – ALL FortnoxConnections
app.post("/fortnox/nightly/delta", async (req, res) => {
  if (!BASE_URL) {
  return res.status(500).json({ ok: false, error: "No BASE_URL resolved (env BASE_URL/BUBBLE_BASE_URL or BUBBLE_BASES[0])" });
}
  // skydd mot dubbelkörning (A)
  if (isNightlyRunning()) {
    return res.status(409).json({ ok: false, error: "Nightly already running" });
  }

  startNightly();

  const startedAt = new Date().toISOString();
  const results = [];

  try {
    const connections = await getAllFortnoxConnections();

    for (const conn of connections) {
      const connection_id = conn._id;
      const one = { connection_id };

      try {
        // 1) Customers (ofta små, snabb delta)
        await fetch(`${BASE_URL}/fortnox/upsert/customers`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.MIRA_RENDER_API_KEY
          },
          body: JSON.stringify({ connection_id })
        });

        // 2) Orders (ex Carotte Food)
        await fetch(`${BASE_URL}/fortnox/upsert/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.MIRA_RENDER_API_KEY
          },
          body: JSON.stringify({
            connection_id,
            months_back: 12,
            limit: 50
          })
        });
// 2b) OrderRows (bara för flaggade orders som nyss skapats/uppdaterats)
await fetch(`${BASE_URL}/fortnox/upsert/order-rows/flagged`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.MIRA_RENDER_API_KEY
  },
  body: JSON.stringify({
    connection_id,
    limit: 30,     // kör i batchar, höj sen om du vill
    pause_ms: 250
  })
});
        // 3) Invoices (alla bolag)
        await fetch(`${BASE_URL}/fortnox/upsert/invoices`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.MIRA_RENDER_API_KEY
          },
          body: JSON.stringify({
            connection_id,
            months_back: 12,
            limit: 50
          })
        });

        one.ok = true;
      } catch (e) {
        one.ok = false;
        one.error = e.message;
      }

      results.push(one);

      // snäll paus mellan bolag
      await sleep(500);
    }

    return res.json({
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      connections: results
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (typeof stopNightly === "function") stopNightly();
  }
});
// ────────────────────────────────────────────────────────────
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
    if (!saved) return res.status(502).json({ error: "Bubble save failed" });

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

app.listen(PORT, () => console.log("🚀 Mira Exchange running on port " + PORT));
