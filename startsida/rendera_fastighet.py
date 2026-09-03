#!/usr/bin/env python3
"""
rendera_fastighet.py - renderar skarmbilder av fastighetsagarvyn till
startsida/bilder/ ur mira-fastighet-demo.html.

    python3 startsida/rendera_fastighet.py            # alla sex flikarna
    python3 startsida/rendera_fastighet.py puls       # bara en

Kallan ar ALLTID demofilen. Aldrig mira-fastighet.html - det skarpa blocket
innehaller riktiga hyresgasters driftdata, och en skarmbild darifran hade brutit
integritetsloftet i samma bild som pastar det.

Tva saker byts vid RENDERING, inte i demofilen:

  1. "SKISS - MOCKDATA" -> "EXEMPELDATA". Publikt lases "SKISS" som ofardigt,
     men bilden maste anda saga att siffrorna inte ar riktiga.
  2. Bolags- och husnamn neutraliseras (NAMN nedan). Demofilens mockdata ar
     Vasakronans faktiska bestand med riktiga hyresgaster, och trenderna ar
     pahittade. Publicerat blir det ett pastaende om namngivna bolag -
     "Tele2 har gatt tyst i Kista Entre" - som vi inte kan sta for. Internt i
     demofilen ar namnen bra, for de gor historien igenkannbar i ett mote.

Tva Chrome-korningar per bild: forst --dump-dom for att mata sidans hojd, sedan
--screenshot i den hojden. Annars maste fonsterhojden gissas per flik.
"""
import os, re, subprocess, sys, tempfile, shutil

ROOT   = os.path.dirname(os.path.abspath(__file__))
REPO   = os.path.dirname(ROOT)
DEMO   = os.path.join(REPO, "mira-fastighet-demo.html")
UT     = os.path.join(ROOT, "bilder")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BREDD  = 1360          # layoutbredd; 2x ger 2720 px, resamplas till 1700
SLUT   = 1700          # samma bredd som ovriga skarmbilder pa startsidan

# (flik, filnamn, takhojd i css-px). 0 = hela vyn. Taket finns for att en bild som
# ar 1,2 ganger sa hog som den ar bred blir en vagg pa startsidan - en avklippt
# tabell laser dessutom som en skarmbild, inte som en utskrift.
FLIKAR = [
    ("bestand",  "fastighet-bestand",  0),
    ("puls",     "fastighet-puls",   800),
    ("arenden",  "fastighet-arenden",  0),
    ("kvalitet", "fastighet-kvalitet", 0),
    ("tjanster", "fastighet-tjanster",700),
    ("kallor",   "fastighet-kallor",   0),
]

# Langsta forst - "Kista Entre" innan "Kista".
NAMN = [
    ("Vasakronan", "Nordvik Fastigheter"),
    ("Hotorgshuset", "Kvarteret Almen"),
    ("Sveavagen 17, Stockholm", "Almgatan 12, Stockholm"),
    ("Sergelhuset", "Kvarteret Eken"),
    ("Sergelgatan 1, Stockholm", "Ekvagen 3, Stockholm"),
    ("Kista Entre", "Nordport"),
    ("Kistagangen 12, Kista", "Nordportsvagen 8, Solna"),
    ("Klara C", "Sodra Porten"),
    ("Klarabergsviadukten 63, Stockholm", "Sodra Portgatan 5, Stockholm"),
    ("Scania CV", "Alvik Konsult"),
    ("Planhat", "Nordbase"),
    ("EA / Dice", "Vinge Studio"),
    ("Nordea Markets", "Sjoberg Kapital"),
    ("Ericsson RnD", "Teknikbolaget Nord"),
    ("Tele2 Business", "Lindberg & Ek"),
    ("Klarna Ops", "Bergman Digital"),
    ("Bonnier News", "Redaktion Vast"),
    ("Kry Sverige", "Halsobolaget"),
    ("Mentimeter", "Formstad"),
]
# Listan ovan halls i ASCII; de svenska tecknen satts tillbaka har.
SV = {"Hotorgshuset":"Hötorgshuset","Sveavagen":"Sveavägen","Kista Entre":"Kista Entré",
      "Kistagangen":"Kistagången","Ekvagen":"Ekvägen","Nordportsvagen":"Nordportsvägen",
      "Sodra":"Södra","Sjoberg":"Sjöberg","Vast":"Väst","Halsobolaget":"Hälsobolaget"}

def sv(s):
    for a, b in SV.items():
        s = s.replace(a, b)
    return s

PAR = [[sv(a), sv(b)] for a, b in NAMN]

WRAP_HEAD = """<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8">
<title>Mira Fastighet</title>
<style>html,body{margin:0;padding:0;background:#1e2235;}
.fa{border-radius:0 !important;padding-bottom:26px !important;}</style>
</head><body>
"""
WRAP_FOOT = """
<script>
(function(){
  var q=(location.search.match(/tab=([a-z]+)/)||[])[1]||"bestand";
  var b=document.querySelector('[data-tab="'+q+'"]');
  if(b) b.click();
  var t=document.querySelector(".skisstag");
  if(t) t.textContent="EXEMPELDATA";
  var par=__PAR__;
  var w=document.createTreeWalker(document.querySelector(".fa"),NodeFilter.SHOW_TEXT,null,false),n;
  while((n=w.nextNode())){
    var s=n.nodeValue;
    for(var i=0;i<par.length;i++){ s=s.split(par[i][0]).join(par[i][1]); }
    if(s!==n.nodeValue) n.nodeValue=s;
  }
  document.body.setAttribute("data-h", String(Math.ceil(document.body.scrollHeight)));
})();
</script>
</body></html>
"""

def bygg_wrapper(mapp):
    demo = open(DEMO, encoding="utf-8").read()
    import json
    html = WRAP_HEAD + demo + WRAP_FOOT.replace("__PAR__", json.dumps(PAR, ensure_ascii=False))
    p = os.path.join(mapp, "wrap.html")
    open(p, "w", encoding="utf-8").write(html)
    return p

def kor(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=180)

def hojd(url):
    r = kor([CHROME, "--headless=new", "--hide-scrollbars", "--virtual-time-budget=6000",
             "--window-size=%d,900" % BREDD, "--dump-dom", url])
    m = re.search(r'data-h="(\d+)"', r.stdout or "")
    return int(m.group(1)) if m else 1200

def main():
    valda = sys.argv[1:]
    mapp = tempfile.mkdtemp(prefix="fastrender-")
    try:
        wrap = bygg_wrapper(mapp)
        for tab, namn, tak in FLIKAR:
            if valda and tab not in valda:
                continue
            url = "file://" + wrap + "?tab=" + tab
            h = hojd(url) + 8
            if tak and h > tak:
                h = tak
            png = os.path.join(mapp, namn + ".png")
            kor([CHROME, "--headless=new", "--hide-scrollbars", "--virtual-time-budget=6000",
                 "--force-device-scale-factor=2", "--window-size=%d,%d" % (BREDD, h),
                 "--screenshot=" + png, url])
            if not os.path.exists(png):
                print("MISSLYCKADES  %s" % namn); continue
            jpg = os.path.join(UT, namn + ".jpg")
            kor(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "86",
                 "--resampleWidth", str(SLUT), png, "--out", jpg])
            d = kor(["sips", "-g", "pixelWidth", "-g", "pixelHeight", jpg]).stdout
            w = re.search(r"pixelWidth:\s*(\d+)", d); hh = re.search(r"pixelHeight:\s*(\d+)", d)
            print("%-22s %sx%s  %d kB" % (namn + ".jpg", w.group(1) if w else "?",
                  hh.group(1) if hh else "?", os.path.getsize(jpg) // 1024))
    finally:
        shutil.rmtree(mapp, ignore_errors=True)

main()
