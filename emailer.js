// ────────────────────────────────────────────────────────────
// emailer.js  –  Mira e-postavisering via SendGrid
// Baserat på mallspecifikation: e-postmallar_claude_underlag.xlsx
//
// Importeras av index.js:
//   import { startEmailPoller } from "./emailer.js";
//   startEmailPoller({ bubbleFind, bubbleGet, bubblePatch });
//
// Datatyper i Bubble:
//   EmailQueue  – en rad per utskick
//   EmailTemplate – ej obligatorisk, subject/cta_label kan overridas
//
// Stödda slugs (template_slug på EmailQueue):
//   invitation_new | matter_new | matter_updated
//   commission_new | commission_updated
//   qc_new         | qc_updated
//   news_new
// ────────────────────────────────────────────────────────────

import nodeCron from "node-cron";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL       = process.env.EMAIL_FROM      || "support@mira-fm.com";
const FROM_NAME        = process.env.EMAIL_FROM_NAME || "Mira";
const APP_BASE_URL     = process.env.APP_BASE_URL    || "https://mira-fm.com";

// ── Bubble-helpers injiceras vid start (undviker cirkulärt beroende) ──
let _bubbleFind, _bubbleGet, _bubblePatch;

// ────────────────────────────────────────────────────────────
// Exporterad startfunktion (anropas från index.js)
// ────────────────────────────────────────────────────────────
export function startEmailPoller({ bubbleFind, bubbleGet, bubblePatch }) {
  _bubbleFind  = bubbleFind;
  _bubbleGet   = bubbleGet;
  _bubblePatch = bubblePatch;

  if (!SENDGRID_API_KEY) {
    console.warn("[email] SENDGRID_API_KEY saknas – e-postpollern startar INTE.");
    return;
  }

  // Kör direkt vid start, sen var 2:a minut
  processEmailQueue().catch(e =>
    console.error("[email] Första körning misslyckades:", e?.message, e?.detail ? JSON.stringify(e.detail) : "")
  );

  nodeCron.schedule("*/2 * * * *", () =>
    processEmailQueue().catch(e =>
      console.error("[email] Poller-fel:", e?.message, e?.detail ? JSON.stringify(e.detail) : "")
    )
  );

  console.log("[email] Poller aktiv – kontrollerar EmailQueue var 2:a minut.");
}

// ────────────────────────────────────────────────────────────
// Huvud-poller: hämtar osända rader, skickar, markerar
// ────────────────────────────────────────────────────────────
async function processEmailQueue() {
  const queue = await _bubbleFind("emailqueue", {
    constraints: [{ key: "email_sent", constraint_type: "equals", value: false }],
    limit: 20,
    sort_field: "Created Date",
    descending: false
  });

  if (!queue.length) return;
  console.log(`[email] ${queue.length} mail i kö`);


  for (const item of queue) {
    try {
      const { subject, html } = await buildEmail(item);

      // Per-utskick avsändarnamn (sätts i index.js från ClientCompany.name).
      // Fallback till global FROM_NAME ("Mira") om saknas.
      let fromName;
      try {
        const ex = safeParseJson(item.extra_data);
        if (ex && ex.from_name) fromName = String(ex.from_name).trim() || undefined;
      } catch (_) {}

      await sendViaSendGrid({
        to:      item.to_email,
        toName:  item.to_name || "",
        subject,
        html,
        fromName
      });

      await _bubblePatch("emailqueue", item._id, {
        email_sent: true,
        sent_at:    new Date().toISOString(),
        error_message: ""
      });

      console.log(`[email] ✓ "${subject}" → ${item.to_email}`);

    } catch (err) {
      console.error(`[email] ✗ ${item._id}:`, err.message);
      await _bubblePatch("emailqueue", item._id, {
        error_message: String(err.message || "Okänt fel").slice(0, 500)
      }).catch(() => {});
    }
  }
}

// ────────────────────────────────────────────────────────────
// buildEmail – orchestrerar datahämtning + rendering
// Förväntar sig dessa fält på EmailQueue-posten:
//   template_id     – relation till EmailTemplate (slug hämtas därifrån)
//   entity_id       – Bubble-ID för relevant post
//   entity_type     – text (för loggning, används ej direkt)
//   to_email        – mottagarens e-post
//   to_name         – mottagarens namn (valfritt)
//   extra_data      – extra data som JSON-sträng (valfritt)
// Fält på EmailTemplate som respekteras vid rendering:
//   slug            – styr vilken mall som väljs
//   subject         – ämnesrad (kan innehålla {{Title}} etc – tolkas ej, används as-is)
//   cta_label       – knapptext (override)
//   accent_color    – hex t.ex. "#db6923" (Eventinbjudan/Nyhet)
// ────────────────────────────────────────────────────────────
async function buildEmail(item) {
  // Hämta EmailTemplate-posten via template_id (Bubble-relation = ID-sträng)
  let tmpl = {};
  if (item.template_id) {
    tmpl = await _bubbleGet("emailtemplate", item.template_id).catch(() => ({})) || {};
  }

  // slug: hämtas från EmailTemplate.slug (primärt) eller direkt på queue-posten (fallback)
  const slug     = String(tmpl.slug || item.template_slug || "").trim();
  const entityId = String(item.entity_id || "").trim();
  const extra    = safeParseJson(item.extra_data);

  // accent_color: EmailTemplate har inget sådant fält ännu – håll som extra_data-override
  const accent   = extra.accent_color || item.accent_color || "#db6923";
  const toName   = item.to_name || "där";

  // cta_label: EmailTemplate.cta_label → annars default per malltyp
  const ctaLabel = tmpl.cta_label || item.cta_label || null;

  if (!slug) throw new Error(
    `Ingen slug – kontrollera att EmailTemplate.slug är ifyllt (template_id: ${item.template_id || "saknas"})`
  );

  // Hämta entity-post om entity_id finns
  const entity = entityId ? await fetchEntity(slug, entityId) : {};

  // subject_override: EmailTemplate.subject används om admin fyllt i det
  const ctx = { ...item, subject_override: tmpl.subject || item.subject_override || null };

  // Välj rätt mall
  switch (slug) {
    case "invitation_new":     return tmplInvitationNew(entity,  extra, toName, accent, ctaLabel, ctx);
    case "matter_new":         return tmplMatterNew(entity,      extra, toName, ctaLabel, ctx);
    case "matter_updated":     return tmplMatterUpdated(entity,  extra, toName, ctaLabel, ctx);
    case "commission_new":     return tmplCommissionNew(entity,  extra, toName, ctaLabel, ctx);
    case "commission_updated": return tmplCommissionUpdated(entity, extra, toName, ctaLabel, ctx);
    case "qc_new":             return tmplQcNew(entity,          extra, toName, ctaLabel, ctx);
    case "qc_updated":         return tmplQcUpdated(entity,      extra, toName, ctaLabel, ctx);
    case "news_new":           return tmplNewsNew(entity,        extra, toName, accent, ctaLabel, ctx);
    case "invoice_question":   return tmplInvoiceQuestion(entity, extra, toName, ctaLabel, ctx);
    case "todo_new":           return tmplTodoNew(entity, extra, toName, ctaLabel, ctx);
      case "public_request_received": return tmplPublicRequestReceived(entity, extra, toName, ctaLabel, ctx);
    case "public_request_internal": return tmplPublicRequestInternal(entity, extra, toName, ctaLabel, ctx);
    case "invite_rsvp_confirmation": return tmplInviteRsvpConfirmation(entity, extra, toName, ctaLabel, ctx);
    case "invite_invitation": return tmplInviteInvitation(entity, extra, toName, ctaLabel, ctx);
    case "news_announcement": return tmplNewsAnnouncement(entity, extra, toName, ctaLabel, ctx);
    case "survey_invitation": return tmplSurveyInvitation(entity, extra, toName, ctaLabel, ctx);
    case "approval_invite":   return tmplApprovalInvite(entity, extra, toName, ctaLabel, ctx);
    case "approval_otp":      return tmplApprovalOtp(entity, extra, toName, ctaLabel, ctx);
    case "approval_signed":   return tmplApprovalSigned(entity, extra, toName, ctaLabel, ctx);
    default:
      throw new Error(`Okänd slug: "${slug}" – lägg till i EmailTemplate.slug`);
  }
}

// ────────────────────────────────────────────────────────────
// Datahämtning per datatyp
// ────────────────────────────────────────────────────────────
async function fetchEntity(slug, id) {
  const typeMap = {
    invitation_new:        "Invitation",
    matter_new:            "Matter",
    matter_updated:        "Matter",
    commission_new:        "Comission",   // Bubble-stavning
    commission_updated:    "Comission",
    qc_new:                "QualityControl",
    qc_updated:            "QualityControl",
    news_new:              "Invitation",
    invoice_question:      "invoiceinquiry",
    todo_new:              "Todo"
  };
  const type = typeMap[slug];
  if (!type) return {};
  try {
    const obj = await _bubbleGet(type, id);
    return obj || {};
  } catch (e) {
    console.warn(`[email] fetchEntity(${type}, ${id}) misslyckades:`, e?.message);
    return {};
  }
}

// Hämta ClientCompany (för logo, namn)
async function fetchClientCompany(id) {
  if (!id) return {};
  try { return (await _bubbleGet("ClientCompany", id)) || {}; } catch { return {}; }
}

// ────────────────────────────────────────────────────────────
// MALL 1: Eventinbjudan  (Invitation, nyhet = false)
// Fält: Rubrik, Brödtext, Avsändare/Logo (ClientCompany),
//       Startdatum, Slutdatum, OSA-datum, Adress,
//       Email avsändare, Bild, accent_color
// ────────────────────────────────────────────────────────────
async function tmplInvitationNew(e, extra, toName, accent, ctaLabel, item) {
  const cc        = await fetchClientCompany(e.client_company || e.ClientCompany);
  const logoUrl   = cc?.logo_url || cc?.Logo || "";
  const senderName= cc?.Name_company || cc?.name || "";

  const title     = e.Title         || e.title        || extra.title      || "Eventinbjudan";
  const body      = e.Description   || e.description  || extra.body       || "";
  const startDate = fmtDate(e.start_date || e.StartDate || extra.start_date);
  const endDate   = fmtDate(e.end_date   || e.EndDate   || extra.end_date);
  const rsvpDate  = fmtDate(e.rsvp_date  || e.OSADate   || extra.rsvp_date);
  const address   = e.address        || e.Address      || extra.address    || "";
  const imageUrl  = e.image_url      || e.Image        || extra.image_url  || "";
  const cta       = ctaLabel         || "OSA nu";
  const subject   = item.subject_override || `${senderName ? senderName + ": " : ""}${title}`;

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl, accent,
    tag: "Inbjudan",
    headline: title,
    body: `<p>${esc(body)}</p>`,
    details: detailRows([
      startDate && ["Startdatum",  startDate],
      endDate   && ["Slutdatum",   endDate],
      rsvpDate  && ["OSA senast",  rsvpDate],
      address   && ["Plats",       address]
    ]),
    ctaLabel: cta,
    ctaUrl: `${APP_BASE_URL}/event/${e._id || ""}`
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 2: Nytt ärende  (Matter)
// Fält: Rubrik, Företag, Logo, Skapad, Beskrivning, Kontor,
//       Prioritet, Ärendekategori, Referens (skapare),
//       Bild, Status, Avvikelse
// ────────────────────────────────────────────────────────────
async function tmplMatterNew(e, extra, toName, ctaLabel, item) {
  // extra_data från Bubble-workflow ska innehålla:
  //   company_id    – matter's Kundföretag's unique id  (för logotyp)
  //   company_name  – matter's Kundföretag's Name_company
  //   category      – matter's Ärendekategori's Display
  //   description   – matter's Beskrivning
  //   ref_name      – matter's Creator's First Name + " " + Creator's Surname
  //   office        – matter's Kontor's Office_title

  const companyId   = extra.company_id   || e.Kundföretag || e.kundföretag || e.company || e.Company || "";
  const cc          = companyId ? await fetchClientCompany(companyId) : null;
  const logoUrl     = cc?.logo_url   || cc?.Logo        || "";
  // Företagsnamn: extra_data prioriteras (redan löst i Bubble), annars API-fältet
  const senderName  = extra.company_name || cc?.Name_company || e.company_name || "";

  const title     = e.Title         || e.title        || extra.title       || "Nytt ärende";
  // Beskrivning: ta från extra_data (Bubble kan skicka den enkelt) eller API-fältet
  const descr     = extra.description || e.Description || e.description    || e.Beskrivning || "";
  const office    = extra.office      || e.Office_title || e.office_title  || "";
  const priority  = e.priority        || e.Prioritet   || extra.priority   || "";
  // Ärendekategori är ett option set – display-värdet skickas enklast via extra_data
  const category  = extra.category    || e.category_title || e.Category    || "";
  const refName   = extra.ref_name    || "";
  const imageUrl  = extra.image_url   || e.image_url   || e.Image          || "";
  const status    = e.Status          || e.status      || "Pågående";
  const avvikelse = e.Avvikelse       ?? e.avvikelse   ?? false;
  // Datum med klockslag
  const createdAt = fmtDateTime(e["Created Date"] || e.created_date);
  const subject   = item.subject_override || `Nytt ärende: ${title}`;

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl, accent: "#db6923",
    tag: "Nytt ärende",
    headline: title,
    body: descr ? `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">${esc(descr)}</p>` : "",
    details: detailRows([
      senderName  && ["Företag",          senderName],
      office      && ["Kontor",           office],
      category    && ["Ärendekategori",   category],
      priority    && ["Prioritet",        priorityBadge(priority)],
      refName     && ["Inrapporterat av", refName],
      createdAt   && ["Inrapporterat",    createdAt],
      status      && ["Status",          status],
      avvikelse    ? ["Avvikelse", '<span style="color:#f87171;font-weight:600;">Ja</span>'] : null
    ]),
    ctaLabel: null,
    ctaUrl: null,
    miraNote: "Läs och hantera ärendet på Mira."
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 3: Ärende uppdatering  (Matter)
// extra_data: ref_name, company_id, company_name, kommentar (list of texts = tråd),
//             status (Display), category
// Används för: ny kommentar OCH statusändring
// ────────────────────────────────────────────────────────────
async function tmplMatterUpdated(e, extra, toName, ctaLabel, item) {
  const companyId  = extra.company_id  || e.Kundföretag || e.kundföretag || e.company || "";
  const cc         = companyId ? await fetchClientCompany(companyId) : null;
  const logoUrl    = cc?.logo_url  || cc?.Logo          || "";
  const senderName = extra.company_name || cc?.Name_company || "";

  const title    = e.Title        || e.title          || "Ärendeuppdatering";
  const status   = extra.status   || e.Status         || e.status || "";
  const category = extra.category || e.category_title || "";
  const office   = extra.office   || e.Office_title   || "";
  const priority = e.priority     || e.Prioritet      || "";
  const refName  = extra.ref_name || "";                // Vem som kommenterade/ändrade
  const subject  = item.subject_override || `Uppdatering: ${title}`;

  // Tråd: extra.kommentar är en list of texts från Bubble → JSON-array
  // Senaste inlägget visas överst (reversad ordning)
  let thread = [];
  try {
    const raw = extra.kommentar;
    if (Array.isArray(raw))      thread = raw;
    else if (typeof raw === "string" && raw.startsWith("[")) thread = JSON.parse(raw);
    else if (typeof raw === "string" && raw) thread = [raw];
  } catch (_) {}

  const reversed   = thread.slice().reverse();   // nyaste överst
  const threadHtml = reversed.length
    ? `<div style="margin:16px 0 4px;">` +
      reversed.map(function(c, i) {
        const isLatest = i === 0;
        const bg      = isLatest ? "#1a1f2e"    : "#0d1117";
        const border  = isLatest ? "#db6923"    : "#262b42";
        const label   = isLatest
          ? `<span style="font-size:10px;font-weight:700;text-transform:uppercase;` +
            `letter-spacing:.07em;color:#db6923;margin-bottom:5px;display:block;">Senaste</span>`
          : "";
        return `<div style="background:${bg};border-left:3px solid ${border};` +
          `border-radius:0 7px 7px 0;padding:11px 14px;margin-bottom:7px;` +
          `font-size:13px;color:#c0c4d6;line-height:1.6;">` +
          label + esc(c) + `</div>`;
      }).join("") +
      `</div>`
    : "";

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl: "", accent: "#db6923",
    tag: "Ärendeuppdatering",
    headline: title,
    body: threadHtml,
    details: detailRows([
      senderName && ["Företag",          senderName],
      office     && ["Kontor",           office],
      category   && ["Ärendekategori",   category],
      priority   && ["Prioritet",        priorityBadge(priority)],
      refName    && ["Uppdaterat av",    refName],
      status     && ["Status",           statusBadge(status)]
    ]),
    ctaLabel: null,
    ctaUrl:   null,
    miraNote: "Läs och hantera ärendet på Mira."
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 4: Ny bokning  (Comission)
// Fält: title, Description, delivery_date, Category,
//       SubcategoryFM/HK/SP/FE, Budget, Beställare (list),
//       guest (number), po_number, Company
// ────────────────────────────────────────────────────────────
async function tmplCommissionNew(e, extra, toName, ctaLabel, item) {
  const cc        = await fetchClientCompany(e.Company || e.company);
  const logoUrl   = cc?.logo_url || cc?.Logo || "";
  const senderName= cc?.Name_company || "";

  const title       = e.commission_title || e.Title       || extra.title    || "Ny bokning";
  const descr       = e.Description      || e.description || "";
  // Leveransdatum med klockslag
  const delivDate   = fmtDateTime(e.delivery_date || e.DeliveryDate);
  const delivAddr   = e.delivery_address  || e.DeliveryAddress || extra.delivery_address || "";
  const category    = e.Category         || e.category    || "";
  const subcat      = e.SubcategoryFM    || e.SubCategoryHK || e.SubCategorySP || e.SubkategoriFE || "";
  const budget      = e.Budget           || e.budget      || "";
  const guests      = e.guest            || e.Guest;
  const poNumber    = e.po_number        || e.PONumber    || "";
  // Beställare: skicka "Förnamn Efternamn" via extra_data.orderer_name (första beställaren)
  // eller en kommaseparerad lista via extra_data.orderers
  const ordererName = extra.orderer_name || "";
  const orderers    = ordererName ? [ordererName] : asArray(extra.orderers);
  const erbjudande  = extra.erbjudande || "";
  const subject     = item.subject_override || `Ny bokning: ${title}`;

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl: "", accent: "#db6923",
    tag: "Ny bokning",
    headline: title,
    body: descr ? `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">${esc(descr)}</p>` : "",
    details: detailRows([
      senderName          && ["Företag",       senderName],
      orderers.length     && ["Beställare",    orderers.join(", ")],
      delivDate           && ["Leveransdatum", delivDate],
      delivAddr           && ["Leveransadress",delivAddr],
      category            && ["Kategori",      category],
      subcat              && ["Underkategori",  subcat],
      erbjudande          && ["Erbjudande",    erbjudande],
      budget              && ["Budget",         budget],
      guests != null      && ["Antal gäster",   String(guests)],
      poNumber            && ["PO-nummer",      poNumber]
    ]),
    ctaLabel: null,
    ctaUrl: null,
    miraNote: "Läs och hantera bokningen på Mira."
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 5: Bokning uppdatering  (Comission)
// extra_data: orderer_name, company_id, company_name, kommentar (tråd), status
// ────────────────────────────────────────────────────────────
async function tmplCommissionUpdated(e, extra, toName, ctaLabel, item) {
  const companyId  = extra.company_id  || e.Company || e.company || "";
  const cc         = companyId ? await fetchClientCompany(companyId) : null;
  const logoUrl    = cc?.logo_url   || cc?.Logo           || "";
  const senderName = extra.company_name || cc?.Name_company || "";

  const title        = e.commission_title || e.Title  || extra.title || "Bokningsuppdatering";
  const status       = extra.status       || e.commission_status || e.status || "";
  const ordererName  = extra.orderer_name || "";
  const delivDate    = fmtDateTime(e.delivery_date || e.DeliveryDate);
  const category     = e.Category        || e.category || "";
  const subject      = item.subject_override || `Uppdatering: ${title}`;

  // Tråd: extra.kommentar är en list of texts → JSON-array, nyaste överst
  let thread = [];
  try {
    const raw = extra.kommentar;
    if (Array.isArray(raw))      thread = raw;
    else if (typeof raw === "string" && raw.startsWith("[")) thread = JSON.parse(raw);
    else if (typeof raw === "string" && raw) thread = [raw];
  } catch (_) {}

  const reversed   = thread.slice().reverse();
  const threadHtml = reversed.length
    ? `<div style="margin:16px 0 4px;">` +
      reversed.map(function(c, i) {
        const isLatest = i === 0;
        const bg      = isLatest ? "#1a1f2e" : "#0d1117";
        const border  = isLatest ? "#db6923" : "#262b42";
        const label   = isLatest
          ? `<span style="font-size:10px;font-weight:700;text-transform:uppercase;` +
            `letter-spacing:.07em;color:#db6923;margin-bottom:5px;display:block;">Senaste</span>`
          : "";
        return `<div style="background:${bg};border-left:3px solid ${border};` +
          `border-radius:0 7px 7px 0;padding:11px 14px;margin-bottom:7px;` +
          `font-size:13px;color:#c0c4d6;line-height:1.6;">` +
          label + esc(c) + `</div>`;
      }).join("") +
      `</div>`
    : "";

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl: "", accent: "#db6923",
    tag: "Bokningsuppdatering",
    headline: title,
    body: threadHtml,
    details: detailRows([
      senderName    && ["Företag",     senderName],
      ordererName   && ["Beställare",  ordererName],
      delivDate     && ["Leveransdatum", delivDate],
      category      && ["Kategori",    category],
      status        && ["Status",      statusBadge(status)]
    ]),
    ctaLabel: null,
    ctaUrl:   null,
    miraNote: "Läs och hantera bokningen på Mira."
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 6: Kvalitetskontroll  (QualityControl)
// extra_data: ref_name, company_id, company_name, betyg, meddelande, office
// ────────────────────────────────────────────────────────────
async function tmplQcNew(e, extra, toName, ctaLabel, item) {
  // Hämta logotyp via company_id om det finns i extra_data (annars via entity-fält)
  const companyId  = extra.company_id   || e.Kundföretag || e.clientcompany || e.ClientCompany || "";
  const cc         = companyId ? await fetchClientCompany(companyId) : null;
  const logoUrl    = cc?.logo_url    || cc?.Logo         || "";
  const senderName = extra.company_name || cc?.Name_company || "";

  // extra_data-nycklar matchar Bubble-workflow (se screenshot):
  // ref_name=Kontrollant, betyg=Betyg_lev, meddelande=Meddelande, office=Kontor's Office_title
  const inspector  = extra.ref_name   || extra.inspector_name || "";
  const message    = extra.meddelande || e.Meddelande         || e.message   || "";
  const betyg      = extra.betyg      || e.Betyg_lev          || e.betyg     || "";
  const office     = extra.office     || e.office_title        || "";
  const qcDate     = fmtDateTime(e.kontrolldatum || e.QCDate   || extra.qc_date);

  // Avtal: e.Avtal är ett Bubble-ID (relation) → hämta titeln via bubbleGet
  let contract = extra.contract_title || e.contract_title || "";
  if (!contract && e.Avtal) {
    try {
      const avtal = await bubbleGet("Avtal", e.Avtal);
      contract = avtal?.Title || avtal?.title || avtal?.Name || "";
    } catch (_) {}
  }
  const subject    = item.subject_override
    || `Kvalitetskontroll: ${senderName || contract || "rapport"}`;

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl: "", accent: "#db6923",
    tag: "Kvalitetskontroll",
    headline: "Kvalitetskontroll genomförd",
    body: message
      ? `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">${esc(message)}</p>`
      : "",
    details: detailRows([
      senderName  && ["Företag",     senderName],
      office      && ["Kontor",      office],
      contract    && ["Avtal",       contract],
      inspector   && ["Kontrollant", inspector],
      qcDate      && ["Datum",       qcDate],
      betyg       && ["Betyg",       starRating(betyg)]
    ]),
    ctaLabel: null,
    ctaUrl:   null,
    miraNote: "Läs rapporten på Mira."
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 7: Kvalitetskontroll uppdatering  (QualityControl)
// extra_data: ref_name, company_id, company_name, betyg_client, feedback_client, office
// ────────────────────────────────────────────────────────────
async function tmplQcUpdated(e, extra, toName, ctaLabel, item) {
  const companyId      = extra.company_id     || e.Kundföretag || e.clientcompany || "";
  const cc             = companyId ? await fetchClientCompany(companyId) : null;
  const logoUrl        = cc?.logo_url     || cc?.Logo          || "";
  const senderName     = extra.company_name   || cc?.Name_company || "";

  const inspector      = extra.ref_name       || "";
  const office         = extra.office         || e.office_title   || "";
  // Kundens betyg och feedback (skiljer sig från Betyg_lev i qc_new)
  const betygClient    = extra.betyg_client   || "";
  const feedbackClient = extra.feedback_client || e.feedback_client || "";
  const subject        = item.subject_override || `Uppdatering: Kvalitetskontroll${senderName ? " – " + senderName : ""}`;

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl: "", accent: "#db6923",
    tag: "QC-uppdatering",
    headline: "Ny återkoppling på kvalitetskontroll",
    body: feedbackClient
      ? `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">${esc(feedbackClient)}</p>`
      : "",
    details: detailRows([
      senderName    && ["Företag",           senderName],
      office        && ["Kontor",            office],
      inspector     && ["Kontrollant",       inspector],
      betygClient   && ["Betyg (kund)",      `<span style="background:rgba(219,105,35,.15);color:#db6923;font-weight:600;padding:2px 10px;border-radius:20px;font-size:12px;">${esc(betygClient)}</span>`]
    ]),
    ctaLabel: null,
    ctaUrl:   null,
    miraNote: "Läs rapporten på Mira."
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 8: Nyhet  (Invitation, nyhet = true)
// Fält: Rubrik, Brödtext, Avsändare/Logo (ClientCompany),
//       Email avsändare, Bild, Created At, accent_color
// ────────────────────────────────────────────────────────────
async function tmplNewsNew(e, extra, toName, accent, ctaLabel, item) {
  const cc        = await fetchClientCompany(e.client_company || e.ClientCompany);
  const logoUrl   = cc?.logo_url || cc?.Logo || "";
  const senderName= cc?.Name_company || "";

  const title     = e.Title        || e.title       || extra.title    || "Nyhet";
  const body      = e.Description  || e.description || extra.body     || "";
  const imageUrl  = e.image_url    || e.Image       || extra.image_url|| "";
  const createdAt = fmtDate(e["Created Date"] || e.created_at);
  const subject   = item.subject_override || title;

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl, accent,
    tag: "Nyhet",
    headline: title,
    body: `<p style="line-height:1.65;">${esc(body)}</p>`,
    details: detailRows([
      createdAt && ["Publicerad", createdAt]
    ]),
    ctaLabel: ctaLabel || "Läs mer",
    ctaUrl: `${APP_BASE_URL}/news/${e._id || ""}`
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL: invoice_question  (InvoiceInquiry)
// extra_data: case_number, billing_company_name
// ────────────────────────────────────────────────────────────
async function tmplInvoiceQuestion(e, extra, toName, ctaLabel, ctx) {
  const caseNr      = extra.case_number          || "";
  const billingCo   = extra.billing_company_name || e.billing_company || "";
  const contactName = e.contact_name             || toName             || "";
  const company     = e.company_name_raw         || extra.company      || "";
  const caseType    = e.case_type                || "";
  const invNr       = e.invoice_number           || "";
  const billingInv  = e.billing_invoice_number   || "";
  const poNr        = e.po_number                || "";
  const clientRef   = e.client_reference         || "";
  const carotteRef  = e.carotte_reference        || "";
  const descr       = e.description              || "";
  const status      = e.status                   || "Pågående";
  const phone       = e.phone                    || "";
  const emailAddr   = e.email                    || "";

  // Bilagor
  let filesHtml = "";
  try {
    const fi = e.files_info ? JSON.parse(e.files_info) : [];
    if (fi.length) filesHtml = `<p style="font-size:13px;color:#c0c4d6;margin-top:16px">
      <strong>Bilagor:</strong> ${fi.map(f => esc(f.name)).join(", ")}</p>`;
  } catch {}

  const subject = ctx.subject_override || (caseNr ? `[${caseNr}] Fakturafråga` : "Fakturafråga");

  const html = wrapLayout({ toName, logoUrl: "", senderName: "Carotte", imageUrl: "",
    accent: "#db6923",
    tag: "Fakturafråga",
    headline: caseNr ? `Fakturafråga · ${caseNr}` : "Fakturafråga",
    body: descr
      ? `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">${esc(descr)}</p>${filesHtml}`
      : filesHtml,
    details: detailRows([
      caseNr      && ["Ärendenummer",   `<span style="font-family:monospace;color:#db6923;font-weight:700;">${esc(caseNr)}</span>`],
      status      && ["Status",         statusBadge(status)],
      contactName && ["Kontakt",        contactName],
      company     && ["Företag",        company],
      emailAddr   && ["E-post",         emailAddr],
      phone       && ["Telefon",        phone],
      caseType    && ["Ärendetyp",      caseType],
      billingCo   && ["Fakturabolag",   billingCo],
      billingInv  && ["Fakturanummer",  billingInv],
      invNr && invNr !== billingInv && ["Ref. fakturanr", invNr],
      poNr        && ["PO-nummer",      poNr],
      clientRef   && ["Er referens",    clientRef],
      carotteRef  && ["Carottes ref.",  carotteRef]
    ]),
    ctaLabel: null,
    ctaUrl:   null,
    miraNote: "Läs och hantera ärendet på Mira."
  });

  return { subject, html };
}


// ────────────────────────────────────────────────────────────
// MALL: todo_new  (Todo)
// extra_data: ref_name, company_id, company_name,
//             meddelande (Beskrivning), deadline (Sluttid), kategori (Display)
// ────────────────────────────────────────────────────────────
async function tmplTodoNew(e, extra, toName, ctaLabel, item) {
  const companyId  = extra.company_id   || e.Företag || e.company || "";
  const cc         = companyId ? await fetchClientCompany(companyId) : null;
  const logoUrl    = cc?.logo_url    || cc?.Logo          || "";
  const senderName = extra.company_name || cc?.Name_company || "";

  const title     = e.Title          || e.title          || extra.title    || "Ny uppgift";
  const message   = extra.meddelande || e.Beskrivning    || e.description  || "";
  const deadline  = fmtDateTime(extra.deadline || e.Sluttid || e.deadline);
  const category  = extra.kategori   || e.Kategori       || "";
  const refName   = extra.ref_name   || "";
  const createdAt = fmtDateTime(e["Created Date"] || e.created_date);
  const subject   = item.subject_override || `Ny uppgift: ${title}`;

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl: "", accent: "#db6923",
    tag: "Uppgift",
    headline: title,
    body: message
      ? `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">${esc(message)}</p>`
      : "",
    details: detailRows([
      senderName && ["Företag",    senderName],
      category   && ["Kategori",   category],
      deadline   && ["Sluttid",    `<span style="font-weight:600;color:#fbbf24;">${esc(deadline)}</span>`],
      refName    && ["Skapad av",  refName],
      createdAt  && ["Skapad",     createdAt]
    ]),
    ctaLabel: null,
    ctaUrl:   null,
    miraNote: "Hantera uppgiften på Mira."
  });

  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// HTML-layout (Carotte brand: #0d1117 / #161c2d / accent)
// ────────────────────────────────────────────────────────────
function wrapLayout({
  toName, logoUrl, senderName, imageUrl,
  accent = "#db6923", tag, headline, body,
  details, ctaLabel, ctaUrl, miraNote = null,
  subhead = null, socialBlock = null, footer = null
}) {
  // E-postklienter (Outlook m.fl.) laddar inte protokoll-relativa "//"-URL:er
  const _abs = u => { u = String(u || "").trim(); return u.startsWith("//") ? "https:" + u : u; };
  logoUrl = _abs(logoUrl); imageUrl = _abs(imageUrl);
  const logoBlock = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(senderName)}"
            style="height:32px;max-width:140px;object-fit:contain;display:block;margin-bottom:20px;">`
    : `<span style="font-size:15px;font-weight:600;color:#e8eaf0;">${esc(senderName || "Mira")}</span>`;

  const imageBlock = imageUrl
    ? `<img src="${esc(imageUrl)}" alt=""
            style="width:100%;max-height:240px;object-fit:cover;display:block;
                   border-radius:8px;margin-bottom:24px;">`
    : "";

  const tagBlock = tag
    ? `<div style="display:inline-flex;align-items:center;gap:6px;
                   background:${hexAlpha(accent, "1a")};
                   border:1px solid ${hexAlpha(accent, "33")};
                   color:${accent};font-size:11px;font-weight:600;
                   padding:3px 12px;border-radius:20px;
                   letter-spacing:.05em;text-transform:uppercase;
                   margin-bottom:14px;">
         <span style="width:5px;height:5px;border-radius:50%;background:${accent};display:inline-block;"></span>
         ${esc(tag)}
       </div>`
    : "";

  const ctaBlock = ctaLabel && ctaUrl
    ? `<div style="margin:28px 0 8px;">
         <a href="${esc(ctaUrl)}"
            style="display:inline-block;background:${accent};color:#ffffff;
                   font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;
                   padding:13px 30px;border-radius:8px;text-decoration:none;
                   letter-spacing:-.1px;">
           ${esc(ctaLabel)}
         </a>
       </div>`
    : miraNote
    ? `<p style="font-size:13px;color:#606880;margin:28px 0 20px;font-style:italic;">${esc(miraNote)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(headline)}</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:40px 16px;">

  <table width="600" cellpadding="0" cellspacing="0" border="0"
         style="background:#161c2d;border-radius:12px;overflow:hidden;
                max-width:600px;width:100%;">

    <!-- Top accent bar -->
    <tr><td style="background:${accent};height:3px;"></td></tr>

    <!-- Header / Logo -->
    <tr><td style="padding:28px 36px 0;">
      ${logoBlock}
    </td></tr>

    <!-- Hero image (om det finns) -->
    ${imageUrl ? `<tr><td style="padding:20px 36px 0;">${imageBlock}</td></tr>` : ""}

    <!-- Body -->
    <tr><td style="padding:24px 36px 0;">
      ${tagBlock}
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;
                 color:#e8eaf0;line-height:1.25;letter-spacing:-.3px;">
        ${esc(headline)}
      </h1>
      ${subhead ? `<p style="margin:0 0 14px;font-size:11px;color:#8892aa;letter-spacing:.06em;text-transform:uppercase;font-weight:600;">${esc(subhead)}</p>` : ""}
      ${toName ? `<p style="margin:0 0 6px;font-size:14px;color:#8892aa;">Hej ${esc(toName)},</p>` : ""}
      <div style="font-size:14px;color:#c0c4d6;line-height:1.65;margin:12px 0 0;">
        ${body || ""}
      </div>
    </td></tr>

    <!-- Detail table (om det finns) -->
    ${details ? `
    <tr><td style="padding:20px 36px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#0d1117;border:1px solid #262b42;border-radius:10px;overflow:hidden;">
        ${details}
      </table>
    </td></tr>` : ""}

    <!-- CTA -->
    <tr><td style="padding:20px 36px 0;">
      ${ctaBlock}
    </td></tr>

    <!-- Sociala ikoner (om angivna) -->
    ${socialBlock ? `<tr><td style="padding:18px 36px 8px;">${socialBlock}</td></tr>` : ""}

    <!-- Footer -->
    <tr><td style="padding:24px 36px;border-top:1px solid #1e2437;">
      ${footer ? buildFooterBlock(footer, senderName) : `<p style="font-size:11px;color:#3a4055;line-height:1.6;margin:0;">Mira · Carotte Group AB</p>`}
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

// ────────────────────────────────────────────────────────────
// Boilerplate-footer för utgående mejl: kontaktuppgifter + copyright + policy.
// Mejl-säker (ren HTML, inga externa bilder). Renderar bara ifyllda fält.
// ────────────────────────────────────────────────────────────
function buildFooterBlock(f, fallbackName) {
  f = f || {};
  const abs = u => { u = String(u || "").trim(); return u.startsWith("//") ? "https:" + u : u; };
  const showUrl = u => String(u || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const year = new Date().getFullYear();
  const org  = String(f.org_name || f.company_name || fallbackName || "Carotte Group AB").trim();
  const link = "color:#8892aa;text-decoration:none;";
  const rows = [];

  const contact = [];
  if (f.website) contact.push(`<a href="${esc(abs(f.website))}" style="${link}">${esc(showUrl(f.website))}</a>`);
  if (f.email)   contact.push(`<a href="mailto:${esc(f.email)}" style="${link}">${esc(f.email)}</a>`);
  if (f.phone)   contact.push(`<span style="color:#8892aa;">${esc(f.phone)}</span>`);
  if (contact.length) rows.push(contact.join(" &nbsp;·&nbsp; "));

  if (f.address) rows.push(`<span style="color:#606880;">${esc(f.address)}</span>`);

  let legal = `© ${year} ${esc(org)}. Alla rättigheter förbehållna.`;
  if (f.privacy_url) legal += ` &nbsp;·&nbsp; <a href="${esc(abs(f.privacy_url))}" style="color:#606880;text-decoration:underline;">Integritetspolicy</a>`;
  rows.push(`<span style="color:#606880;">${legal}</span>`);

  // Avregistrering (GDPR): per-mottagare-länk injicerad i send-flödet. Renderas bara om satt.
  const unsub = f.unsubscribe_url
    ? `<p style="font-size:11px;line-height:1.7;margin:6px 0 0;"><a href="${esc(abs(f.unsubscribe_url))}" style="color:#606880;text-decoration:underline;">Avregistrera dig från utskick</a></p>`
    : "";

  return rows.map(r => `<p style="font-size:11px;line-height:1.7;margin:0 0 4px;">${r}</p>`).join("")
       + unsub
       + `<p style="font-size:10px;color:#3a4055;margin:8px 0 0;">Drivs av Mira</p>`;
}

// ────────────────────────────────────────────────────────────
// Sociala ikoner i mailfot — färgade rutor med bokstavsförkortning.
// Mejl-säker: ren HTML-tabell, inga externa bilder, fungerar i Outlook.
// ────────────────────────────────────────────────────────────
function buildSocialBlock(linkedin, facebook, instagram) {
  linkedin  = String(linkedin  || "").trim();
  facebook  = String(facebook  || "").trim();
  instagram = String(instagram || "").trim();
  if (!linkedin && !facebook && !instagram) return "";
  const btn = (url, label, bg, title) => url
    ? `<td style="padding:0 5px;"><a href="${esc(url)}" title="${esc(title)}" style="display:inline-block;width:34px;height:34px;line-height:34px;background:${bg};color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;border-radius:8px;text-align:center;font-family:Arial,sans-serif;">${label}</a></td>`
    : "";
  return `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>
    ${btn(linkedin,  'in', '#0a66c2', 'LinkedIn')}
    ${btn(facebook,  'f',  '#1877f2', 'Facebook')}
    ${btn(instagram, '@',  '#e1306c', 'Instagram')}
  </tr></table>`;
}

// ────────────────────────────────────────────────────────────
// Detaljtabell-rader
// Skicka in: [[label, value], false, null, …]
// Falskt/null filtreras bort automatiskt
// ────────────────────────────────────────────────────────────
function detailRows(pairs) {
  const valid = pairs.filter(Boolean);
  if (!valid.length) return "";

  return valid.map(([label, value], i) => {
    const bg = i % 2 === 0 ? "#0d1117" : "#0a0d15";
    return `<tr style="background:${bg};">
      <td style="padding:10px 16px;font-size:11px;font-weight:600;color:#4a5068;
                 text-transform:uppercase;letter-spacing:.07em;white-space:nowrap;
                 border-bottom:1px solid #1a1f2e;width:38%;">
        ${esc(label)}
      </td>
      <td style="padding:10px 16px;font-size:13px;color:#c0c4d6;
                 border-bottom:1px solid #1a1f2e;">
        ${value}
      </td>
    </tr>`;
  }).join("");
}

// ────────────────────────────────────────────────────────────
// Hjälpfunktioner
// ────────────────────────────────────────────────────────────

// Säker HTML-escape
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Konvertera hex-färg till hex + 2-siffrig alpha ("1a" = 10%, "33" = 20%)
function hexAlpha(hex, alpha) {
  return hex + alpha;
}

// Datum → "5 maj 2026" (svensk tidszon)
function fmtDate(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return String(v);
    return d.toLocaleDateString("sv-SE", {
      day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Stockholm"
    });
  } catch {
    return String(v);
  }
}

// Datum + tid → "5 maj 2026, 17:13" (svensk tidszon)
function fmtDateTime(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return String(v);
    const tz = "Europe/Stockholm";
    return d.toLocaleDateString("sv-SE", {
      day: "numeric", month: "long", year: "numeric", timeZone: tz
    }) + ", " + d.toLocaleTimeString("sv-SE", {
      hour: "2-digit", minute: "2-digit", timeZone: tz
    });
  } catch {
    return String(v);
  }
}

// Prioritet → färgad badge-HTML
function priorityBadge(p) {
  const str = String(p || "").toLowerCase();
  const colors = {
    hög:    ["#f87171", "rgba(248,113,113,.12)"],
    high:   ["#f87171", "rgba(248,113,113,.12)"],
    medel:  ["#fbbf24", "rgba(251,191,36,.12)"],
    medium: ["#fbbf24", "rgba(251,191,36,.12)"],
    låg:    ["#34d399", "rgba(52,211,153,.12)"],
    low:    ["#34d399", "rgba(52,211,153,.12)"]
  };
  const [fg, bg] = colors[str] || ["#8892aa", "rgba(136,146,170,.12)"];
  return `<span style="background:${bg};color:${fg};font-size:11px;font-weight:600;
                        padding:2px 9px;border-radius:10px;">${esc(p)}</span>`;
}

// Status → subtil badge
function statusBadge(s) {
  return `<span style="background:rgba(99,130,255,.1);color:#8099ff;font-size:11px;
                        font-weight:500;padding:2px 9px;border-radius:10px;">${esc(s)}</span>`;
}

// Betyg (1–5) → stjärnor
function starRating(v) {
  const n = Math.round(Number(v) || 0);
  const stars = Array.from({ length: 5 }, (_, i) =>
    `<span style="color:${i < n ? "#f59e0b" : "#2a2f40"};font-size:16px;">★</span>`
  ).join("");
  return `${stars} <span style="font-size:12px;color:#8892aa;margin-left:4px;">${n}/5</span>`;
}

// Bubbles "list of texts" kan komma som array eller kommaseparerad sträng
function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(",").map(s => s.trim()).filter(Boolean);
}

// Säker JSON-parse (returnerar {} vid fel)
function safeParseJson(v) {
  if (!v) return {};
  try { return JSON.parse(v); } catch { return {}; }
}
// ════════════════════════════════════════════════════════════════════════════
// emailer.js – TILLÄGG för publik medarbetarportal
//
// INTEGRATION (2 steg, minimal risk – fetchEntity behöver INTE ändras):
//
//   1) I buildEmail():s switch(slug) { … } lägg till två cases:
//
//          case "public_request_received": return tmplPublicRequestReceived(entity, extra, toName, ctaLabel, ctx);
//          case "public_request_internal": return tmplPublicRequestInternal(entity, extra, toName, ctaLabel, ctx);
//
//   2) Klistra in de två funktionerna nedan i emailer.js (t.ex. efter tmplCommissionUpdated).
//
// Funktionerna hämtar sin egen entitet via item.entity_type (matter|commission),
// så den statiska typeMap:en i fetchEntity lämnas orörd (returnerar {} för dessa
// slugs, vilket är ofarligt eftersom vi ignorerar `e`).
//
// Återanvänder befintliga helpers i emailer.js: wrapLayout, detailRows, fmtDateTime,
//   fmtDate, esc, statusBadge, _bubbleGet.
// ════════════════════════════════════════════════════════════════════════════

// Gemensam entitetshämtning för publika förfrågningar
async function _fetchPublicEntity(item, extra) {
  const kind = (item.entity_type === "matter" || extra.request_kind === "ticket")
    ? "ticket" : "booking";
  const realType = kind === "ticket" ? "Matter" : "Comission";
  const ent = item.entity_id
    ? ((await _bubbleGet(realType, item.entity_id).catch(() => ({}))) || {})
    : {};
  return { kind, ent };
}
function _firstThread(t){ return Array.isArray(t) ? (t[0] || "") : (t || ""); }

// ────────────────────────────────────────────────────────────
// MALL 6: Bekräftelse till medarbetaren (submitter)
// slug: public_request_received
// Titel + referensnummer kommer från extra (request_title / reference).
// ────────────────────────────────────────────────────────────
async function tmplPublicRequestReceived(e, extra, toName, ctaLabel, item) {
  const { kind, ent } = await _fetchPublicEntity(item, extra);
  const senderName = extra.company_name || "";
  const accent     = extra.accent_color || "#df6f39";
  const ref        = extra.reference || ent._id || "";

  if (kind === "ticket") {
    const title = extra.request_title || ent.Rubrik || ent.rubrik || "Din felanmälan";
    const descr = ent.Beskrivning || _firstThread(ent["Tråd"]) || "";
    const subject = item.subject_override || "Vi har tagit emot din felanmälan";
    const html = wrapLayout({
      toName, logoUrl: "", senderName, imageUrl: "", accent,
      tag: "Mottaget",
      headline: "Tack – din felanmälan är registrerad",
      body: `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">`
          + `Vi har tagit emot din anmälan och teamet${senderName ? ` hos ${esc(senderName)}` : ""} `
          + `tar hand om den. Du behöver inte göra något mer.</p>`
          + (descr ? `<p style="font-size:13px;color:#8892aa;line-height:1.6;margin-top:10px;"><em>${esc(descr)}</em></p>` : ""),
      details: detailRows([
        title        && ["Felanmälan",      esc(title)],
        ref          && ["Referensnummer",  esc(ref)],
        senderName   && ["Företag",         senderName],
        extra.office && ["Kontor",          extra.office],
        ["Hanteras av", "Internservice"]
      ]),
      ctaLabel: null, ctaUrl: null,
      miraNote: "Du får ett nytt mejl när status ändras."
    });
    return { subject, html };
  }

  // booking
  const title   = extra.request_title || ent["Commission title"] || ent.commission_title || "Din beställning";
  const descr   = ent.Description || ent.description || "";
  const delivDt = fmtDateTime(ent.delivery_date || ent.DeliveryDate);
  const subject = item.subject_override || "Vi har tagit emot din beställning";
  const html = wrapLayout({
    toName, logoUrl: "", senderName, imageUrl: "", accent,
    tag: "Mottagen",
    headline: "Tack – din beställning är mottagen",
    body: `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">`
        + `Din beställning är sparad som <strong style="color:#e8eaf0;">utkast</strong> `
        + `och granskas av internservice${senderName ? ` hos ${esc(senderName)}` : ""} innan den bekräftas. Vi hör av oss.</p>`
        + (descr ? `<p style="font-size:13px;color:#8892aa;line-height:1.6;margin-top:10px;"><em>${esc(descr)}</em></p>` : ""),
    details: detailRows([
      title        && ["Beställning",     esc(title)],
      ref          && ["Referensnummer",  esc(ref)],
      senderName   && ["Företag",         senderName],
      extra.office && ["Kontor",          extra.office],
      delivDt      && ["Önskat datum",    delivDt],
      ["Hanteras av", "Internservice"]
    ]),
    ctaLabel: null, ctaUrl: null,
    miraNote: "Du får en bekräftelse när förfrågan är godkänd."
  });
  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// MALL 7: Intern notis till kopplade users
// slug: public_request_internal
// Titel: "Ny beställning / felanmälan att granska" + referensnummer.
// ────────────────────────────────────────────────────────────
async function tmplPublicRequestInternal(e, extra, toName, ctaLabel, item) {
  const { kind, ent } = await _fetchPublicEntity(item, extra);
  const senderName = extra.company_name || "";
  const submitter  = extra.submitter_name || extra.submitter_email || "";
  const accent     = extra.accent_color || "#df6f39";
  const ref        = extra.reference || ent._id || "";
  const title      = extra.request_title
                   || (kind === "ticket" ? (ent.Rubrik || ent.rubrik) : (ent["Commission title"] || ent.commission_title))
                   || (kind === "ticket" ? "Ny felanmälan" : "Ny beställning");
  const descr      = (kind === "ticket" ? (ent.Beskrivning || _firstThread(ent["Tråd"]))
                                        : (ent.Description || ent.description)) || "";
  const delivDt    = fmtDateTime(ent.delivery_date || ent.DeliveryDate);
  const subject = item.subject_override || "Ny beställning / felanmälan att granska";
  const html = wrapLayout({
    toName, logoUrl: "", senderName, imageUrl: "", accent,
    tag: kind === "ticket" ? "Internservice · felanmälan" : "Internservice · utkast",
    headline: "Ny beställning / felanmälan att granska",
    body: `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">`
        + `${esc(title)}${senderName ? ` – ${esc(senderName)}` : ""}.</p>`
        + (descr ? `<p style="font-size:13px;color:#8892aa;line-height:1.6;margin-top:10px;"><em>${esc(descr)}</em></p>` : ""),
    details: detailRows([
      title                 && [kind === "ticket" ? "Felanmälan" : "Beställning", esc(title)],
      ref                   && ["Referensnummer",  esc(ref)],
      senderName            && ["Företag",          senderName],
      extra.office          && ["Kontor",           extra.office],
      submitter             && ["Inskickat av",     esc(submitter)],
      extra.submitter_email && ["E-post",           esc(extra.submitter_email)],
      extra.submitter_phone && ["Telefon",          esc(extra.submitter_phone)],
      delivDt               && ["Leveransdatum",    delivDt],
      ["Hanteras av", "Internservice"],
      ["Status", statusBadge("Utkast")],
      ["Källa", "Publik landningssida"]
    ]),
    ctaLabel: null, ctaUrl: null,
    miraNote: "Granska och hantera i Mira."
  });
  return { subject, html };
}
// ────────────────────────────────────────────────────────────
// MALL: Inbjudan – OSA-bekräftelse (kodbaserad, matchar övriga tmpl*)
// Läser allt ur extra (event_title, event_start/end, event_location,
// event_address, company_name, accent_color, rsvp_status, plus_ones_count,
// allergens_summary, guest_name, logo_url). Entiteten behövs inte.
// ────────────────────────────────────────────────────────────
async function tmplInviteInvitation(e, extra, toName, ctaLabel, item) {
  const x = extra || {};
  const senderName = x.company_name || "";
  const accent     = x.accent_color || "#df6f39";
  const guest      = x.guest_name || toName || "";
  const title      = x.event_title || "Inbjudan";

  let when = "";
  if (x.event_start) {
    when = fmtDateTime(x.event_start);
    if (x.event_end) { const t = String(fmtDateTime(x.event_end)).split(" ").pop(); if (t) when += "\u2013" + t; }
  }
  const deadline = x.rsvp_deadline ? String(fmtDateTime(x.rsvp_deadline)).split(" ")[0] : "";

  const subject  = item.subject_override || ("Inbjudan: " + title);
  const intro    = x.description
    ? esc(x.description).replace(/\n/g, "<br>")
    : "Du \u00e4r varmt v\u00e4lkommen! H\u00e4r \u00e4r detaljerna:";

  const html = wrapLayout({
    toName: guest || toName, logoUrl: x.logo_url || "", senderName, imageUrl: x.image_url || "", accent,
    tag: "Inbjudan",
    headline: title,
    body: '<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">' + intro + '</p>',
    details: detailRows([
      when && ["N\u00e4r", esc(when)],
      x.event_location && ["Plats", esc(x.event_location)],
      x.event_address && ["Adress", esc(x.event_address)],
      deadline && ["Sista anm\u00e4lan", esc(deadline)]
    ]),
    ctaLabel: ctaLabel || "Svara p\u00e5 inbjudan",
    ctaUrl: x.invite_link || null,
    miraNote: "Klicka p\u00e5 knappen f\u00f6r att svara p\u00e5 inbjudan.",
    footer: x.footer || null
  });
  return { subject, html };
}

// slug: news_announcement
// extra: { title (via event_title), description, image_url, logo_url, accent_color,
//          company_name, host_name, cta_label, cta_url, guest_name }
async function tmplNewsAnnouncement(e, extra, toName, ctaLabel, item) {
  const x = extra || {};
  const senderName = x.company_name || "";
  const accent     = x.accent_color || "#df6f39";
  const title      = x.event_title || "Nyhet";

  const subject = item.subject_override || title;
  const body    = x.description
    ? esc(x.description).replace(/\n\n+/g, "</p><p style=\"font-size:14px;color:#c0c4d6;line-height:1.65;margin:0 0 14px;\">").replace(/\n/g, "<br>")
    : "";
  const ctaUrl  = String(x.cta_url || "").trim();
  // CTA-precedens: per-utskick (x.cta_label) > template-default (ctaLabel) > hårdkodad fallback
  const finalCtaLabel = (x.cta_label || ctaLabel || "Läs mer").trim();

  // "Publicerat: <datum>" — när kampanjen skapades
  const pubDate = fmtDate(x.published_at);
  const subhead = pubDate ? `Publicerat: ${pubDate}` : null;

  // Sociala ikoner i mailfot (om angivna)
  const socialBlock = buildSocialBlock(x.linkedin_url, x.facebook_url, x.instagram_url);

  const html = wrapLayout({
    // toName tomt = ingen "Hej Namn,"-hälsning för nyhetsutskick
    toName: "", logoUrl: x.logo_url || "", senderName, imageUrl: x.image_url || "", accent,
    tag: "Nyhetsutskick",
    headline: title,
    subhead,
    body: '<p style="font-size:14px;color:#c0c4d6;line-height:1.65;margin:0 0 14px;">' + body + '</p>',
    details: null,
    ctaLabel: ctaUrl ? finalCtaLabel : null,
    ctaUrl: ctaUrl || null,
    miraNote: null,
    socialBlock,
    footer: x.footer || null
  });
  return { subject, html };
}

// slug: survey_invitation
// extra: { event_title, description, image_url, logo_url, accent_color, company_name,
//          host_name, cta_label, guest_name, invite_link (→ survey-landningssida) }
async function tmplSurveyInvitation(e, extra, toName, ctaLabel, item) {
  const x = extra || {};
  const senderName = x.company_name || "";
  const accent     = x.accent_color || "#df6f39";
  const guest      = x.guest_name || toName || "";
  const title      = x.event_title || "Undersökning";

  const subject = item.subject_override || title;
  const body    = x.description
    ? esc(x.description).replace(/\n\n+/g, "</p><p style=\"font-size:14px;color:#c0c4d6;line-height:1.65;margin:0 0 14px;\">").replace(/\n/g, "<br>")
    : "Vi skulle uppskatta om du kan ta några minuter att besvara vår undersökning.";
  // CTA: per-utskick (x.cta_label) > template-default > hårdkodad fallback
  const finalCtaLabel = (x.cta_label || ctaLabel || "Svara på undersökningen").trim();

  const html = wrapLayout({
    toName: guest || toName, logoUrl: x.logo_url || "", senderName, imageUrl: x.image_url || "", accent,
    tag: "Undersökning",
    headline: title,
    body: '<p style="font-size:14px;color:#c0c4d6;line-height:1.65;margin:0 0 14px;">' + body + '</p>',
    details: null,
    ctaLabel: finalCtaLabel,
    ctaUrl: x.invite_link || null,
    miraNote: "Klicka p\u00e5 knappen f\u00f6r att svara p\u00e5 unders\u00f6kningen.",
    footer: x.footer || null
  });
  return { subject, html };
}

async function tmplInviteRsvpConfirmation(e, extra, toName, ctaLabel, item) {
  const x = extra || {};
  const senderName = x.company_name || "";
  const accent     = x.accent_color || "#df6f39";
  const coming     = String(x.rsvp_status || "").toLowerCase() === "yes";
  const guest      = x.guest_name || toName || "";
  const title      = x.event_title || "Inbjudan";

  let when = "";
  if (x.event_start) {
    when = fmtDateTime(x.event_start);
    if (x.event_end) { const t = String(fmtDateTime(x.event_end)).split(" ").pop(); if (t) when += "\u2013" + t; }
  }

  const subject  = item.subject_override || (coming ? ("Tack \u2013 vi ses p\u00e5 " + title) : ("Tack f\u00f6r ditt svar \u2013 " + title));
  const headline = coming ? "Tack \u2013 vi ser fram emot att ses!" : "Tack f\u00f6r ditt svar";
  const intro    = coming
    ? "Vi har registrerat att du kommer. H\u00e4r \u00e4r detaljerna:"
    : "Vi har registrerat att du tyv\u00e4rr inte har m\u00f6jlighet att komma. Tack f\u00f6r att du svarade.";

  const html = wrapLayout({
    toName: guest || toName, logoUrl: x.logo_url || "", senderName, imageUrl: "", accent,
    tag: coming ? "Anm\u00e4ld" : "Svar mottaget",
    headline,
    body: '<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">' + esc(intro) + '</p>',
    details: detailRows([
      title && ["Event", esc(title)],
      when && ["N\u00e4r", esc(when)],
      x.event_location && ["Plats", esc(x.event_location)],
      x.event_address && ["Adress", esc(x.event_address)],
      (coming && Number(x.plus_ones_count) > 0) && ["Medf\u00f6ljande", String(x.plus_ones_count)],
      (coming && x.allergens_summary) && ["Specialkost", esc(x.allergens_summary)]
    ]),
    ctaLabel: null, ctaUrl: null,
    miraNote: "Beh\u00f6ver du \u00e4ndra ditt svar? Anv\u00e4nd samma l\u00e4nk som i din inbjudan.",
    footer: x.footer || null
  });
  return { subject, html };
}
// ────────────────────────────────────────────────────────────
// OfferApproval-mallar (signeringsflöde — se HANDOFF §0e)
// extra-fält som förväntas:
//   approval_invite:  { rubrik, sender_name, message, view_url, expires_at? }
//   approval_otp:     { rubrik, code, expires_minutes }
//   approval_signed:  { rubrik, document_url, signed_at }
// ────────────────────────────────────────────────────────────
async function tmplApprovalInvite(e, extra, toName, ctaLabel, item) {
  const x = extra || {};
  const senderName = x.sender_name || x.company_name || "Carotte";
  const accent     = x.accent_color || "#df6f39";
  const rubrik     = x.rubrik || "Avtal att signera";
  const viewUrl    = x.view_url || "";
  const message    = x.message || "";

  const subject = item.subject_override || `${rubrik} — väntar på din signering`;
  const html = wrapLayout({
    toName,
    logoUrl: x.logo_url || "",
    senderName,
    imageUrl: "",
    accent,
    tag: "Signering",
    headline: rubrik,
    body:
      `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">`
      + `${esc(senderName)} har skickat ett dokument till dig för digital signering. `
      + `Klicka på knappen nedan för att granska och signera.</p>`
      + (message ? `<p style="font-size:13px;color:#8892aa;line-height:1.65;margin-top:14px;white-space:pre-wrap;">${esc(message)}</p>` : ""),
    details: detailRows([
      ["Avsändare", esc(senderName)],
      x.expires_at && ["Giltigt till", fmtDateTime(x.expires_at)],
    ]),
    ctaLabel: "Granska och signera",
    ctaUrl: viewUrl,
    miraNote: "Du behöver verifiera din e-post med en engångskod innan du signerar.",
  });
  return { subject, html };
}

async function tmplApprovalOtp(e, extra, toName, ctaLabel, item) {
  const x = extra || {};
  const accent  = x.accent_color || "#df6f39";
  const rubrik  = x.rubrik || "Avtal";
  const code    = String(x.code || "").trim();
  const mins    = Number(x.expires_minutes || 10);

  const codeBlock =
    `<div style="margin:22px 0 6px;padding:18px 24px;background:#0d1117;border:1px solid #262b42;`
    + `border-radius:10px;text-align:center;">`
    + `<div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:30px;letter-spacing:.4em;`
    + `font-weight:600;color:#e8eaf0;">${esc(code)}</div>`
    + `<div style="margin-top:8px;font-size:11px;color:#606880;letter-spacing:.08em;text-transform:uppercase;">`
    + `Giltig i ${mins} minuter</div></div>`;

  const subject = item.subject_override || `Din kod för att signera: ${code}`;
  const html = wrapLayout({
    toName,
    logoUrl: x.logo_url || "",
    senderName: x.sender_name || "Carotte",
    imageUrl: "",
    accent,
    tag: "Engångskod",
    headline: "Verifiera din e-post",
    body:
      `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">`
      + `Skriv in koden nedan på signeringssidan för att slutföra signeringen av <strong style="color:#e8eaf0;">${esc(rubrik)}</strong>.</p>`
      + codeBlock,
    details: null,
    ctaLabel: null,
    ctaUrl: null,
    miraNote: "Har du inte begärt denna kod kan du bortse från mailet.",
  });
  return { subject, html };
}

async function tmplApprovalSigned(e, extra, toName, ctaLabel, item) {
  const x = extra || {};
  const senderName = x.sender_name || "Carotte";
  const accent     = x.accent_color || "#047857";
  const rubrik     = x.rubrik || "Avtal";
  const docUrl     = x.document_url || "";
  const signedAt   = x.signed_at ? fmtDateTime(x.signed_at) : "";

  const subject = item.subject_override || `Bekräftelse: ${rubrik} signerat`;
  const html = wrapLayout({
    toName,
    logoUrl: x.logo_url || "",
    senderName,
    imageUrl: "",
    accent,
    tag: "Signerat",
    headline: `${rubrik} är signerat`,
    body:
      `<p style="font-size:14px;color:#c0c4d6;line-height:1.65;">`
      + `Tack — din signering är registrerad. Den slutgiltiga PDF:en innehåller `
      + `originaldokumenten plus ett signeringsbevis med din verifiering.</p>`,
    details: detailRows([
      ["Avtal", esc(rubrik)],
      signedAt && ["Signerat", signedAt],
      ["Signerat av", esc(toName || "")],
    ]),
    ctaLabel: docUrl ? "Ladda ner signerat dokument" : null,
    ctaUrl:   docUrl || null,
    miraNote: docUrl ? null : "Du får en länk till dokumentet inom kort.",
  });
  return { subject, html };
}

// ────────────────────────────────────────────────────────────
// SendGrid REST (ingen SDK – matcher befintligt mönster i index.js)
// ────────────────────────────────────────────────────────────
async function sendViaSendGrid({ to, toName, subject, html, fromName }) {
  if (!SENDGRID_API_KEY) throw new Error("SENDGRID_API_KEY saknas");

  const body = {
    personalizations: [{ to: [{ email: to, name: toName || "" }] }],
    from: { email: FROM_EMAIL, name: (fromName && fromName.trim()) || FROM_NAME },
    subject,
    content: [{ type: "text/html", value: html }]
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SendGrid ${res.status}: ${txt.slice(0, 300)}`);
  }

  return true;
}
