// orgnr.js — svenska organisationsnummer: EN kanonisk form ut, alla former in.
//
// Regeln (Christian 2026-09-01): **visas alltid som `xxxxxx-xxxx`**, men läses
// både med och utan bindestreck.
//
// ⚠️ DELAD MODUL MED FLIT. Funktionerna behövs i både index.js (cache-projektionen
// som matar alla vyer) och companies_api.js (skapa/redigera/sök). En kopia i vardera
// hade drivit isär — och orgnr är dubblettnyckeln för hela kundregistret.
//
// ⚠️ RÖR INTE `normalizeOrgNo` i index.js. Den används av synkvägarna
// (Fortnox/Tengella-matchning) och är siffror-bara. Att lägga på sekelhantering där
// hade ändrat matchningsbeteende i en kedja det här uppdraget inte gäller.

// Alla siffror, inget annat. Samma semantik som index.js normalizeOrgNo.
export function orgDigits(v) {
  return String(v == null ? "" : v).replace(/\D+/g, "");
}

// ⚠️ Sekelprefix. Ett orgnr kan komma 12-siffrigt (`16` + de tio) och ett
// personnummer för enskild firma som `19`/`20` + tio. Båda ska bli samma tio
// siffror som den korta formen, annars matchar inte "556000-1111" mot
// "165560001111" och en kund blir två.
// Andra tolvsiffriga strängar lämnas orörda — vi hittar aldrig på ett orgnr.
export function orgCore(v) {
  const d = orgDigits(v);
  if (d.length === 12 && /^(16|18|19|20)/.test(d)) return d.slice(2);
  return d;
}

// Kanonisk visningsform. ⚠️ Går det INTE att kanonisera returneras värdet
// oförändrat (trimmat) — ett halvt orgnr ska synas som det är, inte formateras
// till något som ser giltigt ut.
export function formatOrgNo(v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return "";
  const core = orgCore(raw);
  if (core.length !== 10) return raw;
  return core.slice(0, 6) + "-" + core.slice(6);
}

// Är det ett orgnr vi kan hantera? (tio siffror efter sekelstrippning)
export function isOrgNo(v) {
  return orgCore(v).length === 10;
}

// Jämförelse som ser förbi bindestreck OCH sekelprefix. Används av
// dubblettspärren — två skrivsätt av samma nummer är ETT företag.
export function sameOrgNo(a, b) {
  const x = orgCore(a), y = orgCore(b);
  return !!x && x === y;
}

// Alla former ett lagrat värde kan tänkas ha, för constraint-matchning mot Bubble.
// (Bubble kan inte normalisera på sin sida — vi måste prova varianterna.)
export function orgVariants(v) {
  const raw = String(v == null ? "" : v).trim();
  const core = orgCore(raw);
  const out = [raw, orgDigits(raw), core];
  if (core.length === 10) out.push(core.slice(0, 6) + "-" + core.slice(6));
  return Array.from(new Set(out.filter(Boolean)));
}
