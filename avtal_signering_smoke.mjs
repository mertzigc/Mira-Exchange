// Smoke: inläst OSIGNERAT avtal → skicka för signering → stämplas signerat.
//   node avtal_signering_smoke.mjs
//
// Bakgrund (2026-08-19): en kollega läste in ett osignerat avtal via PDF-importen,
// la till en bilaga och ville få det signerat. Tre luckor: importen stämplade
// signed_at ändå, signeringsformuläret kunde bara ladda upp nya filer, och det
// fanns ingen koppling avtal→signering. Den här sviten vaktar alla tre.
//
// index.js är för sidoeffektsfylld att importera → funktionerna klipps ut ur
// källan och körs mot en mockad Bubble (samma teknik som cc_cache_smoke.mjs).
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
function slice(src, a, b, label) {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i);
  if (i < 0 || j < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${a}"`); return ""; }
  return src.slice(i, j + b.length);
}
async function group(label, fn) {
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ [${label} kraschade] ${e && e.message}`); }
}

const SRC   = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const CARD  = fs.readFileSync(new URL("./mira-foretag-lista.html", import.meta.url), "utf8");

// Konstanterna vi behöver ur SERVICES — läses ur källan så testet inte har en
// egen sanning om fältnamnen (fel fältnamn = tysta nollresultat, se Internal_room).
const SERVICES = (() => {
  const blk = slice(SRC, "  CT_NOTICE:", "  STATUS_VANTAR_SIGNERING:  \"vantar_signering\",", "SERVICES");
  const o = {};
  for (const m of blk.matchAll(/(\w+):\s*"([^"]*)"/g)) o[m[1]] = m[2];
  Object.assign(o, {
    CONTRACT_TYPE: "Contract", CT_COMPANY: "kundföretag", CT_END: "slutdatum", CT_START: "startdatum",
    STATUS_AKTIV: "aktiv", STATUS_AVSLUTAD: "avslutad", STATUS_UTGAR_SNART: "utgar_snart",
    STATUS_OKAND: "okand", STATUS_OVERRIDE_PAUSED: "pausat", STATUS_OVERRIDE_DISPUTED: "tvistig",
    STATUS_OVERRIDE_DORMANT: "vilande", UTGAR_SNART_DAYS: 30,
  });
  return o;
})();

const run = async () => {

  // ══════════════════════════════════════════════════════════════════════════
  sec("Statushärledning — 'Väntar på signering'");
  // ══════════════════════════════════════════════════════════════════════════
  await group("_deriveContractStatus", () => {
    const fnSrc = slice(SRC, "function _deriveContractStatus(contract, nowMs) {", "\n}", "_deriveContractStatus");
    const derive = new Function("SERVICES", fnSrc + "\nreturn _deriveContractStatus;")(SERVICES);
    const now = Date.now();
    const future = new Date(now + 400 * 864e5).toISOString();

    ok("offer_approval satt + signed_at tom → vantar_signering",
       derive({ offer_approval: "oar1", slutdatum: future }, now) === "vantar_signering");
    ok("signerat avtal påverkas inte",
       derive({ offer_approval: "oar1", signed_at: "2026-08-01", slutdatum: future }, now) === "aktiv");
    // ⚠️ Detta är kärnan i valet av signal: massor av äldre avtal saknar signed_at
    // (manuella /create sätter det bara om anroparen skickar det). Hade vi flaggat
    // på "signed_at tom" ENSAMT skulle halva listan plötsligt visats som osignerad.
    ok("signed_at tom UTAN signering → oförändrad status (inga falsklarm på gamla avtal)",
       derive({ slutdatum: future }, now) === "aktiv");
    ok("manuell override vinner fortfarande",
       derive({ offer_approval: "oar1", status_override: "Pausat" }, now) === "pausat");
    ok("väntar-status går före datum-härledningen (inte 'Aktiv' bara för att start passerat)",
       derive({ offer_approval: "oar1", startdatum: "2020-01-01" }, now) === "vantar_signering");
    ok("avslutat avtal utan signering → avslutad",
       derive({ slutdatum: "2020-01-01" }, now) === "avslutad");
  });

  // ══════════════════════════════════════════════════════════════════════════
  sec("Import — osignerat avtal stämplas inte som signerat");
  // ══════════════════════════════════════════════════════════════════════════
  const imp = slice(SRC, 'app.post("/admin/contracts/import/commit"', "\n});", "import/commit");
  ok("flaggan defaultar till signerat (oförändrat för gamla anropare)",
     /const isSigned\s*=\s*b\.is_signed !== false/.test(imp));
  ok("'no' som sträng räknas också som osignerat", /String\(b\.is_signed\)\.toLowerCase\(\) !== "no"/.test(imp));
  ok("signed_pdf sätts bara när avtalet är signerat", /CT_SIGNED_PDF\]:\s*isSigned \? fileUrl : null/.test(imp));
  ok("signed_at sätts bara när avtalet är signerat", /CT_SIGNED_AT\]:\s*isSigned \? signedAt : null/.test(imp));
  ok("PDF:en blir bilaga oavsett", /CT_ATTACHMENTS\]:\s*fileDocId \? \[fileDocId\] : null/.test(imp));
  ok("svaret säger vilket läge som användes", /is_signed: isSigned/.test(imp));

  // ══════════════════════════════════════════════════════════════════════════
  sec("send-for-signing — återanvänder bilagorna, länkar avtalet");
  // ══════════════════════════════════════════════════════════════════════════
  const send = slice(SRC, 'app.post("/admin/contracts/:id/send-for-signing"', "\n});", "send-for-signing");
  ok("underlaget = avtalets EGNA bilagor (inga omuppladdningar)",
     /const attachmentIds = _ffIdsOf\(ct\[SERVICES\.CT_ATTACHMENTS\]\)/.test(send));
  ok("skickar dokument-id:n, inte filer", /files: \[\]/.test(send) && /dokumentIds,/.test(send));
  // Utan denna filtrering kan man skicka ett FRÄMMANDE dokument för signering
  // genom att bara skicka dess id i bodyn.
  ok("en delmängd får bara innehålla avtalets egna bilagor",
     /requested\.filter\(\(id\) => attachmentIds\.includes\(id\)\)/.test(send));
  ok("inga bilagor → 400 med läsbar orsak", /error: "inga_dokument"/.test(send));
  ok("redan signerat → 409 (skicka inte ut ett påskrivet avtal igen av misstag)",
     /error: "already_signed"/.test(send) && /409/.test(send));
  ok("pågående signering → 409 med request-id:t", /error: "signing_already_started"/.test(send));
  ok("båda spärrarna går att forcera medvetet", (send.match(/&& !force/g) || []).length === 2);
  // ⚠️ Kärnan i duplikatskyddet: utan auto_create_contract:"no" OCH utan
  // contract_template_json skulle Approved kunna skapa ett ANDRA avtal.
  ok("auto-Contract avstängd (annars dubbelt avtal vid Approved)", /auto_create_contract: "no"/.test(send));
  // Kommentarerna nämner fältet — testa på koden, inte på prosan.
  const sendCode = send.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok("skickar aldrig contract_template_json", !/contract_template_json/.test(sendCode));
  ok("länkar avtalet → signeringen", /CT_OFFER_APPROVAL\]: result\.request_id/.test(send));
  ok("länkas EFTER att requesten skapats (pekar aldrig på ett id som inte finns)",
     send.indexOf("_createApprovalRequestInternal") < send.indexOf("CT_OFFER_APPROVAL]: result.request_id"));
  ok("kund + affär ärvs från avtalet", /clientcompany: companyId/.test(send) && /deal:\s+dealId/.test(send));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Återskrivning vid Approved");
  // ══════════════════════════════════════════════════════════════════════════
  await group("_markContractSignedFromApproval", async () => {
    const fnSrc = slice(SRC, "async function _markContractSignedFromApproval(parent) {", "\n}", "_markContractSigned");
    let STORE = {}, patched = [];
    const mk = () => {
      patched = [];
      return new Function("SERVICES", "bubbleFindAll", "bubblePatch", "console", fnSrc + "\nreturn _markContractSignedFromApproval;")(
        SERVICES,
        async (t, { constraints = [] } = {}) => (STORE[t] || []).filter((r) => constraints.every((c) => String(r[c.key] || "") === String(c.value))),
        async (t, id, p) => { patched.push({ t, id, p }); const r = (STORE[t] || []).find((x) => x._id === id); if (r) Object.assign(r, p); },
        { log() {}, warn() {}, error() {} }
      );
    };

    STORE = {
      Contract: [{ _id: "ct1", offer_approval: "oar1" }],
      OfferApproval: [
        { _id: "a1", request: "oar1", signed_document: "https://x/gammal.pdf", signed_document_generated_at: "2026-08-01T10:00:00Z" },
        { _id: "a2", request: "oar1", signed_document: "https://x/senast.pdf", signed_document_generated_at: "2026-08-02T10:00:00Z" },
      ],
    };
    let r = await mk()({ _id: "oar1" });
    ok("stämplar det befintliga avtalet", r.updated === 1 && !!STORE.Contract[0].signed_at);
    ok("tar SENASTE signeringsbeviset", STORE.Contract[0].signed_pdf === "https://x/senast.pdf");
    ok("skriver bara signeringsfälten", JSON.stringify(Object.keys(patched[0].p).sort()) === '["signed_at","signed_pdf"]');

    // Idempotens: körs igen (t.ex. retry) ska inget skrivas om
    r = await mk()({ _id: "oar1" });
    ok("redan stämplat → no-op", r.updated === 0 && patched.length === 0);

    // Utan bevis ska avtalet ändå stämplas — signeringen ÄR klar
    STORE = { Contract: [{ _id: "ct2", offer_approval: "oar2" }], OfferApproval: [{ _id: "b1", request: "oar2" }] };
    r = await mk()({ _id: "oar2" });
    ok("saknat bevis stoppar inte stämplingen", r.updated === 1 && !!STORE.Contract[0].signed_at && !STORE.Contract[0].signed_pdf);

    // Avtal som hör till en ANNAN request rörs inte
    STORE = { Contract: [{ _id: "ct3", offer_approval: "annan" }], OfferApproval: [] };
    r = await mk()({ _id: "oar3" });
    ok("rör bara avtal kopplade till just denna signering", r.updated === 0);
  });

  const complete = slice(SRC, "async function _checkAndCompleteRequest(requestId) {", "\n}", "_checkAndComplete");
  ok("hooken körs vid Approved", /_markContractSignedFromApproval\(parent\)/.test(complete));
  // Ordningen är inte kosmetisk: auto-contract hoppar över requests som redan har
  // ett länkat avtal, så den MÅSTE få titta först.
  ok("körs EFTER auto-contract (som då hoppar över → inget duplikat)",
     complete.indexOf("_createContractsFromApprovalRequest") < complete.indexOf("_markContractSignedFromApproval"));
  ok("mjuk-felar — signeringen bryts aldrig", /contract-signed failed \(non-fatal\)/.test(complete));

  const auto = slice(SRC, "async function _createContractsFromApprovalRequest(parent) {", "\n}", "auto-contract");
  ok("duplikatskyddet bygger på samma koppling vi sätter", /CT_OFFER_APPROVAL, constraint_type: "equals", value: parent\._id/.test(auto));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Kortet");
  // ══════════════════════════════════════════════════════════════════════════
  const proj = slice(SRC, "    offer_approval_id:          ct[SERVICES.CT_OFFER_APPROVAL] || null,", "commission_id:", "projektion");
  ok("projektionen bär is_signed", /is_signed:\s+!!ct\[SERVICES\.CT_SIGNED_AT\]/.test(proj));
  ok("projektionen bär awaiting_signature", /awaiting_signature:\s+!!ct\[SERVICES\.CT_OFFER_APPROVAL\] && !ct\[SERVICES\.CT_SIGNED_AT\]/.test(proj));

  ok("importmodalen frågar om avtalet är signerat", CARD.includes('data-ab="f-is-signed"'));
  ok("frågan är förikryssad = dagens beteende om man inte rör den", /data-ab="f-is-signed" checked/.test(CARD));
  ok("frågan visas BARA i import-läge", /signedRowC\.style\.display = 'none'/.test(CARD));
  ok("flaggan skickas med i commit", /payload\.is_signed = sb \? !!sb\.checked : true/.test(CARD));

  ok("knappen finns på osignerade avtal", /!ct\.is_signed && !ct\.awaiting_signature/.test(CARD));
  ok("knappen döljs när signering redan pågår", CARD.includes("ct.awaiting_signature\n              ? '<div class=\"ab-sign\"><h4>Signering pågår</h4>"));
  ok("statuspillen har en etikett", CARD.includes("label = 'Väntar på signering'"));
  ok("formuläret är INLINE, inte en modal (ingen z-index/stacking-fälla)",
     CARD.includes('data-signwrap=') && !/sign-mask/.test(CARD));
  ok("anropar rätt endpoint", CARD.includes("'/send-for-signing'"));
  ok("skickar valda dokument-id:n", /dokument_ids: docs/.test(CARD));
  ok("kräver minst ett dokument och en mottagare",
     CARD.includes("Välj minst ett dokument att signera.") && CARD.includes("Välj minst en mottagare."));
  ok("mottagare hämtas från kundens kontaktpersoner", CARD.includes("/coworkers"));
  ok("backendens hint visas för användaren", /setErr\(j\.hint \|\| j\.error/.test(CARD));
  ok("listan laddas om efter utskick (statuspillen uppdateras)", /await loadLive\(\);\s*\/\/ statuspillen/.test(CARD));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
