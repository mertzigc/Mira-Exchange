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
    bubbleDelete,   // 9a: krävs för rad-delete-reconciliation (städa spökrader)
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

      // ft_total/ft_balance är TEXT-fält i Bubble (gamla synken skrev String(...)).
      // Behåll text för att slippa fälttyp-migrering. Tecknet finns ändå i strängen.
      // ft_net/ft_totalvat är number-fält (KPI/reconcile summerar dessa).
      ft_total:                String(total),
      ft_net:                  net,                              // signerat (Bug 3)
      ft_totalvat:             vat,                              // signerat (Bug 3)
      ft_balance:              String(balance),
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
    "ft_customer_number", "ft_customer_name", "ft_cancelled", "ft_ocr",
  ];
  // OBS: ft_url EXKLUDERAS medvetet från diff. Tengellas PDF-länk är en temporär
  // signerad URL som regenereras varje hämtning → annars flaggas varje faktura som
  // ändrad vid varje sync (brus + onödiga writes). Permanent PDF lagras i ft_pdf.

  function eqLoose(a, b) {
    if (a == null && b == null) return true;
    if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
    const sa = String(a ?? ""), sb = String(b ?? "");
    // Numerisk jämförelse om båda ser ut som tal (t.ex. "29688.00" == "29688",
    // eller text-fält mot number-fält). Annars exakt sträng.
    if (sa !== "" && sb !== "") {
      const na = Number(sa), nb = Number(sb);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    }
    return sa === sb;
  }

  function diffPayload(payload, existing, fields = COMPARE_FIELDS) {
    const changed = [];
    for (const f of fields) {
      const a = existing ? existing[f] : undefined;
      if (!eqLoose(a, payload[f])) changed.push({ field: f, old: a ?? null, new: payload[f] ?? null });
    }
    return changed;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // upsertToBubble: idempotent på adapterns keyFields (faktura:
  // [connection_id, ft_document_number]; order/offer: [connection, ...]).
  // mode="diff" → läser bara, returnerar tänkt action + ändrade fält.
  // mode="write" → skapar/patchar.
  // 9a: tar adapter (bubbleType + keyFields + valfri compareFields) i stället för
  //     hårdkodad FortnoxInvoice/connection_id. Faktura beter sig identiskt.
  // ───────────────────────────────────────────────────────────────────────────
  async function upsertToBubble(adapter, payload, { mode }) {
    const bubbleType   = adapter.bubbleType;
    const keyFields    = adapter.keyFields || ["connection_id", "ft_document_number"];
    const compareFields = adapter.compareFields || COMPARE_FIELDS;

    const constraints = keyFields.map((f) => ({
      key: f, constraint_type: "equals", value: payload[f],
    }));
    const existing   = await bubbleFindOne(bubbleType, constraints);
    const existingId = existing?._id || existing?.id || null;
    const changed    = diffPayload(payload, existing, compareFields);
    const action     = !existingId ? "create" : (changed.length ? "update" : "noop");

    const base = { action, id: existingId, doc: payload.ft_document_number, net: payload.ft_net, changed };

    if (mode === "diff" || action === "noop") return base;

    if (existingId) {
      await bubblePatch(bubbleType, existingId, payload);
      return { ...base, action: "update" };
    }
    const newId = await bubbleCreate(bubbleType, payload);
    return { ...base, action: "create", id: newId };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // upsertDocWithRows: dokument + rader (order/offer/workorder). 9a-kärnan.
  //   1. Upserta huvudet (upsertToBubble) → parent-id.
  //   2. Hämta ALLA befintliga rader för parent (via parent-relationen).
  //   3. Upserta varje inkommande rad (nyckel = adapter.rows.keyField).
  //   4. RADERA rader vars nyckel saknas i inkommande set (set-reconciliation)
  //      → fixar den största kvalitetsluckan: gamla synken städar aldrig spökrader.
  // diff-läge skriver INGET; rapporterar tänkta row-create/update/delete.
  //
  // adapter.rows-config:
  //   { bubbleType, parentField, keyField, compareFields, buildRowPayload(rowNir, parentId, headNir) }
  // ───────────────────────────────────────────────────────────────────────────
  async function upsertDocWithRows(adapter, payload, rowNirs, { mode }) {
    const head = await upsertToBubble(adapter, payload, { mode });
    const cfg  = adapter.rows;
    if (!cfg || !Array.isArray(rowNirs)) return head;

    const parentId = head.id || null;   // null i diff-läge för ett nytt huvud
    const rowCompare = cfg.compareFields || cfg.compare || [];

    // Bygg inkommande rad-payloads. keyField måste finnas på varje payload.
    const incoming = rowNirs.map((rn) => cfg.buildRowPayload(rn, parentId, payload));
    const incomingByKey = new Map();
    for (const rp of incoming) {
      const k = String(rp[cfg.keyField] ?? "").trim();
      if (k) incomingByKey.set(k, rp);
    }

    // Befintliga rader: bara hämtbara när parent finns (annars allt = create).
    let existingRows = [];
    if (parentId) {
      existingRows = await bubbleFindAll(cfg.bubbleType, {
        constraints: [{ key: cfg.parentField, constraint_type: "equals", value: parentId }],
      }).catch(() => []);
    }
    const existingByKey = new Map();
    for (const er of existingRows) {
      const k = String(er?.[cfg.keyField] ?? "").trim();
      if (k) existingByKey.set(k, er);
    }

    const rowReport = { create: 0, update: 0, noop: 0, delete: 0, error: 0, samples: [] };
    const pushSample = (action, key, changed) => {
      if (rowReport.samples.length < 12) rowReport.samples.push({ action, key, changed: (changed || []).slice(0, 8) });
    };

    // Upserta inkommande rader.
    for (const [key, rp] of incomingByKey) {
      try {
        const existing = existingByKey.get(key) || null;
        const existingId = existing?._id || existing?.id || null;
        const changed = diffPayload(rp, existing, rowCompare);
        const action = !existingId ? "create" : (changed.length ? "update" : "noop");
        rowReport[action]++;
        if (action !== "noop") pushSample(action, key, changed);

        if (mode === "write" && action !== "noop") {
          if (existingId) {
            await bubblePatch(cfg.bubbleType, existingId, rp);
          } else {
            await bubbleCreate(cfg.bubbleType, rp);
          }
        }
      } catch (e) {
        rowReport.error++;
        pushSample("error", key, [{ field: "_error", new: e?.message || String(e) }]);
      }
    }

    // RADERA rader som inte längre finns i källan (set-reconciliation).
    for (const [key, er] of existingByKey) {
      if (incomingByKey.has(key)) continue;
      const erId = er?._id || er?.id || null;
      rowReport.delete++;
      pushSample("delete", key, []);
      if (mode === "write" && erId) {
        try { await bubbleDelete(cfg.bubbleType, erId); }
        catch (e) { rowReport.error++; pushSample("error", key, [{ field: "_delete", new: e?.message || String(e) }]); }
      }
    }

    return { ...head, rows: rowReport };
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
    bubbleType: INVOICE_TYPE,                              // "FortnoxInvoice"
    keyFields: ["connection_id", "ft_document_number"],    // idempotensnyckel
    // rows: undefined → enkel-dokument-väg (beter sig exakt som före 9a)

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

  // Robusta Fortnox-anrop: retry med exponentiell backoff på 429/5xx (transienta).
  // Permanenta 4xx ger upp direkt. Skyddar mot rate-limit mitt i paginering.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fortnoxGetRetry(path, token, query, tries = 4) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const r = await fortnox.get(path, token, query);
      if (r?.ok) return r;
      last = r;
      const st = r?.status || 0;
      if (st && st !== 429 && st < 500) break;       // permanent fel → ge upp
      await sleep(600 * Math.pow(2, i));             // 600ms, 1.2s, 2.4s, 4.8s
    }
    return last;
  }

  // Token-medveten Fortnox-GET: vid 401 (token utgången mitt i körning) force-refresha
  // och kör om EN gång. auth.accessToken muteras så efterföljande anrop återanvänder
  // den nya token. Skyddar långa svep (helår = många listsidor + detail-anrop).
  async function fortnoxGetAuthed(auth, path, query) {
    let r = await fortnoxGetRetry(path, auth.accessToken, query);
    if (r?.status === 401) {
      const tok = await fortnox.ensureAccessToken(auth.connection_id, true);   // force
      if (tok?.ok && tok?.access_token) {
        auth.accessToken = tok.access_token;
        r = await fortnoxGetRetry(path, auth.accessToken, query);
      }
    }
    return r;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Adapter: Fortnox faktura (F&E, Staff, ...)
  // Fortnox detail har Net/TotalVAT KORREKT signerade (credits negativa) → ingen
  // härledning eller teckenflip. Referensfält behålls (Tengella tömmer dem).
  // OBS: fast-läge passar INTE Fortnox (listing saknar Net) → kör alltid detail.
  // ───────────────────────────────────────────────────────────────────────────
  const fortnoxInvoiceAdapter = {
    source: "fortnox-invoice",
    bubbleType: INVOICE_TYPE,                              // "FortnoxInvoice"
    keyFields: ["connection_id", "ft_document_number"],    // idempotensnyckel
    // rows: undefined → enkel-dokument-väg (beter sig exakt som före 9a)

    async resolveAuth(opts) {
      const connId = opts.connection_id;
      if (!connId) throw new Error("connection_id krävs för fortnox-invoice");
      const tok = await fortnox.ensureAccessToken(connId);
      if (!tok?.ok || !tok?.access_token) {
        throw new Error("Fortnox token-fel: " + (tok?.error || "okänt"));
      }
      // Throttle mot Fortnox rate-limit (ms mellan detail-anrop). 0 = av.
      const throttleMs = opts.throttleMs != null ? Number(opts.throttleMs) : 200;
      return { connection_id: connId, accessToken: tok.access_token, throttleMs };
    },

    // Discovery: paginerar /invoices (page + MetaInformation.@TotalPages).
    // Datumfönster skickas serverside via fromdate/todate (InvoiceDate).
    async *iterateRefs(auth, opts) {
      const limit    = Number(opts.limit ?? 100) || 100;
      const fromdate = opts.fromdate || (opts.sinceYM ? opts.sinceYM + "-01" : null);
      const todate   = opts.todate || null;
      // modifiedDaysBack → lastmodified-sweep: fångar nya OCH saldo/betalnings-
      // ändringar på äldre fakturor. Format "YYYY-MM-DD HH:MM" UTC (Fortnox-krav).
      let lastmodified = null;
      if (opts.modifiedDaysBack != null) {
        const s = new Date(Date.now() - Number(opts.modifiedDaysBack) * 864e5);
        const p = (n) => String(n).padStart(2, "0");
        lastmodified = `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} ${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
      }
      const window = lastmodified ? { lastmodified } : { fromdate, todate };
      let page = 1, totalPages = 1;
      do {
        const r = await fortnoxGetAuthed(auth, "/invoices", { page, limit, ...window });
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
      if (auth.throttleMs) await sleep(auth.throttleMs);   // håll under Fortnox rate-limit
      const r = await fortnoxGetAuthed(auth, `/invoices/${encodeURIComponent(ref.docNo)}`);
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

  // ───────────────────────────────────────────────────────────────────────────
  // 9b — Fortnox order/offer-adaptrar (dokument MED rader).
  //
  // Speglar fortnox-invoice (detail-fetch ger huvud + Net/VAT + rader → Bug 1 löst
  // för order/offer också). Skillnad mot faktura: huvudet har rader (rows[]) →
  // upsertDocWithRows + delete-reconciliation städar spökrader.
  //
  // VIKTIGT om coexistence: gamla cron (fortnox_cron_v1.sh m.fl.) skriver fortfarande
  // FortnoxOrder/Offer + rader. Därför speglar vi EXAKT befintliga fältnamn, beloppstyper
  // (order-rad=STRÄNG, offer-rad=NUMBER) och ft_unique_key-format — annars uppstår
  // create/delete-krig under övergången. Nyckel-STANDARDISERING är medvetet uppskjuten
  // till 9e (cron-cutover), då gamla synken stängs av. Connection-fältet heter `connection`
  // (inte connection_id som faktura).
  // ───────────────────────────────────────────────────────────────────────────
  function makeFortnoxDocAdapter(cfg) {
    return {
      source:     cfg.source,
      bubbleType: cfg.bubbleType,
      keyFields:  ["connection", "ft_document_number"],
      compareFields: cfg.headCompareFields,
      buildPayload:  cfg.buildPayload,
      rows: {
        bubbleType:    cfg.rowBubbleType,
        parentField:   cfg.rowParentField,        // "order" | "offer"
        keyField:      "ft_unique_key",
        compareFields: cfg.rowCompareFields,
        buildRowPayload: cfg.buildRowPayload,
      },

      async resolveAuth(opts) {
        const connId = opts.connection_id;
        if (!connId) throw new Error(`connection_id krävs för ${cfg.source}`);
        const tok = await fortnox.ensureAccessToken(connId);
        if (!tok?.ok || !tok?.access_token) {
          throw new Error("Fortnox token-fel: " + (tok?.error || "okänt"));
        }
        const throttleMs = opts.throttleMs != null ? Number(opts.throttleMs) : 200;
        return { connection_id: connId, accessToken: tok.access_token, throttleMs };
      },

      // Discovery: paginera /orders resp /offers (page + @TotalPages), eller
      // lastmodified-sweep för nightly. Datumfönster via fromdate/todate.
      async *iterateRefs(auth, opts) {
        const limit    = Number(opts.limit ?? 100) || 100;
        const fromdate = opts.fromdate || (opts.sinceYM ? opts.sinceYM + "-01" : null);
        const todate   = opts.todate || null;
        let lastmodified = null;
        if (opts.modifiedDaysBack != null) {
          const s = new Date(Date.now() - Number(opts.modifiedDaysBack) * 864e5);
          const p = (n) => String(n).padStart(2, "0");
          lastmodified = `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} ${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
        }
        const window = lastmodified ? { lastmodified } : { fromdate, todate };
        let page = 1, totalPages = 1;
        do {
          const r = await fortnoxGetAuthed(auth, cfg.listPath, { page, limit, ...window });
          if (!r?.ok) throw new Error(`fortnox ${cfg.listPath} listing fel sida ${page} (status ${r?.status})`);
          const list = Array.isArray(r.data?.[cfg.listArrayKey]) ? r.data[cfg.listArrayKey] : [];
          totalPages = Number(r.data?.MetaInformation?.["@TotalPages"] ?? 1) || 1;
          for (const row of list) {
            const docNo = String(row?.DocumentNumber ?? "").trim();
            if (!docNo) continue;
            yield { docNo, ym: String(row?.[cfg.dateField] ?? "").slice(0, 7), listRow: row };
          }
          page++;
        } while (page <= totalPages);
      },

      async fetchComplete(auth, ref) {
        if (auth.throttleMs) await sleep(auth.throttleMs);
        const r = await fortnoxGetAuthed(auth, `${cfg.listPath}/${encodeURIComponent(ref.docNo)}`);
        if (!r?.ok) throw new Error(`fortnox ${cfg.source} detail fel docNo=${ref.docNo} status=${r?.status}`);
        const detail = r.data?.[cfg.detailKey] || r.data?.[cfg.detailKey.toLowerCase()] || null;
        if (!detail) throw new Error(`fortnox ${cfg.source} detail saknar ${cfg.detailKey} docNo=${ref.docNo}`);
        return { detail, ref };
      },

      async normalize(raw, auth, { fast } = {}) {
        const doc  = raw.detail || {};
        const rows = Array.isArray(doc?.[cfg.rowsKey]) ? doc[cfg.rowsKey] : [];

        // linked_company via FortnoxCustomer-bryggan (READ-ONLY), som faktura. Hoppa i fast.
        const companyId = fast ? null
          : await fortnox.resolveLinkedCompany(auth.connection_id, doc?.CustomerNumber).catch(() => null);

        return {
          connection:      auth.connection_id,
          documentNumber:  String(doc?.DocumentNumber ?? "").trim(),
          companyId,
          raw:             doc,
          // rad-NIR: bär råraden + index; buildRowPayload formaterar per typ.
          rows: rows.map((row, i) => ({ row, index: i, connection: auth.connection_id, docNo: String(doc?.DocumentNumber ?? "").trim() })),
        };
      },
    };
  }

  // Order-radens stabila nyckel: RowId när det finns, annars positions-fallback (flaggas).
  function orderRowKey(row, connection, docNo, index) {
    const rowId = row?.RowId ?? row?.RowID ?? null;
    return rowId != null
      ? `ROWID_${rowId}__CONN_${connection}__ORDDOC_${docNo}`
      : `FALLBACK__CONN_${connection}__ORDDOC_${docNo}__IDX_${String(index + 1).padStart(3, "0")}`;
  }

  const fortnoxOrderAdapter = makeFortnoxDocAdapter({
    source: "fortnox-order",
    bubbleType: "FortnoxOrder",
    rowBubbleType: "FortnoxOrderRow",
    rowParentField: "order",
    listPath: "/orders",
    listArrayKey: "Orders",
    detailKey: "Order",
    rowsKey: "OrderRows",
    dateField: "OrderDate",
    headCompareFields: [
      "ft_net", "ft_totalvat", "ft_total", "ft_order_ts",
      "ft_order_date", "ft_delivery_date", "ft_your_reference",
      "ft_customer_number", "ft_customer_name", "ft_cancelled", "ft_sent", "ft_currency",
    ],
    rowCompareFields: ["ft_article_number", "ft_description", "ft_quantity", "ft_unit", "ft_price", "ft_discount", "ft_vat", "ft_total"],
    // FortnoxOrder-huvud — speglar upsertFortnoxOrderDirect; ft_total/radbelopp = STRÄNG.
    buildPayload(nir) {
      const o = nir.raw || {};
      const ts = o?.OrderDate ? Date.parse(o.OrderDate) : NaN;
      const yourRef = String(o?.YourReferenceNumber || o?.YourReference || o?.YourOrderNumber || "").trim();
      const payload = {
        connection:          nir.connection,
        ft_document_number:  String(o?.DocumentNumber ?? "").trim(),
        ft_customer_number:  String(o?.CustomerNumber ?? ""),
        ft_customer_name:    String(o?.CustomerName ?? ""),
        ft_your_reference:   yourRef,
        ft_order_date:       o?.OrderDate ? helpers.toIsoDate(o.OrderDate) : null,
        ft_delivery_date:    o?.DeliveryDate ? helpers.toIsoDate(o.DeliveryDate) : null,
        ft_order_ts:         Number.isFinite(ts) ? ts : null,      // NYTT number-fält
        ft_total:            o?.Total == null ? "" : String(o.Total),     // STRÄNG (befintlig fälttyp)
        ft_net:              o?.Net != null ? Number(o.Net) : null,       // number, korrekt signerat av Fortnox
        ft_totalvat:         o?.TotalVAT != null ? Number(o.TotalVAT) : null,
        ft_currency:         String(o?.Currency ?? ""),
        ft_cancelled:        !!o?.Cancelled,
        ft_sent:             !!o?.Sent,
        ft_url:              String(o?.["@url"] ?? ""),
        ft_raw_json:         JSON.stringify(o || {}),
        source:              "fortnox",   // §9.8: spårbarhet i unified ordermodell
        // 9c: flagga PDF-hämtning. Skrivs bara vid create/update (noop rör inget);
        // ej i compareFields → triggar ingen egen diff. PDF-cron nollar den.
        needs_pdf_sync:      true,
      };
      if (nir.companyId) payload.linked_company = nir.companyId;
      return payload;
    },
    // FortnoxOrderRow — speglar befintlig payload; belopp som STRÄNG.
    buildRowPayload(rn, parentId, head) {
      const row = rn.row || {};
      return {
        connection:               rn.connection,
        order:                    parentId,                       // parent-relation
        ft_order_document_number: rn.docNo,
        ft_row_index:             rn.index + 1,
        ft_row_no:                row?.RowNumber ?? row?.RowNo ?? row?.Row ?? (rn.index + 1),
        ft_article_number:        String(row?.ArticleNumber ?? ""),
        ft_description:           String(row?.Description ?? ""),
        ft_your_reference:        head?.ft_your_reference ?? "",
        ft_quantity:              row?.DeliveredQuantity ?? row?.Quantity ?? null,
        ft_unit:                  String(row?.Unit ?? ""),
        ft_price:                 row?.Price    == null ? "" : String(row.Price),
        ft_discount:              row?.Discount == null ? null : Number(row.Discount),   // NUMBER-fält i Bubble (ej "")
        ft_vat:                   row?.VAT      == null ? null : Number(row.VAT),         // NUMBER-fält i Bubble (ej "")
        ft_total:                 row?.Total    == null ? "" : String(row.Total),
        ft_unique_key:            orderRowKey(row, rn.connection, rn.docNo, rn.index),
        ft_raw_json:              JSON.stringify(row || {}),
      };
    },
  });

  const fortnoxOfferAdapter = makeFortnoxDocAdapter({
    source: "fortnox-offer",
    bubbleType: "FortnoxOffer",
    rowBubbleType: "FortnoxOfferRow",
    rowParentField: "offer",
    listPath: "/offers",
    listArrayKey: "Offers",
    detailKey: "Offer",
    rowsKey: "OfferRows",
    dateField: "OfferDate",
    headCompareFields: [
      "ft_net", "ft_totalvat", "ft_total", "ft_offer_ts",
      "ft_offer_date", "ft_delivery_date", "ft_valid_until", "ft_your_reference",
      "ft_customer_number", "ft_customer_name", "ft_cancelled", "ft_sent", "ft_currency",
    ],
    rowCompareFields: ["ft_article_number", "ft_description", "ft_quantity", "ft_unit", "ft_price", "ft_total"],
    // FortnoxOffer-huvud — speglar upsertFortnoxOfferDirect; ft_total = NUMBER (avviker från order!).
    buildPayload(nir) {
      const o = nir.raw || {};
      const ts = o?.OfferDate ? Date.parse(o.OfferDate) : NaN;
      const payload = {
        connection:          nir.connection,
        ft_document_number:  String(o?.DocumentNumber ?? "").trim(),
        ft_customer_number:  String(o?.CustomerNumber ?? ""),
        ft_customer_name:    String(o?.CustomerName ?? ""),
        ft_delivery_date:    o?.DeliveryDate ? helpers.toIsoDate(o.DeliveryDate) : null,
        ft_your_reference:   String(o?.YourReferenceNumber ?? "").trim(),
        ft_offer_date:       o?.OfferDate ? helpers.toIsoDate(o.OfferDate) : null,
        ft_valid_until:      o?.ExpireDate ? helpers.toIsoDate(o.ExpireDate) : null,
        ft_offer_ts:         Number.isFinite(ts) ? ts : null,      // NYTT number-fält
        ft_total:            o?.Total != null ? Number(o.Total) : null,   // NUMBER (befintlig fälttyp)
        ft_net:              o?.Net != null ? Number(o.Net) : null,
        ft_totalvat:         o?.TotalVAT != null ? Number(o.TotalVAT) : null,
        ft_currency:         String(o?.Currency ?? ""),
        ft_cancelled:        !!o?.Cancelled,
        ft_sent:             !!o?.Sent,
        ft_url:              String(o?.["@url"] ?? ""),
        ft_raw_json:         JSON.stringify(o || {}),
        // 9c: flagga PDF-hämtning (FortnoxOffer har redan fältet). Ej i compareFields.
        needs_pdf_sync:      true,
      };
      if (nir.companyId) payload.linked_company = nir.companyId;
      return payload;
    },
    // FortnoxOfferRow — speglar befintlig payload; belopp som NUMBER (toNumOrNull-stil).
    buildRowPayload(rn, parentId, head) {
      const row = rn.row || {};
      const num = (v) => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
      return {
        connection:               rn.connection,
        offer:                    parentId,                       // parent-relation
        ft_offer_document_number: rn.docNo,
        ft_row_index:             rn.index + 1,
        ft_article_number:        String(row?.ArticleNumber ?? ""),
        ft_description:           String(row?.Description ?? ""),
        ft_quantity:              row?.Quantity ?? null,
        ft_unit:                  String(row?.Unit ?? ""),
        ft_price:                 num(row?.Price),                 // NUMBER
        ft_total:                 num(row?.Total),                 // NUMBER
        ft_unique_key:            `OFFERROW_${row?.RowId ?? rn.index}_${rn.connection}_${rn.docNo}`,
        ft_raw_json:              JSON.stringify(row || {}),
      };
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9d — Tengella workorder → FortnoxOrder (unified ordermodell, §9.8).
  //
  // Avviker från fortnox-order: ingen detail-endpoint (rader inbäddade i listing),
  // GLOBAL discovery (ingen kund-loop), icke-ekonomiskt huvud → härled ft_total =
  // Σ(pris×antal) från rader, net via Tengella-momssats (jämförbar med HK-faktura;
  // markera dock att order ≠ intäkt i KPI). Skriver till SAMMA FortnoxOrder/
  // FortnoxOrderRow-typer som fortnox-order, men connection = TENGELLA → egna records,
  // ingen kollision. source="tengella-workorder". Operativa workorder-fält i ft_raw_json.
  // Ingen needs_pdf_sync (Tengella saknar Fortnox PDF-endpoint).
  // ───────────────────────────────────────────────────────────────────────────
  const tengellaWorkorderAdapter = {
    source: "tengella-workorder",
    bubbleType: "FortnoxOrder",
    keyFields: ["connection", "ft_document_number"],
    compareFields: [
      "ft_net", "ft_totalvat", "ft_total", "ft_order_ts",
      "ft_order_date", "ft_customer_number", "ft_customer_name", "ft_cancelled",
    ],
    rows: {
      bubbleType: "FortnoxOrderRow",
      parentField: "order",
      keyField: "ft_unique_key",
      compareFields: ["ft_article_number", "ft_description", "ft_quantity", "ft_price", "ft_total"],
      buildRowPayload(rn, parentId) {
        const row = rn.row || {};
        const qty   = row?.Quantity != null ? Number(row.Quantity) : null;
        const price = row?.Price != null ? Number(row.Price) : null;
        const lineTotal = (qty != null && price != null) ? Math.round(qty * price * 100) / 100 : null;
        const rowId = row?.WorkOrderRowId ?? row?.workOrderRowId ?? null;
        return {
          connection:               rn.connection,
          order:                    parentId,
          ft_order_document_number: rn.docNo,
          ft_row_index:             rn.index + 1,
          ft_article_number:        row?.ItemNo != null ? String(row.ItemNo) : "",
          ft_description:           String(row?.ItemName ?? ""),
          ft_quantity:              qty,
          ft_unit:                  "",
          ft_price:                 price == null ? "" : String(price),        // STRÄNG (order-rad-typen)
          ft_discount:              null,   // NUMBER-fält i Bubble → null (ej "") för "saknas". Workorder har ingen rabatt.
          ft_vat:                   null,   // NUMBER-fält i Bubble → null. Workorder har ingen moms på rad.
          ft_total:                 lineTotal == null ? "" : String(lineTotal), // härlett Σ-rad
          ft_unique_key:            rowId != null
            ? `WORID_${rowId}__CONN_${rn.connection}__ORDDOC_${rn.docNo}`
            : `FALLBACK__CONN_${rn.connection}__ORDDOC_${rn.docNo}__IDX_${String(rn.index + 1).padStart(3, "0")}`,
          ft_raw_json:              JSON.stringify(row || {}),   // operativa fält (cost_price, invoiced, status)
        };
      },
    },

    async resolveAuth(opts) {
      const orgNo = (opts.orgNo || constants.TENGELLA_DEFAULT_ORGNO || "").trim();
      if (!orgNo) throw new Error("orgNo krävs (eller sätt TENGELLA_DEFAULT_ORGNO)");
      const token = await tengella.login(orgNo);
      return { connection: constants.TENGELLA_CONNECTION_ID, token, orgNo };
    },

    // GLOBAL discovery: paginera /v2/WorkOrders (cursor), rader inbäddade. Ingen kund-loop.
    async *iterateRefs(auth, opts) {
      const maxPages = Number(opts.maxPages ?? 50) || 50;
      const limit    = Number(opts.limit ?? 100) || 100;
      let cursor = null, page = 0, more = true;
      while (more && page < maxPages) {
        page++;
        const resp = await tengella.listWorkOrders({ token: auth.token, limit, cursor });
        const data = Array.isArray(resp?.Data) ? resp.Data : (Array.isArray(resp) ? resp : []);
        for (const wo of data) {
          if (wo?.WorkOrderId == null) continue;
          yield {
            workOrderId: wo.WorkOrderId,
            ym:          String(wo?.OrderDate ?? "").slice(0, 7),
            listRow:     wo,
          };
        }
        cursor = resp?.Next || null;
        more   = helpers.normalizeBool(resp?.ExistsMoreData) && !!cursor;
      }
    },

    // Pass-through: raderna finns redan i listing-raden (ingen detail-endpoint).
    async fetchComplete(auth, ref) {
      return { detail: ref.listRow, ref };
    },

    async normalize(raw, auth, { mode, fast } = {}) {
      const wo   = raw.detail || {};
      const rows = Array.isArray(wo?.WorkOrderRows) ? wo.WorkOrderRows : [];

      // Härled ekonomi: Σ(pris×antal); net via Tengella-momssats (jämförbart med HK-faktura).
      const vatRate = Number(constants.TENGELLA_DEFAULT_VAT_RATE ?? 0.25);
      const round2 = (n) => Math.round(n * 100) / 100;   // bort med float-artefakter (idempotens)
      let total = 0;
      for (const r of rows) {
        const q = Number(r?.Quantity ?? 0), p = Number(r?.Price ?? 0);
        if (Number.isFinite(q) && Number.isFinite(p)) total += q * p;
      }
      total = round2(total);
      const net = Math.round(total / (1 + vatRate));
      const vat = round2(total - net);

      // Kundupplösning: read-only i diff, full (ClientCompany-ensure) i write — som faktura.
      const customerId = wo?.CustomerId;
      const cust = (fast || !customerId)
        ? { customerName: "", customerNumber: "", companyId: null }
        : (mode === "write"
            ? await tengella.resolveInvoiceCustomer(customerId, auth.token)
            : await readOnlyTengellaCustomer(customerId));

      const docNo = String(wo?.WorkOrderNo ?? "").trim() || String(wo?.WorkOrderId ?? "").trim();
      const orderDate = helpers.toIsoDate(helpers.tengellaDate(wo?.OrderDate));

      return {
        connection:     auth.connection,
        documentNumber: docNo,
        orderDate,
        total, net, vat,
        customerName:   cust.customerName,
        customerNumber: cust.customerNumber,
        companyId:      cust.companyId,
        cancelled:      helpers.normalizeBool(wo?.IsDeleted),
        raw:            wo,
        rows: rows.map((row, i) => ({ row, index: i, connection: auth.connection, docNo })),
      };
    },

    // Egen buildPayload: icke-ekonomiskt huvud, härledd ekonomi, source-flagga.
    buildPayload(nir) {
      const ts = nir.orderDate ? Date.parse(nir.orderDate) : NaN;
      const payload = {
        connection:          nir.connection,
        ft_document_number:  String(nir.documentNumber ?? "").trim(),
        ft_customer_number:  nir.customerNumber != null ? String(nir.customerNumber) : "",
        ft_customer_name:    nir.customerName || "",
        ft_order_date:       nir.orderDate || null,
        ft_order_ts:         Number.isFinite(ts) ? ts : null,
        ft_total:            String(Number(nir.total ?? 0)),     // STRÄNG (FortnoxOrder ft_total)
        ft_net:              Number(nir.net ?? 0),               // härlett (order ≠ intäkt i KPI)
        ft_totalvat:         Number(nir.vat ?? 0),
        ft_currency:         "SEK",
        ft_cancelled:        !!nir.cancelled,
        ft_sent:             false,
        ft_url:              "",
        ft_raw_json:         JSON.stringify(nir.raw || {}),      // operativa workorder-fält bevaras
        source:              "tengella-workorder",
      };
      if (nir.companyId) payload.linked_company = nir.companyId;
      return payload;
    },
  };

  const registry = {
    "tengella-invoice":   tengellaInvoiceAdapter,
    "fortnox-invoice":    fortnoxInvoiceAdapter,
    "fortnox-order":      fortnoxOrderAdapter,
    "fortnox-offer":      fortnoxOfferAdapter,
    "tengella-workorder": tengellaWorkorderAdapter,
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

    let attempts = 0;
    for await (const ref of adapter.iterateRefs(auth, opts)) {
      report.counts.seen++;

      // Datum-förfilter via listRow → undvik onödiga detail-anrop
      const ym = ref.ym || "";
      if ((sinceYM && ym && ym < sinceYM) || (untilYM && ym && ym > untilYM)) {
        report.counts.skipped_window++;
        continue;
      }

      // Bounded på FÖRSÖK (inte träffar) → scoped test stoppar även vid fel.
      if (attempts >= maxRecords) break;
      attempts++;

      try {
        const raw     = fast ? { detail: ref.listRow, ref } : await adapter.fetchComplete(auth, ref);
        const nir     = await adapter.normalize(raw, auth, { mode, fast });
        // Per-adapter buildPayload (order/offer ≠ faktura), default = faktura-byggaren.
        const build   = adapter.buildPayload || buildPayload;
        const payload = build(nir);
        // Dokument MED rader (adapter.rows) → set-reconciliation; annars enkel upsert.
        const r       = adapter.rows
          ? await upsertDocWithRows(adapter, payload, nir.rows, { mode })
          : await upsertToBubble(adapter, payload, { mode });

        report.counts.processed++;
        report.counts[r.action]++;

        // Aggregera rad-räknare när adaptern levererar rader.
        if (r.rows) {
          const agg = report.counts.rows || (report.counts.rows = { create: 0, update: 0, noop: 0, delete: 0, error: 0 });
          for (const k of ["create", "update", "noop", "delete", "error"]) agg[k] += (r.rows[k] || 0);
        }

        const tsYM = payload.ft_invoice_ts
          ? new Date(payload.ft_invoice_ts).toISOString().slice(0, 7)
          : (ym || "unknown");

        // Connection-nyckeln är källagnostisk: faktura=connection_id, order/offer=connection.
        const connKey = payload[(adapter.keyFields && adapter.keyFields[0]) || "connection_id"];
        const dkey = connKey + "|" + payload.ft_document_number;
        if (seenDocs.has(dkey)) {
          report.counts.duplicate++;
        } else {
          seenDocs.add(dkey);
          addReconcile(connKey, tsYM, Number(payload.ft_net || 0), payload.ft_invoice_type, payload.ft_cancelled);
          if (r.action === "create" && report.creates.length < 500) {
            report.creates.push({
              doc: payload.ft_document_number, net: Number(payload.ft_net || 0),
              type: payload.ft_invoice_type, ym: tsYM,
            });
          }
        }

        const hasRowChurn = r.rows && (r.rows.create || r.rows.update || r.rows.delete || r.rows.error);
        if ((r.action !== "noop" || hasRowChurn) && report.sample_diffs.length < maxSample) {
          report.sample_diffs.push({
            doc: r.doc, action: r.action, net: r.net, changed: r.changed.slice(0, 12),
            ...(r.rows ? { rows: { create: r.rows.create, update: r.rows.update, delete: r.rows.delete, error: r.rows.error, samples: r.rows.samples } } : {}),
          });
        }
      } catch (e) {
        report.counts.error++;
        if (report.errors.length < 50) {
          report.errors.push({
            invoiceId: ref.invoiceId, customerId: ref.customerId, docNo: ref.docNo,
            message: e?.message || String(e),
            detail: e?.detail || null,
          });
        }
      }
    }

    report.finished_at = new Date().toISOString();
    return report;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BACKFILL: linked_company för befintliga dokument (FortnoxInvoice/Order/Offer).
  //
  // Varför behövs den: linked_company sätts bara på create/update i synken och
  // ligger INTE i COMPARE_FIELDS → ett oförändrat dokument blir "noop" och
  // skrivningen hoppas helt (rad ~151). Dokument som synkats men aldrig ändrats
  // sedan linked_company-logiken kom in saknar därför fältet. Den utlovade
  // historiska backfillen låg i ClientGroup-fasen (avbruten 2026-06-08) → kördes
  // aldrig. Detta är den backfillen.
  //
  // BUBBLE-INTERN: inga Fortnox/Tengella-anrop. All bryggdata finns redan i Bubble.
  // Bygger lookup-map en gång, patchar bara dokument som saknar (eller, med
  // overwrite, har fel) linked_company.
  //
  // Bryggor:
  //   Fortnox-connections (F&E/Staff/Group):
  //     FortnoxCustomer(connection_id, customer_number).linked_company
  //   Tengella (connection == TENGELLA_CONNECTION_ID):
  //     TengellaCustomer(tengella_customer_no ELLER tengella_customer_id
  //                      == ft_customer_number).company
  //
  // mode="diff" (default) skriver INGET — rapporterar tänkta patchar + olösta.
  // mode="write" patchar linked_company.
  // ───────────────────────────────────────────────────────────────────────────
  const BACKFILL_TARGETS = {
    invoice: { bubbleType: "FortnoxInvoice", connField: "connection_id" },
    order:   { bubbleType: "FortnoxOrder",   connField: "connection" },
    offer:   { bubbleType: "FortnoxOffer",   connField: "connection" },
  };

  async function buildCompanyBridges() {
    // Fortnox: `${connection_id}|${customer_number}` → linked_company
    const fortnoxMap = new Map();
    // keySet = ALLA kundposter (oavsett om linked_company finns) → låter oss skilja
    // "kundpost saknas helt" från "kundpost finns men linked_company tom".
    const fortnoxKeySet = new Set();
    const fcs = await bubbleFindAll("FortnoxCustomer", {});
    for (const fc of fcs) {
      const cid = String(fc?.connection_id || "").trim();
      const cn  = String(fc?.customer_number || "").trim();
      const lc  = fc?.linked_company || null;
      if (cid && cn) {
        fortnoxKeySet.add(`${cid}|${cn}`);
        if (lc) fortnoxMap.set(`${cid}|${cn}`, lc);
      }
    }

    // Tengella: ft_customer_number kan vara tengella_customer_no ELLER (fallback i
    // synken) Number(customerId) = tengella_customer_id → mappa BÅDA nycklarna.
    const tengMap = new Map();
    const tengKeySet = new Set();
    const tcs = await bubbleFindAll("TengellaCustomer", {});
    for (const tc of tcs) {
      const company = tc?.company || null;
      const no = String(tc?.tengella_customer_no ?? "").trim();
      const id = String(tc?.tengella_customer_id ?? "").trim();
      if (no) { tengKeySet.add(`no|${no}`); if (company) tengMap.set(`no|${no}`, company); }
      if (id) { tengKeySet.add(`id|${id}`); if (company) tengMap.set(`id|${id}`, company); }
    }

    return {
      fortnoxMap, tengMap, fortnoxKeySet, tengKeySet,
      fcCount: fcs.length, tcCount: tcs.length,
    };
  }

  function resolveBackfillCompany(bridges, connVal, custNo) {
    const conn = String(connVal || "").trim();
    const cn   = String(custNo || "").trim();
    if (!conn || !cn) return null;
    if (conn === String(constants.TENGELLA_CONNECTION_ID)) {
      return bridges.tengMap.get(`no|${cn}`) || bridges.tengMap.get(`id|${cn}`) || null;
    }
    return bridges.fortnoxMap.get(`${conn}|${cn}`) || null;
  }

  // Varför resolvar en kund inte? "no_customer" = ingen kundpost alls; "no_link" =
  // kundpost finns men linked_company/company är tom (rätta vid källan).
  function unresolvedReason(bridges, connVal, custNo) {
    const conn = String(connVal || "").trim();
    const cn   = String(custNo || "").trim();
    if (conn === String(constants.TENGELLA_CONNECTION_ID)) {
      const exists = bridges.tengKeySet.has(`no|${cn}`) || bridges.tengKeySet.has(`id|${cn}`);
      return exists ? "no_link" : "no_customer";
    }
    return bridges.fortnoxKeySet.has(`${conn}|${cn}`) ? "no_link" : "no_customer";
  }

  async function backfillLinkedCompanyForType(target, bridges, opts) {
    const { mode, overwrite, connection_id, maxRecords, sampleSize, onlyMissing } = opts;
    const { bubbleType, connField } = target;

    const constraints = [];
    if (connection_id) constraints.push({ key: connField, constraint_type: "equals", value: connection_id });
    // onlyMissing snabbar upp (läser bara tomma) men is_empty är ett känt fotgevär
    // (Fynd A) → default OFF, robust full-skanning. Slå på medvetet för fart.
    if (onlyMissing) constraints.push({ key: "linked_company", constraint_type: "is_empty", value: true });
    const docs = await bubbleFindAll(bubbleType, { constraints });

    const report = {
      bubbleType,
      scanned: docs.length,
      counts: {
        alreadyOk: 0, missing: 0, resolved: 0, patched: 0,
        unresolved: 0, mismatch: 0, mismatchPatched: 0, skippedNoKey: 0,
      },
      writes: 0,
      sampleResolved: [], sampleUnresolved: [], sampleMismatch: [],
    };

    // Distinkta unresolved-kunder: key `conn|cust` → { conn, cust, name, docs, reason }
    const unresolvedCust = new Map();

    for (const doc of docs) {
      if (maxRecords && report.writes >= maxRecords) break;
      const id      = doc?._id || doc?.id || null;
      const connVal = doc?.[connField];
      const custNo  = doc?.ft_customer_number;
      const current = doc?.linked_company || null;

      if (!connVal || !custNo) { report.counts.skippedNoKey++; continue; }

      const resolved = resolveBackfillCompany(bridges, connVal, custNo);

      if (current) {
        if (resolved && resolved !== current) {
          report.counts.mismatch++;
          if (report.sampleMismatch.length < sampleSize)
            report.sampleMismatch.push({ doc: doc.ft_document_number, conn: connVal, cust: String(custNo), current, resolved });
          if (overwrite && mode === "write" && id) {
            await bubblePatch(bubbleType, id, { linked_company: resolved });
            report.counts.mismatchPatched++; report.writes++;
          }
        } else {
          report.counts.alreadyOk++;
        }
        continue;
      }

      report.counts.missing++;
      if (!resolved) {
        report.counts.unresolved++;
        const cust = String(custNo);
        const ckey = `${connVal}|${cust}`;
        const entry = unresolvedCust.get(ckey);
        if (entry) entry.docs++;
        else unresolvedCust.set(ckey, {
          conn: connVal, cust, name: String(doc.ft_customer_name || ""),
          docs: 1, reason: unresolvedReason(bridges, connVal, cust),
        });
        if (report.sampleUnresolved.length < sampleSize)
          report.sampleUnresolved.push({ doc: doc.ft_document_number, conn: connVal, cust });
        continue;
      }
      report.counts.resolved++;
      if (report.sampleResolved.length < sampleSize)
        report.sampleResolved.push({ doc: doc.ft_document_number, conn: connVal, cust: String(custNo), resolved });
      if (mode === "write" && id) {
        await bubblePatch(bubbleType, id, { linked_company: resolved });
        report.counts.patched++; report.writes++;
      }
    }

    // Distinkt-kund-sammanfattning för unresolved (svaret på "hur många kunder berörs").
    const custList = [...unresolvedCust.values()].sort((a, b) => b.docs - a.docs);
    report.unresolvedCustomers = {
      total:       custList.length,
      noCustomer:  custList.filter((c) => c.reason === "no_customer").length,
      noLink:      custList.filter((c) => c.reason === "no_link").length,
      top:         custList.slice(0, 50),   // mest-drabbade först (cap 50 för payload)
    };
    // FULLA distinkt-nycklarna (lättviktiga) för korrekt global dedup — strippas
    // innan retur så payloaden inte sväller.
    report._allCust = custList.map((c) => ({ key: `${c.conn}|${c.cust}`, reason: c.reason, docs: c.docs }));

    return report;
  }

  async function backfillLinkedCompany(source, opts = {}) {
    const mode          = opts.mode === "write" ? "write" : "diff";   // SÄKER default
    const overwrite     = !!opts.overwrite;                            // korrigera fel-länkade?
    const connection_id = opts.connection_id || null;                 // chunka per bolag
    const onlyMissing   = !!opts.onlyMissing;                         // is_empty-snabbväg (opt-in)
    const maxRecords    = opts.maxRecords != null ? Number(opts.maxRecords) : null;
    const sampleSize    = opts.sampleSize != null ? Number(opts.sampleSize) : 25;

    const keys = source === "all" ? Object.keys(BACKFILL_TARGETS) : [source];
    for (const k of keys) {
      if (!BACKFILL_TARGETS[k]) throw new Error(`Unknown backfill source: ${source} (giltiga: invoice|order|offer|all)`);
    }

    const bridges = await buildCompanyBridges();
    const o = { mode, overwrite, connection_id, maxRecords, sampleSize, onlyMissing };

    const types = [];
    for (const k of keys) types.push(await backfillLinkedCompanyForType(BACKFILL_TARGETS[k], bridges, o));

    const totals = types.reduce((a, t) => {
      for (const key of Object.keys(t.counts)) a[key] = (a[key] || 0) + t.counts[key];
      a.scanned += t.scanned; a.writes += t.writes;
      return a;
    }, { scanned: 0, writes: 0 });

    // Distinkta unresolved-kunder ÖVER alla typer (samma kund kan ligga bakom både
    // order- och offert-dokument → räkna unikt på conn|cust). Aggregera från de
    // FULLA nyckellistorna (_allCust), inte top-50.
    const globalCust = new Map();
    for (const t of types) {
      for (const c of (t._allCust || [])) {
        const e = globalCust.get(c.key);
        if (e) e.docs += c.docs;
        else globalCust.set(c.key, { reason: c.reason, docs: c.docs });
      }
    }
    const globalList = [...globalCust.values()];
    const unresolvedCustomersTotal = {
      distinctCustomers: globalList.length,
      noCustomer: globalList.filter((c) => c.reason === "no_customer").length,
      noLink:     globalList.filter((c) => c.reason === "no_link").length,
      note: "distinkta över alla typer; per-typ-listor (top 50) finns i types[].unresolvedCustomers",
    };

    for (const t of types) delete t._allCust;   // strippa innan retur (håll payload lätt)

    return {
      mode, overwrite, connection_id, onlyMissing,
      bridges: {
        fortnoxCustomers: bridges.fcCount, fortnoxMapped: bridges.fortnoxMap.size,
        tengellaCustomers: bridges.tcCount, tengellaMapped: bridges.tengMap.size,
      },
      totals,
      unresolvedCustomersTotal,
      types,
    };
  }

  return { syncForSource, buildPayload, registry, backfillLinkedCompany };
}
