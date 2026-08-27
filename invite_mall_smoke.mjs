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
const { mailPalette, MAIL_PAL_DARK, contrastInk, contrastRatio, readableAccent } =
  await load("./mail_theme.js", ["mailPalette", "MAIL_PAL_DARK", "contrastInk", "contrastRatio", "readableAccent"]);
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

// ── 2b. Accenten som bärare av text ───────────────────────────────────────
// Accenten är fri och kan ligga för nära bakgrunden för att bära text. Ytor
// (topplist, kantlinje) ska ALLTID vara exakt kundens färg; bara text justeras.
sec("Läsbar accent (readableAccent)");
ok("räcker accenten redan lämnas den OFÖRÄNDRAD (kundens exakta färg)",
   readableAccent("#551e23", "#ece7dd") === "#551e23" && readableAccent("#df6f39", "#161c2d") === "#df6f39");
for (const [a, bg] of [["#2bb6a3", "#ffffff"], ["#e8dcc8", "#f4efe6"], ["#ffffff", "#f4efe6"]]) {
  const r = readableAccent(a, bg);
  ok(`${a} mot ${bg} justeras till ${r} (${num(contrastRatio(r, bg)).toFixed(1)}:1)`,
     r !== a && num(contrastRatio(r, bg)) >= 4.45);
}
ok("ogiltig indata lämnas orörd", readableAccent("inte-hex", "#ffffff") === "inte-hex");

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
// Accent-tonen är OPT-IN. Default false → de 17 övriga mallarna är oförändrade.
ok("accentTone är avstängd som default", /accentTone = false/.test(wrapSrc));
ok("rubriken tar accenten bara när accentTone är på",
   /accentTone \? readableAccent\(accent, pal\.cardBg\) : pal\.headline/.test(wrapSrc));
ok("faktatabellens vänsterkant får RÅ accent (yta, inte text)",
   /accentTone \? `border-left:3px solid \$\{accent\};` : ""/.test(wrapSrc));

const rowsSrc = slice(EMAILER, "function detailRows(", "// Säker HTML-escape", "detailRows");
ok("faktatabellen har inga hårdkodade färger", (rowsSrc.match(HEX) || []).length === 0);
ok("faktaetiketterna tar accenten när den skickas med, annars palettens etikettfärg",
   /const labelColor = accent \? readableAccent\(accent, pal\.rowA\) : pal\.label;/.test(rowsSrc));
const footSrc = slice(EMAILER, "function buildFooterBlock(", "function buildSocialBlock(", "buildFooterBlock");
ok("footern har inga hårdkodade färger", (footSrc.match(HEX) || []).length === 0);

for (const [fn, label] of [["tmplInviteInvitation", "inbjudan"], ["tmplNewsAnnouncement", "nyhetsutskick"],
                           ["tmplSurveyInvitation", "undersökning"], ["tmplInviteRsvpConfirmation", "svarsbekräftelse"]]) {
  const src = slice(EMAILER, "async function " + fn + "(", "\n}", fn);
  ok(`${label}: paletten byggs ur x.bg_color`, /const pal\s*=\s*mailPalette\(x\.bg_color\)/.test(src));
  ok(`${label}: paletten skickas till wrapLayout`, /accent, pal,/.test(src));
  ok(`${label}: accent-tonen är påslagen`, /accentTone: true,/.test(src));
  // Svarsbekräftelsen har inga designblock — bara de tre utskicksmallarna.
  if (fn !== "tmplInviteRsvpConfirmation") {
    ok(`${label}: designblocken får paletten`, /blocksHtmlFor\(x, accent, pal\)/.test(src));
  }
  ok(`${label}: ingen hårdkodad brödtextfärg kvar`, !/color:#c0c4d6/.test(src));
}
const invSrc = slice(EMAILER, "async function tmplInviteInvitation(", "\n}", "tmplInviteInvitation");
ok("inbjudan: CTA centrerad", /ctaAlign:\s*"center"/.test(invSrc));
ok("inbjudan: deadline använder fmtDate (hela datumet)", /const deadline = x\.rsvp_deadline \? fmtDate\(x\.rsvp_deadline\) : ""/.test(invSrc));
ok("inbjudan: faktaetiketterna får både palett och accent", /\], pal, accent\),/.test(invSrc));
ok("ms-strängar parsas som datum (Bubble kan ge båda)", /function _dateish\(v\)/.test(EMAILER));

// ── 5. Källkodskontrakt: index.js ─────────────────────────────────────────
sec("index.js");
ok("create skriver bg_color", /bg_color:\s*_admHex\(d\.bg_color\)/.test(INDEX));
ok("update mappar bg_color", /bg_color: v => _admHex\(v\)/.test(INDEX));
ok("GET /admin/invite/:id returnerar bg_color", /bg_color: i\.bg_color \|\| ""/.test(INDEX));
ok("mailets extra_data bär bg_color", /bg_color: brand\.bg_color/.test(INDEX));
ok("landningssidans config får färdig palett", /palette:\s*bg \? mailPalette\(bg\) : null/.test(INDEX));
// Räknas accenten mot fel underlag blir rubriken oläsbar på standardbakgrunden.
ok("accent_strong räknas mot den FAKTISKA bakgrunden (vald eller sidans standard)",
   /accent_strong: readableAccent\(accent, bg \|\| INVITE_DEFAULT_BG\)/.test(INDEX)
   && /const INVITE_DEFAULT_BG = "#0f1b2d"/.test(INDEX));

// ⚠️ REGRESSIONSVAKT. Det finns TVÅ brand-byggare: _inviteBrand (mejlet) och
// inviteBrand (landningssidan). De får skilja sig i avsändarnamn och logo men
// ALDRIG i färg. När bg_color bara lades till i den ena slog bakgrunden igenom
// på landningssidan men inte i mejlet — och det syntes först i inkorgen.
sec("index.js — en enda färgkälla");
const colorsSrc = slice(INDEX, "function _inviteColors(inv)", "\n}", "_inviteColors");
ok("_inviteColors finns och äger accent, accent_strong, bg_color och palett",
   /accent_color:/.test(colorsSrc) && /accent_strong:/.test(colorsSrc)
   && /bg_color:/.test(colorsSrc) && /palette:/.test(colorsSrc));

const mailBrandSrc = slice(INDEX, "function _inviteBrand(inv, cc)", "\n}", "_inviteBrand");
const webBrandSrc  = slice(INDEX, "function inviteBrand(inv, cc)", "\n}", "inviteBrand");
ok("mejlets brand-byggare spreadar in _inviteColors", /\.\.\._inviteColors\(inv\)/.test(mailBrandSrc));
ok("landningssidans brand-byggare spreadar in _inviteColors", /\.\.\._inviteColors\(inv\)/.test(webBrandSrc));
ok("ingen av dem sätter egna färger vid sidan om",
   !/accent_color:|bg_color:|accent_strong:|palette:/.test(mailBrandSrc)
   && !/accent_color:|bg_color:|accent_strong:|palette:/.test(webBrandSrc));
// Beteendetest, inte bara källkodskontrakt: klipp ut _inviteColors och kör den.
// Det här är testet som HADE fångat buggen — källkodsläsning såg rätt ut i den
// ena funktionen medan mejlets brand-objekt saknade fältet.
{
  const srcAdmHex = slice(INDEX, "function _admHex(v)", "\n}", "_admHex");
  let colors = null;
  try {
    // INVITE_DEFAULT_BG läses ur källan — hårdkodas den här kan testet gröna
    // sig mot fel underlag om konstanten ändras i index.js.
    const defBg = (INDEX.match(/const INVITE_DEFAULT_BG = "(#[0-9a-fA-F]{6})"/) || [])[1] || "";
    ok("INVITE_DEFAULT_BG finns i index.js", !!defBg);
    colors = new Function("mailPalette", "readableAccent", "INVITE", "INVITE_DEFAULT_BG",
      `${srcAdmHex}\n${colorsSrc}\nreturn _inviteColors;`)(mailPalette, readableAccent, { DEFAULT_ACCENT: "#df6f39" }, defBg);
  } catch (e) { fail++; console.log("  ✗ [eval] _inviteColors gick inte att köra — " + (e?.message || e)); }
  const run = (inv) => { try { return colors ? colors(inv) : {}; } catch { return {}; } };

  const valt = run({ accent_color: "#551e23", bg_color: "#ece7dd" });
  ok("vald bakgrund når färgobjektet", valt.bg_color === "#ece7dd");
  ok("vald bakgrund ger en färdig palett", !!valt.palette && valt.palette.pageBg === "#ece7dd");
  ok("accenten lämnas orörd när den räcker mot bakgrunden", valt.accent_color === "#551e23" && valt.accent_strong === "#551e23");

  const tomt = run({ accent_color: "#df6f39" });
  ok("utan bakgrund: bg_color är tom och paletten null (standardutseende)",
     tomt.bg_color === "" && tomt.palette === null);
  ok("utan bakgrund räknas accenten mot sidans standardbakgrund",
     tomt.accent_strong === readableAccent("#df6f39", (INDEX.match(/const INVITE_DEFAULT_BG = "(#[0-9a-fA-F]{6})"/) || [])[1]));

  const skrap = run({ accent_color: "#df6f39", bg_color: "lila" });
  ok("skräp i bg_color faller tillbaka på standardutseendet",
     skrap.bg_color === "" && skrap.palette === null);
}

ok("readableAccent anropas på EXAKT ett ställe i index.js",
   (INDEX.match(/readableAccent\(/g) || []).length === 1);
ok("mailPalette anropas på EXAKT ett ställe i index.js",
   (INDEX.match(/mailPalette\(/g) || []).length === 1);
// BÅDA mejlvägarna: utskicket (baseExtra) och svarsbekräftelsen. Ett ensamt
// träffat ställe räckte inte — det var precis så buggen såg ut.
ok("båda mejlvägarnas extra_data bär bg_color (utskick + svarsbekräftelse)",
   (INDEX.match(/bg_color:\s+brand\.bg_color,/g) || []).length === 2);
ok("hex normaliseras innan den når Bubble/HTML", /function _admHex\(v\)/.test(INDEX));
// Utan självläkande patch blockerar ETT okänt fält hela sparningen av inbjudan.
ok("inbjudan sparas med självläkande patch", /await safePatch\(ADM_INVITATION, b\.id, f\)/.test(INDEX));
ok("safePatch läser felet ur detail.bodyJson/bodyText (inte detail.body)",
   /const j = d\.bodyJson \|\| null;/.test(INDEX) && /d\.bodyText/.test(INDEX));
// Ett droppat fält MÅSTE synas. Annars ser sparningen lyckad ut och man
// felsöker mejlmallen i stället för det saknade Bubble-fältet.
ok("create läser tillbaka bg_color och rapporterar bg_color_saved",
   /_verifyFieldSaved\(id, "bg_color", exact\.bg_color\)/.test(INDEX) && /bg_color_saved: bgSaved/.test(INDEX));
ok("update läser tillbaka bg_color och rapporterar bg_color_saved",
   /_verifyFieldSaved\(b\.id, "bg_color", f\.bg_color\)/.test(INDEX));
ok("verifieringen skiljer 'okänt' (null) från 'saknas' (false)",
   /return null;\s*\/\/ okänt ≠ saknat fält/.test(INDEX));

// ── 6. Landningssidan ─────────────────────────────────────────────────────
sec("invite.html");
ok("temat appliceras från brand", /applyTheme\(b\);/.test(LANDING));
ok("bakgrunden sätts från serverns palett", /set\("--bg", p\.pageBg\);/.test(LANDING));
ok("texttonerna sätts från serverns palett", /set\("--ink", p\.headline\);/.test(LANDING) && /set\("--ink-soft", p\.body\);/.test(LANDING));
ok("designblockens webbvariabler sätts", /set\("--mb-text", p\.body\);/.test(LANDING));
ok("knapptexten härleds ur ACCENTEN", /root\.style\.setProperty\("--accent-ink", contrastInk\(accent\)\);/.test(LANDING));
ok("accenten sätts fortfarande separat", /root\.style\.setProperty\("--accent", accent\);/.test(LANDING));
ok("gradienterna ersätts av platt färg när bakgrund valts", /root\.style\.background = p\.pageBg;/.test(LANDING));

sec("invite.html — accentens ytor");
ok("--accent-strong sätts från servern, med accenten som fallback",
   /setProperty\("--accent-strong", \(brand && brand\.accent_strong\) \|\| accent\)/.test(LANDING));
ok("topplist i RÅ accent", /\.mira-portal::before \{[^}]*background: var\(--accent\)/.test(LANDING));
ok("rubriken i läsbar accent", /h1\.mp-title \{[^}]*color: var\(--accent-strong\)/.test(LANDING));
ok("faktaetiketterna i läsbar accent", /\.mp-fact dt \{[^}]*color: var\(--accent-strong\)/.test(LANDING));
ok("faktablockets vänsterkant i RÅ accent", /\.mp-facts \{[^}]*border-left: 3px solid var\(--accent\)/.test(LANDING));
ok("svarskortets överkant i RÅ accent", /\.mp-card \{[^}]*border-top: 3px solid var\(--accent\)/.test(LANDING));
ok("svarskortets rubrik i läsbar accent", /\.mp-card h2 \{[^}]*color: var\(--accent-strong\)/.test(LANDING));
ok("knappens text följer fortfarande --accent-ink", /background: var\(--accent\); color: var\(--accent-ink\)/.test(LANDING));

// ── Vem svaret binds till ─────────────────────────────────────────────────
// Personlig länk (?g=) döljer namn/e-post eftersom de redan är kända. Utan en
// synlig bekräftelse ser det ut som att uppgifterna fallit bort — det var precis
// därför någon lade till dubblettfält i form_schema.
sec("invite.html — känd gäst");
const whoSrc = slice(LANDING, "function showWhoami(g)", "\n}", "showWhoami");
ok("raden visas i ALLA lägen utom öppen länk utan känd gäst",
   /if \(OPEN_MODE && !CFG\.guest\) show\("mp-contact"\);\s*\n\s*else showWhoami\(CFG\.guest\);/.test(LANDING));
ok("byggs med textContent — namn och e-post är användardata",
   whoSrc.includes("textContent") && !whoSrc.includes("innerHTML"));
ok("visar inget när varken namn eller e-post finns", /if \(!name && !mail\) return;/.test(whoSrc));
ok("klarar gäst med bara namn eller bara e-post",
   /if \(name\)\{/.test(whoSrc) && /if \(mail\)\{/.test(whoSrc));
ok("elementet finns i markupen och är dolt från start",
   /id="mp-whoami" class="mp-whoami mp-hidden"/.test(LANDING));
ok("egen stil med accentkant", /\.mp-whoami \{[^}]*border-left: 3px solid var\(--accent\)/.test(LANDING));
ok("kontaktfälten visas fortfarande BARA i öppet läge utan gäst",
   /kontaktuppgifter: visas bara i öppet läge/.test(LANDING));

// ── 7. Admin ──────────────────────────────────────────────────────────────
sec("mira-kommunikation-admin.html");
ok("bakgrundsfältet finns", /id="iv-bg-hex"/.test(ADMIN) && /id="iv-bg"/.test(ADMIN));
ok("hex-fältet är sanningen vid sparning (tomt = standard)", /bg_color:g\('iv-bg-hex'\)\.value\.trim\(\)/.test(ADMIN));
ok("värdet laddas tillbaka vid redigering", /g\('iv-bg-hex'\)\.value=inv\.bg_color\|\|''/.test(ADMIN));
ok("Rensa-knappen nollar fältet", /iv-bg-clear'\)\.addEventListener\('click'/.test(ADMIN));
ok("accentfältet är orört", /id="iv-accent-hex"/.test(ADMIN) && /accent_color:g\('iv-accent'\)\.value/.test(ADMIN));
// ── Påminnelse på inbjudan ────────────────────────────────────────────────
// Knappen lovar ett antal; backend väljer mottagare. Går villkoren isär säger
// UI:t "Påminn (12)" och servern köar något annat.
sec("Påminnelse (inbjudan)");
ok("påminn-knappen finns i deltagarpanelen", /id="iv-g-remind"/.test(ADMIN));
ok("antalet räknas i en egen funktion", /function ivAwaitingList\(\)/.test(ADMIN));
ok("frontendens villkor: fått mejl + har adress + obesvarad",
   /x\.invite_sent && x\.email && \(x\.rsvp_status\|\|'pending'\)==='pending'/.test(ADMIN));
// Motsvarande rader i backend. Ändras någon av dem ensam faller det här testet.
ok("backendens påminnelseurval: invite_sent === true && notAnswered",
   /\? \(g\.invite_sent === true && notAnswered\(g\)\)/.test(INDEX));
ok("backendens notAnswered för inbjudan: rsvp_status === 'pending'",
   /return String\(g\.rsvp_status \|\| "pending"\)\.toLowerCase\(\) === "pending";/.test(INDEX));
ok("backend hoppar över mottagare utan e-postadress",
   /\.filter\(g => String\(g\.email \|\| ""\)\.trim\(\)\)/.test(INDEX));
// Två träffar krävs: undersökningens gamla knapp OCH inbjudans nya. Ett ensamt
// träffat anrop var undersökningens — testet hade grönat sig utan inbjudan.
ok("reminder:true skickas från BÅDA flikarna (undersökning + inbjudan)",
   (ADMIN.match(/body:JSON\.stringify\(\{offset:offset,limit:40,reminder:true\}\)/g) || []).length === 2);
ok("påminnelse ommarkerar INTE invite_sent (skulle dölja vem som fått vad)",
   /if \(!isReminder\) \{[\s\S]{0,220}invite_sent: true/.test(INDEX));
ok("knappen nollas när deltagarpanelen töms",
   /iv-g-remind'\)\.textContent='🔔 Skicka påminnelse'/.test(ADMIN));
ok("undersökningens påminnelse är orörd", /id="sv-remind"/.test(ADMIN) && /SV_SEND_BUSY \|\| !awaiting/.test(ADMIN));

// ── Påminnelsens ämnesrad ─────────────────────────────────────────────────
// Utan eget prefix trådar mejlklienten ihop påminnelsen med originalet och den
// läser som en dubblett. Flaggan går via extra_data — se nästa test för varför.
sec("Ämnesrad vid påminnelse");
ok("utskicket flaggar påminnelse i extra_data", /is_reminder: isReminder,/.test(INDEX));
ok("inbjudan byter prefix Inbjudan: → Påminnelse:",
   /\(x\.is_reminder \? "P\\u00e5minnelse: " : "Inbjudan: "\) \+ title/.test(EMAILER));
ok("nyhet och undersökning får prefix",
   (EMAILER.match(/x\.is_reminder \? "P\\u00e5minnelse: " \+ title : title/g) || []).length === 2);
ok("ett uttryckligt subject_override vinner fortfarande i alla tre",
   (EMAILER.match(/const subject\s*=\s*item\.subject_override \|\| \(\(?x\.is_reminder/g) || []).length === 3);

// ⚠️ subject_override som KOLUMN på EmailQueue skrivs inte av någon kodväg idag,
// så fältet finns sannolikt inte i Bubble. Ett okänt fält i _bulkCreate ger
// `created: ok || rows.length` → hela utskicket rapporteras lyckat fast INGET
// skapades. Därför får sändvägen aldrig lägga en sådan kolumn på kön.
const sendSrc = slice(INDEX, 'app.post("/admin/invite/:id/send"', "\n});", "send-route");
// Kommentarrader räknas inte — det är KODEN som inte får skriva kolumnen.
const sendCode = sendSrc.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
ok("sändvägen skriver INGEN subject_override-kolumn på EmailQueue",
   sendSrc !== "" && !/subject_override/.test(sendCode));
ok("flaggan ligger i extra_data, som redan är ett fungerande fält",
   /extra_data: JSON\.stringify\(extra\)/.test(sendSrc));

// ── Bubble-bindningen i admin-blocket ─────────────────────────────────────
// Bubble strippar `value` på hidden inputs — attributet överlever, värdet inte.
// En bindning till value ger därför alltid tom sträng och förvalet dör tyst.
sec("Bubble dynamic data (admin)");
ok("e-postfältet bär värdet i data-val", /id="ck_current_user_email"[^>]*data-val=""/.test(ADMIN));
ok("kommentaren säger uttryckligen data-val, inte value", /ALDRIG till value/.test(ADMIN));
ok("läsningen tar data-val först, value som fallback",
   /getAttribute\('data-val'\) \|\| el\.value/.test(ADMIN));
ok("ingen kodväg läser .value direkt från e-postfältet",
   !/g\('ck_current_user_email'\)\|\|\{\}\)\.value/.test(ADMIN));
ok("sen injicering fångas av en nätverksfri poll som ger upp",
   /window\._ckEmailPoll/.test(ADMIN) && /\+\+_et > 60/.test(ADMIN));
// API-nyckeln har egen fallback sedan stripping-incidenten 2026-07-14.
ok("API-nyckeln har kvar sin JS-fallback", /return v \|\| _EA_KEY;/.test(ADMIN));

ok("admin varnar synligt när bg_color droppats av Bubble",
   /function bgWarnIfMissing\(p, j\)/.test(ADMIN) && /bgWarnIfMissing\('iv', j\);/.test(ADMIN)
   && /bg_color" saknas på datatypen Invitation/.test(ADMIN));

console.log(`\n${fail ? "✗" : "✓"} ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
