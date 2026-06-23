// ════════════════════════════════════════════════════════════════════════════
// pricing_engine.js — Mira erbjudande-prismotor (ESM-modul)
// ════════════════════════════════════════════════════════════════════════════
// Samma kod körs både frontend (live-eval i wizardens kostnadspanel) och
// backend (försegling i /admin/forfragan/create). Single source of truth via
// GET /pricing_engine.js som transformerar denna fil till IIFE (window.MiraPricing).
//
// API:
//   evalPricing(formula, answers, opts?) → {
//     ok, currency, subtotal, discount, total, breakdown[], warnings[]
//   }
//
// formula = objekt eller JSON-sträng:
//   {
//     currency: "SEK",
//     rules: [ {id, type, label, ...typ-specifika fält...}, ... ]
//   }
//
// Regeltyper (alla har {id, type, label, ?qty_from}):
//   per_person      { qty_from, price }
//   per_kvm         { qty_from, price }
//   per_hour        { qty_from, price }
//   fixed           { price }
//   piecewise       { qty_from, tiers:[{max, price}] }   // staffat per enhet
//   addon_per_unit  { qty_from, price }
//   tiered_discount { qty_from?, applies_to?, tiers:[{min, rate}] }
//   volume_discount { qty_from, applies_to?, tiers:[{qty, rate}] }   // linjär
//   min_charge      { amount }
//
// answers = { qid: value, ... }  (från custom_form_json-frågorna)
// ════════════════════════════════════════════════════════════════════════════

function _num(v, fallback) {
  if (v == null || v === "") return fallback == null ? 0 : fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return isFinite(n) ? n : (fallback == null ? 0 : fallback);
}

function _round(n) { return Math.round(n * 100) / 100; }

function _qty(rule, answers, warnings) {
  const key = rule.qty_from;
  if (!key) {
    warnings.push("Regel " + (rule.id || rule.type) + ": saknar qty_from");
    return 0;
  }
  const v = answers ? answers[key] : null;
  if (v == null || v === "") return 0;  // kunden har inte svarat än
  return _num(v, 0);
}

function _tierRate(tiers, qty) {
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  const sorted = tiers.slice().sort((a, b) => _num(a.min, 0) - _num(b.min, 0));
  let rate = 0;
  for (const t of sorted) if (qty >= _num(t.min, 0)) rate = _num(t.rate, 0);
  return rate;
}

function _volumeRate(tiers, qty) {
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  const sorted = tiers.slice().sort((a, b) => _num(a.qty, 0) - _num(b.qty, 0));
  if (qty <= _num(sorted[0].qty, 0)) return _num(sorted[0].rate, 0);
  const last = sorted[sorted.length - 1];
  if (qty >= _num(last.qty, 0)) return _num(last.rate, 0);
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i], hi = sorted[i + 1];
    const loQ = _num(lo.qty, 0), hiQ = _num(hi.qty, 0);
    if (qty >= loQ && qty <= hiQ) {
      if (hiQ === loQ) return _num(lo.rate, 0);
      const t = (qty - loQ) / (hiQ - loQ);
      return _num(lo.rate, 0) + t * (_num(hi.rate, 0) - _num(lo.rate, 0));
    }
  }
  return 0;
}

function _piecewisePrice(tiers, qty) {
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  const sorted = tiers.slice().sort((a, b) => {
    const am = a.max == null ? Infinity : _num(a.max, Infinity);
    const bm = b.max == null ? Infinity : _num(b.max, Infinity);
    return am - bm;
  });
  for (const t of sorted) {
    const m = t.max == null ? Infinity : _num(t.max, Infinity);
    if (qty <= m) return _num(t.price, 0);
  }
  return _num(sorted[sorted.length - 1].price, 0);
}

function _defaultLabel(t) {
  return ({
    per_person: "Per person", per_kvm: "Per kvm",
    per_hour: "Per timme", addon_per_unit: "Tillägg",
  })[t] || t;
}
function _defaultUnit(t) {
  return ({
    per_person: "pers", per_kvm: "kvm",
    per_hour: "tim", addon_per_unit: "st",
  })[t] || "st";
}

export function evalPricing(formula, answers, opts) {
  opts = opts || {};
  const warnings = [];
  let parsed = formula;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); }
    catch (e) {
      return { ok: false, error: "ogiltig formel-JSON: " + e.message,
               currency: "SEK", subtotal: 0, discount: 0, total: 0,
               breakdown: [], warnings };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "tom formel", currency: "SEK",
             subtotal: 0, discount: 0, total: 0,
             breakdown: [], warnings };
  }
  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  const currency = parsed.currency || "SEK";
  const breakdown = [];
  const lineAmounts = {};
  let subtotal = 0;
  let discount = 0;
  let minCharge = null;

  // Steg 1: positiva belopp i deklarationsordning.
  rules.forEach((rule) => {
    if (!rule || !rule.type) return;
    const t = String(rule.type).toLowerCase();
    let qty, price, amount;
    switch (t) {
      case "per_person":
      case "per_kvm":
      case "per_hour":
      case "addon_per_unit":
        qty = _qty(rule, answers, warnings);
        price = _num(rule.price, 0);
        amount = _round(qty * price);
        lineAmounts[rule.id || ("r" + breakdown.length)] = amount;
        breakdown.push({
          id: rule.id || null, type: t,
          label: rule.label || _defaultLabel(t),
          qty, unit_price: price, amount,
          unit: rule.unit || _defaultUnit(t),
        });
        subtotal += amount;
        break;
      case "fixed":
        price = _num(rule.price, 0);
        lineAmounts[rule.id || ("r" + breakdown.length)] = price;
        breakdown.push({
          id: rule.id || null, type: t,
          label: rule.label || "Fast pris",
          qty: 1, unit_price: price, amount: price, unit: "st",
        });
        subtotal += price;
        break;
      case "piecewise":
        qty = _qty(rule, answers, warnings);
        price = _piecewisePrice(rule.tiers, qty);
        amount = _round(qty * price);
        lineAmounts[rule.id || ("r" + breakdown.length)] = amount;
        breakdown.push({
          id: rule.id || null, type: t,
          label: rule.label || "Trappad prissättning",
          qty, unit_price: price, amount, unit: rule.unit || "st",
        });
        subtotal += amount;
        break;
      case "min_charge":
        minCharge = _num(rule.amount, 0);
        break;
      case "tiered_discount":
      case "volume_discount":
        break;  // steg 2
      default:
        warnings.push("Okänd regeltyp: " + t);
    }
  });

  subtotal = _round(subtotal);

  // Steg 2: rabatter
  rules.forEach((rule) => {
    if (!rule || !rule.type) return;
    const t = String(rule.type).toLowerCase();
    if (t !== "tiered_discount" && t !== "volume_discount") return;
    const qty = _qty(rule, answers, warnings);
    const rate = t === "tiered_discount"
      ? _tierRate(rule.tiers, qty)
      : _volumeRate(rule.tiers, qty);
    if (!rate) return;
    const base = rule.applies_to && lineAmounts[rule.applies_to] != null
      ? lineAmounts[rule.applies_to] : subtotal;
    const amount = _round(base * rate);
    if (amount <= 0) return;
    breakdown.push({
      id: rule.id || null, type: t,
      label: rule.label || (t === "tiered_discount" ? "Rabatt" : "Volymrabatt"),
      qty, rate, amount: -amount,
      applies_to: rule.applies_to || null,
    });
    discount += amount;
  });

  discount = _round(discount);
  let total = _round(subtotal - discount);

  // Steg 3: min_charge — golv på total.
  if (minCharge != null && total < minCharge) {
    const diff = _round(minCharge - total);
    breakdown.push({
      id: null, type: "min_charge",
      label: "Justering till minimibelopp",
      amount: diff, min_charge: minCharge,
    });
    total = minCharge;
  }

  return { ok: true, currency, subtotal, discount, total, breakdown, warnings };
}

// Strukturvalidering — /admin/offers/upsert kallar denna innan spar.
export function validateFormula(formula) {
  const errors = [];
  let parsed = formula;
  if (typeof parsed === "string") {
    if (!parsed.trim()) return { ok: true, errors: [] };
    try { parsed = JSON.parse(parsed); }
    catch (e) { return { ok: false, errors: ["Ogiltig JSON: " + e.message] }; }
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, errors: ["Formel måste vara objekt"] };
  }
  if (!Array.isArray(parsed.rules)) {
    return { ok: false, errors: ["Formel.rules måste vara array"] };
  }
  const KNOWN = ["per_person","per_kvm","per_hour","fixed","piecewise",
                 "addon_per_unit","tiered_discount","volume_discount","min_charge"];
  parsed.rules.forEach((r, i) => {
    const prefix = "rules[" + i + "]";
    if (!r || typeof r !== "object") {
      errors.push(prefix + ": måste vara objekt"); return;
    }
    const t = String(r.type || "").toLowerCase();
    if (!t || KNOWN.indexOf(t) < 0) {
      errors.push(prefix + ": okänd type=" + r.type); return;
    }
    if (["per_person","per_kvm","per_hour","addon_per_unit"].indexOf(t) >= 0) {
      if (!r.qty_from) errors.push(prefix + " (" + t + "): saknar qty_from");
      if (r.price == null) errors.push(prefix + " (" + t + "): saknar price");
    }
    if (t === "fixed" && r.price == null) {
      errors.push(prefix + " (fixed): saknar price");
    }
    if (t === "piecewise") {
      if (!r.qty_from) errors.push(prefix + " (piecewise): saknar qty_from");
      if (!Array.isArray(r.tiers) || !r.tiers.length) {
        errors.push(prefix + " (piecewise): saknar tiers");
      }
    }
    if (t === "tiered_discount" || t === "volume_discount") {
      if (!Array.isArray(r.tiers) || !r.tiers.length) {
        errors.push(prefix + " (" + t + "): saknar tiers");
      }
      if (t === "volume_discount" && !r.qty_from) {
        errors.push(prefix + " (volume_discount): saknar qty_from");
      }
    }
    if (t === "min_charge" && r.amount == null) {
      errors.push(prefix + " (min_charge): saknar amount");
    }
  });
  return { ok: !errors.length, errors };
}

// Strukturvalidering för custom_form_json (frågorna).
export function validateForm(form) {
  const errors = [];
  let parsed = form;
  if (typeof parsed === "string") {
    if (!parsed.trim()) return { ok: true, errors: [] };
    try { parsed = JSON.parse(parsed); }
    catch (e) { return { ok: false, errors: ["Ogiltig JSON: " + e.message] }; }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, errors: ["custom_form_json måste vara array"] };
  }
  const KNOWN_Q = ["text","textarea","email","number","date","select",
                   "multiselect","rating","nps","scale","yesno","section",
                   "slider","kvm","hours"];
  const ids = {};
  parsed.forEach((q, i) => {
    const prefix = "q[" + i + "]";
    if (!q || typeof q !== "object") {
      errors.push(prefix + ": måste vara objekt"); return;
    }
    if (!q.type || KNOWN_Q.indexOf(String(q.type).toLowerCase()) < 0) {
      errors.push(prefix + ": okänd type=" + q.type);
    }
    if (!q.id && q.type !== "section") {
      errors.push(prefix + ": saknar id");
    } else if (q.id) {
      if (ids[q.id]) errors.push(prefix + ": dubblett av id=" + q.id);
      ids[q.id] = true;
    }
  });
  return { ok: !errors.length, errors };
}
