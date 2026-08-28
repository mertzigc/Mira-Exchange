// staff_api.js — Staff-modulen (dashboard_crm → Service & People).
// DI-mönster som companies_api.js / visitor_api.js.
//
// Fyra vyer på BEFINTLIG data:
//   Översikt            — åtgärdslista + KPI:er
//   Receptionister      — sessionsstatus + tilldelning av fastigheter (SKRIVER)
//   Besöksuppsättningar — en rad per hus
//   Notiser             — statistik + felorsaker
//
// ⚠️ AUTH: `planningAuthed` (x-admin-token = PLANNING_ADMIN_TOKEN). Detta är en
//    CRM-yta för Carotte-personal — ALDRIG visitor-token. Koppla aldrig ihop de två
//    gaterna; scope-isoleringen sker vid DI-injektionen (index.js).
//
// ⚠️ DET HÄR ÄR INTE BYGGT, MED FLIT (se handoff/STAFF-MODULEN.md §4–5):
//    • Bemanning/Intelliplan — källan har dagskornighet, inte klockslag.
//    • "Snittid till värd"  — vi vet när notisen gick, aldrig när värden kom ned.
//    • Lobbyskärmens hälsa  — kräver att skärmen hör av sig. Den gör den inte.
//    • Carotte Academy      — kräver ny datamodell.
//    Rita aldrig en kolumn mot en källa som inte kan fylla den.
//
// ⚠️ WU: ingen enda endpoint sveper Visit. Allt går per fastighet med constraint,
//    och hela modulen delar EN ögonblicksbild med TTL. User-/Coworker-/Fastighet-
//    svepen lånas ur companies_api:s redan förvärmda cachar (deps-injektion) i
//    stället för att göras om. Se [[reference-bubble-wu-full-sweeps]].

import { VISIT } from "./visitor_api.js";

// User-fält. ⚠️ Case-sensitivt. `receptionist_fastigheter` är verifierat mot skarp
// kod (index.js ~21324 LÄSER det i /visitor/session, som fungerar i drift).
// Token-fältets versalisering skiljer sig mellan dokumentationsraderna i
// BESOKSHANTERING.md (§7.5.3 skriver gement, §7.5.3c versalt) — därför provas båda
// vid skrivning, se _rensaToken().
export const STAFF = {
  USER: "User",
  ROLE: "User_role",
  ROLE_VALUE: "Receptionist",
  FASTIGHETER: "receptionist_fastigheter",
  TOKEN_NAMN: ["visitor_token", "Visitor_token"],
};

export function registerStaffRoutes(app, deps) {
  const {
    bubbleFind, bubbleFindAll, bubbleGet, bubbleId, bubblePatch,
    // Lånade, redan förvärmda projektioner ur companies_api. Kastar hellre än
    // svarar tomt — se kommentaren vid returen i companies_api.js.
    receptionistDirectory, coworkerDirectory, fastighetDirectory, usersForget,
    userRoleDirectory,
    planningAuthed, planningCors, publicRateLimited, clientIp,
    snapshotTtlMs, tenantTtlMs,
    // ⚠️ Vilket bolag som är VÅRT. Env är fallback; den inloggades `user_company`
    // vinner (samma regel som companies_api:s onboarding-check, som en gång sa emot
    // personallistan just för att den bara läste env-varen).
    CAROTTE_COMPANY_ID,
  } = deps;

  const _str = (v) => (v == null ? "" : String(v));
  const _ref = (v) => (v == null ? null : (typeof v === "string" ? v : bubbleId(v)));
  const _ts  = (v) => { const t = Date.parse(_str(v)); return Number.isFinite(t) ? t : 0; };
  // Option-set läses som sträng ELLER {display} — samma normalisering som _users()
  // och /visitor/session gör. Läser man bara strängen tappas hälften av svaren.
  const _osVal = (v) => (v == null ? "" : (typeof v === "string" ? v : _str(v.display || v.Display || v)));
  const _pct = (del, av) => (av > 0 ? Math.round((del / av) * 1000) / 10 : null);   // null, aldrig 0 %

  const SNAP_TTL   = snapshotTtlMs == null ? 5 * 60 * 1000  : snapshotTtlMs;
  const TENANT_TTL = tenantTtlMs   == null ? 10 * 60 * 1000 : tenantTtlMs;
  // Tak per hus och fönster. Nås det är siffrorna ofullständiga — och det SÄGS,
  // i svaret och i vyn. En tyst avhuggning läser man som "så här ser det ut".
  const MAX_SIDOR = 40;

  function cors(req, res) { if (planningCors) planningCors(req, res); }
  function gate(req, res) {
    cors(req, res);
    if (!planningAuthed || !planningAuthed(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
    if (publicRateLimited && clientIp && publicRateLimited("staff:" + clientIp(req), 300, 60 * 60 * 1000, "staff")) {
      res.status(429).json({ ok: false, error: "rate_limited" }); return false;
    }
    return true;
  }
  function fel(res, e, var_) {
    console.error("[" + var_ + "]", e && e.message, JSON.stringify((e && e.detail) || null));
    return res.status((e && e.status) || 500).json({ ok: false, error: (e && e.message) || String(e), detail: (e && e.detail) || null });
  }

  // ── Bubble-felklassning ───────────────────────────────────────────────────
  // ⚠️ MATCHA SMALT. Samma disciplin som _deadRefId i index.js: fel fältnamn,
  // fel typnamn och 5xx MÅSTE fortsätta braka, annars döljer vi äkta buggar.
  function _felkropp(e) {
    const d = (e && e.detail) || {};
    return _str(d.body || d.bodyText || (d.bodyJson ? JSON.stringify(d.bodyJson) : ""));
  }
  function _status(e) { const d = (e && e.detail) || {}; return d.status || 0; }
  // "Fastigheten är raderad i Bubble men ligger kvar i en tilldelning."
  // Speglar _deadRefId (index.js) men matchar mot DET id vi frågade om i stället för
  // mot id-formatet — smalare, inte bredare: både frasen OCH id:t måste finnas.
  function _dodRef(e, id) {
    if (_status(e) !== 400) return false;
    const b = _felkropp(e);
    return b.indexOf("object with this id does not exist") > -1 && b.indexOf(String(id)) > -1;
  }
  // "Nyckeln <namn> går inte att använda som constraint / finns inte som fält."
  function _oktantFalt(e, namn) {
    if (_status(e) !== 400) return false;
    const b = _felkropp(e);
    if (b.indexOf("object with this id does not exist") > -1) return false;   // det är dödref, inte fältfel
    return b.indexOf(namn) > -1;
  }

  // ── Hyresgäster per fastighet ─────────────────────────────────────────────
  // ⚠️ ClientCompany.Fastighet contains <id> — ALDRIG Fastighet.Hyresgäster.
  // Det fältet finns i schemat men skrivs aldrig av vår kod (companies_api.js:285
  // skriver ClientCompany.Fastighet) → kan vara tomt/stale. Samma väg som
  // visitor_api.js tenantsFor(), med flit: en enda sanning om vilka som bor i huset.
  const _hyresCache = new Map();
  async function hyresgasterFor(fastighetId) {
    const hit = _hyresCache.get(fastighetId);
    if (hit && (Date.now() - hit.ts) < TENANT_TTL) return hit;
    let rows = null, dod = false;
    try {
      // Ingen .catch(()=>[]) — ett trasigt svar ska braka, inte se ut som "inga hyresgäster".
      rows = await bubbleFindAll("ClientCompany", {
        constraints: [{ key: "Fastighet", constraint_type: "contains", value: fastighetId }],
      });
    } catch (e) {
      if (!_dodRef(e, fastighetId)) throw e;
      rows = []; dod = true;
    }
    const list = (rows || []).map((c) => ({ id: bubbleId(c), name: _str(c.Name_company || c.name || c.Name) }))
      .filter((c) => c.id);
    list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    const ut = { list, dod, ts: Date.now() };
    _hyresCache.set(fastighetId, ut);
    return ut;
  }

  // ── Besök per fastighet inom fönstret ─────────────────────────────────────
  // Två skydd, för att INGET här får bli ett tyst helsvep när Visit växer:
  //  1. Datum-constraint på incheckad_at. Fungerar den inte (Bubbles slug-form för
  //     date-fält är inte verifierad mot den här typen) faller vi tillbaka EN gång
  //     — och `datumfilter` i svaret säger vilken väg som togs. Ingen gissning
  //     lämnas oredovisad.
  //  2. Sidtak + JS-omfiltrering. Taket rapporteras som `trunkerad`.
  async function _sidor(typ, constraints) {
    const ut = []; let cursor = 0, sidor = 0, trunkerad = false;
    for (;;) {
      const batch = await bubbleFind(typ, { constraints, limit: 100, cursor });
      ut.push.apply(ut, batch || []);
      sidor++;
      if (!batch || batch.length < 100) break;
      if (sidor >= MAX_SIDOR) { trunkerad = true; break; }
      cursor += 100;
    }
    return { rows: ut, sidor, trunkerad };
  }
  async function besokFor(fastighetId, franTs) {
    const bas = [{ key: VISIT.F_FASTIGHET, constraint_type: "equals", value: fastighetId }];
    const medDatum = bas.concat([{ key: VISIT.F_IN, constraint_type: "greater than", value: new Date(franTs).toISOString() }]);
    let r = null, lage = "constraint";
    try { r = await _sidor(VISIT.TYPE, medDatum); }
    catch (e) {
      if (_dodRef(e, fastighetId)) return { rows: [], rader_hamtade: 0, trunkerad: false, datumfilter: "dod_fastighet", dod: true };
      if (!_oktantFalt(e, VISIT.F_IN)) throw e;         // allt annat ska braka
      lage = "fallback";
      r = await _sidor(VISIT.TYPE, bas);
    }
    // JS-omfiltrering ALLTID — den är sanningen oavsett om constrainten bet.
    const rows = (r.rows || []).filter((v) => _ts(v[VISIT.F_IN]) >= franTs);
    return { rows, rader_hamtade: (r.rows || []).length, trunkerad: r.trunkerad, datumfilter: lage, dod: false };
  }

  // ── Ögonblicksbilden — allt fyra vyerna behöver, hämtat en gång ───────────
  const _snapCache = new Map();     // dagar → { data, ts }
  async function snapshot(dagar, force) {
    const hit = _snapCache.get(dagar);
    if (!force && hit && (Date.now() - hit.ts) < SNAP_TTL) return hit.data;

    const franTs = Date.now() - dagar * 24 * 60 * 60 * 1000;
    const recs = await receptionistDirectory();
    const fastList = await fastighetDirectory();
    const fastNamn = new Map(fastList.map((f) => [f.id, f.name]));

    // ⚠️ Husurvalet = unionen av receptionisternas tilldelningar. Det är samma
    // sanning som backend scopar på — ett hus utan tilldelad receptionist finns
    // inte i besökshanteringen och ska därför inte stå i tabellen som en nolla.
    const husIds = [];
    const recPerHus = new Map();
    for (const r of recs) {
      for (const f of r.fastigheter) {
        if (!recPerHus.has(f)) { recPerHus.set(f, []); husIds.push(f); }
        recPerHus.get(f).push({ id: r.id, namn: r.name });
      }
    }
    husIds.sort((a, b) => _str(fastNamn.get(a) || a).localeCompare(_str(fastNamn.get(b) || b), "sv"));

    const coworkers = await coworkerDirectory();
    const coPerKund = new Map();
    for (const c of coworkers) {
      if (!c.company_id) continue;
      if (!coPerKund.has(c.company_id)) coPerKund.set(c.company_id, []);
      coPerKund.get(c.company_id).push(c);
    }

    const hus = [], kundRader = [], notisFel = [];
    // Besök per receptionist = signeringen `registrerad_av` på besöksraden. Räknas
    // i samma svep som allt annat — ingen extra Bubble-fråga. Självincheckningar
    // (via=lobby) saknar registrerad_av och räknas därför inte på någon person,
    // vilket är rätt: ingen receptionist tog emot dem.
    const besokPerRec = Object.create(null);
    let trunkerade = 0, datumfilterFallback = 0;

    for (const hid of husIds) {
      const hg = await hyresgasterFor(hid);
      const bes = await besokFor(hid, franTs);
      if (bes.trunkerad) trunkerade++;
      if (bes.datumfilter === "fallback") datumfilterFallback++;

      const namn = _str(fastNamn.get(hid));
      const dod = hg.dod || bes.dod;

      // Besök grupperade per hyresgäst — behövs både för husraden och för
      // konsekvensen i åtgärdslistan ("14 besök gick utan notis").
      const besokPerKund = new Map();
      let viaLobby = 0, viaReception = 0, nSkickad = 0, nFel = 0, nVantar = 0;
      for (const v of bes.rows) {
        const av = _ref(v[VISIT.F_AV]);
        if (av) besokPerRec[av] = (besokPerRec[av] || 0) + 1;
        const cid = _ref(v[VISIT.F_HYRESGAST]);
        if (cid) {
          if (!besokPerKund.has(cid)) besokPerKund.set(cid, { total: 0, utan_notis: 0 });
          const b = besokPerKund.get(cid); b.total++;
          if (_str(v[VISIT.F_STATUS]) !== "skickad") b.utan_notis++;
        }
        if (_str(v[VISIT.F_VIA]) === "lobby") viaLobby++; else viaReception++;
        const st = _str(v[VISIT.F_STATUS]);
        if (st === "skickad") nSkickad++;
        else if (st === "fel") { nFel++; notisFel.push({ hus_id: hid, hus: namn, kund_id: _ref(v[VISIT.F_HYRESGAST]), kanal: _str(v[VISIT.F_KANAL]), orsak: _str(v[VISIT.F_NOTIS_FEL]) || "okänd orsak", vard: _str(v[VISIT.F_VARD_NAMN]), tid: _str(v[VISIT.F_NOTIS_AT] || v[VISIT.F_IN]) }); }
        else nVantar++;
      }

      let medKontaktlista = 0;
      for (const k of hg.list) {
        const cos = coPerKund.get(k.id) || [];
        const nabara = cos.filter((c) => c.has_sms || c.has_mail);
        if (nabara.length) medKontaktlista++;
        const b = besokPerKund.get(k.id) || { total: 0, utan_notis: 0 };
        const rad = {
          kund_id: k.id, kund: k.name, hus_id: hid, hus: namn,
          vardar: cos.length, vardar_nabara: nabara.length,
          besok: b.total, besok_utan_notis: b.utan_notis,
        };
        kundRader.push(rad);
      }

      hus.push({
        id: hid, namn: namn || "(namnlös fastighet)",
        saknas: dod,
        receptionister: recPerHus.get(hid) || [],
        hyresgaster: hg.list.length,
        kontaktlistor: medKontaktlista,
        utan_kontaktlista: hg.list.length - medKontaktlista,
        besok: bes.rows.length,
        via_lobby: viaLobby, via_reception: viaReception,
        lobby_andel: _pct(viaLobby, bes.rows.length),
        notis_skickad: nSkickad, notis_fel: nFel, notis_vantar: nVantar,
        notis_fram_andel: _pct(nSkickad, nSkickad + nFel),
        trunkerad: bes.trunkerad,
        rader_hamtade: bes.rader_hamtade,
      });
    }

    const data = {
      dagar, fran: new Date(franTs).toISOString(),
      hus, receptionister: recs, kundRader, notisFel, besokPerRec,
      fastList,
      meta: { trunkerade, datumfilter_fallback: datumfilterFallback, hus_i_urval: husIds.length },
      byggd: new Date().toISOString(),
    };
    _snapCache.set(dagar, { data, ts: Date.now() });
    return data;
  }
  function snapshotForget() { _snapCache.clear(); }

  // ── Sessionsstatus ────────────────────────────────────────────────────────
  // ⚠️ Visar backends EGNA felkoder. "no_fastigheter_assigned" är exakt vad
  // /visitor/session svarar — ingen ska behöva läsa serverloggar för att förstå
  // varför någon inte kommer in (STAFF-MODULEN.md §6).
  function session(r) {
    if (!r.fastigheter.length) return { status: "nekas", kod: "no_fastigheter_assigned", exp: "", text: "Nekas" };
    const exp = _ts(r.token_exp);
    if (r.has_token && exp > Date.now()) return { status: "aktiv", kod: "", exp: r.token_exp, text: "Aktiv" };
    if (r.has_token && exp) return { status: "utloggad", kod: "token_expired", exp: r.token_exp, text: "Utloggad" };
    return { status: "utloggad", kod: "no_session", exp: "", text: "Utloggad" };
  }

  // ── Åtgärdslistan ─────────────────────────────────────────────────────────
  // Varje rad har ett VERB och en KONSEKVENS. En avvikelse utan handling är bara
  // en notis man vänjer sig vid (STAFF-MODULEN.md §6).
  function atgarder(d) {
    const ut = [];
    const dgr = d.dagar;

    for (const r of d.receptionister) {
      if (r.fastigheter.length) continue;
      ut.push({
        typ: "receptionist_utan_hus", niv: "bad", vikt: 900,
        rubrik: r.name + " saknar tilldelad fastighet",
        text: "Har rollen Receptionist men inget hus. Kan logga in men får inget att arbeta med — sessionen nekas med no_fastigheter_assigned.",
        verb: "Tilldela hus", user_id: r.id, flik: "receptionister",
      });
    }

    for (const h of d.hus) {
      if (!h.saknas) continue;
      const rn = h.receptionister.map((x) => x.namn).join(", ");
      ut.push({
        typ: "fastighet_saknas", niv: "bad", vikt: 950,
        rubrik: "Tilldelad fastighet finns inte längre",
        text: "En fastighet i " + (rn || "en receptionists") + " tilldelning är raderad i Bubble. Besök och hyresgäster kan inte läsas för den.",
        verb: "Rensa tilldelningen", hus_id: h.id, flik: "receptionister",
      });
    }

    // Kundrader: en kund kan ligga i flera hus → slå ihop, annars dubbelrapporteras den.
    const perKund = new Map();
    for (const k of d.kundRader) {
      if (!perKund.has(k.kund_id)) perKund.set(k.kund_id, { kund_id: k.kund_id, kund: k.kund, hus: [], vardar: 0, vardar_nabara: 0, besok: 0, besok_utan_notis: 0 });
      const a = perKund.get(k.kund_id);
      a.hus.push(k.hus); a.vardar = k.vardar; a.vardar_nabara = k.vardar_nabara;
      a.besok += k.besok; a.besok_utan_notis += k.besok_utan_notis;
    }
    for (const a of perKund.values()) {
      const hus = a.hus.join(", ");
      const konsekvens = a.besok_utan_notis > 0
        ? a.besok_utan_notis + " besök de senaste " + dgr + " dagarna gick utan notis; receptionisten har fått ringa varje gång."
        : (a.besok > 0
            ? a.besok + " besök de senaste " + dgr + " dagarna."
            : "Inga besök ännu — men första gästen kan inte aviseras.");
      if (a.vardar === 0) {
        ut.push({
          typ: "kund_utan_kontaktlista", niv: "bad", vikt: 800 + Math.min(a.besok_utan_notis, 99),
          rubrik: a.kund + " (" + hus + ") — ingen kontaktlista",
          text: "Inga registrerade värdar alls. " + konsekvens,
          verb: "Kontakta kunden", kund_id: a.kund_id, flik: "hus",
        });
      } else if (a.vardar_nabara === 0) {
        ut.push({
          typ: "kund_utan_kontaktvag", niv: "bad", vikt: 800 + Math.min(a.besok_utan_notis, 99),
          rubrik: a.kund + " (" + hus + ") — ingen kan nås",
          text: "Alla " + a.vardar + " värdar saknar både mobil och e-post. " + konsekvens,
          verb: "Kontakta kunden", kund_id: a.kund_id, flik: "hus",
        });
      } else if (a.vardar_nabara < a.vardar) {
        ut.push({
          typ: "vardar_utan_kontaktvag", niv: "warn", vikt: 400 + (a.vardar - a.vardar_nabara),
          rubrik: (a.vardar - a.vardar_nabara) + " av " + a.vardar + " värdar hos " + a.kund + " går inte att nå",
          text: "Saknar både mobil och e-post. Besök till dem går utan notis och receptionisten får söka upp värden själv.",
          verb: "Komplettera uppgifter", kund_id: a.kund_id, flik: "hus",
        });
      }
    }

    for (const h of d.hus) {
      if (!h.notis_fel) continue;
      const orsaker = new Map();
      for (const f of d.notisFel) { if (f.hus_id !== h.id) continue; orsaker.set(f.orsak, (orsaker.get(f.orsak) || 0) + 1); }
      const topp = Array.from(orsaker.entries()).sort((a, b) => b[1] - a[1])[0];
      ut.push({
        typ: "notiser_fel", niv: "bad", vikt: 700 + Math.min(h.notis_fel, 99),
        rubrik: h.notis_fel + " notiser gick inte fram i " + h.namn,
        text: "Vanligaste orsaken: " + (topp ? topp[0] + " (" + topp[1] + " st)" : "okänd") + ". Gästen stod i lobbyn utan att värden fick veta det.",
        verb: "Se felorsakerna", hus_id: h.id, flik: "notiser",
      });
    }

    for (const h of d.hus) {
      if (!h.trunkerad) continue;
      ut.push({
        typ: "trunkerad", niv: "warn", vikt: 500,
        rubrik: "Siffrorna för " + h.namn + " är ofullständiga",
        text: "Fler än " + (MAX_SIDOR * 100) + " besök i perioden — hämtningen kapades. Korta perioden eller hör av dig, taket behöver höjas.",
        verb: "Korta perioden", hus_id: h.id, flik: "hus",
      });
    }

    ut.sort((a, b) => b.vikt - a.vikt);
    return ut;
  }

  function kpi(d) {
    let besok = 0, lobby = 0, skickad = 0, fel = 0;
    for (const h of d.hus) { besok += h.besok; lobby += h.via_lobby; skickad += h.notis_skickad; fel += h.notis_fel; }
    const kunder = new Map();
    for (const k of d.kundRader) kunder.set(k.kund_id, k);
    let utanLista = 0;
    for (const k of kunder.values()) if (k.vardar_nabara === 0) utanLista++;
    let kanEjJobba = 0;
    for (const r of d.receptionister) if (!r.fastigheter.length) kanEjJobba++;
    return {
      besok, dagar: d.dagar,
      via_lobby_andel: _pct(lobby, besok),
      notis_fel: fel, notis_fel_andel: _pct(fel, skickad + fel),
      kunder_utan_kontaktvag: utanLista, kunder_totalt: kunder.size,
      receptionister_totalt: d.receptionister.length, receptionister_kan_ej_jobba: kanEjJobba,
      hus: d.hus.length,
    };
  }

  const _dagar = (q) => { const n = Math.round(Number(q)); return (Number.isFinite(n) && n >= 1 && n <= 90) ? n : 7; };
  const _fresh = (q) => _str(q) === "1";

  // ── GET /admin/staff/oversikt ─────────────────────────────────────────────
  app.options("/admin/staff/oversikt", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/admin/staff/oversikt", async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const d = await snapshot(_dagar(req.query.dagar), _fresh(req.query.fresh));
      return res.json({ ok: true, dagar: d.dagar, kpi: kpi(d), atgarder: atgarder(d), meta: d.meta, byggd: d.byggd });
    } catch (e) { return fel(res, e, "/admin/staff/oversikt"); }
  });

  // ── GET /admin/staff/receptionister ───────────────────────────────────────
  app.options("/admin/staff/receptionister", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/admin/staff/receptionister", async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const d = await snapshot(_dagar(req.query.dagar), _fresh(req.query.fresh));
      const husNamn = new Map(d.fastList.map((f) => [f.id, f.name]));
      // Besök per receptionist: signeringen (registrerad_av) på besöksraderna i
      // hens egna hus. Räknas ur ögonblicksbilden — ingen extra Bubble-fråga.
      const rader = d.receptionister.map((r) => {
        const s = session(r);
        return {
          id: r.id, namn: r.name, email: r.email,
          fastigheter: r.fastigheter.map((f) => ({ id: f, namn: husNamn.get(f) || "(raderad fastighet)", saknas: !husNamn.has(f) })),
          session: s,
          kan_jobba: s.status !== "nekas",
          besok: d.besokPerRec[r.id] || 0,
        };
      });
      const kand = await kandidater(req);
      return res.json({
        ok: true, dagar: d.dagar, total: rader.length, rader,
        fastigheter: d.fastList, byggd: d.byggd,
        kandidater: kand.kandidater, roller: kand.roller,
        bolag: kand.bolag, kandidater_ofiltrerade: kand.ofiltrerade || undefined,
      });
    } catch (e) { return fel(res, e, "/admin/staff/receptionister"); }
  });

  // ── POST /admin/staff/receptionister/:id/fastigheter ──────────────────────
  // ⚠️ SÄKERHETSRELEVANT (STAFF-MODULEN.md §3 / BESOKSHANTERING.md §7.5.3c).
  // /visitor/context läser fastigheterna ur TOKENENS payload, inte färskt ur User.
  // Utan att tokenen nollas släpar en ändring upp till 12 h — och en avaktiverad
  // receptionist behåller sin åtkomst lika länge. Bubble-triggern är primär; det
  // här är bälte och hängslen, och det är rätt ställe för det.
  app.options("/admin/staff/receptionister/:id/fastigheter", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.post("/admin/staff/receptionister/:id/fastigheter", async (req, res) => {
    if (!gate(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    const b = req.body || {};
    if (!Array.isArray(b.fastigheter)) return res.status(400).json({ ok: false, error: "fastigheter_must_be_array" });
    const onskade = Array.from(new Set(b.fastigheter.map((v) => _str(v).trim()).filter(Boolean)));
    try {
      // Validera mot fastighetslistan FÖRE skrivning. Ett okänt id skulle bli en
      // död referens som sedan 400:ar varje query som rör huset.
      const fastList = await fastighetDirectory();
      const kanda = new Set(fastList.map((f) => f.id));
      const okanda = onskade.filter((f) => !kanda.has(f));
      if (okanda.length) return res.status(400).json({ ok: false, error: "unknown_fastighet", okanda });

      const u = await bubbleGet(STAFF.USER, id);
      if (!u) return res.status(404).json({ ok: false, error: "user_not_found", user_id: id });
      const role = _osVal(u[STAFF.ROLE]);
      // Samma krav som /visitor/session. Att tilldela hus till någon utan rollen
      // ger ingen åtkomst men ser ut att göra det — vi svarar hellre begripligt.
      if (role !== STAFF.ROLE_VALUE) return res.status(409).json({ ok: false, error: "not_receptionist", role: role || null });

      await bubblePatch(STAFF.USER, id, { [STAFF.FASTIGHETER]: onskade });

      // ⚠️ LÄS ALLTID TILLBAKA RADEN. bubblePatch droppar okända fält tyst
      // ([[reference-bubble-tysta-faltdrop]]) — "sparat" utan verifiering är en gissning.
      const fresh = await bubbleGet(STAFF.USER, id);
      const raw = fresh ? fresh[STAFF.FASTIGHETER] : null;
      const skrivna = (Array.isArray(raw) ? raw : (raw == null || raw === "" ? [] : [raw]))
        .map((v) => (typeof v === "string" ? v : (v && (v._id || v.id)) || null)).filter(Boolean);
      const samma = skrivna.length === onskade.length && onskade.every((f) => skrivna.indexOf(f) > -1);
      if (!samma) {
        return res.status(500).json({ ok: false, error: "fastigheter_ej_skrivna", onskade, skrivna,
          hint: "Fältnamnet " + STAFF.FASTIGHETER + " kan vara felstavat eller ha annan versalisering i Bubble." });
      }

      const tok = await _rensaToken(id);
      usersForget && usersForget();     // receptionistlistan hämtas ur User-svepet
      snapshotForget();

      return res.json({
        ok: true, id, fastigheter: onskade,
        token_rensad: tok.ok, token_falt: tok.falt, token_fel: tok.fel,
        // Nollas inte tokenen slår ändringen inte igenom förrän den gamla går ut.
        varning: tok.ok ? null : "Sessionen kunde INTE nollas — den gamla tilldelningen gäller tills tokenen går ut (upp till 12 h). Töm visitor_token på användaren i Bubble App data.",
      });
    } catch (e) { return fel(res, e, "/admin/staff/receptionister/:id/fastigheter"); }
  });

  // ── Kandidater: våra egna users som ännu inte är receptionister ───────────
  // ⚠️ VÅRT bolag = den inloggades `user_company` (från blocket), annars env.
  // Utan någotdera filtreras INGET bort — men det SÄGS (`ofiltrerade`). Ett tyst
  // felaktigt filter vore värre än en synlig varning; samma val som _ourUsers()
  // i companies_api gör för kundansvarig-listan.
  function vartBolag(req) {
    return _str((req.query && req.query.user_company) || (req.body && req.body.user_company)).trim()
        || _str(CAROTTE_COMPANY_ID).trim();
  }
  async function kandidater(req) {
    const dir = await userRoleDirectory();
    const bolag = vartBolag(req);
    const alla = dir.users.filter((u) => u.role !== STAFF.ROLE_VALUE);
    const mina = bolag ? alla.filter((u) => u.company_id === bolag) : alla;
    return {
      bolag: bolag || null,
      ofiltrerade: bolag ? false : true,
      // ⚠️ `Receptionist` läggs ALLTID till i väljaren, även om ingen bär den ännu.
      // Härledningen ur datan har ett moment 22 för ett värde som ska sättas för
      // FÖRSTA gången — och värdet är inte en gissning: /visitor/session jämför
      // hårt mot exakt den strängen (index.js), så det är ett kontrakt.
      roller: Array.from(new Set((dir.roles || []).concat([STAFF.ROLE_VALUE])))
        .sort((a, b) => a.localeCompare(b, "sv")),
      kandidater: mina.map((u) => ({ id: u.id, namn: u.name, email: u.email, roll: u.role || "" }))
        .sort((a, b) => a.namn.localeCompare(b.namn, "sv")),
    };
  }

  // ── POST /admin/staff/receptionister/:id/roll — sätt/ta bort rollen ────────
  // ⚠️ SÄKERHETSRELEVANT ÅT BÅDA HÅLLEN. Att SÄTTA rollen öppnar besökssystemet för
  // personen; att TA BORT den ska stänga det direkt, inte om 12 h. Därför nollas
  // visitor_token vid varje rollbyte — samma skäl som vid tilldelning (§3).
  app.options("/admin/staff/receptionister/:id/roll", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.post("/admin/staff/receptionister/:id/roll", async (req, res) => {
    if (!gate(req, res)) return;
    const id = _str(req.params.id).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    const roll = _str(req.body && req.body.roll).trim();
    if (!roll) return res.status(400).json({ ok: false, error: "missing_roll" });
    try {
      // ⚠️ FAIL-CLOSED: utan att veta vilket bolag som är vårt får vi inte dela ut en
      // roll som ger åtkomst till besökssystemet. En kundanvändare som råkar bli
      // receptionist ser hyresgästernas kontaktlistor.
      const bolag = vartBolag(req);
      if (!bolag) {
        return res.status(400).json({ ok: false, error: "carotte_company_id_missing",
          hint: "sätt CAROTTE_COMPANY_ID i env eller bind data-mira=\"user_company\" i blocket" });
      }
      const dir = await userRoleDirectory();
      const tillatna = new Set((dir.roles || []).concat([STAFF.ROLE_VALUE]));
      // Option-set-värden är case-sensitiva och ett okänt värde ger ett opakt
      // Bubble-fel — validera mot de värden som FAKTISKT finns i datan först.
      if (!tillatna.has(roll)) {
        return res.status(400).json({ ok: false, error: "unknown_roll", roll, tillatna: Array.from(tillatna).sort() });
      }
      const u = await bubbleGet(STAFF.USER, id);
      if (!u) return res.status(404).json({ ok: false, error: "user_not_found", user_id: id });
      const nuvarande = _osVal(u[STAFF.ROLE]);
      const userBolag = _ref(u.Company);
      if (userBolag !== bolag) {
        return res.status(403).json({ ok: false, error: "not_our_user", user_company: userBolag || null, vart_bolag: bolag,
          hint: "Rollen får bara sättas på en användare i vårt eget bolag." });
      }
      if (nuvarande === roll) return res.json({ ok: true, id, roll, oforandrad: true, token_rensad: null });

      await bubblePatch(STAFF.USER, id, { [STAFF.ROLE]: roll });

      // ⚠️ Läs tillbaka. Ett option-set-fält som inte tar värdet kan skrivas "utan fel".
      const fresh = await bubbleGet(STAFF.USER, id);
      const nu = _osVal(fresh ? fresh[STAFF.ROLE] : null);
      if (nu !== roll) {
        return res.status(500).json({ ok: false, error: "roll_ej_skriven", onskad: roll, skriven: nu || null,
          hint: "Värdet " + roll + " finns kanske inte i option-setet " + STAFF.ROLE + " (case-sensitivt)." });
      }

      const tok = await _rensaToken(id);
      usersForget && usersForget();
      snapshotForget();

      return res.json({
        ok: true, id, roll, tidigare: nuvarande || null,
        token_rensad: tok.ok, token_falt: tok.falt, token_fel: tok.fel,
        varning: tok.ok ? null : "Rollen är satt men sessionen kunde INTE nollas — den gamla behörigheten gäller tills tokenen går ut (upp till 12 h). Töm visitor_token på användaren i Bubble App data.",
        // dashboard_crm har en page-load-guard som skickar Receptionist till /visitor.
        crm_atkomst: roll === STAFF.ROLE_VALUE ? false : true,
      });
    } catch (e) { return fel(res, e, "/admin/staff/receptionister/:id/roll"); }
  });

  // Nollar visitor_token i en EGEN patch. ⚠️ Bubble avvisar HELA patchen vid ett
  // okänt fält ([[reference-bubble-data-api-keys]]) — låg tokennollningen i samma
  // patch som fastigheterna hade ett felstavat tokenfält gjort tilldelningen till
  // en no-op. Versaliseringen skiljer sig mellan dokumentationsraderna, så båda
  // formerna provas och den som bet rapporteras.
  async function _rensaToken(userId) {
    let sist = null;
    for (const falt of STAFF.TOKEN_NAMN) {
      try { await bubblePatch(STAFF.USER, userId, { [falt]: "" }); return { ok: true, falt, fel: null }; }
      catch (e) {
        sist = { falt, status: _status(e), kropp: _felkropp(e).slice(0, 300) };
        if (_status(e) !== 400) break;      // 5xx/nätfel → sluta prova, rapportera
      }
    }
    console.error("[staff] visitor_token kunde inte nollas för " + userId, JSON.stringify(sist));
    return { ok: false, falt: null, fel: sist };
  }

  // ── GET /admin/staff/hus — besöksuppsättningar ────────────────────────────
  app.options("/admin/staff/hus", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/admin/staff/hus", async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const d = await snapshot(_dagar(req.query.dagar), _fresh(req.query.fresh));
      // Kunder utan kontaktväg listas per hus — kolumnen "Kontaktlistor" ska gå
      // att öppna, annars är den bara en siffra man inte kan agera på.
      const utanPerHus = new Map();
      for (const k of d.kundRader) {
        if (k.vardar_nabara > 0) continue;
        if (!utanPerHus.has(k.hus_id)) utanPerHus.set(k.hus_id, []);
        utanPerHus.get(k.hus_id).push({ kund_id: k.kund_id, kund: k.kund, vardar: k.vardar, besok: k.besok, besok_utan_notis: k.besok_utan_notis });
      }
      const rader = d.hus.map((h) => Object.assign({}, h, { utan_kontaktvag: (utanPerHus.get(h.id) || []).sort((a, b) => b.besok - a.besok) }));
      return res.json({ ok: true, dagar: d.dagar, total: rader.length, rader, meta: d.meta, byggd: d.byggd });
    } catch (e) { return fel(res, e, "/admin/staff/hus"); }
  });

  // ── GET /admin/staff/notiser — notisstatistik + felorsaker ────────────────
  app.options("/admin/staff/notiser", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/admin/staff/notiser", async (req, res) => {
    if (!gate(req, res)) return;
    const husFilter = _str(req.query.fastighet).trim();
    try {
      const d = await snapshot(_dagar(req.query.dagar), _fresh(req.query.fresh));
      if (husFilter && !d.hus.some((h) => h.id === husFilter)) {
        return res.status(404).json({ ok: false, error: "unknown_fastighet", fastighet: husFilter });
      }
      const hus = d.hus.filter((h) => !husFilter || h.id === husFilter)
        .map((h) => ({ id: h.id, namn: h.namn, skickad: h.notis_skickad, fel: h.notis_fel, vantar: h.notis_vantar,
                       fram_andel: h.notis_fram_andel, besok: h.besok }));

      const kundNamn = new Map(d.kundRader.map((k) => [k.kund_id, k.kund]));
      const perKund = new Map();
      for (const f of d.notisFel) {
        if (husFilter && f.hus_id !== husFilter) continue;
        const nyckel = f.kund_id || "-";
        if (!perKund.has(nyckel)) perKund.set(nyckel, { kund_id: f.kund_id, kund: kundNamn.get(f.kund_id) || "(okänd hyresgäst)", hus: f.hus, fel: 0, orsaker: new Map() });
        const a = perKund.get(nyckel); a.fel++;
        a.orsaker.set(f.orsak, (a.orsaker.get(f.orsak) || 0) + 1);
      }
      const kunder = Array.from(perKund.values()).map((a) => ({
        kund_id: a.kund_id, kund: a.kund, hus: a.hus, fel: a.fel,
        orsaker: Array.from(a.orsaker.entries()).map((e) => ({ orsak: e[0], antal: e[1] })).sort((x, y) => y.antal - x.antal),
      })).sort((a, b) => b.fel - a.fel);

      const orsaker = new Map();
      for (const f of d.notisFel) { if (husFilter && f.hus_id !== husFilter) continue; orsaker.set(f.orsak, (orsaker.get(f.orsak) || 0) + 1); }

      let skickad = 0, fel = 0, vantar = 0;
      for (const h of hus) { skickad += h.skickad; fel += h.fel; vantar += h.vantar; }
      return res.json({
        ok: true, dagar: d.dagar, fastighet: husFilter || null,
        summa: { skickad, fel, vantar, fram_andel: _pct(skickad, skickad + fel) },
        hus, kunder,
        orsaker: Array.from(orsaker.entries()).map((e) => ({ orsak: e[0], antal: e[1] })).sort((a, b) => b.antal - a.antal),
        meta: d.meta, byggd: d.byggd,
      });
    } catch (e) { return fel(res, e, "/admin/staff/notiser"); }
  });

  // ── GET /admin/staff/kluster — UI-genväg vid tilldelning ──────────────────
  // ⚠️ EGEN endpoint med flit. Kluster LAGRAS aldrig i receptionist_fastigheter
  // (BESOKSHANTERING.md §7.5.2) — de rullas ut till fastigheter i UI:t, så en ny
  // fastighet i klustret inte tyst ger någon åtkomst. Och ligger typen inte i
  // Data API:t får det fälla den här knappen, inte hela tilldelningsvyn.
  app.options("/admin/staff/kluster", (req, res) => { cors(req, res); res.sendStatus(204); });
  app.get("/admin/staff/kluster", async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const rows = await bubbleFindAll("Cluster", {});
      const fastList = await fastighetDirectory();
      const kanda = new Set(fastList.map((f) => f.id));
      const ut = (rows || []).map((c) => {
        const fast = (Array.isArray(c.Fastighet) ? c.Fastighet : (c.Fastighet ? [c.Fastighet] : []))
          .map((v) => (typeof v === "string" ? v : (v && (v._id || v.id)) || null))
          .filter((f) => f && kanda.has(f));
        return { id: bubbleId(c), namn: _str(c.Titel), fastigheter: fast };
      }).filter((c) => c.id && c.namn && c.fastigheter.length);
      ut.sort((a, b) => a.namn.localeCompare(b.namn, "sv"));
      return res.json({ ok: true, total: ut.length, kluster: ut });
    } catch (e) { return fel(res, e, "/admin/staff/kluster"); }
  });

  return { snapshotForget, _internals: { snapshot, atgarder, kpi, session, besokFor, hyresgasterFor } };
}
