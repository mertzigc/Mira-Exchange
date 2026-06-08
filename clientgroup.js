// clientgroup.js
// ─────────────────────────────────────────────────────────────────────────────
// ClientGroup-fasen, CG-1: READ-ONLY kluster-förslag (kundkort-bundling).
// DI-injicerad från index.js (samma mönster som invoice_sync.js / emailer.js).
//
// Skriver INGENTING. Skannar alla ClientCompany + bryggorna (FortnoxCustomer/
// TengellaCustomer) och föreslår grupperingar för mänsklig granskning:
//   - name_clusters     : CCs med identiskt normaliserat namn (split-problemet).
//   - org_groups        : CCs som delar orgnr; olika namn → CONFLATE-flagga (Alecta).
//   - conflate_by_source: CC vars käll-kunder har olika namn (en CC = flera entiteter).
//
// Metodik (beslut 2026-06-08): orgnr är ett HINT, inte facit. Conflate-fall
// auto-buntas ALDRIG — de flaggas för manuellt beslut. Källidentitet bevaras.
// ─────────────────────────────────────────────────────────────────────────────

export function createClientGroupEngine(deps) {
  const {
    bubbleFindAll,
    bubbleFindOne,
    bubbleCreate,
    bubblePatch,
    helpers = {},   // { normalizeOrgNo }
  } = deps;

  const normalizeOrgNo = helpers.normalizeOrgNo || ((v) => String(v || "").replace(/\D+/g, ""));

  // Namn-normalisering: gemener, bort med juridisk form (AB/HB/KB/filial/publ) och
  // skiljetecken. Behåller ort/landord (sweden/sverige) för att inte överbunta.
  function normName(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\(\s*publ\s*\)/g, " ")
      .replace(/[.,/\\&–-]+/g, " ")
      .replace(/\b(aktiebolag|ab|handelsbolag|hb|kommanditbolag|kb|filial|publ)\b/g, " ")
      .replace(/[^a-z0-9åäöéü ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Union-Find (DSU) för att slå ihop CCs som länkas av flera signaler.
  function makeDSU(n) {
    const p = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p[ra] = rb; };
    return { find, union };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // suggestClusters: huvudanalysen. Returnerar rapportobjekt. Inga sidoeffekter.
  // opts: { minClusterSize=2, sampleLimit=200, includeSingletons=false }
  // ───────────────────────────────────────────────────────────────────────────
  async function suggestClusters(opts = {}) {
    const minClusterSize = Number(opts.minClusterSize ?? 2) || 2;
    const sampleLimit    = Number(opts.sampleLimit ?? 200) || 200;

    // 1) Ladda alla ClientCompany + båda käll-typerna (paginerat).
    const companies = await bubbleFindAll("ClientCompany", { constraints: [] });
    const fortnoxCustomers  = await bubbleFindAll("FortnoxCustomer", { constraints: [] }).catch(() => []);
    const tengellaCustomers = await bubbleFindAll("TengellaCustomer", { constraints: [] }).catch(() => []);

    // 2) Gruppera käll-kunder per ClientCompany (bryggorna).
    const sourcesByCc = new Map();   // ccId -> [{src, name, org}]
    const addSource = (ccId, src, name, org) => {
      if (!ccId) return;
      const arr = sourcesByCc.get(ccId) || sourcesByCc.set(ccId, []).get(ccId);
      arr.push({ src, name: String(name || "").trim(), org: normalizeOrgNo(org) });
    };
    for (const fc of fortnoxCustomers) {
      addSource(fc?.linked_company, "fortnox", fc?.name, fc?.organisation_number);
    }
    for (const tc of tengellaCustomers) {
      addSource(tc?.company, "tengella", tc?.name, tc?.org_no);
    }

    // 3) Normalisera varje CC.
    const ccs = companies.map((c) => {
      const id = c?._id || c?.id || null;
      const name = c?.Name_company || c?.name_company || c?.name || "";
      const org  = normalizeOrgNo(c?.Org_Number ?? c?.org_number ?? "");
      return {
        id,
        name: String(name).trim(),
        nname: normName(name),
        org,
        ft_customer_number: c?.ft_customer_number ?? null,
        sources: sourcesByCc.get(id) || [],
      };
    });

    // 4) Union på STARKA signaler: identiskt normaliserat namn ELLER samma orgnr.
    //    (orgnr unionar men flaggas separat om namnen spretar → conflate.)
    const dsu = makeDSU(ccs.length);
    const byName = new Map(), byOrg = new Map();
    ccs.forEach((cc, i) => {
      if (cc.nname) { (byName.get(cc.nname) || byName.set(cc.nname, []).get(cc.nname)).push(i); }
      if (cc.org)   { (byOrg.get(cc.org)   || byOrg.set(cc.org, []).get(cc.org)).push(i); }
    });
    for (const idxs of byName.values()) for (let k = 1; k < idxs.length; k++) dsu.union(idxs[0], idxs[k]);
    for (const idxs of byOrg.values())  for (let k = 1; k < idxs.length; k++) dsu.union(idxs[0], idxs[k]);

    // 5) Bygg kluster ur komponenterna.
    const comp = new Map();   // root -> [ccIndex]
    ccs.forEach((_, i) => { const r = dsu.find(i); (comp.get(r) || comp.set(r, []).get(r)).push(i); });

    const clusters = [];
    for (const idxs of comp.values()) {
      if (idxs.length < minClusterSize) continue;
      const members = idxs.map((i) => ccs[i]);
      const distinctNames = [...new Set(members.map((m) => m.nname).filter(Boolean))];
      const distinctOrgs  = [...new Set(members.map((m) => m.org).filter(Boolean))];
      // Konfidens: namn+org överlappar → high; bara namn → medium; bara org (spretiga namn) → low.
      let confidence = "medium";
      if (distinctNames.length === 1 && distinctOrgs.length <= 1) confidence = "high";
      else if (distinctNames.length === 1) confidence = "high";          // samma namn, olika org = split
      else if (distinctOrgs.length === 1 && distinctNames.length > 1) confidence = "low";  // org-conflate
      // Föreslå primary = CC med flest käll-kunder (mest "aktiv"), tie-break namnlängd.
      const primary = members.slice().sort((a, b) =>
        (b.sources.length - a.sources.length) || (a.name.length - b.name.length))[0];
      clusters.push({
        confidence,
        size: members.length,
        suggested_name: primary?.name || "",
        suggested_primary_id: primary?.id || null,
        org_numbers: distinctOrgs,
        aliases: [...new Set(members.map((m) => m.name).filter(Boolean))],
        org_conflate: distinctOrgs.length === 1 && distinctNames.length > 1,
        companies: members.map((m) => ({
          id: m.id, name: m.name, org: m.org,
          ft_customer_number: m.ft_customer_number, source_count: m.sources.length,
        })),
      });
    }
    // Sortera: conflate-flaggade först, sen störst kluster.
    clusters.sort((a, b) => (Number(b.org_conflate) - Number(a.org_conflate)) || (b.size - a.size));

    // 6) Conflate-by-source: en CC vars länkade käll-kunder har ≥2 olika namn.
    const conflateBySource = [];
    for (const cc of ccs) {
      const srcNames = [...new Set(cc.sources.map((s) => normName(s.name)).filter(Boolean))];
      if (srcNames.length >= 2) {
        conflateBySource.push({
          company_id: cc.id, name: cc.name, org: cc.org,
          distinct_source_names: [...new Set(cc.sources.map((s) => s.name).filter(Boolean))],
          source_count: cc.sources.length,
        });
      }
    }
    conflateBySource.sort((a, b) => b.distinct_source_names.length - a.distinct_source_names.length);

    // 7) Stats.
    const clustered = clusters.reduce((n, c) => n + c.size, 0);
    return {
      generated_at: new Date().toISOString(),
      stats: {
        client_companies: ccs.length,
        fortnox_customers: fortnoxCustomers.length,
        tengella_customers: tengellaCustomers.length,
        clusters: clusters.length,
        companies_in_clusters: clustered,
        singletons: ccs.length - clustered,
        org_conflate_clusters: clusters.filter((c) => c.org_conflate).length,
        conflate_by_source: conflateBySource.length,
        no_org: ccs.filter((c) => !c.org).length,
        no_name: ccs.filter((c) => !c.nname).length,
      },
      clusters: clusters.slice(0, sampleLimit),
      conflate_by_source: conflateBySource.slice(0, sampleLimit),
      truncated: {
        clusters: Math.max(0, clusters.length - sampleLimit),
        conflate_by_source: Math.max(0, conflateBySource.length - sampleLimit),
      },
    };
  }

  function slugify(name) {
    return normName(name).replace(/\s+/g, "-").slice(0, 80);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CG-2: applyClusters — skapar/uppdaterar ClientGroup-poster (status="suggested")
  // från klustren. DURABELT: rör ALDRIG en confirmed grupps medlemskap, och hoppar
  // kluster vars CC redan ligger i en confirmed grupp (människans beslut vinner).
  // mode="diff" (default) skriver inget — rapporterar tänkta create/update.
  // opts: { mode, minConfidence ("high"|"medium"|"low"), sampleLimit }
  // ───────────────────────────────────────────────────────────────────────────
  async function applyClusters(opts = {}) {
    const mode = opts.mode === "write" ? "write" : "diff";
    const confOrder = { high: 3, medium: 2, low: 1 };
    const minConf = opts.minConfidence ? (confOrder[opts.minConfidence] || 0) : 0;
    const sampleLimit = Number(opts.sampleLimit ?? 100) || 100;

    const suggestion = await suggestClusters({ minClusterSize: 2, sampleLimit: 1e9 });
    const clusters = suggestion.clusters;

    // Befintliga grupper: confirmed-medlemmar är "låsta", suggested kan uppdateras.
    const groups = await bubbleFindAll("ClientGroup", { constraints: [] }).catch(() => []);
    const confirmedCompanyIds = new Set();
    const groupBySlug = new Map();
    for (const g of groups) {
      const slug = String(g?.slug || "").trim();
      if (slug) groupBySlug.set(slug, g);
      if (String(g?.status || "").toLowerCase() === "confirmed") {
        for (const cid of (Array.isArray(g?.companies) ? g.companies : [])) confirmedCompanyIds.add(cid);
      }
    }

    const result = {
      mode, generated_at: new Date().toISOString(),
      created: 0, updated: 0, skipped_confirmed_slug: 0, skipped_member_in_confirmed: 0,
      actions: [],
    };
    const usedSlugs = new Set();

    for (const c of clusters) {
      if (minConf && (confOrder[c.confidence] || 0) < minConf) continue;
      const memberIds = c.companies.map((m) => m.id).filter(Boolean);
      if (!memberIds.length) continue;

      // Människans bekräftade gruppering vinner: hoppa om någon CC redan är confirmed-medlem.
      if (memberIds.some((id) => confirmedCompanyIds.has(id))) { result.skipped_member_in_confirmed++; continue; }

      let slug = slugify(c.suggested_name) || ("grp-" + String(c.suggested_primary_id || "").slice(-6));
      // Slug-krock inom samma körning → suffix från primary-id (undvik överskrivning).
      if (usedSlugs.has(slug)) slug = slug + "-" + String(c.suggested_primary_id || "").slice(-4);
      usedSlugs.add(slug);

      const payload = {
        name: c.suggested_name,
        slug,
        companies: memberIds,
        primary_company: c.suggested_primary_id || null,
        org_numbers: c.org_numbers || [],
        aliases: c.aliases || [],
        status: "suggested",
      };

      const existing = groupBySlug.get(slug);
      if (existing) {
        if (String(existing.status || "").toLowerCase() === "confirmed") { result.skipped_confirmed_slug++; continue; }
        result.updated++;
        if (result.actions.length < sampleLimit) result.actions.push({ action: "update", slug, name: c.suggested_name, members: memberIds.length, confidence: c.confidence, org_conflate: !!c.org_conflate });
        if (mode === "write") await bubblePatch("ClientGroup", existing._id || existing.id, payload);
      } else {
        result.created++;
        if (result.actions.length < sampleLimit) result.actions.push({ action: "create", slug, name: c.suggested_name, members: memberIds.length, confidence: c.confidence, org_conflate: !!c.org_conflate });
        if (mode === "write") await bubbleCreate("ClientGroup", payload);
      }
    }
    result.total_clusters = clusters.length;
    return result;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CG-2: rollupGroup — aggregerad vy för en ClientGroup (omsättning/antal över
  // medlems-CCs). READ-ONLY. opts: { id } eller { slug }.
  // ───────────────────────────────────────────────────────────────────────────
  async function rollupGroup(opts = {}) {
    let group = null;
    if (opts.id) {
      group = await bubbleFindOne("ClientGroup", [{ key: "_id", constraint_type: "equals", value: opts.id }]).catch(() => null);
    } else if (opts.slug) {
      group = await bubbleFindOne("ClientGroup", [{ key: "slug", constraint_type: "equals", value: opts.slug }]).catch(() => null);
    }
    if (!group) throw Object.assign(new Error("ClientGroup hittades inte (ange id eller slug)"), { status: 404 });

    const members = (Array.isArray(group.companies) ? group.companies : []).filter(Boolean);
    const base = {
      group: { id: group._id || group.id, name: group.name, slug: group.slug, status: group.status, members: members.length },
      revenue_net: 0, invoice_count: 0, cancelled_count: 0, order_count: 0, order_net: 0, by_company: [],
    };
    if (!members.length) return base;

    // Fakturor: linked_company IN medlemmar (en query, paginerad).
    const invoices = await bubbleFindAll("FortnoxInvoice", {
      constraints: [{ key: "linked_company", constraint_type: "in", value: members }],
    }).catch(() => []);
    const perCompany = new Map();
    for (const inv of invoices) {
      const cancelled = inv?.ft_cancelled === true || String(inv?.ft_cancelled || "").toLowerCase() === "ja";
      if (cancelled) { base.cancelled_count++; continue; }
      const net = Number(inv?.ft_net || 0);
      base.revenue_net += net; base.invoice_count++;
      const cc = inv?.linked_company;
      perCompany.set(cc, (perCompany.get(cc) || 0) + net);
    }

    // Ordrar (F&E + workorder via FortnoxOrder).
    const orders = await bubbleFindAll("FortnoxOrder", {
      constraints: [{ key: "linked_company", constraint_type: "in", value: members }],
    }).catch(() => []);
    base.order_count = orders.length;
    base.order_net = orders.reduce((s, o) => s + Number(o?.ft_net || 0), 0);

    base.revenue_net = Math.round(base.revenue_net);
    base.by_company = [...perCompany.entries()].map(([id, net]) => ({ id, net: Math.round(net) })).sort((a, b) => b.net - a.net);
    return base;
  }

  return { suggestClusters, applyClusters, rollupGroup, normName, slugify };
}
