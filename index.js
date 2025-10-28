import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ----- Helpers: env aliases -----
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || process.env.MS_APP_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || process.env.MS_APP_CLIENT_SECRET;
const MS_TENANT = process.env.MS_TENANT || "common";
const MS_SCOPE = process.env.MS_SCOPE || "User.Read Calendars.ReadWrite offline_access openid profile email";
const BASE_URL = process.env.BASE_URL; // ex https://mira-exchange.onrender.com
const BUBBLE_BASE_URL = process.env.BUBBLE_BASE_URL; // ex https://mira-fm.com
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY; // Bubble Settings → API → Private key
const MIRAGPT_API_KEY = process.env.MIRAGPT_API_KEY;

// ----- Security: x-api-key för POST till våra ms-endpoints -----
app.use((req, res, next) => {
  const protect = req.path === "/ms/refresh"; // lägg fler POST-endpoints här vid behov
  if (protect) {
    const key = req.headers["x-api-key"];
    if (!key || key !== MIRAGPT_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

// Health
app.get("/health", (_, res) => res.send("OK"));

// ----- 1) Start OAuth -----
app.get("/ms/auth", (req, res) => {
  try {
    const userId = String(req.query.u || "");
    if (!userId) return res.status(400).send("Missing user id");
    if (!BASE_URL) return res.status(500).send("Missing BASE_URL env");

    const params = new URLSearchParams({
      client_id: MS_CLIENT_ID,
      response_type: "code",
      redirect_uri: `${BASE_URL}/ms/callback`,
      response_mode: "query",
      scope: MS_SCOPE,
      state: userId
    });

    const authUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize?${params.toString()}`;
    console.log("[auth] redirect", { userId, authUrl });
    return res.redirect(authUrl);
  } catch (e) {
    console.error("[auth] error", e);
    return res.status(500).send("Auth error");
  }
});

// ----- 2) Callback + exchange + push till Bubble -----
app.get("/ms/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");
    if (!BASE_URL) return res.status(500).send("Missing BASE_URL env");

    const body = new URLSearchParams({
      client_id: MS_CLIENT_ID,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: `${BASE_URL}/ms/callback`
    });

    // confidential client (om secret satt)
    if (MS_CLIENT_SECRET) body.set("client_secret", MS_CLIENT_SECRET);

    const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`;
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("[callback] token exchange failed", tokenData);
      return res.status(500).json(tokenData);
    }

    console.log("[callback] got tokens for user", state);

    // Skicka tokens till Bubble WF
    const wfUrl = `${BUBBLE_BASE_URL}/api/1.1/wf/ms_token_upsert`;
    const saveRes = await fetch(wfUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BUBBLE_API_KEY}`
      },
      body: JSON.stringify({
        bubble_user_id: state,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        token_type: tokenData.token_type,
        scope: tokenData.scope,
        server_now_iso: new Date().toISOString()
      })
    });
    const saveJson = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok) {
      console.error("[callback] bubble save failed", saveJson);
      return res.status(500).json({ error: "bubble_save_failed", saveJson });
    }

    // Tillbaka till appen
    const returnUrl = `${BUBBLE_BASE_URL}/dashboard?ms=connected`;
    return res.redirect(returnUrl);
  } catch (e) {
    console.error("[callback] error", e);
    return res.status(500).send("Callback error");
  }
});

// ----- 3) Refresh endpoint (Bubble -> Render) -----
app.post("/ms/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).send("Missing refresh_token");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: MS_CLIENT_ID,
      refresh_token
    });
    if (MS_CLIENT_SECRET) body.set("client_secret", MS_CLIENT_SECRET);

    const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`;
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("[refresh] fail", j);
      return res.status(500).json(j);
    }
    return res.json(j);
  } catch (e) {
    console.error("[refresh] error", e);
    return res.status(500).send("refresh error");
  }
});

// ----- Start -----
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Mira Exchange running on ${port}`));
