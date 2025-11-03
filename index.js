// Mira-Exchange SoT: supports MS_CLIENT_* and MS_APP_CLIENT_* envs.
// Redirect picks MS_REDIRECT_URI || MS_REDIRECT_LIVE || MS_REDIRECT_DEV || onrender callback.
// Keep /ms/debug-env for quick diagnostics. Last verified: 2025-11-03.

import express from "express";
import cors from "cors";
import crypto from "node:crypto";

// Load .env locally (Render uses its own env injector)
if (process.env.NODE_ENV !== "production") {
  try {
    const { config } = await import("dotenv");
    config();
  } catch (e) {
    console.warn("[dotenv] not loaded (dev only)", e?.message || e);
  }
}

const app = express();
app.use(express.json());
app.use(cors());

// --- ENV vars (read both schemes, pick best redirect) ---
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY || "";

// client id: prefer MS_CLIENT_ID, then MS_APP_CLIENT_ID
const CLIENT_ID =
  process.env.MS_CLIENT_ID ||
  process.env.MS_APP_CLIENT_ID ||
  "";

// client secret: prefer MS_CLIENT_SECRET, then MS_APP_CLIENT_SECRET
const CLIENT_SECRET =
  process.env.MS_CLIENT_SECRET ||
  process.env.MS_APP_CLIENT_SECRET ||
  "";

// redirect: prefer explicit URI, else LIVE, else DEV, else onrender callback
const REDIRECT_URI =
  process.env.MS_REDIRECT_URI ||
  process.env.MS_REDIRECT_LIVE ||
  process.env.MS_REDIRECT_DEV ||
  "https://mira-exchange.onrender.com/ms/callback";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PORT = process.env.PORT || 10000;

// --- Helper ---
const log = (msg, data) => {
  console.log(msg, data ? JSON.stringify(data, null, 2) : "");
};

// Normalize "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss" and add :00 if missing
const fixDateTime = (s) => {
  if (!s) return s;
  let v = String(s).trim();
  v = v.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(:\d{2})?)$/, "$1T$2");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v += ":00";
  return v;
};

// -----------------------------------------------------
// 🔹 Health check
// -----------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// -----------------------------------------------------
// 🔹 (Optional) OAuth callback (for testing consent flows)
// -----------------------------------------------------
app.get("/ms/callback", (req, res) => {
  const { code, state, error, error_description } = req.query || {};
  log("[/ms/callback] hit", { code_present: !!code, state, error, error_description });
  res.status(200).send("Mira-Exchange callback OK. Check server logs for details.");
});

// -----------------------------------------------------
// 🔹 Refresh Token & Save (robust w/ scope retry + clear errors)
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

  const tokenEndpoint = `https://login.microsoftonline.com/${tenant || "common"}/oauth2/v2.0/token`;
  log("[/ms/refresh-save] using token endpoint", { tokenEndpoint, REDIRECT_URI });

  const doRefresh = async (scopeValue) => {
    const params = {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token,
      redirect_uri: REDIRECT_URI
    };
    if (scopeValue) params.scope = scopeValue;

    // Maskad diagnostik
    const maskHash = (txt) => (txt ? crypto.createHash("sha256").update(String(txt)).digest("hex").slice(0, 16) + "…" : null);
    log("[/ms/refresh-save] outgoing form (masked)", {
      client_id_len: (CLIENT_ID || "").length,
      client_secret_len: (CLIENT_SECRET || "").length,
      client_secret_sha256_prefix: maskHash(CLIENT_SECRET),
      has_redirect: !!REDIRECT_URI,
      scope_included: !!scopeValue
    });

    const r = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params)
    });
    const j = await r.json().catch(() => ({}));
    log("[/ms/refresh-save] ms token response", {
      ok: r.ok,
      status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token,
      error: j?.error,
      error_description: j?.error_description
    });
    return { r, j };
  };

  try {
    // 1) First try (optionally with scope provided by caller)
    let { r, j } = await doRefresh(incomingScope);

    // 2) If failed and no scope provided, fetch saved scope from Bubble and retry once
    if ((!r.ok || !j?.access_token) && !incomingScope) {
      try {
        const userURL = `https://mira-fm.com/version-test/api/1.1/obj/user/${user_unique_id}`;
        const uRes = await fetch(userURL, { headers: { Authorization: `Bearer ${BUBBLE_API_KEY}` } });
        const uJson = await uRes.json().catch(() => ({}));
        const savedScope = uJson?.response?.ms_scope || uJson?.response?.scope;
        if (savedScope) {
          log("[/ms/refresh-save] retry with saved scope", { savedScope });
          ({ r, j } = await doRefresh(savedScope));
        }
      } catch (e) {
        log("[/ms/refresh-save] failed to load user scope for retry", { e: String(e) });
      }
    }

    if (!r.ok || !j?.access_token) {
      const action =
        j?.error === "invalid_grant" ? "reconsent_required" :
        j?.error === "invalid_client" ? "check_client_credentials" :
        j?.error === "invalid_scope" ? "adjust_scopes" :
        j?.error === "invalid_request" ? "check_redirect_uri" :
        "retry_or_relogin";

      return res.status(400).json({
        error: "Token refresh failed",
        ms_error: j?.error,
        ms_error_description: j?.error_description,
        action,
        used_redirect_uri: REDIRECT_URI
      });
    }

    // Save to Bubble
    const payload = {
      bubble_user_id: user_unique_id,
      access_token: j.access_token,
      refresh_token: j.refresh_token || refresh_token,
      expires_in: j.expires_in,
      token_type: j.token_type,
      scope: j.scope,
      server_now_iso: new Date().toISOString()
    };

    const bases = ["https://mira-fm.com", "https://mira-fm.com/version-test"];
    let saveResult = null;

    for (const base of bases) {
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

// -----------------------------------------------------
// 🔹 Create Calendar Event (adds Teams join link)
// -----------------------------------------------------
app.post("/ms/create-event", async (req, res) => {
  const { user_unique_id, attendees_emails, event } = req.body || {};
  log("[/ms/create-event] hit", {
    has_user: !!user_unique_id,
    has_event: !!event,
    attendees_count: Array.isArray(attendees_emails)
      ? attendees_emails.length
      : (typeof attendees_emails === "string" && attendees_emails.trim() ? attendees_emails.split(",").length : 0)
  });

  if (!user_unique_id || !event) {
    return res.status(400).json({ error: "Missing user_unique_id or event" });
  }

  try {
    // 1) Fetch user token from Bubble
    const userURL = `https://mira-fm.com/version-test/api/1.1/obj/user/${user_unique_id}`;
    const userRes = await fetch(userURL, { headers: { Authorization: `Bearer ${BUBBLE_API_KEY}` } });
    const userData = await userRes.json();

    const accessToken = userData?.response?.ms_access_token;
    if (!accessToken) throw new Error("User has no ms_access_token");

    // 2) Normalize attendees (0..N)
    let normalizedAttendees = [];
    const pushUnique = (email, seen) => {
      const e = String(email || "").trim();
      if (!e) return;
      const lower = e.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      normalizedAttendees.push({ emailAddress: { address: e }, type: "required" });
    };

    if (Array.isArray(attendees_emails)) {
      const seen = new Set();
      for (const raw of attendees_emails) pushUnique(raw, seen);
    } else if (typeof attendees_emails === "string") {
      const parts = attendees_emails.split(",");
      const seen = new Set();
      for (const raw of parts) pushUnique(raw, seen);
    }

    // 3) Build event payload
    const eventToCreate = { ...event };

    // Normalize dateTimes coming from Bubble (handles " " vs "T")
    if (eventToCreate?.start?.dateTime) {
      eventToCreate.start.dateTime = fixDateTime(eventToCreate.start.dateTime);
    }
    if (eventToCreate?.end?.dateTime) {
      eventToCreate.end.dateTime = fixDateTime(eventToCreate.end.dateTime);
    }

    if (normalizedAttendees.length > 0) eventToCreate.attendees = normalizedAttendees;

    const wantsOnline =
      eventToCreate.isOnlineMeeting === true ||
      eventToCreate.onlineMeetingProvider === "teamsForBusiness" ||
      (typeof eventToCreate.isOnlineMeeting === "undefined" &&
       typeof eventToCreate.onlineMeetingProvider === "undefined");

    if (wantsOnline) {
      eventToCreate.isOnlineMeeting = true;
      if (!eventToCreate.onlineMeetingProvider) {
        eventToCreate.onlineMeetingProvider = "teamsForBusiness";
      }
    }

    // 4) Create event in Graph
    const graphRes = await fetch(`${GRAPH_BASE}/me/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(eventToCreate)
    });

    const graphData = await graphRes.json();
    log("[/ms/create-event] graph response", {
      ok: graphRes.ok,
      status: graphRes.status,
      id: graphData?.id,
      webLink: graphData?.webLink,
      hasOnline: !!graphData?.onlineMeeting,
      joinUrl: graphData?.onlineMeeting?.joinUrl || graphData?.onlineMeetingUrl
    });

    if (!graphRes.ok) {
      log("[/ms/create-event] graph error body", {
        status: graphRes.status,
        error: graphData?.error?.code,
        message: graphData?.error?.message
      });
      return res.status(graphRes.status).json({ error: graphData });
    }

    const joinUrl = graphData?.onlineMeeting?.joinUrl || graphData?.onlineMeetingUrl || null;

    res.json({
      ok: true,
      id: graphData.id,
      webLink: graphData.webLink,
      joinUrl,
      raw: graphData
    });
  } catch (err) {
    console.error("[/ms/create-event] error", err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------
// 🔎 Maskad env-debug med källa (remove/protect after use)
// -----------------------------------------------------
app.get("/ms/debug-env", async (req, res) => {
  const pick = (keys) => {
    for (const k of keys) if (process.env[k]) return { key: k, value: process.env[k] };
    return { key: null, value: null };
  };

  const id = pick(["MS_CLIENT_ID", "MS_APP_CLIENT_ID"]);
  const secret = pick(["MS_CLIENT_SECRET", "MS_APP_CLIENT_SECRET"]);
  const redirect = pick(["MS_REDIRECT_URI", "MS_REDIRECT_LIVE", "MS_REDIRECT_DEV"]);

  const mask = (v) => (v ? v.slice(0, 3) + "…" + v.slice(-3) : null);
  const sha = (v) => (v ? crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 16) + "…" : null);

  res.json({
    client_id_source: id.key, client_id_preview: mask(id.value),
    client_secret_source: secret.key, client_secret_len: secret.value ? secret.value.length : 0, client_secret_sha256_prefix: sha(secret.value),
    redirect_source: redirect.key, redirect_uri: redirect.value || null,
    chosen_redirect_uri: REDIRECT_URI
  });
});

// -----------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Mira Exchange running on port ${PORT}`);
});
