// Smoke: bokningsläge — F&E-överlappsutredningen.
//   node bokningslage_smoke.mjs
//
// Frågan som ska besvaras innan de tre affärsområdena summeras: skapar Miras
// egen offertväg (`MiraOrder`) rader som SAMMA affär senare får som
// `FortnoxOrder` med FE-connection? Summeras båda rakt av dubbelräknas den.
import fs from "node:fs";
import { feOverlap, normOrderNo, normMiraOrder, normFortnoxOrder, describeEmptySide } from "./bokningslage.js";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
const M = (o) => Object.assign({ _id: "m" + Math.random().toString(36).slice(2, 7), ordernr: "", kundforetag: "cc1", leveransdatum: "2026-06-10", total: 1000, orderstatus: "Bekräftad" }, o);
const F = (o) => Object.assign({ _id: "f" + Math.random().toString(36).slice(2, 7), ft_document_number: "", linked_company: "cc1", ft_delivery_date: "2026-06-10", ft_total: 1000 }, o);

const run = () => {
  // ══════════════════════════════════════════════════════════════════════════
  sec("Normalisering");
  // ══════════════════════════════════════════════════════════════════════════
  ok("ordernummer jämförs utan skiljetecken/versaler", normOrderNo(" mo-1042 ") === "MO1042");
  ok("tomt ordernummer blir tom sträng", normOrderNo(null) === "");
  // ⚠️ Perioden ska styras av LEVERANS, inte när ordern skapades — en order
  // lagd i maj för ett event i juni hör till juni.
  const nm = normMiraOrder(M({ leveransdatum: "2026-06-20", orderdatum: "2026-05-02" }));
  ok("MiraOrder daterar på leveransdatum", nm.date === "2026-06-20");
  ok("faller tillbaka på orderdatum om leverans saknas",
     normMiraOrder(M({ leveransdatum: null, orderdatum: "2026-05-02" })).date === "2026-05-02");
  ok("ref-objekt plattas till id", normMiraOrder(M({ kundforetag: { _id: "cc9" } })).company === "cc9");
  const nf = normFortnoxOrder(F({ ft_cancelled: "ja" }));
  ok("makulerad order flaggas", nf.cancelled === true);
  ok("boolean-makulering fungerar också", normFortnoxOrder(F({ ft_cancelled: true })).cancelled === true);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Inget överlapp — källorna beskriver olika ordrar");
  // ══════════════════════════════════════════════════════════════════════════
  let r = feOverlap(
    [M({ ordernr: "MO-1", total: 5000 })],
    [F({ ft_document_number: "F-900", ft_total: 7000, ft_delivery_date: "2026-06-25" })]);
  ok("ingen matchning hittas", r.matched === 0);
  ok("överlappsvärdet är noll", r.overlap_value === 0);
  ok("båda sidorna redovisas som omatchade", r.unmatched_mira === 1 && r.unmatched_fortnox === 1);
  ok("utlåtandet säger att båda kan summeras", /Båda kan summeras/.test(r.verdict));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Överlapp på exakt ordernummer — dedup är tillförlitlig");
  // ══════════════════════════════════════════════════════════════════════════
  r = feOverlap(
    [M({ ordernr: "MO-1042", total: 5000 })],
    [F({ ft_document_number: "mo 1042", ft_total: 5000 })]);
  ok("matchar trots olika skrivsätt", r.matched === 1 && r.matched_by.exact_no === 1);
  ok("dubbelräkningsbeloppet redovisas", r.overlap_value === 5000);
  ok("utlåtandet säger att dedup är tillförlitlig", /tillförlitlig/.test(r.verdict));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Svagare matchning — utlåtandet ska VARNA, inte bekräfta");
  // ══════════════════════════════════════════════════════════════════════════
  r = feOverlap([M({ ordernr: "MO-7", total: 5000 })], [F({ ft_document_number: "F-901", ft_total: 5000 })]);
  ok("samma kund+dag+belopp matchar", r.matched === 1 && r.matched_by.company_date_total === 1);
  // ⚠️ Kärnan: en beloppsmatchning KAN vara två olika ordrar på samma summa.
  ok("utlåtandet kallar det en gissning", /gissning/.test(r.verdict));

  r = feOverlap([M({ ordernr: "MO-8", total: 5000, leveransdatum: "2026-06-01" })],
                [F({ ft_document_number: "F-902", ft_total: 5000, ft_delivery_date: "2026-06-20" })]);
  ok("samma belopp inom datumfönstret matchar svagast", r.matched_by.company_total === 1);
  r = feOverlap([M({ total: 5000, leveransdatum: "2026-01-01" })],
                [F({ ft_total: 5000, ft_delivery_date: "2026-06-20" })]);
  ok("utanför datumfönstret matchar INTE", r.matched === 0);

  r = feOverlap([M({ total: 5000, kundforetag: "cc1" })], [F({ ft_total: 5000, linked_company: "cc2" })]);
  ok("olika kund matchar aldrig på belopp", r.matched === 0);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Räkning och sidoeffekter");
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ En FortnoxOrder får bara konsumeras EN gång — annars ser två MiraOrder
  // ut att båda överlappa samma rad och dubbelräkningen överskattas.
  r = feOverlap([M({ ordernr: "MO-1", total: 5000 }), M({ ordernr: "MO-2", total: 5000 })],
                [F({ ft_document_number: "F-1", ft_total: 5000 })]);
  ok("en Fortnox-order konsumeras bara en gång", r.matched === 1 && r.unmatched_mira === 1);

  r = feOverlap([M({ total: 5000 })], [F({ ft_total: 5000, ft_cancelled: "ja" })]);
  ok("makulerade Fortnox-ordrar räknas inte", r.fortnox_count === 0 && r.matched === 0);

  r = feOverlap([M({ total: 1000 })], [F({ ft_total: 1000.5 })]);
  ok("öresavrundning inom tolerans matchar", r.matched === 1);
  r = feOverlap([M({ total: 1000 })], [F({ ft_total: 1050 })]);
  ok("50 kr isär matchar inte", r.matched === 0);

  ok("tomma listor kraschar inte", feOverlap([], []).matched === 0 && feOverlap(null, null).mira_count === 0);
  r = feOverlap([M({ total: 100 }), M({ total: 200 })], [F({ ft_total: 300 })]);
  ok("summorna redovisas per källa", r.mira_total === 300 && r.fortnox_total === 300);
  ok("men lika summor är INTE en matchning", r.matched === 0);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Endpoint");
  // ══════════════════════════════════════════════════════════════════════════
  const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const i = SRC.indexOf('app.get("/admin/bokningslage/fe-overlap"');
  const blk = i < 0 ? "" : SRC.slice(i, SRC.indexOf("\n});", i));
  ok("endpoint finns", i > 0);
  ok("skriver ingenting", !/bubbleCreate|bubblePatch|_bulkCreate/.test(blk));
  // ⚠️ Den här assertionen påstod ursprungligen `connection_id` — samma gissning
  // som koden. Testet BEKRÄFTADE alltså buggen i stället för att fånga den, och
  // var grönt medan endpointen gav noll rader i skarp drift. Fältet heter
  // `connection` (index.js skriver `connection: connection_id`). Lärdom: ett
  // grep-test som speglar antagandet i koden testar ingenting.
  ok("filtrerar på FE-connection via rätt fältnamn",
     /key: "connection", constraint_type: "equals", value: FE_CONNECTION_ID/.test(blk));
  // ⚠️ Bubble saknar "greater than or equal" — inklusivt intervall görs med
  // exklusiva gränser. Samma fälla som kostade en felsökning i Intelliplan-synken.
  // Kommentarerna nämner strängen — testa koden, inte prosan. (Har snubblat på
  // det tre gånger nu: en assertion mot källkod måste alltid strippa kommentarer.)
  const code = blk.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("använder giltiga constraint-typer", !/or equal/.test(code)
     && /constraint_type: "greater than"/.test(code) && /constraint_type: "less than"/.test(code));
  ok("periodiserar F&E på leveransdatum", /leveransdatum/.test(blk) && /ft_delivery_date/.test(blk));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Tomt är INTE en slutsats (skarp bugg 2026-08-19)");
  // ══════════════════════════════════════════════════════════════════════════
  // Första skarpa körningen gav 0 MiraOrder och 0 FortnoxOrder — och verdicten
  // påstod ändå att källorna är disjunkta och "båda kan summeras". Slutsats ur
  // tom data. Orsaken var ett felstavat constraint-fält som .catch svalde.
  const empty = feOverlap([], []);
  ok("noll på båda sidor → INGET ATT JÄMFÖRA", /INGET ATT JÄMFÖRA/.test(empty.verdict));
  ok("påstår INTE att källorna kan summeras", !/kan summeras/.test(empty.verdict));
  ok("uppmanar att kontrollera fältnamn/period", /fältnamnen|perioden/.test(empty.verdict));

  const onlyMira = feOverlap([{ _id: "m1", ordernr: "MO-1", kundforetag: "cc1", leveransdatum: "2026-06-10", total: 1000 }], []);
  ok("bara ena sidan har data → egen varning", /BARA EN KÄLLA/.test(onlyMira.verdict));
  ok("varningen namnger antalen", /MiraOrder 1, FortnoxOrder 0/.test(onlyMira.verdict));

  // ⚠️ Alla ordrar makulerade ser ut som "inga ordrar" — råantalet måste synas,
  // annars letar man efter ett datafel som inte finns.
  const allCancelled = feOverlap([],
    [{ _id: "f1", ft_document_number: "F-1", linked_company: "cc1", ft_delivery_date: "2026-06-10", ft_total: 1000, ft_cancelled: true }]);
  ok("makulerade räknas som noll användbara", /INGET ATT JÄMFÖRA/.test(allCancelled.verdict));
  ok("men råantalet och makuleringarna redovisas", /FortnoxOrder 1 varav 1 makulerade/.test(allCancelled.verdict));
  ok("och drar ingen slutsats om överlapp", !/kan summeras/.test(onlyMira.verdict));

  const onlyFx = feOverlap([], [{ _id: "f1", ft_document_number: "F-1", linked_company: "cc1", ft_delivery_date: "2026-06-10", ft_total: 1000 }]);
  ok("gäller åt andra hållet också", /BARA EN KÄLLA/.test(onlyFx.verdict));

  // Med data på BÅDA sidor är "inget överlapp" en riktig slutsats.
  const disjoint = feOverlap(
    [{ _id: "m1", ordernr: "MO-1", kundforetag: "cc1", leveransdatum: "2026-06-10", total: 1000 }],
    [{ _id: "f1", ft_document_number: "F-9", linked_company: "cc9", ft_delivery_date: "2026-06-20", ft_total: 55 }]);
  ok("data på båda sidor + ingen matchning → slutsatsen är giltig", /Båda kan summeras/.test(disjoint.verdict));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Endpointen — inga tysta nollor");
  // ══════════════════════════════════════════════════════════════════════════
  const SRC2 = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  // Skär till EXAKT endpointen — ett för generöst spann drar in annan kod och
  // gör assertionerna nedan meningslösa.
  const epStart = SRC2.indexOf('app.get("/admin/bokningslage/fe-overlap"');
  const ep = SRC2.slice(epStart, SRC2.indexOf("\n});", epStart) + 4);
  // ⚠️ Kärnan i buggen: en failande fråga får ALDRIG bli en tom lista.
  // Kommentaren i endpointen nämner mönstret — testa koden, inte prosan.
  const epCode = ep.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("inga .catch(() => []) på Bubble-frågorna", !/\.catch\(\(\) => \[\]\)/.test(epCode));
  // ⚠️ Fältet på FortnoxOrder heter `connection` — `connection_id` gav 0 rader.
  ok("constraintar på FortnoxOrder.connection", /key: "connection", constraint_type: "equals"/.test(ep));
  ok("använder INTE connection_id som constraint-nyckel", !/key: "connection_id"/.test(ep));
  // ⚠️ leveransdatum är valfritt på MiraOrder → ordrar utan det vore osynliga.
  ok("hämtar MiraOrder på BÅDE leveransdatum och orderdatum",
     /dateWin\("leveransdatum"\)/.test(ep) && /dateWin\("orderdatum"\)/.test(ep));
  ok("unionen dedupas på id", /seenIds\.has\(id\)/.test(ep));
  ok("svaret redovisar hur många som kom från vilken datumväg",
     /mira_by_leveransdatum/.test(ep) && /mira_by_orderdatum/.test(ep));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Momsbas — inkl vs exkl moms får inte blandas");
  // ══════════════════════════════════════════════════════════════════════════
  // ft_total = Fortnox Total = INKL moms. ft_net = EXKL. Intelliplans intäkt är
  // exkl. Att ställa dem bredvid varandra utan att skilja baserna överdriver F&E
  // med momssatsen. Skarpt juni 2026: 8 096 472 inkl moms mot Intelliplans
  // 6 850 058,36 exkl.
  const momsFx = [
    { _id: "f1", ft_document_number: "F-1", linked_company: "cc1", ft_delivery_date: "2026-06-10", ft_total: 1250, ft_net: 1000 },
    { _id: "f2", ft_document_number: "F-2", linked_company: "cc2", ft_delivery_date: "2026-06-11", ft_total: 2500, ft_net: 2000 },
  ];
  const mb = (feOverlap([], momsFx) || {}).moms_bas || {};
  ok("inkl-moms-summan redovisas separat", mb.fortnox_total_inkl_moms === 3750);
  ok("exkl-moms-summan redovisas separat", mb.fortnox_net_exkl_moms === 3000);
  ok("de är inte samma tal", mb.fortnox_total_inkl_moms !== mb.fortnox_net_exkl_moms);
  ok("full täckning rapporteras som fullständig", /fullständig/.test(mb.note || "") && !/OFULLSTÄNDIG/.test(mb.note || ""));

  // ⚠️ ft_net skrivs bara vid detail-fetch → saknas på list-synkade rader.
  const glesFx = [
    { _id: "f1", ft_document_number: "F-1", linked_company: "cc1", ft_delivery_date: "2026-06-10", ft_total: 1250, ft_net: 1000 },
    { _id: "f2", ft_document_number: "F-2", linked_company: "cc2", ft_delivery_date: "2026-06-11", ft_total: 2500 },
  ];
  const mg = (feOverlap([], glesFx) || {}).moms_bas || {};
  ok("saknat ft_net blir INTE 0 i net-summan", mg.fortnox_net_exkl_moms === 1000);
  ok("antalet rader utan ft_net redovisas", mg.fortnox_utan_net === 1);
  ok("och deras värde redovisas, så gapet syns", mg.fortnox_utan_net_varde_inkl_moms === 2500);
  ok("net-summan flaggas som OFULLSTÄNDIG", /OFULLSTÄNDIG/.test(mg.note || ""));

  // Matchningen ska däremot INTE byta bas — MiraOrder.total är också inkl moms.
  const parad = feOverlap(
    [{ _id: "m1", ordernr: "MO-1", kundforetag: "cc1", leveransdatum: "2026-06-10", total: 1250 }],
    [{ _id: "f1", ft_document_number: "MO-1", linked_company: "cc1", ft_delivery_date: "2026-06-10", ft_total: 1250, ft_net: 1000 }]);
  ok("matchningen jämför total mot total (båda inkl moms)", (parad || {}).matched === 1);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Tom sida — diagnos i stället för slutsats");
  // ══════════════════════════════════════════════════════════════════════════
  // Skarpt 2026-08-20: FortnoxOrder(FE) gav 540 rader men MiraOrder 0 på BÅDA
  // datumvägarna. Frågan "är det ett datafaktum eller en trasig fråga?" måste
  // besvaras av kod, inte av magkänsla.
  const D = (o) => describeEmptySide(Object.assign(
    { type: "MiraOrder", periodCount: 0, typeTotal: 0, wide: [{ field: "leveransdatum", count: 0 }] }, o));

  const tomTyp = D({ typeTotal: 0 });
  ok("typen helt tom → status typen_tom", (tomTyp || {}).status === "typen_tom");
  ok("och säger uttryckligen att det inte handlar om perioden", /inget om just den här perioden/.test((tomTyp || {}).text || ""));

  const faltFel = D({ typeTotal: 350, wide: [{ field: "leveransdatum", count: 0 }, { field: "orderdatum", count: 0 }] });
  ok("rader finns men inget datumfält träffar brett → datumfält_misstänkt", (faltFel || {}).status === "datumfält_misstänkt");
  ok("och pekar ut fältnamnen som ska verifieras", /leveransdatum, orderdatum/.test((faltFel || {}).text || ""));
  ok("kallar det inte ett datafaktum", !/verkligt datafaktum/.test((faltFel || {}).text || ""));

  const riktigNolla = D({ typeTotal: 350, wide: [{ field: "leveransdatum", count: 12 }, { field: "orderdatum", count: 40 }] });
  ok("rader finns brett men noll i perioden → period_tom", (riktigNolla || {}).status === "period_tom");
  ok("först DÅ får det kallas ett datafaktum", /verkligt datafaktum/.test((riktigNolla || {}).text || ""));

  // ⚠️ Skarpt 2026-08-20: MiraOrder hade 1 rad totalt — en TESTORDER. Mira-native
  // offert/orderflödet är inte i drift. "0 i juni" är då sant men berättar fel
  // sak: det betyder "ännu inte i bruk", inte "F&E sålde inget via Mira".
  // Skillnaden avgör om vyn får hårdkoda "F&E = bara Fortnox".
  const knappt = D({ typeTotal: 1, wide: [{ field: "leveransdatum", count: 1 }] });
  ok("en enda rad totalt flaggas som 'knappt i drift'", /knappt är i drift/.test((knappt || {}).text || ""));
  ok("och varnar att svaret ändras när typen tas i drift", /tas i drift ändras svaret/.test((knappt || {}).text || ""));
  ok("grammatiken följer antalet", /har 1 rad totalt/.test((knappt || {}).text || ""));
  const idrift = D({ typeTotal: 350, wide: [{ field: "leveransdatum", count: 40 }] });
  ok("en typ i drift får INTE den varningen", !/knappt är i drift/.test((idrift || {}).text || ""));

  // ⚠️ Det farligaste fallet: probningen själv failade.
  const omatt = D({ typeTotal: null, wide: [{ field: "leveransdatum", count: 0 }] });
  ok("omätbar total → status okänt", (omatt || {}).status === "okänt");
  ok("omätt blir ALDRIG typen_tom", (omatt || {}).status !== "typen_tom");
  const omattFalt = D({ typeTotal: 350, wide: [{ field: "leveransdatum", count: null }] });
  ok("ett omätbart datumfält räcker för okänt", (omattFalt || {}).status === "okänt");
  ok("omätt blir ALDRIG datumfält_misstänkt", (omattFalt || {}).status !== "datumfält_misstänkt");

  const harData = D({ periodCount: 7, typeTotal: 350, wide: [{ field: "leveransdatum", count: 12 }] });
  ok("icke-tom sida rapporteras som har_data", (harData || {}).status === "har_data");

  // ══════════════════════════════════════════════════════════════════════════
  sec("Endpointen — diagnosen mäts med rätt instrument");
  // ══════════════════════════════════════════════════════════════════════════
  ok("endpointen anropar describeEmptySide", /describeEmptySide\(/.test(ep));
  // ⚠️ bubbleCount returnerar 0 på ALLA fel (index.js: `if (!r.ok) continue` →
  // `return 0`). Att diagnostisera en nolla med den vore cirkulärt.
  ok("probningen använder bubbleCountStrict", /bubbleCountStrict\(/.test(epCode));
  ok("och INTE bubbleCount", !/[^t]bubbleCount\(/.test(epCode));
  ok("probefel blir null (omätt), inte 0", /return null;/.test(epCode));
  ok("probefel loggas", /diagnos-probe/.test(epCode));
  ok("diagnosen körs bara när en sida är tom",
     /result\.mira_count === 0/.test(epCode) && /result\.fortnox_count === 0/.test(epCode));
  ok("svaret bär diagnosen", /tom_sida_diagnos/.test(ep));

  // bubbleCountStrict får inte vara en kopia av den sväljande varianten.
  const bcsStart = SRC2.indexOf("async function bubbleCountStrict");
  const bcs = bcsStart === -1 ? "" : SRC2.slice(bcsStart, SRC2.indexOf("\nasync function", bcsStart + 10));
  ok("bubbleCountStrict finns", bcsStart !== -1);
  ok("bubbleCountStrict kastar i stället för att returnera 0", /throw err;/.test(bcs));
  ok("bubbleCountStrict returnerar aldrig en naken 0", !/return 0;/.test(bcs));
  ok("saknad `remaining` gissas inte till 0", /missingRemaining/.test(bcs));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run();
