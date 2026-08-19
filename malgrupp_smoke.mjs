// Smoke: målgrupp per kundansvarig + mass-sättning av Region utifrån Kundansvarig.
//   node malgrupp_smoke.mjs
//
// Två lager:
//   1. `companies_api.js` importeras via DI (region-bulk-endpointen).
//   2. `index.js` klipps ut ur källan (`_buildCcMap`/`_ccOwnerId` + /admin/audience/owners)
//      — samma teknik som cc_cache_smoke.mjs, index.js är för sidoeffektsfylld att importera.
// Plus vaktar att admin-HTML:en faktiskt skickar `owners` och läser kundansvarig-listan.
import fs from "node:fs";
import { registerCompaniesRoutes } from "./companies_api.js";

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const sec = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
// En grupp som kraschar ska bli ETT rött kryss, inte fälla hela körningen — annars
// blir mutationstestet (git stash → koden borta) tyst värdelöst.
async function group(label, fn) {
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ [${label} kraschade] ${e && e.message}`); }
}

function slice(src, a, b, label) {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i);
  if (i < 0 || j < 0) { fail++; console.log(`  ✗ [utklipp saknas] ${label} — hittade inte "${a}"`); return ""; }
  return src.slice(i, j + b.length);
}
const INDEX_SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const ADMIN_SRC = fs.readFileSync(new URL("./mira-kommunikation-admin.html", import.meta.url), "utf8");

// ── Fixtures ────────────────────────────────────────────────────────────────
// u1 = Andriette (äger cc1 tom region, cc2 redan Öst, cc3 Väst = avvikelse)
// u2 = Bo        (äger cc4 tom region)
// u3 = finns som User men äger inga bolag → ska INTE dyka upp i väljaren
// cc5 saknar kundansvarig helt → räknas som companies_without_owner
const CC = {
  cc1: { _id: "cc1", Name_company: "Acme AB",    Kundansvarig: "u1", Region: "" },
  cc2: { _id: "cc2", Name_company: "Beta Bygg",  Kundansvarig: "u1", Region: "Öst" },
  cc3: { _id: "cc3", Name_company: "Zeta Zoo",   Kundansvarig: "u1", Region: "Väst" },
  cc4: { _id: "cc4", Name_company: "Delta Data", Kundansvarig: "u2", Region: "" },
  cc5: { _id: "cc5", Name_company: "Utan ägare", Kundansvarig: null, Region: "" },
};
const USERS = [
  { _id: "u1", "First Name": "Andriette", Surname: "A", email: "andriette@carotte.se" },
  { _id: "u2", "First Name": "Bo", Surname: "Berg", authentication: { email: { email: "BO@carotte.se" } } },  // mejl på auth-objektet + versaler
  { _id: "u3", "First Name": "Utan", Surname: "Kunder", email: "utan@carotte.se" },
];
const project = (c) => ({ id: c._id, name: c.Name_company || "", region: String(c.Region || ""), ansvarig_id: c.Kundansvarig || null });
const mkFull = () => new Map(Object.values(CC).map((c) => [c._id, project(c)]));

let patched = [];
function mk() {
  const routes = { get: {}, post: {}, patch: {}, delete: {}, options: {} };
  const last = (a) => a[a.length - 1];
  const w = (m) => (p, ...a) => { routes[m][p] = last(a); };
  return { app: { get: w("get"), post: w("post"), patch: w("patch"), delete: w("delete"), options: w("options") }, routes };
}
function call(routes, method, path, { query = {}, params = {}, body = {} } = {}) {
  const h = routes[method][path]; if (!h) throw new Error("no route " + method + " " + path);
  return new Promise((r) => {
    const res = { _c: 200, status(c) { this._c = c; return this; }, json(o) { r({ code: this._c, body: o }); }, sendStatus(c) { r({ code: c, body: null }); } };
    h({ params, query, body, headers: {} }, res);
  });
}
let patchFailIds = new Set();
const deps = {
  bubbleId: (r) => (r ? r._id : null),
  bubbleFindAll: async (t) => (t === "User" ? USERS : (t === "ClientCompany" ? Object.values(CC) : [])),
  bubbleFind: async (t) => (t === "User" ? USERS : []),
  bubbleCount: async () => 0,
  bubbleGet: async (t, id) => (t === "ClientCompany" ? CC[id] || null : null),
  bubblePatch: async (t, id, payload) => {
    if (patchFailIds.has(id)) throw new Error("Bubble 400: nekade");
    patched.push({ t, id, payload });
    if (t === "ClientCompany" && CC[id]) Object.assign(CC[id], payload);
    return {};
  },
  bubbleCreate: async () => "new1",
  bubbleDelete: async () => ({}),
  companyFullMap: async () => mkFull(),
  companyRevenueMap: async () => new Map(),
  companyRevenueMapWarm: () => new Map(),
  companyTouchMapWarm: () => new Map(),
  companyPatchEntry: () => {},
  planningAuthed: () => true,
  planningCors: () => {},
};

const run = async () => {
  const s = mk();
  const api = registerCompaniesRoutes(s.app, deps);

  // ══════════════════════════════════════════════════════════════════════════
  sec("userDirectory (delas med kommunikationsmodulen)");
  // ══════════════════════════════════════════════════════════════════════════
  await group("userDirectory", async () => {
    const dir = await api.userDirectory();
    ok("returneras från registerCompaniesRoutes", Array.isArray(dir) && dir.length === 3);
    ok("bär e-post", (dir.find((u) => u.id === "u1") || {}).email === "andriette@carotte.se");
    ok("läser mejl som ligger på authentication-objektet", (dir.find((u) => u.id === "u2") || {}).email === "bo@carotte.se");
    ok("normaliserar till gemener", dir.every((u) => u.email === u.email.toLowerCase()));
  });

  // ══════════════════════════════════════════════════════════════════════════
  sec("region-bulk — torrkörning");
  // ══════════════════════════════════════════════════════════════════════════
  const MAP = { "andriette@carotte.se": "Öst", "BO@carotte.se": "Väst" };
  await group("region-bulk", async () => {
  let d = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: MAP } });
  ok("torrkörning är default (inget dry_run i bodyn)", d.body.ok && d.body.dry_run === true);
  ok("ingenting skrevs", patched.length === 0);
  const a = d.body.owners.find((o) => o.email === "andriette@carotte.se");
  ok("Andriette: 3 bolag", a.companies === 3);
  ok("Andriette: 1 skulle sättas (tom region)", a.would_set === 1);
  ok("Andriette: 1 redan rätt", a.already_correct === 1);
  ok("Andriette: 1 avvikelse (Väst ≠ Öst)", a.conflicts === 1);
  ok("avvikelsen namnges med sitt nuvarande värde", a.conflict_examples[0] === "Zeta Zoo (Väst)");
  ok("de som skulle ändras namnges", a.would_set_examples[0] === "Acme AB");
  ok("versaler i mejlet matchar ändå rätt user", !!d.body.owners.find((o) => o.name.startsWith("Bo")));
  ok("totals.would_set = 2 (cc1 + cc4)", d.body.totals.would_set === 2);
  ok("totals räknar bolag utan ansvarig", d.body.totals.companies_without_owner === 1);
  ok("sorterat med flest ändringar först", d.body.owners[0].would_set >= d.body.owners[1].would_set);
  ok("known_regions härleds ur datan", JSON.stringify(d.body.known_regions) === JSON.stringify(["Väst", "Öst"]));

  // ══════════════════════════════════════════════════════════════════════════
  sec("region-bulk — skyddsräcken");
  // ══════════════════════════════════════════════════════════════════════════
  let bad = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: { "andriette@carotte.se": "Sydost" } } });
  ok("okänt regionvärde → 400 (vi gissar aldrig option-set-värden)", bad.code === 400 && bad.body.error === "unknown_region_value");
  ok("felet listar vad som faktiskt finns", JSON.stringify(bad.body.known_regions) === JSON.stringify(["Väst", "Öst"]));
  ok("felet säger vad man gör åt det", /force:true/.test(bad.body.hint));
  ok("okänt värde skrev ingenting", patched.length === 0);

  let forced = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: { "andriette@carotte.se": "Sydost" }, force: true } });
  ok("force:true släpper igenom nytt regionvärde", forced.body.ok && forced.body.unknown_regions[0] === "Sydost");

  let unk = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: { "finnsej@carotte.se": "Öst", "andriette@carotte.se": "Öst" } } });
  ok("okänd e-post rapporteras (felstavning ser annars ut som 0 bolag)", unk.body.unknown_emails[0] === "finnsej@carotte.se");
  ok("övriga i mappningen körs ändå", unk.body.owners.length === 1);

  let none = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: { "finnsej@carotte.se": "Öst" } } });
  ok("bara okända mejl → 400 no_matching_users", none.code === 400 && none.body.error === "no_matching_users");
  let empty = await call(s.routes, "post", "/admin/companies/region-bulk", { body: {} });
  ok("tom mappning → 400 empty_mapping", empty.code === 400 && empty.body.error === "empty_mapping");
  let halv = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: { "andriette@carotte.se": "" } } });
  ok("mejl utan region ignoreras → 400 empty_mapping", halv.code === 400);

  // Array-formen ska funka lika bra som objektformen
  let arr = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: [{ email: "andriette@carotte.se", region: "Öst" }] } });
  ok("mapping som array fungerar", arr.body.ok && arr.body.owners[0].would_set === 1);

  // ══════════════════════════════════════════════════════════════════════════
  sec("region-bulk — skarp körning (fyller BARA tomma)");
  // ══════════════════════════════════════════════════════════════════════════
  patched = [];
  let w = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: MAP, dry_run: false } });
  ok("svarar dry_run:false", w.body.ok && w.body.dry_run === false);
  ok("uppdaterade exakt 2", w.body.updated === 2);
  ok("skrev bara Region-fältet", patched.every((p) => JSON.stringify(Object.keys(p.payload)) === '["Region"]'));
  ok("cc1 (tom) fick Öst", CC.cc1.Region === "Öst");
  ok("cc4 (tom) fick Väst", CC.cc4.Region === "Väst");
  ok("cc2 (redan Öst) rördes ALDRIG", !patched.some((p) => p.id === "cc2"));
  ok("cc3 (avvikande Väst) rördes ALDRIG — fyller bara tomma", !patched.some((p) => p.id === "cc3") && CC.cc3.Region === "Väst");
  ok("cc5 (utan ansvarig) rördes ALDRIG", !patched.some((p) => p.id === "cc5") && CC.cc5.Region === "");

  // Omkörning ska vara en no-op (idempotent)
  patched = [];
  let again = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: MAP, dry_run: false } });
  ok("omkörning är en no-op (inget kvar att fylla)", again.body.updated === 0 && patched.length === 0);

  // Fel på enskild rad stoppar inte resten
  CC.cc1.Region = ""; CC.cc4.Region = "";
  patchFailIds = new Set(["cc1"]); patched = [];
  let part = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: MAP, dry_run: false } });
  ok("ett Bubble-fel stoppar inte de andra", part.body.updated === 1);
  ok("den som failade rapporteras med namn", part.body.failed.length === 1 && part.body.failed[0].name === "Acme AB");
  patchFailIds = new Set();

  // limit kapar och redovisar resten
  CC.cc1.Region = ""; CC.cc4.Region = "";
  patched = [];
  let lim = await call(s.routes, "post", "/admin/companies/region-bulk", { body: { mapping: MAP, dry_run: false, limit: 1 } });
  ok("limit kapar antalet skrivningar", lim.body.updated === 1 && patched.length === 1);
  ok("resten redovisas i remaining (ingen tyst avkortning)", lim.body.remaining === 1);
  CC.cc1.Region = ""; CC.cc4.Region = "";
  });

  // ══════════════════════════════════════════════════════════════════════════
  sec("index.js — kundansvarig som målgruppsfilter");
  // ══════════════════════════════════════════════════════════════════════════
  let F = null;
  await group("_buildCcMap-utklipp", () => {
  const ownerSrc = slice(INDEX_SRC, "function _ccOwnerId(c) {", "\n}", "_ccOwnerId");
  const mapSrc = slice(INDEX_SRC, "function _buildCcMap(", "\n  return ccMap;\n}", "_buildCcMap");
  F = new Function("_cacheRows", "ADM_CC", "_ccFastIds", "_admName", `
    ${ownerSrc}
    ${mapSrc}
    return { _buildCcMap, _ccOwnerId };
  `)(() => Object.values(CC).map((c) => Object.assign({}, c, { Fastighet: [] })), "ClientCompany", () => [], (c) => c.Name_company);
  });

  if (!F || !F._buildCcMap) { fail++; console.log("  ✗ _buildCcMap kunde inte laddas ur index.js"); }
  else {
    ok("utan owners-filter → alla bolag", Object.keys(F._buildCcMap({})).length === 5);
    const mine = F._buildCcMap({ owners: ["u1"] });
    ok("owners=[u1] → bara Andriettes 3 bolag", Object.keys(mine).length === 3 && !mine.cc4);
    ok("bolag utan ansvarig faller bort", !mine.cc5);
    const two = F._buildCcMap({ owners: ["u1", "u2"] });
    ok("flera ägare kan kombineras", Object.keys(two).length === 4);
    ok("okänd ägare → tomt (inte allt)", Object.keys(F._buildCcMap({ owners: ["u9"] })).length === 0);
    ok("owners kombineras med region-filtret", Object.keys(F._buildCcMap({ owners: ["u1"], regions: ["Väst"] })).length === 1);
    ok("tom owners-array = inget filter (bakåtkompatibelt)", Object.keys(F._buildCcMap({ owners: [] })).length === 5);
    ok("_ccOwnerId klarar både id-sträng och ref-objekt",
       F._ccOwnerId({ Kundansvarig: "u1" }) === "u1" && F._ccOwnerId({ Kundansvarig: { _id: "u1" } }) === "u1" && F._ccOwnerId({}) === "");
  }

  const ownersEp = slice(INDEX_SRC, 'app.get("/admin/audience/owners"', "\n});", "owners-endpoint");
  ok("owners-endpoint räknar bolag per ansvarig", /counts\.set\(oid, \(counts\.get\(oid\) \|\| 0\) \+ 1\)/.test(ownersEp));
  ok("owners-endpoint lånar companies_api:s cachade User-svep (inget eget helsvep)",
     /_companiesApi\.userDirectory/.test(ownersEp) && !/bubbleFindAll\("User"/.test(ownersEp));
  ok("index.js fångar modulens retur", /const _companiesApi = registerCompaniesRoutes\(app, \{/.test(INDEX_SRC));

  const previewEp = slice(INDEX_SRC, 'app.post("/admin/audience/preview"', "\n});", "preview");
  ok("preview tar emot owners", /owners = Array\.isArray\(req\.body\?\.owners\)/.test(previewEp) && /_buildCcMap\(\{ regions, fastigheter, companyId, owners \}\)/.test(previewEp));
  const buildEp = slice(INDEX_SRC, 'app.post("/admin/invite/:id/guests/build"', "\n});", "build");
  ok("guests/build tar emot owners", /owners = Array\.isArray\(req\.body\?\.owners\)/.test(buildEp));
  ok("guests/build skickar owners vidare till urvalet", /_resolveAudience\(\{ regions, fastigheter, companyId, owners \}\)/.test(buildEp));

  // ══════════════════════════════════════════════════════════════════════════
  sec("Admin-HTML — kundansvarig-väljaren");
  // ══════════════════════════════════════════════════════════════════════════
  ok("hämtar kundansvarig-listan", ADMIN_SRC.includes("/admin/audience/owners"));
  ok("hämtas EN gång och delas av alla tre panelerna (ingen anropsstorm)", ADMIN_SRC.includes("OWNERS_LOADING"));
  ok("skickar owners i build-anropet", /owners:filters\.owners\|\|\[\]/.test(ADMIN_SRC));
  ok("förvalet kommer från Current User's e-post", ADMIN_SRC.includes("ck_current_user_email"));
  ok("bindningen är en data-mira-hidden-input", ADMIN_SRC.includes('data-mira="current_user_email"'));
  ok("saknad bindning gör inget — väljaren funkar ändå", /if\(mine\)\{ var me=OWNERS\.filter/.test(ADMIN_SRC));
  // Verktygen monteras per panel — samma markup, tre prefix.
  for (const p of ["iv", "nv", "sv"]) {
    ok(`${p}: deltagarverktygen monterade`, ADMIN_SRC.includes(`attachAudienceTools({ prefix:'${p}'`));
  }
  ok("markupen renderas per prefix (en mall, tre paneler)",
     ADMIN_SRC.includes(`'-own-sel"`) && ADMIN_SRC.includes(`'-own-btn"`));
  ok("väljaren visar antal bolag per person", ADMIN_SRC.includes("+o.companies+' bolag)'"));
  ok("den inloggades rad märks ut", ADMIN_SRC.includes("— dina kunder"));
  // Inne i deltagarverktygen ska det finnas EXAKT en build-körning — ägar-vägen och
  // segment-vägen delar den. (Målgrupp-panelen har en egen, orörd, längre upp i filen.)
  const audTools = slice(ADMIN_SRC, "function attachAudienceTools(cfg){", "\n  attachAudienceTools({ prefix:'iv'", "attachAudienceTools");
  ok("segment-vägen och ägar-vägen delar EN paginerad körning",
     (audTools.match(/function runBuild\(/g) || []).length === 1
     && (audTools.match(/guests\/build'\)/g) || []).length === 1);

  // ══════════════════════════════════════════════════════════════════════════
  sec("Målgrupp-fliken — ägarfiltret sparas i urvalet");
  // ══════════════════════════════════════════════════════════════════════════
  const segGet = slice(INDEX_SRC, 'app.get("/admin/audience/segments"', "\n});", "segments GET");
  ok("GET returnerar sparade ägare", /owners: _segParse\(s\.owners\)/.test(segGet));

  const segPost = slice(INDEX_SRC, 'app.post("/admin/audience/segments"', "\n});", "segments POST");
  ok("POST normaliserar owners till id-strängar", /const owners = \(Array\.isArray\(b\.owners\) \? b\.owners : \[\]\)\.map\(String\)\.filter\(Boolean\)/.test(segPost));
  ok("POST persisterar owners", /owners:\s+JSON\.stringify\(owners\)/.test(segPost));
  // Samma härdning som `members`: ett urval som tappat ägarfiltret ser sparat ut men
  // ger fel personer i nästa utskick.
  ok("POST läser tillbaka och flaggar owners_field_missing", segPost.includes("owners_field_missing"));
  ok("verifieringen jämför ANTALET, inte bara att fältet finns", /_segParse\(check\.owners\)\.length !== owners\.length/.test(segPost));
  ok("verifieringen körs bara när ägare faktiskt skickats", /if \(members\.length \|\| owners\.length\)/.test(segPost));

  ok("Målgrupp-fliken har en kundansvarig-väljare", ADMIN_SRC.includes('id="audOwnSel"') && ADMIN_SRC.includes('id="audOwnChips"'));
  ok("förhandsgranskningen skickar owners", /body:JSON\.stringify\(\{regions:regions,fastigheter:fastigheter,company:company,owners:owners\}\)/.test(ADMIN_SRC));
  ok("deltagarlistan byggs med SAMMA filter som förhandsgranskningen", /owners:LAST_AUD_OWN/.test(ADMIN_SRC));
  ok("spara urval skickar owners", /company:company,owners:owners\}\)/.test(ADMIN_SRC));
  ok("bara ägarfilter räknas som ett filter (går att spara)", /!regions\.length && !fastigheter\.length && !company && !owners\.length/.test(ADMIN_SRC));
  ok("ladda urval återställer ägarchipsen", /\(seg\.owners\|\|\[\]\)\.forEach/.test(ADMIN_SRC));
  ok("urvalslistan visar antal kundansvariga", /kundansvarig'\+\(s\.owners\.length===1\?'':'a'\)/.test(ADMIN_SRC));
  ok("sparade urval bär med ägarfiltret till deltagarpanelerna", /owners:seg\.owners\|\|\[\]/.test(ADMIN_SRC));
  ok("saknat Bubble-fält ger läsbart fel i UI:t", ADMIN_SRC.includes("textfältet \"owners\" saknas"));

  // ⚠️ Målgrupp-fliken ligger TIDIGARE i filen än deltagarverktygen men registrerar
  // en refresher i samma lista. Deklareras listan längre ned ger var-hoisting
  // `undefined` → TypeError vid sidladdning. Vakta ordningen.
  const declIdx = ADMIN_SRC.indexOf("var _audToolRefreshers = []");
  const firstUse = ADMIN_SRC.indexOf("_audToolRefreshers.push");
  ok("_audToolRefreshers deklareras FÖRE första push", declIdx > 0 && declIdx < firstUse);
  const ownersDecl = ADMIN_SRC.indexOf("var OWNERS = []");
  ok("OWNERS deklareras före Målgrupp-flikens användning", ownersDecl > 0 && ownersDecl < ADMIN_SRC.indexOf("function fillAudOwnSel"));
  ok("misslyckad hämtning når båda ytorna", /OWNERS_ERR = true; _audToolRefreshers\.forEach/.test(ADMIN_SRC));

  console.log("\n" + (fail === 0 ? "✅ ALLA GRÖNA" : "❌ FEL") + "  pass=" + pass + " fail=" + fail);
  if (fail) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
