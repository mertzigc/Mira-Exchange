// pdf_utils.js
// ─────────────────────────────────────────────────────────────────────────────
// Delade PDF/HTML/binär-helpers. Flyttade från offer_approval_doc.js i Fas 5
// (2026-07-02) så både approval-cert-motorn och contract_render.js delar
// samma puppeteer-browser-singleton, samma merge-logik och samma
// filtyp-detektering. En Chromium-process per server-instans.
//
// Ren ESM-modul — inga DI-deps. Rör inte Bubble-fält, ingen state utöver
// browser-singleton.
// ─────────────────────────────────────────────────────────────────────────────

import { PDFDocument } from "pdf-lib";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import crypto from "node:crypto";

// ── Puppeteer browser singleton (återanvänds över anrop, lazy) ──────────
// @sparticuz/chromium (slim, ~50 MB) + puppeteer-core. Render's build
// environment cachas av detta paket inuti node_modules → ingen
// PUPPETEER_CACHE_DIR-pyssel, ingen post-install-trubbel.
let _browserPromise = null;

export async function getBrowser() {
  if (_browserPromise) {
    const b = await _browserPromise.catch(() => null);
    if (b && b.connected !== false) return b;
    _browserPromise = null;
  }
  const executablePath = await chromium.executablePath();
  _browserPromise = puppeteer.launch({
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--font-render-hinting=none",
    ],
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });
  return _browserPromise;
}

export async function closeBrowser() {
  if (_browserPromise) {
    const b = await _browserPromise.catch(() => null);
    if (b) await b.close().catch(() => {});
    _browserPromise = null;
  }
}

// ── HTML → PDF (A4, 18 mm marginaler default) ───────────────────────────
export async function renderHtmlToPdf(html, opts = {}) {
  const margin = opts.margin || {
    top: "18mm", bottom: "18mm", left: "18mm", right: "18mm",
  };
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    const buf = await page.pdf({
      format: opts.format || "A4",
      printBackground: opts.printBackground !== false,
      margin,
    });
    return Buffer.from(buf);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Merge N PDF-buffrar i ordning → en sammanslagen PDF-buffer ─────────
export async function mergePdfs(buffers, meta = {}) {
  const out = await PDFDocument.create();
  if (meta.title)    out.setTitle(meta.title);
  if (meta.producer) out.setProducer(meta.producer);
  if (meta.creator)  out.setCreator(meta.creator);
  out.setCreationDate(new Date());

  for (const buf of buffers) {
    let src;
    try {
      src = await PDFDocument.load(buf, { ignoreEncryption: true });
    } catch (e) {
      throw new Error("Kunde inte ladda PDF: " + (e?.message || String(e)));
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

// ── Filtyp-detektering (URL först, magic bytes som fallback) ────────────
export function detectKind(url, buffer) {
  const u = String(url || "").toLowerCase();
  if (/\.pdf(\?|$)/.test(u)) return "pdf";
  if (/\.(jpe?g)(\?|$)/.test(u)) return "jpg";
  if (/\.png(\?|$)/.test(u)) return "png";
  if (buffer && buffer.length >= 4) {
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "pdf"; // %PDF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return "jpg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return "png";
  }
  return "unknown";
}

// ── Wrappa en bild som single-page PDF (för merge) ──────────────────────
// Bevarar naturliga dimensioner. Skala-down om större än ~A0@600dpi.
export async function imageToPdfBuffer(imageBuffer, kind) {
  const doc = await PDFDocument.create();
  const img = kind === "png"
    ? await doc.embedPng(imageBuffer)
    : await doc.embedJpg(imageBuffer);
  const maxDim = 4960;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = img.width * scale;
  const h = img.height * scale;
  const page = doc.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return Buffer.from(await doc.save());
}

// ── Bubble file-URL normalization (protokoll-relativa "//..." → https) ───
export function normalizeFileUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

// ── HTTP-fetch → Buffer (kastar vid non-2xx) ─────────────────────────────
export async function fetchBinary(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`fetchBinary ${r.status} ${url} ${txt.slice(0, 200)}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// ── SHA-256 hex på buffer ────────────────────────────────────────────────
export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
