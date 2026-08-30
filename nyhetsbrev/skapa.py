#!/usr/bin/env python3
"""
skapa.py - laddar upp nyhetsbrevets bilder och skapar nyhetsutskicket i Mira.

Koer sa har (env-varsen maste mappas in pa raden - de ar interaktiva, ej exporterade):

    HOST=$HOST KEY=$KEY python3 nyhetsbrev/skapa.py

Vad den gor, i ordning:
  1. POST /admin/media/upload  x6  -> Bubble-hostade URL:er for skarmbilderna
  2. Ersatter __IMG_0N__ i blocks.json med de URL:erna
  3. POST /admin/invite/create      -> skapar Invitation med kind=news + content_blocks
  4. Skriver ut id + varnar om content_blocks inte landade

Den SKICKAR ingenting. Mottagarlista och utskick gors darefter (se README.md).

Flaggor:
  --dry-run     ladda upp inget, skapa inget - skriv bara ut payloaden
  --update ID   patcha ett befintligt utskick i stallet for att skapa nytt
"""
import base64, json, os, sys, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("HOST", "").rstrip("/")
KEY = os.environ.get("KEY", "") or os.environ.get("MIRA_RENDER_API_KEY", "")

BILDER = [
    ("__IMG_01__", "01-tjanster.jpg"),
    ("__IMG_02__", "02-oversikt.jpg"),
    ("__IMG_03__", "03-planering-manad.jpg"),
    ("__IMG_04__", "04-planering-ar.jpg"),
    ("__IMG_05__", "05-bokningswizard.jpg"),
    ("__IMG_06__", "06-fakturaportal.jpg"),
]

dry = "--dry-run" in sys.argv
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


if not dry and (not HOST or not KEY):
    raise SystemExit("Saknar HOST och/eller KEY. Kor: HOST=$HOST KEY=$KEY python3 nyhetsbrev/skapa.py")

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
    res = call("/admin/media/upload", {
        "data_base64": base64.b64encode(raw).decode("ascii"),
        "content_type": "image/jpeg",
        "filename": fname,
    })
    if not res.get("ok") or not res.get("url"):
        raise SystemExit("Uppladdning misslyckades for %s: %s" % (fname, res))
    urls[token] = res["url"]
    print("uppladdad  %-12s -> %s" % (token, res["url"]))

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
