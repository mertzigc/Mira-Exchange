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

// Acceptera JSON även om Bubble ibland sätter "application/*+json"
app.use(express.json({ type: ["application/json", "application/*+json"] }));
app.use(cors());

// ────────────────────────────────────────────────────────────
/** ENV resolution (stöd båda namnscheman och smart redirect) */
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

const GRAPH_BASE     = "https://graph.microsoft.com/v1.0";
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`;
const PORT           = process.env.PORT || 10000;

// Bubble: försök spara till prod först, sen test
const BUBBLE_BASES = ["https://mira-fm.com", "https://mira-fm.com/version-test"];

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

// Nya hjälpare (rekommenderad av MS Graph-erfarenhet)
// Tillåt "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm", "YYYY-MM-DDTHH:mm:ss"
function toGraphDateTime(local) {
  if (!local) return null;
  const s = String(local).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  return s;
}

// Minimal IANA -> Windows time zone map för vanliga case
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
if (!tz) return "W. Europe Standard Time"; // bättre default för dig
  const t = String(tz).trim();
  // Om det redan är ett Windows ID, behåll det
  if (/Standard Time$/i.test(t)) return t;
  // Vanliga IANA → Windows
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
  return IANA_TO_WINDOWS_TZ[t] || "W. Europe Standard Time";
}

async function fetchBubbleUser(user_unique_id) {
  const variants = [
    `https://mira-fm.com/version-test/api/1.1/obj/user/${user_unique_id}`,
    `https://mira-fm.com/api/1.1/obj/user/${user_unique_id}`,
  ];
  for (const url of variants) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${BUBBLE_API_KEY}` } });
      const j = await r.json().catch(() => ({}));
      if (j?.response) return j.response;
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
      const wf = `${base}/api/1.1/wf/ms_token_upsert`;
      const r = await fetch(wf, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BUBBLE_API_KEY}`,
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

async function refreshWith(refresh_token, scope) {
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token,
    redirect_uri: REDIRECT_URI,
  });
  if (scope) form.set("scope", scope);

  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.access_token, status: r.status, data: j };
}

// ────────────────────────────────────────────────────────────
// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// ────────────────────────────────────────────────────────────
// Refresh & Save (Bubble kallar detta innan create-event ibland)
app.post("/ms/refresh-save", async (req, res) => {
  const { user_unique_id, refresh_token, scope: incomingScope, tenant } = req.body || {};
  log("[/ms/refresh-save] hit", {
    auth: BUBBLE_API_KEY ? "ok" : "missing",
    has_body: !!req.body,
    has_refresh_token: !!refresh_token,
    has_user: !!user_unique_id,
    has_scope: !!incomingScope
  });

  if (!user_unique_id || !refresh_token) {
    return res.status(400).json({ error: "Missing user_unique_id or refresh_token" });
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${tenant || MS_TENANT}/oauth2/v2.0/token`;
  log("[/ms/refresh-save] using token endpoint", { tokenEndpoint, REDIRECT_URI });

  try {
    const form = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token,
      redirect_uri: REDIRECT_URI
    });
    // Ha alltid scope med (stabilare)
    form.set("scope", incomingScope || MS_SCOPE);

    const r = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });
    const j = await r.json().catch(() => ({}));
    log("[/ms/refresh-save] ms token response", {
      ok: r.ok, status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token
    });

    if (!r.ok || !j?.access_token) {
      const action =
        j?.error === "invalid_grant" ? "reconsent_required" :
        j?.error === "invalid_client" ? "check_client_secret" :
        j?.error === "invalid_scope" ? "adjust_scopes" :
        "retry_or_relogin";

      return res.status(401).json({
        error: "Token refresh failed",
        ms_error: j?.error,
        ms_error_description: j?.error_description,
        action
      });
    }

    const saved = await upsertTokensToBubble(user_unique_id, j, j.refresh_token || refresh_token);
    if (!saved) return res.status(502).json({ error: "Bubble save failed" });

    return res.json({ ok: true, saved_for_user: user_unique_id });
  } catch (err) {
    console.error("[/ms/refresh-save] error", err);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// Create Event (robust: token i body → DB → auto-refresh)
// Servern forcerar Teams + allow proposals (du bad om detta)
app.post("/ms/create-event", async (req, res) => {
  const { user_unique_id, attendees_emails, event, ms_access_token, ms_refresh_token } = req.body || {};
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
  });

  if (!user_unique_id || !event) {
    return res.status(400).json({ error: "Missing user_unique_id or event" });
  }

  try {
    // 1) Token via (A) body → (B) DB → (C) auto-refresh
    let accessToken = ms_access_token || null;
    let refreshToken = ms_refresh_token || null;
    let scope = null;

    if (!accessToken || !refreshToken) {
      const u = await fetchBubbleUser(user_unique_id); // kan bli null
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
      const ref = await refreshWith(refreshToken, scope);
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

    // 2) Attendees (0..N, dedupe) – tillåt både top-level och event.attendees_emails
    const normalizedAttendees = [];
    const seen = new Set();
    const push = (raw) => {
      const e = String(raw || "").trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      normalizedAttendees.push({ emailAddress: { address: e }, type: "required" });
    };
    const allAtt =
      Array.isArray(attendees_emails) ? attendees_emails :
      typeof attendees_emails === "string" ? attendees_emails.split(",") :
      Array.isArray(event?.attendees_emails) ? event.attendees_emails :
      typeof event?.attendees_emails === "string" ? event.attendees_emails.split(",") :
      [];
    allAtt.forEach(push);

    // 3) Bygg Graph-event — använder nya helper för tid + Windows-TZ
    const tzInput = event?.tz || event?.start?.timeZone || "Europe/Stockholm";
    const ev = {
      subject: event?.subject || "Untitled event",
      body: {
        contentType: "HTML",
        content: event?.body_html || "",
      },
      start: {
        dateTime: toGraphDateTime(event?.start_iso_local || event?.start?.dateTime || fixDateTime(event?.start_iso_local)),
        timeZone: toWindowsTz(tzInput),
      },
      end: {
        dateTime: toGraphDateTime(event?.end_iso_local || event?.end?.dateTime || fixDateTime(event?.end_iso_local)),
        timeZone: toWindowsTz(tzInput),
      },
      location: {
        displayName: event?.location_name || event?.location?.displayName || "",
      },
      // Server-forcerat online-möte + förslag
      isOnlineMeeting: true,
      allowNewTimeProposals: true,
      onlineMeetingProvider: "teamsForBusiness",
    };

    if (normalizedAttendees.length > 0) ev.attendees = normalizedAttendees;

    // 4) Skapa event
    const graphRes = await fetch(`${GRAPH_BASE}/me/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
      joinUrl: graphData?.onlineMeeting?.joinUrl || graphData?.onlineMeetingUrl,
      // Vid fel – ge lite payload-insikt (utan att dumpa allt)
      error: !graphRes.ok ? graphData?.error : undefined,
      tzSent: ev?.start?.timeZone,
      startSent: ev?.start?.dateTime,
      endSent: ev?.end?.dateTime,
    });

    if (!graphRes.ok) {
      // Skicka tillbaka tydligt fel inkl. status och MS-error
      return res.status(graphRes.status).json({
        ok: false,
        status: graphRes.status,
        error: graphData?.error || graphData
      });
    }

    return res.json({
      ok: true,
      id: graphData.id,
      webLink: graphData.webLink,
      joinUrl: graphData?.onlineMeeting?.joinUrl || graphData?.onlineMeetingUrl || null,
      raw: graphData,
    });
  } catch (err) {
    console.error("[/ms/create-event] error", err);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
app.get("/ms/debug-env", (_req, res) => {
  const mask = (v) => !v ? null : `${String(v).slice(0,3)}...${String(v).slice(-3)}`;
  const sha  = (v) => !v ? null : crypto.createHash("sha256").update(String(v)).digest("hex").slice(0,16) + "…";
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
// ────────────────────────────────────────────────────────────
// Helpers for app-only (client_credentials) Graph calls
const pick = (...vals) => vals.find(v => !!v && String(v).trim()) || null;

const NODE_ENV = process.env.NODE_ENV || "production";
const PORT = parseInt(process.env.PORT || "10000", 10);

// Read BOTH naming schemes (per your canonical rule)
const CLIENT_ID = pick(process.env.MS_APP_CLIENT_ID, process.env.MS_CLIENT_ID);
const CLIENT_SECRET = pick(process.env.MS_APP_CLIENT_SECRET, process.env.MS_CLIENT_SECRET);

// Redirect: prefer unified MS_REDIRECT_URI if present, else use LIVE/DEV
const REDIRECT_URI = pick(
  process.env.MS_REDIRECT_URI,
  process.env.MS_REDIRECT_LIVE,
  process.env.MS_REDIRECT_DEV
);

// Default tenant fallback (can be 'common', but for app-only you should pass real tenant)
const DEFAULT_TENANT = pick(process.env.MS_TENANT, "common");

// small utils
const sha = (s) => (!s ? null : crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 10));
const mask = (s) => (!s ? null : String(s).slice(0, 4) + "…" + String(s).slice(-4));

// Fetch wrapper
async function graphFetch(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": body ? "application/json" : undefined
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = json || { text, status: res.status };
    throw Object.assign(new Error(`Graph ${method} ${url} failed ${res.status}`), { status: res.status, detail });
  }
  return json;
}

// Resolve tenant to use (query param, header, or default)
function resolveTenant(req) {
  return pick(
    req.query.tenant,
    req.headers["x-tenant-id"],
    DEFAULT_TENANT
  );
}

// Get app-only token for a tenant
async function getAppToken(tenant) {
  const t = tenant || DEFAULT_TENANT;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID/CLIENT_SECRET for app-only flow");
  }
  const form = new URLSearchParams();
  form.set("client_id", CLIENT_ID);
  form.set("client_secret", CLIENT_SECRET);
  form.set("grant_type", "client_credentials");
  // Minimal default scopes for app-only
  // For rooms & availability: Place.Read.All + Calendars.Read (app perms) must be consented in the app registration.
  form.set("scope", "https://graph.microsoft.com/.default");

  const tokenEndpoint = `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`;
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  const j = await r.json();
  if (!r.ok) {
    throw Object.assign(new Error("App token fetch failed"), { status: r.status, detail: j });
  }
  if (!j.access_token) {
    throw Object.assign(new Error("No access_token in app token response"), { detail: j });
  }
  return j.access_token;
}

// ────────────────────────────────────────────────────────────
// New endpoints (additive)

// Quick health/debug for app-only
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

// 1) List all Rooms in tenant (Graph places API)
app.get("/ms/places/rooms", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    // You can filter/expand later; start simple:
    // GET https://graph.microsoft.com/v1.0/places/microsoft.graph.room?$top=999
    const base = "https://graph.microsoft.com/v1.0/places/microsoft.graph.room?$top=999";
    const data = await graphFetch("GET", base, token);
    // Normalize a lite payload for Bubble
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

// 2) Availability for given room emails (uses getSchedule)
app.post("/ms/rooms/availability", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    const {
      room_emails = [],
      start, // ISO
      end,   // ISO
      timezone = "Europe/Stockholm",
      intervalMinutes = 30
    } = req.body || {};

    if (!Array.isArray(room_emails) || room_emails.length === 0) {
      return res.status(400).json({ ok: false, error: "room_emails (array) is required" });
    }
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: "start and end (ISO) are required" });
    }

    const body = {
      schedules: room_emails,
      startTime: { dateTime: start, timeZone: timezone },
      endTime:   { dateTime: end,   timeZone: timezone },
      availabilityViewInterval: intervalMinutes
    };

    // POST https://graph.microsoft.com/v1.0/users/getSchedule
    const url = "https://graph.microsoft.com/v1.0/users/getSchedule";
    const data = await graphFetch("POST", url, token, body);

    res.json({ ok: true, tenant, result: data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

// 3) Raw events for a single room calendar (calendarView)
app.get("/ms/rooms/:roomEmail/calendar", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    const { roomEmail } = req.params;
    const { start, end } = req.query; // ISO

    if (!roomEmail) return res.status(400).json({ ok: false, error: "roomEmail is required" });
    if (!start || !end) return res.status(400).json({ ok: false, error: "start & end ISO required" });

    const params = new URLSearchParams({
      startDateTime: String(start),
      endDateTime: String(end),
      // Select a light event shape; extend if you need more
      "$select": "id,subject,organizer,start,end,location,attendees,isAllDay,webLink"
    });

    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(roomEmail)}/calendarView?${params.toString()}`;
    const data = await graphFetch("GET", url, token);

    res.json({ ok: true, tenant, events: data?.value || [] });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});
// ────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`🚀 Mira Exchange running on port ${PORT}`));
