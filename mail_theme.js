// ────────────────────────────────────────────────────────────
// mail_theme.js — färgpalett för utskick och landningssidor
//
// EN källa för hur en vald bakgrundsfärg blir en hel, läsbar palett.
// Importeras av emailer.js (mejlets chrome), content_blocks.js (designblocken)
// och speglas i invite.html (landningssidan) via /invite/config.
//
// ⚠️ TVÅ OBEROENDE REGLAGE:
//   accent_color — oförändrad. Styr eyebrow, topplist, rubrikstreck, länkar, knapp.
//   bg_color     — NYTT. Styr sidbakgrund; ALLA texttoner härleds ur den.
// Accenten härleds ALDRIG ur bakgrunden och tvärtom. Ändrar du den ena rör sig
// inte den andra.
//
// ⚠️ Mejl kan inte använda CSS-variabler — allt måste vara inline. Därför måste
// varje färg gå via paletten. En färg som glöms kvar hårdkodad är osynlig tills
// någon väljer en ljus bakgrund; då står ljusgrå brödtext på vitt.
// ────────────────────────────────────────────────────────────

// Hex → {r,g,b}. Klarar #abc och #aabbcc, med eller utan brädgård. null = ogiltig.
function parseHex(hex) {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

const toHex = ({ r, g, b }) =>
  "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

// WCAG-relativ luminans (0 = svart, 1 = vit).
function luminance(rgb) {
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

export const INK_DARK = "#0d1117";
export const INK_LIGHT = "#ffffff";

// Tröskeln 0.1913 är den punkt där vit och INK_DARK ger EXAKT samma
// kontrastkvot mot underlaget — under den vinner vit, över den mörk.
// Räknat ur (L+0.05)/(L_ink+0.05) = 1.05/(L+0.05) med L_ink(#0d1117) = 0.00547.
const INK_THRESHOLD = 0.1913;

// Läsbar textfärg mot en godtycklig bakgrund. Okänt format → vit (dagens beteende).
export function contrastInk(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return INK_LIGHT;
  return luminance(rgb) > INK_THRESHOLD ? INK_DARK : INK_LIGHT;
}

// Kontrastkvot mellan två färger (1–21). Används av röktestet.
export function contrastRatio(a, b) {
  const ra = parseHex(a), rb = parseHex(b);
  if (!ra || !rb) return 0;
  const la = luminance(ra), lb = luminance(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Blanda `t` (0–1) av `to` in i `from`.
function mix(from, to, t) {
  const a = parseHex(from), b = parseHex(to);
  if (!a || !b) return from;
  return toHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}

// ── Standardpaletten = EXAKT dagens hårdkodade färger ───────────────────────
// Byte för byte identisk med det som stod inline i emailer.js före paletten.
// Utan bg_color renderas varje mall precis som förut — härledningen nedan
// används bara när någon aktivt valt en bakgrundsfärg.
export const MAIL_PAL_DARK = Object.freeze({
  pageBg:   "#0d1117",
  cardBg:   "#161c2d",
  headline: "#e8eaf0",
  body:     "#c0c4d6",
  muted:    "#8892aa",
  dim:      "#606880",
  faint:    "#3a4055",
  hairline: "#1e2437",
  border:   "#262b42",
  rowLine:  "#1a1f2e",
  rowA:     "#0d1117",
  rowB:     "#0a0d15",
  label:    "#4a5068",
  // Bara landningssidan (--card). Mejlet använder cardBg.
  surface:  "#1c2338"
});

// Ytor: fasta andelar bläck. De ska bara skilja sig märkbart från bakgrunden,
// inte klara något kontrastkrav — de bär ingen text.
const SURFACE_STEPS = {
  cardBg: 0.06, surface: 0.11, rowA: 0, rowB: 0.03, rowLine: 0.09, hairline: 0.10, border: 0.13
};

// Texter: andelen bläck är ett GOLV, inte ett facit. Mot mörka och ljusa
// bakgrunder räcker golvet, men en mellanton (t.ex. en mättad turkos) ligger
// långt från båda ändarna — då ger 0.76 bara ~5:1 och brödtexten blir sliskig.
// Därför löses varje textroll ut mot ett kontraSTMÅL i stället.
const TEXT_STEPS   = { faint: 0.26, label: 0.34, dim: 0.42, muted: 0.56, body: 0.76, headline: 0.93 };
const TEXT_TARGETS = { faint: 2.0,  label: 2.6,  dim: 3.0,  muted: 3.5,  body: 7.0,  headline: 10.0 };

const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

// Minsta andel bläck där mix(bg, ink, t) når `target` mot bg — aldrig under
// `floor`. Kontrasten växer monotont med t → binärsökning. Är målet inte nåbart
// (mellantoner har ett tak) returneras 1, dvs. bästa möjliga kontrast.
function solveT(bgHex, inkHex, target, floor) {
  const Lbg = luminance(parseHex(bgHex));
  const at = t => ratio(luminance(parseHex(mix(bgHex, inkHex, t))), Lbg);
  if (at(floor) >= target) return floor;
  if (at(1) < target) return 1;
  let lo = floor, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target) hi = mid; else lo = mid;
  }
  return hi;
}

// bg_color → hel palett. Tomt/ogiltigt värde → dagens mörka standardpalett,
// så en tom kolumn i Bubble aldrig kan ge ett trasigt utskick.
export function mailPalette(bgColor) {
  const bg = parseHex(bgColor);
  if (!bg) return MAIL_PAL_DARK;
  const hex = toHex(bg);
  const ink = contrastInk(hex);
  const pal = { pageBg: hex };
  for (const [role, t] of Object.entries(SURFACE_STEPS)) pal[role] = mix(hex, ink, t);
  for (const [role, floor] of Object.entries(TEXT_STEPS)) {
    pal[role] = mix(hex, ink, solveT(hex, ink, TEXT_TARGETS[role], floor));
  }
  return Object.freeze(pal);
}
