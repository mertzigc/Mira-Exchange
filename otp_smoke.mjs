// Smoke: OTP-koden vid signering — återanvändning i stället för ny kod per sidladdning.
//   node otp_smoke.mjs
//
// SKARP BUGG 2026-08-19: signeringssidan anropade requestOtp() vid VARJE sidladdning,
// och varje ny kod skrev över `otp_hash` → koden mottagaren just hämtat ur inkorgen
// dog så fort hon laddade om eller öppnade länken igen. Kunden fick sex koder och
// först den sista fungerade ("Mira bombarderar mig med länkar, den 7:e funkade").
//
// Sviten kör den RIKTIGA route-handlern ur index.js mot en mockad Bubble och räknar
// hur många mail som köas — det är den enhet kunden faktiskt drabbades av.
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
function slice(src, a, b, label) {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i);
  if (i < 0 || j < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${a}"`); return ""; }
  return src.slice(i, j + b.length);
}
async function group(label, fn) {
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ [${label} kraschade] ${e && e.message}`); }
}
const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

// ── Mockad Bubble + miljö ───────────────────────────────────────────────────
let APPROVAL, MAILS, PATCHES, NOW;
function reset(overrides) {
  APPROVAL = Object.assign({
    _id: "ap1", recipient_email: "feklund@nexon-hq.com", token_hash: "TOKENHASH",
    status: "Sent", otp_hash: "", otp_expires_at: null, request: "oar1", rubrik: "Housekeeping",
  }, overrides || {});
  MAILS = []; PATCHES = [];
}
const env = {
  _clientIp: () => "1.2.3.4",
  _publicRateLimited: () => false,
  _sha256Hex: (v) => (v === "raw" ? "TOKENHASH" : "H(" + v + ")"),
  _safeEqHex: (a, b) => a === b,
  _genOtp: () => String(100000 + MAILS.length),          // deterministisk, unik per mail
  _approvalCors: () => {},
  _approvalTemplateId: () => "tpl-otp",
  bubbleGet: async (t, id) => (t === "OfferApproval" && id === APPROVAL._id ? APPROVAL
    : (t === "OfferApprovalRequest" ? { _id: "oar1", rubrik: "Housekeeping NEXON HQ Europe AB" } : null)),
  bubblePatch: async (t, id, p) => { PATCHES.push({ t, id, p }); Object.assign(APPROVAL, p); },
  bubbleCreate: async (t, row) => { if (t === "emailqueue") MAILS.push(row); return "m" + MAILS.length; },
};

function buildRoute() {
  const helper = slice(SRC, "async function _fetchApprovalByToken(approvalId, rawToken) {", "\n}", "_fetchApprovalByToken");
  const consts = slice(SRC, "const OTP_MINUTES =", "const OTP_RESEND_COOLDOWN_MS = 60 * 1000;", "OTP-konstanter");
  const route  = slice(SRC, 'app.post("/approval/request-otp/:id"', "\n});", "request-otp");
  if (!helper || !route) return null;
  let handler = null;
  const app = { post: (p, h) => { handler = h; }, options: () => {} };
  new Function("app", "bubbleGet", "bubblePatch", "bubbleCreate", "_clientIp", "_publicRateLimited",
    "_sha256Hex", "_safeEqHex", "_genOtp", "_approvalCors", "_approvalTemplateId", "console",
    `${consts}\n${helper}\n${route}`)(
      app, env.bubbleGet, env.bubblePatch, env.bubbleCreate, env._clientIp, env._publicRateLimited,
      env._sha256Hex, env._safeEqHex, env._genOtp, env._approvalCors, env._approvalTemplateId,
      { log() {}, warn() {}, error() {} });
  return handler;
}
function call(handler, body) {
  return new Promise((r) => {
    const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } };
    handler({ params: { id: "ap1" }, body, headers: {} }, res);
  });
}
const TOKEN = "raw";                                    // _sha256Hex("raw") === "H(raw)"

const run = async () => {
  await group("request-otp", async () => {
    const h = buildRoute();
    if (!h) { fail++; console.log("  ✗ kunde inte bygga routen"); return; }

    // ══════════════════════════════════════════════════════════════════════
    sec("Första besöket");
    // ══════════════════════════════════════════════════════════════════════
    reset();
    let r = await call(h, { token: TOKEN });
    ok("skickar en kod när ingen finns", r.body.ok && r.body.sent === true && MAILS.length === 1);
    ok("koden hashas, aldrig i klartext i databasen", !!APPROVAL.otp_hash && !PATCHES.some((p) => /^\d{6}$/.test(String(p.p.otp_hash))));
    ok("mailet bär koden", /^\d{6}$/.test(JSON.parse(MAILS[0].extra_data).code));
    ok("giltighetstiden är 15 min", Math.round((Date.parse(APPROVAL.otp_expires_at) - Date.now()) / 60000) === 15);
    ok("svaret säger när koden går ut", !!r.body.expires_at);

    // ══════════════════════════════════════════════════════════════════════
    sec("Omladdningar — KÄRNAN i buggen");
    // ══════════════════════════════════════════════════════════════════════
    const firstHash = APPROVAL.otp_hash;
    for (let i = 0; i < 5; i++) r = await call(h, { token: TOKEN });
    ok("fem omladdningar skickar NOLL extra mail (var sex st tidigare)", MAILS.length === 1);
    ok("koden i mottagarens inkorg är fortfarande giltig", APPROVAL.otp_hash === firstHash);
    ok("svaret markerar återanvändning", r.body.reused === true && !r.body.sent);
    ok("svaret bär utgångstiden så sidan kan visa den", !!r.body.expires_at);
    ok("ingen onödig skrivning mot Bubble", PATCHES.length === 1);

    // ══════════════════════════════════════════════════════════════════════
    sec("Utgången kod");
    // ══════════════════════════════════════════════════════════════════════
    APPROVAL.otp_expires_at = new Date(Date.now() - 1000).toISOString();
    r = await call(h, { token: TOKEN });
    ok("utgången kod → ny skickas automatiskt", r.body.sent === true && MAILS.length === 2);
    ok("den nya koden ersätter den gamla", APPROVAL.otp_hash !== firstHash);

    // ══════════════════════════════════════════════════════════════════════
    sec("'Skicka koden igen' (force)");
    // ══════════════════════════════════════════════════════════════════════
    r = await call(h, { token: TOKEN, force: true });
    ok("för tidig omsändning → 429, inget mail", r.code === 429 && r.body.error === "resend_too_soon" && MAILS.length === 2);
    ok("svaret säger hur länge man måste vänta", r.body.retry_after > 0 && r.body.retry_after <= 60);
    ok("den gamla koden lever kvar även vid nekad omsändning", !!APPROVAL.otp_hash);

    // Låtsas att kylan gått ut: flytta utgången bakåt (= skickades för länge sedan)
    APPROVAL.otp_expires_at = new Date(Date.now() + 13.5 * 60000).toISOString();
    const beforeForce = APPROVAL.otp_hash;
    r = await call(h, { token: TOKEN, force: true });
    ok("efter kylan → ny kod skickas", r.body.sent === true && MAILS.length === 3 && APPROVAL.otp_hash !== beforeForce);
    // ⚠️ Utan detta hade force varit meningslöst: sidladdningen hade återanvänt igen.
    ok("force går förbi återanvändningen", !r.body.reused);

    // ══════════════════════════════════════════════════════════════════════
    sec("Skyddsräcken");
    // ══════════════════════════════════════════════════════════════════════
    reset();
    r = await call(h, { token: "fel-token" });
    ok("fel token → 401, inget mail", r.code === 401 && MAILS.length === 0);
    r = await call(h, {});
    ok("token saknas → 400, inget mail", r.code === 400 && MAILS.length === 0);

    reset({ status: "Approved", approved_at: "2026-08-19T09:00:00Z", otp_hash: "x", otp_expires_at: new Date(Date.now() + 6e5).toISOString() });
    r = await call(h, { token: TOKEN, force: true });
    ok("redan signerat → ingen ny kod ens med force", r.body.already_approved === true && MAILS.length === 0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  sec("Signeringssidan");
  // ══════════════════════════════════════════════════════════════════════════
  const page = slice(SRC, "  function clockOf(iso){", "})();", "signeringssidan");
  ok("utklippet hittades", page.length > 0);
  ok("sidladdningen frågar UTAN force", /requestOtp\(false\);/.test(page));
  ok("'Skicka koden igen' är enda vägen till en ny kod", /resend\.addEventListener\("click", \(\) => requestOtp\(true\)\)/.test(page));
  ok("force skickas till servern", /force: force === true/.test(page));
  ok("återanvänd kod förklaras för användaren", page.includes("Vi har redan skickat en kod"));
  ok("texten säger att omladdning inte spelar roll", page.includes("fungerar även om du laddat om sidan"));
  ok("utgångstiden visas", /function clockOf\(iso\)/.test(page) && page.includes("giltig till "));
  ok("429 hanteras utan att se ut som ett fel", /resend_too_soon/.test(page) && /startCooldown\(j\.retry_after/.test(page));
  // Regressionsvakt: det var precis det ovillkorliga anropet som orsakade buggen.
  ok("inget ovillkorligt requestOtp() kvar", page.length > 0 && !/(^|[^(])\brequestOtp\(\)/.test(page));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
