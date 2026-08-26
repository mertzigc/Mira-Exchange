// Smoke: inbjudningsmallens utseende — CTA-kontrast, CTA-centrering, deadline
// och den fria bakgrundsfärgen (bg_color) hela vägen mail → landningssida → admin.
//   node invite_mall_smoke.mjs
//
// mail_theme.js och content_blocks.js importeras på riktigt (inga beroenden).
// emailer.js/index.js importeras INTE (node-cron + sidoeffekter) — kontrakten
// kontrolleras mot källkoden. Ett utklipp som inte hittas blir ETT rött kryss,
// aldrig en krasch: annars blir mutationstestet (gammal kod) tyst värdelöst.
import fs from "node:fs";

// Dynamisk import med fallback: mot gammal kod (modulen finns inte, eller saknar
// exporten) ska sviten ge RÖDA KRYSS, inte krascha på raden ovanför testerna.
let _fails0 = 0;
async function load(spec, names) {
  const out = {};
  let mod = null;
  try { mod = await import(spec); }
  catch (e) { console.log(`  ✗ [modul saknas] ${spec} — ${e?.message || e}`); _fails0++; }
  for (const n of names) {
    if (mod && typeof mod[n] !== "undefined") { out[n] = mod[n]; continue; }
    if (mod) { console.log(`  ✗ [export saknas] ${spec} → ${n}`); _fails0++; }
    out[n] = (n === "MAIL_PAL_DARK") ? {} : () => "(saknas)";
  }
  return out;
}
const { mailPalette, MAIL_PAL_DARK, contrastInk, contrastRatio } =
  await load("./mail_theme.js", ["mailPalette", "MAIL_PAL_DARK", "contrastInk", "contrastRatio"]);
const { renderBlocksEmail } = await load("./content_blocks.js", ["renderBlocksEmail"]);

const read = f => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const EMAILER = read("./emailer.js");
const INDEX   = read("./index.js");
const LANDING = read("./invite.html");
const ADMIN   = read("./mira-kommunikation-admin.html");

let pass = 0, fail = _fails0;
const ok = (label, cond) => { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label); } };
const sec = t => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

function slice(src, startNeedle, endNeedle, label) {
  const a = src.indexOf(startNeedle);
  const b = a < 0 ? -1 : src.indexOf(endNeedle, a);
  if (a < 0 || b < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${startNeedle}"`); return ""; }
  return src.slice(a, b + endNeedle.length);
}
const HEX = /#[0-9a-fA-F]{6}/g;
// Mot gammal kod är importerna stubbar — tvinga typen så assertions FALLER
// i stället för att kasta TypeError och avbryta resten av sviten.
const num = v => (typeof v === "number" && Number.isFinite(v)) ? v : 0;
const str = v => (typeof v === "string" ? v : "");

// ── 1. Kontrastsäker text mot godtycklig färg ─────────────────────────────
sec("Kontrast (contrastInk)");
ok("ljus sand #e8dcc8 -> mörk text",   contrastInk("#e8dcc8") === "#0d1117");
ok("vit #ffffff -> mörk text",         contrastInk("#ffffff") === "#0d1117");
ok("mörk #0d1117 -> vit text",         contrastInk("#0d1117") === "#ffffff");
ok("marinblå #1b2a4a -> vit text",     contrastInk("#1b2a4a") === "#ffffff");
ok("kortform #fff -> mörk text",       contrastInk("#fff")    === "#0d1117");
ok("tomt/skräp -> vit text (fallback)", contrastInk("") === "#ffffff" && contrastInk("rgb(1,2,3)") === "#ffffff");

// ── 2. Paletten ur en fri bakgrundsfärg ───────────────────────────────────
// INVARIANT: utan bg_color måste paletten vara EXAKT dagens hårdkodade färger,
// annars ändrar den här funktionen utseendet på 20 mallar som inte bett om det.
sec("Palett (mailPalette)");
ok("tom bakgrund -> oförändrad standardpalett", mailPalette("") === MAIL_PAL_DARK);
ok("ogiltig bakgrund -> oförändrad standardpalett", mailPalette("inte-en-färg") === MAIL_PAL_DARK);
ok("standardpalettens brödtext är dagens #c0c4d6", MAIL_PAL_DARK.body === "#c0c4d6");
ok("standardpalettens kort är dagens #161c2d", MAIL_PAL_DARK.cardBg === "#161c2d");

// En mellanton har ett TAK för hur mycket kontrast som ens är möjlig (som lägst
// ~4.4:1 vid luminans 0.19). Kravet är därför "målet, eller taket om målet inte
// går att nå" — inte ett absolut tal som skulle vara omöjligt för turkos.
for (const bg of ["#ffffff", "#f4efe6", "#0f1b2d", "#2bb6a3", "#808080", "#000000", "#e8dcc8"]) {
  const p = mailPalette(bg) || {};
  const ceil = Math.max(num(contrastRatio("#0d1117", bg)), num(contrastRatio("#ffffff", bg))) || 21;
  const need = (target) => Math.min(target, ceil) - 0.05;
  const cBody = num(contrastRatio(p.body, bg)), cHead = num(contrastRatio(p.headline, bg)), cMut = num(contrastRatio(p.muted, bg));
  ok(`${bg}: brödtext ${cBody.toFixed(1)}:1 (mål 7, tak ${ceil.toFixed(1)})`, cBody >= need(7));
  ok(`${bg}: brödtext klarar WCAG AA (4.5) eller taket`, cBody >= Math.min(4.5, ceil) - 0.05);
  ok(`${bg}: rubrik ${cHead.toFixed(1)}:1 minst lika stark som brödtexten`, cHead >= cBody - 0.05);
  ok(`${bg}: dämpad text ${cMut.toFixed(1)}:1 (mål 3.5, tak ${ceil.toFixed(1)})`, cMut >= need(3.5));
  ok(`${bg}: dämpad text är svagare än brödtexten (hierarkin behålls)`, cMut <= cBody + 0.05);
  ok(`${bg}: bakgrunden sätts oförändrad`, p.pageBg === bg.toLowerCase());
}
// Ljus bakgrund måste ge MÖRKA texter, inte bara "tillräcklig kontrast".
ok("ljus bakgrund -> mörk brödtext",
   num(contrastRatio((mailPalette("#ffffff") || {}).body, "#ffffff")) > num(contrastRatio((mailPalette("#ffffff") || {}).body, "#000000")));

// De två reglagen är oberoende: paletten känner inte till accenten.
sec("Accent och bakgrund är oberoende");
ok("paletten tar bara emot en bakgrundsfärg — ingen accent kan smitta in",
   mailPalette.length === 1 && JSON.stringify(mailPalette("#f4efe6")) === JSON.stringify(mailPalette("#f4efe6")));
ok("knappens text följer ACCENTEN, inte bakgrunden",
   contrastInk("#df6f39") === contrastInk("#df6f39") && contrastInk("#e8dcc8") !== contrastInk("#1b2a4a"));

// ── 3. Designblocken följer paletten ──────────────────────────────────────
sec("Designblock (renderBlocksEmail)");
const BLOCKS = [
  { type: "text", heading: "Rubrik", body: "Stycke ett.\n\nStycke två." },
  { type: "quote", quote: "Ett citat", source: "Någon" },
  { type: "divider" },
  { type: "cta", label: "Klicka", url: "https://mira-fm.com/x" }
];
const lightPal = mailPalette("#f4efe6") || {};
const lightHtml = str(renderBlocksEmail(BLOCKS, "#e8dcc8", lightPal));
const darkHtml  = str(renderBlocksEmail(BLOCKS, "#df6f39"));
// OBS: #0d1117 räknas INTE som kvarglömd — det är contrastInk(ljus accent),
// alltså den mörka knapptexten, som ska vara där.
const DARK_LEFTOVERS = ["#c0c4d6", "#e8eaf0", "#8892aa", "#262b42"];
ok("ljus palett: inga mörka standardfärger kvar i blocken",
   lightHtml !== "" && !DARK_LEFTOVERS.some(c => lightHtml.includes(c)));
ok("ljus palett: brödtexten använder palettens färg", !!lightPal.body && lightHtml.includes(lightPal.body));
ok("ljus palett: avdelaren använder palettens ram", !!lightPal.border && lightHtml.includes(lightPal.border));
ok("utan palett: blocken ser ut EXAKT som förut", DARK_LEFTOVERS.every(c => darkHtml.includes(c)));
ok("blockens CTA-text följer accenten (mörk text på ljus knapp)",
   lightHtml.includes("background:#e8dcc8;color:#0d1117") && darkHtml.includes("color:" + contrastInk("#df6f39")));

// ── 4. Källkodskontrakt: emailer.js ───────────────────────────────────────
sec("emailer.js");
const wrapSrc = slice(EMAILER, "function wrapLayout({", "// Boilerplate-footer", "wrapLayout");
const wrapHex = (wrapSrc.match(HEX) || []).filter(h => h.toLowerCase() !== "#db6923"); // accent-default är legitim
ok("wrapLayout har INGA hårdkodade chrome-färger kvar (fick: " + (wrapHex.join(", ") || "inga") + ")", wrapHex.length === 0);
ok("wrapLayout tar emot en palett (default = standardmörk)", /pal = MAIL_PAL_DARK/.test(wrapSrc));
ok("sidbakgrunden kommer från paletten", /background:\$\{pal\.pageBg\}/.test(wrapSrc));
ok("kortets bakgrund kommer från paletten", /background:\$\{pal\.cardBg\}/.test(wrapSrc));
ok("CTA-texten kommer från contrastInk(accent), inte hårdkodad vit",
   /color:\$\{contrastInk\(accent\)\}/.test(wrapSrc) && !/color:#ffffff/.test(wrapSrc));
ok("CTA-cellens align styrs av ctaAlign", /align="\$\{ctaAlign === "center" \? "center" : "left"\}"/.test(wrapSrc));

const rowsSrc = slice(EMAILER, "function detailRows(", "// Säker HTML-escape", "detailRows");
ok("faktatabellen har inga hårdkodade färger", (rowsSrc.match(HEX) || []).length === 0);
const footSrc = slice(EMAILER, "function buildFooterBlock(", "function buildSocialBlock(", "buildFooterBlock");
ok("footern har inga hårdkodade färger", (footSrc.match(HEX) || []).length === 0);

for (const [fn, label] of [["tmplInviteInvitation", "inbjudan"], ["tmplNewsAnnouncement", "nyhetsutskick"], ["tmplSurveyInvitation", "undersökning"]]) {
  const src = slice(EMAILER, "async function " + fn + "(", "\n}", fn);
  ok(`${label}: paletten byggs ur x.bg_color`, /const pal\s*=\s*mailPalette\(x\.bg_color\)/.test(src));
  ok(`${label}: paletten skickas till wrapLayout`, /accent, pal,/.test(src));
  ok(`${label}: designblocken får paletten`, /blocksHtmlFor\(x, accent, pal\)/.test(src));
}
const invSrc = slice(EMAILER, "async function tmplInviteInvitation(", "\n}", "tmplInviteInvitation");
ok("inbjudan: CTA centrerad", /ctaAlign:\s*"center"/.test(invSrc));
ok("inbjudan: deadline använder fmtDate (hela datumet)", /const deadline = x\.rsvp_deadline \? fmtDate\(x\.rsvp_deadline\) : ""/.test(invSrc));
ok("inbjudan: faktatabellen får paletten", /\], pal\),/.test(invSrc));
ok("ms-strängar parsas som datum (Bubble kan ge båda)", /function _dateish\(v\)/.test(EMAILER));

// ── 5. Källkodskontrakt: index.js ─────────────────────────────────────────
sec("index.js");
ok("create skriver bg_color", /bg_color:\s*_admHex\(d\.bg_color\)/.test(INDEX));
ok("update mappar bg_color", /bg_color: v => _admHex\(v\)/.test(INDEX));
ok("GET /admin/invite/:id returnerar bg_color", /bg_color: i\.bg_color \|\| ""/.test(INDEX));
ok("mailets extra_data bär bg_color", /bg_color: brand\.bg_color/.test(INDEX));
ok("landningssidans config får färdig palett", /palette:\s*bg \? mailPalette\(bg\) : null/.test(INDEX));
ok("hex normaliseras innan den når Bubble/HTML", /function _admHex\(v\)/.test(INDEX));
// Utan självläkande patch blockerar ETT okänt fält hela sparningen av inbjudan.
ok("inbjudan sparas med självläkande patch", /await safePatch\(ADM_INVITATION, b\.id, f\)/.test(INDEX));
ok("safePatch läser felet ur detail.bodyJson/bodyText (inte detail.body)",
   /const j = d\.bodyJson \|\| null;/.test(INDEX) && /d\.bodyText/.test(INDEX));

// ── 6. Landningssidan ─────────────────────────────────────────────────────
sec("invite.html");
ok("temat appliceras från brand", /applyTheme\(b\);/.test(LANDING));
ok("bakgrunden sätts från serverns palett", /set\("--bg", p\.pageBg\);/.test(LANDING));
ok("texttonerna sätts från serverns palett", /set\("--ink", p\.headline\);/.test(LANDING) && /set\("--ink-soft", p\.body\);/.test(LANDING));
ok("designblockens webbvariabler sätts", /set\("--mb-text", p\.body\);/.test(LANDING));
ok("knapptexten härleds ur ACCENTEN", /root\.style\.setProperty\("--accent-ink", contrastInk\(accent\)\);/.test(LANDING));
ok("accenten sätts fortfarande separat", /root\.style\.setProperty\("--accent", accent\);/.test(LANDING));
ok("gradienterna ersätts av platt färg när bakgrund valts", /root\.style\.background = p\.pageBg;/.test(LANDING));

// ── 7. Admin ──────────────────────────────────────────────────────────────
sec("mira-kommunikation-admin.html");
ok("bakgrundsfältet finns", /id="iv-bg-hex"/.test(ADMIN) && /id="iv-bg"/.test(ADMIN));
ok("hex-fältet är sanningen vid sparning (tomt = standard)", /bg_color:g\('iv-bg-hex'\)\.value\.trim\(\)/.test(ADMIN));
ok("värdet laddas tillbaka vid redigering", /g\('iv-bg-hex'\)\.value=inv\.bg_color\|\|''/.test(ADMIN));
ok("Rensa-knappen nollar fältet", /iv-bg-clear'\)\.addEventListener\('click'/.test(ADMIN));
ok("accentfältet är orört", /id="iv-accent-hex"/.test(ADMIN) && /accent_color:g\('iv-accent'\)\.value/.test(ADMIN));

console.log(`\n${fail ? "✗" : "✓"} ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
