#!/usr/bin/env python3
"""
ladda_upp.py - laddar upp startsidans skarmbilder till Bubble och skriver en
kopia av sidan dar <img src> pekar pa CDN-URL:erna i stallet for bilder/.

    BUBBLE_API_KEY=$BUBBLE_API_KEY python3 startsida/ladda_upp.py

Tar startsida/index.html som standard; ge en annan fil som argument om du vill.
Resultatet hamnar i startsida/index-live.html - det ar DEN du klistrar in.

Uppladdade bilder cachas i bilder/uppladdade.json, sa en omkorning laddar inte
upp samma fil igen (uppladdning till Bubble gar inte att angra). Byter du ut en
bild laddas just den upp pa nytt, eftersom cachen ar nycklad pa filstorlek.
"""
import json, mimetypes, os, sys, urllib.request, urllib.error, uuid

ROOT = os.path.dirname(os.path.abspath(__file__))
BUBBLE_KEY = os.environ.get("BUBBLE_API_KEY", "")
BUBBLE_BASE = os.environ.get("BUBBLE_BASE", "https://mira-fm.com").rstrip("/")
if not BUBBLE_KEY:
    raise SystemExit("Saknar BUBBLE_API_KEY. Kor `bash kolla_nycklar.sh` forst.")

KALLA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "index.html")
UT = os.path.join(ROOT, "index-live.html")
CACHE = os.path.join(ROOT, "bilder", "uppladdade.json")
cache = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}


def upp(filename, buf):
    ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    b = "----mirasp" + uuid.uuid4().hex
    body = b"".join([("--%s\r\n" % b).encode(),
        ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % filename).encode(),
        ("Content-Type: %s\r\n\r\n" % ctype).encode(), buf, b"\r\n", ("--%s--\r\n" % b).encode()])
    req = urllib.request.Request(BUBBLE_BASE + "/fileupload", data=body, method="POST",
        headers={"Authorization": "Bearer " + BUBBLE_KEY,
                 "Content-Type": "multipart/form-data; boundary=" + b})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            txt = r.read().decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %s fran /fileupload\n%s" % (e.code, e.read().decode("utf-8", "replace")[:600]))
    try:
        j = json.loads(txt)
        txt = j if isinstance(j, str) else (j.get("url") or txt)
    except Exception:
        pass
    u = str(txt).strip('"').strip()
    return ("https:" + u) if u.startswith("//") else u


html = open(KALLA, encoding="utf-8").read()
filer = sorted(f for f in os.listdir(os.path.join(ROOT, "bilder")) if f.lower().endswith((".jpg", ".png")))
anvanda = [f for f in filer if ('src="bilder/' + f + '"') in html]
if not anvanda:
    raise SystemExit("Hittade inga src=\"bilder/...\" i %s - ar filen redan uppdaterad?" % KALLA)

for f in anvanda:
    raw = open(os.path.join(ROOT, "bilder", f), "rb").read()
    t = cache.get(f)
    if t and t.get("bytes") == len(raw):
        u = t["url"]; print("cachad     %-22s %s" % (f, u))
    else:
        u = upp(f, raw)
        cache[f] = {"bytes": len(raw), "url": u}
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("uppladdad  %-22s %s" % (f, u))
    html = html.replace('src="bilder/' + f + '"', 'src="' + u + '"')

open(UT, "w", encoding="utf-8").write(html)
print("\nKLART. %s har CDN-URL:er inbakade - klistra in den filen." % UT)
