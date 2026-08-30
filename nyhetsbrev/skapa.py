#!/usr/bin/env python3
"""
skapa.py - laddar upp nyhetsbrevets bilder och skapar nyhetsutskicket i Mira.

Koer sa har (env-varsen maste mappas in pa raden - de ar interaktiva, ej exporterade):

    HOST=$HOST KEY=$KEY BUBBLE_API_KEY=$BUBBLE_API_KEY python3 nyhetsbrev/skapa.py

Vad den gor, i ordning:
  1. Laddar upp de sex skarmbilderna -> Bubble-hostade URL:er
  2. Ersatter __IMG_0N__ i blocks.json med de URL:erna
  3. POST /admin/invite/create  -> skapar Invitation med kind=news + content_blocks
  4. Skriver ut id + varnar om content_blocks inte landade

Den SKICKAR ingenting. Mottagarlista och utskick gors darefter (se README.md).

UPPLADDNINGSVAG: direkt mot Bubbles /fileupload (multipart) med BUBBLE_API_KEY, plus en
MediaAsset-rad sa bilderna syns i Arkiv-valjaren. Render-vagen /admin/media/upload gar INTE
att anvanda for de har bilderna: `express.json()` i index.js kor pa default-taket 100 kb, sa
allt over ~74 kb ravfil svarar 413 Payload Too Large langt innan endpointens egen 6 MB-koll.
Satts `limit` pa express.json nagon gang kan --via-render anvandas i stallet.

Flaggor:
  --dry-run      ladda upp inget, skapa inget - skriv bara ut payloaden
  --update ID    patcha ett befintligt utskick i stallet for att skapa nytt
  --via-render   ladda upp via /admin/media/upload i stallet (kraver hojt json-tak)
"""
import base64, json, mimetypes, os, sys, urllib.request, urllib.error, uuid

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("HOST", "").rstrip("/")
KEY = os.environ.get("KEY", "") or os.environ.get("MIRA_RENDER_API_KEY", "")
BUBBLE_KEY = os.environ.get("BUBBLE_API_KEY", "")
BUBBLE_BASE = os.environ.get("BUBBLE_BASE", "https://mira-fm.com").rstrip("/")

BILDER = [
    ("__IMG_01__", "01-tjanster.jpg"),
    ("__IMG_02__", "02-oversikt.jpg"),
    ("__IMG_03__", "03-planering-manad.jpg"),
    ("__IMG_04__", "04-planering-ar.jpg"),
    ("__IMG_05__", "05-bokningswizard.jpg"),
    ("__IMG_06__", "06-fakturaportal.jpg"),
]

dry = "--dry-run" in sys.argv
via_render = "--via-render" in sys.argv
update_id = None
if "--update" in sys.argv:
    update_id = sys.argv[sys.argv.index("--update") + 1]


def call(path, payload, method="POST"):
    req = urllib.request.Request(
        HOST + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-api-key": KEY},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise SystemExit("HTTP %s pa %s\n%s" % (e.code, path, body[:800]))


def _httpsUrl(u):
    u = str(u or "").strip()
    return ("https:" + u) if u.startswith("//") else u


def bubble_upload(filename, buf):
    """Multipart POST mot Bubbles /fileupload. Returnerar publik URL."""
    ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    boundary = "----miranb" + uuid.uuid4().hex
    body = b"".join([
        ("--%s\r\n" % boundary).encode(),
        ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % filename).encode(),
        ("Content-Type: %s\r\n\r\n" % ctype).encode(),
        buf, b"\r\n",
        ("--%s--\r\n" % boundary).encode(),
    ])
    req = urllib.request.Request(
        BUBBLE_BASE + "/fileupload", data=body, method="POST",
        headers={"Authorization": "Bearer " + BUBBLE_KEY,
                 "Content-Type": "multipart/form-data; boundary=" + boundary},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            txt = r.read().decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %s fran Bubbles /fileupload\n%s" % (e.code, e.read().decode("utf-8", "replace")[:800]))
    try:
        j = json.loads(txt)
        if isinstance(j, str):
            return _httpsUrl(j)
        for k in ("url", "file_url", "body"):
            if isinstance(j, dict) and j.get(k):
                return _httpsUrl(j[k])
    except Exception:
        pass
    url = _httpsUrl(txt.strip('"'))
    if not url.startswith("http"):
        raise SystemExit("Ovantat svar fran /fileupload: %r" % txt[:300])
    return url


def bubble_media_asset(url, filename):
    """Skapar MediaAsset-raden sa bilden dyker upp i Arkiv-valjaren. Fel har ar inte kritiskt."""
    payload = {"url": url, "name": filename, "content_type": "image/jpeg"}
    req = urllib.request.Request(
        BUBBLE_BASE + "/api/1.1/obj/MediaAsset", data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": "Bearer " + BUBBLE_KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60):
            return True
    except Exception as e:
        print("  (kunde inte skapa MediaAsset-rad: %s - bilden fungerar anda)" % e)
        return False


if not dry:
    if not HOST or not KEY:
        raise SystemExit("Saknar HOST och/eller KEY. Kor: HOST=$HOST KEY=$KEY BUBBLE_API_KEY=$BUBBLE_API_KEY python3 nyhetsbrev/skapa.py")
    if not via_render and not BUBBLE_KEY:
        raise SystemExit("Saknar BUBBLE_API_KEY (behovs for bilduppladdningen).\n"
                         "Kor: HOST=$HOST KEY=$KEY BUBBLE_API_KEY=$BUBBLE_API_KEY python3 nyhetsbrev/skapa.py")

blocks = json.load(open(os.path.join(ROOT, "blocks.json"), encoding="utf-8"))
meta = json.load(open(os.path.join(ROOT, "utskick.json"), encoding="utf-8"))

# 1. Bilder
urls = {}
for token, fname in BILDER:
    path = os.path.join(ROOT, "bilder", fname)
    raw = open(path, "rb").read()
    if dry:
        urls[token] = "https://exempel.invalid/" + fname
        print("[dry] %-12s %s (%d kB)" % (token, fname, len(raw) // 1024))
        continue
    if via_render:
        res = call("/admin/media/upload", {
            "data_base64": base64.b64encode(raw).decode("ascii"),
            "content_type": "image/jpeg",
            "filename": fname,
        })
        if not res.get("ok") or not res.get("url"):
            raise SystemExit("Uppladdning misslyckades for %s: %s" % (fname, res))
        url = res["url"]
    else:
        url = bubble_upload(fname, raw)
        bubble_media_asset(url, fname)
    urls[token] = url
    print("uppladdad  %-12s (%3d kB) -> %s" % (token, len(raw) // 1024, url))

# 2. Substituera
txt = json.dumps(blocks, ensure_ascii=False)
for token, url in urls.items():
    txt = txt.replace(token, url)
if "__IMG_" in txt:
    raise SystemExit("Nagon bildplatshallare blev kvar - kolla BILDER-listan mot blocks.json")
blocks = json.loads(txt)

payload = dict(meta)
payload["content_blocks"] = blocks

if dry:
    print("\n--- payload (%d block) ---" % len(blocks))
    print(json.dumps(payload, ensure_ascii=False, indent=2)[:1500] + "\n...")
    raise SystemExit(0)

# 3. Skapa / patcha
if update_id:
    payload["id"] = update_id
    res = call("/admin/invite/update", payload, method="PATCH")
else:
    res = call("/admin/invite/create", payload)

print("\nsvar:", json.dumps(res, ensure_ascii=False))
if not res.get("ok"):
    raise SystemExit("Create/update misslyckades.")
if res.get("blocks_saved") is False or res.get("warning") == "content_blocks_field_missing":
    print("\nVARNING: content_blocks landade INTE i Bubble. Falt saknas pa Invitation ->")
    print("         utskicket skulle ga ut utan designblocken. Fixa faltet innan du skickar.")
else:
    print("\nKLART. Utskicks-id: %s  (%d block sparade)" % (res.get("id"), len(blocks)))
    print("Nasta steg: bygg mottagarlista + skicka. Se nyhetsbrev/README.md.")
