// =======================
// Mira-Exchange / index.js
// =======================

import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// ------- ENV -------
const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || "https://mira-exchange.onrender.com").replace(/\/$/, "");

// Bubble
const BUBBLE_BASE_URL = (process.env.BUBBLE_BASE_URL || "https://mira-fm.com").replace(/\/$/, "");
const BUBBLE_API_KEY = process.env.MIRAGPT_API_KEY || process.env.BUBBLE_API_KEY;

// Microsoft
const MS_CLIENT_ID = process.env.MS_APP_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_APP_CLIENT_SECRET; // kan vara tom om public client
const MS_TENANT = process.env.MS_TENANT || "common";
const MS_SCOPE =
  process.env.MS_SCOPE ||
  "User.Read Calendars.ReadWrite offline_access openid profile email";
const MS_REDIRECT_LIVE =
  process.env.MS_REDIRECT_LIVE || `${BASE_URL}/ms/callback`;

// ------- SMALL UTILS -------
const log = (...args) => console.log(...args);

function buildBubbleBases() {
  // returnera [live, version-test] eller [version-test, live] beroende på satt bas
  const bases = [];
  const base = BUBBLE_BASE_URL.replace(/\/$/, "");
  if (!base) return bases;

  if (base.includes("/version-test")) {
    bases.push(base);
    bases.push(base.replace("/version-test", ""));
  } else {
    bases.push(base);
    bases.push(`${base}/version-test`);
  }
  return bases.map((b) =>
    b.replace("/version-test/version-test", "/version-test")
  );
}

async function jsonFetch(url, opts = {}) {
  const r = await fetch(url, opts);
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { r, j };
}

function nowIso() {
  return new Date().toISOString();
}

// ------- MS TOKEN EXCHANGE -------
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
  return jsonFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

// ------- SAVE TO BUBBLE (WF → WF/version-test → Data API) -------
async function saveTokensToBubbleByAnyMeans({
  bubble_user_id, // Bubble "Unique id" (String)
  access_token,
  refresh_token,
  scope,
  token_type,
  expires_in,
  ext_expires_in,
}) {
  const bases = buildBubbleBases();

  // 1) Försök med API Workflow: /wf/ms_token_upsert
  const wfBody = {
    bubble_user_id,                         // <- VIKTIGT: matchar Bubble-parameter
    access_token,
    refresh_token,
    expires_in,
    scope,
    token_type,
    server_now_iso: nowIso(),
  };

  for (const base of bases) {
    const wfUrl = `${base}/api/1.1/wf/ms_token_upsert`;
    try {
      const { r, j } = await jsonFetch(wfUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BUBBLE_API_KEY}`,
        },
        body: JSON.stringify(wfBody),
      });
      log("[save] try WF", { base, status: r.status, ok: r.ok, j });
      if (r.ok) return { ok: true, via: "wf", base, status: r.status, j };
      if (r.status !== 404) {
        // annat fel: returnera direkt
        return { ok: false, via: "wf", base, status: r.status, j };
      }
      // annars 404 → prova nästa base
    } catch (e) {
      log("[save] WF error", { base, error: String(e) });
    }
  }

  // 2) Fallback: Data API PUT /obj/user/:id (bubble_user_id = object id)
  const expiresAtIso = new Date(
    Date.now() + (Number(expires_in || 0) - 120) * 1000
  )
    .toISOString()
    .replace("Z", "+00:00");

  const dataBody = {
    ms_access_token: access_token,
    ms_scope: scope,
    ms_token_type: token_type,
    ms_expires_at: expiresAtIso,
  };
  if (refresh_token) dataBody.ms_refresh_token = refresh_token;

  for (const base of bases) {
    const putUrl = `${base}/api/1.1/obj/user/${encodeURIComponent(
      bubble_user_id
    )}`;
    try {
      const { r, j } = await jsonFetch(putUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BUBBLE_API_KEY}`,
        },
        body: JSON.stringify(dataBody),
      });
      log("[save] try DataAPI PUT user", { base, status: r.status, ok: r.ok, j });
      if (r.ok) return { ok: true, via: "data_api", base, status: r.status, j };
      if (r.status !== 404) {
        return { ok: false, via: "data_api", base, status: r.status, j };
      }
    } catch (e) {
      log("[save] DataAPI error", { base, error: String(e) });
    }
  }

  return { ok: false, via: "exhausted", error: "Could not save via WF or Data API" };
}

// ------- SERVER START & HEALTH -------
app.listen(PORT, () => {
  log("\n/////////////////////////////////////////");
  log(`🚀 Mira Exchange running on port ${PORT}`);
  log(`🌐 Health: ${BASE_URL}/health`);
  log("/////////////////////////////////////////\n");
});

app.get("/health", (_req, res) => res.send("OK"));

// ------- AUTH START -------
app.get("/ms/auth", async (req, res) => {
  try {
    const { u } = req.query;
    if (!u) return res.status(400).send("Missing ?u=user_unique_id");

    const redirectUri = encodeURIComponent(MS_REDIRECT_LIVE);
    const scope = encodeURIComponent(MS_SCOPE);
    const state = encodeURIComponent(JSON.stringify({ u }));

    const authUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize?client_id=${MS_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&response_mode=query&scope=${scope}&state=${state}`;
    log("[/ms/auth] redirecting", { u, redirectUri });
    res.redirect(authUrl);
  } catch (e) {
    log("[/ms/auth] error", e);
    res.status(500).send("auth error");
  }
});

// ------- CALLBACK (exchange + save) -------
app.get("/ms/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing code");
    const decoded = JSON.parse(state || "{}");
    const bubble_user_id = decoded.u;
    if (!bubble_user_id) return res.status(400).send("Missing user id in state");

    log("[/ms/callback] code received for", bubble_user_id);

    const { r, j } = await msTokenExchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: MS_REDIRECT_LIVE,
    });

    log("[/ms/callback] token exchange", {
      ok: r.ok,
      status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token,
      expires_in: j.expires_in,
    });
    if (!r.ok) return res.status(500).json(j);

    const save = await saveTokensToBubbleByAnyMeans({
      bubble_user_id,
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      scope: j.scope,
      token_type: j.token_type,
      expires_in: j.expires_in,
      ext_expires_in: j.ext_expires_in,
    });

    log("[/ms/callback] save result", save);
    if (!save.ok) return res.status(500).json({ error: "bubble_save_failed", details: save });

    // redirect tillbaka till app (prioritera samma basordning som i buildBubbleBases)
    const bases = buildBubbleBases();
    const back = `${bases[0]}/dashboard?ms=connected#`;
    return res.redirect(back);
  } catch (e) {
    log("[/ms/callback] error:", e);
    res.status(500).send("callback error");
  }
});

// ------- RAW REFRESH -------
app.post("/ms/refresh", async (req, res) => {
  try {
    const keyOk = req.headers["x-api-key"] === BUBBLE_API_KEY;
    log("[/ms/refresh] hit", {
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

    log("[/ms/refresh] ms token response", {
      ok: r.ok,
      status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token,
      expires_in: j.expires_in,
    });

    if (!r.ok) return res.status(500).json(j);
    return res.json(j);
  } catch (e) {
    log("[/ms/refresh] error:", e);
    return res.status(500).send("refresh error");
  }
});

// ------- REFRESH & SAVE (end-to-end) -------
app.post("/ms/refresh-save", async (req, res) => {
  try {
    const keyOk = req.headers["x-api-key"] === BUBBLE_API_KEY;
    const body = req.body || {};
    log("[/ms/refresh-save] hit", {
      auth: keyOk ? "ok" : "bad",
      has_body: !!req.body,
      has_refresh_token: !!body.refresh_token,
      has_user: !!body.user_unique_id,
    });
    if (!keyOk) return res.status(401).json({ error: "Unauthorized" });

    const { refresh_token, user_unique_id } = body;
    if (!refresh_token || !user_unique_id) {
      return res.status(400).send("Missing refresh_token or user_unique_id");
    }

    const { r, j } = await msTokenExchange({
      grant_type: "refresh_token",
      refresh_token,
    });

    log("[/ms/refresh-save] ms token response", {
      ok: r.ok,
      status: r.status,
      has_access_token: !!j.access_token,
      has_refresh_token: !!j.refresh_token,
      expires_in: j.expires_in,
    });
    if (!r.ok) return res.status(500).json(j);

    // Spara med bubblans WF (bubble_user_id) + fallback
    const save = await saveTokensToBubbleByAnyMeans({
      bubble_user_id: user_unique_id, // <- VIKTIGT: heter bubble_user_id i WF
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      scope: j.scope,
      token_type: j.token_type,
      expires_in: j.expires_in,
      ext_expires_in: j.ext_expires_in,
    });

    log("[/ms/refresh-save] save result", save);
    if (!save.ok) return res.status(500).json({ error: "bubble_save_failed", details: save });

    return res.json({ ok: true, saved_via: save.via, expires_in: j.expires_in });
  } catch (e) {
    log("[/ms/refresh-save] error:", e);
    return res.status(500).send("refresh-save error");
  }
});
