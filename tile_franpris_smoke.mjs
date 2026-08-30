// Smoke: tile-priset faller tillbaka på ServiceCatalogs från-pris när
// erbjudandet saknar prisformel.
//   node tile_franpris_smoke.mjs
//
// Bakgrund (2026-08-30): frukt och växter hade formler som skalar linjärt utan
// tak — växter 14 kr/kvm gav 42 000 kr/mån på 3 000 kvm, och 10 710 kr/mån för
// Planhat där det SIGNERADE avtalet säger 7 691. Felet är begreppsmässigt:
// växter kostar per växt, frukt per förbrukning — inte per kvm/arbetsplats.
// Lösningen är samma som kaffe och skrivare redan använder: inget formelfält,
// bara ett från-pris. Den fallbacken var HELT oskyddad av tester, och det är
// precis den vi nu börjar lita på.
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

// Klipp ut den riktiga prisfunktionen och kör den mot en stubbad motor.
function priceFn(evalImpl) {
  const i = SRC.indexOf("function _servicesPriceOf(offer, defaultQty, fallback, assumptions) {");
  const j = SRC.indexOf("\n}", i);
  if (i < 0 || j < 0) return null;
  try {
    return new Function("_evalPricing", "FORFRAGAN",
      SRC.slice(i, j + 2) + "\nreturn _servicesPriceOf;")(evalImpl, { OFFER_PRICING_JSON: "pricing_formula_json" });
  } catch (_) { return null; }
}
// Stubben speglar motorn: 14 kr/kvm för växter.
const engine = (raw, answers) => ({ ok: true, total: 14 * Number(answers.yta || 0) });
const pris = priceFn(engine);

sec("Fallbacken till från-pris");
ok("_servicesPriceOf går att köra", !!pris);
if (pris) {
  const ASSUM = { yta: 3000, arbetsplatser: 220 };

  // ⚠️ Det HÄR är fallbacken hela ändringen vilar på.
  ok("utan formel används ServiceCatalogs från-pris",
     pris({ pricing_formula_json: "" }, 1, 2500, ASSUM) === 2500);
  ok("saknat fält (undefined) räknas också som ingen formel",
     pris({}, 1, 2300, ASSUM) === 2300);
  ok("bara blanksteg räknas som ingen formel",
     pris({ pricing_formula_json: "   " }, 1, 2500, ASSUM) === 2500);

  // Med formel ska den fortfarande vinna — kaffe/skrivare-mönstret får inte
  // smitta tjänster som FAKTISKT skalar (housekeeping per kvm).
  ok("med formel vinner formeln över från-priset",
     pris({ pricing_formula_json: '{"rules":[]}' }, 1, 2500, ASSUM) === 42000);

  // ⚠️ 42 000 kr/mån för växter på 3 000 kvm — precis felet vi tar bort.
  ok("formeln skalar linjärt utan tak (varför växter/frukt inte ska ha en)",
     pris({ pricing_formula_json: "x" }, 1, 0, { yta: 3000 }) === 42000
     && pris({ pricing_formula_json: "x" }, 1, 0, { yta: 765 }) === 10710);

  // En trasig formel får inte ge 0 kr — då ser tjänsten gratis ut.
  const trasig = priceFn(() => { throw new Error("boom"); });
  ok("kraschande formel faller tillbaka på från-priset, inte 0",
     trasig({ pricing_formula_json: "trasig" }, 1, 2500, ASSUM) === 2500);
  const svarslos = priceFn(() => ({ ok: false }));
  ok("formel som inte kan räknas faller tillbaka på från-priset",
     svarslos({ pricing_formula_json: "x" }, 1, 2500, ASSUM) === 2500);

  // PrisPerPerson ligger mellan formel och från-pris i kedjan.
  ok("PrisPerPerson används före från-priset när formel saknas",
     pris({ PrisPerPerson: 999 }, 1, 2500, ASSUM) === 999);
  ok("från-priset används när inget annat finns", pris({}, 1, 0, ASSUM) === 0);
}

sec("Endpoint för att sätta från-priset");
const ep = (() => { const i = SRC.indexOf('app.patch("/admin/service-catalog/:id"'); const j = SRC.indexOf("\n});", i); return i < 0 ? "" : SRC.slice(i, j); })();
ok("PATCH-endpointen finns", ep.length > 0);
ok("den kräver admin-token", /error: "unauthorized"/.test(ep));
ok("negativt eller icke-numeriskt från-pris avvisas",
   /!Number\.isFinite\(n\) \|\| n < 0/.test(ep));
ok("tomt anrop avvisas i stället för att låtsas spara", /inget_att_uppdatera/.test(ep));
// ⚠️ bubblePatch avvisar HELA patchen vid okänt fält — ett tyst "ok" utan
// verifiering är hur fel siffror blir kvar.
ok("raden läses tillbaka och returneras", /const fresh = await bubbleGet\(SERVICES\.CATALOG_TYPE, id\)/.test(ep)
   && /from_price: fresh/.test(ep));
ok("endpointen är öppen för x-admin-token", /"\/admin\/service-catalog",/.test(SRC));

sec("Kundens tjänste-grid påstår inget om beräkningen");
{
  const GRID = fs.readFileSync(new URL("./mira-kund-dashboard-tjanster.html", import.meta.url), "utf8");
  // ⚠️ "Beräknat för X kvm · X arbetsplatser" stod under Från-priset. När
  // frukt/växter gick över till från-pris blev påståendet osant — priset är
  // inte längre räknat på kundens yta.
  // Kommentaren som FÖRKLARAR borttagningen får nämna texten — testet ska bara
  // fälla om strängen faktiskt renderas.
  const gridCode = GRID.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  ok("antagande-texten är borta", !/Beräknat för/.test(gridCode));

  // Markupen ensam räcker inte — beloppet måste faktiskt renderas i den.
  ok("Från-priset visas fortfarande med sitt belopp",
     /'<div class="mt-mprice-r">Från<b>'\+fmtKr\(unitPrice\)/.test(gridCode));
  // officeAssume behövs KVAR: tjänster som faktiskt skalar (housekeeping) räknas
  // per valt kontor via adaptedUnitPrice.
  ok("kontorets siffror används fortfarande av prismotorn",
     /function officeAssume\(\)/.test(GRID) && /var a = officeAssume\(\);/.test(GRID));
  ok("ingen annan formulering påstår att priset är beräknat på ytan",
     !/beräknat för/i.test(gridCode));
}

console.log(`\n${fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL"}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
