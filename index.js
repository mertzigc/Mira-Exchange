// index.js — Mira Exchange (Render)
// ESM (package.json: { "type": "module" })

import express from "express";
import fetch from "node-fetch";
import cors from "cors";

// ---------- ENV (med alias-stöd) ----------
const BASE_URL = process.env.BASE_URL; // ex https://mira-exchange.onrender.com
const BUBBLE_BASE_URL = process.env.BUBBLE_BASE_URL; // ex https://mira-fm.com
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY; // Bubble Settings → API → Private key (Bearer)
const MIRAGPT_API_KEY = process.env.MIRAGPT_API_KEY;

const MS_CLIENT_ID = process.env.MS_CLIENT_ID || process.env.MS_APP_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || process.env.MS_APP_CLIENT_SECRET; // valfri om public client
const MS_TENANT = process.env.MS_TENANT || "common";
const MS_SCOPE =
  process.env.MS_SCOPE ||
  "User.Read Calendars.ReadWrite offline_access openid profile email";

// ---------- App setup ----------
const app = express();
app.use(cors());
app.use(express.json());

// ---------- Helpers ----------
const tokenUrl = (tenant) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const authorizeUrl = (tenant, params) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;

const b64urlEncode = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString("base64url");
const b64urlDecode = (str) =>
  JSON.parse(Buffer.from(String(str), "base64url").toString("utf8"));

const requireEnv = (name) => {
  if (!process.env[name] || String(process.env[name]).trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
};

// ---------- Security for POSTs to our private endpoints ----------
app.use((req, res, next) => {
  // Skydda endast explicit de POST-routes vi exponerar för Bubble.
  const protectedPaths = ["/ms/refresh"];
  if (req.method === "POST" && protectedPaths.includes(req.path)) {
    const key = req.headers["x-api-key"];
    if (!key || key !== MIRAGPT_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  return next();
});

// ---------- Health / Debug ----------
app.get("/health", (_, res) => res.send("OK"));

app.get("/ms/debug/env", (req, res) => {
  res.json({
    BASE_URL,
    computed_redirect_uri: BASE_URL ? `${BASE_URL}/ms/callback` : null,
    MS_TENANT,
    MS_SCOPE,
    has_BUBBLE_API_KEY: Boolean(BUBBLE_API_KEY),
    has_MS_CLIENT_ID: Boolean(MS_CLIENT_ID),
    has_MS_CLIENT_SECRET: Boolean(MS_CLIENT_SECRET)
  });
});

app.get("/ms/debug/authurl", (req, res) => {
  const u = String(req.query.u || "debug-user");
  const r = req.query.r ? String(req.query.r) : undefined;
  const state = b64urlEncode({ u, r });
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: BASE_URL ? `${BASE_URL}/ms/callback` : "",
    response_mode: "query",
    scope: MS_SCOPE,
    state
  });
  res.send(authorizeUrl(MS_TENANT, params));
});

// ---------- 1) Start OAuth (Bubble → Render) ----------
app.get("/ms/auth", (req, res) => {
  try {
    requireEnv("BASE_URL");
    requireEnv("MS_TENANT");

    const u = String(req.query.u || "");
    if (!u) return res.status(400).send("Missing query param: u (Bubble user id)");

    // Valfri retur-URL efter lyckad koppling
    const r = req.query.r ? String(req.query.r) : undefined;

    const state = b64urlEncode({ u, r });
    const params = new URLSearchParams({
      client_id: MS_CLIENT_ID || "",
      response_type: "code",
      redirect_uri: `${BASE_URL}/ms/callback`,
      response_mode: "query",
      scope: MS_SCOPE,
      state
    });

    const url = authorizeUrl(MS_TENANT, params);
    console.log("[/ms/auth] redirecting", { u, r, url });
    return res.redirect(url);
  } catch (e) {
    console.error("[/ms/auth] error:", e);
    return res.status(500).send(e.message || "Auth error");
  }
});

// ---------- 2) Callback (Microsoft → Render) ----------
app.get("/ms/callback", async (req, res) => {
  try {
    requireEnv("BASE_URL");
    requireEnv("BUBBLE_BASE_URL");
    requireEnv("BUBBLE_API_KEY");

    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");

    let decoded;
    try {
      decoded = b64urlDecode(state);
    } catch (e) {
      console.error("[/ms/callback] state decode error:", e);
      return res.status(400).send("Invalid state");
    }
    const bubbleUserId = String(decoded.u || "");
    const returnUrl = decoded.r
      ? String(decoded.r)
      : `${BUBBLE_BASE_URL}/dashboard?ms=connected`;

    if (!bubbleUserId) return res.status(400).send("State missing user id");

    // Exchange code → tokens
    const body = new URLSearchParams({
      client_id: MS_CLIENT_ID || "",
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: `${BASE_URL}/ms/callback`
    });
    if (MS_CLIENT_SECRET) body.set("client_secret", MS_CLIENT_SECRET);

    const tRes = await fetch(tokenUrl(MS_TENANT), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokens = await tRes.json();

    if (!tRes.ok) {
      console.error("[/ms/callback] token exchange failed:", tokens);
      return res.status(500).json(tokens);
    }

    console.log("[/ms/callback] tokens received for user", bubbleUserId, {
      has_access_token: Boolean(tokens.access_token),
      has_refresh_token: Boolean(tokens.refresh_token),
      expires_in: tokens.expires_in
    });

    // Push tokens till Bubble backend WF
    const saveRes = await fetch(`${BUBBLE_BASE_URL}/api/1.1/wf/ms_token_upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BUBBLE_API_KEY}`
      },
      body: JSON.stringify({
        bubble_user_id: bubbleUserId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        token_type: tokens.token_type,
        scope: tokens.scope,
        server_now_iso: new Date().toISOString()
      })
    });

    const saveJson = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok) {
      console.error("[/ms/callback] bubble save failed:", saveJson);
      return res.status(500).json({ error: "bubble_save_failed", details: saveJson });
    }

    console.log("[/ms/callback] tokens saved to Bubble for user", bubbleUserId);
    return res.redirect(returnUrl);
  } catch (e) {
    console.error("[/ms/callback] error:", e);
    return res.status(500).send("Callback error");
  }
});

// ---------- 3) Refresh (Bubble → Render) ----------
app.post("/ms/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).send("Missing refresh_token");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: MS_CLIENT_ID || "",
      refresh_token: String(refresh_token)
    });
    if (MS_CLIENT_SECRET) body.set("client_secret", MS_CLIENT_SECRET);

    const r = await fetch(tokenUrl(MS_TENANT), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("[/ms/refresh] fail:", j);
      return res.status(500).json(j);
    }
    return res.json(j);
  } catch (e) {
    console.error("[/ms/refresh] error:", e);
    return res.status(500).send("refresh error");
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Mira Exchange running on port ${PORT}`);
  console.log(`   Health: ${BASE_URL ? BASE_URL : "http://localhost:"+PORT}/health`);
});
