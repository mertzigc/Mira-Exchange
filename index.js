import express from "express";
import cors from "cors";
import crypto from "node:crypto";

// Load .env lokalt (Render injicerar env själv i prod)
if (process.env.NODE_ENV !== "production") {
  try {
    const { config } = await import("dotenv");
    config();
  } catch (e) {
    console.warn("[dotenv] not loaded (dev only)", e?.message || e);
  }
}

const app = express();

// Tillåt bara korrekt JSON: skyddar mot text/plain → JSON-parse-fel
app.use(express.json({ type: ["application/json", "application/*+json"] }));
app.use(cors());

// ---------- ENV resolution (stöder båda scheman) ----------
const pick = (...vals) => vals.find(v => !!v && String(v).trim()) || null;

const CLIENT_ID     = pick(process.env.MS_CLIENT_ID,     process.env.MS_APP_CLIENT_ID);
const CLIENT_SECRET = pick(process.env.MS_CLIENT_SECRET, process.env.MS_APP_CLIENT_SECRET);

// Redirect: MS_REDIRECT_URI → fallback LIVE/DEV (prioritera LIVE i production)
const NODE_ENV = process.env.NODE_ENV || "production";
const REDIRECT_URI = pick(
  process.env.MS_REDIRECT_URI,
  NODE_ENV === "production" ? process.env.MS_REDIRECT_LIVE : null,
  process.env.MS_REDIRECT_DEV,
  process.env.MS_REDIRECT_LIVE
);

// Scope & tenant (valfritt, bra default)
const MS_SCOPE  = pick(process.env.MS_SCOPE, "User.Read Calendars.ReadWrite offline_access openid profile email");
const MS_TENANT = pick(process.env.MS_TENANT, "common");

const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY || process.env.MIRAGPT_API_KEY;
const GRAPH_BASE     = "https://graph.microsoft.com/v1.0";
const PORT           = process.env.PORT || 10000;

// ---------- Helpers ----------
const log = (msg, data) => console.log(msg, data ? JSON.stringify(data, null, 2) : "");

// "YYYY-MM-DD HH:mm[:ss]" → "YYYY-MM-DDTHH:mm:ss"
const fixDateTime = (s) => {
  if (!s) return s;
  let v = String(s).trim();
  v = v.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(:\d{2})?)$/, "$1T$2");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v += ":00";
  return v;
};

// Försök spara först i prod, annars i test
const bubbleBases = ["https://mira-fm.com", "https://mira-fm.com/version-test"];

// -----------------------------------------------------
// Health
// -----------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// -----------------------------------------------------
// Refresh & Save
// -----------------------------------------------------
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

  // Gör token-refresh
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token,
    redirect_uri: REDIRECT_URI
  });
  if (incomingScope || MS_SCOPE) form.set("scope", incomingScope || MS_SCOPE);

  try {
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

    // Spara i Bubble (prod -> test)
    const payload = {
      bubble_user_id: user_unique_id,
      access_token: j.access_token,
      refresh_token: j.refresh_token || refresh_token,
      expires_in: j.expires_in,
      token_type: j.token_type,
      scope: j.scope,
      server_now_iso: new Date().toISOString()
    };

    let saveResult = null;
    for (const base of bubbleBases) {
      const wf = `${base}/api/1.1/wf/ms_token_upsert`;
      const r2 = await fetch(wf, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BUBBLE_API_KEY}`
        },
        body: JSON.stringify(payload)
      });
      const j2 = await r2.json().catch(() => ({}));
      log("[save] try WF", { base, status: r2.status, ok: r2.ok, j: j2 });
      if (r2.ok) { saveResult = { ok: true, via: "wf", base, status: r2.status, j: j2 }; break; }
    }

    if (!saveResult) throw new Error("No Bubble save succeeded");
    res.json(saveResult);

  } catch (err) {
    console.error("[/ms/refresh-save] error", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- helpers överst i filen (behåll om du redan har dem) ----------
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${process.env.MS_TENANT || "common"}/oauth2/v2.0/token`;
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY;

// Hämta user från Bubble (test först, sedan live som fallback)
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

async function refreshWith(refresh_token, scope) {
  const form = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || process.env.MS_APP_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET || process.env.MS_APP_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token,
    redirect_uri:
      process.env.MS_REDIRECT_URI ||
      process.env.MS_REDIRECT_LIVE ||
      process.env.MS_REDIRECT_DEV,
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

  const bases = ["https://mira-fm.com", "https://mira-fm.com/version-test"];
  for (const base of bases) {
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
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

// Gör ISO robust: "YYYY-MM-DD HH:mm" -> "YYYY-MM-DDTHH:mm:00"
const fixDateTime = (s) => {
  if (!s) return s;
  let v = String(s).trim();
  v = v.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(:\d{2})?)$/, "$1T$2");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v += ":00";
  return v;
};

// -----------------------------------------------------
// 🔹 Create Calendar Event (robust: body token OR DB OR auto-refresh)
// -----------------------------------------------------
app.post("/ms/create-event", async (req, res) => {
  const { user_unique_id, attendees_emails, event, ms_access_token, ms_refresh_token } = req.body || {};
  log("[/ms/create-event] hit", {
    has_user: !!user_unique_id,
    has_event: !!event,
    attendees_count: Array.isArray(attendees_emails)
      ? attendees_emails.length
      : (typeof attendees_emails === "string" && attendees_emails.trim() ? attendees_emails.split(",").length : 0),
    body_has_access: !!ms_access_token,
    body_has_refresh: !!ms_refresh_token,
  });

  if (!user_unique_id || !event) {
    return res.status(400).json({ error: "Missing user_unique_id or event" });
  }

  try {
    // 1) Hämta token via (A) body → (B) DB → (C) auto-refresh
    let accessToken = ms_access_token || null;
    let refreshToken = ms_refresh_token || null;
    let scope = null;

    if (!accessToken || !refreshToken) {
      const u = await fetchBubbleUser(user_unique_id); // kan vara null
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
        // spara tillbaka till Bubble (prod->test fallback)
        await upsertTokensToBubble(user_unique_id, ref.data, newRefresh);
      }
    }

    if (!accessToken) {
      return res.status(401).json({ error: "User has no ms_access_token (and refresh missing/failed)" });
    }

    // 2) Normalisera attendees (0..N)
    const normalizedAttendees = [];
    const seen = new Set();
    const push = (raw) => {
      const e = String(raw || "").trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      normalizedAttendees.push({ emailAddress: { address: e }, type: "required" });
    };
    if (Array.isArray(attendees_emails)) attendees_emails.forEach(push);
    else if (typeof attendees_emails === "string") attendees_emails.split(",").forEach(push);

    // 3) Bygg Graph-payload
    const ev = { ...event };

    // servern forcerar Teams + proposals
    ev.isOnlineMeeting = true;
    ev.onlineMeetingProvider = "teamsForBusiness";
    ev.allowNewTimeProposals = true;

    if (ev?.start?.dateTime) ev.start.dateTime = fixDateTime(ev.start.dateTime);
    if (ev?.end?.dateTime)   ev.end.dateTime   = fixDateTime(ev.end.dateTime);
    if (normalizedAttendees.length > 0) ev.attendees = normalizedAttendees;

    // 4) Skapa event i Graph
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
    });

    if (!graphRes.ok) {
      return res.status(graphRes.status).json({ error: graphData });
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
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------
// /ms/debug-env – maskad
// -----------------------------------------------------
app.get("/ms/debug-env", (_req, res) => {
  const mask = (v) => !v ? null : `${String(v).slice(0,3)}...${String(v).slice(-3)}`;
  const sha = (v) => !v ? null : crypto.createHash("sha256").update(String(v)).digest("hex").slice(0,16) + "…";
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

// -----------------------------------------------------
app.listen(PORT, () => console.log(`🚀 Mira Exchange running on port ${PORT}`));
