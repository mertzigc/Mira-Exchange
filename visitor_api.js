// visitor_api.js — besöksloggen för /visitor (receptionist + lobbyskärm).
// DI-mönster som companies_api.js / produktion_api.js.
//
// ⚠️ SCOPE ÄR SÄKERHETEN. Varje endpoint:
//   1. visitorAuth.authed(req) → payload eller 401
//   2. resolveScope(payload, begärd fastighet) → lista eller 403
//   3. ALLA Bubble-frågor filtrerar på den listan
// Lita ALDRIG på fastighet/hyresgäst-id från klienten utan att skära mot tokenen.
// Utanför scope = 403, aldrig tom lista (tyst tomt döljer buggar).
//
// ⚠️ Kundlistan HÄRLEDS ur `ClientCompany.Fastighet contains <id>` — INTE ur
// `Fastighet.Hyresgäster`. Det fältet finns i schemat men skrivs aldrig av vår kod
// (companies_api.js:285 skriver ClientCompany.Fastighet) → kan vara tomt/stale.
// Se handoff/BESOKSHANTERING.md §7.5.2.
//
// Varför inte återanvända InviteGuest: den är EVENEMANGSBUNDEN (guest.invitation ==
// Invitation) och används av RSVP/deltagarlistor. Ett besök hör till fastighet +
// hyresgäst + värd — att tvinga in det i en Invitation vore ett konstlat påhäng.

// Bubble-fältnamn samlade — ⚠️ case-sensitivt, ändra HÄR om typen döps om.
export const VISIT = {
  TYPE: "Visit",
  F_FASTIGHET:   "fastighet",         // Fastighet  (scope-nyckeln)
  F_HYRESGAST:   "hyresgast",         // ClientCompany
  F_VARD:        "vard",              // Coworker (valfri — kan saknas)
  F_VARD_NAMN:   "vard_namn",         // text (fallback när värden inte är Coworker)
  F_GAST_NAMN:   "besokare_namn",     // text
  F_GAST_BOLAG:  "besokare_bolag",    // text
  F_IN:          "incheckad_at",      // date
  F_UT:          "utcheckad_at",      // date
  F_VIA:         "via",               // text: "reception" | "lobby"
  F_AV:          "registrerad_av",    // User (tom vid självincheckning)
  F_AV_NAMN:     "registrerad_av_namn", // text (signering — se §7.5)
  F_KANAL:       "notis_kanal",       // text: "sms" | "mail" | "ingen"
  F_STATUS:      "notis_status",      // text: "vantar" | "skickad" | "fel"
  F_NOTIS_AT:    "notis_at",          // date
  F_NOTIS_FEL:   "notis_fel",         // text
};

export function registerVisitorRoutes(app, deps) {
  const {
    bubbleFindAll, bubbleGet, bubbleId, bubbleCreate, bubblePatch,
    visitorAuth, planningCors, publicRateLimited, clientIp,
    sms, sendMail,          // notiskanaler — se /visitor/visits/:id/notify
  } = deps;

  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : bubbleId(v)));
  const _iso = (v) => { const d = v ? new Date(v) : null; return (d && !isNaN(d.getTime())) ? d.toISOString() : null; };

  function cors(req, res) { if (planningCors) planningCors(req, res); }

  // Gate: token → payload. Returnerar null och svarar 401 om den saknas/är ogiltig.
  function gate(req, res) {
    cors(req, res);
    const p = visitorAuth && visitorAuth.authed ? visitorAuth.authed(req) : null;
    if (!p) { res.status(401).json({ ok: false, error: "unauthorized" }); return null; }
    if (publicRateLimited && clientIp && publicRateLimited("visitor:" + clientIp(req), 600, 60 * 60 * 1000, "visitor")) {
      res.status(429).json({ ok: false, error: "rate_limited" }); return null;
    }
    return p;
  }

  // Scope: begärd fastighet måste ligga i tokenen. Utanför → 403 (aldrig tom lista).
  function scope(p, req, res) {
    const list = visitorAuth.resolveScope(p, _str(req.query.fastighet || (req.body && req.body.fastighet)).trim());
    if (!list || !list.length) {
      res.status(403).json({ ok: false, error: "outside_scope" });
      return null;
    }
    return list;
  }

  // ── Hyresgäster per fastighet (TTL-cache) ─────────────────────────────────
  // Bubble har inget OR → en fråga per fastighet. Med 2–6 fastigheter per receptionist
  // är det bundet, och cachen gör att sökningar/paginering inte kostar nya svep.
  const TTL = 10 * 60 * 1000;
  const _tenantCache = new Map();   // fastighet-id → { list, ts }
  async function tenantsFor(fastighetId) {
    const hit = _tenantCache.get(fastighetId);
    if (hit && (Date.now() - hit.ts) < TTL) return hit.list;
    // Ingen .catch(()=>[]) — ett trasigt svar ska braka, inte se ut som "inga hyresgäster".
    const rows = await bubbleFindAll("ClientCompany", {
      constraints: [{ key: "Fastighet", constraint_type: "contains", value: fastighetId }],
    });
    const list = (rows || []).map((c) => ({
      id: bubbleId(c),
      name: _str(c.Name_company || c.name || c.Name),
      fastighet: fastighetId,
    })).filter((c) => c.id && c.name);
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    _tenantCache.set(fastighetId, { list, ts: Date.now() });
    return list;
  }
  function tenantsForget() { _tenantCache.clear(); }

  async function tenantsForScope(fastigheter) {
    const all = [];
    for (const f of fastigheter) all.push(...(await tenantsFor(f)));
    return all;
  }

  // ── GET /visitor/context — vad receptionisten får se ──────────────────────
  // Fastigheter (namn) + hyresgäster i dem. Grunden för både registreringsformuläret
  // och lobbyskärmens sökning.
  app.options("/visitor/context", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/visitor/context", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    try {
      const mine = p.fast || [];
      const fastigheter = [];
      for (const id of mine) {
        const f = await bubbleGet("Fastighet", id).catch(() => null);
        // ⚠️ Fastighet har INGET `Namn`-fält — namnet ligger i `Titel`, och `Adress` är
        // ett geographic address-OBJEKT. Se [[reference-bubble-fastighet-titel]].
        const adr = f && f.Adress;
        const adrTxt = adr ? (typeof adr === "string" ? adr : _str(adr.address)) : "";
        fastigheter.push({ id, name: (f ? _str(f.Titel) : "") || adrTxt || id });
      }
      const hyresgaster = await tenantsForScope(mine);
      return res.json({
        ok: true,
        user: { id: p.uid, name: p.name || "" },
        fastigheter,
        hyresgaster,
        exp: p.exp,
      });
    } catch (e) {
      console.error("[/visitor/context]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /visitor/hosts?hyresgast= — värdar hos en hyresgäst ───────────────
  // ⚠️ Hyresgästen MÅSTE ligga i en av mina fastigheter, annars kan vem som helst
  // lista kontaktuppgifter för valfritt bolag i Mira.
  app.options("/visitor/hosts", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/visitor/hosts", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    const companyId = _str(req.query.hyresgast).trim();
    if (!companyId) return res.status(400).json({ ok: false, error: "missing_hyresgast" });
    try {
      const allowed = await tenantsForScope(p.fast || []);
      if (!allowed.some((c) => c.id === companyId)) {
        return res.status(403).json({ ok: false, error: "outside_scope" });
      }
      const rows = await bubbleFindAll("Coworker", {
        constraints: [{ key: "Kundföretag", constraint_type: "equals", value: companyId }],
      });
      const hosts = (rows || []).map((co) => {
        const first = _str(co["Förnamn"] || co["First Name"]);
        const last = _str(co["Efternamn"] || co["Last Name"]);
        const tel = _str(co.Telefon || co.telefon);
        const mail = _str(co.Email || co.email);
        return {
          id: bubbleId(co),
          name: (first + " " + last).trim() || mail,
          title: _str(co.Titel || co.title),
          // Kanalerna avgör hur värden notifieras — och visas för receptionisten så
          // hen ser direkt om personen går att nå.
          has_sms: !!tel,
          has_mail: !!mail,
        };
      }).filter((h) => h.id && h.name);
      hosts.sort((a, b) => a.name.localeCompare(b.name, "sv"));
      return res.json({ ok: true, count: hosts.length, hosts });
    } catch (e) {
      console.error("[/visitor/hosts]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── GET /visitor/visits — dagens besök i mitt scope ───────────────────────
  app.options("/visitor/visits", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/visitor/visits", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    const mine = scope(p, req, res); if (!mine) return;
    try {
      const q = _str(req.query.q).trim().toLowerCase();
      const openOnly = _str(req.query.open) === "1";
      const day = _str(req.query.datum).trim() || new Date().toISOString().slice(0, 10);

      const tenants = await tenantsForScope(mine);
      const tenantName = new Map(tenants.map((c) => [c.id, c.name]));

      // En fråga per fastighet (Bubble saknar OR). Dagsfiltret läggs på lokalt:
      // datumsträngar är opålitliga i Bubbles constraints — samma skäl som
      // ft_invoice_ts finns (ARKITEKTUR_OCH_OMTAG §3.3).
      let raw = [];
      for (const f of mine) {
        const rows = await bubbleFindAll(VISIT.TYPE, {
          constraints: [{ key: VISIT.F_FASTIGHET, constraint_type: "equals", value: f }],
        });
        raw.push(...(rows || []));
      }
      raw = raw.filter((r) => _str(r[VISIT.F_IN]).slice(0, 10) === day);
      if (openOnly) raw = raw.filter((r) => !r[VISIT.F_UT]);
      if (q) {
        raw = raw.filter((r) => {
          const hay = (_str(r[VISIT.F_GAST_NAMN]) + " " + _str(r[VISIT.F_GAST_BOLAG]) + " " +
                       _str(r[VISIT.F_VARD_NAMN]) + " " +
                       _str(tenantName.get(_ref(r[VISIT.F_HYRESGAST])))).toLowerCase();
          return hay.indexOf(q) > -1;
        });
      }
      raw.sort((a, b) => (Date.parse(_str(b[VISIT.F_IN])) || 0) - (Date.parse(_str(a[VISIT.F_IN])) || 0));

      const rows = raw.map((r) => {
        const cid = _ref(r[VISIT.F_HYRESGAST]);
        return {
          id: bubbleId(r),
          gast: _str(r[VISIT.F_GAST_NAMN]),
          gast_bolag: _str(r[VISIT.F_GAST_BOLAG]),
          hyresgast_id: cid,
          hyresgast: cid ? (tenantName.get(cid) || "") : "",
          vard: _str(r[VISIT.F_VARD_NAMN]),
          vard_id: _ref(r[VISIT.F_VARD]),
          fastighet_id: _ref(r[VISIT.F_FASTIGHET]),
          in: _iso(r[VISIT.F_IN]),
          ut: _iso(r[VISIT.F_UT]),
          via: _str(r[VISIT.F_VIA]) || "reception",
          av: _str(r[VISIT.F_AV_NAMN]),
          kanal: _str(r[VISIT.F_KANAL]),
          status: _str(r[VISIT.F_STATUS]),
          notis_fel: _str(r[VISIT.F_NOTIS_FEL]),
          open: !r[VISIT.F_UT],
        };
      });
      return res.json({ ok: true, datum: day, total: rows.length, rows });
    } catch (e) {
      console.error("[/visitor/visits]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /visitor/visits — registrera besök ───────────────────────────────
  // Notisen skickas INTE här (egen route) — en misslyckad notis får aldrig hindra
  // att besöket loggas. Gästen står ju faktiskt i lobbyn.
  app.options("/visitor/visits", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.post("/visitor/visits", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    const b = req.body || {};
    const fastighet = _str(b.fastighet).trim();
    if (!fastighet) return res.status(400).json({ ok: false, error: "missing_fastighet" });
    if (!visitorAuth.hasFastighet(p, fastighet)) return res.status(403).json({ ok: false, error: "outside_scope" });

    const companyId = _str(b.hyresgast).trim();
    const gast = _str(b.gast).trim();
    if (!companyId) return res.status(400).json({ ok: false, error: "missing_hyresgast" });
    if (!gast) return res.status(400).json({ ok: false, error: "missing_gast" });
    try {
      // Hyresgästen måste ligga i DEN fastigheten — inte bara i mitt scope. Annars kan
      // ett besök registreras på fel hus och dyka upp i fel receptionists lista.
      const tenants = await tenantsFor(fastighet);
      if (!tenants.some((c) => c.id === companyId)) {
        return res.status(403).json({ ok: false, error: "tenant_not_in_fastighet" });
      }
      const via = _str(b.via).trim() === "lobby" ? "lobby" : "reception";
      const payload = {
        [VISIT.F_FASTIGHET]: fastighet,
        [VISIT.F_HYRESGAST]: companyId,
        [VISIT.F_GAST_NAMN]: gast,
        [VISIT.F_IN]: new Date().toISOString(),
        [VISIT.F_VIA]: via,
        [VISIT.F_STATUS]: "vantar",
      };
      const bolag = _str(b.gast_bolag).trim(); if (bolag) payload[VISIT.F_GAST_BOLAG] = bolag;
      const vardId = _str(b.vard).trim();      if (vardId) payload[VISIT.F_VARD] = vardId;
      const vardNamn = _str(b.vard_namn).trim(); if (vardNamn) payload[VISIT.F_VARD_NAMN] = vardNamn;
      // Signering: vem uppgav sig registrera besöket. Vid självincheckning står lobbyn.
      if (via === "lobby") payload[VISIT.F_AV_NAMN] = "Självincheckning";
      else {
        payload[VISIT.F_AV] = p.uid;
        payload[VISIT.F_AV_NAMN] = _str(b.av_namn).trim() || p.name || "";
      }
      const id = await bubbleCreate(VISIT.TYPE, payload);
      return res.json({ ok: true, id, via, incheckad_at: payload[VISIT.F_IN] });
    } catch (e) {
      console.error("[/visitor/visits POST]", e?.message, e?.detail);
      return res.status(500).json({ ok: false, error: e?.message || String(e), detail: e?.detail || null });
    }
  });

  // ── POST /visitor/visits/:id/checkout — checka ut ─────────────────────────
  app.options("/visitor/visits/:id/checkout", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.post("/visitor/visits/:id/checkout", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const v = await bubbleGet(VISIT.TYPE, id);
      if (!v) return res.status(404).json({ ok: false, error: "visit_not_found" });
      // ⚠️ Besöket måste ligga i MITT scope — annars kan vem som helst med en giltig
      // visitor-token checka ut besök i andras hus genom att gissa id.
      if (!visitorAuth.hasFastighet(p, _ref(v[VISIT.F_FASTIGHET]))) {
        return res.status(403).json({ ok: false, error: "outside_scope" });
      }
      if (v[VISIT.F_UT]) return res.json({ ok: true, id, utcheckad_at: _iso(v[VISIT.F_UT]), already: true });
      const nowIso = new Date().toISOString();
      await bubblePatch(VISIT.TYPE, id, { [VISIT.F_UT]: nowIso });
      return res.json({ ok: true, id, utcheckad_at: nowIso });
    } catch (e) {
      console.error("[/visitor/visits/:id/checkout]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── POST /visitor/visits/:id/notify — notifiera värden ────────────────────
  // ⚠️ EGEN route, medvetet skild från create. Ett notisfel får ALDRIG hindra att
  // besöket loggas — gästen står faktiskt i lobbyn oavsett om SMS:et gick fram.
  // Kanalval: SMS om värden har mobil, annars mail. Statusen skrivs alltid, även
  // vid fel, så receptionisten ser svart på vitt om värden är nådd.
  app.options("/visitor/visits/:id/notify", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.post("/visitor/visits/:id/notify", async (req, res) => {
    const p = gate(req, res); if (!p) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    try {
      const v = await bubbleGet(VISIT.TYPE, id);
      if (!v) return res.status(404).json({ ok: false, error: "visit_not_found" });
      const fastId = _ref(v[VISIT.F_FASTIGHET]);
      if (!visitorAuth.hasFastighet(p, fastId)) return res.status(403).json({ ok: false, error: "outside_scope" });

      // Dedupe: en feltryckande receptionist ska inte kunna spamma värden — och
      // varje SMS kostar pengar. `force` finns för medvetet omsändande.
      const force = req.body && (req.body.force === true || req.body.force === "1");
      if (_str(v[VISIT.F_STATUS]) === "skickad" && !force) {
        return res.json({ ok: true, id, already: true, kanal: _str(v[VISIT.F_KANAL]), status: "skickad" });
      }

      const gast = _str(v[VISIT.F_GAST_NAMN]);
      const f = fastId ? await bubbleGet("Fastighet", fastId).catch(() => null) : null;
      const husnamn = f ? (_str(f.Titel) || (f.Adress ? (typeof f.Adress === "string" ? f.Adress : _str(f.Adress.address)) : "")) : "";

      // Värdens kanaler läses FÄRSKT ur Coworker — kontaktuppgifter ändras, och
      // besöksraden ska inte bära en kopia som blir inaktuell.
      const vardId = _ref(v[VISIT.F_VARD]);
      const co = vardId ? await bubbleGet("Coworker", vardId).catch(() => null) : null;
      const tel = co ? _str(co.Telefon || co.telefon) : "";
      const mail = co ? _str(co.Email || co.email) : "";
      const vardNamn = _str(v[VISIT.F_VARD_NAMN]) ||
        (co ? ((_str(co["Förnamn"] || co["First Name"]) + " " + _str(co["Efternamn"] || co["Last Name"])).trim()) : "");

      const nowIso = new Date().toISOString();
      const write = async (patch) => { await bubblePatch(VISIT.TYPE, id, patch); };

      // Ingen kontaktväg alls → registrera det som ett synligt fel, inte som tystnad.
      if (!tel && !mail) {
        await write({ [VISIT.F_STATUS]: "fel", [VISIT.F_KANAL]: "ingen", [VISIT.F_NOTIS_AT]: nowIso,
                      [VISIT.F_NOTIS_FEL]: "Värden saknar både mobil och e-post" });
        return res.status(422).json({ ok: false, error: "no_contact_channel", id, vard: vardNamn });
      }

      // ⚠️ Emoji-fri och kort med flit — se sms.js: en emoji dubblar kostnaden.
      const smsText = "Din besökare " + gast + " väntar i receptionen" +
        (husnamn ? ", " + husnamn : "") + ". Hälsningar Carotte";

      let result = null, kanal = "";
      if (tel && sms && sms.configured) {
        kanal = "sms";
        result = await sms.send({ to: tel, text: smsText });
      } else if (mail && typeof sendMail === "function") {
        kanal = "mail";
        const bolag = _str(v[VISIT.F_GAST_BOLAG]);
        const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1e2235">' +
          "<p>Hej" + (vardNamn ? " " + esc(vardNamn.split(" ")[0]) : "") + ",</p>" +
          "<p>Din besökare har checkat in i receptionen och väntar på dig.</p>" +
          '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">' +
          "<tr><td><b>Besökare</b></td><td>" + esc(gast) + "</td></tr>" +
          (bolag ? "<tr><td><b>Bolag</b></td><td>" + esc(bolag) + "</td></tr>" : "") +
          (husnamn ? "<tr><td><b>Plats</b></td><td>" + esc(husnamn) + "</td></tr>" : "") +
          "</table></div>";
        try {
          await sendMail({ to: mail, toName: vardNamn, subject: "Din besökare " + gast + " är här", html, fromName: "Carotte Reception" });
          result = { ok: true };
        } catch (e) { result = { ok: false, error: "mail_failed", detail: String(e && e.message || e).slice(0, 300) }; }
      } else {
        // Kanal finns men gatewayen är inte konfigurerad → aldrig tyst "skickat".
        await write({ [VISIT.F_STATUS]: "fel", [VISIT.F_KANAL]: tel ? "sms" : "mail", [VISIT.F_NOTIS_AT]: nowIso,
                      [VISIT.F_NOTIS_FEL]: "Notiskanalen är inte konfigurerad" });
        return res.status(503).json({ ok: false, error: "channel_not_configured", id });
      }

      if (result && result.ok) {
        await write({ [VISIT.F_STATUS]: "skickad", [VISIT.F_KANAL]: kanal, [VISIT.F_NOTIS_AT]: nowIso, [VISIT.F_NOTIS_FEL]: "" });
        return res.json({ ok: true, id, kanal, status: "skickad", segments: result.segments || null });
      }
      const felText = _str(result && (result.detail || result.error)) || "okänt fel";
      await write({ [VISIT.F_STATUS]: "fel", [VISIT.F_KANAL]: kanal, [VISIT.F_NOTIS_AT]: nowIso, [VISIT.F_NOTIS_FEL]: felText });
      // 200 med status:"fel" — besöket ÄR registrerat, bara notisen gick inte fram.
      // Receptionisten ska se det i listan och kunna trycka om, inte få ett rött API-fel.
      return res.json({ ok: false, id, kanal, status: "fel", error: felText });
    } catch (e) {
      console.error("[/visitor/visits/:id/notify]", e?.message);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  return { tenantsForget };
}
