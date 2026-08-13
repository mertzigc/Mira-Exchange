// Smoke: framåt-bara Deal-status-progression. node deal_status_smoke.mjs
import { DEAL_STATUS_RANK, shouldAdvanceDealStatus } from "./deal_status.js";

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
const S = shouldAdvanceDealStatus;

// ── framåt: går ──
ok("tom → Avtal", S("", "Avtal") === true);
ok("null → Avtal", S(null, "Avtal") === true);
ok("Kundkontakt → Avtal", S("Kundkontakt", "Avtal") === true);
ok("Delegerad → Avtal (lead-skapad → signerad)", S("Delegerad", "Avtal") === true);
ok("Offert → Avtal", S("Offert", "Avtal") === true);
ok("Kundkontakt → Offert", S("Kundkontakt", "Offert") === true);
ok("Avtal → Avslutad", S("Avtal", "Avslutad") === true);

// ── samma nivå: nej (idempotent, ingen onödig patch) ──
ok("Avtal → Avtal (idempotent)", S("Avtal", "Avtal") === false);
ok("Kundkontakt → Kundkontakt", S("Kundkontakt", "Kundkontakt") === false);
ok("Delegerad → Kundkontakt (samma rank)", S("Delegerad", "Kundkontakt") === false);

// ── bakåt: ALDRIG nedgradera ──
ok("Avtal → Offert (ingen nedgradering)", S("Avtal", "Offert") === false);
ok("Avslutad → Avtal (ingen nedgradering)", S("Avslutad", "Avtal") === false);
ok("Avtal → Kundkontakt (ingen nedgradering)", S("Offert", "Kundkontakt") === false);
ok("Avslutad → Offert", S("Avslutad", "Offert") === false);

// ── ogiltiga ──
ok("ogiltigt target → false", S("Kundkontakt", "Trams") === false);
ok("tomt target → false", S("Kundkontakt", "") === false);
ok("okänt nuvarande behandlas som rank 0 → Avtal går", S("Nåntingskonstigt", "Avtal") === true);

// ── whitespace-tolerans ──
ok("nuvarande med whitespace matchar", S(" Avtal ", "Avslutad") === true && S(" Avtal ", "Avtal") === false);

// ── rank-tabell sanity ──
ok("rank: Kundkontakt<Offert<Avtal<Avslutad", DEAL_STATUS_RANK.Kundkontakt < DEAL_STATUS_RANK.Offert && DEAL_STATUS_RANK.Offert < DEAL_STATUS_RANK.Avtal && DEAL_STATUS_RANK.Avtal < DEAL_STATUS_RANK.Avslutad);
ok("Delegerad samma rank som Kundkontakt", DEAL_STATUS_RANK.Delegerad === DEAL_STATUS_RANK.Kundkontakt);

// ── stegvis tratt: offert SKICKAS → Offert, SIGNERAS → Avtal, abonnemang → Avtal ──
ok("offert skickas: Kundkontakt → Offert", S("Kundkontakt", "Offert") === true);
ok("offert skickas: Delegerad → Offert (lead-skapad)", S("Delegerad", "Offert") === true);
ok("offert skickas igen (redan Offert): ingen dubbelpatch", S("Offert", "Offert") === false);
ok("offert skickas på redan-Avtal-affär: ingen nedgradering", S("Avtal", "Offert") === false);
ok("offert signeras: Offert → Avtal (steget efter skicka)", S("Offert", "Avtal") === true);
ok("abonnemang skapas när redan Avtal: ingen dubbelpatch", S("Avtal", "Avtal") === false);

console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
if (fail) process.exit(1);
