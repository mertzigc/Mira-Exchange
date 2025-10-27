import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// CORS
const allowed = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowed.some(a => origin.startsWith(a))) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const getRedirect = env => env === "live"
  ? process.env.MS_REDIRECT_LIVE
  : process.env.MS_REDIRECT_DEV;

// API-nyckel (valfritt)
const checkKey = (req, res, next) => {
  if (!process.env.MIRAGPT_API_KEY) return next();
  if (req.headers["x-api-key"] === process.env.MIRAGPT_API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
};

// Exchange: code -> tokens
app.post("/ms/oauth/exchange", checkKey, async (req, res) => {
  try {
    const { code, env } = req.body;
    if (!code) return res.status(400).json({ error: "missing_code" });
    const redirect_uri = getRedirect(env === "live" ? "live" : "dev");

    const body = new URLSearchParams({
      client_id: process.env.MS_APP_CLIENT_ID,
      client_secret: process.env.MS_APP_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri,
      scope: "openid profile email offline_access User.Read Calendars.ReadWrite"
    });

    const r = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json(json);
    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// Refresh: refresh_token -> new access_token
app.post("/ms/oauth/refresh", checkKey, async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: "missing_refresh_token" });

    const body = new URLSearchParams({
      client_id: process.env.MS_APP_CLIENT_ID,
      client_secret: process.env.MS_APP_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token
    });

    const r = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json(json);
    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("OAuth server on", port));
