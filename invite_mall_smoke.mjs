// Smoke: inbjudningsmallen i emailer.js (CTA-kontrast, CTA-centrering, deadline).
//   node invite_mall_smoke.mjs
//
// emailer.js importeras INTE (kräver node-cron + är sidoeffektsfylld) — funktioner
// klipps ut ur källan och evalas, samma teknik som komm_blocks_smoke.mjs.
// Ett utklipp som inte hittas blir ETT rött kryss, aldrig en krasch: annars blir
// mutationstestet (git stash → gammal kod) tyst värdelöst.
import fs from "node:fs";

const SRC = fs.readFileSync("./emailer.js", "utf8");
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

function slice(startNeedle, endNeedle, label) {
  const a = SRC.indexOf(startNeedle);
  const b = a < 0 ? -1 : SRC.indexOf(endNeedle, a);
  if (a < 0 || b < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${startNeedle}"`); return ""; }
  return SRC.slice(a, b + endNeedle.length);
}

// ── Utklipp: kontrastfärg + datumformatering ───────────────────────────────
const srcCtaInk  = slice("function ctaInk(", "\n}", "ctaInk");
const srcDateish = slice("function _dateish(", "\n}", "_dateish");
const srcFmtDate = slice("function fmtDate(", "\n}", "fmtDate");

let ctaInk = () => "(ctaInk saknas)";
let fmtDate = () => "(fmtDate saknas)";
// Saknas _dateish (gammal kod) faller vi tillbaka på new Date — då mäter
// fmtDate-testerna fortfarande fmtDate, i stället för att alla faller på evalen.
const dateishOrStub = srcDateish || "function _dateish(v){ return new Date(v); }";
try {
  const mk = new Function(`${srcCtaInk || "function ctaInk(){ return '(ctaInk saknas)'; }"}\n${dateishOrStub}\n${srcFmtDate}\nreturn { ctaInk, fmtDate };`);
  const m = mk();
  if (typeof m.ctaInk === "function") ctaInk = m.ctaInk;
  if (typeof m.fmtDate === "function") fmtDate = m.fmtDate;
} catch (e) {
  fail++; console.log("  ✗ [eval] kunde inte eval:a utklippen — " + (e?.message || e));
}

// ── 1. CTA-knappens text måste vara läsbar oavsett vald accentfärg ─────────
// Accenten sätts fritt per utskick (färgväljare i kommunikationsadmin). En ljus
// sand/beige gav tidigare vit text på ljus knapp = oläsbar.
sec("CTA-kontrast (ctaInk)");
ok("ljus sand #e8dcc8 -> mörk text",        ctaInk("#e8dcc8") === "#0d1117");
ok("vit #ffffff -> mörk text",              ctaInk("#ffffff") === "#0d1117");
ok("mörk #0d1117 -> vit text",              ctaInk("#0d1117") === "#ffffff");
ok("marinblå #1b2a4a -> vit text",          ctaInk("#1b2a4a") === "#ffffff");
ok("turkos #2bb6a3 -> mörk text",           ctaInk("#2bb6a3") === "#0d1117");
ok("kortform #fff -> mörk text",            ctaInk("#fff")    === "#0d1117");
ok("tom accent -> vit text (fallback)",     ctaInk("")        === "#ffffff");
ok("skräpvärde -> vit text (fallback)",     ctaInk("rgb(1,2,3)") === "#ffffff");

// ── 2. Sista anmälan: hela datumet, inte bara dagsiffran ───────────────────
// Buggen: fmtDateTime(...).split(" ")[0] gav "10" i stället för "10 september 2026".
sec("Deadline-datum (fmtDate)");
ok('ISO -> "10 september 2026" (fick: ' + fmtDate("2026-09-10T21:59:00.000Z") + ")",
   fmtDate("2026-09-10T21:59:00.000Z") === "10 september 2026");
ok("ms-sträng parsas som ms-tal (Bubble kan ge båda)",
   fmtDate("1757541540000") === fmtDate(1757541540000) && /\d{4}$/.test(String(fmtDate("1757541540000"))));
ok("tomt värde -> tom sträng", fmtDate("") === "" && fmtDate(null) === "");

// ── 3. Källkodskontrakt i wrapLayout / tmplInviteInvitation ────────────────
sec("Källkodskontrakt");
const srcCta = slice("const ctaBlock = ctaLabel && ctaUrl", "    : miraNote", "ctaBlock");
ok("CTA-texten hämtas från ctaInk(accent), inte hårdkodad vit",
   /color:\$\{ctaInk\(accent\)\}/.test(srcCta) && !/color:#ffffff/.test(srcCta));
ok("CTA-knappen ligger i en cell vars align styrs av ctaAlign",
   /align="\$\{ctaAlign === "center" \? "center" : "left"\}"/.test(srcCta));
ok("wrapLayout tar emot ctaAlign (default left)", /ctaAlign = "left"/.test(SRC));

const srcInv = slice("async function tmplInviteInvitation(", "\n}", "tmplInviteInvitation");
ok("inbjudningsmallen centrerar sin CTA", /ctaAlign:\s*"center"/.test(srcInv));
ok("deadline använder fmtDate (inte avklippt fmtDateTime)",
   /const deadline = x\.rsvp_deadline \? fmtDate\(x\.rsvp_deadline\) : ""/.test(srcInv));
ok('ingen split(" ")[0] kvar på deadline-raden', !/rsvp_deadline[^\n]*split\("\s"\)\[0\]/.test(srcInv));

console.log(`\n${fail ? "✗" : "✓"} ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
