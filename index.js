// index.js (ESM)
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- Helpers ----------
const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest();

function signState(payloadObj) {
  const secret = process.env.MIRAGPT_API_KEY || "dev-secret";
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify(payloadObj)));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}
function verifyState(token) {
  const secret = process.env.MIRAGPT_API_KEY || "dev-secret";
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("bad state token format");
  const data = `${h}.${p}`;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  if (expected !== s) throw new Error("bad state signature");
  return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
}

// ---------- Config ----------
const TENANT = process.env.MS_TENANT || "common";
const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET || ""; // tomt om public client (PKCE only)
const SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "User.Read",
  "Calendars.ReadWrite"
].join(" ");

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL; // ex https://mira-exchange.onrender.com
const REDIRECT_URI = `${PUBLIC_BASE}/ms/callback`;

const BUBBLE_WF_URL = process.env.BUBBLE_WF_URL; // ex https://app.mira-fm.com/api/1.1/wf/ms_token_upsert
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY;
const RETURN_URL_DEFAULT = process.env.BUBBLE_RETURN_URL || "https://app.mira-fm.com/";

// ---------- Public health ----------
app.get("/health", (_, res) => res.send("OK"));

// ---------- Auth guard (för privata routes) ----------
app.use((req, res, next) => {
  const publicPaths = ["/ms/auth", "/ms/callback", "/health"];
  if (publicPaths.includes(req.path)) return next();
  const key = req.headers["x-api-key"];
  if (key !== process.env.MIRAGPT_API_KEY) return res.status(401).send("Unauthorized");
  return next();
});

// ---------- Start OAuth (public) ----------
app.get("/ms/auth", async (req, res) => {
  try {
    const bubbleUserId = String(req.query.u || "");
    const returnUrl = String(req.query.r || RETURN_URL_DEFAULT);
    if (!bubbleUserId) return res.status(400).send("Missing ?u=<bubble_user_id>");

    // PKCE
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(sha256(Buffer.from(codeVerifier)));

    // Packa verifier + metadata i state (HMAC-signerat)
    const state = signState({ u: bubbleUserId, v: codeVerifier, r: returnUrl });

    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    return res.redirect(url.toString());
  } catch (e) {
    console.error("ms/auth error:", e);
    return res.status(500).send("Auth init failed");
  }
});

// ---------- Callback & token exchange (public) ----------
app.get("/ms/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");
    let decoded;
    try { decoded = verifyState(String(state)); }
    catch (e) { console.error("state verify fail:", e); return res.status(400).send("Invalid state"); }

    const { u: bubbleUserId, v: codeVerifier, r: returnUrl } = decoded;
    if (!bubbleUserId || !codeVerifier) return res.status(400).send("State missing data");

    // Exchange code → tokens
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", CLIENT_ID);
    body.set("redirect_uri", REDIRECT_URI);
    body.set("code", String(code));
    body.set("code_verifier", codeVerifier);
    if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error("Token exchange failed:", tokenJson);
      return res.status(500).send("Token exchange failed");
    }

    // Spara i Bubble
    const saveResp = await fetch(BUBBLE_WF_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BUBBLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bubble_user_id: bubbleUserId,
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token,
        expires_in: tokenJson.expires_in,
        scope: tokenJson.scope,
        token_type: tokenJson.token_type,
        server_now_iso: new Date().toISOString()
      })
    });
    const saveJson = await saveResp.json().catch(() => ({}));
    if (!saveResp.ok) {
      console.error("Bubble save failed:", saveJson);
      return res.status(500).send("Bubble save failed");
    }

    // Tillbaka till Bubble-UI
    const back = returnUrl || RETURN_URL_DEFAULT;
    const sep = back.includes("?") ? "&" : "?";
    return res.redirect(`${back}${sep}ok=1`);
  } catch (e) {
    console.error("ms/callback error:", e);
    return res.status(500).send("Callback error");
  }
});

// ---------- Refresh (privat; kräver x-api-key) ----------
app.post("/ms/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).send("Missing refresh_token");

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("client_id", CLIENT_ID);
    if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);
    body.set("refresh_token", refresh_token);

    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("refresh fail:", j);
      return res.status(500).json(j);
    }
    return res.json(j);
  } catch (e) {
    console.error("ms/refresh error:", e);
    return res.status(500).send("refresh error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Mira Exchange server running on", PORT));
