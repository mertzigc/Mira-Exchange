// Smoke: designblock (content_blocks) i kommunikationsmodulen.
//   node komm_blocks_smoke.mjs
//
// Tre lager testas mot RIKTIG källkod:
//   1. content_blocks.js importeras direkt (normalisering + båda renderarna).
//   2. emailer.js `blocksHtmlFor` klipps ut ur källan (index/emailer är för
//      sidoeffektsfyllda för att importeras) — samma teknik som cc_cache_smoke.mjs.
//   3. index.js `_verifyBlocksSaved` + /admin/blocks/preview klipps ut likadant.
// Dessutom vaktas att admin-HTML:ens blocktyper är EXAKT samma mängd som
// BLOCK_TYPES — en typ som bara finns i UI:t droppas tyst av normBlocks och
// innehållet försvinner utan felmeddelande.
import fs from "node:fs";
import { normBlocks, renderBlocksEmail, renderBlocksWeb, BLOCK_TYPES, safeUrl, videoEmbedSrc, BLOCK_CSS } from "./content_blocks.js";

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

// ── Källkodsutklipp (samma mönster som cc_cache_smoke.mjs) ──────────────────
// Kastar ALDRIG. Ett utklipp som inte hittas ska bli ett rött kryss, inte en krasch
// som avbryter resten av sviten — annars blir mutationstestet (git stash → koden
// borta) tyst värdelöst i stället för att peka ut exakt vad som saknas.
function slice(src, startNeedle, endNeedle, label) {
  const a = src.indexOf(startNeedle);
  const b = a < 0 ? -1 : src.indexOf(endNeedle, a);
  if (a < 0 || b < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${startNeedle}"`); return ""; }
  return src.slice(a, b + endNeedle.length);
}
// Kör en grupp assertions; en oväntad exception blir ETT rött kryss i stället för
// att fälla hela körningen.
async function group(label, fn) {
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ [${label} kraschade] ${e && e.message}`); }
}
const EMAILER_SRC = fs.readFileSync(new URL("./emailer.js", import.meta.url), "utf8");
const INDEX_SRC   = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const ADMIN_SRC   = fs.readFileSync(new URL("./mira-kommunikation-admin.html", import.meta.url), "utf8");

const run = async () => {

  // ══════════════════════════════════════════════════════════════════════════
  sec("Normalisering");
  // ══════════════════════════════════════════════════════════════════════════
  ok("11 blocktyper i whitelisten", BLOCK_TYPES.length === 11);
  ok("okänd typ droppas", normBlocks([{ type: "iframe_evil", body: "x" }]).length === 0);
  ok("icke-array → []", normBlocks("inte json").length === 0 && normBlocks(null).length === 0 && normBlocks({}).length === 0);
  ok("JSON-sträng accepteras (så lagrat Bubble-textfält kan läsas rakt av)",
     normBlocks('[{"type":"quote","quote":"Hej"}]').length === 1);

  ok("text utan innehåll droppas", normBlocks([{ type: "text", heading: "", body: "" }]).length === 0);
  ok("heading utan text droppas", normBlocks([{ type: "heading", heading: "  " }]).length === 0);
  ok("cta utan länk droppas", normBlocks([{ type: "cta", label: "Klicka" }]).length === 0);
  ok("cta utan text droppas", normBlocks([{ type: "cta", url: "https://x.se" }]).length === 0);
  ok("image utan bild droppas", normBlocks([{ type: "image", caption: "bara text" }]).length === 0);
  ok("divider behålls utan fält", normBlocks([{ type: "divider" }]).length === 1);
  ok("video med icke-stödd länk droppas", normBlocks([{ type: "video", url: "https://tiktok.com/x" }]).length === 0);
  ok("video med youtu.be behålls", normBlocks([{ type: "video", url: "https://youtu.be/abc123" }]).length === 1);
  ok("image_left utan bild MEN med text behålls (renderas enkolumns)",
     normBlocks([{ type: "image_left", body: "text" }]).length === 1);

  // Gallery
  const gal = normBlocks([{ type: "gallery3", images: ["https://x/1.jpg", { url: "https://x/2.jpg", caption: "C" }, { url: "" }, "https://x/4.jpg"] }]);
  ok("gallery3 kapar till 3 slots och filtrerar tomma", gal[0].images.length === 2);
  ok("gallery3 accepterar både sträng och objekt", gal[0].images[0].url === "https://x/1.jpg" && gal[0].images[1].caption === "C");
  ok("gallery3 helt utan giltiga bilder droppas", normBlocks([{ type: "gallery3", images: ["", null] }]).length === 0);

  // Lista
  const li = normBlocks([{ type: "list", items: " a \n\n b \nc\n" }]);
  ok("list: sträng splittas per rad, tomma bort", li[0].items.length === 3 && li[0].items[0] === "a");
  ok("list: array funkar också", normBlocks([{ type: "list", items: ["x", " ", "y"] }])[0].items.length === 2);
  ok("list utan punkter droppas", normBlocks([{ type: "list", heading: "Bara rubrik" }]).length === 0);

  // Kapning + tak
  ok("body kapas till 6000 tecken", normBlocks([{ type: "text", body: "x".repeat(9000) }])[0].body.length === 6000);
  ok("max 60 block", normBlocks(Array.from({ length: 80 }, () => ({ type: "divider" }))).length === 60);
  ok("id sätts om det saknas", !!normBlocks([{ type: "divider" }])[0].id);
  ok("ordning bevaras", normBlocks([{ type: "heading", heading: "A" }, { type: "divider" }, { type: "quote", quote: "Q" }])
     .map(b => b.type).join(",") === "heading,divider,quote");

  // ══════════════════════════════════════════════════════════════════════════
  sec("URL-vitlista + escaping (går ut i mejl till externa mottagare)");
  // ══════════════════════════════════════════════════════════════════════════
  ok("javascript: blockeras", safeUrl("javascript:alert(1)") === "");
  ok("data: blockeras", safeUrl("data:text/html,<script>") === "");
  ok("vbscript: blockeras", safeUrl("vbscript:msgbox") === "");
  ok("protokoll-relativ // → https:", safeUrl("//cdn.x/a.jpg") === "https://cdn.x/a.jpg");
  ok("mailto: släpps igenom", safeUrl("mailto:a@b.se") === "mailto:a@b.se");
  ok("https släpps igenom", safeUrl(" https://x.se/a.jpg ") === "https://x.se/a.jpg");

  const evil = [
    { type: "text", heading: '</h2><script>alert(1)</script>', body: '<img src=x onerror=alert(2)>' },
    { type: "image", image: "javascript:alert(3)", caption: "x" },
    { type: "image_left", image: "https://x/a.jpg", body: "b", link_url: "javascript:alert(4)", link_label: "Klicka" },
    { type: "quote", quote: 'Han sa "hej" & gick <b>' }
  ];
  const evilNorm = normBlocks(evil);
  ok("image med javascript:-URL droppas helt (bilden var enda innehållet)",
     !evilNorm.some(b => b.type === "image"));
  ok("link_url med javascript: nollas men blocket lever", evilNorm.find(b => b.type === "image_left").link_url === "");
  const evilMail = renderBlocksEmail(evil, "#df6f39"), evilWeb = renderBlocksWeb(evil);
  ok("ingen <script> i mejl-HTML", !/<script/i.test(evilMail));
  ok("ingen <script> i webb-HTML", !/<script/i.test(evilWeb));
  ok("ingen javascript: i någon rendering", !/javascript:/i.test(evilMail) && !/javascript:/i.test(evilWeb));
  // "onerror" får finnas som SYNLIG text — det som räknas är att det inte sitter
  // i en tagg. Escapad text är inert; en assertion på blotta ordet vore falsk trygghet.
  ok("onerror sitter aldrig i en tagg (bara som escapad text)",
     !/<[^>]*onerror/i.test(evilMail) && !/<[^>]*onerror/i.test(evilWeb)
     && evilMail.includes("&lt;img src=x onerror"));
  ok("& escapas (Fröberg & Lundholm-buggen)", evilMail.includes("&amp;") && evilWeb.includes("&amp;"));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Rendering — mejl");
  // ══════════════════════════════════════════════════════════════════════════
  ok("tomma block → tom sträng (anropare kan konkatenera rakt av)",
     renderBlocksEmail([], "#df6f39") === "" && renderBlocksEmail(null) === "");

  const ACCENT = "#123456";
  const full = [
    { type: "heading", heading: "Om oss" },
    { type: "text", heading: "Rubrik", body: "Stycke ett.\n\nStycke två." },
    { type: "image_left", image: "https://x/a.jpg", heading: "H", body: "B", link_url: "https://x.se", link_label: "Läs mer" },
    { type: "image_right", image: "https://x/b.jpg", body: "B2" },
    { type: "gallery3", images: ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"] },
    { type: "image", image: "https://x/hero.jpg", caption: "Bildtext" },
    { type: "quote", quote: "Ett citat", source: "Christian" },
    { type: "cta", label: "Anmäl dig", url: "https://x.se/anmal" },
    { type: "list", heading: "Tre saker", items: ["ett", "två", "tre"] },
    { type: "divider" },
    { type: "video", url: "https://vimeo.com/12345", caption: "Filmen" }
  ];
  ok("alla 11 typer överlever normaliseringen", normBlocks(full).length === 11);
  const mail = renderBlocksEmail(full, ACCENT);
  ok("mejl: accentfärgen används", mail.includes(ACCENT));
  ok("mejl: bara tabeller/divar — inga moderna layout-props som klienter struntar i",
     !/display:\s*(grid|flex)/i.test(mail));
  ok("mejl: MSO-ghost-tabeller för Outlook i tvåkolumnsblock", mail.includes("<!--[if mso]>"));
  ok("mejl: inline-block + max-width så kolumnerna staplar på mobil",
     /display:inline-block;vertical-align:top;width:100%;max-width:252px/.test(mail));
  ok("mejl: dubbel radbrytning blir två stycken", (mail.match(/Stycke ett\./g) || []).length === 1 && mail.includes("Stycke två."));
  ok("mejl: gallery3 ger tre 160px-kolumner", (mail.match(/max-width:160px/g) || []).length === 3);
  ok("mejl: image_left lägger bilden FÖRE texten", mail.indexOf('https://x/a.jpg') < mail.indexOf('>H<'));
  ok("mejl: image_right lägger texten FÖRE bilden", mail.indexOf('B2') < mail.indexOf('https://x/b.jpg'));
  ok("mejl: video blir klickbar länk (iframes körs inte i mejl)",
     !/<iframe/i.test(mail) && mail.includes('href="https://vimeo.com/12345"'));
  ok("mejl: CTA-knapp med länk", mail.includes('href="https://x.se/anmal"') && mail.includes("Anmäl dig"));
  ok("mejl: listan blir <ul><li>", mail.includes("<li") && mail.includes("två"));
  ok("mejl: citatets källa med em-dash", mail.includes("&mdash; Christian"));

  // Video med omslagsbild → bild i stället för textlänk
  const vidPoster = renderBlocksEmail([{ type: "video", url: "https://youtu.be/abc123", poster: "https://x/p.jpg" }], ACCENT);
  ok("mejl: video med omslagsbild renderar bilden inuti länken",
     vidPoster.includes("https://x/p.jpg") && vidPoster.includes('href="https://youtu.be/abc123"'));

  // image_left utan bild → enkolumns, ingen tom halva
  const noImg = renderBlocksEmail([{ type: "image_left", heading: "H", body: "B" }], ACCENT);
  ok("mejl: image_left utan bild ger INGEN tom kolumn", !noImg.includes("<!--[if mso]>"));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Rendering — webb (landningssidor + admin-preview)");
  // ══════════════════════════════════════════════════════════════════════════
  const web = renderBlocksWeb(full);
  ok("webb: tom in → tom ut", renderBlocksWeb([]) === "");
  ok("webb: yttre wrapper", web.startsWith('<div class="mb-blocks">'));
  ok("webb: en klass per blocktyp", BLOCK_TYPES.filter(t => t !== "text").every(t => web.includes("mb-" + t.replace(/_/g, "-"))));
  ok("webb: split-layout på bild/text-blocken", web.includes("mb-split"));
  ok("webb: video blir iframe-embed (till skillnad från mejlet)",
     /<iframe src="https:\/\/player\.vimeo\.com\/video\/12345"/.test(web));
  ok("webb: youtube-länk → embed-URL", renderBlocksWeb([{ type: "video", url: "https://youtu.be/abc123" }]).includes("youtube.com/embed/abc123"));
  ok("webb: externa länkar får rel=noopener", web.includes('rel="noopener noreferrer"'));
  ok("webb: inga inline style-attribut (allt via BLOCK_CSS)", !/ style="/.test(web));
  ok("BLOCK_CSS har media query för stapling på mobil", BLOCK_CSS.includes("@media (max-width:640px)"));
  ok("BLOCK_CSS hänger på --accent med fallback", BLOCK_CSS.includes("var(--accent,#df6f39)"));
  ok("videoEmbedSrc avvisar okänd värd", videoEmbedSrc("https://example.com/film.mp4") === "");

  // ══════════════════════════════════════════════════════════════════════════
  sec("emailer.js — blocksHtmlFor (hämta vid sändning, fail-loud)");
  // ══════════════════════════════════════════════════════════════════════════
  await group("emailer blocksHtmlFor", async () => {
  const blocksFnSrc = slice(EMAILER_SRC, "const _BLOCKS_TTL =", "\n}\n", "blocksHtmlFor");
  let getCalls = [], INV = {};
  const makeBlocksFn = () => {
    getCalls = [];
    const factory = new Function("_bubbleGet", "normBlocks", "renderBlocksEmail", `
      ${blocksFnSrc}
      return { blocksHtmlFor, cache: _blocksCache };
    `);
    return factory(
      async (type, id) => { getCalls.push({ type, id }); if (!(id in INV)) throw new Error("not found"); return INV[id]; },
      normBlocks, renderBlocksEmail
    );
  };

  INV = { inv1: { content_blocks: JSON.stringify([{ type: "quote", quote: "Hej" }, { type: "divider" }]) } };
  let E = makeBlocksFn();
  const h1 = await E.blocksHtmlFor({ invitation_id: "inv1", blocks_count: 2 }, "#df6f39");
  ok("renderar blocken från Invitation", h1.includes("Hej") && getCalls.length === 1);
  ok("hämtar rätt typ", getCalls[0].type === "Invitation" && getCalls[0].id === "inv1");

  const h2 = await E.blocksHtmlFor({ invitation_id: "inv1", blocks_count: 2 }, "#df6f39");
  ok("andra anropet går på cachen — noll extra Bubble-läsningar", h2 === h1 && getCalls.length === 1);

  ok("blocks_count=0 → tom sträng utan Bubble-anrop",
     (await E.blocksHtmlFor({ invitation_id: "inv1", blocks_count: 0 }, "#df6f39")) === "" && getCalls.length === 1);
  ok("saknad blocks_count (gamla köade rader) → tom sträng, ingen krasch",
     (await E.blocksHtmlFor({}, "#df6f39")) === "" && getCalls.length === 1);

  // FAIL-LOUD: antalet stämmer inte → kasta, inte skicka urholkat utskick
  E = makeBlocksFn();
  INV = { inv1: { content_blocks: JSON.stringify([{ type: "quote", quote: "Hej" }]) } };
  let threw = null;
  try { await E.blocksHtmlFor({ invitation_id: "inv1", blocks_count: 5 }, "#df6f39"); } catch (e) { threw = e; }
  ok("fel antal block → kastar (utskicket får error_message i stället för att gå ut tomt)",
     !!threw && /förväntade 5 block/.test(threw.message));

  // content_blocks-fältet saknas helt i Bubble → 0 block, samma fail-loud
  E = makeBlocksFn();
  INV = { inv1: { title: "Utan fältet" } };
  threw = null;
  try { await E.blocksHtmlFor({ invitation_id: "inv1", blocks_count: 3 }, "#df6f39"); } catch (e) { threw = e; }
  ok("content_blocks-fältet saknas → kastar med läsbar orsak",
     !!threw && /fältet content_blocks saknas/.test(threw.message));

  E = makeBlocksFn();
  threw = null;
  try { await E.blocksHtmlFor({ blocks_count: 2 }, "#df6f39"); } catch (e) { threw = e; }
  ok("blocks_count utan invitation_id → kastar", !!threw && /invitation_id saknas/.test(threw.message));

  E = makeBlocksFn(); INV = {};
  threw = null;
  try { await E.blocksHtmlFor({ invitation_id: "borta", blocks_count: 1 }, "#df6f39"); } catch (e) { threw = e; }
  ok("Bubble-fel vid hämtning → kastar (sväljs inte)", !!threw && /kunde inte hämta Invitation/.test(threw.message));

  // Underkänt svar får inte cachas — annars fastnar felet till TTL:n går ut
  E = makeBlocksFn();
  INV = { inv1: { content_blocks: "[]" } };
  try { await E.blocksHtmlFor({ invitation_id: "inv1", blocks_count: 1 }, "#df6f39"); } catch (_) {}
  INV = { inv1: { content_blocks: JSON.stringify([{ type: "divider" }]) } };
  const recovered = await E.blocksHtmlFor({ invitation_id: "inv1", blocks_count: 1 }, "#df6f39");
  ok("underkänt svar cachas INTE — nästa försök läser om och lyckas", recovered.length > 0 && getCalls.length === 2);
  });

  // ══════════════════════════════════════════════════════════════════════════
  sec("emailer.js — mallarna kallar renderaren");
  // ══════════════════════════════════════════════════════════════════════════
  for (const [tmpl, label] of [["tmplInviteInvitation", "inbjudan"], ["tmplNewsAnnouncement", "nyhetsutskick"], ["tmplSurveyInvitation", "undersökning"]]) {
    const body = slice(EMAILER_SRC, `async function ${tmpl}(`, "\n}\n", tmpl);
    ok(`${label}: hämtar blocken`, /await blocksHtmlFor\(x, accent\)/.test(body));
    ok(`${label}: lägger in dem i body`, /\+ blocks/.test(body));
  }

  // ══════════════════════════════════════════════════════════════════════════
  sec("index.js — _verifyBlocksSaved (tyst bortdroppat fält fångas)");
  // ══════════════════════════════════════════════════════════════════════════
  await group("_verifyBlocksSaved", async () => {
  const verifySrc = slice(INDEX_SRC, "async function _verifyBlocksSaved(", "\n}", "_verifyBlocksSaved");
  let ROW = null, getErr = false;
  const V = new Function("bubbleGet", "ADM_INVITATION", "_normBlocks", "console", `
    ${verifySrc}
    return _verifyBlocksSaved;
  `)(async () => { if (getErr) throw new Error("bubble nere"); return ROW; }, "Invitation", normBlocks, { warn() {} });

  ROW = { content_blocks: JSON.stringify([{ type: "divider" }, { type: "divider" }]) };
  ok("rätt antal sparat → true", (await V("i1", 2)) === true);
  ROW = { title: "utan fältet" };
  ok("fältet saknas i Bubble → false (safeCreat­es tysta drop fångas)", (await V("i1", 2)) === false);
  ROW = { content_blocks: JSON.stringify([{ type: "divider" }]) };
  ok("fel antal → false", (await V("i1", 2)) === false);
  ok("inga block skickade → null (inget att verifiera)", (await V("i1", 0)) === null);
  ok("inget id → null", (await V("", 2)) === null);
  getErr = true;
  ok("Bubble-fel vid verifiering → null, INTE false (okänt ≠ saknat fält)", (await V("i1", 2)) === null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  sec("index.js — endpoints bär content_blocks");
  // ══════════════════════════════════════════════════════════════════════════
  const createEp = slice(INDEX_SRC, 'app.post("/admin/invite/create"', "\n});", "create");
  ok("create skriver content_blocks normaliserat", /content_blocks:\s*JSON\.stringify\(_normBlocks\(d\.content_blocks\)\)/.test(createEp));
  ok("create svarar blocks_saved", /blocks_saved:\s*blocksSaved/.test(createEp));
  ok("create flaggar content_blocks_field_missing", createEp.includes("content_blocks_field_missing"));

  const updateEp = slice(INDEX_SRC, 'app.patch("/admin/invite/update"', "\n});", "update");
  ok("update mappar content_blocks", /content_blocks:\s*v\s*=>\s*JSON\.stringify\(_normBlocks\(v\)\)/.test(updateEp));
  ok("update verifierar BARA när fältet skickats (annars null)", /b\.content_blocks === undefined\s*\n?\s*\?\s*null/.test(updateEp));

  const getEp = slice(INDEX_SRC, 'app.get("/admin/invite/:id"', "\n});", "get");
  ok("GET returnerar normaliserad array (byggaren kan ladda direkt)", /content_blocks:\s*_normBlocks\(i\.content_blocks\)/.test(getEp));

  const cfgFn = slice(INDEX_SRC, "function inviteConfigPayload(", "\n}", "config");
  ok("config levererar färdig blocks_html", /blocks_html:\s*_renderBlocksWeb\(inv\.content_blocks\)/.test(cfgFn));
  ok("config levererar blocks_css", /blocks_css:\s*_BLOCK_CSS/.test(cfgFn));

  const sendEp = slice(INDEX_SRC, 'app.post("/admin/invite/:id/send"', "\n});", "send");
  ok("send skickar invitation_id + blocks_count", /invitation_id:\s*invId/.test(sendEp) && /blocks_count:\s*_normBlocks\(inv\.content_blocks\)\.length/.test(sendEp));
  ok("send bakar INTE in blocken per mottagare (EmailQueue-uppsvälln.)", !/content_blocks:/.test(sendEp));

  const prevEp = slice(INDEX_SRC, 'app.post("/admin/blocks/preview"', "\n});", "preview");
  ok("preview returnerar html + css + count", /html:\s*_renderBlocksWeb/.test(prevEp) && /css:\s*_BLOCK_CSS/.test(prevEp) && /count:\s*blocks\.length/.test(prevEp));
  ok("preview rör ingen data (inga bubble-anrop)", !/bubble/i.test(prevEp));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Admin-HTML — byggaren matchar backend");
  // ══════════════════════════════════════════════════════════════════════════
  const bbBlock = slice(ADMIN_SRC, "var BB_TYPES = [", "\n  ];", "BB_TYPES");
  const uiTypes = [...bbBlock.matchAll(/\{\s*v:'([a-z0-9_]+)'/g)].map(m => m[1]);
  ok("byggaren erbjuder alla 11 typer", uiTypes.length === 11);
  ok("inga UI-typer saknas i backend (annars droppas de TYST)",
     uiTypes.every(t => BLOCK_TYPES.includes(t)));
  ok("inga backend-typer saknas i UI:t", BLOCK_TYPES.every(t => uiTypes.includes(t)));

  for (const p of ["iv", "nv", "sv"]) {
    ok(`${p}: byggaren monterad`, ADMIN_SRC.includes(`attachBlockBuilder('${p}')`));
    ok(`${p}: markup finns`, ADMIN_SRC.includes(`id="${p}-blocks"`) && ADMIN_SRC.includes(`id="${p}-b-add"`));
    ok(`${p}: sparar blocken`, new RegExp(`content_blocks:\\s*bbGet\\('${p}'\\)`).test(ADMIN_SRC));
    ok(`${p}: laddar vid redigering`, ADMIN_SRC.includes(`bbSet('${p}', inv.content_blocks)`));
    ok(`${p}: nollar vid ny`, ADMIN_SRC.includes(`bbSet('${p}', [])`));
    ok(`${p}: varnar när Bubble-fältet saknas`, ADMIN_SRC.includes(`bbWarnIfMissing('${p}', j)`));
  }
  ok("Arkiv-knappen är delegerad (blockens fält renderas dynamiskt)",
     /document\.addEventListener\('click', function\(e\)\{\s*\n?\s*var btn=e\.target\.closest && e\.target\.closest\('\.ck-media-btn'\)/.test(ADMIN_SRC));
  ok("arkivet dispatchar input-event så blockmodellen uppdateras",
     ADMIN_SRC.includes("dispatchEvent(new Event('input'"));
  ok("förhandsgranskningen är debouncad (inte ett anrop per tangenttryck)",
     /BB_PREV_TIMER\[p\]=setTimeout/.test(ADMIN_SRC));
  ok("fältändring re-renderar INTE (fokus/markör bevaras vid inmatning)",
     !/data-bb-f[\s\S]{0,400}bbRender\(p\)/.test(slice(ADMIN_SRC, "box.querySelectorAll('[data-bb-f]')", "});", "fältbindning")));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Landningssidor");
  // ══════════════════════════════════════════════════════════════════════════
  const INVITE_SRC = fs.readFileSync(new URL("./invite.html", import.meta.url), "utf8");
  const SURVEY_SRC = fs.readFileSync(new URL("./mira-undersokning.html", import.meta.url), "utf8");
  ok("invite.html injicerar blocks_html", INVITE_SRC.includes('$("mp-blocks").innerHTML = html'));
  ok("invite.html injicerar blocks_css en gång", INVITE_SRC.includes('getElementById("mp-blocks-css")'));
  ok("invite.html anropar renderBlocks i render()", INVITE_SRC.includes("renderBlocks(CFG);"));
  ok("undersökningssidan injicerar blocks_html", SURVEY_SRC.includes("if (cfg.blocks_html) { html += cfg.blocks_html; }"));
  ok("undersökningssidan injicerar blocks_css", SURVEY_SRC.includes("injectBlocksCss(cfg.blocks_css)"));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
