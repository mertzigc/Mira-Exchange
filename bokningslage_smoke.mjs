// Smoke: bokningsläge — F&E-överlappsutredningen.
//   node bokningslage_smoke.mjs
//
// Frågan som ska besvaras innan de tre affärsområdena summeras: skapar Miras
// egen offertväg (`MiraOrder`) rader som SAMMA affär senare får som
// `FortnoxOrder` med FE-connection? Summeras båda rakt av dubbelräknas den.
import fs from "node:fs";
import { feOverlap, normOrderNo, normMiraOrder, normFortnoxOrder, describeEmptySide, bokningslageSummary, normWorkorder, workorderBelopp, kallaFarskhet } from "./bokningslage.js";

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
  // ⚠️ Skarpt: "1 rad totalt och 2 träffar" — samma rad i två datumfält lästes
  // som två rader. Träffarna ska redovisas PER FÄLT, inte som en klumpsumma.
  const tvaFalt = D({ typeTotal: 1, wide: [{ field: "leveransdatum", count: 1 }, { field: "orderdatum", count: 1 }] });
  ok("träffar redovisas per fält", /leveransdatum: 1, orderdatum: 1/.test((tvaFalt || {}).text || ""));
  ok("ingen klumpsumma som läses som radantal", !/2 träffar/.test((tvaFalt || {}).text || ""));
  ok("och säger att samma rad kan ligga i flera fält", /samma rad kan ligga i flera/.test((tvaFalt || {}).text || ""));
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

  // ══════════════════════════════════════════════════════════════════════════
  sec("Sammanställning — tre affärsområden utan att ljuga");
  // ══════════════════════════════════════════════════════════════════════════
  const SP = [{ revenue: 6000000 }, { revenue: 850058.36 }];
  // ⚠️ HK = FortnoxOrder(connection=TENGELLA, source="tengella-workorder") efter
  // §9-cutovern 2026-06-08. `TengellaWorkorder` är PENSIONERAD (fryst 2026-06-04
  // när tengella_cron.sh suspenderades — med flit). HK bär bara ft_order_date;
  // v2-adaptern sätter aldrig ft_delivery_date.
  const W = (o) => Object.assign({ _id: "w" + Math.random().toString(36).slice(2, 7),
    ft_document_number: "WO-1", ft_order_date: "2026-06-05",
    ft_total: 125000, ft_net: 100000, source: "tengella-workorder" }, o);
  const HK = [
    W({ _id: "h1" }),
    W({ _id: "h2", ft_total: 62500, ft_net: 50000, ft_cancelled: "ja" }),
  ];
  const FE = [{ _id: "e1", ft_delivery_date: "2026-06-07", ft_total: 1250, ft_net: 1000 }];
  const sum1 = bokningslageSummary({ sp: SP, hk: HK, fe: FE });
  const omr = (k) => (sum1.omraden || []).find((o) => o.nyckel === k) || {};

  ok("S&P summeras ur revenue", omr("service_people").belopp === 6850058.36);
  ok("HK använder ft_net, inte ft_total", omr("housekeeping").belopp === 100000);
  ok("makulerade HK-ordrar räknas bort", omr("housekeeping").antal === 1 && omr("housekeeping").antal_makulerade === 1);
  ok("F&E använder ft_net", omr("food_event").belopp === 1000);

  // ⚠️ Kärnan: talen får inte presenteras som samma sort.
  ok("S&P märks som intjänat", /Intjänat/.test(omr("service_people").matt || ""));
  ok("HK märks som ordervärde", /Ordervärde/.test(omr("housekeeping").matt || ""));
  // ⚠️ Tengella har INGET leveransdatum — bara order_date. HK svarar alltså på
  // en annan fråga än F&E, och etiketten måste säga det.
  ok("HK säger uttryckligen ORDERDATUM, inte leveransdatum", /ORDERDATUM/.test(omr("housekeeping").matt || ""));
  ok("HK varnar att det inte är samma sak som levererat", /INTE samma sak som levererat/.test(omr("housekeeping").matt || ""));
  ok("F&E säger LEVERANSDATUM", /LEVERANSDATUM/.test(omr("food_event").matt || ""));
  ok("HK och F&E har därför olika mått", omr("housekeeping").matt !== omr("food_event").matt);
  ok("F&E märks som ordervärde", /Ordervärde/.test(omr("food_event").matt || ""));
  ok("måtten är olika", omr("service_people").matt !== omr("housekeeping").matt);
  // 🔻 BESLUT 2026-08-20: ingen totalsumma alls. En etikett ("BLANDADE MÅTT")
  // gör inte ett meningslöst tal meningsfullt — och F&E är känt ofullständigt
  // till Q1-27. Historik bakåt tas ur bokföringen i Fortnox.
  ok("ingen totalsumma visas", sum1.summa === null);
  ok("och skälet står utskrivet", /Ett hopslaget tal hade sett ut som ett facit/.test(sum1.summa_saknas_varfor || ""));
  ok("skälet nämner både måtten och Caspeco-luckan",
     /intjänat/.test(sum1.summa_saknas_varfor || "") && /Caspeco/.test(sum1.summa_saknas_varfor || ""));
  ok("momsbasen sägs ut", /EXKL moms/.test(sum1.moms || ""));

  // ⚠️ Saknat ft_net får inte bli en tyst för låg summa.
  const glest = bokningslageSummary({ sp: [], hk: [], fe: [{ _id: "e9", ft_delivery_date: "2026-06-05", ft_total: 125000 }] });
  ok("order utan ft_net räknas inte som 0 kr utan flaggas", (glest.omraden.find((o) => o.nyckel === "food_event") || {}).ofullstandig === true);
  ok("och gapets storlek redovisas", /125000 kr inkl moms/.test((glest.varningar || []).join(" ")));
  // ⚠️ Samma tysta nolla på HK-sidan: en HK-order utan ft_net.
  const hkTom = bokningslageSummary({ sp: [], hk: [W({ ft_net: undefined })], fe: [] });
  ok("HK-order utan ft_net blir inte 0 kr utan flaggas", (hkTom.omraden.find((o) => o.nyckel === "housekeeping") || {}).ofullstandig === true);
  ok("underlaget markeras som icke fullständigt", glest.underlag_fullstandigt === false);

  // ⚠️ Pågående period: S&P växer i efterhand.
  const pagaende = bokningslageSummary({ sp: SP, hk: [], fe: [], opts: { periodPagaende: true } });
  ok("pågående period varnar om efterrapportering", /Perioden pågår/.test((pagaende.varningar || []).join(" ")));
  ok("och säger att man ska jämföra mot samma dag bakåt", /SAMMA DAG/.test((pagaende.varningar || []).join(" ")));
  ok("pågående period ger aldrig fullständigt underlag", pagaende.underlag_fullstandigt === false);
  const klar = bokningslageSummary({ sp: SP, hk: [], fe: [], opts: { periodPagaende: false } });
  ok("avslutad period varnar inte om efterrapportering", !/Perioden pågår/.test((klar.varningar || []).join(" ")));
  // ⚠️ Men den blir ändå inte `fullstandig` — F&E:s Caspeco-lucka gäller varje
  // period tills migreringen är klar. Det HÄR testet påstod tidigare motsatsen;
  // antagandet föll när täckningsluckan blev känd (Christian 2026-08-20).
  // Så länge något bolag har tackning < 1 får ingen period kallas fullständig.
  ok("men underlaget är ändå inte fullständigt så länge F&E:s täckningslucka finns", klar.underlag_fullstandigt === false);
  ok("och orsaken är täckningen, inte perioden", /Ca 30 %/.test((klar.varningar || []).join(" ")));

  // ⚠️ Den dagen mira-native går i drift måste F&E varna för dubbelräkning.
  const medMira = bokningslageSummary({ sp: [], hk: [], fe: FE, miraCount: 12 });
  ok("MiraOrder i perioden → varning om dubbelräkning", /dubbelräkning|BÅDE MiraOrder och FortnoxOrder/.test((medMira.varningar || []).join(" ")));
  ok("och hänvisar till fe-overlap", /fe-overlap/.test((medMira.varningar || []).join(" ")));
  // ⚠️ Skarpt 2026-08-20: 1 MiraOrder (testordern) fick varningen att påstå
  // "mira-native flödet är i drift". Falskt. Varna — men påstå bara det uppmätta.
  const enMira = bokningslageSummary({ sp: [], hk: [], fe: FE, miraCount: 1 });
  ok("1 MiraOrder varnar fortfarande", /MiraOrder/.test((enMira.varningar || []).join(" ")));
  ok("men påstår INTE att flödet är i drift", !/flödet är i drift/.test((enMira.varningar || []).join(" ")));
  ok("utan pekar på testdata", /TESTDATA/.test((enMira.varningar || []).join(" ")));
  ok("många MiraOrder får däremot drift-formuleringen", /ser ut att vara i drift/.test((medMira.varningar || []).join(" ")));
  ok("utan MiraOrder ingen sådan varning", !/BÅDE MiraOrder/.test((sum1.varningar || []).join(" ")));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Täckningslucka F&E — ~30 % saknas tills Caspeco-migreringen är klar");
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ Farligast av allt: talet SER komplett ut. Inget failar, ingen rad är tom
  // — F&E är bara systematiskt ~30 % för lågt (Christian 2026-08-20, Q1-27).
  const tck = bokningslageSummary({ sp: SP, hk: HK, fe: [
    { _id: "e1", ft_delivery_date: "2026-06-07", ft_total: 8750, ft_net: 7000 }] });
  const fe1 = (tck.omraden || []).find((o) => o.nyckel === "food_event") || {};
  ok("F&E bär en täckningsgrad", fe1.tackning === 0.7);
  ok("belopp är det UPPMÄTTA, inte det uppräknade", fe1.belopp === 7000);
  // 🔻 Uppräkningen är BORTTAGEN — vi vet att talet är för lågt, inte hur mycket.
  ok("ingen uppräkning görs", fe1.uppskattad_full_belopp === undefined);
  ok("och inget fält påstår sig vara en uppskattning", fe1.uppskattad === undefined);
  ok("varningen säger uttryckligen att vi inte räknar upp", /räknar INTE upp/.test((tck.varningar || []).join(" ")));
  ok("noten säger att beloppet är för lågt", /för LÅGT/.test(fe1.tackning_note || ""));
  ok("noten namnger orsaken och tidpunkten", /Caspeco/.test(fe1.tackning_note || "") && /Q1 2027/.test(fe1.tackning_note || ""));
  ok("täckningsluckan hamnar bland varningarna", /Ca 30 %/.test((tck.varningar || []).join(" ")));
  ok("den har ett datum då den ska ses över", fe1.tackning_ses_over === "2027-Q1");

  // De andra bolagen ska INTE räknas upp.
  const sp1 = (tck.omraden || []).find((o) => o.nyckel === "service_people") || {};
  const hk1 = (tck.omraden || []).find((o) => o.nyckel === "housekeeping") || {};
  ok("S&P har full täckning", sp1.tackning === 1);
  ok("HK har full täckning", hk1.tackning === 1);

  // ⚠️ Summan får aldrig se komplett ut när ett bolag har en känd lucka.
  ok("ingen summa att förvanska", tck.summa === null);
  ok("underlaget flaggas som icke fullständigt", tck.underlag_fullstandigt === false);
  ok("per-område-beloppen är kvar och uppmätta", fe1.belopp === 7000);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Källfärskhet — en inaktuell källa är farligare än en tom");
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ Skarpt 2026-08-20: HK gav antal:1, belopp:2880, ofullstandig:false för
  // augusti — men inga TengellaWorkorders hade skapats sedan 4 juni. Ett litet
  // plausibelt tal passerar varje nollkontroll. Nollan syns; det här gör inte det.
  const NU = "2026-08-20T00:00:00.000Z";
  const FR = (o) => kallaFarskhet(Object.assign(
    { type: "TengellaWorkorder", senasteSkapad: NU, senasteRord: NU, nu: NU, maxDagar: 3 }, o));

  ok("färsk källa är färsk", FR({}).status === "farsk");
  const dod = FR({ senasteSkapad: "2026-06-04T00:00:00.000Z", senasteRord: "2026-06-04T00:00:00.000Z" });
  ok("inget rört på 77 dagar → inaktuell", dod.status === "inaktuell");
  ok("dagantalet redovisas", dod.dagar_sedan_rord === 77);
  ok("och säger att synken sannolikt inte kör", /kör sannolikt inte/.test(dod.text || ""));
  ok("och att talet är en rest, inte ett affärsfaktum", /rest av senaste lyckade körning/.test(dod.text || ""));

  // Rörs rader men inget nytt skapas → svagare signal, egen status.
  const ingaNya = FR({ senasteSkapad: "2026-06-04T00:00:00.000Z", senasteRord: NU });
  ok("rader rörs men inga nya → inga_nya, inte inaktuell", ingaNya.status === "inga_nya");
  ok("och kallas inte färsk", ingaNya.status !== "farsk");
  ok("men påstår inte att synken är död", !/kör sannolikt inte/.test(ingaNya.text || ""));

  // ⚠️ Omätt är inte färskt.
  const omattF = FR({ senasteSkapad: null, senasteRord: null });
  ok("omätbar färskhet → okänt", omattF.status === "okänt");
  ok("omätt blir ALDRIG färsk", omattF.status !== "farsk");
  ok("och säger att talet är overifierat", /overifierat/.test(omattF.text || ""));

  // Gränsen ska gå att flytta, och exakt på gränsen är fortfarande färskt.
  ok("precis på gränsen är färskt", FR({ senasteSkapad: "2026-08-17T00:00:00.000Z", senasteRord: "2026-08-17T00:00:00.000Z" }).status === "farsk");
  ok("en dag över gränsen är det inte", FR({ senasteSkapad: "2026-08-16T00:00:00.000Z", senasteRord: "2026-08-16T00:00:00.000Z" }).status === "inaktuell");

  // ══════════════════════════════════════════════════════════════════════════
  sec("Summary-endpointen");
  // ══════════════════════════════════════════════════════════════════════════
  const sStart = SRC2.indexOf('app.get("/admin/bokningslage/summary"');
  const sEp = sStart === -1 ? "" : SRC2.slice(sStart, SRC2.indexOf("\n});", sStart) + 4);
  const sCode = sEp.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("summary-endpointen finns", sStart !== -1);
  ok("inga .catch(() => []) på frågorna", !/\.catch\(\(\) => \[\]\)/.test(sCode));
  // ⚠️ HK constraintades tidigare på TENGELLA_CONNECTION_ID mot FortnoxOrder.
  // Den assertionen togs bort för att den bevakade FEL källa — se HK-testerna
  // nedan. Att bara utöka hade lämnat kvar ett test som skyddade en bugg.
  ok("F&E constraintas på FE_CONNECTION_ID", /FE_CONNECTION_ID/.test(sCode));
  ok("F&E på fältet connection, inte connection_id", /key: "connection", constraint_type: "equals"/.test(sCode) && !/key: "connection_id"/.test(sCode));
  ok("S&P hämtas på ip_period", /key: "ip_period"/.test(sCode));
  // ⚠️⚠️ DE TVÅ FELEN SOM KOSTADE UTREDNINGEN 2026-08-20:
  //  (a) HK lästes ur `TengellaWorkorder` — en PENSIONERAD typ, fryst 2026-06-04.
  //  (b) HK frågades på `ft_delivery_date` — ett fält v2-adaptern ALDRIG skriver.
  // Båda gav 0 rader, och båda nollorna tolkades som fakta.
  ok("HK hämtas ur FortnoxOrder, inte den pensionerade TengellaWorkorder",
     /bubbleFindAll\("FortnoxOrder"/.test(sCode) && !/bubbleFindAll\("TengellaWorkorder"/.test(sCode));
  ok("HK constraintas på TENGELLA-connection", /value: TENGELLA_CONNECTION_ID/.test(sCode));
  ok("HK constraintas på ft_order_date — v2 sätter aldrig ft_delivery_date",
     /dateWin\("ft_order_date"\)/.test(sCode));
  ok("F&E constraintas på ft_delivery_date", /dateWin\("ft_delivery_date"\)/.test(sCode));
  ok("HK och F&E frågar därför OLIKA datumfält",
     /dateWin\("ft_order_date"\)/.test(sCode) && /dateWin\("ft_delivery_date"\)/.test(sCode));
  // ⚠️ summary saknade tom-sida-diagnosen som fe-overlap hade.
  // ⚠️ Att bara greppa `describeEmptySide(` bevisar INGENTING — symbolen kan
  // finnas kvar medan urvalet är dödat. (Mutationstest 2026-08-20: `tomma = []`
  // gav grönt.) Assertionen måste träffa själva urvalet.
  ok("tomma områden väljs ut på antal === 0", /result\.omraden\.filter\(\(o\) => o\.antal === 0\)/.test(sCode));
  ok("och varje tomt område får en diagnos", /o\.tom_sida_diagnos = await probe\(/.test(sCode));
  ok("tomma områden diagnostiseras", /describeEmptySide\(/.test(sCode));
  ok("diagnosen mäts med bubbleCountStrict", /bubbleCountStrict\(/.test(sCode));
  ok("ett tomt område kan aldrig vara fullständigt", /o\.ofullstandig = true/.test(sCode));
  ok("och nollar underlag_fullstandigt", /result\.underlag_fullstandigt = false/.test(sCode));
  // ⚠️ Färskhetskontrollen — HK:s 2 880 kr fick aldrig se friskt ut igen.
  ok("varje område färskhetskontrolleras", /for \(const o of result\.omraden\)/.test(sCode) && /o\.farskhet = await farskhet\(/.test(sCode));
  ok("färskhet läses på både Created Date och Modified Date",
     /nyaste\(type, "Created Date", extra\)/.test(sCode) && /nyaste\(type, "Modified Date", extra\)/.test(sCode));
  // ⚠️ ALARM FATIGUE-RÄTTNING 2026-08-20: villkoret var `status !== "farsk"`,
  // vilket flaggade `inga_nya` (= synken KÖR, bara inga nya rader) som ett
  // problem. Första skarpa körningen gav 4 🔴 av 7 källor när bara EN var en
  // verklig incident. Bara `inaktuell` (inget rörs) och `okänt` (omätt) duger.
  ok("bara inaktuell/okänt gör området ofullständigt",
     /o\.farskhet\.status === "inaktuell" \|\| o\.farskhet\.status === "okänt"/.test(sCode));
  ok("inga_nya flaggar INTE området", !/status !== "farsk"/.test(sCode));
  // ⚠️ HK och F&E bor i SAMMA tabell. En okonstraintad färskhetsmätning hade
  // gjort HK "färsk" bara för att F&E synkas — falsk trygghet av värsta sorten.
  ok("HK-färskheten är constraintad på TENGELLA-connection",
     /housekeeping: \["FortnoxOrder", 3, CONN\(TENGELLA_CONNECTION_ID\)/.test(sCode));
  ok("F&E-färskheten är constraintad på FE-connection",
     /food_event: \["FortnoxOrder", 3, CONN\(FE_CONNECTION_ID\)/.test(sCode));
  ok("färskhetsfrågan skickar med constraints", /constraints: extra/.test(sCode));
  // ⚠️ ip_period är HELA månader — ett delspann gör S&P-talet för stort.
  ok("delspann mot månadskornighet flaggas", /sp_tacker_perioden/.test(sEp) && /inte hela månader/.test(sEp));
  ok("pågående period upptäcks mot dagens datum", /periodPagaende: to >= idag/.test(sCode));
  // Utan datum ska frågan vara "innevarande månad" — det är vyns fråga.
  ok("defaultar till innevarande månad", /mStart\.toISOString/.test(sCode) && /mSlut\.toISOString/.test(sCode));
  ok("och avvisar bakvända spann", /to_före_from/.test(sCode));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Källhälsa-endpointen");
  // ══════════════════════════════════════════════════════════════════════════
  const kStart = SRC2.indexOf('app.get("/admin/bokningslage/kallhalsa"');
  const kEp = kStart === -1 ? "" : SRC2.slice(kStart, SRC2.indexOf("\n});", kStart) + 4);
  const kCode = kEp.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("källhälsa-endpointen finns", kStart !== -1);
  // ⚠️ En PENSIONERAD typ och en DÖD synk ser identiska ut utifrån. Enda sättet
  // att skilja dem är att källan DEKLARERAR vilket den är.
  ok("varje källa deklarerar aktiv/pensionerad", /status: "aktiv"/.test(kCode) && /status: "pensionerad"/.test(kCode));
  ok("TengellaWorkorder är märkt pensionerad",
     /namn: "TengellaWorkorder"[\s\S]{0,300}status: "pensionerad"/.test(kCode));
  ok("och HK-ordrar mäts på FortnoxOrder med TENGELLA-connection",
     /FortnoxOrder \(TENGELLA\/HK\)"[\s\S]{0,200}CONNC\(TENGELLA_CONNECTION_ID\)/.test(kCode));
  // ⚠️ Greppa KODEN (kCode), inte kEp — kommentarerna innehåller samma ord och
  // gjorde testet grönt när själva grenen var borta (mutationstest 2026-08-20).
  ok("bedömningen grenar faktiskt på status", /k\.status === "pensionerad"/.test(kCode));
  ok("en pensionerad källa flaggas inte som problem för att den är gammal",
     /pensionerad — ska inte få nya rader/.test(kCode));
  ok("men flaggas om den PLÖTSLIGT får nya rader", /OVÄNTAT: pensionerad källa/.test(kCode));
  // ⚠️ Planeringsvyns pass — egen väg, ingen cron.
  ok("Tengella-pass mäts via Activity + ActivityType Housekeeping",
     /AT_HOUSEKEEPING/.test(kCode) && /Activity \(Tengella-pass\)/.test(kCode));
  ok("och det saknade cron-jobbet står utskrivet i svaret", /INGEN CRON ANROPAR DEN/.test(kCode));
  ok("färskheten mäts med kallaFarskhet", /kallaFarskhet\(/.test(kCode));
  ok("antalet räknas med bubbleCountStrict, inte bubbleCount", /bubbleCountStrict\(/.test(kCode) && !/[^t]bubbleCount\(/.test(kCode));
  ok("mätfel bärs som fel, inte som noll", /fel = e\?\.message/.test(kCode) && /antal = null/.test(kCode));
  ok("färskhetsfrågorna är constraintade (limit 1)", /limit: 1/.test(kCode));

  // ── Pass-täckning: kan kunderna över huvud taget visa pass? ────────────────
  // ⚠️ syncTengella hoppar över varje TengellaCustomer utan ClientCompany.
  // Kalendern filtrerar på Clientcompany → de kundernas pass syns aldrig, och
  // det ser ut som "inga inbokade pass" i stället för "kopplingen saknas".
  ok("pass-täckningen mäts", /kunder_utan_clientcompany/.test(kCode));
  ok("och betydelsen förklaras för läsaren", /ser ut som "inga inbokade pass"/.test(kCode));
  ok("okopplade kunder namnges så mappningen går att laga", /exempel_utan/.test(kCode));
  ok("mätfel ger okänd täckning, inte fullständig", /behandla den som okänd, inte som fullständig/.test(kCode));
  ok("okopplade kunder gör allt_ok falskt", /!\(passTackning && passTackning\.kunder_utan_clientcompany\)/.test(kCode));
  // ⚠️ Bubbles is_empty kan inte indexeras och är opålitlig för ref-fält →
  // filtrera i JS. 123 rader gör det försumbart.
  ok("company-tomheten filtreras i JS, inte via is_empty", !/is_empty/.test(kCode));

  // ── Överhoppade kunder i själva pass-synken ───────────────────────────────
  const AS = fs.readFileSync(new URL("./activity_sync.js", import.meta.url), "utf8");
  const asCode = AS.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("syncTengella redovisar överhoppade kunder", /report\.skipped_customers\.push\(/.test(asCode));
  ok("och anger orsaken per kund", /orsak:/.test(asCode));
  ok("skipped_customers finns i rapportens grundform (stabil även vid tidig retur)",
     /source: "tengella", companies: 0, skipped_customers: \[\]/.test(asCode));
  ok("den tysta `continue` är borta", !/if \(!ccId \|\| !customerId\) continue;/.test(asCode));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run();
