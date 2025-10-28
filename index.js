import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// --- helpers ---
const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

// HMAC-signerat state (ingen server-side storage behövs)
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
  const [headerB64, payloadB64, sig] = token.split(".");
  if (!headerB64 || !payloadB64 || !sig) throw new Error("bad state token format");
  const data = `${headerB64}.${payloadB64}`;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  if (expected !== sig) throw new Error("bad state signature");
  const json = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  return json;
}

// Protect all private routes with x-api-key (behåll din tidigare middleware)
app.use((req, res, next) => {
  const publicPaths = ["/ms/auth", "/ms/callback", "/health"];
  if (publicPaths.includes(req.path)) return next();
  const key = req.headers["x-api-key"];
  if (key !== process.env.MIRAGPT_API_KEY) return res.status(401).send("Unauthorized");
  return next();
});

app.get("/health", (_, res) => res.send("OK"));

// --- MS OAuth config ---
const TENANT = process.env.MS_TENANT || "common";
const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET; // om public client, lämna tomt
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

// 1) starta OAuth (Bubble länkar hit)
app.get("/ms/auth", async (req, res) => {
  try {
    const bubbleUserId = String(req.query.u || "");
    if (!bubbleUserId) return res.status(400).send("Missing ?u=<bubble_user_id>");

    // PKCE: skapa verifier & challenge
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(sha256(Buffer.from(codeVerifier)));

    // Encoda verifier in i state (ingen server store)
    const state = signState({
      u: bubbleUserId,
      v: codeVerifier,
      r: process.env.BUBBLE_RETURN_URL || "" // valfri "return-to" i Bubble
    });

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

// 2) callback → exchange code → spara i Bubble → redirecta till Bubble
app.get("/ms/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");

    let decoded;
    try {
      decoded = verifyState(String(state));
    } catch (e) {
      console.error("state verify fail:", e);
      return res.status(400).send("Invalid state");
    }

    const { u: bubbleUserId, v: codeVerifier, r: returnUrl } = decoded;
    if (!bubbleUserId || !codeVerifier) return res.status(400).send("State missing data");

    // Exchange
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", CLIENT_ID);
    body.set("redirect_uri", REDIRECT_URI);
    body.set("code", String(code));
    body.set("code_verifier", codeVerifier);
    if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET); // om confidential client

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

    // Extrahera
    const {
      access_token,
      refresh_token,
      expires_in,
      scope,
      id_token,
      token_type
    } = tokenJson;

    // (valfritt) decoda id_token för tenant oid, preferred_username etc
    // Här pushar vi tokens till Bubble backend WF
    const bubbleUrl = process.env.BUBBLE_WF_URL;
    const saveResp = await fetch(bubbleUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.BUBBLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bubble_user_id: bubbleUserId,
        access_token,
        refresh_token,
        expires_in,
        scope,
        token_type,
        // (tips) spara även serverns "now" så du kan räkna ut expires_at i Bubble
        server_now_iso: new Date().toISOString()
      })
    });

    const saveJson = await saveResp.json().catch(() => ({}));
    if (!saveResp.ok) {
      console.error("Bubble save failed:", saveJson);
      return res.status(500).send("Bubble save failed");
    }

    // tillbaka till Bubble-UI
    const back = returnUrl || "https://app.mira-fm.com/";
    const sep = back.includes("?") ? "&" : "?";
    return res.redirect(`${back}${sep}ok=1`);
  } catch (e) {
    console.error("ms/callback error:", e);
    return res.status(500).send("Callback error");
  }
});

// --- (valfri) refresh endpoint om du vill sköta refresh på servern ---
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

// starta appen (Render använder PORT env)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("MiraGPT server running on", PORT));
