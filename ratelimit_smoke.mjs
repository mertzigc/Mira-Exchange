// Smoke: publika rate-limitens HINKAR.
//   node ratelimit_smoke.mjs
//
// Bakgrund (2026-08-30): kundens dashboard visade "Ingen kundansvarig tilldelad"
// och "Kunde inte uppdatera". Orsaken var INTE saknad data — /kpi/company/refresh
// svarade 429. Hink-parametern lades till 2026-08-12 efter samma sorts fel, men
// bara TVÅ anropsställen fick en egen hink. Resten delade nyckeln = bara IP:
// olika `max` mot SAMMA träfflista, så den strängaste gränsen fällde alla.
// Kunddashboarden laddar flera publika endpoints och åt upp budgeten.
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const KPI = fs.readFileSync(new URL("./mira-kund-dashboard-kpi.html", import.meta.url), "utf8");

sec("Hinkarna isolerar endpointerna");
{
  const i = SRC.indexOf("function _publicRateLimited(");
  const j = SRC.indexOf("\n}", i);
  const rl = new Function("_publicRl", SRC.slice(i, j + 2) + "\nreturn _publicRateLimited;")(new Map());
  const IP = "1.2.3.4";

  // Fyll en hink till taket — en ANNAN hink ska vara orörd.
  for (let n = 0; n < 40; n++) rl(IP, 30, 3600000, "dashboard");
  ok("full hink stryper sin egen endpoint", rl(IP, 30, 3600000, "dashboard") === true);
  ok("ANNAN endpoint påverkas inte av full hink", rl(IP, 30, 3600000, "kpi_refresh") === false);
  // ⚠️ Utan hink delar allt samma nyckel — det var precis felet.
  for (let n = 0; n < 40; n++) rl(IP, 240);
  ok("hinklösa anrop delar fortfarande nyckel (varför bucket krävs)", rl(IP, 30) === true);
  ok("olika IP delar aldrig hink", rl("9.9.9.9", 30, 3600000, "dashboard") === false);
}

sec("Varje publikt anropsställe har en egen hink");
{
  const calls = SRC.split("\n")
    .map((l, i) => ({ n: i + 1, l }))
    .filter((x) => /_publicRateLimited\(/.test(x.l)
                && !/function _publicRateLimited/.test(x.l));
  ok("det finns publika rate-limit-anrop att kontrollera", calls.length >= 10);
  // Antingen namngiven hink, eller en prefixad IP-nyckel ("klogin:" m.fl.) som
  // ger samma isolering.
  const utan = calls.filter((x) => !/undefined, "/.test(x.l) && !/_publicRateLimited\("\w+:/.test(x.l));
  ok("inget anropsställe saknar hink" + (utan.length ? " (rad " + utan.map((x) => x.n).join(", ") + ")" : ""),
     utan.length === 0);
  // Namnen ska vara unika — två endpoints med samma hink är samma bugg igen.
  const namn = (SRC.match(/undefined, "(\w+)"\)/g) || []).map((m) => m.replace(/.*"(\w+)".*/, "$1"));
  ok("hinknamnen är unika", new Set(namn).size === namn.length);
  ok("kpi_refresh har en egen hink", namn.includes("kpi_refresh"));
  // 30/h var för snålt: dashboarden auto-triggar omräkning när datan är tom.
  ok("kpi_refresh tål dashboardens auto-trigg (>30/h)",
     /_publicRateLimited\(ip, 120, undefined, "kpi_refresh"\)/.test(SRC));
}

sec("Blocket säger vad som faktiskt hände");
// ⚠️ Ett generiskt "Kunde inte uppdatera" dolde en 429 i veckor — kortet såg ut
// att sakna data när det i själva verket var strypt.
ok("429 särskiljs från andra fel", /'För många försök — vänta en stund'/.test(KPI));
ok("patch-fel särskiljs", /'Kunde inte spara i Bubble'/.test(KPI));
ok("okänt fel visar serverns text", /'Kunde inte uppdatera: ' \+ j\.error/.test(KPI));

console.log(`\n${fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL"}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
