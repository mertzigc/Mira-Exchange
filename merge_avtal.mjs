// Monterar Avtal-fliken (abonnemang + wizard + import + signeringar) in i
// mira-foretag-lista.html. Källblocken kopieras i stort sett verbatim; bara
// bootstrap-raderna (claim/config/init) skrivs om så modulerna drivs av kortets
// STATE i stället för Bubble-hidden-inputs.
//
// Kör:  node merge_avtal.mjs            (skriver mira-foretag-lista.html)
//       node merge_avtal.mjs --dry      (skriver bara .merged.html för diff)
//
// ⚠️ HISTORIK — SKRIPTET KAN INTE KÖRAS. Kördes EN gång 2026-08-17 mot den då
// omergade filen. Sen dess är mira-foretag-lista.html committad och redigerad
// direkt (assertions failar), och 2026-08-27 RADERADES källblocket
// BÅDA källblocken (mira-abonnemang-kund.html + mira-approval-create.html) —
// deras innehåll lever nu bara inne i mira-foretag-lista.html. Filen ligger kvar
// enbart som dokumentation av hur porten gick till.
// Vill du läsa källblocken: git show <commit före 2026-08-27>:<fil>.
// CSS-scopingen nedan (scopeCss) lades till EFTER första körningen, som efterfix
// via scope_avtal_css.mjs — se den filen och HANDOFF §0k.

import fs from "node:fs";

const DIR = "/Users/christianmertzig/Documents/GitHub/Mira-Exchange";
const rd = (f) => fs.readFileSync(`${DIR}/${f}`, "utf8");
const seg = (src, from, to) => src.split("\n").slice(from - 1, to).join("\n");

let steps = 0;
// Assert-baserad ersättning: exakt EN träff krävs, annars kastas fel.
function rep(s, find, replace, label) {
  const i = s.indexOf(find);
  if (i < 0) throw new Error(`EJ HITTAD: ${label}\n---sökte---\n${find.slice(0, 220)}`);
  if (s.indexOf(find, i + 1) >= 0) throw new Error(`FLERA TRÄFFAR: ${label}`);
  steps++;
  return s.slice(0, i) + replace + s.slice(i + find.length);
}

// ── CSS-scoping ────────────────────────────────────────────────────────────
// Källblocken kör ensamma på egna sidor/popups och har därför en mängd HELT
// generiska selektorer (.field, .pill, .drop, .btn-primary, .err … och värst
// `.hidden{display:none !important}`). Inne på Företag-sidan läcker de ut över
// hela Bubble-appen — `.hidden` släckte alla omgivande Bubble-element (2026-08-17).
// Samma lärdom som multiblock-krocken: byt/scopa HELA namnrymden.
// Vi scopar CSS:en i st.f. att döpa om klasser i markup+JS (lägre risk): varje
// selektor som inte redan bär en egen namnrymd prefixas med panelens rot.
const KEEP = /^(\.ab-|\.ac-|\.aa-|\.wt-|\.fl|\.fk|:root|html\b|body\b|\*)/;
function scopeCss(css, rootSel) {
  // Skydda kommentarer (kan innehålla { }) under parsningen.
  const comments = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, (m) => `/*__C${comments.push(m) - 1}__*/`);

  function block(s, open) {          // hitta matchande }
    let d = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === "{") d++;
      else if (s[i] === "}") { d--; if (!d) return { inner: s.slice(open + 1, i), end: i }; }
    }
    throw new Error("obalanserad CSS");
  }
  function walk(s) {
    let out = "", i = 0;
    while (i < s.length) {
      const b = s.indexOf("{", i);
      if (b < 0) { out += s.slice(i); break; }
      const prelude = s.slice(i, b), t = prelude.trim();
      const blk = block(s, b);
      if (t.startsWith("@")) {
        // @media/@supports: scopa innehållet. @keyframes/@font-face: verbatim.
        out += prelude + "{" + (/^@(media|supports)/i.test(t) ? walk(blk.inner) : blk.inner) + "}";
      } else {
        out += prelude.split(",").map((part) => {
          const sel = part.trim();
          if (!sel || KEEP.test(sel)) return part;
          scoped++;
          return part.replace(sel, rootSel + " " + sel);
        }).join(",") + "{" + blk.inner + "}";
      }
      i = blk.end + 1;
    }
    return out;
  }
  const res = walk(css);
  return res.replace(/\/\*__C(\d+)__\*\//g, (m, n) => comments[Number(n)]);
}
let scoped = 0;

const AB = rd("mira-abonnemang-kund.html");
const AC = rd("mira-approval-create.html");
let FL = rd("mira-foretag-lista.html");

// ── 1. Extrahera segment (gränser verifierade 2026-08-17) ────────────────────
const abCss = seg(AB, 25, 731);      // 3 style-block: .ab-, .aa-wiz-, .wt-
const abHtml = seg(AB, 734, 1308);   // .ab-wrap INKL aa-wiz-mask > .wt-wrap
const abJs = seg(AB, 1310, 2405);    // abonnemangsmodulen
const wzJs = seg(AB, 2408, 3228);    // mall-wizarden
const glJs = seg(AB, 3231, 3281);    // wizard öppna/stäng-delegering
const acCss = seg(AC, 29, 165);
const acHtml = seg(AC, 167, 266);    // .ac-wrap
const acJs = seg(AC, 269, 757);

for (const [n, v] of Object.entries({ abCss, abHtml, abJs, wzJs, glJs, acCss, acHtml, acJs })) {
  if (!v.trim()) throw new Error(`tomt segment: ${n}`);
}
if (!abHtml.startsWith('<div class="ab-wrap">')) throw new Error("abHtml börjar fel");
if (!acHtml.startsWith('<div class="ac-wrap">')) throw new Error("acHtml börjar fel");
if (!abHtml.includes('data-aa="wiz-mask-k"')) throw new Error("wizard-masken saknas i abHtml");
if (!abHtml.includes('class="wt-wrap"')) throw new Error("wizard-markupen saknas i abHtml");

// Tag-balans: .ab-wrap / .ac-wrap måste vara slutna enheter.
function divBalance(html) {
  const open = (html.match(/<div\b/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  return open - close;
}
if (divBalance(abHtml) !== 0) throw new Error(`abHtml div-obalans: ${divBalance(abHtml)}`);
if (divBalance(acHtml) !== 0) throw new Error(`acHtml div-obalans: ${divBalance(acHtml)}`);

// ── 2. Skriv om abonnemangsmodulens bootstrap ───────────────────────────────
let abMod = abJs;
abMod = rep(abMod, `  var root = (function () {
    var all = document.querySelectorAll('.ab-wrap');
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r.dataset.abInit) { r.dataset.abInit = '1'; return r; }
    }
    return null;
  })();
  if (!root) return;`,
  `  // PORT 2026-08-17: kortet äger roten — ingen egen claim.
  var root = FLROOT;`, "ab: root-claim");

abMod = rep(abMod, `  var CLIENTCOMPANY = cfg('clientcompany');`,
  `  var CLIENTCOMPANY = '';   // PORT: sätts av kortet via FKAVTAL.ab.setCompany`, "ab: CLIENTCOMPANY");
abMod = rep(abMod, `  var CC_NAME       = cfg('clientcompany_nm');`, `  var CC_NAME       = '';`, "ab: CC_NAME");
abMod = rep(abMod, `  var DEAL_ID       = cfg('deal');`, `  var DEAL_ID       = '';   // kortet är alltid företags-scopat`, "ab: DEAL_ID");

abMod = rep(abMod, `  bindImportInput();
  renderAll();
  loadLive();
  loadCatalog();
  loadSuppliers();
})();`,
  `  bindImportInput();
  loadSuppliers();   // företags-oberoende (/admin/suppliers) → OK vid init

  // ── PORT 2026-08-17: kort-API. Ingen auto-loadLive/loadCatalog vid init —
  // ingen kund är vald då, och loadCatalog() ÄR företags-scopad
  // (/services/dashboard?company_id=) och fyller BÅDE erbjudande- OCH
  // kontorsdropdownen i skapa-formen. Körs den utan kund blir kontorsvalet
  // tomt (bara Account-scope). Därför: reload() kör båda.
  // Ingen renderAll() vid init heller — annars blinkar demo-SAMPLE förbi.
  FKAVTAL.ab = {
    setCompany: function (id, nm) { CLIENTCOMPANY = id || ''; CC_NAME = nm || ''; DEAL_ID = ''; },
    clear: function () {
      SAMPLE.offices = []; SAMPLE.account_contracts = []; SAMPLE.contracts_by_office = {};
      var cn = $('cust-name'); if (cn) cn.textContent = CC_NAME || 'Kund';
      renderAll();
    },
    reload: function () { loadCatalog(); return loadLive(); },
    render: renderAll
  };
})();`, "ab: init-svans");

// ── 3. Wizarden ─────────────────────────────────────────────────────────────
let wzMod = wzJs;
wzMod = rep(wzMod, `  var BROOT = document.querySelector('.ab-wrap');`,
  `  var BROOT = FLROOT;   // PORT 2026-08-17: kortets rot`, "wiz: BROOT");
wzMod = rep(wzMod, `  const WIZ_CC_ID   = ((BROOT||document).querySelector('[data-mira="clientcompany"]')    || {}).value || '';`,
  `  let WIZ_CC_ID   = '';   // PORT: sätts av kortet`, "wiz: CC_ID");
wzMod = rep(wzMod, `  const WIZ_CC_NAME = ((BROOT||document).querySelector('[data-mira="clientcompany_nm"]') || {}).value || '';`,
  `  let WIZ_CC_NAME = '';`, "wiz: CC_NAME");
wzMod = rep(wzMod, `  const WIZ_DEAL_ID = ((BROOT||document).querySelector('[data-mira="deal"]') || {}).value || '';`,
  `  let WIZ_DEAL_ID = '';`, "wiz: DEAL_ID");
wzMod = rep(wzMod, `  window.resetWizard_k = resetWizard;`,
  `  window.resetWizard_k = resetWizard;

  // ── PORT 2026-08-17: kortet sätter förvald kund innan wizarden öppnas.
  // CLIENT är ett objekt → muteras (inga const-problem).
  FKAVTAL.wiz = {
    setCompany: function (id, nm) {
      WIZ_CC_ID = id || ''; WIZ_CC_NAME = nm || ''; WIZ_DEAL_ID = '';
      CLIENT.id = WIZ_CC_ID || null; CLIENT.name = WIZ_CC_NAME || null;
      var nEl = byId('wt-clientName'); if (nEl) nEl.value = WIZ_CC_NAME || '';
    }
  };`, "wiz: kort-API");

// ── 4. Signeringsmodulen ────────────────────────────────────────────────────
let acMod = acJs;
acMod = rep(acMod, `  const root = (function () {
    const all = document.querySelectorAll(".ac-wrap");
    for (const r of all) {
      if (!r.dataset.acInit) { r.dataset.acInit = "1"; return r; }
    }
    return null;
  })();
  if (!root) return;`,
  `  // PORT 2026-08-17: kortet äger roten — ingen egen claim.
  const root = FLROOT;`, "ac: root-claim");

acMod = rep(acMod, `  const CLIENTCOMPANY = cfg("clientcompany");
  const DEAL          = cfg("deal");
  const DEAL_MODE     = !!DEAL;
  const CC_MODE       = !DEAL_MODE && !!CLIENTCOMPANY;
  const LIST_MODE     = DEAL_MODE || CC_MODE;`,
  `  // PORT 2026-08-17: kunden kommer från kortet, inte från hidden inputs.
  let CLIENTCOMPANY = "";
  let DEAL          = "";
  let DEAL_MODE     = false;
  let CC_MODE       = false;
  let LIST_MODE     = false;`, "ac: company-config");

acMod = rep(acMod, `  if (LIST_MODE) {
    $("history-view").classList.remove("hidden");
    $("form-view").classList.add("hidden");
    if (DEAL_MODE) {
      $("title").innerHTML = 'Signering för <span>denna affär</span>';
      $("subtitle").textContent = "Historik + ny utskick · scopad till Deal";
    } else {
      $("title").innerHTML = 'Signering för <span>detta bolag</span>';
      $("subtitle").textContent = "Historik + ny utskick · scopad till ClientCompany";
    }
    fetchHistory();
  }
})();`,
  `  // ── PORT 2026-08-17: kort-API i st.f. auto-init. Kortet är alltid
  // företags-scopat (aldrig deal), så CC_MODE/LIST_MODE sätts av setCompany.
  FKAVTAL.sign = {
    setCompany: function (id, nm) {
      CLIENTCOMPANY = id || ""; DEAL = ""; DEAL_MODE = false;
      CC_MODE = !!CLIENTCOMPANY; LIST_MODE = CC_MODE;
      state.clientcompany = CLIENTCOMPANY;
      const t = $("title");
      // escapeHtml (ej strip) — annars försvinner & ur t.ex. "Fröberg & Lundholm".
      if (t) t.innerHTML = 'Signering för <span>' + (nm ? escapeHtml(String(nm)) : "detta bolag") + '</span>';
      const s = $("subtitle");
      if (s) s.textContent = "Historik + ny utskick · scopad till ClientCompany";
      const hv = $("history-view"), fv = $("form-view");
      if (hv) hv.classList.remove("hidden");
      if (fv) fv.classList.add("hidden");
      loadUserPicker();
    },
    reload: fetchHistory
  };
})();`, "ac: init-svans");

// ── 5. Kortsidan: hidden inputs + panel-hållare ─────────────────────────────
FL = rep(FL, `  <input type="hidden" data-mira="user_name"`,
  `  <input type="hidden" data-mira="sender_email"   value=""><!-- Current User's e-post (avsändare för signeringar) -->
  <input type="hidden" data-mira="sender_name"    value=""><!-- Current User's namn (avsändare för signeringar) -->
  <input type="hidden" data-mira="user_name"`, "fl: sender-inputs");

// Panelerna ligger UTANFÖR cardview → renderCard()s innerHTML= rör dem aldrig.
FL = rep(FL, `  <div data-fl="cardview" style="display:none"></div>`,
  `  <div data-fl="cardview" style="display:none"></div>

  <!-- ══ PORTAT 2026-08-17: Avtal-flikens paneler ══════════════════════════
       Ligger UTANFÖR data-fl="cardview" med flit: renderCard() gör innerHTML=
       på cardview vid varje state-ändring, vilket skulle radera formulär/
       wizard/uppladdningar mitt i inmatning. Panelerna flyttas in i kortets
       mount-punkt med appendChild (flytt bevarar både lyssnare och DOM-state)
       och stashas tillbaka hit före varje re-render. Se mountPanes/stashPanes. -->
  <div data-fl="panes" style="display:none">
${abHtml}
${acHtml}
  </div>`, "fl: panel-hållare");

// CSS från källblocken (egna namnrymder .ab-/.aa-/.wt-/.ac- → krockar ej med .fl/.fk)
FL = rep(FL, `<div class="fl">`, `<!-- ══ PORTAT 2026-08-17: CSS för Avtal-flikens paneler ══
     Generiska selektorer (.field/.pill/.drop/.btn-primary/.hidden …) är
     scopade under .ab-wrap/.ac-wrap av merge_avtal.mjs. UTAN det läcker de
     ut på hela Bubble-sidan — ".hidden{display:none!important}" släckte alla
     omgivande Bubble-element. Lägg ALDRIG till en oscopad regel här. ══ -->
${scopeCss(abCss, ".ab-wrap")}
${scopeCss(acCss, ".ac-wrap")}

<div class="fl">`, "fl: css");

// ── 6. Kortsidan: mount-logik + tab-branch ─────────────────────────────────
FL = rep(FL, `  var STATE={ view:"list", q:"", sort:"name",`,
  `  // ── PORTAT 2026-08-17: Avtal-panelerna registrerar sig här (se modulerna
  // längst ned i denna IIFE). FLROOT ger dem kortets rot utan egen claim.
  var FLROOT = root;
  var FKAVTAL = {};

  var STATE={ view:"list", q:"", sort:"name",`, "fl: FKAVTAL-deklaration");

FL = rep(FL, `    if(STATE.cardTab==="avtal"){
      var sub=STATE.avtalSub||"avtal";
      var toggle='<div class="fk-subtabs">'+
        '<span class="fk-subtab'+(sub==="avtal"?" on":"")+'" data-fk="avsub" data-s="avtal">Abonnemang</span>'+
        '<span class="fk-subtab'+(sub==="signeringar"?" on":"")+'" data-fk="avsub" data-s="signeringar">Signeringar</span></div>';
      var rows=STATE.chain[sub], inner;
      if(rows===undefined){ fetchChain(sub); inner='<div class="fl-msg">Laddar…</div>'; }
      else if(rows==="loading") inner='<div class="fl-msg">Laddar…</div>';
      else inner=(sub==="avtal"?avtalTableBody(rows):signTableBody(rows));
      return '<div class="fk-body">'+toggle+inner+'</div>';
    }`,
  `    if(STATE.cardTab==="avtal"){
      // PORTAT 2026-08-17: full CRUD via de inflyttade panelerna (.ab-wrap /
      // .ac-wrap). Bara mount-punkten renderas här; mountPanes() flyttar in
      // rätt panel efter render. Gamla läsvyn (avtalTableBody/signTableBody)
      // används inte längre för fliken.
      var sub=STATE.avtalSub||"avtal";
      var toggle='<div class="fk-subtabs">'+
        '<span class="fk-subtab'+(sub==="avtal"?" on":"")+'" data-fk="avsub" data-s="avtal">Abonnemang</span>'+
        '<span class="fk-subtab'+(sub==="signeringar"?" on":"")+'" data-fk="avsub" data-s="signeringar">Signeringar</span></div>';
      return '<div class="fk-body">'+toggle+'<div data-fk="avtalmount"></div></div>';
    }`, "fl: avtal-branch");

// stash/mount + anrop i renderCard
FL = rep(FL, `  function renderCard(){`,
  `  // ── PORTAT 2026-08-17: panel-flytt ────────────────────────────────────
  // appendChild FLYTTAR noden — lyssnare och ifyllda fält följer med. Före
  // varje re-render stashas panelerna tillbaka till hållaren så de inte ligger
  // kvar i cardview när innerHTML= nollställer det.
  function paneEl(sub){ return root.querySelector(sub==="signeringar" ? ".ac-wrap" : ".ab-wrap"); }
  function stashPanes(){
    var holder=$("panes"); if(!holder) return;
    var a=root.querySelector(".ab-wrap"), c=root.querySelector(".ac-wrap");
    if(a && a.parentNode!==holder){ a.style.display="none"; holder.appendChild(a); }
    if(c && c.parentNode!==holder){ c.style.display="none"; holder.appendChild(c); }
  }
  function mountPanes(){
    if(STATE.view!=="card" || STATE.cardTab!=="avtal") return;
    var mount=root.querySelector('[data-fk="avtalmount"]'); if(!mount) return;
    var sub=STATE.avtalSub||"avtal", pane=paneEl(sub); if(!pane) return;
    pane.style.display="";
    mount.appendChild(pane);
    syncAvtalCompany(sub);
  }
  // Panelerna hämtar bara när kunden faktiskt bytts (eller första gången).
  var _avtalFor={avtal:null, signeringar:null};
  function syncAvtalCompany(sub){
    var id=STATE.cardId, nm=(STATE.card && STATE.card.company && STATE.card.company.name) || "";
    if(!id) return;
    if(_avtalFor[sub]===id) return;
    _avtalFor[sub]=id;
    if(sub==="signeringar"){
      if(FKAVTAL.sign){ FKAVTAL.sign.setCompany(id, nm); FKAVTAL.sign.reload(); }
    } else {
      if(FKAVTAL.ab){ FKAVTAL.ab.setCompany(id, nm); FKAVTAL.ab.clear(); FKAVTAL.ab.reload(); }
      if(FKAVTAL.wiz) FKAVTAL.wiz.setCompany(id, nm);
    }
  }
  function resetAvtalPanes(){ _avtalFor.avtal=null; _avtalFor.signeringar=null; }

  function renderCard(){
    stashPanes();`, "fl: mount-helpers");

// Mount efter att cardview fått nytt innehåll
FL = rep(FL, `    $("cardview").innerHTML='<button class="fk-back" data-fk="back">← Företagslistan</button>'+
      '<div class="fk-card">'+cardHero()+cardTabs()+cardBody()+'</div>';`,
  `    $("cardview").innerHTML='<button class="fk-back" data-fk="back">← Företagslistan</button>'+
      '<div class="fk-card">'+cardHero()+cardTabs()+cardBody()+'</div>';
    mountPanes();   // PORTAT 2026-08-17`, "fl: mount-anrop");

// Byte av företag → panelerna måste hämta om
FL = rep(FL, `    $("cardview").style.display="none"; $("cardview").innerHTML=""; $("listview").style.display="";`,
  `    stashPanes(); resetAvtalPanes();   // PORTAT 2026-08-17: rädda panelerna före wipe
    $("cardview").style.display="none"; $("cardview").innerHTML=""; $("listview").style.display="";`, "fl: closeCard");

// ── 7. Splitsa in modulerna i slutet av kortets IIFE ───────────────────────
const tail = FL.lastIndexOf("})();");
if (tail < 0) throw new Error("hittade inte kort-IIFE:ns slut");
const modules = `
  // ══════════════════════════════════════════════════════════════════════════
  // PORTAT 2026-08-17 — Avtal-fliken: abonnemang + mall-wizard + PDF-import
  // (ur mira-abonnemang-kund.html) samt signeringar (ur mira-approval-create.html).
  // Modulerna ligger INNE i kortets IIFE så de ser root/FLROOT/FKAVTAL utan
  // window-globaler (undviker multiblock-krock). Varje modul har sin egen IIFE
  // → deras lokala $/esc/cfg skuggar kortets utan konflikt. Bootstrap-raderna
  // (claim + data-mira-config + auto-init) är omskrivna; allt annat är verbatim.
  //
  // Monterades EN gång av merge_avtal.mjs (ligger i repot för spårbarhet).
  // Denna fil är nu källan — redigera HÄR, inte i skriptet. Skriptet är inte
  // idempotent: en andra körning failar på sina assertions i st.f. att dubblera.
  // Ändras källblocken (mira-abonnemang-kund.html / mira-approval-create.html)
  // slår det INTE igenom hit automatiskt.
  // ══════════════════════════════════════════════════════════════════════════
${abMod}

${wzMod}

${glJs}

${acMod}

`;
FL = FL.slice(0, tail) + modules + FL.slice(tail);

// ── 8. Sanity ──────────────────────────────────────────────────────────────
if (/\?\./.test(FL.replace(/^\s*(\/\/|\*).*$/gm, ""))) console.warn("VARNING: ?. i koden (Bubbles parser)");
const out = process.argv.includes("--dry") ? `${DIR}/.merged.html` : `${DIR}/mira-foretag-lista.html`;
fs.writeFileSync(out, FL);
console.log(`✅ ${steps} omskrivningar + ${scoped} CSS-selektorer scopade → ${out}`);
console.log(`   ${(FL.length / 1024).toFixed(0)} kB, ${FL.split("\n").length} rader`);
