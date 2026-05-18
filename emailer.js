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

      await sendViaSendGrid({
        to:      item.to_email,
        toName:  item.to_name || "",
        subject,
        html
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
    invoice_question:      "invoiceinquiry"
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
// Fält: commission_status, Tråd (kommentarer)
// ────────────────────────────────────────────────────────────
async function tmplCommissionUpdated(e, extra, toName, ctaLabel, item) {
  const cc        = await fetchClientCompany(e.Company || e.company);
  const logoUrl   = cc?.logo_url || cc?.Logo || "";
  const senderName= cc?.Name_company || "";

  const title     = e.commission_title || e.Title || extra.title || "Bokningsuppdatering";
  const status    = e.commission_status || e.status || extra.status || "";
  const comments  = asArray(e.thread || extra.comments);
  const subject   = item.subject_override || `Uppdatering: ${title}`;

  const commentsHtml = comments.length
    ? `<div style="margin:20px 0;">${
        comments.map(c =>
          `<div style="background:#0d1117;border-left:3px solid #262b42;border-radius:0 6px 6px 0;
                       padding:10px 14px;margin-bottom:8px;font-size:13px;color:#c0c4d6;line-height:1.55;">
             ${esc(c)}
           </div>`
        ).join("")
      }</div>`
    : "";

  const html = wrapLayout({ toName, logoUrl, senderName, imageUrl: "", accent: "#db6923",
    tag: "Bokningsuppdatering",
    headline: title,
    body: commentsHtml,
    details: detailRows([
      status && ["Status", statusBadge(status)]
    ]),
    ctaLabel: null,
    ctaUrl: null,
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
// HTML-layout (Carotte brand: #0d1117 / #161c2d / accent)
// ────────────────────────────────────────────────────────────
function wrapLayout({
  toName, logoUrl, senderName, imageUrl,
  accent = "#db6923", tag, headline, body,
  details, ctaLabel, ctaUrl, miraNote = null
}) {
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
      <p style="margin:0 0 6px;font-size:14px;color:#8892aa;">Hej ${esc(toName)},</p>
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

    <!-- Footer -->
    <tr><td style="padding:24px 36px;border-top:1px solid #1e2437;margin-top:24px;">
      <p style="font-size:11px;color:#3a4055;line-height:1.6;margin:0;">
        Mira · Carotte Group AB
      </p>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
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

// ────────────────────────────────────────────────────────────
// SendGrid REST (ingen SDK – matcher befintligt mönster i index.js)
// ────────────────────────────────────────────────────────────
async function sendViaSendGrid({ to, toName, subject, html }) {
  if (!SENDGRID_API_KEY) throw new Error("SENDGRID_API_KEY saknas");

  const body = {
    personalizations: [{ to: [{ email: to, name: toName || "" }] }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
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
