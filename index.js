// Node 22 har fetch inbyggt (via undici internt) – vi importerar INTE undici själva
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

// ────────────────────────────────────────────────────────────
// .env lokalt (Render injicerar env i production)
if (process.env.NODE_ENV !== "production") {
  try {
    const { config } = await import("dotenv");
    config();
  } catch (e) {
    console.warn("[dotenv] not loaded (dev only):", e?.message || e);
  }
}

// ────────────────────────────────────────────────────────────
// App & JSON
const app = express();
app.use(express.json({ type: ["application/json", "application/*+json"] }));
app.use(cors());

// ────────────────────────────────────────────────────────────
// ENV resolution (stöd båda namnscheman och smart redirect)
const pick = (...vals) => vals.find(v => !!v && String(v).trim()) || null;

const NODE_ENV       = process.env.NODE_ENV || "production";
const BUBBLE_API_KEY =
  pick(process.env.BUBBLE_API_KEY, process.env.MIRAGPT_API_KEY);

const CLIENT_ID =
  pick(process.env.MS_CLIENT_ID, process.env.MS_APP_CLIENT_ID);
const CLIENT_SECRET =
  pick(process.env.MS_CLIENT_SECRET, process.env.MS_APP_CLIENT_SECRET);

// Välj redirect i ordning: explicit → live i prod → dev → live (fallback)
const REDIRECT_URI = pick(
  process.env.MS_REDIRECT_URI,
  NODE_ENV === "production" ? process.env.MS_REDIRECT_LIVE : null,
  process.env.MS_REDIRECT_DEV,
  process.env.MS_REDIRECT_LIVE
);

const MS_SCOPE  = pick(
  process.env.MS_SCOPE,
  "User.Read Calendars.ReadWrite Mail.Read Mail.Read.Shared offline_access openid profile email"
);
const MS_TENANT = pick(process.env.MS_TENANT, "common");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PORT       = process.env.PORT || 10000;

// ────────────────────────────────────────────────────────────
// Render API key guard (Bubble -> Render)
const RENDER_API_KEY =
  pick(process.env.MIRA_RENDER_API_KEY, process.env.MIRA_EXCHANGE_API_KEY);

//  envs
const FORTNOX_CLIENT_ID     = process.env.FORTNOX_CLIENT_ID;
const FORTNOX_CLIENT_SECRET = process.env.FORTNOX_CLIENT_SECRET;

// Rekommenderat när Render hanterar allt:
// - Sätt i Render: FORTNOX_REDIRECT_URI=https://mira-exchange.onrender.com/fortnox/callback
// - Om env saknas: fallback till den gamla
const FORTNOX_REDIRECT_URI  =
  process.env.FORTNOX_REDIRECT_URI || "https://api.mira-fm.com/fortnox/callback";
function isDocsConnection(connection_id) {
  const id = String(connection_id || "").trim();

  // Prefer new name, but stay backward compatible with older envs
  const allow =
    String(process.env.FORTNOX_DOCS_CONNECTION_IDS || process.env.FORTNOX_ORDERS_CONNECTION_IDS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

  // If env is not set, default = allow ALL (safer for dev), but in prod you WILL set it
  if (!allow.length) return true;

  return allow.includes(id);
}

// Bubble: styr miljö via env (live som default). Ingen tyst fallback till version-test.
const BUBBLE_PRIMARY_BASE =
  pick(
    process.env.BUBBLE_LIVE_BASE,   // ✅ rekommenderad (sätt i Render)
    process.env.BASE_URL,           // legacy/stöd
    process.env.BUBBLE_BASE_URL     // legacy/stöd
  ) || "https://mira-fm.com";       // ✅ hård default = LIVE

const BUBBLE_BASES = [BUBBLE_PRIMARY_BASE];

console.log("[BOOT] BUBBLE_BASES =", BUBBLE_BASES);
console.log("[BOOT] INDEX_FINGERPRINT = 2025-12-21_15:40_v1");

// Behåll samma semantics i resten av filen
const BASE_URL = BUBBLE_BASES[0] || null;
const BUBBLE_BASE_URL = BASE_URL; // ✅ BACKWARD COMPAT

if (!BASE_URL) {
  console.warn("[BOOT] No BASE_URL resolved. endpoints will fail.");
}
if (!BUBBLE_API_KEY) {
  console.warn("[BOOT] No BUBBLE_API_KEY resolved. Bubble calls will fail.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Helpers ────────────────────────────────────────────────────────────
function decodeHtmlEntities(s = "") {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
function normalizeActionUrl(url) {
  if (!url) return "";
  let s = String(url).trim();

  // återanvänd din befintliga decoder
  s = decodeHtmlEntities(s);

  // extra säkerhet (om vissa mails använder numerisk entity för &)
  s = s.replace(/&#38;/g, "&");

  // ta bort whitespace/newlines som ibland smyger sig in i href
  s = s.replace(/\s/g, "");

  return s;
}
function safeUrl(s, maxLen = 2000) {
  if (!s) return "";
  return String(s)
    .trim()
    .replace(/\s/g, "")     // bort whitespace/newlines i länken
    .slice(0, maxLen);
}
function stripHtmlToText(html = "") {
  let s = String(html);

  // Byt vanliga radbrytare till \n innan vi strippar taggar
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<\/td>/gi, " ");
  s = s.replace(/<\/div>/gi, "\n");

  // Ta bort head/style/script helt
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Strip alla resterande taggar
  s = s.replace(/<[^>]+>/g, "");

  // Decode entities + städa whitespace
  s = decodeHtmlEntities(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

// Plocka "bästa" body-texten från Graph message
function getMessageBodyText(msg) {
  const ct = String(msg?.body?.contentType || "").toLowerCase();
  const content = msg?.body?.content || "";
  if (content) {
    return ct === "html" ? stripHtmlToText(content) : String(content).trim();
  }
  return String(msg?.bodyPreview || "").trim();
}
// Helpers
const log = (msg, data) =>
  console.log(msg, data ? JSON.stringify(data, null, 2) : "");

// "YYYY-MM-DD HH:mm[:ss]" → "YYYY-MM-DDTHH:mm:ss"
const fixDateTime = (s) => {
  if (!s) return s;
  let v = String(s).trim();
  v = v.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(:\d{2})?)$/, "$1T$2");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v += ":00";
  return v;
};

function toGraphDateTime(local) {
  if (!local) return null;
  const s = String(local).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s + ":00";
  return s;
}

// IANA → Windows time zone (vanliga fall)
const IANA_TO_WINDOWS_TZ = {
  "Europe/Stockholm": "W. Europe Standard Time",
  "Europe/Paris": "Romance Standard Time",
  "Europe/Berlin": "W. Europe Standard Time",
  "Europe/Amsterdam": "W. Europe Standard Time",
  "Europe/Madrid": "Romance Standard Time",
  "Europe/London": "GMT Standard Time",
  "UTC": "UTC",
  "Etc/UTC": "UTC"
};
function toWindowsTz(tz) {
  if (!tz) return "W. Europe Standard Time";
  const t = String(tz).trim();
  if (/Standard Time$/i.test(t)) return t;
  return IANA_TO_WINDOWS_TZ[t] || "W. Europe Standard Time";
}

// Safe helpers (utan template literals)
const mask = (v) => {
  if (!v) return null;
  const s = String(v);
  return s.slice(0, 3) + "..." + s.slice(-3);
};
const sha  = (v) => {
  if (!v) return null;
  const h = crypto.createHash("sha256").update(String(v)).digest("hex");
  return h.slice(0, 16) + "…";
};

// ────────────────────────────────────────────────────────────
// Helper: normalizeRedirect – cleans up double slashes like "//ms_consent_callback"
function normalizeRedirect(u) {
  try {
    const url = new URL(u);
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return u;
  }
}
// ────────────────────────────────────────────────────────────
// HTML-escape helper (för att säkert kunna skriva värden i en liten callback-HTML)
function escapeHtml(input = "") {
  const s = String(input);
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#x60;"
  };
  return s.replace(/[&<>"'`]/g, (ch) => map[ch] || ch);
}
function extractActionLink({ bodyHtml = "", bodyText = "" } = {}) {
  const html = String(bodyHtml || "");
  const text = String(bodyText || "");

  // 0) Hård preferens: DeDu-kvittenslänk (oavsett länktext)
  // Ex: https://www.dedu.se/deduweb/external/direktdelkvittens.aspx?...&guid=...
  let m = html.match(/<a\b[^>]*href\s*=\s*["'](https?:\/\/www\.dedu\.se\/deduweb\/external\/direktdelkvittens\.aspx\?[^"']+)["'][^>]*>/i);
  if (m?.[1]) return { url: m[1], label: "Kvittera beställning", foundIn: "html" };

  // 1) Länk med text "Kvittera beställning" (tillåt span/whitespace)
  m = html.match(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?Kvittera\s+beställning[\s\S]*?<\/a>/i
  );
  if (m?.[1]) return { url: m[1], label: "Kvittera beställning", foundIn: "html" };

  // 2) Begränsat fönster runt "Rapportera åtgärd" och plocka första href
  const idx = html.toLowerCase().indexOf("rapportera åtgärd");
  if (idx !== -1) {
    const window = html.slice(idx, idx + 4000);
    m = window.match(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (m?.[1]) {
      const inner = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const label = inner || "Kvittera beställning";
      return { url: m[1], label, foundIn: "html" };
    }
  }

  // 3) Text fallback: leta DeDu-länk direkt i text
  m = text.match(/https?:\/\/www\.dedu\.se\/deduweb\/external\/direktdelkvittens\.aspx\?\S+/i);
  if (m?.[0]) return { url: m[0], label: "Kvittera beställning", foundIn: "text" };

  // 4) Text fallback: "Kvittera beställning" + url i närheten
  const t = text.replace(/\r/g, "");
  const lines = t.split("\n").map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes("kvittera beställning") || line.includes("rapportera åtgärd")) {
      for (let j = i; j < Math.min(i + 8, lines.length); j++) {
        const mm = lines[j].match(/https?:\/\/\S+/i);
        if (mm?.[0]) return { url: mm[0], label: "Kvittera beställning", foundIn: "text" };
      }
    }
  }

  return { url: "", label: "", foundIn: "" };
}
// ────────────────────────────────────────────────────────────
// API key guard – allow health + OAuth redirect/callback endpoints without key
function requireApiKey(req, res, next) {
  // Exakta paths (utan querystring)
  const openPaths = new Set([
    "/health",

    // Fortnox OAuth
    "/fortnox/authorize",
    "/fortnox/callback",

    // Microsoft OAuth (browser hits these WITHOUT x-api-key)
    "/ms/authorize",
    "/ms/callback",
  ]);

  // Tillåt även om du råkar lägga under-routes senare (bra säkerhetsmarginal)
  const openPrefixes = [
    // ex: om du senare lägger /ms/callback/...
  ];

  if (openPaths.has(req.path) || openPrefixes.some(p => req.path.startsWith(p))) {
    return next();
  }

  if (!RENDER_API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "Missing MIRA_RENDER_API_KEY on server" });
  }

  const key = req.headers["x-api-key"];
  if (!key || String(key).trim() !== String(RENDER_API_KEY).trim()) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad x-api-key)" });
  }

  return next();
}

app.use(requireApiKey);
// ────────────────────────────────────────────────────────────
// Bubble helpers (User + Data API)
// ────────────────────────────────────────────────────────────
// Bubble: PATCH helper (Data API)
// ────────────────────────────────────────────────────────────
async function bubblePatch(typeName, id, payload) {
  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}/${id}`;
    try {
      const r = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY
        },
        body: JSON.stringify(payload)
      });

      // Bubble PATCH ger ofta 204 utan body
      if (r.status === 204) return true;

      const text = await r.text().catch(() => "");
      let j = null;
      try { j = text ? JSON.parse(text) : null; } catch { j = null; }

      if (!r.ok) {
        lastErr = {
          base,
          status: r.status,
          statusText: r.statusText,
          bodyJson: j,
          bodyText: text?.slice(0, 2000) || null,
          url
        };
        continue;
      }

      return true;
    } catch (e) {
      lastErr = { base, error: String(e?.message || e), url };
    }
  }
  console.error("[bubblePatch] failed across all bases", lastErr);
  const err = new Error("bubblePatch failed");
  err.detail = lastErr;
  throw err;
}
async function fetchBubbleUser(user_unique_id) {
  const variants = [
    ...BUBBLE_BASES.map(b => b + "/api/1.1/obj/user/" + user_unique_id)
  ];
  for (const url of variants) {
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + BUBBLE_API_KEY } });
      const j = await r.json().catch(() => ({}));
      if (j && j.response) return j.response;
    } catch {}
  }
  return null;
}
// ────────────────────────────────────────────────────────────
// UnifiedOrder (cache/view) helpers
// Upsert by (source + source_thing_id)
// ────────────────────────────────────────────────────────────
async function upsertUnifiedOrder(payload) {
  if (!payload?.source || !payload?.source_thing_id) {
    throw new Error("UnifiedOrder requires source + source_thing_id");
  }

  // 1) Hitta ev befintlig UnifiedOrder på (source, source_thing_id)
  const existing = await bubbleFindOne("UnifiedOrder", [
    { key: "source", constraint_type: "equals", value: String(payload.source) },
    { key: "source_thing_id", constraint_type: "equals", value: String(payload.source_thing_id) },
  ]).catch(() => null);

  const existingId = bubbleId(existing);

  // 2) Bas-payload som alltid är OK att skriva
  const base = {
    ...payload,
    last_synced_at: new Date().toISOString(),
  };

  // 3) KRITISKT: skriv ALDRIG över company med null/empty vid UPDATE
  //    - om vi har ett company-id => sätt det
  //    - annars => ta bort nyckeln helt (så vi inte nollar ett befintligt värde)
  const hasCompany = !!(base.company && String(base.company).trim());
  if (!hasCompany) delete base.company;

  // 4) Rensa endast undefined (men låt null finnas kvar för andra fält om du vill nolla dem)
  //    (company hanteras redan ovan)
  const finalPayload = Object.fromEntries(
    Object.entries(base).filter(([, v]) => v !== undefined)
  );

  if (existingId) {
    const patched = await bubblePatch("UnifiedOrder", existingId, finalPayload);
    return { ok: true, action: "patched", id: existingId, patched };
  }

  // CREATE: här är det okej att company saknas (då sparas den tom),
  // men om company finns så följer den med (eftersom vi inte delete:ar när den finns).
  const createdId = await bubbleCreate("UnifiedOrder", finalPayload);
  return { ok: true, action: "created", id: createdId };
}
app.post("/debug/unifiedorder/resolve", requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};

    const connection_id = String(body.connection_id || "").trim();
    const customerNumber = body.customerNumber ?? "";
    const orgNumber = body.orgNumber ?? null;
    const customerName = body.customerName ?? null;

    // Viktigt: resolvern ska INTE referera till "fortnoxOrder" här.
    // Den ska använda inputs från body.
    const resolved_company_id = await resolveCompanyForUnifiedOrderFortnox({
      connection_id,
      customerNumber,
      // Policy B inputs (om du lagt till stöd i resolvern)
      orgNumber,
      customerName
    });

    return res.json({
      ok: true,
      input: {
        connection_id,
        customerNumber: String(customerNumber ?? ""),
        orgNumber: orgNumber ? String(orgNumber) : null,
        customerName: customerName ? String(customerName) : null
      },
      resolved_company_id: resolved_company_id || null
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }
});
function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function buildUnifiedOrderFromFortnox({ bubbleFortnoxOrderId, fortnoxOrder, connection_id }) {
  const docNo = String(fortnoxOrder?.DocumentNumber || fortnoxOrder?.documentNumber || "").trim();

  // ✅ Company: prefer orgnr-match via FortnoxCustomer -> ClientCompany(orgnr)
const companyId = await resolveCompanyForUnifiedOrderFortnox({
  connection_id,
  customerNumber: fortnoxOrder?.CustomerNumber ?? fortnoxOrder?.customerNumber,

  // 🔑 Policy B – ONLY source of creation
  orgNumber: fortnoxOrder?.OrganisationNumber ?? null,
  customerName: fortnoxOrder?.CustomerName ?? null
});

  // ---- Robust money parsing (Fortnox kan ge "1234.50" eller "1 234,50")
  const fnxMoneyOrNull = (v) => {
    if (v === undefined || v === null) return null;
    let s = String(v).trim();
    if (!s) return null;

    s = s.replace(/\s+/g, "").replace(",", ".");
    s = s.replace(/[^0-9.\-]/g, "");
    if (!s || s === "." || s === "-" || s === "-.") return null;

    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const orderDate = toDateOrNull(toIsoDate?.(fortnoxOrder?.OrderDate) || fortnoxOrder?.OrderDate);

  const deliveryRaw =
    fortnoxOrder?.DeliveryDate ??
    fortnoxOrder?.deliveryDate ??
    fortnoxOrder?.Deliverydate ??
    null;

  const deliveryDate = toDateOrNull(toIsoDate?.(deliveryRaw) || deliveryRaw);

  const amount =
    fnxMoneyOrNull(fortnoxOrder?.Total ?? fortnoxOrder?.total) ??
    fnxMoneyOrNull(fortnoxOrder?.TotalValue ?? fortnoxOrder?.totalValue) ??
    null;

  const yourRef = String(fortnoxOrder?.YourReference || fortnoxOrder?.yourReference || "").trim();

  console.log("[UnifiedOrder][fortnox] computed", {
    docNo,
    bubbleFortnoxOrderId,
    companyId: companyId || null,
    amount,
    orderDate,
    deliveryDate
  });

  return {
    source: "fortnox",
    source_thing_id: String(bubbleFortnoxOrderId),

    order_number: docNo || null,
    raw_title: docNo ? `Fortnox order ${docNo}` : "Fortnox order",

    amount: amount ?? null,
    company: companyId || null,

    order_date: orderDate,
    delivery_date: deliveryDate,

    supplier_name: "Carotte Food & Event AB",
    status: yourRef ? `YourRef: ${yourRef}` : "",

    source_url: String(fortnoxOrder?.["@url"] || ""),
    account_manager: null
  };
} // ✅ VIKTIG: den här saknades
// UnifiedOrder – Company resolver (Fortnox) – Policy B (create ONLY if order has orgnr)
// ------------------------------------------------------------

// Legacy helper – snabb väg om ft_customer_number redan sitter
async function resolveCompanyFromFortnoxCustomerNumber(customerNumber) {
  const cnStr = String(customerNumber ?? "").trim();
  if (!cnStr) return null;

  // ft_customer_number är number i Bubble i din live (ex: 69)
  let cc = null;

  const cnNum = Number(cnStr);
  if (Number.isFinite(cnNum)) {
    cc = await bubbleFindOne("ClientCompany", [
      { key: "ft_customer_number", constraint_type: "equals", value: cnNum }
    ]).catch(() => null);
    if (cc) return bubbleId(cc);
  }

  // fallback ifall någon miljö har text
  cc = await bubbleFindOne("ClientCompany", [
    { key: "ft_customer_number", constraint_type: "equals", value: cnStr }
  ]).catch(() => null);

  return bubbleId(cc);
}

// Normalisera orgnr till endast siffror (hanterar 556193-8233 => 5561938233)
function normalizeOrg(org) {
  if (!org) return null;
  const s = String(org).replace(/\D/g, "");
  return s.length >= 6 ? s : null;
}

// Policy B: skapa ClientCompany ONLY om orgnr kommer från ORDER (orgNumber param)
async function ensureClientCompanyByOrderOrgNo({
  orgRaw,            // raw orgnr (från fortnoxOrder.OrganisationNumber)
  customerNumberStr, // fortnox customer no (kan cache:as till ft_customer_number)
  customerName       // kan användas som Name_company
} = {}) {
  const orgN = normalizeOrg(orgRaw);
  if (!orgN) return null;

  // 1) hitta befintlig
  let cc =
    (await bubbleFindOne("ClientCompany", [
      { key: "Org_Number", constraint_type: "equals", value: orgN }
    ]).catch(() => null)) ||
    (orgRaw
      ? await bubbleFindOne("ClientCompany", [
          { key: "Org_Number", constraint_type: "equals", value: String(orgRaw).trim() }
        ]).catch(() => null)
      : null);

  let ccId = bubbleId(cc);
  if (ccId) return ccId;

  // 2) skapa minimal ClientCompany (inga flaggor)
  const payload = {
    Org_Number: orgN,
    Name_company: (customerName && String(customerName).trim())
      ? String(customerName).trim()
      : `Auto-created (${orgN})`
  };

  // sätt ft_customer_number om det är numeriskt
  const cnNum = Number(String(customerNumberStr ?? "").trim());
  if (Number.isFinite(cnNum)) payload.ft_customer_number = cnNum;

  console.log("[UO][resolve] PolicyB create ClientCompany (order-orgnr only)", payload);

  try {
    const created = await bubbleCreate("ClientCompany", payload);
    ccId = bubbleId(created);
    if (ccId) {
      console.log("[UO][resolve] PolicyB created ClientCompany", { clientCompanyId: ccId, orgN });
      return ccId;
    }
  } catch (e) {
    // Race condition: någon annan kan ha skapat samtidigt
    console.warn("[UO][resolve] PolicyB create failed, retry find", {
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }

  // 3) sista försök: hitta igen
  cc =
    (await bubbleFindOne("ClientCompany", [
      { key: "Org_Number", constraint_type: "equals", value: orgN }
    ]).catch(() => null)) ||
    (orgRaw
      ? await bubbleFindOne("ClientCompany", [
          { key: "Org_Number", constraint_type: "equals", value: String(orgRaw).trim() }
        ]).catch(() => null)
      : null);

  ccId = bubbleId(cc);
  return ccId || null;
}

/**
 * Resolver för UnifiedOrder (Fortnox)
 * Prioritet:
 * 1) ClientCompany.ft_customer_number (snabb)
 * 2) FortnoxCustomer.organisation_number -> ClientCompany.Org_Number (match ONLY, skapa INTE här)
 * 3) Order.OrganisationNumber (orgNumber param) -> matcha eller skapa (Policy B)
 *
 * Viktigt: Vi skapar endast ClientCompany om orgnr kommer från ordern (orgNumber).
 */
async function resolveCompanyForUnifiedOrderFortnox({
  connection_id,
  customerNumber,
  orgNumber,     // <-- från fortnoxOrder.OrganisationNumber
  customerName   // <-- från fortnoxOrder.CustomerName
} = {}) {
  const cnStr = String(customerNumber ?? "").trim();

  console.log("[UO][resolve] start", {
    connection_id: String(connection_id || ""),
    customerNumber: cnStr,
    order_orgNumber: orgNumber ? String(orgNumber) : null
  });

  // 1) snabb match via ft_customer_number
  if (cnStr) {
    const byCustomerNo = await resolveCompanyFromFortnoxCustomerNumber(cnStr).catch(() => null);
    if (byCustomerNo) {
      console.log("[UO][resolve] hit via ft_customer_number", {
        customerNumber: cnStr,
        clientCompanyId: byCustomerNo
      });
      return byCustomerNo;
    }
  }

  // 2) match via Bubble FortnoxCustomer.organisation_number (INGET skapande här)
  if (cnStr && connection_id) {
    let fc = null;
    try {
      fc = await bubbleFindOne("FortnoxCustomer", [
        { key: "connection_id", constraint_type: "equals", value: String(connection_id) },
        { key: "customer_number", constraint_type: "equals", value: cnStr } // TEXT hos dig
      ]);
    } catch (e) {
      console.warn("[UO][resolve] Bubble FortnoxCustomer lookup error", {
        error: e?.message || String(e),
        detail: e?.detail || null
      });
      fc = null;
    }

    console.log("[UO][resolve] Bubble FortnoxCustomer result", {
      found: !!fc,
      fortnoxCustomerId: bubbleId(fc) || null,
      organisation_number: fc?.organisation_number || null
    });

    if (fc?.organisation_number) {
      const orgN = normalizeOrg(fc.organisation_number);
      if (orgN) {
        const cc =
          (await bubbleFindOne("ClientCompany", [
            { key: "Org_Number", constraint_type: "equals", value: orgN }
          ]).catch(() => null)) ||
          (await bubbleFindOne("ClientCompany", [
            { key: "Org_Number", constraint_type: "equals", value: String(fc.organisation_number).trim() }
          ]).catch(() => null));

        const ccId = bubbleId(cc);
        if (ccId) {
          console.log("[UO][resolve] hit via FortnoxCustomer.organisation_number", {
            organisation_number: fc.organisation_number,
            clientCompanyId: ccId
          });

          // cache ft_customer_number för snabbhet framåt
          try {
            const cnNum = Number(cnStr);
            if (Number.isFinite(cnNum)) {
              await bubblePatch("ClientCompany", ccId, { ft_customer_number: cnNum });
            }
          } catch (_) {}

          return ccId;
        }
      }
    }
  }

  // 3) Policy B: skapa endast om orgnr finns på ordern
  if (orgNumber) {
    const ccId = await ensureClientCompanyByOrderOrgNo({
      orgRaw: orgNumber,
      customerNumberStr: cnStr,
      customerName
    });

    if (ccId) {
      console.log("[UO][resolve] hit via order orgnr (match/create)", {
        order_orgNumber: String(orgNumber),
        clientCompanyId: ccId
      });
      return ccId;
    }
  }

  console.log("[UO][resolve] end: unresolved");
  return null;
}
async function tokenExchange({ code, refresh_token, scope, tenant, redirect_uri }) {
  const tokenEndpoint = "https://login.microsoftonline.com/" + (tenant || MS_TENANT) + "/oauth2/v2.0/token";
  const form = new URLSearchParams();
  form.set("client_id", CLIENT_ID);
  form.set("client_secret", CLIENT_SECRET);
  if (code) {
    form.set("grant_type", "authorization_code");
    form.set("code", code);
  } else if (refresh_token) {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refresh_token);
  } else {
    throw new Error("Missing code or refresh_token");
  }
  form.set("redirect_uri", redirect_uri || REDIRECT_URI);
  form.set("scope", scope || MS_SCOPE);

  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.access_token, status: r.status, data: j };
}
// ────────────────────────────────────────────────────────────
// Delegated MS token helpers (for Mail polling)
// We store tokens on Bubble User (same as your calendar delegated flow)

async function getDelegatedTokenForUser(user_unique_id, { tenant = null, scope = null } = {}) {
  if (!user_unique_id) throw new Error("Missing user_unique_id for delegated token");

  const u = await fetchBubbleUser(user_unique_id);
  if (!u) throw new Error("Bubble user not found: " + user_unique_id);

  // Support both naming schemes (your create-event reads ms_access_token/ms_refresh_token)
  let accessToken =
    u?.ms_access_token ||
    u?.access_token ||
    null;

  let refreshToken =
    u?.ms_refresh_token ||
    u?.refresh_token ||
    null;

  const dbScope =
    u?.ms_scope ||
    u?.scope ||
    null;

  // If no access token, try refresh
  if (!accessToken && refreshToken) {
    const ref = await tokenExchange({
      refresh_token: refreshToken,
      scope: scope || dbScope || MS_SCOPE,
      tenant: tenant || MS_TENANT
    });

    if (ref.ok) {
      accessToken = ref.data.access_token;
      const newRefresh = ref.data.refresh_token || refreshToken;

      // Persist back to Bubble (your WF maps this to ms_access_token etc)
      await upsertTokensToBubble(user_unique_id, ref.data, newRefresh);
      refreshToken = newRefresh;
    }
  }


  // If access token exists but is expired (JWT exp), refresh it
  if (accessToken && refreshToken && isJwtExpired(accessToken)) {
    const ref = await tokenExchange({
      refresh_token: refreshToken,
      scope: scope || dbScope || MS_SCOPE,
      tenant: tenant || MS_TENANT
    });

    if (ref.ok) {
      accessToken = ref.data.access_token;
      const newRefresh = ref.data.refresh_token || refreshToken;
      await upsertTokensToBubble(user_unique_id, ref.data, newRefresh);
      refreshToken = newRefresh;
    }
  }

  // If we have access token but want to be safer, you can still refresh on demand later.
  if (!accessToken) {
    throw new Error("No delegated ms_access_token available (and refresh missing/failed) for user: " + user_unique_id);
  }

  return { access_token: accessToken, refresh_token: refreshToken, scope: dbScope || scope || null };
}

// JWT helpers (to refresh delegated tokens proactively)
function _b64urlToStr(b64url) {
  try {
    const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
    const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function jwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const json = _b64urlToStr(parts[1]);
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function isJwtExpired(token, skewSeconds = 60) {
  const p = jwtPayload(token);
  const exp = Number(p?.exp || 0);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return (exp - skewSeconds) <= now;
}
// ────────────────────────────────────────────────────────────
// Helpers (deklarera EN gång)
const asTextOrEmpty = (v) => (v === undefined || v === null) ? "" : String(v);
// Telefon/orgnr/belopp: plocka siffror ur sträng (+46, mellanslag, bindestreck osv)
function asNumberOrNull(v) {
  if (v === undefined || v === null) return null;

  const s = String(v).trim();
  if (!s) return null;

  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;

  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}
// Belopp: försök parsea decimaler (sv/en format). "1 234,50" -> 1234.5
const asMoneyNumberOrNull = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;

  const s0 = String(v).trim();
  if (!s0) return null;

  // ta bort spaces
  let s = s0.replace(/\s+/g, "");

  // Om både punkt och komma finns: anta att sista tecknet är decimal-separator
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    const decIsComma = lastComma > lastDot;

    // ta bort tusentals-separatorn och normalisera decimal till "."
    if (decIsComma) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    // "1234,50" -> "1234.50"
    s = s.replace(",", ".");
  } else {
    // bara punkt eller bara siffror: ok
  }

  // rensa allt utom siffror, minus och punkt
  s = s.replace(/[^0-9.-]/g, "");
  if (!s || s === "-" || s === "." || s === "-.") return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
// ────────────────────────────────────────────────────────────
// Bubble Data API helpers (object-CRUD)
async function bubbleFind(typeName, { constraints = [], limit = 1, cursor = 0, sort_field = null, descending = false } = {}) {
  const qs = new URLSearchParams();
  if (limit != null) qs.set("limit", String(limit));
  if (cursor != null) qs.set("cursor", String(cursor));
  if (sort_field) qs.set("sort_field", String(sort_field));
  if (descending) qs.set("descending", "true");

  if (constraints && constraints.length) {
    qs.set("constraints", JSON.stringify(
      constraints.map(c => ({
        key: c.key,
        constraint_type: c.constraint_type || "equals",
        value: c.value
      }))
    ));
  }

  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}?${qs.toString()}`;
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + BUBBLE_API_KEY } });
      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        lastErr = { base, status: r.status, body: j, url };
        continue;
      }
      return Array.isArray(j?.response?.results) ? j.response.results : [];
    } catch (e) {
      lastErr = { base, error: String(e?.message || e), url };
    }
  }

  const err = new Error("bubbleFind failed");
  err.detail = lastErr;
  throw err;
}

async function bubbleFindAll(typeName, { constraints = [], sort_field = null, descending = false } = {}) {
  const out = [];
  let cursor = 0;
  const limit = 100;

  while (true) {
    const batch = await bubbleFind(typeName, { constraints, limit, cursor, sort_field, descending });
    out.push(...batch);
    if (batch.length < limit) break;
    cursor += limit;
  }
  return out;
}
function bubbleId(obj) {
  return obj?._id || obj?.id || obj?.response?._id || obj?.response?.id || null;
}
async function bubbleFindOne(type, constraints) {
  const arr = await bubbleFind(type, {
    constraints: Array.isArray(constraints) ? constraints : [],
    limit: 1
  });
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}
// ────────────────────────────────────────────────────────────
// ClientCompany orgnr mapping (STABLE)
// Bubble Data API confirms the field key is exactly: Org_Number (text)
// We also normalize org numbers to digits-only to match stored values.
// ────────────────────────────────────────────────────────────

const CLIENTCOMPANY_ORG_FIELD = "Org_Number";

// Skapa (eller hitta) ClientCompany baserat på orgnr (primärt)
// + sätter/patchar ft_customer_number (number) från Fortnox CustomerNumber
async function ensureClientCompanyForFortnoxCustomer(cust) {
  const orgNoRaw = asTextOrEmpty(
    cust?.OrganisationNumber || cust?.organisation_number || cust?.organisationNumber
  ).trim();

  const orgNoNorm = normalizeOrgNo(orgNoRaw);
  if (!orgNoNorm) return null;

  const customerNoText = asTextOrEmpty(
    cust?.CustomerNumber || cust?.customer_number || cust?.customerNumber
  ).trim();

  const customerNoNum = asNumberOrNull(customerNoText);

  const name  = asTextOrEmpty(cust?.Name || cust?.name).trim();
  const email = asTextOrEmpty(cust?.Email || cust?.email).trim();
  const phone = cust?.Phone || cust?.phone;

  // 1) hitta befintligt ClientCompany på Org_Number (digits-only)
  let existing = await bubbleFindOne("ClientCompany", [
    { key: CLIENTCOMPANY_ORG_FIELD, constraint_type: "equals", value: orgNoNorm }
  ]);

  // fallback: om någon gammal post råkat ligga med bindestreck (ovanligt)
  if (!existing?._id && orgNoRaw) {
    existing = await bubbleFindOne("ClientCompany", [
      { key: CLIENTCOMPANY_ORG_FIELD, constraint_type: "equals", value: orgNoRaw }
    ]);
  }

  if (existing?._id) {
    const patch = {};

    if (customerNoNum !== null && (existing.ft_customer_number === undefined || existing.ft_customer_number === null)) {
      patch.ft_customer_number = customerNoNum;
    }

    if (name && !existing.Name_company) patch.Name_company = name;
    if (email && !existing.Email) patch.Email = email;

    const phoneNum = asNumberOrNull(phone);
    if (phoneNum !== null && (existing.Telefon === undefined || existing.Telefon === null)) {
      patch.Telefon = phoneNum;
    }

    if (Object.keys(patch).length) {
      await bubblePatch("ClientCompany", existing._id, patch);
    }

    return existing._id;
  }

  // 2) skapa nytt ClientCompany
  // VIKTIGT: spara orgnr normaliserat (digits-only) i Org_Number
  const ccFields = {
    Name_company: name || orgNoNorm,
    [CLIENTCOMPANY_ORG_FIELD]: orgNoNorm
  };

  if (email) ccFields.Email = email;

  const phoneNum = asNumberOrNull(phone);
  if (phoneNum !== null) ccFields.Telefon = phoneNum;

  if (customerNoNum !== null) ccFields.ft_customer_number = customerNoNum;

  const ccId = await bubbleCreate("ClientCompany", ccFields);
  return ccId || null;
}
// ────────────────────────────────────────────────────────────
// B) Fetch all FortnoxConnections (version-test)
async function getAllFortnoxConnections() {
  const results = await bubbleFind("FortnoxConnection", {
    constraints: [],
    limit: 1000
  });

  // säker filtrering
  return (Array.isArray(results) ? results : []).filter(c =>
    c?._id &&
    c?.access_token &&
    c?.is_active !== false
  );
}
async function bubbleGet(typeName, id) {
  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}/${id}`;
    try {
      const r = await fetch(url, {
        headers: { Authorization: "Bearer " + BUBBLE_API_KEY }
      });
      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        lastErr = { base, status: r.status, body: j };
        continue;
      }
      return j?.response || null;
    } catch (e) {
      lastErr = { base, error: String(e?.message || e) };
    }
  }

  const err = new Error("bubbleGet failed");
  err.detail = lastErr;
  throw err;
}

async function bubbleCreate(typeName, payload) {
  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${base}/api/1.1/obj/${typeName}`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY
        },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        console.error("[bubbleCreate] 400 payload rejected", {
    base,
    typeName,
    payload,
    status: r.status,
    body: j
  });
        lastErr = { base, status: r.status, body: j };
        continue;
      }
      return j?.id || j?.response?.id || null;
    } catch (e) {
      lastErr = { base, error: String(e?.message || e) };
    }
  }

  const err = new Error("bubbleCreate failed");
  err.detail = lastErr;
  throw err;
}
// ────────────────────────────────────────────────────────────
// Fortnox helpers (legacy token upsert to User – kept for compatibility)
async function fortnoxTokenExchange(code) {
  if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET || !FORTNOX_REDIRECT_URI) {
    throw new Error("Fortnox env saknas (client_id/secret/redirect_uri)");
  }

  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", FORTNOX_CLIENT_ID);
  form.set("client_secret", FORTNOX_CLIENT_SECRET);
  form.set("code", code);
  form.set("redirect_uri", FORTNOX_REDIRECT_URI);

  const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const j = await r.json().catch(() => ({}));

  return {
    ok: r.ok && !!j.access_token,
    status: r.status,
    data: j,
  };
}

async function upsertFortnoxTokensToBubble(bubble_user_id, tokenJson) {
  const payload = {
    customer_id: Number(workOrder?.CustomerId ?? 0) || null,
    project_id: Number(workOrder?.ProjectId ?? 0) || null,

    description: workOrder?.WorkOrderDescription ?? "",
    internal_note: workOrder?.InternalNote ?? "",
    is_deleted: normalizeBool(workOrder?.IsDeleted),
    order_date: toBubbleDate(workOrder?.OrderDate),
    work_address_id: Number(workOrder?.WorkAddressId ?? 0) || null,

    // Optional: if you pass these in request body AND you have these fields in Bubble type
    company: bubbleCompanyId ?? null,
    commission: bubbleCommissionId ?? null,
    parsed_commission_uid: parsedCommissionUid ?? ""
  };

  for (const base of BUBBLE_BASES) {
    try {
      const wf = base + "/api/1.1/wf/fortnox_token_upsert";
      const r = await fetch(wf, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + BUBBLE_API_KEY,
        },
        body: JSON.stringify(payload),
      });
      const ok = r.ok;
      log("[fortnox_save] WF", { base, status: r.status, ok });
      if (ok) return true;
    } catch (e) {
      log("[fortnox_save] WF error", { base, e: String(e) });
    }
  }
  return false;
}
const numOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Hämtar FortnoxConnection och plockar en next_page-nyckel (fallback=1)
async function getConnNextPage(connectionId, key, fallback = 1) {
  const conn = await bubbleGet("FortnoxConnection", connectionId);
  const v = Number(conn?.[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Sätter paging-fält på FortnoxConnection (men krascha inte hela run om fält saknas)
async function safeSetConnPaging(connectionId, patchObj) {
  try {
    await bubblePatch("FortnoxConnection", connectionId, patchObj);
    return true;
  } catch (e) {
    console.warn("[nightly] safeSetConnPaging failed (ignored)", {
      connectionId,
      patchObj,
      err: e?.message || String(e),
      detail: e?.detail || null
    });
    return false;
  }
}
async function postInternalJson(path, payload, timeoutMs = 15 * 60 * 1000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const base =
    process.env.INTERNAL_BASE_URL ||
    process.env.SELF_BASE_URL ||
    SELF_BASE_URL;

  const url = `${String(base).replace(/\/+$/, "")}${path}`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });

    const text = await r.text().catch(() => "");
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }

    if (!r.ok || !j.ok) {
      const err = new Error(`internal call failed: ${path}`);
      err.detail = { url, path, status: r.status, statusText: r.statusText, bodyText: text || null, bodyJson: j || null };
      throw err;
    }

    return j;
  } finally {
    clearTimeout(t);
  }
}
// ────────────────────────────────────────────────────────────
// Fortnox (Render-first) – connection-based token refresh + API fetch
function nowIso() { return new Date().toISOString(); }

function needsRefresh(expiresAtIso, minutes = 2) {
  if (!expiresAtIso) return true;
  const t = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(t)) return true;
  return (t - Date.now()) < minutes * 60 * 1000;
}

async function fortnoxRefresh(refreshToken) {
  if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET) {
    return { ok: false, status: 500, data: { error: "Missing Fortnox client envs" } };
  }

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", FORTNOX_CLIENT_ID);
  form.set("client_secret", FORTNOX_CLIENT_SECRET);

  const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });

  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.access_token, status: r.status, data: j };
}

async function getConnectionOrThrow(connection_id) {
  if (!connection_id) throw new Error("Missing connection_id");
  const conn = await bubbleGet("FortnoxConnection", connection_id);
  if (!conn) throw new Error("FortnoxConnection not found in Bubble: " + connection_id);
  return conn;
}

async function ensureFortnoxAccessToken(connection_id) {
  const conn = await getConnectionOrThrow(connection_id);

  const access = conn.access_token || null;
  const refresh = conn.refresh_token || null;
  const expiresAt = conn.expires_at || null;

  if (access && !needsRefresh(expiresAt, 2)) {
    return { ok: true, access_token: access, connection: conn, refreshed: false };
  }

  if (!refresh) {
    await bubblePatch("FortnoxConnection", connection_id, {
      last_error: "Missing refresh_token on connection",
      is_active: false,
      last_refresh_at: nowIso()
    });
    return { ok: false, error: "Missing refresh_token on connection" };
  }

  const rr = await fortnoxRefresh(refresh);

  if (!rr.ok) {
    await bubblePatch("FortnoxConnection", connection_id, {
      last_error: "Refresh failed: " + JSON.stringify(rr.data || {}),
      is_active: false,
      last_refresh_at: nowIso()
    });
    return { ok: false, error: "Refresh failed", detail: rr };
  }

  const newAccess = rr.data.access_token;
  const newRefresh = rr.data.refresh_token || refresh;
  const expiresIn = Number(rr.data.expires_in || 0);
  const newExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  await bubblePatch("FortnoxConnection", connection_id, {
    access_token: newAccess,
    refresh_token: newRefresh,
    expires_at: newExpiresAt,
    last_refresh_at: nowIso(),
    last_error: "",
    is_active: true,
    scope: rr.data.scope || conn.scope || ""
  });

  const conn2 = await getConnectionOrThrow(connection_id);

  return { ok: true, access_token: newAccess, connection: conn2, refreshed: true };
}

// Fortnox v3 API fetch helper
async function fortnoxGet(path, accessToken, query = {}) {
  const base = "https://api.fortnox.se/3";
  const qs = new URLSearchParams();
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });

  const url = base + path + (qs.toString() ? `?${qs.toString()}` : "");

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Client-Secret": String(FORTNOX_CLIENT_SECRET || ""),  // ✅ KRITISK
      "Accept": "application/json"
    }
  });

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, url };
}
// ────────────────────────────────────────────────────────────
//  lock (in-memory, survives within same Node process)
const getLock = () => {
  if (!globalThis.__miraNightlyLock) {
    globalThis.__miraNightlyLock = {
      running: false,
      started_at: 0,
      finished_at: 0,
      connection_id: null,
      run_id: null
    };
  }
  return globalThis.__miraNightlyLock;
};

// ✅ alias så dina routes funkar (du kan använda båda namnen)
const getNightlyLock = getLock;

app.get("/fortnox/nightly/status", requireApiKey, async (req, res) => {
  const lock = getNightlyLock();
  return res.json({ ok: true, lock });
});

app.post("/fortnox/nightly/unlock", requireApiKey, async (req, res) => {
  const lock = getNightlyLock();
  const was = { ...lock };
  lock.running = false;
  lock.started_at = 0;
  lock.connection_id = null;
  lock.run_id = null;
  return res.json({ ok: true, unlocked: true, was });
});
// ────────────────────────────────────────────────────────────
// Internal self-calls: använd localhost by default (stabilt, snabbt)
const SELF_BASE_URL = pick(process.env.SELF_BASE_URL) || `http://127.0.0.1:${PORT}`;
console.log("[BOOT] SELF_BASE_URL =", SELF_BASE_URL);

async function renderPostJson(path, body) {
  const url = SELF_BASE_URL.replace(/\/$/, "") + path;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.MIRA_RENDER_API_KEY
    },
    body: JSON.stringify(body || {})
  });

  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }

  if (!r.ok || j?.ok === false) {
    const err = new Error(`POST ${path} failed (${r.status})`);
    err.status = r.status;
    err.detail = j;
    throw err;
  }
  return j;
}
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/debug/bubble-bases", (req, res) => {
  res.json({ ok: true, bubble_bases: BUBBLE_BASES });
});

app.get("/debug/routes", (req, res) => {
  const routes = [];
  (app._router?.stack || []).forEach(l => {
    if (l.route?.path) {
      const methods = Object.keys(l.route.methods || {}).map(m => m.toUpperCase());
      routes.push({ methods, path: l.route.path });
    }
  });
  res.json({ ok: true, count: routes.length, routes });
});
// ────────────────────────────────────────────────────────────
// Fortnox OAuth: start authorization (connection-first, supports legacy user flow)
app.get("/fortnox/authorize", (req, res) => {
  const u = req.query.u && String(req.query.u).trim(); // legacy: bubble user id
  const c = req.query.c && String(req.query.c).trim(); // NEW: FortnoxConnection id

  const state = c ? "c:" + c : u ? "u:" + u : crypto.randomUUID();

  // ✅ Include invoice + companyinformation, and normalize whitespace
  const FORTNOX_SCOPE = String(
    process.env.FORTNOX_SCOPE ||
      "customer order offer invoice"
  )
    .trim()
    .replace(/\s+/g, " ");

  const url =
    "https://apps.fortnox.se/oauth-v1/auth" +
    `?client_id=${encodeURIComponent(FORTNOX_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(FORTNOX_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(FORTNOX_SCOPE)}` +
    `&state=${encodeURIComponent(state)}`;

  log("[/fortnox/authorize] redirect", {
    state,
    have_u: !!u,
    have_c: !!c,
    redirect_uri: FORTNOX_REDIRECT_URI,
    scope: FORTNOX_SCOPE
  });

  return res.redirect(url);
});

// Callback + token exchange
app.get("/fortnox/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query || {};

  const connectionId =
    typeof state === "string" && state.startsWith("c:") ? state.slice(2) : null;

  const bubbleUserId =
    typeof state === "string" && state.startsWith("u:") ? state.slice(2) : null;

  // ✅ Better error surfacing (Fortnox returns error params instead of code)
  if (!code) {
    if (error) {
      return res
        .status(400)
        .send(
          `Fortnox OAuth error: ${String(error)}${
            error_description ? " - " + String(error_description) : ""
          }`
        );
    }
    return res.status(400).send("Missing code from Fortnox");
  }

  try {
    const tokenRes = await fetch("https://apps.fortnox.se/oauth-v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: FORTNOX_REDIRECT_URI,
        client_id: FORTNOX_CLIENT_ID,
        client_secret: FORTNOX_CLIENT_SECRET
      })
    });

    const tokenJson = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error("[Fortnox OAuth] token error", tokenJson);
      return res.status(400).json(tokenJson);
    }

    const expiresIn = Number(tokenJson.expires_in || 0);
    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    console.log("[Fortnox OAuth] token OK", {
      has_access_token: !!tokenJson.access_token,
      has_refresh_token: !!tokenJson.refresh_token,
      connectionId,
      bubbleUserId,
      raw_scope: tokenJson.scope
    });

    // ✅ NEW: save on FortnoxConnection when connectionId is present
    if (connectionId) {
      const patched = await bubblePatch("FortnoxConnection", connectionId, {
        access_token: tokenJson.access_token || null,
        refresh_token: tokenJson.refresh_token || null,
        expires_at: expiresAt,
        token_type: tokenJson.token_type || "Bearer",
        scope: tokenJson.scope || "",
        is_active: true,
        last_error: "",
        last_refresh_at: new Date().toISOString()
      });

      log("[Fortnox OAuth] saved to FortnoxConnection", { connectionId, patched });

      if (!patched) {
        return res.status(502).send("Failed to save tokens to FortnoxConnection");
      }
    }

    // Legacy: keep supporting user flow if you want
    if (!connectionId && bubbleUserId) {
      const saved = await upsertFortnoxTokensToBubble(bubbleUserId, tokenJson);
      log("[Fortnox OAuth] saved to User legacy", { bubbleUserId, saved });
      if (!saved) return res.status(502).send("Failed to save Fortnox tokens to Bubble user");
    }

    // Redirect back (include connectionId so UI can show “connected” per supplier)
    const redirectTo = connectionId
      ? "https://mira-fm.com/fortnox-connected?connection_id=" + encodeURIComponent(connectionId)
      : "https://mira-fm.com/fortnox-connected";

    return res.redirect(redirectTo);
  } catch (err) {
    console.error("[Fortnox OAuth] callback error", err);
    return res.status(500).send("Fortnox OAuth failed");
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: refresh token PER CONNECTION (ny arkitektur)
app.post("/fortnox/connection/refresh", async (req, res) => {
  const { connection_id } = req.body || {};
  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Hämta FortnoxConnection från Bubble
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    }

    const rt = conn.refresh_token || null;
    if (!rt) {
      return res.status(400).json({ ok: false, error: "Missing refresh_token on connection" });
    }

    // 2) Refresh mot Fortnox
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", rt);
    form.set("client_id", FORTNOX_CLIENT_ID);
    form.set("client_secret", FORTNOX_CLIENT_SECRET);

    const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.access_token) {
      await bubblePatch("FortnoxConnection", connection_id, {
        last_error: JSON.stringify(j || {}),
        last_refresh_at: new Date().toISOString()
      });
      return res.status(400).json({ ok: false, status: r.status, error: j });
    }

    const expiresIn = Number(j.expires_in || 0);
    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // 3) Spara nya tokens på FortnoxConnection
    const patched = await bubblePatch("FortnoxConnection", connection_id, {
      access_token: j.access_token || null,
      refresh_token: j.refresh_token || rt,
      expires_at: expiresAt,
      scope: j.scope || conn.scope || "",
      last_error: "",
      last_refresh_at: new Date().toISOString(),
      is_active: true
    });

    return res.json({
      ok: true,
      patched,
      connection_id,
      expires_at: expiresAt,
      has_new_refresh_token: !!j.refresh_token
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: sync customers (Render-first, read-only)
app.post("/fortnox/sync/customers", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Hämta FortnoxConnection
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    }

    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    // 2) Auto-refresh om token saknas eller är expired
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch("https://mira-exchange.onrender.com/fortnox/connection/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id })
      });
      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) {
        return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });
      }

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }

    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "No access_token available" });
    }

    // 3) Call Fortnox Customers
    const url =
      "https://api.fortnox.se/3/customers" +
      `?page=${encodeURIComponent(page)}` +
      `&limit=${encodeURIComponent(limit)}`;

    const r = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        "Accept": "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Fortnox API error",
        detail: data
      });
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      meta: data?.MetaInformation || null,
      customers: data?.Customers || []
    });

  } catch (e) {
    console.error("[/fortnox/sync/customers] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: sync orders (Render-first, read-only) with months_back filter
app.post("/fortnox/sync/orders", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,
    months_back = 12
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Load FortnoxConnection
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    }

    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    // 2) Auto-refresh token
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch("https://mira-exchange.onrender.com/fortnox/connection/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id })
      });

      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) {
        return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });
      }

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }

    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "No access_token available" });
    }

    // 3) Date window
    const mb = Math.max(1, Number(months_back) || 12);
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - mb);

    const fmt = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const fromDate = fmt(from);
    const toDate   = fmt(to);

    // 4) Fetch orders filtered by ORDER DATE (server-side)
    const url =
      "https://api.fortnox.se/3/orders" +
      `?page=${encodeURIComponent(page)}` +
      `&limit=${encodeURIComponent(limit)}` +
      `&fromdate=${encodeURIComponent(fromDate)}` +
      `&todate=${encodeURIComponent(toDate)}`;

    const r = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        "Accept": "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Fortnox API error",
        detail: data
      });
    }

    const list = Array.isArray(data?.Orders) ? data.Orders : [];

    // 5) Render-side filter:  >= cutoff
    const cutoff = new Date(fromDate + "T00:00:00Z").getTime();

    const filtered = list.filter(o => {
      const d = String(o?.DeliveryDate || "").trim();
      if (!d) return false;
      const t = new Date(d + "T00:00:00Z").getTime();
      return Number.isFinite(t) && t >= cutoff;
    });

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      sent_filters: {
        months_back: mb,
        orderDateFrom: fromDate,
        orderDateTo: toDate,
        deliveryDateCutoff: fromDate
      },
      meta: data?.MetaInformation || null,
      orders: filtered,
      debug_counts: {
        fetched: list.length,
        kept_by_deliverydate: filtered.length
      }
    });

  } catch (e) {
    console.error("[/fortnox/sync/orders] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
async function fortnoxGetOfferDetail(tok, docNo) {
  const url = `https://api.fortnox.se/3/offers/${encodeURIComponent(docNo)}`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${tok.access_token}`,
      "Client-Secret": tok.client_secret
    }
  });

  const text = await r.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!r.ok) {
    return { ok: false, status: r.status, url, detail: json };
  }

  // Fortnox brukar returnera { Offer: {...} } men ibland direkt objekt
  const offer = json?.Offer || json?.offer || json;
  return { ok: true, offer };
}
// ────────────────────────────────────────────────────────────
// Fortnox: upsert orders into Bubble (one page)
app.post("/fortnox/upsert/orders", async (req, res) => {
  const { connection_id, page = 1, limit = 100, months_back = 12 } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let firstError = null;

  try {
    const syncRes = await fetch("https://mira-exchange.onrender.com/fortnox/sync/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });

    const syncText = await syncRes.text();
    let syncJson = {};
    try { syncJson = syncText ? JSON.parse(syncText) : {}; } catch { syncJson = { raw: syncText }; }

    if (!syncRes.ok || !syncJson.ok) {
      return res.status(400).json({ ok: false, error: "sync/orders failed", http_status: syncRes.status, detail: syncJson });
    }

    const orders = Array.isArray(syncJson.orders) ? syncJson.orders : [];

    for (const o of orders) {
      const docNo = String(o?.DocumentNumber || "").trim();
      if (!docNo) { skipped++; continue; }

      const payload = {
        connection: connection_id,
        ft_document_number: docNo,
        ft_customer_number: String(o?.CustomerNumber || ""),
        ft_customer_name: String(o?.CustomerName || ""),
        ft_your_reference: String(o?.YourReference || ""),
        ft_order_date: toIsoDate(o?.OrderDate),
        ft_delivery_date: toIsoDate(o?.DeliveryDate),
        ft_last_seen_at: new Date().toISOString(),
        ft_total: o?.Total == null ? "" : String(o.Total),
        ft_cancelled: !!o?.Cancelled,
        ft_sent: !!o?.Sent,
        ft_currency: String(o?.Currency || ""),
        ft_url: String(o?.["@url"] || ""),
        ft_raw_json: JSON.stringify(o || {}),
        needs_rows_sync: true
      };

      try {
        const search = await bubbleFind("FortnoxOrder", {
          constraints: [
            { key: "connection", constraint_type: "equals", value: connection_id },
            { key: "ft_document_number", constraint_type: "equals", value: docNo }
          ],
          limit: 1
        });

        const existing = Array.isArray(search) && search.length ? search[0] : null;
        const foundDoc = String(existing?.ft_document_number || "").trim();

        let fortnoxOrderId = null;

if (existing?._id && foundDoc === docNo) {
  fortnoxOrderId = existing._id;
  await bubblePatch("FortnoxOrder", fortnoxOrderId, payload);
  updated++;
} else {
  fortnoxOrderId = await bubbleCreate("FortnoxOrder", payload);
  created++;
}

// ✅ UnifiedOrder cache
try {
  if (fortnoxOrderId) {
    const unifiedPayload = await buildUnifiedOrderFromFortnox({
      bubbleFortnoxOrderId: fortnoxOrderId,
      fortnoxOrder: o,
      connection_id
    });
    await upsertUnifiedOrder(unifiedPayload);
  }
} catch (e) {
  console.error("[UnifiedOrder][fortnox] failed", {
    docNo,
    error: e?.message || String(e),
    detail: e?.detail || null
  });
}
      } catch (e) {
        errors++;
        if (!firstError) firstError = { docNo, message: e?.message || String(e), status: e?.status || null, detail: e?.detail || null };
      }
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      months_back,
      meta: syncJson.meta || null,
      counts: { created, updated, skipped, errors },
      first_error: firstError
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert orders - batch loop (N pages per run)
app.post("/fortnox/upsert/orders/all", async (req, res) => {
  const {
    connection_id,
    start_page = 1,
    limit = 100,
    max_pages = 10,
    months_back = 12
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  const start = Number(start_page) || 1;
  const maxP  = Math.max(1, Number(max_pages) || 10);
  const lim   = Math.max(1, Math.min(500, Number(limit) || 100));

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let page = start;
  let totalPages = null;

  try {
    for (let i = 0; i < maxP; i++) {
      const r = await fetch(`${SELF_BASE_URL}/fortnox/upsert/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, page, limit: lim, months_back })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        return res.status(400).json({ ok: false, error: "upsert/orders failed", detail: j, page });
      }

      created += j.counts?.created || 0;
      updated += j.counts?.updated || 0;
      skipped += j.counts?.skipped || 0;
      errors  += j.counts?.errors  || 0;

      const meta = j.meta || null;
      const cur  = Number(meta?.["@CurrentPage"] || page);
      const tot  = Number(meta?.["@TotalPages"] || 0);
      if (tot) totalPages = tot;

      if (tot && cur >= tot) {
        return res.json({
          ok: true, connection_id, done: true,
          start_page: start, end_page: cur, total_pages: tot,
          counts: { created, updated, skipped, errors },
          next_page: null
        });
      }

      page = cur + 1;
    }

    return res.json({
      ok: true, connection_id, done: false,
      start_page: start, end_page: page - 1, total_pages: totalPages,
      counts: { created, updated, skipped, errors },
      next_page: page
    });
  } catch (e) {
    console.error("[/fortnox/upsert/orders/all] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: sync ONE order (fetch order detail incl YourReference)
app.post("/fortnox/sync/orders/one", requireApiKey, async (req, res) => {
  try {
    const { connection_id, order_docno } = req.body || {};
    const docNo = String(order_docno || "").trim();
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
    if (!docNo) return res.status(400).json({ ok: false, error: "Missing order_docno" });

    const tok = await ensureFortnoxAccessToken(connection_id);
    if (!tok?.ok) {
      return res.status(401).json({ ok: false, error: tok?.error || "Token error", detail: tok?.detail || null });
    }

    const r = await fortnoxGet("/orders/" + encodeURIComponent(docNo), tok.access_token);
    if (!r.ok) {
      return res.status(r.status || 500).json({ ok: false, status: r.status || 500, data: r.data || null, url: r.url || null });
    }

    const order = r.data?.Order || r.data?.order || null;
    return res.json({ ok: true, connection_id, order_docno: docNo, order });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Alias (valfritt, men nice)
app.post("/fortnox/sync/order", requireApiKey, async (req, res) => {
  const r = await fetch(`${SELF_BASE_URL.replace(/\/$/, "")}/fortnox/sync/orders/one`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
    body: JSON.stringify(req.body || {})
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  return res.status(r.status).json(j);
});
// ────────────────────────────────────────────────────────────
// Fortnox: fetch + upsert customers into Bubble (FortnoxCustomer)
app.post("/fortnox/upsert/customers", requireApiKey, async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,
    skip_without_orgnr = true,
    link_company = true
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let first_error = null;

  try {
    const r = await fetch(`${SELF_BASE_URL}/fortnox/sync/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify({ connection_id, page, limit })
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) {
      return res.status(400).json({ ok: false, error: "sync/customers failed", http_status: r.status, detail: j });
    }

    const list = Array.isArray(j.customers) ? j.customers : [];

    for (const c of list) {
      const customerNumber = asTextOrEmpty(c?.CustomerNumber).trim();
      const orgnr = asTextOrEmpty(c?.OrganisationNumber).trim();

      if (!customerNumber) { skipped++; continue; }
      if (skip_without_orgnr && !orgnr) { skipped++; continue; }

      const basePayload = {
        connection_id: asTextOrEmpty(connection_id),
        customer_number: customerNumber,
        name: asTextOrEmpty(c?.Name),
        organisation_number: orgnr,
        email: asTextOrEmpty(c?.Email),
        phone: asTextOrEmpty(c?.Phone),
        address1: asTextOrEmpty(c?.Address1),
        address2: asTextOrEmpty(c?.Address2),
        zip: asTextOrEmpty(c?.ZipCode),
        city: asTextOrEmpty(c?.City),
        ft_url: asTextOrEmpty(c?.["@url"]),
        last_seen_at: new Date().toISOString(),
        raw_json: JSON.stringify(c || {}),
        fortnox_json: JSON.stringify(c || {})
      };

      try {
        const existing = await bubbleFindOne("FortnoxCustomer", [
          { key: "connection_id", constraint_type: "equals", value: connection_id },
          { key: "customer_number", constraint_type: "equals", value: customerNumber }
        ]);

        let ccId = null;
const hasLinkedAlready = !!(existing && (existing.linked_company || existing.linked_company?._id));

// ✅ Kör alltid (så ClientCompany kan patchas med ft_customer_number även om den redan är länkad)
if (link_company && orgnr) {
  ccId = await ensureClientCompanyForFortnoxCustomer(c);
}

        if (existing?._id) {
          const patchPayload = { ...basePayload };
          if (ccId && !hasLinkedAlready) patchPayload.linked_company = ccId;

          await bubblePatch("FortnoxCustomer", existing._id, patchPayload);
          updated++;
        } else {
          const createPayload = { ...basePayload };
          if (ccId) createPayload.linked_company = ccId;

          const id = await bubbleCreate("FortnoxCustomer", createPayload);
          if (id) created++;
          else {
            errors++;
            if (!first_error) first_error = { step: "bubbleCreate", customerNumber, message: "bubbleCreate returned null id" };
          }
        }
      } catch (e) {
        errors++;
        if (!first_error) first_error = {
          step: "bubbleUpsert",
          customerNumber,
          message: e?.message || String(e),
          detail: e?.detail || null
        };
      }
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      skip_without_orgnr,
      link_company,
      meta: j.meta || null,
      counts: { created, updated, skipped, errors },
      first_error
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// Fortnox: upsert customers - batch loop (N pages per run)
app.post("/fortnox/upsert/customers/all", requireApiKey, async (req, res) => {
  const {
    connection_id,
    start_page = 1,
    limit = 100,
    max_pages = 10,
    pause_ms = 0,
    skip_without_orgnr = true,
    link_company = true
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  const start = Number(start_page) || 1;
  const maxP  = Math.max(1, Number(max_pages) || 10);
  const lim   = Math.max(1, Math.min(200, Number(limit) || 100));
  const pause = Math.max(0, Number(pause_ms) || 0);

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let page = start;
  let totalPages = null;
  let first_error = null;

  try {
    for (let i = 0; i < maxP; i++) {
      const r = await fetch(`${SELF_BASE_URL}/fortnox/upsert/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({
          connection_id,
          page,
          limit: lim,
          skip_without_orgnr,
          link_company
        })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        return res.status(400).json({ ok: false, error: "upsert/customers failed", detail: j, page });
      }

      created += j.counts?.created || 0;
      updated += j.counts?.updated || 0;
      skipped += j.counts?.skipped || 0;
      errors  += j.counts?.errors  || 0;

      if (!first_error && j.first_error) first_error = j.first_error;

      const meta = j.meta || null;
      const cur  = Number(meta?.["@CurrentPage"] || page);
      const tot  = Number(meta?.["@TotalPages"] || 0);
      if (tot) totalPages = tot;

      if (tot && cur >= tot) {
        return res.json({
          ok: true,
          connection_id,
          done: true,
          start_page: start,
          end_page: cur,
          total_pages: tot,
          counts: { created, updated, skipped, errors },
          first_error,
          next_page: null
        });
      }

      page = cur + 1;
      if (pause) await sleep(pause);
    }

    return res.json({
      ok: true,
      connection_id,
      done: false,
      start_page: start,
      end_page: page - 1,
      total_pages: totalPages,
      counts: { created, updated, skipped, errors },
      first_error,
      next_page: page
    });

  } catch (e) {
    console.error("[/fortnox/upsert/customers/all] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: refresh + spara token (legacy to User)
app.post("/fortnox/refresh-save", async (req, res) => {
  const {
    bubble_user_id,
    u,
    refresh_token
  } = req.body || {};

  const userId = bubble_user_id || u || null;

  log("[/fortnox/refresh-save] hit", {
    has_body: !!req.body,
    has_user: !!userId,
    has_refresh_token: !!refresh_token
  });

  if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "Fortnox client envs missing"
    });
  }

  try {
    let rt = refresh_token || null;

    if (!rt && userId) {
      const uResp = await fetchBubbleUser(userId);
      rt = uResp?.ft_refresh_token || null;
      log("[/fortnox/refresh-save] fetched user", {
        has_user: !!uResp,
        has_ft_refresh_token: !!rt
      });
    }

    if (!rt) {
      return res.status(400).json({
        ok: false,
        error: "Missing refresh_token (and could not load from Bubble)"
      });
    }

    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", rt);
    form.set("client_id", FORTNOX_CLIENT_ID);
    form.set("client_secret", FORTNOX_CLIENT_SECRET);

    const r = await fetch("https://apps.fortnox.se/oauth-v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.access_token) {
      console.error("[/fortnox/refresh-save] token error", {
        status: r.status,
        body: j
      });
      return res.status(400).json({
        ok: false,
        status: r.status,
        error: j
      });
    }

    let saved = false;
    if (userId) {
      saved = await upsertFortnoxTokensToBubble(userId, j);
      log("[/fortnox/refresh-save] upsert", { userId, saved });
      if (!saved) {
        return res.status(502).json({
          ok: false,
          error: "Failed to save refreshed Fortnox tokens to Bubble"
        });
      }
    }

    return res.json({
      ok: true,
      saved_for_user: userId,
      access_token_preview: (j.access_token || "").slice(0, 12) + "...",
      has_refresh_token: !!j.refresh_token,
      raw_scope: j.scope || null
    });
  } catch (e) {
    console.error("[/fortnox/refresh-save] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
const toIsoDate = (d) => {
  const s = String(d || "").trim(); // "YYYY-MM-DD"
  if (!s) return null;
  // Bubble brukar gilla ISO
  return s + "T00:00:00.000Z";
};
const toNumOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function parseFtDateToTs(v) {
  const s = String(v || "").trim();
  if (!s) return NaN;

  // "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(s + "T00:00:00Z").getTime();
  }

  // "YYYY-MM-DDTHH:mm:ss"
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    return new Date(s).getTime();
  }

  // "/Date(1234567890)/"
  const m = s.match(/Date\((\d+)\)/);
  if (m) return Number(m[1]);

  return NaN;
}
// ────────────────────────────────────────────────────────────
// Fortnox: sync invoices (Render-first, read-only) with months_back filter on InvoiceDate
app.post("/fortnox/sync/invoices", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,
    months_back = 12
  } = req.body || {};

  if (!connection_id) {
    return res.status(400).json({ ok: false, error: "Missing connection_id" });
  }

  try {
    // 1) Hämta FortnoxConnection
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });

    // PAUS: om du stänger av is_active stoppar vi här
    if (conn.is_active === false) {
      return res.json({ ok: true, paused: true, connection_id });
    }

    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    // 2) Auto-refresh om token saknas/expired
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch(`${SELF_BASE_URL}/fortnox/connection/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id })
      });

      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) {
        return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });
      }

      const updated = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updated?.access_token || null;
    }

    if (!accessToken) return res.status(401).json({ ok: false, error: "No access_token available" });

    // 3) months_back window (cutoff = today - months_back)
    const mb = Math.max(1, Number(months_back) || 12);
    const now = new Date();
    const from = new Date(now);
    from.setMonth(from.getMonth() - mb);

    const fmt = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const cutoffDate = fmt(from);      // fromdate
    const toDate = fmt(now);           // todate
    const cutoffTs = new Date(cutoffDate + "T00:00:00Z").getTime();

    // 4) Hämta invoices (LÅT FORTNOX FILTRERA via fromdate/todate)
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      fromdate: cutoffDate,
      todate: toDate
    });

    const url = `https://api.fortnox.se/3/invoices?${qs.toString()}`;

    const r = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        "Accept": "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Fortnox API error",
        detail: data
      });
    }

    const list = Array.isArray(data?.Invoices) ? data.Invoices : [];

    // Safety net: client-side filter också (ska normalt vara redundant nu)
    const pickInvoiceDateTs = (inv) => {
      const candidates = [
        inv?.InvoiceDate,
        inv?.invoiceDate,
        inv?.DocumentDate,
        inv?.documentDate,
        inv?.Created,
        inv?.created,
        inv?.DueDate,
        inv?.dueDate
      ];
      for (const c of candidates) {
        const ts = parseFtDateToTs(c);
        if (Number.isFinite(ts)) return ts;
      }
      return NaN;
    };

    const filtered = list.filter(inv => {
      const ts = pickInvoiceDateTs(inv);
      return Number.isFinite(ts) && ts >= cutoffTs;
    });

    // DEBUG: visa sample så vi ser exakt vilka fält som kommer
    const sample = list[0] || null;
    const sampleKeys = sample ? Object.keys(sample) : [];
    const samplePickedTs = sample ? pickInvoiceDateTs(sample) : null;

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      sent_filters: {
        months_back: mb,
        fromdate: cutoffDate,
        todate: toDate,
        invoiceDateCutoff: cutoffDate
      },
      meta: data?.MetaInformation || null,
      invoices: filtered,
      debug_counts: { fetched: list.length, kept_by_date: filtered.length },
      debug_sample: {
        keys: sampleKeys,
        invoiceDate: sample?.InvoiceDate || sample?.invoiceDate || null,
        documentDate: sample?.DocumentDate || sample?.documentDate || null,
        created: sample?.Created || sample?.created || null,
        dueDate: sample?.DueDate || sample?.dueDate || null,
        picked_ts: samplePickedTs,
        cutoff_ts: cutoffTs,
        request_url: url
      }
    });
  } catch (e) {
    console.error("[/fortnox/sync/invoices] error", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert invoices (NO invoice rows) – uses /fortnox/sync/invoices
// Upsert key: connection_id + ft_document_number
app.post("/fortnox/upsert/invoices", requireApiKey, async (req, res) => {
  try {
    const {
      connection_id,
      page = 1,
      limit = 100,
      months_back = 12,
      pause_ms = 0
    } = req.body || {};

    if (!connection_id) {
      return res.status(400).json({ ok: false, error: "Missing connection_id" });
    }

    // 1) Hämta invoices via din sync-endpoint (filtrerar på datum)
    const syncRes = await fetch(`${SELF_BASE_URL}/fortnox/sync/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });

    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncJson.ok) {
      return res.status(400).json({ ok: false, error: "sync/invoices failed", detail: syncJson });
    }

    const invoices = Array.isArray(syncJson.invoices) ? syncJson.invoices : [];
    const TYPE = "FortnoxInvoice";

    let created = 0, updated = 0, skipped = 0, errors = 0;
    let first_error = null;

    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i] || {};
      const docNo = String(inv.DocumentNumber || inv.documentNumber || "").trim();
      if (!docNo) { skipped++; continue; }

      const fields = {
        connection_id: connection_id,                           // ✅ matchar ditt relationsfält
        ft_document_number: docNo,

        ft_invoice_date: toIsoDate(inv.InvoiceDate),            // ✅ date-fält
        ft_due_date: toIsoDate(inv.DueDate),                    // ✅ date-fält

        ft_customer_number: asTextOrEmpty(inv.CustomerNumber),  // ✅ text
        ft_customer_name: asTextOrEmpty(inv.CustomerName),      // ✅ text

        ft_total: asTextOrEmpty(inv.Total),                     // ✅ text
        ft_balance: asTextOrEmpty(inv.Balance),                 // ✅ text
        ft_currency: asTextOrEmpty(inv.Currency),               // ✅ text
        ft_ocr: asTextOrEmpty(inv.OCR),                         // ✅ text

        ft_cancelled: inv.Cancelled === true,                   // ✅ yes/no
        ft_sent: inv.Sent === true,                             // ✅ yes/no

        ft_url: asTextOrEmpty(inv["@url"]),                     // ✅ text
        ft_raw_json: JSON.stringify(inv || {})
      };

      try {
        const existing = await bubbleFindOne(TYPE, [
          { key: "connection_id", constraint_type: "equals", value: connection_id },
          { key: "ft_document_number", constraint_type: "equals", value: docNo }
        ]);

        if (existing?._id) {
          await bubblePatch(TYPE, existing._id, fields);
          updated++;
        } else {
          const id = await bubbleCreate(TYPE, fields);
          if (id) created++;
          else {
            errors++;
            if (!first_error) first_error = { step: "bubbleCreate", docNo, detail: "bubbleCreate returned null id" };
          }
        }
      } catch (e) {
        errors++;
        if (!first_error)
          first_error = {
            step: "bubbleUpsert",
            docNo,
            message: e?.message || String(e),
            status: e?.status || null,
            detail: e?.detail || null
          };
      }

      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({
      ok: true,
      connection_id,
      page,
      limit,
      months_back,
      meta: syncJson.meta || null,
      counts: { created, updated, skipped, errors },
      first_error,
      docs: invoices.length
    });
  } catch (e) {
    console.error("[/fortnox/upsert/invoices] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
const bubbleFindAllCursor = async (type, constraints, pageSize = 100) => {
  const out = [];
  let cursor = 0;
  let safety = 0;

  while (true) {
    safety++;
    if (safety > 500) break; // skydd

    const resp = await bubbleFind(type, {
      constraints,
      limit: pageSize,
      cursor
    });

    const list = Array.isArray(resp) ? resp : (resp?.results || []);
    if (!Array.isArray(list) || list.length === 0) break;

    out.push(...list);

    if (list.length < pageSize) break;
    cursor += pageSize;
  }

  return out;
};

// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows (per order docno)  ✅ WU-optimerad
app.post("/fortnox/upsert/order-rows", requireApiKey, async (req, res) => {
  const { connection_id, order_docno } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
  if (!order_docno) return res.status(400).json({ ok: false, error: "Missing order_docno" });

  try {
    // 0) Connection + paused?
    const conn = await bubbleGet("FortnoxConnection", connection_id);
    if (!conn) return res.status(404).json({ ok: false, error: "FortnoxConnection not found" });
    if (conn.is_active === false) return res.json({ ok: true, paused: true, connection_id });

    // 1) Access token (behåll ditt befintliga refresh-mönster, men utan hardcoded onrender)
    let accessToken = conn.access_token || null;
    const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;

    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const ref = await fetch(`${SELF_BASE_URL}/fortnox/connection/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id })
      });
      const refJson = await ref.json().catch(() => ({}));
      if (!ref.ok) return res.status(401).json({ ok: false, error: "Token refresh failed", detail: refJson });

      const updatedConn = await bubbleGet("FortnoxConnection", connection_id);
      accessToken = updatedConn?.access_token || null;
    }
    if (!accessToken) return res.status(401).json({ ok: false, error: "No access_token available" });

    // 2) Hämta order från Fortnox
    const docNoReq = String(order_docno).trim();
    const url = `https://api.fortnox.se/3/orders/${encodeURIComponent(docNoReq)}`;

    const r = await fetch(url, {
      headers: {
        Authorization: "Bearer " + accessToken,
        "Client-Secret": FORTNOX_CLIENT_SECRET,
        Accept: "application/json"
      }
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ ok: false, error: "Fortnox API error", detail: data });

    const order = data?.Order || data?.order || null;
    const rows = Array.isArray(order?.OrderRows) ? order.OrderRows : [];

    const ordDocNo = String(order?.DocumentNumber || docNoReq).trim();

    // ✅ Fix: YourReference kommer från ORDER, inte "o" (som inte finns här)
    const orderYourRef = String(order?.YourReference || order?.YourReferenceNumber || "");

    // 3) Hitta parent order i Bubble
    const searchOrd = await bubbleFind("FortnoxOrder", {
      constraints: [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "ft_document_number", constraint_type: "equals", value: ordDocNo }
      ],
      limit: 1
    });

    const ordObj = Array.isArray(searchOrd) && searchOrd.length ? searchOrd[0] : null;
    if (!ordObj?._id) {
      return res.status(404).json({ ok: false, error: "Parent FortnoxOrder not found in Bubble", ordDocNo });
    }

    // 4) ✅ NYTT: Hämta alla befintliga rader för just denna order (1 gång) och indexera på ft_unique_key
    const existingRows = await bubbleFindAllCursor(
      "FortnoxOrderRow",
      [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "order", constraint_type: "equals", value: ordObj._id }
      ],
      100
    );

    const existingByKey = {};
    for (const er of existingRows) {
      if (er?.ft_unique_key && er?._id) existingByKey[String(er.ft_unique_key)] = er._id;
    }

    // 5) Upsert rows utan bubbleFind per rad
    let created = 0, updated = 0, errors = 0;
    let firstError = null;
    const debug = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = i + 1;

      const rowNo = Number(row?.RowNumber ?? row?.RowNo ?? row?.Row ?? rowIndex);
      const rowId = row?.RowId ?? row?.rowId ?? null;

      // Samma “säker” uniqueKey som du redan kör (för kompatibilitet)
      const uniqueKey = rowId
        ? `ROWID_${rowId}__CONN_${connection_id}__ORDDOC_${ordDocNo}`
        : `FALLBACK__CONN_${connection_id}__ORDDOC_${ordDocNo}__IDX_${String(rowIndex).padStart(3, "0")}`;

      const payload = {
        connection: connection_id,
        order: ordObj._id,

        ft_order_document_number: ordDocNo,
        ft_row_index: rowIndex,
        ft_row_no: rowNo,

        ft_article_number: String(row?.ArticleNumber || ""),
        ft_description: String(row?.Description || ""),

        // ✅ fix: använd orderns YourReference (inte o?.)
        ft_your_reference: orderYourRef,

        ft_quantity: row?.DeliveredQuantity ?? row?.Quantity ?? null,
        ft_unit: String(row?.Unit || ""),

        // Behåll samma “string/empty” typ som din befintliga kod för att inte riskera Bubble field-type errors
        ft_price: row?.Price == null ? "" : String(row.Price),
        ft_discount: row?.Discount == null ? "" : String(row.Discount),
        ft_vat: row?.VAT == null ? "" : String(row.VAT),
        ft_total: row?.Total == null ? "" : String(row.Total),

        ft_unique_key: uniqueKey,
        ft_raw_json: JSON.stringify(row || {})
      };

      try {
        const existingId = existingByKey[uniqueKey];

        if (debug.length < 5) {
          debug.push({
            rowIndex,
            uniqueKey,
            existing_id: existingId || null
          });
        }

        if (existingId) {
          await bubblePatch("FortnoxOrderRow", existingId, payload);
          updated++;
        } else {
          await bubbleCreate("FortnoxOrderRow", payload);
          created++;
        }
      } catch (e) {
        errors++;
        if (!firstError) firstError = { uniqueKey, message: e?.message || String(e), detail: e?.detail || null };
      }
    }

    // 6) Markera parent som synkad (samma som du gör idag)
    if (errors === 0) {
      await bubblePatch("FortnoxOrder", ordObj._id, {
        needs_rows_sync: false,
        rows_last_synced_at: new Date().toISOString()
      });
    }

    return res.json({
      ok: true,
      connection_id,
      order_docno: ordDocNo,
      rows_count: rows.length,
      existing_rows_in_bubble: existingRows.length,
      counts: { created, updated, errors },
      first_error: firstError,
      debug_samples: debug
    });

  } catch (e) {
    console.error("[/fortnox/upsert/order-rows] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows for FLAGGED orders (needs_rows_sync=true)
app.post("/fortnox/upsert/order-rows/flagged", requireApiKey, async (req, res) => {
  try {
    const { connection_id, limit = 30, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    const flagged = await bubbleFind("FortnoxOrder", {
      constraints: [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "needs_rows_sync", constraint_type: "equals", value: true }
      ],
      limit: Number(limit) || 30
    });

    const orders = Array.isArray(flagged) ? flagged : [];
    const results = [];
    let ok_count = 0, fail_count = 0;

    for (const o of orders) {
      const docNo = String(o?.ft_document_number || "").trim();
      if (!docNo) continue;

      const rr = await fetch(`${SELF_BASE_URL}/fortnox/upsert/order-rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, order_docno: docNo })
      });

      const j = await rr.json().catch(() => ({}));
      const ok = !!j.ok;

      results.push({
        docNo,
        ok,
        http_status: rr.status,
        counts: j.counts || null,
        first_error: j.first_error || j.error || j.detail || null
      });

      ok ? ok_count++ : fail_count++;
      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({ ok: true, connection_id, flagged_found: orders.length, ok_count, fail_count, results });
  } catch (e) {
    console.error("[/fortnox/upsert/order-rows/flagged] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// Fortnox: upsert order rows for ALL orders on one orders page
app.post("/fortnox/upsert/order-rows/page", requireApiKey, async (req, res) => {
  try {
    const { connection_id, page = 1, limit = 50, months_back = 12, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    // ✅ Byt bort hardcoded onrender och kör mot SELF_BASE_URL (rätt miljö alltid)
    const syncRes = await fetch(`${SELF_BASE_URL}/fortnox/sync/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
      body: JSON.stringify({ connection_id, page, limit, months_back })
    });

    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncJson.ok) {
      return res.status(400).json({ ok: false, error: "sync/orders failed", detail: syncJson });
    }

    const docs = Array.isArray(syncJson.orders) ? syncJson.orders : [];
    const results = [];
    let ok_count = 0, fail_count = 0;

    for (let i = 0; i < docs.length; i++) {
      const docNo = String(docs[i]?.DocumentNumber || "").trim();
      if (!docNo) continue;

      const rr = await fetch(`${SELF_BASE_URL}/fortnox/upsert/order-rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({ connection_id, order_docno: docNo })
      });

      const j = await rr.json().catch(() => ({}));
      const ok = !!j.ok;

      results.push({ docNo, ok, counts: j.counts || null, first_error: j.first_error || j.error || null });
      ok ? ok_count++ : fail_count++;

      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({ ok: true, connection_id, page, limit, months_back, docs: docs.length, ok_count, fail_count, results });
  } catch (e) {
    console.error("[/fortnox/upsert/order-rows/page] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox (Render-first) endpoints – use FortnoxConnection in Bubble
app.post("/fortnox/debug/connection", async (req, res) => {
  try {
    const { connection_id } = req.body || {};
    const conn = await getConnectionOrThrow(connection_id);

    return res.json({
      ok: true,
      connection_id,
      has_access_token: !!conn.access_token,
      has_refresh_token: !!conn.refresh_token,
      expires_at: conn.expires_at || null,
      needs_refresh: needsRefresh(conn.expires_at, 2),
      is_active: conn.is_active ?? null,
      last_error: conn.last_error || ""
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
      detail: e.detail || null
    });
  }
});
app.get("/fortnox/debug/connections", requireApiKey, async (req, res) => {
  try {
    const onlyActive = String(req.query.only_active ?? "true") !== "false";
    const list = await getAllFortnoxConnections({ onlyActive });

    const slim = list.map(c => ({
      id: c?._id,
      is_active: c?.is_active,
      supplier: c?.supplier ?? null,
      expires_at: c?.expires_at ?? null,
      has_access_token: !!c?.access_token,
      has_refresh_token: !!c?.refresh_token
    }));

    res.json({ ok: true, count: slim.length, connections: slim });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});
// ────────────────────────────────────────────────────────────
// fortnox/sync/offers  (Render-first, read-only)
app.post("/fortnox/sync/offers", async (req, res) => {
  const { connection_id, page = 1, limit = 100 } = req.body || {};
  if (!connection_id) return res.status(400).json({ ok:false, error:"Missing connection_id" });

  const tok = await ensureFortnoxAccessToken(connection_id);
  if (!tok.ok) return res.status(401).json(tok);

  const r = await fortnoxGet("/offers", tok.access_token, { page, limit });
  if (!r.ok) return res.status(r.status).json(r);

  return res.json({
    ok: true,
    connection_id,
    meta: r.data?.MetaInformation || null,
    offers: r.data?.Offers || []
  });
});
// ────────────────────────────────────────────────────────────
// Fortnox PDF -> Bubble fileupload helpers (OFFERS)
// Bubble FortnoxOffer fields used:
// - ft_pdf (file)
// - ft_pdf_fetched_at (date)
// - needs_pdf_sync (yes/no)

const boolish = (v, def = false) => {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return def;
};
app.get("/debug/fortnox-binary-version", (req, res) => {
  res.json({
    ok: true,
    note: "fortnoxGetBinary should have NO Accept header (or application/json)",
    hasAcceptInBinary: false,
    ts: new Date().toISOString()
  });
});
async function fortnoxGetBinary(path, accessToken) {
  const base = "https://api.fortnox.se/3";
  const url = base + path;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Client-Secret": String(FORTNOX_CLIENT_SECRET || "")
      // OBS: INGEN Accept-header här (Fortnox kan kasta 1000030 om den inte gillar värdet)
      // Vill du ändå ha en: sätt "Accept": "application/json"
    }
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, status: r.status, url, detail: txt };
  }

  const ab = await r.arrayBuffer();
  return {
    ok: true,
    status: r.status,
    url,
    contentType: r.headers.get("content-type") || null,
    buf: Buffer.from(ab)
  };
}
// Uploadar fil till Bubble via /fileupload och returnerar file-URL string
async function bubbleUploadFile({ filename, contentType, buffer }) {
  let lastErr = null;

  for (const base of BUBBLE_BASES) {
    const url = `${String(base).replace(/\/+$/, "")}/fileupload`;
    try {
      const fd = new FormData();
      const blob = new Blob([buffer], { type: contentType || "application/pdf" });
      fd.append("file", blob, filename);

      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + BUBBLE_API_KEY
          // OBS: sätt inte Content-Type här (FormData sätter boundary själv)
        },
        body: fd
      });

      const txt = await r.text().catch(() => "");
      if (!r.ok) {
        lastErr = { base, status: r.status, url, body: txt?.slice(0, 2000) || "" };
        continue;
      }

      // Bubble brukar returnera en URL som text. Ibland JSON.
      try {
        const j = txt ? JSON.parse(txt) : null;
        if (typeof j === "string") return j;
        if (j?.url) return j.url;
        if (j?.file_url) return j.file_url;
      } catch (_) {}

      const out = String(txt || "").trim();
      if (!out) {
        lastErr = { base, status: 200, url, body: "Empty fileupload response" };
        continue;
      }
      return out;
    } catch (e) {
      lastErr = { base, error: e?.message || String(e), url };
    }
  }

  const err = new Error("bubbleUploadFile failed");
  err.detail = lastErr;
  throw err;
}
// ────────────────────────────────────────────────────────────
// Helpers: skapa/uppdatera Offert + dokument automatiskt för FortnoxOffer PDF

async function ensureOffertWrapperForDeal({ deal_id, bubble_offer_id, docNo }) {
  // deal_id = Deal's unique id (som du stoppar i Fortnox "Ert referensnummer" => ft_your_reference)
  const dealId = String(deal_id || "").trim();
  if (!dealId) return { ok: false, skipped: true, reason: "missing_deal_id" };
  if (!bubble_offer_id) return { ok: false, skipped: true, reason: "missing_bubble_offer_id" };

  // Finns redan en Offert som både:
  // - hör till deal
  // - innehåller denna FortnoxOffer i listan FortnoxOffer
  let existing = null;
  try {
    existing = await bubbleFindOne("Offert", [
      { key: "deal", constraint_type: "equals", value: dealId },
      { key: "FortnoxOffer", constraint_type: "contains", value: bubble_offer_id }
    ]);
  } catch (e) {
    // ignore, create new below
  }

  if (existing?._id) {
    return { ok: true, offert_id: existing._id, offert_obj: existing, created: false };
  }

  // Skapa ny Offert-wrapper
  const titel = `Fortnox offert ${docNo || ""}`.trim() || "Fortnox offert";
  const offertId = await bubbleCreate("Offert", {
    deal: dealId,
    titel,
    // din field heter "FortnoxOffer" (list of FortnoxOffers) enligt din datatyp-bild
    FortnoxOffer: [bubble_offer_id],
    offer_status: false
  });

  const offertObj = await bubbleGet("Offert", offertId).catch(() => null);

  return { ok: true, offert_id: offertId, offert_obj: offertObj, created: true };
}

async function ensureDokumentForOffert({ offert_id, fileUrl, docNo }) {
  if (!offert_id) return { ok: false, skipped: true, reason: "missing_offert_id" };
  if (!fileUrl) return { ok: false, skipped: true, reason: "missing_fileUrl" };

  // Försök hitta befintligt dokument på samma Offert + samma fileUrl
  let existingDoc = null;
  try {
    existingDoc = await bubbleFindOne("Dokument", [
      { key: "offert", constraint_type: "equals", value: offert_id },
      { key: "file", constraint_type: "equals", value: fileUrl }
    ]);
  } catch (e) {}

  const nowIso = new Date().toISOString();
  const titel = `Offert ${docNo || ""} (Fortnox PDF)`.trim();

  if (existingDoc?._id) {
    await bubblePatch("Dokument", existingDoc._id, {
      titel,
      latest_update: nowIso
    });
    return { ok: true, dokument_id: existingDoc._id, created: false };
  }

  // Skapa nytt dokument
  const dokumentId = await bubbleCreate("Dokument", {
    titel,
    beskrivning: "PDF hämtad från Fortnox (preview)",
    file: fileUrl,
    latest_update: nowIso,
    offert: offert_id
    // author lämnar vi tomt här (du kan sätta senare i Bubble om du vill)
  });

  return { ok: true, dokument_id: dokumentId, created: true };
}

async function ensureOffertHasDokument({ offert_obj, offert_id, dokument_id }) {
  if (!offert_id || !dokument_id) return { ok: false, skipped: true };

  // Offert har fältet "dokument" (list of documents) enligt din datatyp-bild.
  // Vi patchar listan "dokument" så att den innehåller dokument_id (utan dubletter).
  let current = offert_obj;
  if (!current) current = await bubbleGet("Offert", offert_id).catch(() => null);

  const curList = Array.isArray(current?.dokument) ? current.dokument : [];
  if (curList.includes(dokument_id)) return { ok: true, already: true };

  const next = [...curList, dokument_id];
  await bubblePatch("Offert", offert_id, { dokument: next });
  return { ok: true, already: false };
}
async function fetchAndStoreOfferPdf({
  connection_id,
  offer_docno,
  bubble_offer_id,
  access_token,

  // NYTT: så vi kan skapa Offert + dokument kopplat till rätt Deal
  deal_id
}) {
  const docNo = String(offer_docno || "").trim();
  if (!docNo) return { ok: false, status: 400, error: "Missing offer_docno" };

  // 1) Fortnox preview PDF
  const pdf = await fortnoxGetBinary(`/offers/${encodeURIComponent(docNo)}/preview`, access_token);
  if (!pdf.ok || !pdf.buf?.length) {
    return { ok: false, status: pdf.status || 500, error: "Failed to fetch offer PDF", detail: pdf };
  }

  // 2) Upload to Bubble
  const fileName = `fortnox_offer_${connection_id}_${docNo}.pdf`;
  const fileUrl = await bubbleUploadFile({
    filename: fileName,
    contentType: pdf.contentType || "application/pdf",
    buffer: pdf.buf
  });

  // 3) Patch FortnoxOffer: set file + metadata
  await bubblePatch("FortnoxOffer", bubble_offer_id, {
    ft_pdf: fileUrl,
    ft_pdf_fetched_at: new Date().toISOString(),
    needs_pdf_sync: false
  });

  // 4) NYTT: skapa/uppdatera Offert-wrapper + dokument (PDF)
  // - Offert.deal = deal_id (Deal unique id)
  // - Offert.FortnoxOffer contains bubble_offer_id
  // - dokument.offert = Offert
  // - dokument.file = fileUrl
  let offertWrap = null;
  let docRes = null;

  try {
    const wrap = await ensureOffertWrapperForDeal({ deal_id, bubble_offer_id, docNo });
    offertWrap = wrap;

    if (wrap?.ok && wrap?.offert_id) {
      docRes = await ensureDokumentForOffert({ offert_id: wrap.offert_id, fileUrl, docNo });

      if (docRes?.ok && docRes?.dokument_id) {
        await ensureOffertHasDokument({
          offert_obj: wrap.offert_obj,
          offert_id: wrap.offert_id,
          dokument_id: docRes.dokument_id
        });
      }
    }
  } catch (e) {
    // Vi vill INTE faila hela PDF-hämtningen om dokument-kopplingen strular.
    // PDF:en är redan sparad på FortnoxOffer.
    console.warn("[fetchAndStoreOfferPdf] Offert/dokument linkage failed", e?.message || e);
  }

  return {
    ok: true,
    ft_pdf: fileUrl,
    bytes: pdf.buf.length,
    offer_docno: docNo,
    link: {
      deal_id: deal_id || null,
      offert_id: offertWrap?.offert_id || null,
      dokument_id: docRes?.dokument_id || null
    }
  };
}
// ────────────────────────────────────────────────────────────
// /fortnox/upsert/offers
// - fetch_pdf: true/false (default false)
// - pdf_missing_only: true/false (default true)
// - pdf_max_per_page: max PDF-försök per sida (default 10)  <-- throttling på attempted
// - pdf_pause_ms: paus mellan PDF-hämtningar (default 400ms)
// Retur: first_pdf_error visar första PDF-felet (Fortnox eller Bubble upload)
app.post("/fortnox/upsert/offers", async (req, res) => {
  const {
    connection_id,
    page = 1,
    limit = 100,

    fetch_pdf = false,
    pdf_missing_only = true,
    pdf_max_per_page = 10,
    pdf_pause_ms = 400
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let firstError = null;
  let meta = null;

  // PDF counters
  let pdf_attempted = 0;
  let pdf_fetched = 0;
  let pdf_skipped = 0;
  let pdf_errors = 0;

  // NEW: capture first PDF error for curl-debug
  let firstPdfError = null;

  try {
    // 1) Hämta offers via din befintliga sync-route
    const syncRes = await fetch(`${SELF_BASE_URL}/fortnox/sync/offers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify({ connection_id, page, limit })
    });

    const syncText = await syncRes.text().catch(() => "");
    let sync = null;
    try { sync = syncText ? JSON.parse(syncText) : null; }
    catch { sync = { raw: syncText }; }

    if (!syncRes.ok || !sync || sync.ok === false) {
      return res.status(400).json({
        ok: false,
        error: "sync/offers failed",
        http_status: syncRes.status,
        detail: sync
      });
    }

    const offers = Array.isArray(sync?.offers) ? sync.offers : [];
    meta = sync?.meta || null;

    // 2) Om PDF ska hämtas i samma pass: hämta token EN gång
    const wantPdf = boolish(fetch_pdf, false);
    let tok = null;
    if (wantPdf) {
      tok = await ensureFortnoxAccessToken(connection_id);
      if (!tok?.ok) {
        return res.status(401).json({
          ok: false,
          error: "Token error",
          detail: tok
        });
      }
    }

    const maxPerPage = Math.max(0, Number(pdf_max_per_page) || 0);
    const pauseMs = Math.max(0, Number(pdf_pause_ms) || 0);
    const missingOnly = boolish(pdf_missing_only, true);

// 3) Upsert per offer
let detail_enriched = 0;        // NEW: räkna hur många detail-enrich vi gjorde
let detail_errors = 0;
let firstDetailError = null;

for (const o of offers) {
  const docNo = String(o?.DocumentNumber || "").trim();
  if (!docNo) { skipped++; continue; }

  // Bas-payload från LIST (saknar YourReferenceNumber)
  const payload = {
    connection: connection_id, // Bubble reference (FortnoxConnection) = Bubble thing-id
    ft_document_number: docNo,
    ft_customer_number: String(o?.CustomerNumber || ""),
    ft_customer_name: String(o?.CustomerName || ""),
    // OBS: kommer ofta vara tomt från listan – vi enrich:ar senare
    ft_your_reference: String(o?.YourReferenceNumber || o?.YourReference || "").trim(),
    ft_offer_date: toIsoDate(o?.OfferDate),
    ft_total: toNumOrNull(o?.Total),
    ft_currency: String(o?.Currency || ""),
    ft_sent: !!o?.Sent,
    ft_cancelled: !!o?.Cancelled,
    ft_url: String(o?.["@url"] || ""),
    ft_raw_json: JSON.stringify(o || {}),
    needs_rows_sync: true
  };

  try {
    // bubbleFindOne() hos dig returnerar ett Bubble-objekt (med _id) eller null.
    const existing = await bubbleFindOne("FortnoxOffer", [
      { key: "connection", constraint_type: "equals", value: connection_id },
      { key: "ft_document_number", constraint_type: "equals", value: docNo }
    ]);

    let bubbleId = null;

    if (existing?._id) {
      // UPDATE
      bubbleId = existing._id;

      const r = await bubblePatch("FortnoxOffer", bubbleId, payload);

      // I din kodbas kan bubblePatch vara boolean true vid OK.
      // Vi accepterar även några vanliga varianter, men främst true.
      const patchOk =
        r === true ||
        r?.ok === true ||
        r?.status === "success" ||
        r?.status === "SUCCESS" ||
        r?.response?.status === "success";

      if (!patchOk) {
        const err = new Error("bubblePatch failed");
        err.detail = r;
        throw err;
      }

      updated++;
    } else {
      // CREATE
      const r = await bubbleCreate("FortnoxOffer", payload);

      // bubbleCreate i din kod brukar returnera id-string vid OK.
      // Men vi stödjer även några varianter.
      const createdId =
        (typeof r === "string" && r) ||
        r?.id ||
        r?._id ||
        r?.response?.id ||
        r?.response?._id ||
        null;

      if (!createdId) {
        const err = new Error("bubbleCreate failed");
        err.detail = r;
        throw err;
      }

      bubbleId = createdId;
      created++;
    }

    // ────────────────────────────────────────────────────────────
    // NEW: Detail-enrichment (throttlad)
    //
    // Fortnox list-offers saknar YourReferenceNumber (deal-koden).
    // Vi hämtar detaljer för ett begränsat antal poster per körning.
    //
    const shouldEnrich = wantPdf && detail_enriched < maxPerPage;          // återanvänder pdf_max_per_page som throttle

    // Enrich bara om vi saknar deal-kod i Bubble (eller om payload saknade den)
    // Vi använder "missingOnly"-logiken för att undvika onödiga calls.
    const missingDeal = !String(payload.ft_your_reference || "").trim();

    if (shouldEnrich && missingDeal) {
      const det = await fortnoxGetOfferDetail(tok, docNo);
      if (det?.ok && det.offer) {
        const yourRef = String(det.offer?.YourReferenceNumber || det.offer?.YourReference || "").trim();

        const patch = {
          ft_your_reference: yourRef,
          ft_delivery_date: toIsoDate(det.offer?.DeliveryDate),
          ft_valid_until: toIsoDate(det.offer?.ExpireDate),
          // om du vill spara hela detail-json också:
          // ft_raw_json_detail: JSON.stringify(det.offer || {})
        };

        const pr = await bubblePatch("FortnoxOffer", bubbleId, patch);

const patchOk =
  pr === true ||
  typeof pr === "string" ||
  pr?.ok === true ||
  pr?.status === "success" ||
  pr?.status === "SUCCESS" ||
  pr?.response?.status === "success";

if (!patchOk) {
  detail_errors++;
  if (!firstDetailError) {
    firstDetailError = {
      ok: false,
      stage: "bubblePatch(detail) failed",
      docNo,
      bubbleId,
      patch_attempted: patch,
      detail: pr
    };
  }
  // IMPORTANT: fortsätt utan att kasta
} else {
  detail_enriched++;
}
      } else {
        detail_errors++;
        if (!firstDetailError) {
          firstDetailError = {
            ok: false,
            stage: "offer_detail_failed",
            docNo,
            detail: det
          };
        }
      }
    }

    // ────────────────────────────────────────────────────────────
   // ────────────────────────────────────────────────────────────
// PDF fetch (din befintliga logik, men med KORREKT param-mapping)
if (wantPdf) {
  const alreadyHasPdf = !!existing?.item?.ft_pdf;
  const shouldTryPdf =
    pdf_attempted < maxPerPage &&
    (!missingOnly || !alreadyHasPdf);

  if (shouldTryPdf) {
    pdf_attempted++;
    try {
      const pdfRes = await fetchAndStoreOfferPdf({
        connection_id,
        offer_docno: docNo,          // ✅ MÅSTE heta offer_docno
        bubble_offer_id: bubbleId,   // ✅ MÅSTE heta bubble_offer_id
        access_token: tok.access_token // ✅ MÅSTE heta access_token (string)
      });

      if (pdfRes?.ok) {
        pdf_fetched++;
      } else {
        pdf_errors++;
        if (!firstPdfError) {
          firstPdfError = {
            ok: false,
            stage: "fetchAndStoreOfferPdf_failed",
            docNo,
            detail: pdfRes
          };
        }
      }

      if (pauseMs) await sleep(pauseMs);
    } catch (e) {
      pdf_errors++;
      if (!firstPdfError) {
        firstPdfError = {
          ok: false,
          stage: "fetchAndStoreOfferPdf_exception",
          docNo,
          detail: String(e?.message || e)
        };
      }
    }
  } else {
    pdf_skipped++;
  }
}
  } catch (e) {
    errors++;
    if (!firstError) {
      firstError = {
        docNo,
        message: e?.message || String(e),
        stack: e?.stack || null,
        detail: e?.detail || null
      };
    }
  }
}

return res.json({
  ok: true,
  connection_id,
  page,
  limit,
  meta,
  counts: { created, updated, skipped, errors },

  // NEW: detail-enrichment stats
  detail: {
    enabled: true,
    enriched: detail_enriched,
    errors: detail_errors,
    cfg: { maxPerPage }
  },

  pdf: {
    enabled: wantPdf,
    attempted: pdf_attempted,
    fetched: pdf_fetched,
    skipped: pdf_skipped,
    errors: pdf_errors,
    cfg: { missingOnly, maxPerPage, pauseMs }
  },

  first_error: firstError,
  first_detail_error: firstDetailError,
  first_pdf_error: firstPdfError
});
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }
});
// ────────────────────────────────────────────────────────────
// /fortnox/upsert/offer-rows  (WU-optimerad: bulk fetch av befintliga rows)
app.post("/fortnox/upsert/offer-rows", requireApiKey, async (req, res) => {
  const t0 = Date.now();

  try {
    const { connection_id, offer_docno } = req.body || {};
    const docNo = String(offer_docno || "").trim();

    if (!connection_id || !docNo) {
      return res.status(400).json({ ok: false, error: "Missing connection_id or offer_docno" });
    }

    const tok = await ensureFortnoxAccessToken(connection_id);
    const r = await fortnoxGet(`/offers/${encodeURIComponent(docNo)}`, tok.access_token);
    if (!r.ok) {
      return res.status(r.status || 500).json({ ok: false, error: "fortnoxGet failed", detail: r });
    }

    const offer = r.data?.Offer;
    const rows = Array.isArray(offer?.OfferRows) ? offer.OfferRows : [];

    const parent = await bubbleFindOne("FortnoxOffer", [
      { key: "connection", constraint_type: "equals", value: connection_id },
      { key: "ft_document_number", constraint_type: "equals", value: docNo }
    ]);

    if (!parent?._id) {
      return res.status(404).json({
        ok: false,
        error: "Parent FortnoxOffer not found in Bubble (run /fortnox/upsert/offers first for this docNo)",
        connection_id,
        offer_docno: docNo
      });
    }

    // ---- NEW: Bulk-hämta alla befintliga rows för den här offerten ----
    // Detta ersätter N st bubbleFind(ft_unique_key=...) (dyrt i WU).
    const PAGE_SIZE = 100;
    const MAX_PAGES = 2000; // safety
    const existingByKey = {};
    let bulk_ok = false;

    try {
      let cursor = 0;
      let pages = 0;
      let prevFirstId = null;

      while (pages < MAX_PAGES) {
        pages++;

        // OBS: om din bubbleFind inte stödjer cursor så kan den ignorera cursor,
        // därför har vi "repeat detection" nedan som breaks.
        const page = await bubbleFind("FortnoxOfferRow", {
          constraints: [{ key: "offer", constraint_type: "equals", value: parent._id }],
          limit: PAGE_SIZE,
          cursor
        });

        if (!Array.isArray(page) || page.length === 0) break;

        const firstId = page?.[0]?._id || null;
        if (prevFirstId && firstId && firstId === prevFirstId) {
          // cursor verkar ignoreras → bryt och fall tillbaka till legacy-metod
          throw new Error("bubbleFind cursor seems unsupported (repeated first record)");
        }
        prevFirstId = firstId;

        for (const it of page) {
          if (it?.ft_unique_key && it?._id) {
            existingByKey[String(it.ft_unique_key)] = it._id;
          }
        }

        if (page.length < PAGE_SIZE) break;
        cursor += PAGE_SIZE;
      }

      bulk_ok = true;
    } catch (e) {
      bulk_ok = false;
      console.warn("[/fortnox/upsert/offer-rows] bulk prefetch failed, fallback to per-row find:", e?.message || e);
    }

    let created = 0, updated = 0, errors = 0;
    let first_error = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const uniqueKey = `OFFERROW_${row.RowId || i}_${connection_id}_${docNo}`;

      const payload = {
        connection: connection_id,
        offer: parent._id,
        ft_offer_document_number: docNo,
        ft_row_index: i + 1,
        ft_article_number: row.ArticleNumber || "",
        ft_description: row.Description || "",
        ft_quantity: row.Quantity ?? null,
        ft_unit: row.Unit || "",
        ft_price: toNumOrNull(row?.Price),
        ft_total: toNumOrNull(row?.Total),
        ft_unique_key: uniqueKey,
        ft_raw_json: JSON.stringify(row || {})
      };

      try {
        let existingId = null;

        if (bulk_ok) {
          existingId = existingByKey[uniqueKey] || null;
        } else {
          // legacy fallback (exakt som tidigare beteende)
          const found = await bubbleFind("FortnoxOfferRow", {
            constraints: [{ key: "ft_unique_key", constraint_type: "equals", value: uniqueKey }],
            limit: 1
          });
          if (found?.[0]?._id) existingId = found[0]._id;
        }

        if (existingId) {
          await bubblePatch("FortnoxOfferRow", existingId, payload);
          updated++;
        } else {
          await bubbleCreate("FortnoxOfferRow", payload);
          created++;
        }
      } catch (e) {
        errors++;
        if (!first_error) {
          first_error = {
            row_index: i + 1,
            message: e?.message || String(e),
            detail: e?.detail || null
          };
        }
      }
    }

    try {
      await bubblePatch("FortnoxOffer", parent._id, {
        rows_last_synced_at: new Date().toISOString(),
        needs_rows_sync: false
      });
    } catch (e) {
      errors++;
      if (!first_error) first_error = { message: "Failed to patch parent offer", detail: e?.detail || null };
    }

    return res.json({
      ok: true,
      connection_id,
      offer_docno: docNo,
      rows_count: rows.length,
      counts: { created, updated, errors },
      first_error,
      bulk_prefetch: { ok: bulk_ok, keys: bulk_ok ? Object.keys(existingByKey).length : 0 },
      ms: Date.now() - t0
    });
  } catch (e) {
    console.error("[/fortnox/upsert/offer-rows] fatal", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Fortnox: upsert offer rows for FLAGGED offers (needs_rows_sync=true)
app.post("/fortnox/upsert/offer-rows/flagged", requireApiKey, async (req, res) => {
  try {
    const { connection_id, limit = 30, pause_ms = 250 } = req.body || {};
    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });

    const flagged = await bubbleFind("FortnoxOffer", {
      constraints: [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "needs_rows_sync", constraint_type: "equals", value: true }
      ],
      limit: Number(limit) || 30
    });

    const offers = Array.isArray(flagged) ? flagged : [];
    const results = [];
    let ok_count = 0, fail_count = 0;

    for (const o of offers) {
      const docNo = String(o?.ft_document_number || "").trim();
      if (!docNo) continue;

      const rr = await fetch(`${SELF_BASE_URL}/fortnox/upsert/offer-rows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.MIRA_RENDER_API_KEY
        },
        body: JSON.stringify({ connection_id, offer_docno: docNo })
      });

      const text = await rr.text();
      let j = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }

      const ok = !!j.ok;

      results.push({
        docNo,
        ok,
        http_status: rr.status,
        counts: j.counts || null,
        first_error: j.first_error || j.error || j.detail || null
      });

      ok ? ok_count++ : fail_count++;
      if (pause_ms) await sleep(Number(pause_ms));
    }

    return res.json({
      ok: true,
      connection_id,
      flagged_found: offers.length,
      ok_count,
      fail_count,
      results
    });
  } catch (e) {
    console.error("[/fortnox/upsert/offer-rows/flagged] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// Fortnox: sync ONE offer (fetch offer + OfferRows)
app.post("/fortnox/sync/offers/one", requireApiKey, async (req, res) => {
  try {
    const { connection_id, offer_docno } = req.body || {};
    const docNo = String(offer_docno || "").trim();

    if (!connection_id) return res.status(400).json({ ok: false, error: "Missing connection_id" });
    if (!docNo) return res.status(400).json({ ok: false, error: "Missing offer_docno" });

    const tok = await ensureFortnoxAccessToken(connection_id);
    if (!tok.ok) {
      return res.status(401).json({
        ok: false,
        error: tok.error || "Token error",
        detail: tok.detail || null
      });
    }

    const r = await fortnoxGet("/offers/" + encodeURIComponent(docNo), tok.access_token);
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false,
        status: r.status || 500,
        data: r.data || null,
        url: r.url || null
      });
    }

    const offer = r.data?.Offer || r.data?.offer || null;
    const rows = Array.isArray(offer?.OfferRows) ? offer.OfferRows : [];

    return res.json({
      ok: true,
      connection_id,
      offer_docno: docNo,
      rows_count: rows.length,
      offer,
      rows
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Alias så att dina gamla kommandon funkar
app.post("/fortnox/sync/offer", requireApiKey, async (req, res) => {
  try {
    const r = await fetch(`${SELF_BASE_URL}/fortnox/sync/offers/one`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MIRA_RENDER_API_KEY
      },
      body: JSON.stringify(req.body || {})
    });

    const text = await r.text();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }

    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────
// Fortnox: upsert ALL invoices pages (NO rows) – pages via /fortnox/upsert/invoices meta
app.post("/fortnox/upsert/invoices/all", requireApiKey, async (req, res) => {
  try {
    const {
      connection_id,
      start_page = 1,
      limit = 100,
      months_back = 12,
      max_pages = 9999,
      pause_ms = 250
    } = req.body || {};

    if (!connection_id) {
      return res.status(400).json({ ok: false, error: "Missing connection_id" });
    }

    const mb = Math.max(1, Number(months_back) || 12);
    const perPage = Math.max(1, Math.min(500, Number(limit) || 100));
    const maxPages = Math.max(1, Number(max_pages) || 9999);
    const pauseMs = Math.max(0, Number(pause_ms) || 0);

    // Robust ORIGIN för self-calls
    const ORIGIN =
      (typeof SELF_BASE_URL !== "undefined" && SELF_BASE_URL) ||
      (typeof BASE_URL !== "undefined" && BASE_URL) || // sista fallback (brukar vara Bubble – men bättre än null)
      `http://127.0.0.1:${process.env.PORT || 10000}`;

    const apiKey =
      (typeof RENDER_API_KEY !== "undefined" && RENDER_API_KEY) ||
      process.env.MIRA_RENDER_API_KEY ||
      process.env.MIRA_EXCHANGE_API_KEY ||
      null;

    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "No Render API key resolved (RENDER_API_KEY/MIRA_RENDER_API_KEY)" });
    }

    let page = Math.max(1, Number(start_page) || 1);
    let pages_done = 0;

    let created = 0, updated = 0, skipped = 0, errors = 0;
    let first_error = null;

    const callUpsertInvoicesPage = async (body) => {
      const controller = new AbortController();
      const timeoutMs = 180000; // 3 min per sida (justera vid behov)
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const url = String(ORIGIN).replace(/\/+$/, "") + "/fortnox/upsert/invoices";

      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.ok) {
          return { ok: false, status: r.status, detail: j };
        }
        return j;
      } finally {
        clearTimeout(timer);
      }
    };

    while (pages_done < maxPages) {
      const j = await callUpsertInvoicesPage({
        connection_id,
        page,
        limit: perPage,
        months_back: mb,
        pause_ms: 0 // undvik dubbel-paus (vi pausar här i /all)
      });

      if (!j?.ok) {
        return res.status(400).json({
          ok: false,
          error: "upsert/invoices failed",
          connection_id,
          page,
          detail: j
        });
      }

      created += Number(j?.counts?.created || 0);
      updated += Number(j?.counts?.updated || 0);
      skipped += Number(j?.counts?.skipped || 0);
      errors += Number(j?.counts?.errors || 0);
      if (!first_error && j?.first_error) first_error = j.first_error;

      pages_done++;

      const meta = j?.meta || null;
      const totalPagesRaw = meta?.["@TotalPages"] ?? meta?.TotalPages ?? null;
      const totalPages = totalPagesRaw ? Number(totalPagesRaw) : null;

      // docs på sidan – robust om j.docs saknas
      const docsThisPage =
        Number(
          j?.docs ??
          j?.debug_counts?.fetched ??
          j?.debug_counts?.kept_by_date ??
          (Array.isArray(j?.invoices) ? j.invoices.length : 0) ??
          0
        ) || 0;

      // Stopvillkor #1: Fortnox total pages och vi är klara
      if (totalPages && page >= totalPages) break;

      // Stopvillkor #2: inga docs på denna sida (vanligt vid filter)
      if (!docsThisPage) break;

      page++;

      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    }

    const done = pages_done >= maxPages ? false : true; // "true" betyder "vi stannade pga stopvillkor", inte pga max_pages

    return res.json({
      ok: true,
      connection_id,
      months_back: mb,
      start_page: Math.max(1, Number(start_page) || 1),
      limit: perPage,
      pages_done,
      next_page: page,          // nästa sida att köra om du fortsätter senare
      done,                     // true om vi stoppade naturligt (slut/0 docs), annars false om vi nådde max_pages
      counts: { created, updated, skipped, errors },
      first_error
    });
  } catch (e) {
    console.error("[/fortnox/upsert/invoices/all] error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────
// Fortnox: upsert offers - batch loop (N pages per run)
// NYTT: skickar igenom pdf-parametrar till /fortnox/upsert/offers
app.post("/fortnox/upsert/offers/all", async (req, res) => {
  const {
    connection_id,
    start_page = 1,
    limit = 100,
    max_pages = 10,

    // pass-through (valfritt)
    fetch_pdf = false,
    pdf_missing_only = true,
    pdf_max_per_page = 10,
    pdf_pause_ms = 400
  } = req.body || {};

  if (!connection_id) return res.status(400).json({ ok:false, error:"Missing connection_id" });

  const start = numOr(start_page, 1);
  const lim = Math.max(1, Math.min(500, numOr(limit, 100)));
  const maxP = Math.max(1, numOr(max_pages, 10));

  let page = start;
  let created = 0, updated = 0, errors = 0;
  let totalPages = null;

  // pdf aggregate
  let pdf_attempted = 0, pdf_fetched = 0, pdf_skipped = 0, pdf_errors = 0;

  try {
    for (let i = 0; i < maxP; i++) {
      const r = await fetch(`${SELF_BASE_URL}/fortnox/upsert/offers`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "x-api-key": process.env.MIRA_RENDER_API_KEY },
        body: JSON.stringify({
          connection_id,
          page,
          limit: lim,
          fetch_pdf,
          pdf_missing_only,
          pdf_max_per_page,
          pdf_pause_ms
        })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        return res.status(400).json({ ok:false, error:"upsert/offers failed", page, detail:j });
      }

      created += j.counts?.created || 0;
      updated += j.counts?.updated || 0;
      errors  += j.counts?.errors  || 0;

      pdf_attempted += j.pdf?.attempted || 0;
      pdf_fetched   += j.pdf?.fetched   || 0;
      pdf_skipped   += j.pdf?.skipped   || 0;
      pdf_errors    += j.pdf?.errors    || 0;

      const meta = j.meta || null;
      const cur = numOr(meta?.["@CurrentPage"], page);
      const tot = numOr(meta?.["@TotalPages"], 0);
      if (tot) totalPages = tot;

      if (tot && cur >= tot) {
        return res.json({
          ok: true,
          connection_id,
          done: true,
          start_page: start,
          end_page: cur,
          total_pages: tot,
          counts: { created, updated, errors },
          pdf: { attempted: pdf_attempted, fetched: pdf_fetched, skipped: pdf_skipped, errors: pdf_errors },
          next_page: 1
        });
      }

      page = cur + 1;
    }

    return res.json({
      ok: true,
      connection_id,
      done: false,
      start_page: start,
      end_page: page - 1,
      total_pages: totalPages,
      counts: { created, updated, errors },
      pdf: { attempted: pdf_attempted, fetched: pdf_fetched, skipped: pdf_skipped, errors: pdf_errors },
      next_page: page
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
});
// ────────────────────────────────────────────
// Fortnox: fetch offer PDFs for flagged offers (needs_pdf_sync=true)
// Lättviktig batch: kör i nightly efter offers/all.
app.post("/fortnox/upsert/offer-pdfs/flagged", requireApiKey, async (req, res) => {
  try {
    const {
      connection_id,
      limit = 10,
      pause_ms = 500
    } = req.body || {};

    if (!connection_id) return res.status(400).json({ ok:false, error:"Missing connection_id" });

    const lim = Math.max(1, Math.min(100, Number(limit) || 10));
    const pauseMs = Math.max(0, Number(pause_ms) || 0);

    const tok = await ensureFortnoxAccessToken(connection_id);
    if (!tok.ok) return res.status(401).json(tok);

    // Hämta FortnoxOffer med needs_pdf_sync=true
    const list = await bubbleFind("FortnoxOffer", {
      constraints: [
        { key: "connection", constraint_type: "equals", value: connection_id },
        { key: "needs_pdf_sync", constraint_type: "equals", value: true }
      ],
      limit: lim
    });

    let attempted = 0, fetched = 0, skipped = 0, errors = 0;
    let first_error = null;

    for (const it of list) {
      const id = it?._id;
      const docNo = String(it?.ft_document_number || "").trim();
      if (!id || !docNo) { skipped++; continue; }

      // Om PDF redan finns, stäng flaggan
      if (it?.ft_pdf) {
        skipped++;
        try { await bubblePatch("FortnoxOffer", id, { needs_pdf_sync: false }); } catch {}
        continue;
      }

      attempted++;
      try {
        const r = await fetchAndStoreOfferPdf({
  connection_id,
  offer_docno: docNo,
  bubble_offer_id: id,
  access_token: tok.access_token,
  deal_id: it?.ft_your_reference
});

        if (r.ok) {
          fetched++;
          if (pauseMs) await sleep(pauseMs);
        } else {
          errors++;
          if (!first_error) first_error = r;
          try { await bubblePatch("FortnoxOffer", id, { needs_pdf_sync: true }); } catch {}
        }
      } catch (e) {
        errors++;
        if (!first_error) first_error = { docNo, message: e?.message || String(e), detail: e?.detail || null };
        try { await bubblePatch("FortnoxOffer", id, { needs_pdf_sync: true }); } catch {}
      }
    }

    return res.json({
      ok: true,
      connection_id,
      flagged_found: list.length,
      counts: { attempted, fetched, skipped, errors },
      first_error
    });

  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});
app.post("/fortnox/nightly/delta", requireApiKey, async (req, res) => {
  const lock = getLock();
  const now = Date.now();
  const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

  const numOr = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const { connection_id = null, only_connection_id = null, months_back = 12 } = req.body || {};
  const onlyId = (only_connection_id || connection_id || null);
  const mb = Math.max(1, numOr(months_back, 12));

  // stale lock clear
  if (lock.running && lock.started_at && (now - lock.started_at > LOCK_TTL_MS)) {
    console.warn("[nightly/delta] stale lock cleared", { ...lock, age_ms: now - lock.started_at });
    lock.running = false;
    lock.started_at = 0;
    lock.finished_at = 0;
    lock.connection_id = null;
    lock.run_id = null;
  }
  if (lock.running) return res.status(409).json({ ok: false, error: "Nightly already running", lock });

  lock.running = true;
  lock.started_at = now;
  lock.finished_at = 0;
  lock.connection_id = onlyId;
  lock.run_id = `${now}-${Math.random().toString(16).slice(2)}`;

  try {
    const connections = await getAllFortnoxConnections();
    const pickList = onlyId
      ? connections.filter(c => String(c?._id || "") === String(onlyId))
      : connections;

    const results = [];

    for (const conn of pickList) {
      const cid = conn._id;
      const allowDocs = isDocsConnection(cid);

      const one = {
        connection_id: cid,
        allow_docs: allowDocs,
        ok: false,
        steps: {},
        errors: []
      };

      try {
        // 1) customers (1 sida delta) — ALLA connections
        const customersJ = await postInternalJson(
          "/fortnox/upsert/customers",
          { connection_id: cid, page: 1, limit: 100 },
          120000
        );
        one.steps.customers = { ok: true, counts: customersJ.counts || null };

        // 2) orders + order rows — ENDAST docs-allowlist (Food & Event)
        if (allowDocs) {
          const startOrders = await getConnNextPage(cid, "orders_next_page", 1);

          const ordersJ = await postInternalJson(
            "/fortnox/upsert/orders/all",
            {
              connection_id: cid,
              months_back: mb,
              start_page: startOrders,
              limit: 100,
              max_pages: 5,
              pause_ms: 150
            },
            15 * 60 * 1000
          );

          one.steps.orders = {
            ok: true,
            done: !!ordersJ.done,
            next_page: ordersJ.next_page ?? null,
            counts: ordersJ.counts || null
          };

          await safeSetConnPaging(cid, {
            orders_next_page: ordersJ?.next_page || 1,
            orders_last_progress_at: nowIso(),
            ...(ordersJ?.done ? { orders_last_full_sync_at: nowIso() } : {})
          });

          for (let round = 0; round < 5; round++) {
            const rowsJ = await postInternalJson(
              "/fortnox/upsert/order-rows/flagged",
              { connection_id: cid, limit: 30, pause_ms: 250 },
              5 * 60 * 1000
            );
            if (!rowsJ.flagged_found) break;
          }
          one.steps.order_rows = { ok: true };
        } else {
          one.steps.orders = { skipped: true, reason: "not allowed for orders/offers" };
          one.steps.order_rows = { skipped: true, reason: "not allowed for orders/offers" };
        }

        // 3) offers + pdf + offer rows — ENDAST docs-allowlist
        if (allowDocs) {
          const startOffers = await getConnNextPage(cid, "offers_next_page", 1);

          const offersJ = await postInternalJson(
            "/fortnox/upsert/offers/all",
            {
              connection_id: cid,
              start_page: startOffers,
              limit: 100,
              max_pages: 5,
              fetch_pdf: false
            },
            15 * 60 * 1000
          );

          one.steps.offers = {
            ok: true,
            done: !!offersJ.done,
            next_page: offersJ.next_page ?? null,
            counts: offersJ.counts || null
          };

          await safeSetConnPaging(cid, {
            offers_next_page: offersJ?.next_page || 1,
            offers_last_progress_at: nowIso(),
            ...(offersJ?.done ? { offers_last_full_sync_at: nowIso() } : {})
          });

          const pdfJ = await postInternalJson(
            "/fortnox/upsert/offer-pdfs/flagged",
            { connection_id: cid, limit: 10, pause_ms: 500 },
            15 * 60 * 1000
          );

          one.steps.offer_pdfs = {
            ok: true,
            counts: pdfJ.counts || null,
            flagged_found: pdfJ.flagged_found ?? null
          };

          for (let round = 0; round < 5; round++) {
            const rowsJ = await postInternalJson(
              "/fortnox/upsert/offer-rows/flagged",
              { connection_id: cid, limit: 30, pause_ms: 250 },
              5 * 60 * 1000
            );
            if (!rowsJ.flagged_found) break;
          }
          one.steps.offer_rows = { ok: true };
        } else {
          one.steps.offers = { skipped: true, reason: "not allowed for orders/offers" };
          one.steps.offer_pdfs = { skipped: true, reason: "not allowed for orders/offers" };
          one.steps.offer_rows = { skipped: true, reason: "not allowed for orders/offers" };
        }

        // 4) invoices — ALLA connections
        const startInv = await getConnNextPage(cid, "invoices_next_page", 1);

        const invoicesJ = await postInternalJson(
          "/fortnox/upsert/invoices/all",
          { connection_id: cid, start_page: startInv, limit: 50, max_pages: 5, months_back: mb },
          15 * 60 * 1000
        );

        one.steps.invoices = {
          ok: true,
          done: !!invoicesJ.done,
          next_page: invoicesJ.next_page ?? null,
          counts: invoicesJ.counts || null
        };

        await safeSetConnPaging(cid, {
          invoices_next_page: invoicesJ?.next_page || 1,
          invoices_last_progress_at: nowIso(),
          ...(invoicesJ?.done ? { invoices_last_full_sync_at: nowIso() } : {})
        });

        one.ok = true;
        await safeSetConnPaging(cid, { nightly_last_run_at: nowIso(), nightly_last_error: "" });
      } catch (e) {
        one.ok = false;
        one.error = e?.message || String(e);
        one.detail = e?.detail || null;
        one.errors.push({ message: one.error, detail: one.detail });

        console.error("[nightly/delta] conn error", { connection_id: cid, error: one.error, detail: one.detail });
        await safeSetConnPaging(cid, { nightly_last_run_at: nowIso(), nightly_last_error: one.error });
      }

      results.push(one);
    }

    return res.json({ ok: true, run_id: lock.run_id, months_back: mb, results });
  } catch (e) {
    console.error("[nightly/delta] fatal", e);
    return res.status(500).json({ ok: false, run_id: lock.run_id, error: e?.message || String(e) });
  } finally {
    lock.running = false;
    lock.finished_at = Date.now();
    console.log("[nightly/delta] finished", { run_id: lock.run_id, finished_at: lock.finished_at });
  }
});
app.post("/fortnox/nightly/run", requireApiKey, async (req, res) => {
  const lock = getLock();
  const now = Date.now();
  const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

  let acquired = false;
  let myRunId = null;

  // --- Helpers ---
  const numOr = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const boolOr = (v, fallback) => (v === undefined ? fallback : !!v);

  const isDocsConnectionLocal = (connection_id) => {
    const id = String(connection_id || "").trim();
    const allow = String(
      process.env.FORTNOX_DOCS_CONNECTION_IDS ||
      process.env.FORTNOX_ORDERS_CONNECTION_IDS ||
      ""
    )
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (!allow.length) return true;
    return allow.includes(id);
  };

  const extractFortnoxErrorInfo = (err) => {
    // Walk down nested .detail chains until we find ErrorInformation
    let node = err?.detail?.body;
    for (let i = 0; i < 12 && node; i++) {
      if (node?.ErrorInformation) return node.ErrorInformation;
      node = node?.detail;
    }
    return null;
  };

  try {
    // Clear stale lock
    if (lock.running && lock.started_at && now - lock.started_at > LOCK_TTL_MS) {
      console.warn("[nightly/run] stale lock cleared", { ...lock, age_ms: now - lock.started_at });
      lock.running = false;
      lock.started_at = 0;
      lock.finished_at = 0;
      lock.connection_id = null;
      lock.run_id = null;
    }
    if (lock.running) {
      return res.status(409).json({ ok: false, error: "Nightly already running", lock });
    }

    myRunId = `${now}-${Math.random().toString(16).slice(2)}`;
    lock.running = true;
    lock.started_at = now;
    lock.finished_at = 0;
    lock.connection_id = null;
    lock.run_id = myRunId;
    acquired = true;

    const body = req.body || {};
    const months_back = Math.max(1, numOr(body.months_back, 12));
    const docs_allowlist = String(body.docs_allowlist ?? "").trim() || null;

    // allow override via request body (optional), else env-based isDocsConnectionLocal
    const allowDocsFor = (cid) => {
      if (!docs_allowlist) return isDocsConnectionLocal(cid);
      const allow = docs_allowlist.split(",").map(s => s.trim()).filter(Boolean);
      if (!allow.length) return isDocsConnectionLocal(cid);
      return allow.includes(String(cid));
    };

    // ✅ IMPORTANT: respect 0 (skip). Correctly read pages_per_call (NOT max_pages).
    const cfg = {
      customers: {
        limit:  numOr(body?.customers?.limit, 500),
        max_pages: numOr(body?.customers?.max_pages, 30),
        pause_ms: numOr(body?.customers?.pause_ms, 50),
        skip_without_orgnr: boolOr(body?.customers?.skip_without_orgnr, true),
        link_company: boolOr(body?.customers?.link_company, true)
      },
      orders: {
  mode: String(body?.orders?.mode || "delta"),  // <--- ADD
  limit: Number(body?.orders?.limit ?? 200) || 200,
  pages_per_call: Number(body?.orders?.pages_per_call ?? 5) || 5,
  pause_ms: Number(body?.orders?.pause_ms ?? 150) || 150
},
      offers: {
        limit: numOr(body?.offers?.limit, 200),
        pages_per_call: numOr(body?.offers?.pages_per_call, 5),
        pause_ms: numOr(body?.offers?.pause_ms, 150)
      },
      invoices: {
        limit: numOr(body?.invoices?.limit, 200),
        pages_per_call: numOr(body?.invoices?.pages_per_call, 5),
        pause_ms: numOr(body?.invoices?.pause_ms, 150)
      },
      rows: {
        limit: numOr(body?.rows?.limit, 30),
        passes: numOr(body?.rows?.passes, 20),
        pause_ms: numOr(body?.rows?.pause_ms, 250)
      }
    };

    const conns = await getAllFortnoxConnections();
    const results = [];

    for (const c of conns) {
      const connection_id = c._id;
      const allowDocs = allowDocsFor(connection_id);

      const one = {
        connection_id,
        allow_docs: allowDocs,
        customers: null,
        orders: null,
        offers: null,
        invoices: null,
        errors: []
      };

      // --- CUSTOMERS (ALL) — SOFT FAIL / SKIP WHEN max_pages<=0 ---
      if (cfg.customers.max_pages <= 0) {
        one.customers = { skipped: true, reason: "customers.max_pages=0" };
      } else {
        try {
          let startCustomers = await getConnNextPage(connection_id, "customers_next_page", 1);

          const runCustomers = async (start_page) => {
            return await postInternalJson(
              "/fortnox/upsert/customers/all",
              {
                connection_id,
                start_page,
                limit: cfg.customers.limit,
                max_pages: cfg.customers.max_pages,
                pause_ms: cfg.customers.pause_ms,
                skip_without_orgnr: cfg.customers.skip_without_orgnr,
                link_company: cfg.customers.link_company
              },
              180000
            );
          };

          let customersJ;
          try {
            customersJ = await runCustomers(startCustomers);
          } catch (e1) {
            const errInfo = extractFortnoxErrorInfo(e1);
            if (errInfo?.code === 2001889) {
              console.warn("[nightly/run] customers page out of range; resetting to page 1", {
                connection_id, startCustomers, limit: cfg.customers.limit, months_back
              });
              await safeSetConnPaging(connection_id, { customers_next_page: 1, customers_last_progress_at: nowIso() });
              customersJ = await runCustomers(1);
            } else {
              throw e1;
            }
          }

          one.customers = {
            done: !!customersJ.done,
            next_page: customersJ.next_page ?? null,
            counts: customersJ.counts || null
          };

          await safeSetConnPaging(connection_id, {
            customers_next_page: customersJ?.next_page || 1,
            customers_last_progress_at: nowIso(),
            ...(customersJ?.done ? { customers_last_full_sync_at: nowIso() } : {})
          });
        } catch (e) {
          const msg = e?.message || String(e);
          one.customers = {
            ok: false,
            skipped: true,
            reason: "customers failed (continuing)",
            message: msg,
            fortnox_error: extractFortnoxErrorInfo(e) || null
          };
          one.errors.push({ message: msg, detail: e?.detail || null });
        }
      }
// --- ORDERS + ORDER ROWS (DOCS ONLY) / SKIP WHEN pages_per_call<=0 ---
if (!allowDocs) {
  one.orders = { skipped: true, reason: "not allowed for orders/offers" };
} else if (cfg.orders.pages_per_call <= 0) {
  one.orders = { skipped: true, reason: "orders.pages_per_call=0" };
} else {
  const ordersMode = String(cfg.orders.mode || "delta").toLowerCase(); // "delta" | "backfill"
  let ordersOk = false;

  try {
    if (ordersMode === "backfill") {
      // BACKFILL: fortsätt från orders_next_page
      let startOrders = await getConnNextPage(connection_id, "orders_next_page", 1);

      const runOrdersAll = async (start_page) => {
        return await postInternalJson(
          "/fortnox/upsert/orders/all",
          {
            connection_id,
            start_page,
            limit: cfg.orders.limit,
            max_pages: cfg.orders.pages_per_call,
            pause_ms: cfg.orders.pause_ms,
            months_back
          },
          15 * 60 * 1000
        );
      };

      let ordersJ;
      try {
        ordersJ = await runOrdersAll(startOrders);
      } catch (e1) {
        const errInfo = extractFortnoxErrorInfo(e1);
        if (errInfo?.code === 2001889) {
          console.warn("[nightly/run] orders page out of range; resetting to page 1", {
            connection_id,
            startOrders,
            months_back
          });
          await safeSetConnPaging(connection_id, {
            orders_next_page: 1,
            orders_last_progress_at: nowIso()
          });
          ordersJ = await runOrdersAll(1);
        } else {
          throw e1;
        }
      }

      one.orders = {
        mode: "backfill",
        done: !!ordersJ.done,
        next_page: ordersJ.next_page ?? null,
        counts: ordersJ.counts || null
      };

      await safeSetConnPaging(connection_id, {
        orders_next_page: ordersJ?.next_page || 1,
        orders_last_progress_at: nowIso(),
        ...(ordersJ?.done ? { orders_last_full_sync_at: nowIso() } : {})
      });

      ordersOk = true;
    } else {
      // DELTA: alltid page 1..N (senaste först)
      const totals = { created: 0, updated: 0, skipped: 0, errors: 0 };

      for (let page = 1; page <= cfg.orders.pages_per_call; page++) {
        const j = await postInternalJson(
          "/fortnox/upsert/orders",
          {
            connection_id,
            months_back,
            page,
            limit: cfg.orders.limit
          },
          5 * 60 * 1000
        );

        const c = j?.counts || {};
        totals.created += Number(c.created || 0);
        totals.updated += Number(c.updated || 0);
        totals.skipped += Number(c.skipped || 0);
        totals.errors += Number(c.errors || 0);

        if (cfg.orders.pause_ms) await sleep(Number(cfg.orders.pause_ms));
      }

      one.orders = {
        mode: "delta",
        done: true,
        next_page: 1,
        counts: totals
      };

      // I delta-läge ska vi INTE flytta orders_next_page (för att inte “fastna” i historik).
      await safeSetConnPaging(connection_id, {
        orders_last_progress_at: nowIso(),
        orders_last_delta_at: nowIso()
      });

      ordersOk = true;
    }

    // --- Order rows flagged (optional) — only if rows.passes>0 AND orders ran ok ---
    if (ordersOk && cfg.rows.passes > 0) {
      for (let p = 0; p < cfg.rows.passes; p++) {
        const rowsJ = await postInternalJson(
          "/fortnox/upsert/order-rows/flagged",
          { connection_id, limit: cfg.rows.limit, pause_ms: cfg.rows.pause_ms },
          5 * 60 * 1000
        );
        if (!rowsJ.flagged_found) break;
        if (cfg.rows.pause_ms) await sleep(Number(cfg.rows.pause_ms));
      }
      one.order_rows = { ok: true };
    } else if (cfg.rows.passes <= 0) {
      one.order_rows = { skipped: true, reason: "rows.passes=0" };
    }
  } catch (e) {
    one.orders = null;
    one.order_rows = one.order_rows || null;
    one.errors.push({ message: e?.message || String(e), detail: e?.detail || null });
  }
}
      // --- OFFERS + OFFER ROWS (DOCS ONLY) / SKIP WHEN pages_per_call<=0 ---
      if (!allowDocs) {
        one.offers = { skipped: true, reason: "not allowed for orders/offers" };
      } else if (cfg.offers.pages_per_call <= 0) {
        one.offers = { skipped: true, reason: "offers.pages_per_call=0" };
      } else {
        try {
          const startOffers = await getConnNextPage(connection_id, "offers_next_page", 1);

          const offersJ = await postInternalJson(
            "/fortnox/upsert/offers/all",
            {
              connection_id,
              start_page: startOffers,
              limit: cfg.offers.limit,
              max_pages: cfg.offers.pages_per_call
            },
            15 * 60 * 1000
          );

          one.offers = {
            done: !!offersJ.done,
            next_page: offersJ.next_page ?? null,
            counts: offersJ.counts || null
          };

          await safeSetConnPaging(connection_id, {
            offers_next_page: offersJ?.next_page || 1,
            offers_last_progress_at: nowIso(),
            ...(offersJ?.done ? { offers_last_full_sync_at: nowIso() } : {})
          });

          if (cfg.rows.passes > 0) {
            for (let p = 0; p < cfg.rows.passes; p++) {
              const rowsJ = await postInternalJson(
                "/fortnox/upsert/offer-rows/flagged",
                { connection_id, limit: cfg.rows.limit, pause_ms: cfg.rows.pause_ms },
                180000
              );
              if (!rowsJ.flagged_found) break;
              if (cfg.rows.pause_ms) await sleep(Number(cfg.rows.pause_ms));
            }
          }
        } catch (e) {
          one.offers = null;
          one.errors.push({ message: e?.message || String(e), detail: e?.detail || null });
        }
      }

      // --- INVOICES (ALL) — self-heal paging / SKIP WHEN pages_per_call<=0 ---
      if (cfg.invoices.pages_per_call <= 0) {
        one.invoices = { skipped: true, reason: "invoices.pages_per_call=0" };
      } else {
        try {
          let startInv = await getConnNextPage(connection_id, "invoices_next_page", 1);

          const runInvoices = async (start_page) => {
            return await postInternalJson(
              "/fortnox/upsert/invoices/all",
              {
                connection_id,
                start_page,
                limit: cfg.invoices.limit,
                max_pages: cfg.invoices.pages_per_call,
                months_back
              },
              15 * 60 * 1000
            );
          };

          let invoicesJ;
          try {
            invoicesJ = await runInvoices(startInv);
          } catch (e1) {
            const errInfo = extractFortnoxErrorInfo(e1);
            if (errInfo?.code === 2001889) {
              console.warn("[nightly/run] invoices page out of range; resetting to page 1", {
                connection_id, startInv, months_back
              });
              await safeSetConnPaging(connection_id, { invoices_next_page: 1, invoices_last_progress_at: nowIso() });
              invoicesJ = await runInvoices(1);
            } else {
              throw e1;
            }
          }

          one.invoices = {
            done: !!invoicesJ.done,
            next_page: invoicesJ.next_page ?? null,
            counts: invoicesJ.counts || null
          };

          await safeSetConnPaging(connection_id, {
            invoices_next_page: invoicesJ?.next_page || 1,
            invoices_last_progress_at: nowIso(),
            ...(invoicesJ?.done ? { invoices_last_full_sync_at: nowIso() } : {})
          });
        } catch (e) {
          one.invoices = null;
          one.errors.push({ message: e?.message || String(e), detail: e?.detail || null });
        }
      }

      results.push(one);

      if (cfg.customers.pause_ms) await sleep(Number(cfg.customers.pause_ms));
    }

    return res.json({
      ok: true,
      run_id: myRunId,
      months_back,
      config: cfg,
      docs_allowlist: docs_allowlist || String(
        process.env.FORTNOX_DOCS_CONNECTION_IDS ||
        process.env.FORTNOX_ORDERS_CONNECTION_IDS ||
        ""
      ),
      connections: conns.length,
      results
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  } finally {
    if (acquired && lock.run_id === myRunId) {
      lock.running = false;
      lock.finished_at = Date.now();
      console.log("[nightly/run] finished", { run_id: lock.run_id, finished_at: lock.finished_at });
    }
  }
});
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
// Bubble: Matter + MatterMessage

async function findMatterByExternalCaseId(external_case_id) {
  const id = safeText(String(external_case_id || "").trim(), 100);
  if (!id) return null;

  return await bubbleFindOne("Matter", [
    { key: "external_case_id", constraint_type: "equals", value: id }
  ]);
}

async function createMatter(fields) {
  return await bubbleCreate("Matter", fields);
}

async function patchMatter(matterId, fields) {
  return await bubblePatch("Matter", matterId, fields);
}

async function findMatterMessageByGraphId(graph_message_id) {
  const gid = safeText(String(graph_message_id || "").trim(), 300);
  if (!gid) return null;

  return await bubbleFindOne("MatterMessage", [
    { key: "graph_message_id", constraint_type: "equals", value: gid }
  ]);
}

async function createMatterMessage(fields) {
  return await bubbleCreate("MatterMessage", fields);
}

async function patchMatterMessage(messageId, fields) {
  return await bubblePatch("MatterMessage", messageId, fields);
}
// ────────────────────────────────────────────────────────────
// DeDu parsing helpers

function lineValue(body, labelOrLabels) {
  const labels = Array.isArray(labelOrLabels) ? labelOrLabels : [labelOrLabels];

  // Matchar t.ex.
  // "Ärende: 925565"
  // "Ärendenummer: 123456"
  // "Ärende nr: 123456"
  // "Ärende nummer - 123456"
  for (const label of labels) {
    const re = new RegExp(
      `^\\s*${escapeRegExp(label)}\\s*(?:[:\\-]|\\s+)\\s*(.+?)\\s*$`,
      "mi"
    );
    const m = String(body || "").match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePropertyLine(s) {
  // "14170 - Beridarebanan 77" => { code:"14170", name:"Beridarebanan 77" }
  const txt = String(s || "").trim();
  const m = txt.match(/^(\d+)\s*-\s*(.+)$/);
  if (m) return { code: m[1].trim(), name: m[2].trim() };
  return { code: "", name: txt };
}

function parseTenantAddressLine(s) {
  // "Scila AB - Sveavägen 17" => { tenant:"Scila AB", address:"Sveavägen 17" }
  const txt = String(s || "").trim();
  const parts = txt.split(" - ").map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { tenant: parts[0], address: parts.slice(1).join(" - ") };
  return { tenant: txt, address: "" };
}

function extractCaseTitleAndDescription(bodyClean) {
  // Hitta blocket efter "Ärendebeskrivning:" och plocka första raden som title
  const txt = String(bodyClean || "");
  const idx = txt.toLowerCase().indexOf("ärendebeskrivning:");
  if (idx < 0) return { title: "", description: "" };

  const after = txt.slice(idx + "ärendebeskrivning:".length).trim();

  // Skär av vid nästa tydliga sektion (om den finns)
  const stopRe = /\n\s*(Anmält av|Telefon|Mobil|Epost|Datum|Kvitteringsjournal|Slutkvittering|Delkvittens|Internkommentarer|Kundkommentarer)\s*:/i;
  const stop = after.search(stopRe);
  const block = (stop >= 0 ? after.slice(0, stop) : after).trim();

  // title = första icke-tomma raden, description = hela blocket
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const title = lines[0] || "";
  const description = block;

  return { title, description };
}

function normalizePhone(s) {
  return safeText(String(s || "").replace(/[^\d+]/g, ""), 50);
}
// ────────────────────────────────────────────────────────────
// Build Matter + MatterMessage payloads

function buildMatterMessagePatch({
  mailbox_upn,
  matterId,
  msg,
  bodyClean,
  bodyPreview,
  bodyType,
  bodyContent
}) {
  const graphId = String(msg?.id || "").trim();

  const fromEmail =
    normEmail(msg?.from?.emailAddress?.address) ||
    normEmail(msg?.sender?.emailAddress?.address) ||
    "";

  const fromName = safeText(
    msg?.from?.emailAddress?.name || msg?.sender?.emailAddress?.name || "",
    200
  );

  const subject = safeText(msg?.subject || "", 300);
  const receivedAt = msg?.receivedDateTime ? new Date(msg.receivedDateTime) : new Date();

  const toRecipients = Array.isArray(msg?.toRecipients)
    ? msg.toRecipients.map(r => r?.emailAddress?.address).filter(Boolean).join(", ")
    : "";

  const ccRecipients = Array.isArray(msg?.ccRecipients)
    ? msg.ccRecipients.map(r => r?.emailAddress?.address).filter(Boolean).join(", ")
    : "";

  const hasAttachments = !!msg?.hasAttachments;

  // ✅ DeDu: extrahera action-link (Kvittera beställning)
  const action = extractActionLink({
    bodyHtml: String(bodyType || "").toLowerCase() === "html" ? (bodyContent || "") : "",
    bodyText: bodyClean || bodyPreview || ""
  });

  // VIKTIGT: din extractActionLink hittar ofta url med &amp; → gör om till &
  const actionUrl = decodeHtmlEntities(action?.url || "");

  return {
    matter: matterId,
    graph_message_id: safeText(graphId, 400),
    mailbox_upn: safeText(mailbox_upn || "", 200),
    received_at: receivedAt,

    from_email: safeText(fromEmail, 200),
    sender_name: fromName,
    subject,

    body_preview: safeText(bodyPreview || "", 1000),
    body_type: safeText(bodyType || "", 20),
    body_content: safeText(bodyContent || "", 50000),
    body_clean: safeText(bodyClean || "", 50000),

    to_recipients: safeText(toRecipients, 2000),
    cc_recipients: safeText(ccRecipients, 2000),
    has_attachments: hasAttachments,

    // ✅ spara länken per meddelande
    action_link: safeText(actionUrl, 2000),
    action_link_label: safeText(action?.label || "", 200)

    // raw_json: safeText(JSON.stringify(msg), 50000)
  };
}
function buildMatterPatchFromBody({ mailbox_upn, subject, bodyClean, msg, bodyType, bodyContent, bodyPreview }) {
  const external_case_id = lineValue(bodyClean, [
  "Ärende",
  "Ärendenummer",
  "Ärende nr",
  "Ärende nummer"
]);

  const propertyLine = lineValue(bodyClean, "Fastighet");
  const prop = parsePropertyLine(propertyLine);

  const tenantAddrLine = lineValue(bodyClean, "Hyresgäst - Adress");
  const ta = parseTenantAddressLine(tenantAddrLine);

  const contractRef = lineValue(bodyClean, "Avtal - Adress");
  const executor = lineValue(bodyClean, "Utförare");
  const caseType = lineValue(bodyClean, "Ärendetyp");

  const reportedBy = lineValue(bodyClean, "Anmält av");
  const phone = lineValue(bodyClean, "Telefon");
  const mobile = lineValue(bodyClean, "Mobil");
  const email = lineValue(bodyClean, "Epost");
  const dateStr = lineValue(bodyClean, "Datum");

  const { title, description } = extractCaseTitleAndDescription(bodyClean);

  // Datum: "2026-01-27 14:50:29" -> Date (best effort)
  let reportedAt = null;
  if (dateStr) {
    const isoish = dateStr.replace(" ", "T");
    const d = new Date(isoish);
    if (!isNaN(d.getTime())) reportedAt = d;
  }

  const receivedAt = msg?.receivedDateTime ? new Date(msg.receivedDateTime) : new Date();

  // ✅ NYTT: extrahera DeDu action link även på Matter-nivå (senaste kända)
  const action = extractActionLink({
    bodyHtml: String(bodyType || "").toLowerCase() === "html" ? (bodyContent || "") : "",
    bodyText: bodyClean || bodyPreview || ""
  });

  return {
    external_system: "DeDu",
    external_case_id: safeText(external_case_id, 100),
    mailbox_upn: safeText(mailbox_upn || "", 200),

    subject_latest: safeText(subject || "", 300),
    last_message_at: receivedAt,
    latest_graph_message_id: safeText(String(msg?.id || ""), 400),
    ms_conversation_id: safeText(String(msg?.conversationId || ""), 400),

    property_code: safeText(prop.code, 50),
    property_name: safeText(prop.name, 200),
    tenant_name: safeText(ta.tenant, 200),
    tenant_address: safeText(ta.address, 300),

    contract_ref: safeText(contractRef, 200),
    executor: safeText(executor, 200),
    case_type: safeText(caseType, 200),

    case_title: safeText(title, 300),
    case_description_clean: safeText(description, 12000),

    reported_by_name: safeText(reportedBy, 200),
    reported_by_email: safeText(normEmail(email), 200),
    reported_by_phone: safeText(phone, 80),
    reported_by_mobile: safeText(normalizePhone(mobile), 80),

    reported_at: reportedAt || receivedAt,

    raw_body_last: safeText(bodyClean || "", 50000),

    // ✅ NYTT: action link på Matter (senaste)
    action_link: safeText(action?.url || "", 1000),
    action_link_label: safeText(action?.label || "", 200),
    action_link_found_in: safeText(action?.foundIn || "", 20)

    // raw_html_last: ... (om du vill)
  };
}
// ────────────────────────────────────────────────────────────
// POST /jobs/matter/poll
// Body: { mailbox_upn: "test1@carotte.se", auth_user_id: "<bubble user id>", top?: 25, tenant?: "<tenant-id>" }
app.post("/jobs/matter/poll", requireApiKey, async (req, res) => {
  const t0 = Date.now();

  const mailbox_upn = normEmail(req.body?.mailbox_upn);
  const auth_user_id = req.body?.auth_user_id || req.body?.u || null;
  const top = Number(req.body?.top || 25);
  const tenant = resolveTenantFromBodyOrReq(req);

  if (!mailbox_upn) return res.status(400).json({ ok: false, error: "mailbox_upn is required" });
  if (!auth_user_id) return res.status(400).json({ ok: false, error: "auth_user_id is required" });

  let state = null;
  let createdMessages = 0;
  let skippedExistingMessages = 0;
  let mattersCreated = 0;
  let mattersUpdated = 0;
  let errors = 0;
  let first_error = null;
  let sample = []; // debug: visar vad delta faktiskt returnerar

  try {
    // Återanvänd samma state-tabell/typ som du redan har (delta_link per mailbox)
    state = await getOrCreateMailPollState(mailbox_upn);

    const deltaRes = await graphDeltaFetchAll({
      tenant,
      mailbox_upn,
      delta_link: state?.delta_link || "",
      top: Number.isFinite(top) && top > 0 ? top : 25,
      auth_user_id
    });

    const messages = Array.isArray(deltaRes?.messages) ? deltaRes.messages : [];

    for (const msg of messages) {
      // sampleItem måste ligga utanför inner try/catch så vi kan skriva i catch också
      const sampleItem = {
        graph_message_id: String(msg?.id || "").trim(),
        subject: String(msg?.subject || ""),
        receivedDateTime: String(msg?.receivedDateTime || ""),
        from: String(
          msg?.from?.emailAddress?.address ||
          msg?.sender?.emailAddress?.address ||
          ""
        ),
        action: "unknown"
      };

      try {
        const graphId = sampleItem.graph_message_id;

        if (!graphId) {
          skippedExistingMessages++;
          if (sample.length < 5) { sampleItem.action = "skipped_no_graph_id"; sample.push(sampleItem); }
          continue;
        }

        // 1) Idempotens: skapa inte MatterMessage om den redan finns
        const existingMM = await findMatterMessageByGraphId(graphId);
        if (existingMM?._id) {
          skippedExistingMessages++;
          if (sample.length < 5) { sampleItem.action = "skipped_existing_mattermessage"; sample.push(sampleItem); }
          continue;
        }

// 2) Body: använd Graph body om den finns i delta-payload
let bodyType = String(msg?.body?.contentType || "").toLowerCase() || "html";
let bodyContent = String(msg?.body?.content || "");
let bodyPreview = String(msg?.bodyPreview || "");

// Fallback: delta kan sakna full body (vanligt vid VB/FW eller vissa delta-lägen)
// → hämta fulla meddelandet via Graph med message-id
if (!bodyContent && String(msg?.id || "").trim()) {
  const full = await graphGetMessageById({
    tenant,
    mailbox_upn,
    graph_message_id: String(msg.id).trim(),
    auth_user_id
  });

  // Full message kan ha bättre body/preview
  bodyType = String(full?.body?.contentType || bodyType || "").toLowerCase() || "html";
  bodyContent = String(full?.body?.content || bodyContent || "");
  bodyPreview = String(full?.bodyPreview || bodyPreview || "");

  // (Valfritt men bra) ersätt msg så resten av koden använder fulla objektet
  msg = full || msg;
}

const bodyClean = bodyType === "html"
  ? htmlToText(bodyContent)
  : String(bodyContent || "");

        const subject = safeText(msg?.subject || "", 300);

        // 3) Skapa/uppdatera Matter (per external_case_id)
        const matterPatch = buildMatterPatchFromBody({
          mailbox_upn,
          subject,
          bodyClean,
          msg,
          bodyType,
          bodyContent,
          bodyPreview
        });

        const caseId = String(matterPatch.external_case_id || "").trim();
        if (!caseId) {
          skippedExistingMessages++;
          if (sample.length < 5) { sampleItem.action = "skipped_missing_case_id"; sample.push(sampleItem); }
          continue;
        }

        let matter = await findMatterByExternalCaseId(caseId);

        let matterId = null;
        if (!matter?._id) {
          matterId = await createMatter(matterPatch);
          mattersCreated++;
        } else {
          matterId = matter._id;
          await patchMatter(matterId, matterPatch);
          mattersUpdated++;
        }

        // 4) Skapa MatterMessage kopplad till Matter
        const mmFields = buildMatterMessagePatch({
          mailbox_upn,
          matterId,
          msg,
          bodyClean,
          bodyPreview,
          bodyType,
          bodyContent
        });

        await createMatterMessage(mmFields);
        createdMessages++;

        if (sample.length < 5) { sampleItem.action = "created_mattermessage"; sample.push(sampleItem); }

      } catch (e) {
        errors++;
        if (!first_error) first_error = { message: e?.message || String(e), detail: e?.detail || null };

        if (sample.length < 5) {
          sampleItem.action = "error";
          sampleItem.error = e?.message || String(e);
          sample.push(sampleItem);
        }
      }
    }

    // 5) Spara delta_link
    const newDelta = String(deltaRes?.delta_link || "").trim();
    await updateMailPollState(state._id, {
      delta_link: newDelta || state?.delta_link || "",
      last_run_at: new Date().toISOString(),
      last_error: errors ? (state?.last_error || "") : ""
    });

    return res.json({
      ok: true,
      mailbox_upn,
      tenant,
      auth_user_id,
      processed: messages.length,
      counts: {
        matter_messages_created: createdMessages,
        matter_messages_skipped_existing: skippedExistingMessages,
        matters_created: mattersCreated,
        matters_updated: mattersUpdated,
        errors
      },
      first_error,
      sample,
      ms: Date.now() - t0
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      mailbox_upn,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }
});
// ────────────────────────────────────────────────────────────
// HTML → text (för Lead.Description m.m.)
// (Använder befintlig decodeHtmlEntities() som redan finns i din fil)
function htmlToText(input, { maxLen = 8000 } = {}) {
  if (input == null) return "";
  let s = String(input);

  s = s.replace(/\r\n/g, "\n");

  // Ta bort Outlook mobile signature-block om det finns
  s = s.replace(/<div[^>]+id=["']ms-outlook-mobile-signature["'][\s\S]*?<\/div>/gi, "");

  // Byt ut radbrytande taggar → \n
  s = s
    .replace(/<(br|br\/)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<\/td>/gi, "  ");

  // Ta bort scripts/styles
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Ta bort alla övriga taggar
  s = s.replace(/<[^>]+>/g, "");

  // Decode entities (din befintliga funktion)
  s = decodeHtmlEntities(s);

  // Städa whitespace
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Klipp längd
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen - 1).trim() + "…";
  return s;
}
// ────────────────────────────────────────────────────────────
// Render-first Mail Polling (Graph delta) → Bubble Data API
// Bubble types (EXACT):
//  - MailPollState: mailbox_upn (text), delta_link (text), last_run_at (date), last_error (text)
//  - InboundEmail : graph_message_id (text), mailbox_upn (text), from_email (text), received_at (date), subject (text), lead (Lead)
//  - Lead         : Name (text), Email (text), Phone (text), Company (text), Description (text)

// Small helpers
const normEmail = (s) => String(s || "").trim().toLowerCase();
const safeText = (s, max = 5000) => {
  const t = String(s || "").replace(/\u0000/g, "").trim();
  return t.length > max ? t.slice(0, max) : t;
};

function resolveTenantFromBodyOrReq(req) {
  // Prefer body.tenant, then header/query, else your existing DEFAULT_TENANT
  return pick(
    req.body?.tenant,
    req.query?.tenant,
    req.headers["x-tenant-id"],
    DEFAULT_TENANT
  );
}
function guessCompanyFromEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return "";

  // plocka domän
  let domain = e.split("@").pop() || "";
  domain = domain.replace(/^mail\./, "").replace(/^m\./, "").replace(/^smtp\./, "");

  // om det är en vanlig privat maildomän -> lämna tomt
  const publicDomains = new Set([
    "gmail.com","googlemail.com","icloud.com","me.com",
    "outlook.com","hotmail.com","live.com","msn.com",
    "yahoo.com","yahoo.se",
    "proton.me","protonmail.com",
    "aol.com",
    "telia.com","telia.se","comhem.se","bahnhof.se",
    "bredband.net","ownit.se"
  ]);
  if (publicDomains.has(domain)) return "";

  // ta "företagsnamn" från domänen (första labeln)
  const label = (domain.split(".")[0] || "").trim();
  if (!label) return "";

  // lite snyggare display
  const pretty = label
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return pretty ? (pretty.charAt(0).toUpperCase() + pretty.slice(1)) : "";
}
function extractPhoneNumber(input) {
  const s = String(input || "");
  if (!s) return "";

  // Leta efter något som liknar ett telefonnummer (svenskt + internationellt)
  // Ex: 070-123 45 67, +46 70 123 45 67, 08-123456, 031 840850
  const m = s.match(/(\+?\d[\d\s().-]{6,}\d)/);
  if (!m) return "";

  let raw = m[1];

  // Rensa bort allt utom siffror och + i början
  raw = raw.replace(/[^\d+]/g, "");

  // Normalisera "00" -> "+"
  if (raw.startsWith("00")) raw = "+" + raw.slice(2);

  // Om den börjar med +, behåll + och siffror
  if (raw.startsWith("+")) {
    // säkerhetsklipp
    return raw.slice(0, 20);
  }

  // Annars: bara siffror, klipp rimligt
  const digits = raw.replace(/\D/g, "");
  return digits.slice(0, 20);
}
// -------------------------
// Bubble: MailPollState
async function getOrCreateMailPollState(mailbox_upn) {
  const mb = normEmail(mailbox_upn);
  if (!mb) throw new Error("mailbox_upn is required");

  const existing = await bubbleFindOne("MailPollState", [
    { key: "mailbox_upn", constraint_type: "equals", value: mb }
  ]);

  if (existing?._id) return existing;

  const id = await bubbleCreate("MailPollState", {
    mailbox_upn: mb,
    delta_link: "",
    last_run_at: new Date().toISOString(),
    last_error: ""
  });

  const created = await bubbleGet("MailPollState", id);
  return created;
}

async function updateMailPollState(id, patch) {
  if (!id) throw new Error("updateMailPollState: missing id");
  if (!patch || typeof patch !== "object") return;

  // Bubble kan ge 400 "Unrecognized field: X" om datatypen saknar fältet.
  // Vi gör därför en liten "self-heal": droppa okända fält och försök igen 1 gång.
  const attempt = async (p) => bubblePatch("MailPollState", id, p);

  let r = await attempt(patch);
  if (r?.ok) return r;

  const msg = r?.detail?.body?.body?.message || r?.detail?.body?.message || "";
  const m = String(msg).match(/Unrecognized field:\s*([A-Za-z0-9_]+)/);
  if (m?.[1]) {
    const bad = m[1];
    const p2 = { ...patch };
    delete p2[bad];
    if (Object.keys(p2).length === 0) return r;
    const r2 = await attempt(p2);
    return r2;
  }
  return r;
}

// -------------------------
// Bubble: InboundEmail (idempotens)
async function findInboundEmailByMessageId(mailbox_upn, graph_message_id) {
  const mb = normEmail(mailbox_upn);
  const mid = String(graph_message_id || "").trim();
  if (!mb || !mid) return null;

  const existing = await bubbleFindOne("InboundEmail", [
    { key: "mailbox_upn", constraint_type: "equals", value: mb },
    { key: "graph_message_id", constraint_type: "equals", value: mid }
  ]);

  return existing || null;
}

async function createInboundEmail(mailbox_upn, msg) {
  const from_email = normEmail(msg?.from?.emailAddress?.address || msg?.sender?.emailAddress?.address || "");
  const subject = safeText(msg?.subject || "", 500);
  const received_at = msg?.receivedDateTime || null;
  const graph_message_id = String(msg?.id || "");

  // Raw body fields (for debugging + better parsing later)
  const body_preview = safeText(msg?.bodyPreview || "", 5000);
  const body_type = safeText(msg?.body?.contentType || "", 50);
  const body_content = safeText(msg?.body?.content || "", 50000);

  const payload = {
    mailbox_upn: normEmail(mailbox_upn),
    from_email,
    subject,
    received_at,
    graph_message_id,
    body_preview,
    body_type,
    body_content
  };

  const id = await bubbleCreate("InboundEmail", payload);
  return id;
}

// -------------------------
// Lead parsing (enkelt men robust)
// ---- Lead extraction + normalization (email -> Lead)

// Convert raw HTML/text body into readable plain text (keep it robust and not too aggressive)
function normalizeMailBodyToText({ contentType, content, fallbackPreview }) {
  const ct = String(contentType || "").toLowerCase();
  let raw = String(content || "");

  // Prefer full body if present, else fallback to preview
  if (!raw.trim()) raw = String(fallbackPreview || "");

  let txt = raw;
  if (ct === "html" || /<\w+[^>]*>/.test(raw)) {
    txt = htmlToText(raw);
  }

  // Normalize whitespace
  txt = txt.replace(/\r\n/g, "\n");
  txt = txt.replace(/[\t\f\v]+/g, " ");
  txt = txt.replace(/\n{3,}/g, "\n\n");
  return txt.trim();
}

function stripCommonSignature(text) {
  const t = String(text || "");
  if (!t) return "";

  const markers = [
    "Vänliga hälsningar",
    "Med vänlig hälsning",
    "Med vänliga hälsningar",
    "Mvh",
    "MVH",
    "Regards",
    "Best regards",
    "Kind regards",
    "Sent from my",
    "Skickat från",
    "--"
  ];

  // Cut at first marker occurrence that is not too early
  let cutAt = -1;
  for (const mk of markers) {
    const i = t.indexOf(mk);
    if (i >= 0) {
      if (cutAt === -1 || i < cutAt) cutAt = i;
    }
  }

  if (cutAt >= 0 && cutAt > 40) {
    return t.slice(0, cutAt).trim();
  }
  return t.trim();
}

function pickFirstRealEmail(text, mailbox_upn) {
  const hay = String(text || "");
  const mb = normEmail(mailbox_upn);
  const matches = hay.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const e of matches) {
    const ne = normEmail(e);
    if (!ne) continue;
    // Avoid picking the shared mailbox address itself
    if (mb && ne === mb) continue;
    return ne;
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// Extract fields for new Lead based on inbound email
function extractLeadFieldsFromMessage(msg) {
  if (!msg) return {};

  const subject = safeText(msg?.subject || "", 300);
  const bodyPreview = msg?.bodyPreview || "";
  const bodyContent = msg?.body?.content || "";
  const bodyType = msg?.body?.contentType || "";
  const fromEmail = normEmail(msg?.from?.emailAddress?.address);
  const fromName = safeText(msg?.from?.emailAddress?.name || "", 200);

  // Clean up the HTML body to readable text
  const core =
    bodyType === "html"
      ? decodeHtmlEntities(
          bodyContent
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<\/?[^>]+(>|$)/g, " ")
        )
      : decodeHtmlEntities(bodyContent || bodyPreview || "");

  const description = safeText(core, 8000);
  const name = fromName || fromEmail?.split("@")[0] || "Okänd";
  const company = guessCompanyFromEmail(fromEmail);
  const leadEmail = fromEmail || "";
  const phone = extractPhoneNumber(core);

  // Short description = body_preview (or fallback) – tightened & clean
  const description_short = tightenShort(bodyPreview || core, 220);

  return {
    Name: name,
    Email: leadEmail,
    Phone: phone,
    Company: company,
    Description: description,
    Description_short: description_short,
    // Option set value (Display) – assumes Lead has field "Source" (type: lead_source)
    Source: "info@carotte.se"
  };
}

// ────────────────────────────────────────────────────────────
// Helper: clean up and shorten description text
function tightenShort(str, maxLen = 220) {
  if (!str) return "";
  return safeText(String(str), maxLen * 3)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?p[^>]*>/gi, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}
// Bubble: Create NEW Lead for every inbound (no upsert)
async function createLeadAlways(fields) {
  const email = normEmail(fields?.Email);
  if (!email) return { ok: false, error: "Lead Email missing" };

  const base = {
    Name: safeText(fields?.Name || "", 200),
    Email: email,
    Phone: safeText(fields?.Phone || "", 100),
    Company: safeText(fields?.Company || "", 200),

    // Långa beskrivningen (som du redan bygger)
    Description: safeText(fields?.Description || "", 8000),

    // Kort beskrivning (du bad om body_preview -> Description_short)
    Description_short: safeText(fields?.Description_short || "", 500),

    // Option set "lead_source" - sätt displayvärdet exakt som i option set
    Source: safeText(fields?.Source || "info@carotte.se", 200),
  };

  const id = await bubbleCreate("Lead", base);
  return { ok: true, lead_id: id, created: true };
}
// -------------------------
// Graph: delta fetch (delegated) with pagination
async function graphDeltaFetchAll({ tenant, mailbox_upn, delta_link, top = 25, auth_user_id }) {
  const mailbox = normEmail(mailbox_upn);
  if (!mailbox) throw new Error("mailbox_upn is required");
  if (!auth_user_id) throw new Error("auth_user_id is required for delegated mail polling");

  // ✅ DELEGATED token (from Bubble user)
  const tok = await getDelegatedTokenForUser(auth_user_id, {
    tenant: tenant || MS_TENANT,
    scope: MS_SCOPE
  });

  const token = tok.access_token;

  let url = delta_link && String(delta_link).trim()
    ? String(delta_link).trim()
    : `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages/delta?$top=${encodeURIComponent(top)}&$select=id,receivedDateTime,subject,from,sender,bodyPreview,body`;

  const all = [];
  let next = null;
  let finalDelta = null;

  while (true) {
    const data = await graphFetch("GET", url, token);

    const value = Array.isArray(data?.value) ? data.value : [];
    all.push(...value);

    next = data?.["@odata.nextLink"] || null;
    finalDelta = data?.["@odata.deltaLink"] || finalDelta;

    if (next) {
      url = next;
      continue;
    }
    break;
  }

  return { messages: all, delta_link: finalDelta || "" };
}

// Fetch a single message (full body) by Graph message id
async function graphGetMessageById({ tenant, mailbox_upn, message_id, auth_user_id }) {
  const mb = encodeURIComponent(String(mailbox_upn || "").trim());
  const mid = encodeURIComponent(String(message_id || "").trim());
  if (!mb) throw new Error("mailbox_upn required");
  if (!mid) throw new Error("message_id required");

  const url = `https://graph.microsoft.com/v1.0/users/${mb}/messages/${mid}?$select=id,receivedDateTime,subject,from,sender,bodyPreview,body`;
  return await graphDelegatedFetchJson({ tenant, auth_user_id, url });
}

// Delegated Graph fetch with one refresh+retry on 401
async function graphDelegatedFetchJson({ tenant, auth_user_id, url, method = "GET", headers = {}, body = null }) {
  const tok = await getDelegatedTokenForUser(auth_user_id, { tenant });
  const doFetch = async (accessToken) => {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...headers
      },
      body
    });
    const text = await r.text().catch(() => "");
    let j = null
    try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
    return { r, j };
  };

  // First try
  let out = await doFetch(tok.access_token);

  // If token expired/invalid, try refresh once and retry
  if (out.r.status === 401 && tok.refresh_token) {
    const ref = await tokenExchange({
      refresh_token: tok.refresh_token,
      scope: tok.scope || MS_SCOPE,
      tenant: tenant || MS_TENANT
    });

    if (ref.ok) {
      const newRefresh = ref.data.refresh_token || tok.refresh_token;
      await upsertTokensToBubble(auth_user_id, ref.data, newRefresh);
      out = await doFetch(ref.data.access_token);
    }
  }

  if (!out.r.ok) {
    const err = new Error(`Graph ${method} ${url} failed ${out.r.status}`);
    err.detail = out.j;
    throw err;
  }

  return out.j;
}
// ────────────────────────────────────────────────────────────
// Routes: Jobs
function isMsTokenExpiredError(e) {
  const msg = String(e?.message || "").toLowerCase();
  const innerMsg = String(e?.detail?.error?.message || "").toLowerCase();
  return (
    e?.status === 401 ||
    msg.includes("failed 401") ||
    msg.includes("token is expired") ||
    innerMsg.includes("token is expired") ||
    innerMsg.includes("lifetime validation failed") ||
    innerMsg.includes("invalidauthenticationtoken")
  );
}

// Hämtar delegated token för auth_user_id från Bubble och refreshar vid behov
async function getDelegatedAccessTokenForUser({ auth_user_id, tenant, force_refresh = false }) {
  const u = await fetchBubbleUser(auth_user_id);
  const accessToken = u?.ms_access_token || null;
  const refreshToken = u?.ms_refresh_token || null;
  const scope = u?.ms_scope || u?.scope || null;

  if (!refreshToken) {
    const err = new Error("User has no ms_refresh_token in Bubble (cannot refresh)");
    err.status = 401;
    throw err;
  }

  if (accessToken && !force_refresh) {
    return { access_token: accessToken, refresh_token: refreshToken, scope };
  }

  const ref = await tokenExchange({ refresh_token: refreshToken, scope, tenant });
  if (!ref.ok) {
    const err = new Error("Delegated refresh failed");
    err.status = ref.status || 401;
    err.detail = ref.data || null;
    throw err;
  }

  const newRefresh = ref.data.refresh_token || refreshToken;
  await upsertTokensToBubble(auth_user_id, ref.data, newRefresh);

  return { access_token: ref.data.access_token, refresh_token: newRefresh, scope: ref.data.scope || scope };
}

// Hämtar inbox-messages via delta och följer ev. paging (nextLink)
async function graphMailDeltaFetchAll({ mailbox_upn, top, delta_link, access_token }) {
  const mailboxEnc = encodeURIComponent(String(mailbox_upn).trim().toLowerCase());

  // Start-URL: antingen delta_link (om vi har) eller första delta-call
  let url = (delta_link && String(delta_link).trim())
    ? String(delta_link).trim()
    : `${GRAPH_BASE}/users/${mailboxEnc}/mailFolders('Inbox')/messages/delta?$top=${encodeURIComponent(String(top || 25))}`
      + `&$select=id,receivedDateTime,subject,from,sender,bodyPreview,body`;

  const messages = [];
  let safety = 0;
  let finalDelta = "";

  while (url && safety < 20) { // säkerhetsbälte
    safety++;

    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + access_token }
    });
    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      const err = new Error(`Graph GET ${url} failed ${r.status}`);
      err.status = r.status;
      err.detail = j;
      throw err;
    }

    if (Array.isArray(j?.value)) messages.push(...j.value);

    // nästa sida eller deltaLink
    url = j["@odata.nextLink"] || "";
    finalDelta = j["@odata.deltaLink"] || finalDelta || "";
  }

  return { messages, delta_link: finalDelta };
}
// POST /jobs/mail/poll
// Body: { mailbox_upn:"info@carotte.se", auth_user_id:"<Bubble user id>", top?:25 }
app.post("/jobs/mail/poll", requireApiKey, async (req, res) => {
  const t0 = Date.now();

  const mailbox_upn = normEmail(req.body?.mailbox_upn);
  const auth_user_id =
    req.body?.auth_user_id ||
    req.body?.user_unique_id ||
    req.body?.u ||
    null;

  const top = Number(req.body?.top || 25);
  const tenant = resolveTenantFromBodyOrReq(req);

  if (!mailbox_upn) {
    return res.status(400).json({ ok: false, error: "mailbox_upn is required" });
  }
  if (!auth_user_id) {
    return res.status(400).json({ ok: false, error: "auth_user_id is required (Bubble user id that owns delegated token)" });
  }

  let state = null;
  let createdInbound = 0;
  let skippedInbound = 0;
  let createdLeads = 0;
  let updatedLeads = 0;
  let linked = 0;
  let errors = 0;
  let first_error = null;

  try {
    state = await getOrCreateMailPollState(mailbox_upn);

    // 1) Hämta delta (med auto-refresh + retry på 401 expired)
    let deltaRes = null;

    const runDelta = async ({ force_refresh = false } = {}) => {
      const tok = await getDelegatedAccessTokenForUser({ auth_user_id, tenant, force_refresh });
      return await graphMailDeltaFetchAll({
        tenant,
        mailbox_upn,
        delta_link: state?.delta_link || "",
        top: Number.isFinite(top) && top > 0 ? top : 25,
        access_token: tok.access_token
      });
    };

    try {
      deltaRes = await runDelta({ force_refresh: false });
    } catch (e) {
      // om expired → refresh + retry EN gång
      if (isMsTokenExpiredError(e)) {
        deltaRes = await runDelta({ force_refresh: true });
      } else {
        // om delta-state invalid (Graph 410 m.fl.) → spara fel och fail denna körning
        await updateMailPollState(state._id, {
          last_run_at: new Date().toISOString(),
          last_error: "Delta fetch failed: " + (e?.message || String(e))
        });
        throw e;
      }
    }

    const messages = Array.isArray(deltaRes?.messages) ? deltaRes.messages : [];

    // 2) Processa varje message idempotent via InboundEmail
    for (const msg of messages) {
      try {
        const graphId = String(msg?.id || "").trim();
        if (!graphId) { skippedInbound++; continue; }

        const existingInbound = await findInboundEmailByMessageId(mailbox_upn, graphId);
        if (existingInbound?._id) {
          skippedInbound++;
          continue;
        }

        // (Optional but recommended) fetch full message body again by id (delta can be truncated)
        let fullMsg = msg;
        try {
          fullMsg = await graphGetMessageById({ tenant, mailbox_upn, message_id: graphId, auth_user_id });
        } catch (e) {
          // If this fails, we still create the inbound from delta payload
          fullMsg = msg;
        }

        const inboundId = await createInboundEmail(mailbox_upn, fullMsg);
        createdInbound++;

        // Lead upsert
        const leadFields = extractLeadFieldsFromMessage(fullMsg, mailbox_upn);
        if (leadFields?.Email) {
          const up = await createLeadAlways(leadFields);
if (up.ok && up.lead_id) {
  createdLeads++; // alltid ny
  await bubblePatch("InboundEmail", inboundId, { lead: up.lead_id });
  linked++;
}
        }
      } catch (e) {
        errors++;
        if (!first_error) first_error = { message: e?.message || String(e), detail: e?.detail || null };
      }
    }

    // 3) Spara ny delta_link + last_run_at
    const newDelta = String(deltaRes?.delta_link || "").trim();
    await updateMailPollState(state._id, {
      delta_link: newDelta || state?.delta_link || "",
      last_run_at: new Date().toISOString(),
      last_error: errors ? (state?.last_error || "") : ""
    });

    return res.json({
      ok: true,
      mailbox_upn,
      tenant,
      auth_user_id,
      processed: messages.length,
      counts: {
        inbound_created: createdInbound,
        inbound_skipped_existing: skippedInbound,
        leads_created: createdLeads,
        leads_updated_or_appended: updatedLeads,
        inbound_linked_to_lead: linked,
        errors
      },
      first_error,
      ms: Date.now() - t0
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      mailbox_upn,
      error: e?.message || String(e),
      detail: e?.detail || null
    });
  }
});


// POST /jobs/mail/message
// Body: { mailbox_upn, auth_user_id, graph_message_id, inbound_id?: "<Bubble InboundEmail id>" }
// Fetches a single message from Graph and (optionally) patches the Bubble InboundEmail with raw body fields.
app.post("/jobs/mail/message", requireApiKey, async (req, res) => {
  const mailbox_upn = normEmail(req.body?.mailbox_upn);
  const auth_user_id = req.body?.auth_user_id || req.body?.user_unique_id || req.body?.u || null;
  const graph_message_id = String(req.body?.graph_message_id || "").trim();
  const inbound_id = String(req.body?.inbound_id || "").trim();
  const tenant = resolveTenantFromBodyOrReq(req);

  if (!mailbox_upn) return res.status(400).json({ ok: false, error: "mailbox_upn is required" });
  if (!auth_user_id) return res.status(400).json({ ok: false, error: "auth_user_id is required" });
  if (!graph_message_id) return res.status(400).json({ ok: false, error: "graph_message_id is required" });

  try {
    const msg = await graphGetMessageById({ tenant, mailbox_upn, message_id: graph_message_id, auth_user_id });

    const patch = {
      body_preview: safeText(msg?.bodyPreview || "", 5000),
      body_type: safeText(msg?.body?.contentType || "", 50),
      body_content: safeText(msg?.body?.content || "", 50000)
    };

    if (inbound_id) {
      await bubblePatch("InboundEmail", inbound_id, patch);
    }

    return res.json({
      ok: true,
      mailbox_upn,
      auth_user_id,
      graph_message_id,
      inbound_id: inbound_id || null,
      patch,
      sample: {
        subject: safeText(msg?.subject || "", 500),
        receivedDateTime: msg?.receivedDateTime || null,
        from: msg?.from?.emailAddress?.address || null
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, mailbox_upn, graph_message_id, error: e?.message || String(e), detail: e?.detail || null });
  }
});

// GET /jobs/mail/status?mailbox_upn=info@carotte.se
app.get("/jobs/mail/status", requireApiKey, async (req, res) => {
  try {
    const mailbox_upn = normEmail(req.query?.mailbox_upn);
    if (!mailbox_upn) return res.status(400).json({ ok: false, error: "mailbox_upn is required" });

    const existing = await bubbleFindOne("MailPollState", [
      { key: "mailbox_upn", constraint_type: "equals", value: mailbox_upn }
    ]);

    return res.json({ ok: true, mailbox_upn, state: existing || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
  }
});

// POST /jobs/mail/reset { mailbox_upn: "info@carotte.se" }
app.post("/jobs/mail/reset", requireApiKey, async (req, res) => {
  try {
    const mailbox_upn = normEmail(req.body?.mailbox_upn);
    if (!mailbox_upn) return res.status(400).json({ ok: false, error: "mailbox_upn is required" });

    const st = await getOrCreateMailPollState(mailbox_upn);
    await updateMailPollState(st._id, {
      delta_link: "",
      last_run_at: new Date().toISOString(),
      last_error: ""
    });

    return res.json({ ok: true, mailbox_upn, reset: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
  }
});
// Microsoft helpers / routes (din befintliga kod – oförändrad)
function buildAuthorizeUrl({ user_id, redirect }) {
  const authBase = "https://login.microsoftonline.com/" + MS_TENANT + "/oauth2/v2.0/authorize";
  const url = new URL(authBase);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MS_SCOPE);
  url.searchParams.set("redirect_uri", redirect || REDIRECT_URI);
  if (user_id) url.searchParams.set("state", "u:" + user_id);
  return url.toString();
}

app.post("/ms/auth", async (req, res) => {
  try {
    const { user_id, u, redirect } = req.body || {};
    const uid = user_id || u;
    log("[/ms/auth] incoming body", req.body);
    if (!uid) return res.status(400).json({ error: "Missing user_id" });

    const cleanRedirect = normalizeRedirect(redirect || REDIRECT_URI);
    const url = buildAuthorizeUrl({ user_id: uid, redirect: cleanRedirect });

    log("[/ms/auth] → built url", {
      have_clientId: !!CLIENT_ID,
      redirect: cleanRedirect
    });
    res.json({ ok: true, url });
  } catch (err) {
    console.error("[/ms/auth] error", err);
    res.status(500).json({ error: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// Fortnox-lik OAuth-flöde (Render äger callbacken)
// - /ms/authorize redirectar till Microsoft
// - /ms/callback tar emot code, växlar token och sparar direkt i Bubble (User)
// OBS: du måste lägga till redirect URI i Azure App Registration:
//      https://mira-exchange.onrender.com/ms/callback   (och ev din api-subdomän senare)
function publicBaseFromReq(req) {
  // Render/Cloudflare kan sätta X-Forwarded-*; vi bygger en stabil "public base"
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"]  || req.get("host") || "").toString().split(",")[0].trim();
  if (!host) return null;
  return `${proto}://${host}`;
}

app.get("/ms/authorize", async (req, res) => {
  try {
    const userId = pick(req.query.user_unique_id, req.query.u, req.query.user_id);
    if (!userId) return res.status(400).send("Missing user id (?u=... or ?user_unique_id=...)");

    const base = publicBaseFromReq(req) || pick(process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL);
    if (!base) return res.status(500).send("Could not determine public base url");

    const redirectUri = normalizeRedirect(`${base}/ms/callback`);

    // stöd även custom scopes om du vill, annars tar vi MS_SCOPE (som du redan använder)
    const scope = pick(req.query.scope, MS_SCOPE);

    const authBase = "https://login.microsoftonline.com/" + MS_TENANT + "/oauth2/v2.0/authorize";
    const url = new URL(authBase);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", scope);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", "u:" + userId);

    // valfritt: efter success kan du skicka användaren tillbaka till Bubble
    const next = pick(req.query.next, req.query.redirect_after);
    if (next) url.searchParams.set("state", "u:" + userId + "|next:" + encodeURIComponent(next));

    return res.redirect(url.toString());
  } catch (e) {
    console.error("[/ms/authorize] error", e);
    res.status(500).send(e.message || "error");
  }
});

app.get("/ms/callback", async (req, res) => {
  try {
    const code  = req.query.code;
    const state = String(req.query.state || "");
    if (!code) return res.status(400).send("Missing code");

    // state: "u:<bubbleUserId>" eller "u:<id>|next:<urlencoded>"
    const m = state.match(/^u:([^|]+)(?:\|next:(.+))?$/);
    const userId = m?.[1] || null;
    const next = m?.[2] ? decodeURIComponent(m[2]) : null;
    if (!userId) return res.status(400).send("Missing/invalid state");

    const base = publicBaseFromReq(req) || pick(process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL);
    const redirectUri = normalizeRedirect(`${base}/ms/callback`);

    const result = await tokenExchange({ code, redirect_uri: redirectUri });

    if (!result.ok) {
      return res.status(400).send("Token exchange failed: " + (result.data?.error_description || result.data?.error || "unknown"));
    }

    const saved = await upsertTokensToBubble(userId, result.data, null);
    if (!saved) return res.status(502).send("Bubble save failed");

    // Om du skickar ?next=... kan du landa tillbaka i Bubble
    if (next) return res.redirect(next);

    // annars visa en enkel OK-sida
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<html><body><h3>Microsoft connected ✅</h3><p>User: ${escapeHtml(userId)}</p><p>Du kan stänga detta fönster.</p></body></html>`);
  } catch (e) {
    console.error("[/ms/callback] error", e);
    res.status(500).send(e.message || "error");
  }
});


/** Exchange CODE or REFRESH TOKEN and save to Bubble */
app.post("/ms/refresh-save", async (req, res) => {
  const {
    user_unique_id,
    u,
    refresh_token,
    code,
    scope: incomingScope,
    tenant,
    redirect
  } = req.body || {};

  const userId = user_unique_id || u;

  log("[/ms/refresh-save] hit", {
    auth: BUBBLE_API_KEY ? "ok" : "missing",
    has_body: !!req.body,
    has_code: !!code,
    has_refresh_token: !!refresh_token,
    has_user: !!userId,
    has_scope: !!incomingScope
  });

  if (!userId) return res.status(400).json({ error: "Missing user id (u or user_unique_id)" });

  try {
    const result = await tokenExchange({
      code,
      refresh_token,
      scope: incomingScope,
      tenant,
      redirect_uri: normalizeRedirect(redirect || REDIRECT_URI)
    });

    log("[/ms/refresh-save] ms token response", {
      ok: result.ok,
      status: result.status,
      has_access_token: !!result.data?.access_token,
      has_refresh_token: !!result.data?.refresh_token
    });

    if (!result.ok) {
      const j = result.data || {};
      logMsTokenError("/ms/refresh-save", result, {
        sent: {
          have_code: !!code,
          have_refresh_token: !!refresh_token,
          redirect_used: normalizeRedirect(redirect || REDIRECT_URI),
          scope_used: incomingScope || MS_SCOPE,
          tenant_used: tenant || MS_TENANT
        }
      });

      return res.status(400).json({
        ok: false,
        stage: "token_exchange",
        status: result.status,
        ms_error: j.error,
        ms_error_description: j.error_description,
        sent: {
          have_code: !!code,
          have_refresh_token: !!refresh_token,
          redirect_used: normalizeRedirect(redirect || REDIRECT_URI),
          scope_used: incomingScope || MS_SCOPE,
          tenant_used: tenant || MS_TENANT
        }
      });
    }

    const saved = await upsertTokensToBubble(userId, result.data, result.data.refresh_token || refresh_token);
if (!saved?.ok) return res.status(502).json({ ok: false, error: "Bubble save failed", detail: saved });

    return res.json({
      ok: true,
      saved_for_user: userId,
      access_token: result.data.access_token || null,
      refresh_token: result.data.refresh_token || refresh_token || null,
      expires_in: result.data.expires_in || null,
      scope: result.data.scope || incomingScope || null,
      token_type: result.data.token_type || "Bearer",
      access_token_preview: (result.data.access_token || "").slice(0, 12) + "..."
    });

  } catch (err) {
    console.error("[/ms/refresh-save] error", err);
    res.status(500).json({ error: err.message });
  }
});

// CREATE EVENT (med stöd för room_email / resource-attendee)
app.post("/ms/create-event", async (req, res) => {
  const {
    user_unique_id,
    attendees_emails,
    event,
    ms_access_token,
    ms_refresh_token,
    room_email
  } = req.body || {};

  log("[/ms/create-event] hit", {
    has_user: !!user_unique_id,
    has_event: !!event,
    attendees_count: Array.isArray(attendees_emails)
      ? attendees_emails.length
      : (typeof attendees_emails === "string" && attendees_emails.trim()
          ? attendees_emails.split(",").length
          : 0),
    body_has_access: !!ms_access_token,
    body_has_refresh: !!ms_refresh_token,
    has_room_email: !!room_email
  });

  if (!user_unique_id || !event) {
    return res.status(400).json({ error: "Missing user_unique_id or event" });
  }

  try {
    let accessToken = ms_access_token || null;
    let refreshToken = ms_refresh_token || null;
    let scope = null;

    if (!accessToken || !refreshToken) {
      const u = await fetchBubbleUser(user_unique_id);
      log("[/ms/create-event] user snapshot", {
        has_response: !!u,
        has_ms_access_token: !!u?.ms_access_token,
        has_ms_refresh_token: !!u?.ms_refresh_token,
        scope: u?.ms_scope ? u.ms_scope.split(" ").slice(0,3).join(" ") + "…" : null
      });
      const dbAccess = u?.ms_access_token || null;
      const dbRefresh = u?.ms_refresh_token || null;
      scope = u?.ms_scope || u?.scope || null;

      accessToken = accessToken || dbAccess || null;
      refreshToken = refreshToken || dbRefresh || null;
    }

    if (!accessToken && refreshToken) {
      const ref = await tokenExchange({ refresh_token: refreshToken, scope });
      log("[/ms/create-event] auto-refresh", { ok: ref.ok, status: ref.status });
      if (ref.ok) {
        accessToken = ref.data.access_token;
        const newRefresh = ref.data.refresh_token || refreshToken;
        await upsertTokensToBubble(user_unique_id, ref.data, newRefresh);
      }
    }

    if (!accessToken) {
      return res.status(401).json({ error: "User has no ms_access_token (and refresh missing/failed)" });
    }

    const normalizedAttendees = [];
    const seen = new Set();
    const push = (raw, type = "required") => {
      const e = String(raw || "").trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      normalizedAttendees.push({
        emailAddress: { address: e },
        type
      });
    };

    const allAtt =
      Array.isArray(attendees_emails) ? attendees_emails :
      typeof attendees_emails === "string" ? attendees_emails.split(",") :
      Array.isArray(event?.attendees_emails) ? event.attendees_emails :
      typeof event?.attendees_emails === "string" ? event.attendees_emails.split(",") :
      [];
    allAtt.forEach(e => push(e, "required"));

    const roomEmailFromEvent =
      event?.room_email ||
      event?.location_email ||
      event?.locationEmailAddress ||
      null;
    const roomEmail = room_email || roomEmailFromEvent || null;

    if (roomEmail) {
      push(roomEmail, "resource");
    }

    const tzInput = event?.tz || event?.start?.timeZone || "Europe/Stockholm";
    const ev = {
      subject: event?.subject || "Untitled event",
      body: {
        contentType: "HTML",
        content: event?.body_html || "",
      },
      start: {
        dateTime: toGraphDateTime(
          event?.start_iso_local ||
          event?.start?.dateTime ||
          fixDateTime(event?.start_iso_local)
        ),
        timeZone: toWindowsTz(tzInput),
      },
      end: {
        dateTime: toGraphDateTime(
          event?.end_iso_local ||
          event?.end?.dateTime ||
          fixDateTime(event?.end_iso_local)
        ),
        timeZone: toWindowsTz(tzInput),
      },
      location: {
        displayName: event?.location_name || event?.location?.displayName || "",
        locationEmailAddress: roomEmail || roomEmailFromEvent || undefined
      },
      isOnlineMeeting: true,
      allowNewTimeProposals: true,
      onlineMeetingProvider: "teamsForBusiness",
    };
    if (normalizedAttendees.length > 0) ev.attendees = normalizedAttendees;

    const graphRes = await fetch(GRAPH_BASE + "/me/events", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ev),
    });
    const graphData = await graphRes.json().catch(() => ({}));

    log("[/ms/create-event] graph response", {
      ok: graphRes.ok,
      status: graphRes.status,
      id: graphData?.id,
      webLink: graphData?.webLink,
      hasOnline: !!graphData?.onlineMeeting,
      joinUrl: (graphData?.onlineMeeting && graphData.onlineMeeting.joinUrl) || graphData?.onlineMeetingUrl,
      error: !graphRes.ok ? graphData?.error : undefined,
      tzSent: ev?.start?.timeZone,
      startSent: ev?.start?.dateTime,
      endSent: ev?.end?.dateTime,
    });

    if (!graphRes.ok) {
      return res.status(graphRes.status).json({
        ok: false,
        status: graphRes.status,
        error: graphData?.error || graphData
      });
    }

    res.json({
      ok: true,
      id: graphData.id,
      webLink: graphData.webLink,
      joinUrl: (graphData?.onlineMeeting && graphData.onlineMeeting.joinUrl) || graphData?.onlineMeetingUrl || null,
      raw: graphData,
    });
  } catch (err) {
    console.error("[/ms/create-event] error", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/ms/debug-env", (_req, res) => {
  res.json({
    has_CLIENT_ID: !!CLIENT_ID,
    has_CLIENT_SECRET: !!CLIENT_SECRET,
    has_REDIRECT_URI: !!REDIRECT_URI,
    client_id: mask(CLIENT_ID),
    client_secret: mask(CLIENT_SECRET),
    client_secret_sha256_prefix: sha(CLIENT_SECRET),
    redirect_uri: REDIRECT_URI || null,
    node_env: NODE_ENV
  });
});

// ────────────────────────────────────────────────────────────
// Helpers for app-only (client_credentials) Graph calls
const DEFAULT_TENANT = pick(process.env.MS_TENANT, "common");

async function graphFetch(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": body ? "application/json" : undefined
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = json || { text, status: res.status };
    const err = new Error("Graph " + method + " " + url + " failed " + res.status);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return json;
}

function resolveTenant(req) {
  return pick(
    req.query.tenant,
    req.headers["x-tenant-id"],
    DEFAULT_TENANT
  );
}

async function getAppToken(tenant) {
  const t = tenant || DEFAULT_TENANT;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID/CLIENT_SECRET for app-only flow");
  }
  const form = new URLSearchParams();
  form.set("client_id", CLIENT_ID);
  form.set("client_secret", CLIENT_SECRET);
  form.set("grant_type", "client_credentials");
  form.set("scope", "https://graph.microsoft.com/.default");

  const tokenEndpoint = "https://login.microsoftonline.com/" + t + "/oauth2/v2.0/token";
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  const j = await r.json();
  if (!r.ok) {
    const err = new Error("App token fetch failed");
    err.status = r.status;
    err.detail = j;
    throw err;
  }
  if (!j.access_token) {
    const err = new Error("No access_token in app token response");
    err.detail = j;
    throw err;
  }
  return j.access_token;
}

app.get("/ms/app-token/debug", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    res.json({
      ok: true,
      tenant,
      client_id: mask(CLIENT_ID),
      has_token: !!token,
      token_hash: sha(token)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

app.get("/ms/places/rooms", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    const base = "https://graph.microsoft.com/v1.0/places/microsoft.graph.room?$top=999";
    const data = await graphFetch("GET", base, token);
    const rooms = (data?.value || []).map(r => ({
      id: r.id || null,
      displayName: r.displayName || null,
      emailAddress: r.emailAddress || null,
      floorLabel: r.floorLabel || r.floor || null,
      building: r.building || null,
      capacity: r.capacity || null
    }));
    res.json({ ok: true, tenant, count: rooms.length, rooms });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

app.post("/ms/rooms/availability", async (req, res) => {
  try {
    const {
      room_emails = [],
      start,
      end,
      timezone = "Europe/Stockholm",
      intervalMinutes = 30
    } = req.body || {};

    if (!Array.isArray(room_emails) || room_emails.length === 0) {
      return res.status(400).json({ ok: false, error: "room_emails (array) saknas" });
    }
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: "start och/eller end saknas (ISO)" });
    }

    const tenant = resolveTenant(req);
    const token  = await getAppToken(tenant);

    const anchor = encodeURIComponent(room_emails[0]);
    const url = `${GRAPH_BASE}/users/${anchor}/calendar/getSchedule`;

    const body = {
      schedules: room_emails,
      startTime: { dateTime: start, timeZone: timezone },
      endTime:   { dateTime: end,   timeZone: timezone },
      availabilityViewInterval: intervalMinutes
    };

    const data = await graphFetch("POST", url, token, body);

    const items = [];
    const arr = Array.isArray(data?.value) ? data.value : [];
    for (const sched of arr) {
      const scheduleId = sched?.scheduleId || null;
      const list = Array.isArray(sched?.scheduleItems) ? sched.scheduleItems : [];
      for (const it of list) {
        items.push({
          scheduleId,
          status: it?.status || "busy",
          subject: it?.subject || "",
          start: it?.start?.dateTime || null,
          end:   it?.end?.dateTime   || null,
          start_tz: it?.start?.timeZone || timezone,
          end_tz:   it?.end?.timeZone   || timezone
        });
      }
    }

    return res.json({ ok: true, tenant, count: items.length, items });
  } catch (e) {
    console.error("[/ms/rooms/availability] error:", e);
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

app.get("/ms/rooms/:roomEmail/calendar", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const token = await getAppToken(tenant);
    const { roomEmail } = req.params;
    const { start, end } = req.query;

    if (!roomEmail) return res.status(400).json({ ok: false, error: "roomEmail is required" });
    if (!start || !end) return res.status(400).json({ ok: false, error: "start & end ISO required" });

    const params = new URLSearchParams({
      startDateTime: String(start),
      endDateTime: String(end),
      "$select": "id,subject,organizer,start,end,location,attendees,isAllDay,webLink"
    });

    const url = "https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(roomEmail) + "/calendarView?" + params.toString();
    const data = await graphFetch("GET", url, token);

    res.json({ ok: true, tenant, events: data?.value || [] });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

function logMsTokenError(where, result, extra = {}) {
  try {
    console.error(`[${where}] MS token error`, {
      status: result?.status,
      ms_error: result?.data?.error,
      ms_error_description: result?.data?.error_description,
      extra
    });
  } catch {}
}

app.get("/ms/routes", (req, res) => {
  const routes = [];
  (app._router?.stack || []).forEach(l => {
    if (l.route?.path) {
      const method = Object.keys(l.route.methods || {})[0]?.toUpperCase();
      routes.push({ method, path: l.route.path });
    }
  });
  res.json({ routes });
});
function normalizeBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").toLowerCase().trim();
  if (!s) return false;
  return ["true", "yes", "1", "y"].includes(s);
}
function safeJsonStringify(obj, maxLen = 250000) {
  try {
    const s = JSON.stringify(obj ?? null);
    if (s && s.length > maxLen) return s.slice(0, maxLen) + "…";
    return s;
  } catch {
    return "";
  }
}
function normalizeOrgNo(v) {
  return String(v || "").replace(/\D+/g, "").trim();
}

// Cachea så vi bara detekterar en gång per process
let CLIENTCOMPANY_ORG_KEY = null;

// Detektera vilken field-key som faktiskt finns i Bubble Data API för ClientCompany orgnr
async function detectClientCompanyOrgKey() {
  if (CLIENTCOMPANY_ORG_KEY) return CLIENTCOMPANY_ORG_KEY;

  const candidates = [
    "Org_Number",
    "Org_number",
    "org_number",
    "OrgNo",
    "orgNo",
    "orgno",
    "OrgNr",
    "orgnr",
    "OrganisationNumber",
    "organisation_number"
  ];

  for (const key of candidates) {
    try {
      // Tricket: om key inte finns -> Bubble svarar 404 "Field not found ..."
      // om key finns men ingen match -> 200 med tom response (eller 200 med response.results=[])
      await bubbleFindOne("ClientCompany", [
        { key, constraint_type: "equals", value: "__probe__" }
      ]);

      CLIENTCOMPANY_ORG_KEY = key;
      console.log("[detectClientCompanyOrgKey] Using key:", CLIENTCOMPANY_ORG_KEY);
      return CLIENTCOMPANY_ORG_KEY;
    } catch (e) {
      const msg =
        e?.detail?.body?.body?.message ||
        e?.detail?.body?.message ||
        e?.message ||
        "";

      // bara ignorera "Field not found" och prova nästa
      if (String(msg).toLowerCase().includes("field not found")) continue;

      // annat fel -> kasta (då är det något annat som spökar)
      throw e;
    }
  }

  throw new Error("Could not detect ClientCompany org field key in Bubble Data API (none of the candidates worked).");
}

// Hitta ClientCompany via orgnr – provar både raw och digits
async function findClientCompanyByOrgNo(orgNoRaw) {
  const key = await detectClientCompanyOrgKey();

  const raw = String(orgNoRaw || "").trim();
  const digits = normalizeOrgNo(raw);

  // prova först raw (om ni sparar med bindestreck)
  if (raw) {
    const a = await bubbleFindOne("ClientCompany", [
      { key, constraint_type: "equals", value: raw }
    ]);
    if (a?._id) return a;
  }

  // prova digits (om ni sparar utan bindestreck)
  if (digits) {
    const b = await bubbleFindOne("ClientCompany", [
      { key, constraint_type: "equals", value: digits }
    ]);
    if (b?._id) return b;
  }

  return null;
}
const SYNC_SECRET = pick(process.env.SYNC_SECRET);

function requireSyncSecret(req, res, next) {
  // Om du inte satt env än, faila hårt så du märker det
  if (!SYNC_SECRET) return res.status(500).json({ ok: false, error: "Missing env SYNC_SECRET" });

  const got = req.headers["x-sync-secret"];
  if (!got || String(got) !== String(SYNC_SECRET)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return next();
}
// ────────────────────────────────────────────────────────────
// Tengella – Customers sync (Render → Tengella → Bubble Data API)
// ────────────────────────────────────────────────────────────
// Tengella ENV (robust mot olika namn)
const TENGELLA_ORGNO = pick(
  process.env.TENGELLA_ORGNO,
  process.env.TENGELLA_ORG_NO,
  process.env.TENGELLA_ORGNR,
  process.env.TENGELLA_DEFAULT_ORGNO,
  "746-0509" // sista fallback (safe för dig eftersom du har EN tenant)
);
async function listTengellaCustomers({ token, limit = 100, cursor = null } = {}) {
  return tengellaFetch(`/v2/Customers`, {
    method: "GET",
    token,
    query: { limit, cursor },
  });
}
async function tengellaGetCustomerById({ token, customerId }) {
  if (!customerId) return null;
  // Försök vanligaste REST-mönstret först
  try {
    return await tengellaFetch(`/v2/Customers/${customerId}`, { token });
  } catch (e) {
    // Fallback om API:t inte stödjer /Customers/:id
    // (då kan du senare byta till listTengellaCustomers + filtrering)
    throw e;
  }
}
async function upsertTengellaCustomerToBubble(customer) {
  const type = "TengellaCustomer";

  const tengella_customer_id = Number(customer?.CustomerId ?? 0) || null;
  if (!tengella_customer_id) return { ok: false, reason: "missing_customer_id" };

  const existing = await bubbleFindOne(type, [
    { key: "tengella_customer_id", constraint_type: "equals", value: tengella_customer_id },
  ]);

  const existingId = existing?._id || existing?.id || null;

  // Tengella skickar listor
  const addresses = Array.isArray(customer?.Addresses) ? customer.Addresses : [];
  const contacts  = Array.isArray(customer?.Contacts) ? customer.Contacts : [];

  const invAddr =
    addresses.find(a => Number(a?.AddressType) === 1 && !!a?.IsDefaultAddressforType) ||
    addresses.find(a => Number(a?.AddressType) === 1) ||
    null;

  const visitAddr =
    addresses.find(a => Number(a?.AddressType) === 4 && !!a?.IsDefaultAddressforType) ||
    addresses.find(a => Number(a?.AddressType) === 4) ||
    null;

  const defContact =
    contacts.find(c => !!c?.IsDefaultCustomerContact) ||
    contacts[0] ||
    null;

  const regNoRaw    = String(customer?.RegNo ?? "").trim();
  const regNoDigits = normalizeOrgNo(regNoRaw);

  // Matcha ClientCompany på Org_Number (safe)
  let matchedCompanyId = null;
  if (regNoDigits) {
    try {
      const cc = await bubbleFindOne("ClientCompany", [
        { key: "Org_Number", constraint_type: "equals", value: regNoDigits }
      ]);
      matchedCompanyId = cc?._id || cc?.id || null;
    } catch (_) {
      matchedCompanyId = null;
    }
  }

  const payload = {
    tengella_customer_id,
    tengella_customer_no: customer?.CustomerNo != null ? String(customer.CustomerNo) : "",

    name: customer?.CustomerName ?? customer?.Name ?? "",
    org_no: regNoDigits,
    org_no_raw: regNoRaw, // bara om fältet finns i Bubble
    vat_no: customer?.VatNumber ?? customer?.VatNo ?? "",

    phone: customer?.Phone ?? defContact?.Phone ?? defContact?.Mobile ?? "",
    email: customer?.EMail ?? customer?.Email ?? defContact?.Email ?? "",
    website: customer?.Www ?? customer?.Website ?? "",

    address: visitAddr?.Street ?? "",
    city: visitAddr?.City ?? "",
    zip: visitAddr?.ZipCode ?? "",

    invoice_address: invAddr?.Street ?? "",
    invoice_city: invAddr?.City ?? "",
    invoice_zip: invAddr?.ZipCode ?? "",

    ...(matchedCompanyId ? { company: matchedCompanyId } : {}),

    is_deleted: normalizeBool(customer?.IsDeleted),
    raw_json: safeJsonStringify(customer),
  };

  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  if (existingId) {
    // ✅ Bubble PATCH
    await bubblePatch(type, existingId, payload);
    return { ok: true, mode: "update", id: existingId };
  } else {
    const createdId = await bubbleCreate(type, payload);
    return { ok: true, mode: "create", id: createdId || null };
  }
}
app.post("/tengella/customers/sync", requireSyncSecret, async (req, res) => {
  try {
    const orgNo = req.body?.orgNo;
    const limit = Number(req.body?.limit ?? 100) || 100;
    const cursor = req.body?.cursor ?? null;
    const maxPages = Number(req.body?.maxPages ?? 50) || 50;

    if (!orgNo) return res.status(400).json({ ok: false, error: "Missing orgNo" });

    const token = await tengellaLogin(orgNo);

    let page = 0;
    let nextCursor = cursor;
    let existsMoreData = true;

    let fetched = 0;
    let upserted = 0;
    const errors = [];

    while (existsMoreData && page < maxPages) {
      page += 1;

      const resp = await listTengellaCustomers({ token, limit, cursor: nextCursor });
      const data = Array.isArray(resp?.Data) ? resp.Data : [];

      fetched += data.length;

      for (const customer of data) {
        try {
          // 1) Upsert TengellaCustomer (inkl ev "company" match om den redan finns)
          const r = await upsertTengellaCustomerToBubble(customer);
          if (r?.ok) upserted += 1;

          // 2) Hämta TengellaCustomer igen (för Bubble id + nuvarande company)
          const tRec = await bubbleFindOne("TengellaCustomer", [
            { key: "tengella_customer_id", constraint_type: "equals", value: Number(customer?.CustomerId) }
          ]);
          const tId = tRec?._id || tRec?.id || null;

          // 3) Om vi vill auto-skapa/ensura ClientCompany och länka:
          // (förutsätter att ensureClientCompanyForTengellaCustomer finns i filen)
          if (tId && typeof ensureClientCompanyForTengellaCustomer === "function") {
            const ccId = await ensureClientCompanyForTengellaCustomer(customer);

            if (ccId && !tRec?.company) {
              await bubblePatch("TengellaCustomer", tId, { company: ccId });
            }

            // (valfritt) spara tengella_customer_id på ClientCompany om fältet finns
            // - gör safe: patcha bara om fältet saknas
            try {
              const ccRec = await bubbleFindOne("ClientCompany", [
                { key: "_id", constraint_type: "equals", value: ccId }
              ]);
              if (ccRec && (ccRec.tengella_customer_id === undefined || ccRec.tengella_customer_id === null)) {
                await bubblePatch("ClientCompany", ccId, { tengella_customer_id: Number(customer?.CustomerId) });
              }
            } catch (_) {}
          }
        } catch (e) {
          errors.push({
            customerId: customer?.CustomerId,
            reason: e?.message || String(e),
            detail: e?.detail || e?.details || null
          });
        }
      }

      nextCursor = resp?.Next || null;
      existsMoreData = normalizeBool(resp?.ExistsMoreData) && !!nextCursor;
      if (normalizeBool(resp?.ExistsMoreData) && !nextCursor) existsMoreData = false;
    }

    return res.json({
      ok: true,
      pages: page,
      fetched,
      upserted,
      nextCursor,
      existsMoreData,
      errors: errors.slice(0, 50),
    });
  } catch (e) {
    console.error("[tengella/customers/sync] error:", e?.message || e, e?.details || e?.detail || "");
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      details: e?.details || e?.detail || null,
    });
  }
});
// ────────────────────────────────────────────────────────────
// Tengella – Customers + WorkOrders sync (Render → Tengella → Bubble Data API)
//
// ✅ DROP-IN REPLACEMENT BLOCK
// Replaces your whole “Tengella section” (fetch/login + upserts + routes)
// Put this block ONCE, at top-level (NOT inside any other route/loop),
// and place it BEFORE your final `app.listen(...)`.
//
// Requires your existing helpers elsewhere in index.js:
//   - pick(...)
//   - bubbleFindOne(type, constraints[])
//   - bubbleCreate(type, payload)
//   - bubbleUpdate(type, id, payload)
//
// Bubble types expected:
//   - TengellaWorkorder
//   - TengellaWorkorderRow
//   - TengellaCustomer
//
// Env required:
//   TENGELLA_BASE_URL      (optional, default https://api.tengella.se/public)
//   TENGELLA_APP_KEY       (used as header X-TengellaApiKey, per your Bubble setup)
//
// Notes:
//   - Login endpoint uses JSON-string body (ex: "746-0509") and path /v2/login (lowercase)
//   - Pagination returns { Data, Next, ExistsMoreData }
// ────────────────────────────────────────────────────────────

const TENGELLA_BASE_URL = pick(process.env.TENGELLA_BASE_URL, "https://api.tengella.se/public");
const TENGELLA_APP_KEY = pick(process.env.TENGELLA_APP_KEY);
const TENGELLA_DEFAULT_ORGNO = "746-0509";
// ────────────────────────────────────────────────────────────
// Tiny helpers (kept here so you don’t get “not defined” again)
// ────────────────────────────────────────────────────────────
function redacted(str, keep = 4) {
  const s = String(str || "");
  if (!s) return "";
  if (s.length <= keep) return "***";
  return s.slice(0, keep) + "…" + s.slice(-keep);
}
// ────────────────────────────────────────────────────────────
// Ensure ClientCompany from Tengella Customer (RegNo)
// Uses ClientCompany field: Org_Number (text)
// ────────────────────────────────────────────────────────────
async function ensureClientCompanyForTengellaCustomer(tCustomer) {
  // Tengella: RegNo ex "556233-9266"
  const regNoRaw = String(
    tCustomer?.RegNo ||
    tCustomer?.OrganisationNumber ||
    tCustomer?.OrganisationNo ||
    tCustomer?.org_no ||
    ""
  ).trim();

  const orgNoNorm = normalizeOrgNo(regNoRaw);
  if (!orgNoNorm) return null;

  // 1) Find by Org_Number
  const existing = await bubbleFindOne("ClientCompany", [
    { key: "Org_Number", constraint_type: "equals", value: orgNoNorm }
  ]);

  if (existing?._id) return existing._id;

  // 2) Create minimal ClientCompany (don’t overwrite CRM)
  const name = String(tCustomer?.CustomerName || tCustomer?.Name || "").trim() || orgNoNorm;

  const payload = {
    Name_company: name,
    Org_Number: orgNoNorm,
  };

  const createdId = await bubbleCreate("ClientCompany", payload);
  return createdId || null;
}
function toBubbleDate(v) {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
// ────────────────────────────────────────────────────────────
// UnifiedOrder payload from Tengella WorkOrder
// ────────────────────────────────────────────────────────────
async function buildUnifiedOrderFromTengella({
  bubbleWorkorderId,
  wo,
  resolvedCompanyId,
  tengellaCustomer = null,
  supplier = "Carotte Housekeeping AB",
} = {}) {
  const workorderNo = String(wo?.WorkOrderNo || "").trim();
  const workorderId = Number(wo?.WorkOrderId ?? 0) || null;

  // Order date
  const order_date = toBubbleDate(wo?.OrderDate);

  // Rows (amount + delivery_date)
  const woRows = Array.isArray(wo?.WorkOrderRows) ? wo.WorkOrderRows : [];

  // Amount = sum(Price * Quantity)
  const amountNum = woRows.reduce((sum, r) => {
    const price = Number(r?.Price ?? 0);
    const qty = Number(r?.Quantity ?? 1);
    const p = Number.isFinite(price) ? price : 0;
    const q = Number.isFinite(qty) ? qty : 1;
    return sum + p * q;
  }, 0);

  const amount = amountNum ? amountNum : null;

  // Delivery date = earliest timetable start from rows
  const candidateDates = woRows
    .map(r => r?.FirstTimeTableEventStart || r?.LastTimeTableEventStart || null)
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => Number.isFinite(d.getTime()));

  const delivery_date =
    candidateDates.length
      ? new Date(Math.min(...candidateDates.map(d => d.getTime()))).toISOString()
      : null;

  // Optional debug
  console.log("[UnifiedOrder][tengella] computed", {
    workorderNo,
    bubbleWorkorderId,
    rowsCount: woRows.length,
    sampleRowDates: woRows[0]
      ? {
          FirstTimeTableEventStart: woRows[0]?.FirstTimeTableEventStart ?? null,
          LastTimeTableEventStart: woRows[0]?.LastTimeTableEventStart ?? null,
        }
      : null,
    deliveryCandidatesCount: candidateDates.length,
    deliveryDateIso: delivery_date,
    amount,
  });
  // ✅ Fallback: om resolvedCompanyId saknas, försök matcha via orgnr från TengellaCustomer
  let companyIdFinal = resolvedCompanyId || null;

  if (!companyIdFinal && tengellaCustomer) {
    const orgRaw = String(tengellaCustomer?.org_no || tengellaCustomer?.org_no_raw || "").trim();
    if (orgRaw) {
      const cc = await findClientCompanyByOrgNo(orgRaw);
      const ccId = bubbleId(cc);
      if (ccId) companyIdFinal = ccId;
    }
  }
  return {
    source: "tengella",
    source_thing_id: String(bubbleWorkorderId),

    order_number: workorderNo || (workorderId ? String(workorderId) : null),
    raw_title: workorderNo ? `Tengella WO ${workorderNo}` : "Tengella Workorder",

    amount,
    company: companyIdFinal,

    order_date,
    delivery_date,

    // ✅ Detta är fältet du vill få in:
    supplier_name: String(supplier || "").trim() || "Carotte Housekeeping AB",

    status: "",
    source_url: "",
    account_manager: null,
  };
}
// ────────────────────────────────────────────────────────────
// Tengella fetch + login (matchar din Bubble setup)
// ────────────────────────────────────────────────────────────
async function tengellaFetch(
  path,
  { method = "GET", token = null, query = null, body = null, extraHeaders = null } = {}
) {
  if (!TENGELLA_APP_KEY) throw new Error("Missing env TENGELLA_APP_KEY (header X-TengellaApiKey)");

  const url = new URL(path.startsWith("http") ? path : `${TENGELLA_BASE_URL}${path}`);

  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === null || v === undefined || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    "Content-Type": "application/json",
    // ✅ exakt som i Bubble-screenshot: X-TengellaApiKey
    "X-TengellaApiKey": TENGELLA_APP_KEY,
    ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
  };

  if (token) headers.Authorization = `Bearer ${token}`;

  const hasBody = !(body === null || body === undefined);

  // ✅ Om body redan är en JSON-string (t.ex. "\"746-0509\""), skicka den som den är.
  // ✅ Om body är objekt, JSON.stringify:a.
  const finalBody = !hasBody
    ? undefined
    : typeof body === "string"
      ? body
      : JSON.stringify(body);

  const res = await fetch(url.toString(), { method, headers, body: finalBody });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const err = new Error(
      `Tengella ${method} ${url.pathname} failed (${res.status}): ` +
        (json ? JSON.stringify(json) : (text || `EMPTY_BODY (${res.statusText})`))
    );
    err.status = res.status;
    err.details = {
      status: res.status,
      statusText: res.statusText,
      url: url.toString(),
      sentHeaders: {
        "Content-Type": headers["Content-Type"],
        "X-TengellaApiKey": TENGELLA_APP_KEY ? redacted(TENGELLA_APP_KEY, 6) : null,
        Authorization: token ? "Bearer ***" : null,
      },
      bodyText: text || null,
      bodyJson: json || null,
    };
    throw err;
  }

  // Tengella brukar svara JSON, men om det är tomt:
  return json ?? (text || null);
}

async function tengellaLogin(orgNo) {
  if (!orgNo) throw new Error('Missing orgNo for Tengella login (ex: "746-0509")');

  // ✅ Swagger/Bubble: body ska vara en JSON-string => "746-0509"
  const bodyJsonString = JSON.stringify(String(orgNo).trim());

  // ✅ matcha path/case som i Bubble (du körde /v2/login)
  const data = await tengellaFetch(`/v2/login`, {
    method: "POST",
    body: bodyJsonString, // skicka som redan-JSON-string, inte stringify igen
  });

  // token kan vara string eller objekt med Token/token
  const token =
    (typeof data === "string" ? data : null) ||
    pick(data?.Token, data?.token, data?.access_token, data?.accessToken);

  if (!token) {
    const keys = typeof data === "object" && data ? Object.keys(data).join(", ") : typeof data;
    throw new Error(`Tengella login returned no token. Response keys/type: ${keys}`);
  }

  return token;
}

// ────────────────────────────────────────────────────────────
// Tengella list endpoints
// ────────────────────────────────────────────────────────────
async function listTengellaWorkOrders({ token, limit = 100, cursor = null, customerId = null, projectId = null } = {}) {
  return tengellaFetch(`/v2/WorkOrders`, {
    method: "GET",
    token,
    query: { limit, cursor, customerId, projectId },
  });
}

// (listTengellaCustomers defined earlier)

// ────────────────────────────────────────────────────────────
// Bubble upsert: WorkOrder
// (OBS: ta bort/kommentera fält som inte finns i Bubble, annars 400 Unrecognized field)
// ────────────────────────────────────────────────────────────
async function upsertTengellaWorkorderToBubble(
  workOrder,
  {
    bubbleCompanyId = null,
    bubbleCommissionId = null,
    parsedCommissionUid = "",
    saveRowsJson = true,
    tengellaCustomerId = null, // ✅ NYTT
  } = {}
) {
  const type = "TengellaWorkorder";

  const workorder_id = Number(workOrder?.WorkOrderId ?? 0) || null;
  if (!workorder_id) return { ok: false, reason: "Missing WorkOrderId" };

  const existing = await bubbleFindOne(type, [
    { key: "workorder_id", constraint_type: "equals", value: workorder_id },
  ]);

  const payload = {
    workorder_id,
     // ✅ Kopplingar (Bubble "field type = Thing")
  ...(tengellaCustomerId ? { tengella_customer: tengellaCustomerId } : {}),
  ...(bubbleCompanyId ? { company: bubbleCompanyId } : {}),
    project_id: Number(workOrder?.ProjectId ?? 0) || null,
    customer_id: Number(workOrder?.CustomerId ?? 0) || null,
    workorder_no: workOrder?.WorkOrderNo ?? "",
    description: workOrder?.WorkOrderDescription ?? "",
    work_address_id: Number(workOrder?.WorkAddressId ?? 0) || null,
    order_date: toBubbleDate(workOrder?.OrderDate),
    is_deleted: normalizeBool(workOrder?.IsDeleted),
    note: workOrder?.Note ?? "",
    internal_note: workOrder?.InternalNote ?? "",
    note_for_schedule: workOrder?.NoteForSchedule ?? "",
    desired_schedule_note: workOrder?.DesiredScheduleNote ?? "",
    general_schedule_note: workOrder?.GeneralScheduleNote ?? "",
    workorder_rows_json: saveRowsJson ? safeJsonStringify(workOrder?.WorkOrderRows ?? []) : "",
  };

  // Optional relations (ONLY if those fields exist in Bubble)
  if (bubbleCompanyId) payload.company = bubbleCompanyId;
  if (bubbleCommissionId) payload.commission = bubbleCommissionId;
  if (parsedCommissionUid) payload.commission_uid = parsedCommissionUid; // only if you created it
  if (tengellaCustomerId) payload.tengella_customer = tengellaCustomerId; // only if you created it

  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const existingId = existing?._id || existing?.id || null;

  if (existingId) {
    // PATCH är säkrare för relationer (company/workorder)
    await bubblePatch(type, existingId, payload);
    return { ok: true, mode: "update", id: existingId };
  } else {
    const createdId = await bubbleCreate(type, payload);
    return { ok: true, mode: "create", id: createdId || null };
  }
} // ✅ stänger upsertTengellaWorkorderToBubble

// ────────────────────────────────────────────────────────────
// Bubble upsert: WorkOrderRow
// - använder bubblePatch (inte bubbleUpdate)
// - skickar company/workorder bara om de finns (så du slipper 400 om schema inte är klart)
// ────────────────────────────────────────────────────────────

let _TWO_ROW_FIELD_CACHE = null;

async function canWriteTengellaWorkorderRowFields() {
  if (_TWO_ROW_FIELD_CACHE) return _TWO_ROW_FIELD_CACHE;

  const probe = async (field) => {
    try {
      // Bubble validerar fältet i constraints; resultat spelar ingen roll.
      await bubbleFindOne("TengellaWorkorderRow", [
        { key: field, constraint_type: "equals", value: "__probe__" }
      ]);
      return true;
    } catch (e) {
      const msg =
        e?.detail?.body?.body?.message ||
        e?.details?.body?.body?.message ||
        e?.message ||
        "";
      if (String(msg).toLowerCase().includes("field not found") || String(msg).toLowerCase().includes("unrecognized field")) {
        return false;
      }
      // andra fel: anta false för säkerhet
      return false;
    }
  };

  const hasCompany  = await probe("company");
  const hasWorkorder = await probe("workorder");
  const hasCommission = await probe("commission");

  _TWO_ROW_FIELD_CACHE = { hasCompany, hasWorkorder, hasCommission };
  console.log("[TengellaWorkorderRow fields]", _TWO_ROW_FIELD_CACHE);
  return _TWO_ROW_FIELD_CACHE;
}

// ────────────────────────────────────────────────────────────
// Bubble upsert: WorkOrderRow
// ────────────────────────────────────────────────────────────
async function upsertTengellaWorkorderRowToBubble(
  row,
  {
    workorderBubbleId = null,
    workorderId = null,
    projectId = null,
    customerId = null,
    company = null,        // Bubble ClientCompany ID
    commission = null      // Bubble Commission ID (type Comission)
  } = {}
) {
  const type = "TengellaWorkorderRow";
  if (!row) return { ok: false, reason: "missing_row" };

  const workOrderRowId = Number(row.WorkOrderRowId ?? row.workOrderRowId ?? 0) || null;
  if (!workOrderRowId) return { ok: false, reason: "missing_workOrderRowId" };

  const existing = await bubbleFindOne(type, [
    { key: "workorder_row_id", constraint_type: "equals", value: workOrderRowId },
  ]);

  const existingId = existing?._id || existing?.id || null;

  const payload = {
    workorder_row_id: workOrderRowId,

    // numeric refs
    workorder_id: Number(row.WorkOrderId ?? row.workOrderId ?? workorderId ?? 0) || null,
    project_id: Number(projectId ?? 0) || null,
    customer_id: Number(customerId ?? 0) || null,

    // relations (Thing fields) — ALWAYS send if we have ids
    ...(workorderBubbleId ? { workorder: workorderBubbleId } : {}),
    ...(company ? { company } : {}),
    ...(commission ? { commission } : {}),

    // row data
    item_id: Number(row.ItemId ?? 0) || null,
    item_no: row.ItemNo != null ? String(row.ItemNo) : null,
    item_name: row.ItemName ?? null,

    quantity: row.Quantity != null ? Number(row.Quantity) : null,
    note: row.Note ?? null,

    price: row.Price != null ? Number(row.Price) : null,
    cost_price: row.CostPrice != null ? Number(row.CostPrice) : null,
    total_cost_price: row.TotalCostPrice != null ? Number(row.TotalCostPrice) : null,

    invoiced: normalizeBool(row.Invoiced),
    workorder_row_invoice_status_id: Number(row.WorkOrderRowInvoiceStatusId ?? 0) || null,
    approx_working_time: row.ApproxWorkingTime != null ? Number(row.ApproxWorkingTime) : null,
    material_to_project_row_id: Number(row.MaterialToProjectRowId ?? 0) || null,
    desired_schedule_is_handled: normalizeBool(row.DesiredScheduleIsHandled),
    item_invoice_type_id: Number(row.ItemInvoiceTypeId ?? 0) || null,
    invoice_status_change_datetime: toBubbleDate(row.WorkOrderRowInvoiceStatusChangeDatetime),
    cant_be_scheduled: normalizeBool(row.CantBeScheduled),
    time_spent_for_tax_reduction: row.TimeSpentForTaxReduction != null ? Number(row.TimeSpentForTaxReduction) : null,
    unit_of_measure_id: Number(row.UnitOfMeasureId ?? 0) || null,
    allowed_minutes: row.AllowedMinutes != null ? Number(row.AllowedMinutes) : null,
    order_by: row.OrderBy != null ? Number(row.OrderBy) : null,
    workorder_rounding_id: Number(row.WorkOrderRoundingId ?? 0) || null,
    approved_working_time: row.ApprovedWorkingTime != null ? Number(row.ApprovedWorkingTime) : null,
    first_timetable_event_start: toBubbleDate(row.FirstTimeTableEventStart),
    last_timetable_event_start: toBubbleDate(row.LastTimeTableEventStart),

    raw_json: safeJsonStringify(row),
  };

  // Bubble gillar null men inte undefined
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  // debug (så du ser att vi faktiskt skickar company)
  console.log("[row payload]", {
    mode: existingId ? "update" : "create",
    workOrderRowId,
    workorderBubbleId: workorderBubbleId || null,
    company: company || null,
    commission: commission || null
  });

  if (existingId) {
    await bubblePatch(type, existingId, payload);
    return { ok: true, mode: "update", id: existingId };
  } else {
    const createdId = await bubbleCreate(type, payload);
    return { ok: true, mode: "create", id: createdId || null };
  }
}
// ────────────────────────────────────────────────────────────
// Bubble upsert: Customer
// (Match your Bubble fields – adjust keys if needed)
// ────────────────────────────────────────────────────────────


// (dedup) removed duplicate upsertTengellaCustomerToBubble



// ────────────────────────────────────────────────────────────
// Debug endpoints
// ────────────────────────────────────────────────────────────
app.get("/tengella/debug-env", (req, res) => {
  res.json({
    ok: true,
    base_url: TENGELLA_BASE_URL,
    has_app_key: !!TENGELLA_APP_KEY,
    app_key_preview: TENGELLA_APP_KEY ? redacted(TENGELLA_APP_KEY, 6) : null,
  });
});

app.post("/tengella/auth/test", async (req, res) => {
  try {
    const orgNo = (req.body?.orgNo || TENGELLA_DEFAULT_ORGNO || "").trim();
    if (!orgNo) return res.status(400).json({ ok: false, error: "Missing orgNo" });

    const token = await tengellaLogin(orgNo);

    return res.json({
      ok: true,
      orgNo,
      token_preview: token ? `${String(token).slice(0, 6)}...${String(token).slice(-5)}` : null
    });
  } catch (e) {
    console.error("[tengella/auth/test]", e?.message || e, e?.details || "");
    return res.status(500).json({ ok: false, error: e?.message || String(e), details: e?.details || null });
  }
});
// ────────────────────────────────────────────────────────────
// WorkOrders sync route (TOP-LEVEL, not nested)
// Resolves TengellaCustomer → ClientCompany (Policy B)
// + ✅ Upsert UnifiedOrder per WorkOrder (Alternativ 2)
// ────────────────────────────────────────────────────────────
app.post("/tengella/workorders/sync", requireSyncSecret, async (req, res) => {
  try {
    const orgNo = (req.body?.orgNo || TENGELLA_DEFAULT_ORGNO || "").trim();
    if (!orgNo) return res.status(400).json({ ok: false, error: "Missing orgNo" });

    const limit = Number(req.body?.limit ?? 100) || 100;
    const cursor = req.body?.cursor ?? null;
    const customerId = req.body?.customerId ?? null;
    const projectId = req.body?.projectId ?? null;
    const maxPages = Number(req.body?.maxPages ?? 50) || 50;

    const saveRowsJson =
      req.body?.saveRowsJson === undefined ? true : normalizeBool(req.body?.saveRowsJson);
    const upsertRows =
      req.body?.upsertRows === undefined ? true : normalizeBool(req.body?.upsertRows);

    const bubbleCompanyId = req.body?.bubbleCompanyId ?? null;
    const bubbleCommissionId = req.body?.bubbleCommissionId ?? null;
    const parsedCommissionUid = req.body?.parsedCommissionUid ?? "";

    const token = await tengellaLogin(orgNo);

    let page = 0;
    let nextCursor = cursor;
    let existsMoreData = true;

    let fetched = 0;
    let upserted = 0;
    let unifiedOrdersUpserted = 0; // ✅ NYTT
    let unifiedOrdersErrors = 0;   // ✅ NYTT
    let workorderRowsUpserted = 0;
    let workorderRowsErrors = 0;
    const errors = [];

    while (existsMoreData && page < maxPages) {
      page += 1;

      const resp = await listTengellaWorkOrders({
        token,
        limit,
        cursor: nextCursor,
        customerId,
        projectId
      });

      const data = Array.isArray(resp?.Data) ? resp.Data : [];
      fetched += data.length;

      for (const wo of data) {
        // ─────────────────────────────────────────
        // Resolve TengellaCustomer → ClientCompany
        // ─────────────────────────────────────────
        let resolvedCompanyId = bubbleCompanyId || null;
        let resolvedTengellaCustomerId = null;

        // ✅ VIKTIGT: tc måste ligga i scope för UnifiedOrder-hooken
        let tc = null;

        if (wo?.CustomerId) {
          const custIdNum = Number(wo.CustomerId);

          tc = await bubbleFindOne("TengellaCustomer", [
            { key: "tengella_customer_id", constraint_type: "equals", value: custIdNum }
          ]).catch(() => null);

          if (!tc && typeof tengellaGetCustomerById === "function") {
            try {
              const apiCustomer = await tengellaGetCustomerById({
                token,
                customerId: custIdNum
              });
              if (apiCustomer && typeof upsertTengellaCustomerToBubble === "function") {
                await upsertTengellaCustomerToBubble(apiCustomer).catch(() => null);
                tc = await bubbleFindOne("TengellaCustomer", [
                  { key: "tengella_customer_id", constraint_type: "equals", value: custIdNum }
                ]).catch(() => null);
              }
            } catch (e) {
              console.warn("[tengella/workorders] customer fetch failed", custIdNum);
            }
          }

          if (tc?._id) {
            resolvedTengellaCustomerId = tc._id;

            if (tc.company) {
              resolvedCompanyId = tc.company;
            } else {
              const regDigits = normalizeOrgNo(
                tc.org_no || tc.org_no_raw || tc.organization_number || ""
              );

              // Policy B: skapa ClientCompany endast om orgnr finns
              if (regDigits) {
                let cc = await findClientCompanyByOrgNo(regDigits).catch(() => null);
                let ccId = cc?._id || cc?.id || null;

                if (!ccId && typeof ensureClientCompanyForTengellaCustomer === "function") {
                  ccId = await ensureClientCompanyForTengellaCustomer({
                    RegNo: regDigits,
                    CustomerName: tc.name || tc.customer_name || null
                  }).catch(() => null);
                }

                if (ccId) {
                  resolvedCompanyId = ccId;
                  await bubblePatch("TengellaCustomer", tc._id, { company: ccId }).catch(() => null);
                }
              }
            }
          }
        }

        // ─────────────────────────────────────────
        // Upsert WorkOrder
        // ─────────────────────────────────────────
        const result = await upsertTengellaWorkorderToBubble(wo, {
          bubbleCompanyId: resolvedCompanyId,
          bubbleCommissionId,
          parsedCommissionUid,
          saveRowsJson,
          tengellaCustomerId: resolvedTengellaCustomerId
        });

        if (result?.ok) {
          upserted += 1;

          // ─────────────────────────────────────────
          // ✅ Upsert UnifiedOrder (Alternativ 2)
          // ─────────────────────────────────────────
          try {
            if (
              result?.id &&
              typeof buildUnifiedOrderFromTengella === "function" &&
              typeof upsertUnifiedOrder === "function"
            ) {
              const unifiedPayload = await buildUnifiedOrderFromTengella({
                bubbleWorkorderId: result.id,
                wo,
                resolvedCompanyId,
                tengellaCustomer: tc || null,
                supplier: "Carotte Housekeeping AB"
              });

              await upsertUnifiedOrder(unifiedPayload);
              unifiedOrdersUpserted += 1;
            }
          } catch (e) {
            unifiedOrdersErrors += 1;
            errors.push({
              kind: "unifiedorder_upsert_failed",
              workOrderId: wo?.WorkOrderId,
              workOrderNo: wo?.WorkOrderNo,
              bubbleWorkorderId: result?.id || null,
              reason: e?.message || String(e)
            });
          }

          // ─────────────────────────────────────────
          // Upsert Rows
          // ─────────────────────────────────────────
          if (upsertRows && Array.isArray(wo?.WorkOrderRows) && wo.WorkOrderRows.length) {
            for (const row of wo.WorkOrderRows) {
              try {
                const rr = await upsertTengellaWorkorderRowToBubble(row, {
                  workorderBubbleId: result.id,
                  workorderId: wo.WorkOrderId,
                  projectId: wo.ProjectId,
                  customerId: wo.CustomerId,
                  company: resolvedCompanyId,
                  commission: bubbleCommissionId
                });

                if (rr?.ok) workorderRowsUpserted += 1;
                else workorderRowsErrors += 1;
              } catch (e) {
                workorderRowsErrors += 1;
              }
            }
          }
        }
      }

      nextCursor = resp?.Next || null;
      existsMoreData = normalizeBool(resp?.ExistsMoreData) && !!nextCursor;
      if (normalizeBool(resp?.ExistsMoreData) && !nextCursor) existsMoreData = false;
    }

    return res.json({
      ok: true,
      pages: page,
      fetched,
      upserted,
      unifiedOrdersUpserted, // ✅ NYTT
      unifiedOrdersErrors,   // ✅ NYTT
      workorderRowsUpserted,
      workorderRowsErrors,
      nextCursor,
      existsMoreData,
      errors: errors.slice(0, 50)
    });
  } catch (e) {
    console.error("[tengella/workorders/sync] fatal", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ────────────────────────────────────────────────────────────
// Tengella SyncState (Bubble) helpers
// ────────────────────────────────────────────────────────────
const SYNC_STATE_TYPE = "TengellaSyncState";

async function getOrCreateTengellaSyncState(orgNo) {
  const org = String(orgNo || TENGELLA_ORGNO).trim();
  let s = await bubbleFindOne(SYNC_STATE_TYPE, [
    { key: "org_no", constraint_type: "equals", value: org }
  ]);

  if (bubbleId(s)) return s;

  const createdId = await bubbleCreate(SYNC_STATE_TYPE, {
    org_no: org,
    customers_cursor: "",
    workorders_cursor: "",
    last_ok: true
  });

  s = await bubbleFindOne(SYNC_STATE_TYPE, [
    { key: "org_no", constraint_type: "equals", value: org }
  ]);

  return s || { _id: createdId, org_no: org };
}

function isLocked(locked_until) {
  if (!locked_until) return false;
  const t = new Date(locked_until).getTime();
  if (Number.isNaN(t)) return false;
  return t > Date.now();
}

async function acquireLockOrFail(stateId, minutes = 8) {
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  await bubblePatch(SYNC_STATE_TYPE, stateId, { locked_until: until });
  return until;
}

async function releaseLock(stateId) {
  await bubblePatch(SYNC_STATE_TYPE, stateId, { locked_until: null });
}
// ────────────────────────────────────────────────────────────
// Tengella Cron Sync (single-tenant default)
// ────────────────────────────────────────────────────────────
app.post("/tengella/cron", requireSyncSecret, async (req, res) => {
  const orgNo = String(req.body?.orgNo || TENGELLA_ORGNO).trim();

  const customersMaxPagesRaw  = Number(req.body?.customersMaxPages ?? 20);
  const workordersMaxPagesRaw = Number(req.body?.workordersMaxPages ?? 40);

  // Viktigt: 0 ska vara giltigt (=> kör inte)
  const customersMaxPages  = Number.isFinite(customersMaxPagesRaw)  ? customersMaxPagesRaw  : 20;
  const workordersMaxPages = Number.isFinite(workordersMaxPagesRaw) ? workordersMaxPagesRaw : 40;

  // separata limits (säkrare)
  const customersLimit  = Number(req.body?.customersLimit ?? 100) || 100;
  const workordersLimit = Number(req.body?.limit ?? 50) || 50;

  try {
    // 1) Hämta state
    const state = await getOrCreateTengellaSyncState(orgNo);
    const stateId = bubbleId(state);
    if (!stateId) throw new Error("Could not resolve TengellaSyncState id");

    // 2) Stoppa om låst
    if (isLocked(state.locked_until)) {
      return res.json({ ok: true, skipped: "locked", locked_until: state.locked_until, orgNo });
    }

    // 3) Lock
    const locked_until = await acquireLockOrFail(stateId, 8);

    // 4) Login Tengella
    const token = await tengellaLogin(orgNo);

    // ── A) Customers sync (cursor-driven)
    let customersCursor = state.customers_cursor || null;
    let customersPages = 0;
    let customersFetched = 0;
    let customersUpserted = 0;

    if (customersMaxPages > 0) {
      while (customersPages < customersMaxPages) {
        customersPages += 1;

        const resp = await listTengellaCustomers({
          token,
          limit: customersLimit,
          cursor: customersCursor
        });

        const data = Array.isArray(resp?.Data) ? resp.Data : [];
        customersFetched += data.length;

        for (const c of data) {
          const r = await upsertTengellaCustomerToBubble(c);
          if (r?.ok) customersUpserted += 1;
        }

        const nextCursor = resp?.Next || null;
        const more = normalizeBool(resp?.ExistsMoreData) && !!nextCursor;
        customersCursor = nextCursor;

        // spara cursor efter varje page (så vi aldrig tappar läge)
        await bubblePatch(SYNC_STATE_TYPE, stateId, {
          customers_cursor: customersCursor || "",
          last_run: new Date().toISOString(),
          last_ok: true
        });

        if (!more) break;
      }
    }

    // ── B) WorkOrders sync (cursor-driven)
    let workordersCursor = state.workorders_cursor || null;
    let workordersPages = 0;
    let workordersFetched = 0;
    let workordersUpserted = 0;
    let rowsUpserted = 0;

    if (workordersMaxPages > 0) {
      while (workordersPages < workordersMaxPages) {
        workordersPages += 1;

        const resp = await listTengellaWorkOrders({
          token,
          limit: workordersLimit,
          cursor: workordersCursor
        });

        const data = Array.isArray(resp?.Data) ? resp.Data : [];
        workordersFetched += data.length;

        // DEBUG: se exakt vad Tengella svarar om det blir 0
        console.log("[tengella/cron] workorders page", {
          workordersPages,
          sentCursor: workordersCursor,
          got: data.length,
          next: resp?.Next || null,
          existsMoreData: resp?.ExistsMoreData
        });

        for (const wo of data) {
          // Resolve TengellaCustomer → company (ClientCompany)
let resolvedCompanyId = null;
let resolvedTengellaCustomerBubbleId = null;
let tc = null; // 👈 VIKTIGT: definierad i rätt scope

if (wo?.CustomerId) {
  tc = await bubbleFindOne("TengellaCustomer", [
    {
      key: "tengella_customer_id",
      constraint_type: "equals",
      value: Number(wo.CustomerId)
    }
  ]);

  const tcId = bubbleId(tc);
  if (tcId) {
    resolvedTengellaCustomerBubbleId = tcId;

    if (tc?.company) {
      // Redan kopplad → använd direkt
      resolvedCompanyId = tc.company;
    } else {
// Försök härleda ClientCompany via orgnr (robust: auto-detect rätt orgnr-fält)
const regDigits = normalizeOrgNo(tc?.org_no || tc?.org_no_raw || "");
if (regDigits) {
  const cc = await findClientCompanyByOrgNo(regDigits);
  const ccId = bubbleId(cc);

  if (ccId) {
    resolvedCompanyId = ccId;

    // Cachea kopplingen på TengellaCustomer
    await bubblePatch("TengellaCustomer", tcId, { company: ccId });
  }
}
    }
  }
}

                   const wr = await upsertTengellaWorkorderToBubble(wo, {
            bubbleCompanyId: resolvedCompanyId,
            tengellaCustomerId: resolvedTengellaCustomerBubbleId
          });

          if (wr?.ok) workordersUpserted += 1;

// ✅ Hook 2: UnifiedOrder cache (per workorder)
try {
  if (wr?.ok && wr?.id) {
    const unifiedPayload = await buildUnifiedOrderFromTengella({
      bubbleWorkorderId: wr.id,
      wo,
      resolvedCompanyId,
      tengellaCustomer: tc,
      supplier: "Carotte Housekeeping AB",
    });

    await upsertUnifiedOrder(unifiedPayload);
  }
} catch (e) {
  console.error("[UnifiedOrder][tengella] failed", {
    workorderId: wo?.WorkOrderId,
    workorderNo: wo?.WorkOrderNo,
    bubbleWorkorderId: wr?.id || null,
    error: e?.message || String(e),
    detail: e?.detail || null,
  });
}

// Rows
if (wr?.ok && Array.isArray(wo?.WorkOrderRows) && wo.WorkOrderRows.length) {
  for (const row of wo.WorkOrderRows) {
    const rr = await upsertTengellaWorkorderRowToBubble(row, {
      workorderBubbleId: wr.id,
      workorderId: wo.WorkOrderId,
      projectId: wo.ProjectId,
      customerId: wo.CustomerId,
      company: resolvedCompanyId,
    });
    if (rr?.ok) rowsUpserted += 1;
  }
}
        } // 👈 👈 👈 VIKTIG: STÄNGER for (const wo of data)

        const nextCursor = resp?.Next || null;
        const more = normalizeBool(resp?.ExistsMoreData) && !!nextCursor;
        workordersCursor = nextCursor;

        await bubblePatch(SYNC_STATE_TYPE, stateId, {
          workorders_cursor: workordersCursor || "",
          last_run: new Date().toISOString(),
          last_ok: true
        });

        if (!more) break;
      }
    }

    // 5) Release lock
    await releaseLock(stateId);

    return res.json({
      ok: true,
      orgNo,
      locked_until,
      customers: {
        pages: customersPages,
        fetched: customersFetched,
        upserted: customersUpserted,
        cursor: customersCursor || ""
      },
      workorders: {
        pages: workordersPages,
        fetched: workordersFetched,
        upserted: workordersUpserted,
        rowsUpserted,
        cursor: workordersCursor || ""
      }
    });
  } catch (e) {
    console.error("[tengella/cron] error:", e?.message || e, e?.details || e?.detail || "");
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      details: e?.details || e?.detail || null
    });
  }
});
app.listen(PORT, () => console.log("🚀 Mira Exchange running on port " + PORT));
