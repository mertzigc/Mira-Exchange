// Efterfix 2026-08-17: scopa den portade CSS:en i mira-foretag-lista.html.
// Källblocken hade helt generiska selektorer (.field/.pill/.drop/.btn-primary/
// .err … och värst `.hidden{display:none !important}`). På Företag-sidan läckte
// de ut över hela Bubble-appen och släckte omgivande element.
// Vi prefixar varje selektor som saknar egen namnrymd med panelens rot.
import fs from "node:fs";
const F = "/Users/christianmertzig/Documents/GitHub/Mira-Exchange/mira-foretag-lista.html";
let s = fs.readFileSync(F, "utf8");

const MARK = "PORTAT 2026-08-17: CSS för Avtal-flikens paneler";
const start = s.indexOf(MARK);
const end = s.indexOf('<div class="fl">');
if (start < 0 || end < 0 || end < start) throw new Error("hittade inte den portade CSS-regionen");

const region = s.slice(start, end);
const blocks = [...region.matchAll(/<style>([\s\S]*?)<\/style>/g)];
if (blocks.length < 2) throw new Error(`väntade flera style-block, fick ${blocks.length}`);

const KEEP = /^(\.ab-|\.ac-|\.aa-|\.wt-|\.fl|\.fk|:root|html\b|body\b|\*)/;
let scoped = 0;
const touched = [];
function scopeCss(css, rootSel) {
  const comments = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, (m) => `/*__C${comments.push(m) - 1}__*/`);
  function block(str, open) {
    let d = 0;
    for (let i = open; i < str.length; i++) {
      if (str[i] === "{") d++;
      else if (str[i] === "}") { d--; if (!d) return { inner: str.slice(open + 1, i), end: i }; }
    }
    throw new Error("obalanserad CSS");
  }
  function walk(str) {
    let out = "", i = 0;
    while (i < str.length) {
      const b = str.indexOf("{", i);
      if (b < 0) { out += str.slice(i); break; }
      const prelude = str.slice(i, b), t = prelude.trim(), blk = block(str, b);
      if (t.startsWith("@")) {
        out += prelude + "{" + (/^@(media|supports)/i.test(t) ? walk(blk.inner) : blk.inner) + "}";
      } else {
        out += prelude.split(",").map((part) => {
          // Skilj ledande whitespace/kommentar-platshållare från SJÄLVA selektorn,
          // annars testas KEEP mot "/*__C0__*/ .ab-head" → allt scopas (fel
          // specificitet på redan namnrymdade regler).
          const lead = (part.match(/^(?:\s|\/\*__C\d+__\*\/)*/) || [""])[0];
          const sel = part.slice(lead.length).trim();
          if (!sel || KEEP.test(sel)) return part;
          scoped++; touched.push(sel);
          return lead + rootSel + " " + sel;
        }).join(",") + "{" + blk.inner + "}";
      }
      i = blk.end + 1;
    }
    return out;
  }
  return walk(css).replace(/\/\*__C(\d+)__\*\//g, (m, n) => comments[Number(n)]);
}

// Sista style-blocket i regionen = signeringsblockets CSS (.ac-wrap), övriga = .ab-wrap.
let newRegion = region;
blocks.forEach((m, idx) => {
  const root = idx === blocks.length - 1 ? ".ac-wrap" : ".ab-wrap";
  const fixed = scopeCss(m[1], root);
  newRegion = newRegion.replace("<style>" + m[1] + "</style>", "<style>" + fixed + "</style>");
});

// Varningskommentar så ingen lägger tillbaka oscopade regler.
newRegion = newRegion.replace(MARK + " ══ -->",
  MARK + `
     Generiska selektorer (.field/.pill/.drop/.btn-primary/.hidden …) är
     SCOPADE under .ab-wrap/.ac-wrap. Utan det läcker de ut på hela
     Bubble-sidan — ".hidden{display:none!important}" släckte alla omgivande
     Bubble-element (2026-08-17). Lägg ALDRIG till en oscopad regel här. ══ -->`);

s = s.slice(0, start) + newRegion + s.slice(end);
fs.writeFileSync(F, s);
console.log(`✅ ${scoped} selektorer scopade i ${blocks.length} style-block`);
console.log("   t.ex.: " + touched.slice(0, 8).join(", "));
console.log("   .hidden med? " + (touched.includes(".hidden") ? "JA" : "NEJ — kontrollera!"));
