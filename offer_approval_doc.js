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

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBrowser,
  closeBrowser,
  renderHtmlToPdf,
  mergePdfs,
  detectKind,
  imageToPdfBuffer,
  normalizeFileUrl,
  fetchBinary,
  sha256,
} from "./pdf_utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "approval-cert.template.html");

export function createApprovalDocEngine(deps) {
  const { bubbleGet, bubblePatch, bubbleUploadFile, bubbleFindAll } = deps;
  if (!bubbleGet || !bubblePatch || !bubbleUploadFile) {
    throw new Error("createApprovalDocEngine: bubbleGet/bubblePatch/bubbleUploadFile required");
  }

  // Puppeteer browser-singleton + renderHtmlToPdf/mergePdfs/detectKind/
  // imageToPdfBuffer/normalizeFileUrl/fetchBinary/sha256 flyttade till
  // pdf_utils.js (Fas 5, 2026-07-02) så contract_render.js delar samma
  // Chromium-process. Se toppen av filen för imports.

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

  // ── Hämta tillhörande dokument-objekt och deras byten ───────────────────
  // PDF → buffer används direkt vid merge.
  // JPG/PNG → wrappas som single-page PDF för merge, men hash:as på original.
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
      const kind = detectKind(fileUrl, buffer);

      let mergeBuffer = buffer;
      if (kind === "jpg" || kind === "png") {
        try {
          mergeBuffer = await imageToPdfBuffer(buffer, kind);
        } catch (e) {
          throw new Error(`Kunde inte konvertera ${kind.toUpperCase()}-bild till PDF: ${e?.message || String(e)}`);
        }
      } else if (kind !== "pdf") {
        // Okänd typ: hoppa över med varning hellre än att fail:a hela merge:n
        console.warn("[loadOriginalDocs] skipping unknown file type", fileUrl);
        continue;
      }

      out.push({
        id: d._id,
        titel: d.titel || d.title || "Dokument",
        beskrivning: d.beskrivning || "",
        fileUrl,
        kind,                       // "pdf" | "jpg" | "png"
        bytes: buffer.length,
        hash: sha256(buffer),       // hash på ORIGINAL (inte image-wrapped pdf)
        buffer,                     // original-byten (för audit-trail)
        mergeBuffer,                // PDF-form för merge
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

  // Bygg granskar-sektion från reviewer-syskon. Tomt om inga reviewers finns.
  async function buildReviewersBlock(requestId) {
    if (!requestId || !bubbleFindAll) return "";
    const siblings = await bubbleFindAll("OfferApproval", {
      constraints: [
        { key: "request", constraint_type: "equals", value: requestId },
        { key: "role",    constraint_type: "equals", value: "Reviewer" },
      ],
    }).catch(() => []);
    const reviewers = (siblings || []).filter((r) => r.reviewed_at);
    if (!reviewers.length) return "";

    const rows = reviewers.map((r) => `
      <li>
        <div class="doc-titel">${esc(r.recipient_email || "—")}</div>
        <div class="doc-meta">Godkänd granskning ${esc(fmtDateSE(r.reviewed_at))}</div>
        ${r.approved_ip ? `<div class="doc-hash"><span class="lbl">IP:</span> ${esc(r.approved_ip)}</div>` : ""}
      </li>
    `).join("");

    return `
      <h2>Granskat av</h2>
      <ul class="docs">${rows}</ul>
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
    const reviewersBlock = await buildReviewersBlock(requestId);
    const rawSlots = {
      DOCS_HTML:       buildDocsHtml(originalDocs),
      MESSAGE_BLOCK:   buildMessageBlock(meddelande),
      REVIEWERS_BLOCK: reviewersBlock,
    };
    const html = renderTemplate(tpl, vars, rawSlots);

    // 4) HTML → PDF
    const certPdf = await renderHtmlToPdf(html);

    // 5) Merge: originalen FÖRST, beviset SIST
    const buffersToMerge = [...originalDocs.map((d) => d.mergeBuffer || d.buffer), certPdf];
    const mergedPdf = await mergePdfs(buffersToMerge, {
      title:    "Signerat avtal",
      producer: "Mira / Carotte",
      creator:  "mira-exchange offer_approval_doc",
    });

    // 6) Ladda upp till Bubble
    const safeRubrik = String(vars.rubrik).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
    const filename = `signerat_${safeRubrik || "avtal"}_${approvalId}.pdf`;
    const uploadedUrl = await bubbleUploadFile({
      filename,
      contentType: "application/pdf",
      buffer: mergedPdf
    });

    // Bubble returnerar protokoll-relativ URL (//cdn.bubble.io/...) — mail-
    // klienter resolverar inte det rätt (blir file:// hos vissa). Tvinga https.
    const absoluteUrl = normalizeFileUrl(uploadedUrl) || uploadedUrl;

    // 7) Skriv tillbaka på OfferApproval (om writeBack)
    // Lagrar absoluteUrl så framtida läsare alltid får https.
    if (writeBack) {
      await bubblePatch("OfferApproval", approvalId, {
        signed_document: absoluteUrl,
        signed_document_generated_at: new Date().toISOString()
      });
    }

    return {
      ok: true,
      approval_id: approvalId,
      signed_document_url: absoluteUrl,
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

  // closeBrowser importeras från pdf_utils.js så både approval-cert och
  // contract_render stänger samma singleton. Exponeras oförändrat mot
  // index.js så gamla anrop till approvalDocEngine.closeBrowser() funkar.
  return { generateAndStore, closeBrowser };
}
