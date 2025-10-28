import express from "express";
import cors from "cors";

// Ladda .env lokalt, men skippa i production (Render har egna env vars)
if (process.env.NODE_ENV !== "production") {
  try {
    const { config } = await import("dotenv");
    config();
  } catch (e) {
    console.warn("[dotenv] not loaded (development only)", e?.message || e);
  }
}

const app = express();
app.use(express.json());
app.use(cors());

// --- ENV vars ---
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const REDIRECT_URI = process.env.MS_REDIRECT_URI;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PORT = process.env.PORT || 10000;

// --- Helper ---
const log = (msg, data) => {
  console.log(msg, data ? JSON.stringify(data, null, 2) : "");
};

// -----------------------------------------------------
// 🔹 Health check
// -----------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// -----------------------------------------------------
// 🔹 Refresh Token & Save
// -----------------------------------------------------
app.post("/ms/refresh-save", async (req, res) => {
  const { user_unique_id, refresh_token } = req.body || {};
  log("[/ms/refresh-save] hit", {
    auth: BUBBLE_API_KEY ? "ok" : "missing",
    has_body: !!req.body,
    has_refresh_token: !!refresh_token,
    has_user: !!user_unique_id
  });

  if (!user_unique_id || !refresh_token) {
    return res.status(400).json({ error: "Missing user_unique_id or refresh_token" });
  }

  try {
    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token,
        redirect_uri: REDIRECT_URI
      })
    });

    const tokenData = await tokenRes.json();
    log("[/ms/refresh-save] ms token response", {
      ok: tokenRes.ok,
      status: tokenRes.status,
      has_access_token: !!tokenData.access_token,
      has_refresh_token: !!tokenData.refresh_token,
      expires_in: tokenData.expires_in
    });

    if (!tokenRes.ok || !tokenData.access_token)
      return res.status(400).json({ error: "Token refresh failed", tokenData });

    const payload = {
      bubble_user_id: user_unique_id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || refresh_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      server_now_iso: new Date().toISOString()
    };

    const bases = ["https://mira-fm.com", "https://mira-fm.com/version-test"];
    let saveResult = null;

    for (const base of bases) {
      const wf = `${base}/api/1.1/wf/ms_token_upsert`;
      const r = await fetch(wf, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BUBBLE_API_KEY}`
        },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({}));
      log("[save] try WF", { base, status: r.status, ok: r.ok, j });
      if (r.ok) {
        saveResult = { ok: true, via: "wf", base, status: r.status, j };
        break;
      }
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

  if (!user_unique_id || !event)
    return res.status(400).json({ error: "Missing user_unique_id or event" });

  try {
    // 1) Fetch user token from Bubble
    const userURL = `https://mira-fm.com/version-test/api/1.1/obj/user/${user_unique_id}`;
    const userRes = await fetch(userURL, {
      headers: { Authorization: `Bearer ${BUBBLE_API_KEY}` }
    });
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
      normalizedAttendees.push({
        emailAddress: { address: e },
        type: "required"
      });
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
      id: graphData.id,
      webLink: graphData.webLink,
      hasOnline: !!graphData?.onlineMeeting,
      joinUrl: graphData?.onlineMeeting?.joinUrl || graphData?.onlineMeetingUrl
    });

    if (!graphRes.ok) return res.status(graphRes.status).json({ error: graphData });

    const joinUrl =
      graphData?.onlineMeeting?.joinUrl ||
      graphData?.onlineMeetingUrl ||
      null;

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
app.listen(PORT, () =>
  console.log(`🚀 Mira Exchange running on port ${PORT}`)
);
