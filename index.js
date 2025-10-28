import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// --- Middleware för API-nyckel ---
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (req.path.startsWith("/ms") && req.method === "POST") {
    if (!key || key !== process.env.MIRAGPT_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

// --- AUTH: Startar Microsoft-login ---
app.get("/ms/auth", (req, res) => {
  try {
    const userId = req.query.u;
    if (!userId) return res.status(400).send("Missing user id");

    const params = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      response_type: "code",
      redirect_uri: `${process.env.BASE_URL}/ms/callback`,
      response_mode: "query",
      scope: process.env.MS_SCOPE,
      state: userId,
    });

    const authUrl = `https://login.microsoftonline.com/${process.env.MS_TENANT || "common"}/oauth2/v2.0/authorize?${params.toString()}`;
    console.log("Redirecting user", userId, "to", authUrl);
    res.redirect(authUrl);
  } catch (e) {
    console.error("Auth error:", e);
    res.status(500).send("Auth error");
  }
});

// --- CALLBACK: Exchange code -> tokens, skicka till Bubble ---
app.get("/ms/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code or state");

  try {
    const body = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${process.env.BASE_URL}/ms/callback`,
    });

    const tokenRes = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT || "common"}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("Token exchange error:", tokenData);
      return res.status(500).json(tokenData);
    }

    console.log("Got tokens for user", state);

    await fetch(`${process.env.BUBBLE_BASE_URL}/api/1.1/wf/ms_token_upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRAGPT_API_KEY,
      },
      body: JSON.stringify({
        bubble_user_id: state,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        token_type: tokenData.token_type,
        scope: tokenData.scope,
        server_now_iso: new Date().toISOString(),
      }),
    });

    res.redirect(`${process.env.BUBBLE_BASE_URL}/dashboard?ms=connected`);
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Callback error");
  }
});

// --- REFRESH: Bubble kallar denna för att uppdatera tokens ---
app.post("/ms/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).send("Missing refresh_token");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      refresh_token,
    });

    const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT || "common"}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json(data);
    res.json(data);
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).send("Refresh error");
  }
});

// --- Start server ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Mira Exchange running on port ${port}`));
