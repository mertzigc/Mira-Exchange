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

// Bubble
const BUBBLE_BASE_URL = process.env.BUBBLE_BASE_URL || "https://mira-fm.com";
const BUBBLE_API_KEY = process.env.MIRAGPT_API_KEY || process.env.BUBBLE_API_KEY;

// Microsoft
const MS_CLIENT_ID = process.env.MS_APP_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_APP_CLIENT_SECRET; // kan vara tom i public client
const MS_TENANT = process.env.MS_TENANT || "common";
const MS_SCOPE =
  process.env.MS_SCOPE ||
  "User.Read Calendars.ReadWrite offline_access openid profile email";
const MS_REDIRECT_LIVE =
  process.env.MS_REDIRECT_LIVE || `${BASE_URL}/ms/callback`;

// ====== HELPERS ======

function buildBubbleBases() {
  // Prova både live och version-test robust
  const bases = [];
  const base = (BUBBLE_BASE_URL || "").replace(/\/$/, "");

  if (!base) return bases;

  // om man redan satt version-test som bas, lägg den först
  if (base.includes("/version-test")) {
    bases.push(base);
    bases.push(base.replace("/version-test", ""));
  } else {
    bases.push(base);
    bases.push(`${base}/version-test`);
  }
  // rensa ev. dubbel "/version-test/version-test"
  return bases.map((b) =>
    b.replace("/version-test/version-test", "/version-test")
  );
}

// Spara via WF och falla tillbaka till Data API på user/:id
async function saveTokensToBubbleByAnyMeans({
  user_unique_id, // Bubble "Unique id"
  access_token,
  refresh_token,
  scope,
  token_type,
  expires_in,
  ext_expires_in,
}) {
  const payload = {
    user_unique_id,
    access_token,
    refresh_token,
    scope,
    token_type,
    expires_in,
    ext_expires_in,
    server_now_iso: new Date().toISOString(),
  };

  // 1) Först försök API Workflow (live -> version-test)
  const bases = buildBubbleBases();
  for (const base of bases) {
    const wfUrl = `${base}/api/1.1/wf/ms_token_upsert`;
    try {
      const r = await fetch(wfUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BUBBLE_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      console.log("[save] try WF", { base, status: r.status, ok: r.ok, j });
      if (r.ok) return { ok: true, via: "wf", base, status: r.status, j };
      // prova nästa bas bara vid 404/NOT_FOUND
      if (r.status !== 404) {
        // annat fel -> avbryt och returnera
        return { ok: false, via: "wf", base, status: r.status, j };
      }
    } catch (e) {
      console.log("[save] WF error", { base, error: String(e) });
    }
  }

  // 2) Fallback: Data API PUT /obj/user/:id
  for (const base of bases) {
    const putUrl = `${base}/api/1.1/obj/user/${encodeURIComponent(
      user_unique_id
    )}`;
    try {
      // Bubble förväntar sig fältnamn enligt din databas
      const body = {
        ms_access_token: access_token,
        ms_scope: scope,
        ms_token_type: token_type,
        // ms_expires_at: beräknas från expires_in
        ms_expires_at: new Date(Date.now() + (Number(expires_in) - 120) * 1000)
          .toISOString()
          .replace("Z", "+00:00"), // ISO som Bubble gillar
      };
      if (refresh_token) body.ms_refresh_token = refresh_token;

      const r = await fetch(putUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BUBBLE_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      console.log("[save] try DataAPI PUT user", {
        base,
        status: r.status,
        ok: r.ok,
        j,
      });
      if (r.ok) return { ok: true, via: "data_api", base, status: r.status, j };
      if (r.status !== 404) {
        return { ok: false, via: "data_api", base, status: r.status, j };
      }
    } catch (e) {
      console.log("[save] DataAPI error", { base, error: String(e) });
    }
  }

  return {
    ok: false,
    via: "exhausted",
    error: "Could not save via WF or Data API",
  };
}

async function msTokenExchange({ grant_type, code, refresh_token, redirect_uri }) {
  const form = new URLSearchParams();
  form.set("client_id", MS_CLIENT_ID || "");
  form.set("grant_type", grant_type);
  if (code) form.set("code", code);
  if (refresh_token) form.set("refresh_token", refresh_token);
  if (redirect_uri) form.set("redirect_uri", redirect_uri);
  form.set("scope", MS_SCOPE);
  if (MS_CLIENT_SECRET) form.set("client_secret", MS_CLIENT_SECRET);

  const url = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json();
  return { r, j };
}

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
    const state = encodeURIComponent(JSON.stringify({ u }));

    const authUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize?client_id=${MS_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&response_mode=query&scope=${scope}&state=${state}`;

    console.log("[/ms/auth] redirecting", { u, redirectUri });
    res.redirect(authUrl);
  } catch (e) {
    console.error("[/ms/auth] error:", e);
    res.status(500).send("auth error");
  }
});

// ====== MICROSOFT CALLBACK (exchange + save with fallbacks) ======
app.get("/ms/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing code");
    const decoded = JSON.parse(state || "{}");
    const user_unique_id = decoded.u;
    if (!user_unique_id) return res.status(400).send("Missing user id in state");

    console.log("[/ms/callback] code received for", user_unique_id);

    const { r, j } = await msTokenExchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: MS_REDIRECT_LIVE,
    });

    console.log("[/ms/callback] token exchange", {
      ok: r.ok,
      status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token,
      expires_in: j.expires_in,
    });
    if (!r.ok) return res.status(500).json(j);

    // Save with multi-strategy
    const save = await saveTokensToBubbleByAnyMeans({
      user_unique_id,
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      scope: j.scope,
      token_type: j.token_type,
      expires_in: j.expires_in,
      ext_expires_in: j.ext_expires_in,
    });

    console.log("[/ms/callback] save result", save);
    if (!save.ok) return res.status(500).json({ error: "bubble_save_failed", details: save });

    // back to app
    const redirectUrl = `${buildBubbleBases()[0]}/dashboard?ms=connected#`;
    return res.redirect(redirectUrl);
  } catch (e) {
    console.error("[/ms/callback] error:", e);
    res.status(500).send("callback error");
  }
});

// ====== REFRESH (raw) ======
app.post("/ms/refresh", async (req, res) => {
  try {
    const keyOk = req.headers["x-api-key"] === BUBBLE_API_KEY;
    console.log("[/ms/refresh] hit", {
      auth: keyOk ? "ok" : "bad",
      has_body: !!req.body,
      has_refresh_token: !!(req.body && req.body.refresh_token),
    });
    if (!keyOk) return res.status(401).json({ error: "Unauthorized" });

    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).send("Missing refresh_token");

    const { r, j } = await msTokenExchange({
      grant_type: "refresh_token",
      refresh_token,
    });

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

// ====== REFRESH & SAVE (end-to-end; minimal Bubble-logik) ======
app.post("/ms/refresh-save", async (req, res) => {
  try {
    const keyOk = req.headers["x-api-key"] === BUBBLE_API_KEY;
    console.log("[/ms/refresh-save] hit", {
      auth: keyOk ? "ok" : "bad",
      has_body: !!req.body,
      has_refresh_token: !!(req.body && req.body.refresh_token),
      has_user: !!(req.body && req.body.user_unique_id),
    });
    if (!keyOk) return res.status(401).json({ error: "Unauthorized" });

    const { refresh_token, user_unique_id } = req.body || {};
    if (!refresh_token || !user_unique_id)
      return res.status(400).send("Missing refresh_token or user_unique_id");

    const { r, j } = await msTokenExchange({
      grant_type: "refresh_token",
      refresh_token,
    });

    console.log("[/ms/refresh-save] ms token response", {
      ok: r.ok,
      status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token,
      expires_in: j.expires_in,
    });
    if (!r.ok) return res.status(500).json(j);

    const save = await saveTokensToBubbleByAnyMeans({
      user_unique_id,
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      scope: j.scope,
      token_type: j.token_type,
      expires_in: j.expires_in,
      ext_expires_in: j.ext_expires_in,
    });
    console.log("[/ms/refresh-save] save result", save);

    if (!save.ok) return res.status(500).json({ error: "bubble_save_failed", details: save });
    return res.json({ ok: true, saved_via: save.via, expires_in: j.expires_in });
  } catch (e) {
    console.error("[/ms/refresh-save] error:", e);
    return res.status(500).send("refresh-save error");
  }
});
