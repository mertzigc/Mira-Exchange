// forhandsgranska.mjs — renderar nyhetsbrevet till en lokal HTML-fil sa du ser
// exakt hur mejlet ser ut innan nagot skickas.
//
//   node nyhetsbrev/forhandsgranska.mjs        -> nyhetsbrev/preview.html
//   node nyhetsbrev/forhandsgranska.mjs --live -> anvander de uppladdade bild-URL:erna
//                                                 i stallet for lokala filer
//
// Blockrenderingen ar den RIKTIGA (renderBlocksEmail ur content_blocks.js), sa det
// som visas har ar det som gar ut. Ramen runt (wrapLayout) ar en kopia av emailer.js
// — den kan i teorin glida isar; blocken kan inte.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normBlocks, renderBlocksEmail } from "../content_blocks.js";
import { MAIL_PAL_DARK, contrastInk, readableAccent } from "../mail_theme.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "utskick.json"), "utf8"));
let blocksTxt = fs.readFileSync(path.join(ROOT, "blocks.json"), "utf8");

const BILDER = {
  __IMG_01__: "01-tjanster.jpg",
  __IMG_02__: "02-oversikt.jpg",
  __IMG_03__: "03-planering-manad.jpg",
  __IMG_04__: "04-planering-ar.jpg",
  __IMG_05__: "05-bokningswizard.jpg",
  __IMG_06__: "06-fakturaportal.jpg"
};

// safeUrl i content_blocks.js slapper medvetet inte igenom data:-URI:er (blocken
// gar ut i mejl). Vi satter darfor unika https-platshallare fore normalisering och
// byter ut dem mot data-URI:er i den fardiga HTML-strangen.
const platshallare = {};
for (const token of Object.keys(BILDER)) {
  platshallare[token] = "https://forhandsgranskning.local/" + token + ".jpg";
  blocksTxt = blocksTxt.split(token).join(platshallare[token]);
}
const blocks = normBlocks(JSON.parse(blocksTxt));

const accent = meta.accent_color || "#df6f39";
const pal = MAIL_PAL_DARK;
const esc = v => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const hexAlpha = (hex, a) => String(hex || "").trim() + a;

const bodyText = String(meta.description || "")
  .split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean)
  .map(p => `<p style="font-size:14px;color:${pal.body};line-height:1.65;margin:0 0 14px;">${esc(p).replace(/\n/g, "<br>")}</p>`)
  .join("");

const blocksHtml = renderBlocksEmail(blocks, accent, pal);

const html = `<!DOCTYPE html>
<html lang="sv"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title)}</title></head>
<body style="margin:0;padding:0;background:${pal.pageBg};font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:40px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:${pal.cardBg};border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
    <tr><td style="background:${accent};height:3px;"></td></tr>
    <tr><td style="padding:28px 36px 0;"><span style="font-size:15px;font-weight:600;color:${pal.headline};">${esc(meta.host_name || "Carotte")}</span></td></tr>
    <tr><td style="padding:24px 36px 0;">
      <div style="display:inline-flex;align-items:center;gap:6px;background:${hexAlpha(accent, "1a")};border:1px solid ${hexAlpha(accent, "33")};color:${accent};font-size:11px;font-weight:600;padding:3px 12px;border-radius:20px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:14px;">
        <span style="width:5px;height:5px;border-radius:50%;background:${accent};display:inline-block;"></span> Nyhetsutskick
      </div>
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:${readableAccent(accent, pal.cardBg)};line-height:1.25;letter-spacing:-.3px;">${esc(meta.title)}</h1>
      <div style="font-size:14px;color:${pal.body};line-height:1.65;margin:12px 0 0;">${bodyText}${blocksHtml}</div>
    </td></tr>
    <tr><td style="padding:20px 36px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;"><tr><td align="left">
        <a href="${esc(meta.cta_url)}" style="display:inline-block;background:${accent};color:${contrastInk(accent)};font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;padding:13px 30px;border-radius:8px;text-decoration:none;letter-spacing:-.1px;">${esc(meta.cta_label)}</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:24px 36px;border-top:1px solid ${pal.hairline};">
      <p style="font-size:11px;color:${pal.faint};line-height:1.6;margin:0;">Mira &middot; Carotte Group AB<br>Forhandsgranskning &mdash; footern i skarpt lage kommer fran _footerData() och far en avregistreringslank per mottagare.</p>
    </td></tr>
  </table>
</td></tr></table></body></html>`;

let ut = html;
if (!live) {
  for (const [token, file] of Object.entries(BILDER)) {
    const b64 = fs.readFileSync(path.join(ROOT, "bilder", file)).toString("base64");
    ut = ut.split(platshallare[token]).join("data:image/jpeg;base64," + b64);
  }
}

const out = path.join(ROOT, "preview.html");
fs.writeFileSync(out, ut);
console.log(`Skrev ${out} (${blocks.length} block, ${(ut.length / 1024 / 1024).toFixed(1)} MB${live ? "" : ", bilder inbakade"})`);
