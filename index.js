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

async function fetchBubbleUser(user_unique_id) {
  const variants = [
    "https://mira-fm.com/version-test/api/1.1/obj/user/" + user_unique_id,
    "https://mira-fm.com/api/1.1/obj/user/" + user_unique_id,
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
app.get("/health", (_req, res) => res.json({ ok: true }));
// ────────────────────────────────────────────────────────────
// Fortnox OAuth (Render-owned, frontend-agnostic)

// Env read (fail early if missing)
const FORTNOX_CLIENT_ID = process.env.FORTNOX_CLIENT_ID;
const FORTNOX_CLIENT_SECRET = process.env.FORTNOX_CLIENT_SECRET;
const FORTNOX_REDIRECT_URI = process.env.FORTNOX_REDIRECT_URI;

if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET || !FORTNOX_REDIRECT_URI) {
  console.warn("[Fortnox OAuth] Missing env vars", {
    hasClientId: !!FORTNOX_CLIENT_ID,
    hasClientSecret: !!FORTNOX_CLIENT_SECRET,
    hasRedirect: !!FORTNOX_REDIRECT_URI
  });
}

// ── Step 1: Redirect user to Fortnox authorize ───────────────
app.get("/fortnox/authorize", (_req, res) => {
  const state = crypto.randomUUID();

  const url =
    "https://apps.fortnox.se/oauth-v1/authorize" +
    `?client_id=${encodeURIComponent(FORTNOX_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(FORTNOX_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("read write")}` +
    `&state=${encodeURIComponent(state)}`;

  res.redirect(url);
});

// ── Step 2: Fortnox callback + token exchange ─────────────────
app.get("/fortnox/callback", async (req, res) => {
  const { code } = req.query || {};

  if (!code) {
    return res.status(400).send("Missing code from Fortnox");
  }

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

    if (!tokenRes.ok) {
      console.error("[Fortnox OAuth] token error", tokenJson);
      return res.status(400).json(tokenJson);
    }

    // TODO (nästa steg):
    // – spara tokenJson.access_token
    // – spara tokenJson.refresh_token
    // – koppla till Bubble user / company

    // Tillfällig redirect tillbaka till Bubble
    res.redirect("https://mira-fm.com/fortnox-connected");

  } catch (err) {
    console.error("[Fortnox OAuth] callback error", err);
    res.status(500).send("Fortnox OAuth failed");
  }
});

// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
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
/** Exchange CODE or REFRESH TOKEN and save to Bubble */
app.post("/ms/refresh-save", async (req, res) => {
  const {
    user_unique_id, // gamla namnet
    u,              // nya korta
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
      // Logga tydligt i Render
      logMsTokenError("/ms/refresh-save", result, {
        sent: {
          have_code: !!code,
          have_refresh_token: !!refresh_token,
          redirect_used: normalizeRedirect(redirect || REDIRECT_URI),
          scope_used: incomingScope || MS_SCOPE,
          tenant_used: tenant || MS_TENANT
        }
      });

      // Skicka tillbaka detaljerat fel till Bubble
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

// ────────────────────────────────────────────────────────────
// CREATE EVENT (med stöd för room_email / resource-attendee)
app.post("/ms/create-event", async (req, res) => {
  const {
    user_unique_id,
    attendees_emails,
    event,
    ms_access_token,
    ms_refresh_token,
    room_email // NYTT: explicit room-email från Bubble
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

    // ── Attendees + room (resource) ─────────────────────────
    const normalizedAttendees = [];
    const seen = new Set();
    const push = (raw, type = "required") => {
      const e = String(raw || "").trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      normalizedAttendees.push({
        emailAddress: { address: e },
        type // "required" | "optional" | "resource"
      });
    };

    const allAtt =
      Array.isArray(attendees_emails) ? attendees_emails :
      typeof attendees_emails === "string" ? attendees_emails.split(",") :
      Array.isArray(event?.attendees_emails) ? event.attendees_emails :
      typeof event?.attendees_emails === "string" ? event.attendees_emails.split(",") :
      [];
    allAtt.forEach(e => push(e, "required"));

    // Room email kan komma både toppnivå + inne i event
    const roomEmailFromEvent =
      event?.room_email ||
      event?.location_email ||
      event?.locationEmailAddress ||
      null;
    const roomEmail = room_email || roomEmailFromEvent || null;

    if (roomEmail) {
      // Lägg till rummet som resource-attendee
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
        // Viktigt för rum – koppla location till room mailbox
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

// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// 2) Rooms Availability via getSchedule (app-only)
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

    // App-only kräver /users/{anchor}/calendar/getSchedule – välj första rummet som anchor
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
      "$select": "id,subject,organizer,start,end,location,attendees,isAllDay,webLink"
    });

    const url = "https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(roomEmail) + "/calendarView?" + params.toString();
    const data = await graphFetch("GET", url, token);

    res.json({ ok: true, tenant, events: data?.value || [] });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

// ────────────────────────────────────────────────────────────
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
