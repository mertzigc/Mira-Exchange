// =======================
// Mira-Exchange / index.js
// =======================

import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || "https://mira-exchange.onrender.com";
const BUBBLE_BASE_URL = process.env.BUBBLE_BASE_URL || "https://mira-fm.com";
const MIRAGPT_API_KEY = process.env.MIRAGPT_API_KEY;

const MS_CLIENT_ID = process.env.MS_APP_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_APP_CLIENT_SECRET;
const MS_TENANT = process.env.MS_TENANT || "common";
const MS_SCOPE =
  process.env.MS_SCOPE ||
  "User.Read Calendars.ReadWrite offline_access openid profile email";
const MS_REDIRECT_LIVE =
  process.env.MS_REDIRECT_LIVE || `${BASE_URL}/ms/callback`;

// ====== SERVER START ======
app.listen(PORT, () => {
  console.log("\n/////////////////////////////////////////");
  console.log(`🚀 Mira Exchange running on port ${PORT}`);
  console.log(`🌐 Health: ${BASE_URL}/health`);
  console.log("/////////////////////////////////////////\n");
});

// ====== HEALTH CHECK ======
app.get("/health", (req, res) => res.send("OK"));

// ====== MICROSOFT LOGIN START ======
app.get("/ms/auth", async (req, res) => {
  try {
    const { u } = req.query;
    if (!u) return res.status(400).send("Missing ?u=user_unique_id");

    const redirectUri = encodeURIComponent(MS_REDIRECT_LIVE);
    const scope = encodeURIComponent(MS_SCOPE);

    const authUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize?client_id=${MS_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&response_mode=query&scope=${scope}&state=${JSON.stringify(
      { u }
    )}`;

    console.log("[/ms/auth] redirecting", { user: u, redirectUri });
    res.redirect(authUrl);
  } catch (e) {
    console.error("[/ms/auth] error:", e);
    res.status(500).send("auth error");
  }
});

// ====== MICROSOFT CALLBACK ======
app.get("/ms/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing code param");

    const decoded = JSON.parse(state || "{}");
    const userUniqueId = decoded.u;
    if (!userUniqueId)
      return res.status(400).send("Missing user ID in state object");

    console.log("[/ms/callback] received token code for", userUniqueId);

    // Exchange auth code for tokens
    const body = new URLSearchParams({
      client_id: MS_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: MS_REDIRECT_LIVE,
      scope: MS_SCOPE,
    });
    if (MS_CLIENT_SECRET) body.set("client_secret", MS_CLIENT_SECRET);

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }
    );

    const tokenData = await tokenRes.json();
    console.log("[/ms/callback] token exchange", {
      ok: tokenRes.ok,
      status: tokenRes.status,
      has_access_token: !!tokenData.access_token,
      has_refresh_token: !!tokenData.refresh_token,
    });

    if (!tokenRes.ok) {
      console.error("Token exchange failed:", tokenData);
      return res.status(500).json(tokenData);
    }

    // Save to Bubble backend
    const saveRes = await fetch(
      `${BUBBLE_BASE_URL}/api/1.1/wf/ms_token_upsert`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MIRAGPT_API_KEY}`,
        },
        body: JSON.stringify({
          user_unique_id: userUniqueId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          scope: tokenData.scope,
          token_type: tokenData.token_type,
          expires_in: tokenData.expires_in,
          ext_expires_in: tokenData.ext_expires_in,
        }),
      }
    );

    const saveResult = await saveRes.json();
    console.log("[/ms/callback] tokens saved to Bubble", {
      ok: saveRes.ok,
      status: saveRes.status,
      body: saveResult,
    });

    if (!saveRes.ok) throw new Error("Bubble save failed");

    // Redirect back to Mira
    const redirectUrl = `${BUBBLE_BASE_URL}/dashboard?ms=connected#`;
    return res.redirect(redirectUrl);
  } catch (e) {
    console.error("[/ms/callback] error:", e);
    res.status(500).send("callback error");
  }
});

// ====== REFRESH TOKEN ======
app.post("/ms/refresh", async (req, res) => {
  try {
    const keyOk = req.headers["x-api-key"] === MIRAGPT_API_KEY;
    console.log("[/ms/refresh] hit", {
      auth: keyOk ? "ok" : "bad",
      has_body: !!req.body,
      has_refresh_token: !!(req.body && req.body.refresh_token),
    });
    if (!keyOk) return res.status(401).json({ error: "Unauthorized" });

    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).send("Missing refresh_token");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: MS_CLIENT_ID,
      refresh_token: String(refresh_token),
    });
    if (MS_CLIENT_SECRET) body.set("client_secret", MS_CLIENT_SECRET);

    const r = await fetch(
      `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }
    );

    const j = await r.json();
    console.log("[/ms/refresh] ms token response", {
      ok: r.ok,
      status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token,
      expires_in: j.expires_in,
    });

    if (!r.ok) return res.status(500).json(j);
    return res.json(j);
  } catch (e) {
    console.error("[/ms/refresh] error:", e);
    return res.status(500).send("refresh error");
  }
});
