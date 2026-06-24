// offer_approval_doc.js
// ─────────────────────────────────────────────────────────────────────────────
// Genererar ett signeringsbevis från en OfferApproval, mergar in det sist i
// originaldokumentens PDF:er och laddar upp den sammanslagna filen till Bubble.
// Filens URL skrivs tillbaka på OfferApproval.signed_document.
//
// DI-mönster identiskt med invoice_sync.js / emailer.js: index.js skickar in
// bubble-helpers + bubbleUploadFile vid createApprovalDocEngine({...}).
//
// Steg 1 i planen (juni 2026): körs som intern Render-route som Bubble-flödet
// triggar via API Connector. Steg 2: när offertmotorn flyttar till Render
// anropas generateAndStore direkt utan HTTP-hop.
// ─────────────────────────────────────────────────────────────────────────────

import { PDFDocument } from "pdf-lib";
import puppeteer from "puppeteer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "approval-cert.template.html");

export function createApprovalDocEngine(deps) {
  const { bubbleGet, bubblePatch, bubbleUploadFile } = deps;
  if (!bubbleGet || !bubblePatch || !bubbleUploadFile) {
    throw new Error("createApprovalDocEngine: bubbleGet/bubblePatch/bubbleUploadFile required");
  }

  // ── Puppeteer browser singleton (återanvänds över anrop, lazy) ──────────
  let _browserPromise = null;
  async function getBrowser() {
    if (_browserPromise) {
      const b = await _browserPromise.catch(() => null);
      if (b && b.connected !== false) return b;
      _browserPromise = null;
    }
    _browserPromise = puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--font-render-hinting=none"
      ]
    });
    return _browserPromise;
  }

  // ── Mall cache (filen läses en gång per process) ────────────────────────
  let _templateCache = null;
  async function loadTemplate() {
    if (!_templateCache) {
      _templateCache = await fs.readFile(TEMPLATE_PATH, "utf8");
    }
    return _templateCache;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function fmtDateSE(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString("sv-SE", {
      timeZone: "Europe/Stockholm",
      dateStyle: "long",
      timeStyle: "short"
    });
  }

  function shortHash(hex) {
    const s = String(hex || "");
    if (!s) return "—";
    return s.slice(0, 24) + (s.length > 24 ? "…" : "");
  }

  function sha256(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  // Bubbles file-fält lagras ofta som "//s3.amazonaws.com/..." utan protokoll
  function normalizeFileUrl(u) {
    if (!u) return null;
    let s = String(u).trim();
    if (!s) return null;
    if (s.startsWith("//")) s = "https:" + s;
    if (!/^https?:\/\//i.test(s)) return null;
    return s;
  }

  async function fetchBinary(url) {
    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`fetchBinary ${r.status} ${url} ${txt.slice(0, 200)}`);
    }
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  }

  // ── Generisk fältplockning för främmande typer (ClientCompany/Deal) ─────
  // OfferApproval-fälten är confirmade lowercase (se Bubble Data Types-vyn
  // 2026-06-24) och accessas direkt. ClientCompany/Deal-schemat är okänt
  // utan att öppna dem i editorn → vi testar några vanliga namn-varianter.
  function pick(obj, ...keys) {
    if (!obj) return null;
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== "") return obj[k];
    }
    return null;
  }

  // ── Mall-rendering: två faser så DOCS_HTML/MESSAGE_BLOCK släpps rå ────
  function renderTemplate(tpl, vars, rawSlots = {}) {
    let out = tpl;
    // 1) Råslots först (annars escapas deras innehåll av nästa pass)
    for (const [k, v] of Object.entries(rawSlots)) {
      out = out.split("{{" + k + "}}").join(v == null ? "" : String(v));
    }
    // 2) Vanliga slots — escapas
    out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), vars);
      return v == null ? "" : esc(v);
    });
    return out;
  }

  async function renderHtmlToPdf(html) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
      const buf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "18mm", bottom: "18mm", left: "18mm", right: "18mm" }
      });
      return Buffer.from(buf);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async function mergePdfs(buffers) {
    const out = await PDFDocument.create();
    out.setTitle("Signerat avtal");
    out.setProducer("Mira / Carotte");
    out.setCreator("mira-exchange offer_approval_doc");
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

  // ── Hämta tillhörande dokument-objekt och deras PDF-bytes ──────────────
  async function loadOriginalDocs(source) {
    // source = OfferApprovalRequest (preferred) eller legacy OfferApproval
    const list = Array.isArray(source?.dokument) ? source.dokument : [];
    if (!list.length) return [];

    const dokuments = await Promise.all(
      list.map((id) => bubbleGet("Dokument", id).catch(() => null))
    );

    const out = [];
    for (const d of dokuments) {
      if (!d) continue;
      const fileUrl = normalizeFileUrl(d.file);
      if (!fileUrl) continue;
      const buffer = await fetchBinary(fileUrl);
      out.push({
        id: d._id,
        titel: d.titel || d.title || "Dokument",
        beskrivning: d.beskrivning || "",
        fileUrl,
        bytes: buffer.length,
        hash: sha256(buffer),
        buffer
      });
    }
    return out;
  }

  // ── Bygg HTML för dokumentlistan i beviset ─────────────────────────────
  function buildDocsHtml(docs) {
    if (!docs.length) {
      return `<li><div class="doc-titel">Inga signerade dokument registrerade</div></li>`;
    }
    return docs.map((d) => `
      <li>
        <div class="doc-titel">${esc(d.titel)}</div>
        <div class="doc-meta">${(d.bytes / 1024).toFixed(1)} kB</div>
        <div class="doc-hash"><span class="lbl">SHA-256:</span> ${esc(d.hash)}</div>
      </li>
    `).join("");
  }

  function buildMessageBlock(meddelande) {
    const m = String(meddelande || "").trim();
    if (!m) return "";
    return `
      <h2>Meddelande</h2>
      <pre class="message">${esc(m)}</pre>
    `;
  }

  // ── Klientföretags-namn hämtas pragmatiskt (Bubble har inget fast schema) ─
  function clientCompanyName(cc, fallbackId) {
    if (!cc) return fallbackId || "—";
    return pick(cc, "name", "Name", "company_name", "Company_name", "namn", "Namn") || fallbackId || "—";
  }

  function dealRef(deal, fallbackId) {
    if (!deal) return fallbackId || "—";
    return pick(deal, "name", "Name", "titel", "Titel", "rubrik", "Rubrik", "title") || fallbackId || "—";
  }

  // ───────────────────────────────────────────────────────────────────────
  // HUVUDFUNKTION
  // generateAndStore(approvalId, { writeBack=true, mode="merged" })
  // ───────────────────────────────────────────────────────────────────────
  async function generateAndStore(approvalId, options = {}) {
    const { writeBack = true } = options;
    if (!approvalId) throw new Error("generateAndStore: approvalId required");

    // 1) OfferApproval + relaterade entiteter
    const approval = await bubbleGet("OfferApproval", approvalId);
    if (!approval) {
      const e = new Error("OfferApproval not found: " + approvalId);
      e.status = 404;
      throw e;
    }

    // Moder-typ (om kopplad) styr rubrik/meddelande/dokument/clientcompany/deal.
    // Faller tillbaka på child-fält om approval.request saknas (bakåtkompabilitet
    // mot gamla OfferApproval-poster skapade innan §0e cutover).
    const requestId = approval.request || null;
    const request = requestId
      ? await bubbleGet("OfferApprovalRequest", requestId).catch(() => null)
      : null;

    const ccId   = (request && request.clientcompany) || approval.clientcompany || null;
    const dealId = (request && request.deal)          || approval.deal          || null;

    const [clientCompany, deal] = await Promise.all([
      ccId   ? bubbleGet("ClientCompany", ccId).catch(() => null) : null,
      dealId ? bubbleGet("Deal",          dealId).catch(() => null) : null
    ]);

    // 2) Hämta originaldokument + hasha (parent first, fallback child)
    const docSource = request && Array.isArray(request.dokument) && request.dokument.length
      ? request
      : approval;
    const originalDocs = await loadOriginalDocs(docSource);

    // 3) Rendera bevis-HTML
    const tpl = await loadTemplate();
    const rubrik     = (request && request.rubrik)     || approval.rubrik     || "Avtal";
    const meddelande = (request && request.meddelande) || approval.meddelande || "";
    const vars = {
      rubrik,
      client_name:         clientCompanyName(clientCompany, ccId),
      deal_ref:            dealRef(deal, dealId),
      approved_by:         approval.approved_by_email || approval.recipient_email || "—",
      approved_at:         fmtDateSE(approval.approved_at),
      approved_ip:         approval.approved_ip || "—",
      approved_user_agent: approval.approved_user_agent || "—",
      otp_verified:        approval.token_email_verify
                            ? "Ja, e-post-OTP verifierad"
                            : "Nej / ej registrerad",
      token_fingerprint:   shortHash(approval.token_hash),
      approval_link:       approval.approval_link || "—",
      status:              approval.status || "—",
      generated_at:        fmtDateSE(new Date().toISOString())
    };
    const rawSlots = {
      DOCS_HTML:     buildDocsHtml(originalDocs),
      MESSAGE_BLOCK: buildMessageBlock(meddelande)
    };
    const html = renderTemplate(tpl, vars, rawSlots);

    // 4) HTML → PDF
    const certPdf = await renderHtmlToPdf(html);

    // 5) Merge: originalen FÖRST, beviset SIST
    const buffersToMerge = [...originalDocs.map((d) => d.buffer), certPdf];
    const mergedPdf = await mergePdfs(buffersToMerge);

    // 6) Ladda upp till Bubble
    const safeRubrik = String(vars.rubrik).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
    const filename = `signerat_${safeRubrik || "avtal"}_${approvalId}.pdf`;
    const uploadedUrl = await bubbleUploadFile({
      filename,
      contentType: "application/pdf",
      buffer: mergedPdf
    });

    // 7) Skriv tillbaka på OfferApproval (om writeBack)
    if (writeBack) {
      await bubblePatch("OfferApproval", approvalId, {
        signed_document: uploadedUrl,
        signed_document_generated_at: new Date().toISOString()
      });
    }

    return {
      ok: true,
      approval_id: approvalId,
      signed_document_url: uploadedUrl,
      bytes: mergedPdf.length,
      original_docs: originalDocs.map((d) => ({
        id: d.id,
        titel: d.titel,
        bytes: d.bytes,
        sha256: d.hash
      })),
      cert_bytes: certPdf.length
    };
  }

  async function closeBrowser() {
    if (_browserPromise) {
      const b = await _browserPromise.catch(() => null);
      if (b) await b.close().catch(() => {});
      _browserPromise = null;
    }
  }

  return { generateAndStore, closeBrowser };
}
