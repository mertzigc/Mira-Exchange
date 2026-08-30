#!/usr/bin/env python3
"""
skicka.py - tar nyhetsutskicket fran skapat till skickat. Skoter pagineringen at dig.

Koer sa har (env-varsen MASTE mappas in pa raden - de ar interaktiva, ej exporterade):

    HOST=$HOST KEY=$KEY python3 nyhetsbrev/skicka.py <kommando> <id> [...]

Kommandon, i den ordning de ska koras:

  status   <id>                  vad ar laget: antal gaster, skickade, kvar
  test     <id> <mejladress>     lagg till EN mottagare och skicka bara till den
  malgrupp <id>                  visa hur manga det blir, fraga, bygg sedan listan
  skicka   <id>                  skicka till alla i listan som inte fatt an

Inget kommando skickar nagot utan att fraga forst (utom `test`, som bara gar till dig).
"""
import json, os, sys, urllib.request, urllib.error

HOST = os.environ.get("HOST", "").rstrip("/")
KEY = os.environ.get("KEY", "") or os.environ.get("MIRA_RENDER_API_KEY", "")

if not HOST or not KEY:
    raise SystemExit("Saknar HOST och/eller KEY. Kor: HOST=$HOST KEY=$KEY python3 nyhetsbrev/skicka.py ...")
if not HOST.startswith("http"):
    raise SystemExit("HOST ser fel ut (%r). Ska vara Render-URL:en, t.ex. https://mira-exchange.onrender.com" % HOST)


def call(path, payload=None, method=None):
    method = method or ("POST" if payload is not None else "GET")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        HOST + path, data=data, method=method,
        headers={"Content-Type": "application/json", "x-api-key": KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %s pa %s\n%s" % (e.code, path, e.read().decode("utf-8", "replace")[:800]))


def ja(fraga):
    svar = input(fraga + " [ja/nej] ").strip().lower()
    return svar in ("ja", "j", "y", "yes")


def hamta_utskick(inv_id):
    res = call("/admin/invite/" + inv_id)
    if not res.get("ok"):
        raise SystemExit("Hittade inget utskick med id %s" % inv_id)
    return res.get("invite") or res


def cmd_status(inv_id):
    inv = hamta_utskick(inv_id)
    print("Utskick : %s" % inv.get("title"))
    print("Typ     : %s   Aktiv: %s" % (inv.get("kind"), inv.get("active")))
    blocks = inv.get("content_blocks") or []
    print("Block   : %d %s" % (len(blocks), "" if blocks else "  <-- VARNING: inga designblock!"))
    st = call("/admin/invite/%s/guests/stats" % inv_id)
    print("Gaster  : %s" % json.dumps({k: v for k, v in st.items() if k != "ok"}, ensure_ascii=False))


def cmd_test(inv_id, mejl):
    print("Lagger till %s som mottagare ..." % mejl)
    res = call("/admin/invite/%s/guests/import" % inv_id,
               {"rows": [{"name": "Test", "email": mejl}], "first": True})
    print("  skapade=%s  redan_i_listan=%s  ogiltiga=%s" % (res.get("created"), res.get("skipped"), res.get("invalid")))
    if res.get("skipped"):
        print("  (adressen fanns redan - har den redan fatt brevet gar det INTE ut igen)")
    print("Koar utskick till den adressen ...")
    res = call("/admin/invite/%s/send" % inv_id, {"offset": 0, "limit": 5})
    print("  koade=%s av totalt %s i sandlistan" % (res.get("queued"), res.get("total")))
    print("\nPollern tommer kon var 2:a minut. Brevet bor ligga i inkorgen inom ~3 min.")
    print("Las det i Outlook OCH pa mobilen innan du gar vidare till `malgrupp`.")


def cmd_malgrupp(inv_id):
    pre = call("/admin/audience/preview", {})
    print("Malgrupp utan filter:")
    print("  %s foretag" % pre.get("company_count"))
    print("  %s mottagare med mejladress" % pre.get("user_count"))
    print("  %s kontaktpersoner saknar mejl (hoppas over)" % pre.get("no_email"))
    if not ja("\nBygga mottagarlistan pa %s adresser?" % pre.get("user_count")):
        return print("Avbrutet. Inget skapat.")
    offset, skapade, hoppade = 0, 0, 0
    while True:
        r = call("/admin/invite/%s/guests/build" % inv_id, {"offset": offset, "limit": 100})
        skapade += r.get("created") or 0
        hoppade += r.get("skipped") or 0
        print("  %s/%s ..." % (r.get("processed"), r.get("total")))
        if r.get("done"):
            break
        offset = r.get("next_offset")
    print("\nKlart. %s tillagda, %s fanns redan (t.ex. din testadress)." % (skapade, hoppade))
    print("Nasta: HOST=$HOST KEY=$KEY python3 nyhetsbrev/skicka.py skicka %s" % inv_id)


def cmd_skicka(inv_id):
    inv = hamta_utskick(inv_id)
    st = call("/admin/invite/%s/guests/stats" % inv_id)
    print("Utskick : %s" % inv.get("title"))
    print("Gaster  : %s" % json.dumps({k: v for k, v in st.items() if k != "ok"}, ensure_ascii=False))
    print("\nDetta koar brevet till ALLA i listan som inte redan fatt det.")
    print("Avregistrerade (EmailOptout) hoppas over automatiskt. Det gar inte att angra.")
    if not ja("Skicka?"):
        return print("Avbrutet. Ingenting koat.")
    offset, koade = 0, 0
    while True:
        r = call("/admin/invite/%s/send" % inv_id, {"offset": offset, "limit": 40})
        koade += r.get("queued") or 0
        print("  %s/%s koade ..." % (r.get("processed"), r.get("total")))
        if r.get("done"):
            break
        offset = r.get("next_offset")
    print("\n%s rader koade i emailqueue." % koade)
    print("Pollern skickar ~20 mejl varannan minut (~600/timme) - stort utskick tar sin tid.")
    print("Folj upp: sok emailqueue i Bubble pa email_sent=false AND error_message is not empty.")


KOMMANDON = {"status": (cmd_status, 1), "test": (cmd_test, 2), "malgrupp": (cmd_malgrupp, 1), "skicka": (cmd_skicka, 1)}
args = sys.argv[1:]
if not args or args[0] not in KOMMANDON:
    raise SystemExit(__doc__)
fn, n = KOMMANDON[args[0]]
if len(args) - 1 != n:
    raise SystemExit("Fel antal argument till `%s`.\n%s" % (args[0], __doc__))
fn(*args[1:])
