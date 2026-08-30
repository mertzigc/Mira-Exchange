// Smoke: tiered_qty — kvantiteten slås upp ur en trappa i stället för att
// kunden anger den.
//   node pris_tiered_smoke.mjs
//
// Utlösare (2026-08-28): EA/Dice har ett kundunikt eventstäd-erbjudande där
// ANTALET GÄSTER bestämmer både tidsåtgången och rabatten:
//   <100 pers 3,5h ×0,9873 · <200 5h ×0,97 · <300 6h ×0,9634
//   <400 7,5h ×0,9563 · 400+ 8,5h ×0,9533
// Motorn kunde rabattdelen (tiered_discount) men inte härleda TIMMARNA —
// _qty() läser bara ett kundsvar. Utan tiered_qty måste kunden själv fylla i
// timmar, och lathunden blir en rekommendation i stället för en uträkning.
//
// ⚠️ Procenttalen är avstämda med kunden och ska INTE avrundas snyggare.
import fs from "node:fs";
import { evalPricing, validateFormula } from "./pricing_engine.js";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
const KOMM = fs.readFileSync(new URL("./mira-kommunikation-admin.html", import.meta.url), "utf8");

const HOURLY = 495;
// EA/Dice-trappan, ordagrant.
const LATHUND = [
  { min: 0,   qty: 3.5, mult: 0.9873 },
  { min: 100, qty: 5,   mult: 0.97   },
  { min: 200, qty: 6,   mult: 0.9634 },
  { min: 300, qty: 7.5, mult: 0.9563 },
  { min: 400, qty: 8.5, mult: 0.9533 },
];
const FORMULA = { rules: [
  { id: "tid", type: "tiered_qty", qty_from: "antal", price: HOURLY, unit: "h", label: "Eventstäd",
    tiers: LATHUND.map((t) => ({ min: t.min, qty: t.qty })) },
  { id: "rabatt", type: "tiered_discount", qty_from: "antal", applies_to: "tid", label: "Volymrabatt",
    tiers: LATHUND.map((t) => ({ min: t.min, rate: Math.round((1 - t.mult) * 10000) / 10000 })) },
]};

sec("Trappan mot kundens lathund");
ok("formeln validerar", validateFormula(FORMULA).ok === true);

// ⚠️ Testa BÅDA sidor av varje gräns — en off-by-one i nivåvalet syns bara där.
const GRANSER = [
  [1, 0], [99, 0], [100, 1], [199, 1], [200, 2],
  [299, 2], [300, 3], [399, 3], [400, 4], [5000, 4],
];
for (const [gaster, idx] of GRANSER) {
  const t = LATHUND[idx];
  const r = evalPricing(FORMULA, { antal: gaster });
  const line = r.breakdown.find((b) => b.id === "tid") || {};
  const vantat = t.qty * HOURLY * t.mult;
  ok(`${gaster} gäster → ${t.qty} h`, line.qty === t.qty);
  ok(`${gaster} gäster → ${Math.round(vantat)} kr (lathunden)`, Math.abs(r.total - vantat) <= 1);
}

sec("Kanter som annars ger tyst nollpris");
{
  // ⚠️ Under lägsta min: utan fallback hade "0 gäster" gett 0 timmar och priset
  // blivit noll utan att någon märkte det.
  const utanNoll = { rules: [{ id: "tid", type: "tiered_qty", qty_from: "antal", price: HOURLY,
    tiers: [{ min: 100, qty: 5 }, { min: 200, qty: 6 }] }] };
  const r = evalPricing(utanNoll, { antal: 10 });
  ok("drivare under lägsta nivån faller på lägsta nivån, inte 0", r.total === Math.round(5 * HOURLY));
}
{
  const r = evalPricing(FORMULA, {});
  ok("obesvarad fråga ger lägsta nivån, inte krasch", r.total > 0 && !!r.breakdown.length);
}
{
  const okastad = { rules: [{ id: "tid", type: "tiered_qty", qty_from: "antal", price: 100,
    tiers: [{ min: 0, qty: 3.5 }, { min: 400, qty: 8.5 }, { min: 200, qty: 6 }] }] };
  ok("osorterad trappa sorteras internt (osorterad hade gett 6 h, inte 8,5)",
     evalPricing(okastad, { antal: 500 }).total === Math.round(8.5 * 100));
}
ok("nivå utan qty fångas av valideringen",
   validateFormula({ rules: [{ id: "t", type: "tiered_qty", qty_from: "a", price: 1,
     tiers: [{ min: 0 }] }] }).ok === false);
ok("tiered_qty utan qty_from fångas", validateFormula({ rules: [{ id: "t", type: "tiered_qty",
   price: 1, tiers: [{ min: 0, qty: 1 }] }] }).ok === false);
ok("tiered_qty utan price fångas", validateFormula({ rules: [{ id: "t", type: "tiered_qty",
   qty_from: "a", tiers: [{ min: 0, qty: 1 }] }] }).ok === false);
ok("tiered_qty utan tiers fångas", validateFormula({ rules: [{ id: "t", type: "tiered_qty",
   qty_from: "a", price: 1 }] }).ok === false);
{
  // Rabatten ska träffa RADEN, inte hela subtotalen — annars rabatteras även
  // andra rader i samma erbjudande.
  const medExtra = { rules: FORMULA.rules.concat(
    [{ id: "extra", type: "fixed", price: 1000, label: "Framkörning" }]) };
  const r = evalPricing(medExtra, { antal: 500 });
  ok("rabatten träffar bara sin egen rad (applies_to)",
     Math.abs(r.total - (8.5 * HOURLY * 0.9533 + 1000)) <= 1);
}

sec("Erbjudande-adminen");
ok("pris-typen finns i väljaren", /key:'tiered_hours'/.test(KOMM));
ok("den bygger BÅDA reglerna ur en drivare",
   /type:'tiered_qty', qty_from:'antal'/.test(KOMM) && /type:'tiered_discount', qty_from:'antal', applies_to:'tid'/.test(KOMM));
// ⚠️ Procenttalen är avstämda med kund — de ska ligga kvar exakt.
for (const p of ["1.27", "3.00", "3.66", "4.37", "4.67"]) {
  ok("lathundens " + p + " % finns som default", KOMM.indexOf("pct:" + p) >= 0);
}
for (const h of ["3.5", "5", "6", "7.5", "8.5"]) {
  ok("lathundens " + h + " h finns som default", new RegExp("qty:" + h.replace(".", "\\.") + "[,\\s]").test(KOMM));
}
ok("procent lagras som sats (4,67 % → 0.0467)", /rate:ofPnum\(t\.pct\)\/100/.test(KOMM));
// ⚠️ Enda typen med TVÅ regler → måste testas före enregels-kontrollen, annars
// öppnas erbjudandet alltid i Avancerat läge.
ok("inläsning känner igen tvåregels-uppsättningen",
   /if \(OF_RULES && OF_RULES\.length === 2\)/.test(KOMM)
   && KOMM.indexOf("if (OF_RULES && OF_RULES.length === 2)") < KOMM.indexOf("if (!OF_RULES || OF_RULES.length !== 1) return null;"));
ok("trappan går att redigera rad för rad", /class="ea-fi of-tier"/.test(KOMM) && /of-tier-add/.test(KOMM));
// En tom trappa ger tyst 0 kr.
ok("sista nivån går inte att ta bort", /if \(ts\.length <= 1\) return;/.test(KOMM));
ok("förhandsvisningen har en gäst-drivare", /id="of-pv-antal"/.test(KOMM));
// ⚠️ Eventstäd är per tillfälle — "kr/mån" hade varit missvisande.
ok("förhandsvisningen säger kr/tillfälle, inte kr/mån", /' kr\/tillfälle' : ' kr\/mån'/.test(KOMM));

sec("Kund-väljaren + upsert-svaret");
const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

// ⚠️ /admin/cc/list svarar {ok, companies:[…]}. Väljaren läste items/ccs med
// `|| j` som fallback → OF_CCS blev hela svarsOBJEKTET och .filter() kastade.
// Sökrutan gav aldrig träffar, utan felmeddelande.
ok("kund-väljaren läser rätt svarsnyckel",
   /OF_CCS = \(j && Array\.isArray\(j\.companies\)\) \? j\.companies : \[\];/.test(KOMM));
ok("ingen `|| j`-fallback kvar som gör OF_CCS till ett objekt",
   !/OF_CCS = \(j && j\.items\)/.test(KOMM));
ok("sökningen kastar inte på oväntad svarsform",
   /var src = Array\.isArray\(OF_CCS\) \? OF_CCS : \[\];/.test(KOMM));
// Samma endpoint läses på två ställen i blocket — de får inte glida isär igen.
ok("båda läsarna av /admin/cc/list använder .companies",
   (KOMM.match(/fetch\(api\('\/admin\/cc\/list'\)/g) || []).length === 2
   && (KOMM.match(/j\.companies/g) || []).length >= 2);
ok("endpointen svarar faktiskt med companies",
   /res\.json\(\{ ok: true, companies: out \}\)/.test(SRC));

// ⚠️ bubbleCreate returnerar id:t som STRÄNG. `created?.id` gav alltid null →
// {ok:true, id:null, offer:null} fast erbjudandet skapades.
ok("upsert returnerar id:t från bubbleCreate",
   /id = await bubbleCreate\(FORFRAGAN\.OFFER_TYPE, patch\);/.test(SRC));
ok("klona-till-kund returnerar också id:t direkt",
   /\/\/ ⚠️ Samma fälla som i \/upsert[\s\S]{0,120}const id = await bubbleCreate\(FORFRAGAN\.OFFER_TYPE, copy\);/.test(SRC));
ok("ingen objekt-avläsning kvar på erbjudande-createn",
   !/created\?\.id \|\| created\?\._id \|\| null/.test(SRC));
// Fortnox-vägarna läser samma helper men hanterar strängfallet FÖRST — de är
// alltså inte samma bugg och ska lämnas i fred.
ok("Fortnox-createarna hanterar strängfallet (inte samma bugg)",
   (SRC.match(/\(typeof created === "string" && created\)/g) || []).length >= 2);
// Bubbles faktiska klagomål loggades men returnerades inte — "bubbleCreate
// failed" utan att veta vilket fält.
ok("upsert exponerar detail vid fel",
   /\[\/admin\/offers\/upsert\]"[\s\S]{0,200}detail: e\?\.detail \|\| null/.test(SRC));

console.log(`\n${fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL"}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
