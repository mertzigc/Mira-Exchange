// invoice_sync.js
// ─────────────────────────────────────────────────────────────────────────────
// Generisk sync-kärna (NIR-baserad). DI-injicerad från index.js (samma mönster
// som emailer.js). Se ARKITEKTUR_OCH_OMTAG.md §8 för design.
//
// Flöde:  adapter.iterateRefs → fetchComplete (ALLTID detail) → normalize → NIR
//         → buildPayload (källagnostisk) → upsertToBubble (diff | write)
//
// Diff-läge skriver INGENTING. Det är säkerhetsgarantin: vi kör diff mot live,
// granskar reconcile-totalen (HK jan–apr ska bli 15 928 196), och flippar först
// då till write.
// ─────────────────────────────────────────────────────────────────────────────

export function createSyncEngine(deps) {
  const {
    // Bubble-helpers (befintliga i index.js)
    bubbleFindOne,
    bubbleCreate,
    bubblePatch,
    bubbleFindAll,
    // Tengella-fetchers + helpers (befintliga i index.js)
    tengella,   // { login, listInvoices, getInvoiceById, resolveInvoiceCustomer }
    fortnox,    // { ensureAccessToken, get, resolveLinkedCompany }
    helpers,    // { toIsoDate, tengellaDate, normalizeBool }
    constants,  // { TENGELLA_CONNECTION_ID, TENGELLA_DEFAULT_ORGNO, TENGELLA_DEFAULT_VAT_RATE }
  } = deps;

  const INVOICE_TYPE = "FortnoxInvoice";

  // ───────────────────────────────────────────────────────────────────────────
  // buildPayload: NIR → ft_*-payload. KÄLLAGNOSTISK. Växer aldrig en switch.
  // ───────────────────────────────────────────────────────────────────────────
  function buildPayload(nir) {
    const total   = Number(nir.total ?? 0);                 // SIGNERAT (credits negativa)
    const vatRate = nir.vatRate != null ? Number(nir.vatRate) : 0.25;

    // Härled net/vat bara när källan saknar dem (Tengella). Ingen total>0-guard.
    // Tecknet följer total automatiskt → Bug 3 strukturellt fixad.
    const net = nir.net != null ? Number(nir.net) : Math.round(total / (1 + vatRate));
    const vat = nir.vat != null ? Number(nir.vat) : (total - net);

    const paid    = Number(nir.paid ?? 0);
    const balance = nir.balance != null ? Number(nir.balance) : (total - paid);

    const ts = nir.invoiceDate ? Date.parse(nir.invoiceDate) : NaN;
    const docNo = String(nir.documentNumber ?? "").trim();

    const payload = {
      connection_id:           nir.connection_id,

      ft_document_number:      docNo,
      ft_customer_number:      nir.customerNumber != null ? String(nir.customerNumber) : "",
      ft_customer_name:        nir.customerName || "",

      ft_invoice_date:         nir.invoiceDate || null,          // ISO-string (oförändrad lagring)
      ft_invoice_ts:           Number.isFinite(ts) ? ts : null,  // NYTT: numeriskt → pålitliga constraints + scaling
      ft_due_date:             nir.dueDate || null,

      ft_total:                total,                            // numeriskt + signerat (idag sträng)
      ft_net:                  net,                              // signerat (Bug 3)
      ft_totalvat:             vat,                              // signerat (Bug 3)
      ft_balance:              balance,
      ft_currency:             nir.currency || "SEK",
      ft_ocr:                  nir.ocr || "",

      ft_cancelled:            !!nir.cancelled,
      ft_sent:                 !!docNo,

      ft_url:                  nir.url || "",

      ft_invoice_type:         nir.type || "",                  // NYTT dedikerat (Bug 2)
      ft_tax_reduction_type:   nir.taxReductionType || "",      // NYTT (Bug 2)
      ft_tax_reduction_amount: Number(nir.taxReductionAmount ?? 0), // NYTT

      // Referensfält bärs av NIR: Tengella lämnar dem tomma (Bug 2),
      // Fortnox sätter dem (deal-link via YourReference).
      ft_our_reference:        nir.ourReference || "",
      ft_your_reference:       nir.yourReference || "",
      ft_your_order_number:    nir.yourOrderNumber || "",

      ft_raw_json:             JSON.stringify(nir.raw || {}),
    };

    if (nir.companyId) payload.linked_company = nir.companyId;
    return payload;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Diff: payload vs existing. Jämför bara fält vi skriver (ej raw_json).
  // ───────────────────────────────────────────────────────────────────────────
  const COMPARE_FIELDS = [
    "ft_net", "ft_totalvat", "ft_total", "ft_balance",
    "ft_invoice_type", "ft_tax_reduction_type", "ft_tax_reduction_amount",
    "ft_invoice_ts", "ft_invoice_date", "ft_due_date",
    "ft_our_reference", "ft_your_reference",
    "ft_customer_number", "ft_customer_name", "ft_cancelled", "ft_url", "ft_ocr",
  ];

  function eqLoose(a, b) {
    if (a == null && b == null) return true;
    if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
    if (typeof a === "number" || typeof b === "number") {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    }
    return String(a ?? "") === String(b ?? "");
  }

  function diffPayload(payload, existing) {
    const changed = [];
    for (const f of COMPARE_FIELDS) {
      const a = existing ? existing[f] : undefined;
      if (!eqLoose(a, payload[f])) changed.push({ field: f, old: a ?? null, new: payload[f] ?? null });
    }
    return changed;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // upsertToBubble: idempotent på (connection_id, ft_document_number).
  // mode="diff" → läser bara, returnerar tänkt action + ändrade fält.
  // mode="write" → skapar/patchar.
  // ───────────────────────────────────────────────────────────────────────────
  async function upsertToBubble(payload, { mode }) {
    const existing = await bubbleFindOne(INVOICE_TYPE, [
      { key: "connection_id",      constraint_type: "equals", value: payload.connection_id },
      { key: "ft_document_number", constraint_type: "equals", value: payload.ft_document_number },
    ]);
    const existingId = existing?._id || existing?.id || null;
    const changed    = diffPayload(payload, existing);
    const action     = !existingId ? "create" : (changed.length ? "update" : "noop");

    const base = { action, id: existingId, doc: payload.ft_document_number, net: payload.ft_net, changed };

    if (mode === "diff" || action === "noop") return base;

    if (existingId) {
      await bubblePatch(INVOICE_TYPE, existingId, payload);
      return { ...base, action: "update" };
    }
    const newId = await bubbleCreate(INVOICE_TYPE, payload);
    return { ...base, action: "create", id: newId };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read-only kundupplösning för DIFF-läge (inga sidoeffekter).
  // Write-läge använder tengella.resolveInvoiceCustomer (skapar ClientCompany m.m.).
  // ───────────────────────────────────────────────────────────────────────────
  async function readOnlyTengellaCustomer(customerId) {
    if (!customerId) return { customerName: "", customerNumber: "", companyId: null };
    const tc = await bubbleFindOne("TengellaCustomer", [
      { key: "tengella_customer_id", constraint_type: "equals", value: Number(customerId) },
    ]).catch(() => null);
    if (!tc) return { customerName: "", customerNumber: "", companyId: null };
    const customerName = String(tc?.name || tc?.customer_name || "").trim();
    const kundNr       = String(tc?.tengella_customer_no ?? "").trim();
    return {
      customerName,
      customerNumber: kundNr || Number(customerId),
      companyId:      tc?.company || null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Adapter: Tengella faktura
  // ───────────────────────────────────────────────────────────────────────────
  const tengellaInvoiceAdapter = {
    source: "tengella-invoice",

    async resolveAuth(opts) {
      const orgNo = (opts.orgNo || constants.TENGELLA_DEFAULT_ORGNO || "").trim();
      if (!orgNo) throw new Error("orgNo krävs (eller sätt TENGELLA_DEFAULT_ORGNO)");
      const token = await tengella.login(orgNo);
      return { connection_id: constants.TENGELLA_CONNECTION_ID, token, orgNo };
    },

    // Discovery: kunder (Bubble) → fakturor per kund (cursor-paginering).
    // listRow.InvoiceDate används för datum-förfilter så vi slipper detail-anrop
    // för fakturor utanför fönstret.
    async *iterateRefs(auth, opts) {
      const maxPages = Number(opts.maxPages ?? 50) || 50;
      const limit    = Number(opts.limit ?? 100) || 100;

      let customerIds;
      if (opts.customerId) {
        customerIds = [Number(opts.customerId)];
      } else {
        const customers = await bubbleFindAll("TengellaCustomer", { constraints: [] });
        customerIds = customers.map(c => Number(c?.tengella_customer_id ?? 0)).filter(n => n > 0);
      }

      for (const customerId of customerIds) {
        let cursor = null, page = 0, more = true;
        while (more && page < maxPages) {
          page++;
          const resp = await tengella.listInvoices({ token: auth.token, limit, cursor, customerId });
          const data = Array.isArray(resp?.Data) ? resp.Data : (Array.isArray(resp) ? resp : []);
          for (const inv of data) {
            if (inv?.InvoiceId == null) continue;
            yield {
              invoiceId:  inv.InvoiceId,
              customerId,
              ym:         String(inv?.InvoiceDate ?? "").slice(0, 7), // "YYYY-MM" för förfilter
              listRow:    inv,
            };
          }
          cursor = resp?.Next || null;
          more   = helpers.normalizeBool(resp?.ExistsMoreData) && !!cursor;
        }
      }
    },

    async fetchComplete(auth, ref) {
      const detail = await tengella.getInvoiceById({
        token: auth.token, invoiceId: ref.invoiceId, customerId: ref.customerId,
      });
      return { detail, ref };
    },

    async normalize(raw, auth, { mode, fast } = {}) {
      const inv = raw.detail || {};
      const ref = raw.ref || {};

      // fast-läge: hoppa över kundupplösning helt (behövs ej för reconcile/net).
      // write-läge: full upplösning med sidoeffekter. diff-läge: read-only.
      const cust = fast
        ? { customerName: "", customerNumber: "", companyId: null }
        : (mode === "write"
            ? await tengella.resolveInvoiceCustomer(ref.customerId, auth.token)
            : await readOnlyTengellaCustomer(ref.customerId));

      const total = Number(inv?.TotalAmount ?? 0);   // SIGNERAT
      const paid  = Number(inv?.PaidAmount ?? 0);

      return {
        connection_id:      constants.TENGELLA_CONNECTION_ID,
        documentNumber:     String(inv?.InvoiceNo ?? "").trim() || String(inv?.InvoiceId ?? "").trim(),
        invoiceDate:        helpers.toIsoDate(helpers.tengellaDate(inv?.InvoiceDate)),
        dueDate:            helpers.toIsoDate(helpers.tengellaDate(inv?.DueDate)),
        total,
        net:                null,   // Tengella saknar uppdelning → härled i buildPayload
        vat:                null,
        vatRate:            constants.TENGELLA_DEFAULT_VAT_RATE,
        paid,
        balance:            total - paid,
        currency:           "SEK",
        ocr:                String(inv?.Ocr ?? inv?.OCR ?? inv?.OcrNumber ?? "").trim(),
        customerName:       cust.customerName,
        customerNumber:     cust.customerNumber,
        companyId:          cust.companyId,
        cancelled:          inv?.Void === true,
        type:               String(inv?.InvoiceType ?? "").trim(),
        taxReductionType:   inv?.TaxReductionType != null ? String(inv.TaxReductionType).trim() : "",
        taxReductionAmount: Number(inv?.TaxReductionAmount ?? 0),
        url:                String(inv?.Url ?? inv?.PdfUrl ?? inv?.Uri ?? "").trim(),
        raw:                inv,
      };
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Adapter: Fortnox faktura (F&E, Staff, ...)
  // Fortnox detail har Net/TotalVAT KORREKT signerade (credits negativa) → ingen
  // härledning eller teckenflip. Referensfält behålls (Tengella tömmer dem).
  // OBS: fast-läge passar INTE Fortnox (listing saknar Net) → kör alltid detail.
  // ───────────────────────────────────────────────────────────────────────────
  const fortnoxInvoiceAdapter = {
    source: "fortnox-invoice",

    async resolveAuth(opts) {
      const connId = opts.connection_id;
      if (!connId) throw new Error("connection_id krävs för fortnox-invoice");
      const tok = await fortnox.ensureAccessToken(connId);
      if (!tok?.ok || !tok?.access_token) {
        throw new Error("Fortnox token-fel: " + (tok?.error || "okänt"));
      }
      return { connection_id: connId, accessToken: tok.access_token };
    },

    // Discovery: paginerar /invoices (page + MetaInformation.@TotalPages).
    // Datumfönster skickas serverside via fromdate/todate (InvoiceDate).
    async *iterateRefs(auth, opts) {
      const limit    = Number(opts.limit ?? 100) || 100;
      const fromdate = opts.fromdate || (opts.sinceYM ? opts.sinceYM + "-01" : null);
      const todate   = opts.todate || null;
      let page = 1, totalPages = 1;
      do {
        const r = await fortnox.get("/invoices", auth.accessToken, { page, limit, fromdate, todate });
        if (!r?.ok) throw new Error(`fortnox /invoices listing fel sida ${page} (status ${r?.status})`);
        const list = Array.isArray(r.data?.Invoices) ? r.data.Invoices : [];
        totalPages = Number(r.data?.MetaInformation?.["@TotalPages"] ?? 1) || 1;
        for (const inv of list) {
          const docNo = String(inv?.DocumentNumber ?? "").trim();
          if (!docNo) continue;
          yield { docNo, ym: String(inv?.InvoiceDate ?? "").slice(0, 7), listRow: inv };
        }
        page++;
      } while (page <= totalPages);
    },

    async fetchComplete(auth, ref) {
      const r = await fortnox.get(`/invoices/${encodeURIComponent(ref.docNo)}`, auth.accessToken);
      if (!r?.ok) throw new Error(`fortnox detail fel docNo=${ref.docNo} status=${r?.status}`);
      const detail = r.data?.Invoice || r.data?.invoice || null;
      if (!detail) throw new Error(`fortnox detail saknar Invoice docNo=${ref.docNo}`);
      return { detail, ref };
    },

    async normalize(raw, auth, { fast } = {}) {
      const inv = raw.detail || {};
      const total = Number(inv?.Total ?? 0);
      const yourOrderNumber = String(inv?.YourOrderNumber || "").trim();
      const yourReference   = String(inv?.YourReference || "").trim();
      const ourReference    = String(inv?.OurReference || "").trim();

      // linked_company via FortnoxCustomer-bryggan (READ-ONLY). Hoppa i fast för fart.
      const companyId = fast ? null
        : await fortnox.resolveLinkedCompany(auth.connection_id, inv?.CustomerNumber).catch(() => null);

      return {
        connection_id:      auth.connection_id,
        documentNumber:     String(inv?.DocumentNumber ?? "").trim(),
        invoiceDate:        helpers.toIsoDate(inv?.InvoiceDate),
        dueDate:            helpers.toIsoDate(inv?.DueDate),
        total,
        net:                inv?.Net != null ? Number(inv.Net) : null,        // korrekt signerat av Fortnox
        vat:                inv?.TotalVAT != null ? Number(inv.TotalVAT) : null,
        vatRate:            0.25,   // endast fallback om Net saknas (ovanligt i detail)
        paid:               null,
        balance:            inv?.Balance != null ? Number(inv.Balance) : null,
        currency:           String(inv?.Currency || "SEK"),
        ocr:                String(inv?.OCR || "").trim(),
        customerName:       String(inv?.CustomerName || ""),
        customerNumber:     String(inv?.CustomerNumber || ""),
        companyId,
        cancelled:          inv?.Cancelled === true,
        type:               "",
        taxReductionType:   "",
        taxReductionAmount: 0,
        url:                String(inv?.["@url"] || ""),
        ourReference,
        yourOrderNumber,
        yourReference:      yourReference || yourOrderNumber,   // deal-link (som gamla synken)
        raw:                inv,
      };
    },
  };

  const registry = {
    "tengella-invoice": tengellaInvoiceAdapter,
    "fortnox-invoice":  fortnoxInvoiceAdapter,
  };

  // ───────────────────────────────────────────────────────────────────────────
  // syncForSource: driver. Säker default = diff.
  // opts: { mode, orgNo, customerId, limit, maxPages, maxRecords, sinceYM, untilYM, sampleDiffs }
  // ───────────────────────────────────────────────────────────────────────────
  async function syncForSource(source, opts = {}) {
    const adapter = registry[source];
    if (!adapter) throw new Error(`Unknown sync source: ${source}`);

    const mode      = opts.mode === "write" ? "write" : "diff"; // SÄKER default
    const fast      = !!opts.fast;           // hoppa över detail-anrop + kundupplösning (reconcile-validering)
    const sinceYM   = opts.sinceYM || null;  // "YYYY-MM" inkl
    const untilYM   = opts.untilYM || null;  // "YYYY-MM" inkl
    const maxRecords = opts.maxRecords ? Number(opts.maxRecords) : Infinity;
    const maxSample  = Number(opts.sampleDiffs ?? 50) || 50;

    // fast-läge skriver ALDRIG: det normaliserar från listing (saknar DueDate/
    // TaxReduction/Url) → en write skulle skriva över bra fält med tomma.
    if (fast && mode === "write") {
      throw new Error("fast+write förbjudet: skulle skriva ofullständig data (kör utan fast för write)");
    }

    const auth = await adapter.resolveAuth(opts);

    const report = {
      source, mode,
      started_at: new Date().toISOString(),
      counts: { seen: 0, processed: 0, create: 0, update: 0, noop: 0, error: 0, skipped_window: 0, duplicate: 0 },
      reconcile: {},        // connection_id → { total, total_active, by_month, by_type }
      creates: [],          // alla create-fakturor (saknas i Bubble idag)
      sample_diffs: [],
      errors: [],
    };

    // Reconcile dedupar på (connection_id, dokumentnummer): Tengella-listing är
    // per kund, samma faktura kan dyka upp under flera customerId → annars dubbelräkning.
    const seenDocs = new Set();

    // Facit-likvärdig: makulerade (Void) exkluderas från active-summan (samma
    // bas som computeSalesKpi / bokföring), men redovisas separat.
    const addReconcile = (conn, ym, net, type, cancelled) => {
      const r = report.reconcile[conn] || (report.reconcile[conn] = {
        total: 0, total_active: 0, cancelled_net: 0, cancelled_count: 0, by_month: {}, by_type: {},
      });
      r.total += net;
      if (cancelled) { r.cancelled_net += net; r.cancelled_count++; return; }
      r.total_active += net;
      const mk = ym || "unknown";
      r.by_month[mk] = (r.by_month[mk] || 0) + net;
      const tk = type || "unknown";
      const t = r.by_type[tk] || (r.by_type[tk] = { net: 0, count: 0 });
      t.net += net;
      t.count++;
    };

    for await (const ref of adapter.iterateRefs(auth, opts)) {
      report.counts.seen++;
      if (report.counts.processed >= maxRecords) break;

      // Datum-förfilter via listRow → undvik onödiga detail-anrop
      const ym = ref.ym || "";
      if ((sinceYM && ym && ym < sinceYM) || (untilYM && ym && ym > untilYM)) {
        report.counts.skipped_window++;
        continue;
      }

      try {
        const raw     = fast ? { detail: ref.listRow, ref } : await adapter.fetchComplete(auth, ref);
        const nir     = await adapter.normalize(raw, auth, { mode, fast });
        const payload = buildPayload(nir);
        const r       = await upsertToBubble(payload, { mode });

        report.counts.processed++;
        report.counts[r.action]++;

        const tsYM = payload.ft_invoice_ts
          ? new Date(payload.ft_invoice_ts).toISOString().slice(0, 7)
          : (ym || "unknown");

        const dkey = payload.connection_id + "|" + payload.ft_document_number;
        if (seenDocs.has(dkey)) {
          report.counts.duplicate++;
        } else {
          seenDocs.add(dkey);
          addReconcile(payload.connection_id, tsYM, Number(payload.ft_net || 0), payload.ft_invoice_type, payload.ft_cancelled);
          if (r.action === "create" && report.creates.length < 500) {
            report.creates.push({
              doc: payload.ft_document_number, net: Number(payload.ft_net || 0),
              type: payload.ft_invoice_type, ym: tsYM,
            });
          }
        }

        if (r.action !== "noop" && report.sample_diffs.length < maxSample) {
          report.sample_diffs.push({
            doc: r.doc, action: r.action, net: r.net, changed: r.changed.slice(0, 12),
          });
        }
      } catch (e) {
        report.counts.error++;
        if (report.errors.length < 50) {
          report.errors.push({
            invoiceId: ref.invoiceId, customerId: ref.customerId,
            message: e?.message || String(e),
          });
        }
      }
    }

    report.finished_at = new Date().toISOString();
    return report;
  }

  return { syncForSource, buildPayload, registry };
}
