#!/usr/bin/env python3
"""
patcha.py - byter ut startsidans handbyggda fejk-UI mot riktiga skarmbilder.

    python3 startsida/patcha.py <din-index.html> [--ut index-nytt.html]

Den ROR INTE din fil - den skriver en ny. Text och komposition ar oforandrade;
bara innehallet INUTI fem containrar byts mot en <img>:

  .fc         (hero-kortet)            -> hero-kort.jpg
  .ov-body    (flik Oversikt)          -> skarm-oversikt.jpg
  .bk-body    (flik Bokningar)         -> skarm-bokningar.jpg
  .lv-body    (flik Lokalvard)         -> skarm-lokalvard.jpg
  .drift-body (flik Arenden)           -> skarm-arenden.jpg

Webblasarramen (.stb med prickar och URL), flikarna, rubrikerna, ticker,
bridge-sektionen, AI-sektionen, telefonerna och foten ror vi inte.

Hittas inte en container avbryter skriptet med fel - hellre det an att tyst
lamna en fejkvy kvar.

Flaggan --bas byter bildsokvag (default "bilder/"). Efter uppladdning till
Bubble kor du med --bas https://...cdn.bubble.io/f.../  sa pekar taggarna dit.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))

if len(sys.argv) < 2 or sys.argv[1].startswith("--"):
    raise SystemExit(__doc__)
KALLA = sys.argv[1]
UT = sys.argv[sys.argv.index("--ut") + 1] if "--ut" in sys.argv else os.path.join(ROOT, "index-nytt.html")
BAS = sys.argv[sys.argv.index("--bas") + 1] if "--bas" in sys.argv else "bilder/"

# container-oppning (regex) -> (bildfil, alt-text)
MAL = [
    (r'<div class="fc">',                        "hero-kort.jpg",      "Overblick i Mira: bokningar, arenden och kvalitetsbetyg"),
    (r'<div class="ov-body">',                   "skarm-oversikt.jpg", "Oversiktsvyn i Mira med bokningar, arenden, kvalitet och kundansvarig"),
    (r'<div class="bk-body">',                   "skarm-bokningar.jpg","Tjanstevyn i Mira: aktiva tjanster, forslag och paket att bestalla"),
    (r'<div class="lv-body">',                   "skarm-lokalvard.jpg","Kvalitetskontroll i Mira med betyg och kommentar per yta"),
    (r'<div class="drift-body"[^>]*>',           "skarm-arenden.jpg",  "Arendelistan i Mira med prioritet, kontor och status"),
]

# Hero-kortet behaller sin rubrikrad; de ovriga ersatts helt.
HERO_HEAD = ('<div class="fch"><span class="fct">Kontoret just nu &middot; Live</span>'
             '<div class="fcd"></div></div>')

CSS = """
/* ── Riktiga skarmbilder i stallet for handbyggda vyer ── */
.shot-img{display:block;width:100%;height:auto;border:0;}
.sw .shot-img{border-radius:0 0 16px 16px;}
.fc .shot-img{border-radius:8px;border:1px solid var(--bdr);}
.fc.has-shot{padding:18px 18px 16px;}
"""


def slut_pa_div(html, start):
    """Index precis efter den </div> som stanger taggen som borjar pa `start`."""
    i, djup = start, 0
    tagg = re.compile(r"<\s*(/?)div\b", re.I)
    while True:
        m = tagg.search(html, i)
        if not m:
            raise SystemExit("Trasig HTML: hittade ingen avslutande </div> fran position %d" % start)
        djup += -1 if m.group(1) else 1
        i = m.end()
        if djup == 0:
            slut = html.find(">", i)
            return slut + 1


html = open(KALLA, encoding="utf-8").read()
original_langd = len(html)
bytta = []

for monster, fil, alt in MAL:
    m = re.search(monster, html)
    if not m:
        raise SystemExit("Hittade inte containern %r i %s - har markupen andrats?" % (monster, KALLA))
    slut = slut_pa_div(html, m.start())
    img = '<img class="shot-img" src="%s%s" alt="%s" loading="lazy">' % (BAS, fil, alt)
    if fil == "hero-kort.jpg":
        ny = '<div class="fc has-shot">' + HERO_HEAD + img + "</div>"
    else:
        ny = m.group(0) + img + "</div>"
    html = html[:m.start()] + ny + html[slut:]
    bytta.append(fil)

# Lagg in CSS:en sist i den befintliga <style>-blocken
if "</style>" not in html:
    raise SystemExit("Hittade ingen </style> att lagga CSS-tillagget i.")
sista = html.rfind("</style>")
html = html[:sista] + CSS + html[sista:]

open(UT, "w", encoding="utf-8").write(html)
print("Skrev %s" % UT)
print("  %d vyer utbytta: %s" % (len(bytta), ", ".join(bytta)))
print("  bildsokvag: %s" % BAS)
print("  %d -> %d tecken" % (original_langd, len(html)))
print("\nJamfor innan du klistrar in:  diff <(cat %s) <(cat %s) | head -60" % (KALLA, UT))
