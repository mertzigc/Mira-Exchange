// contract_render.js
// ─────────────────────────────────────────────────────────────────────────────
// Renderar ContractTemplate → PDF med bilage-merge → Dokument-rad i Bubble.
// Två publika ingångar:
//   renderPreview()      — skapar temp-Dokument med deletable_after för iframe-visning
//   renderAndPersist()   — skapar permanent Dokument (för /admin/contracts/render-and-send)
//
// DI-mönster (samma som offer_approval_doc.js): index.js skickar in bubble-
// helpers + SERVICES-konstanten via createContractRenderEngine({...}).
// Delad puppeteer-browser + PDF-merge via pdf_utils.js så en Chromium-process
// betjänar både approval-cert och contract-render.
// ─────────────────────────────────────────────────────────────────────────────

import {
  renderHtmlToPdf,
  mergePdfs,
  detectKind,
  imageToPdfBuffer,
  normalizeFileUrl,
  fetchBinary,
} from "./pdf_utils.js";

// Preview-Dokument städas när första /render-preview-anropet efter TTL passeras.
// 2 timmar räcker för Carotte att öppna, granska, korrigera spec, re-rendera.
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

export function createContractRenderEngine(deps) {
  const { bubbleGet, bubbleCreate, bubbleUploadFile, SERVICES } = deps;
  if (!bubbleGet || !bubbleCreate || !bubbleUploadFile || !SERVICES) {
    throw new Error(
      "createContractRenderEngine: bubbleGet/bubbleCreate/bubbleUploadFile/SERVICES required"
    );
  }

  // ── HTML-escaping + template-substitution ──────────────────────────
  // Samma mönster som offer_approval_doc.js — {{key}} eller {{a.b.c}} med
  // dot-access, escapas som HTML-entiteter. rawSlots hoppar över escapen
  // (för pre-renderad HTML som tabeller). Duplikat hålls här så contract-
  // render kan skruvas oberoende av approval-cert.
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
  function renderTemplate(tpl, vars, rawSlots = {}) {
    let out = tpl;
    for (const [k, v] of Object.entries(rawSlots)) {
      out = out.split("{{" + k + "}}").join(v == null ? "" : String(v));
    }
    out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), vars);
      return v == null ? "" : esc(v);
    });
    return out;
  }

  // ── Hämta bilage-Dokument-rader → PDF-buffrar ──────────────────────
  // PDF direkt, JPG/PNG wrappas till single-page PDF via pdf_utils. Okända
  // typer loggas som warning istället för att fail:a hela renderingen.
  async function loadAttachmentBuffers(dokumentIds) {
    const list = Array.isArray(dokumentIds) ? dokumentIds : [];
    if (!list.length) return { buffers: [], warnings: [] };
    const rows = await Promise.all(
      list.map((id) => bubbleGet("Dokument", id).catch(() => null))
    );
    const buffers = [];
    const warnings = [];
    for (const row of rows) {
      if (!row) { warnings.push({ error: "dokument_not_found" }); continue; }
      const url = normalizeFileUrl(row.file);
      if (!url) { warnings.push({ dokument_id: row._id, error: "no_file_url" }); continue; }
      try {
        const buffer = await fetchBinary(url);
        const kind = detectKind(url, buffer);
        if (kind === "pdf") {
          buffers.push(buffer);
        } else if (kind === "jpg" || kind === "png") {
          buffers.push(await imageToPdfBuffer(buffer, kind));
        } else {
          warnings.push({ dokument_id: row._id, error: `unsupported_kind_${kind}` });
        }
      } catch (e) {
        warnings.push({ dokument_id: row._id, error: e?.message || String(e) });
      }
    }
    return { buffers, warnings };
  }

  // ── Kärna: rendera mall-HTML → PDF, merga med bilagor ──────────────
  async function renderContractPdf({ templateHtml, spec, attachmentDokumentIds }) {
    if (!templateHtml) throw _err("template_html_required", 400);
    const html = renderTemplate(templateHtml, spec || {});
    const mainPdf = await renderHtmlToPdf(html);
    const { buffers: attachBuffers, warnings } = await loadAttachmentBuffers(attachmentDokumentIds);
    const mergedPdf = await mergePdfs([mainPdf, ...attachBuffers], {
      title:    "Avtal (mall)",
      producer: "Mira / Carotte",
      creator:  "mira-exchange contract_render",
    });
    return {
      pdfBuffer:       mergedPdf,
      mainBytes:       mainPdf.length,
      attachmentCount: attachBuffers.length,
      warnings,
    };
  }

  // ── Hämta ContractTemplate-rad + resolva default_attachments ──────
  async function _loadTemplate(templateId) {
    const row = await bubbleGet(SERVICES.CTPL_TYPE, templateId);
    if (!row) throw _err("template_not_found", 404);
    return row;
  }

  // ── _resolveTemplateInputs — gemensam pre-render för preview/persist ─
  // Om templateId givet: läs Bubble-mallen + fyll attachments från default
  // om caller inte gav egna. Annars: använd inline templateHtml.
  async function _resolveTemplateInputs({ templateId, templateHtml, attachmentDokumentIds }) {
    let tpl = templateHtml || null;
    let template = null;
    let attachIds = Array.isArray(attachmentDokumentIds) ? attachmentDokumentIds.slice() : [];
    if (templateId) {
      template = await _loadTemplate(templateId);
      tpl = template[SERVICES.CTPL_TEMPLATE_HTML];
      const defaults = template[SERVICES.CTPL_DEFAULT_ATTACHMENTS];
      if (Array.isArray(defaults) && defaults.length && attachIds.length === 0) {
        attachIds = defaults.slice();
      }
    }
    if (!tpl) throw _err("template_html_required", 400);
    return { templateHtml: tpl, template, attachmentDokumentIds: attachIds };
  }

  function _safeFilename(hint) {
    return String(hint || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "avtal";
  }

  function _err(msg, status = 500) {
    const e = new Error(msg);
    e.status = status;
    return e;
  }

  // ── Publik: renderPreview ──────────────────────────────────────────
  // Kräver templateId ELLER templateHtml. Om templateId: default_attachments
  // används automatiskt om caller inte skickar egna. Sparar temp-Dokument
  // med deletable_after = now + 2h.
  async function renderPreview({ templateId, templateHtml, spec, attachmentDokumentIds }) {
    const resolved = await _resolveTemplateInputs({ templateId, templateHtml, attachmentDokumentIds });
    const { pdfBuffer, mainBytes, attachmentCount, warnings } = await renderContractPdf({
      templateHtml:           resolved.templateHtml,
      spec,
      attachmentDokumentIds:  resolved.attachmentDokumentIds,
    });

    const nowIso    = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
    const nameHint  = resolved.template?.[SERVICES.CTPL_NAME] || "inline";
    const filename  = `preview_${_safeFilename(nameHint)}_${Date.now()}.pdf`;

    const rawUrl = await bubbleUploadFile({
      filename,
      contentType: "application/pdf",
      buffer:      pdfBuffer,
    });
    const fileUrl = normalizeFileUrl(rawUrl) || rawUrl;

    const dokumentPayload = {
      titel:         `Preview: ${nameHint}`,
      beskrivning:   "Contract-mall preview (temporär)",
      file:          fileUrl,
      latest_update: nowIso,
    };
    dokumentPayload[SERVICES.DOK_DELETABLE_AFTER] = expiresAt;
    const dokumentId = await bubbleCreate("Dokument", dokumentPayload);

    return {
      dokument_id:      dokumentId,
      file_url:         fileUrl,
      expires_at:       expiresAt,
      bytes:            pdfBuffer.length,
      main_bytes:       mainBytes,
      attachment_count: attachmentCount,
      warnings,
    };
  }

  // ── Publik: renderAndPersist ───────────────────────────────────────
  // Skapar permanent Dokument-rad (utan deletable_after). Används av
  // /admin/contracts/render-and-send för att bygga signeringsunderlaget
  // som sedan skickas in i _createApprovalRequestInternal.
  async function renderAndPersist({ templateId, templateHtml, spec, attachmentDokumentIds, titel }) {
    const resolved = await _resolveTemplateInputs({ templateId, templateHtml, attachmentDokumentIds });
    const { pdfBuffer, mainBytes, attachmentCount, warnings } = await renderContractPdf({
      templateHtml:          resolved.templateHtml,
      spec,
      attachmentDokumentIds: resolved.attachmentDokumentIds,
    });

    const nameHint = titel || resolved.template?.[SERVICES.CTPL_NAME] || "avtal";
    const filename = `avtal_${_safeFilename(nameHint)}_${Date.now()}.pdf`;

    const rawUrl = await bubbleUploadFile({
      filename,
      contentType: "application/pdf",
      buffer:      pdfBuffer,
    });
    const fileUrl = normalizeFileUrl(rawUrl) || rawUrl;

    const dokumentId = await bubbleCreate("Dokument", {
      titel:         nameHint,
      beskrivning:   "Signeringsunderlag (mall-genererat)",
      file:          fileUrl,
      latest_update: new Date().toISOString(),
    });

    return {
      dokument_id:      dokumentId,
      file_url:         fileUrl,
      bytes:            pdfBuffer.length,
      main_bytes:       mainBytes,
      attachment_count: attachmentCount,
      warnings,
    };
  }

  return { renderPreview, renderAndPersist, renderContractPdf };
}
