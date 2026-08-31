#!/usr/bin/env python3
"""
mottagare_users.py - bygger mottagarlistan ur Bubbles `User`-typ, dvs. de som
faktiskt HAR ett konto pa Mira. Skiljer sig fran Malgrupp-fliken, som bygger pa
`Coworker` (alla kontaktpersoner, aven de utan inloggning) och blir mangdubbelt
storre.

    python3 nyhetsbrev/mottagare_users.py rakna
    python3 nyhetsbrev/mottagare_users.py lista
    python3 nyhetsbrev/mottagare_users.py importera <utskicks-id>

Filter (galler alla tre kommandon lika, sa siffran du ser ar den som gar ut):
    --utan-carotte          hoppa over @carotte.se och @mira-fm.com (egen personal)
    --utan a@b.se,c@d.se    hoppa over namngivna adresser (test-konton, felstavningar)

`rakna` och `lista` ar helt ofarliga - de laser bara. `importera` skapar
InviteGuest-rader men skickar fortfarande ingenting.

E-postfaltet lases likadant som index.js `_admUserEmail`: email / Email /
email_address / authentication.email.email.

Satt CAROTTE_COMPANY_ID for att kunna dela upp kundanvandare vs egen personal.
"""
import json, os, sys, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("HOST", "").rstrip("/")
KEY = os.environ.get("KEY", "") or os.environ.get("MIRA_RENDER_API_KEY", "")
BUBBLE_KEY = os.environ.get("BUBBLE_API_KEY", "")
BUBBLE_BASE = os.environ.get("BUBBLE_BASE", "https://mira-fm.com").rstrip("/")
CAROTTE_ID = os.environ.get("CAROTTE_COMPANY_ID", "")

if not BUBBLE_KEY:
    raise SystemExit("Saknar BUBBLE_API_KEY. Kor `bash kolla_nycklar.sh` forst.")


def bubble_get(typ, cursor, limit=100):
    url = "%s/api/1.1/obj/%s?limit=%d&cursor=%d" % (BUBBLE_BASE, typ, limit, cursor)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + BUBBLE_KEY})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))["response"]
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %s pa %s\n%s" % (e.code, typ, e.read().decode("utf-8", "replace")[:500]))


def mejl(u):
    for k in ("email", "Email", "email_address"):
        v = u.get(k)
        if v:
            return str(v).strip()
    a = u.get("authentication") or {}
    return str(((a.get("email") or {}).get("email")) or "").strip()


def namn(u):
    for k in ("Förnamn", "Fornamn", "first_name", "First name", "fornamn"):
        if u.get(k):
            return str(u[k]).strip()
    for k in ("name", "Name", "full_name"):
        if u.get(k):
            return str(u[k]).strip()
    return ""


def hamta_users():
    alla, cursor = [], 0
    while True:
        r = bubble_get("User", cursor)
        alla.extend(r.get("results") or [])
        kvar = r.get("remaining")
        sys.stderr.write("\r  hamtat %d, %s kvar ..." % (len(alla), kvar))
        sys.stderr.flush()
        if not kvar:
            break
        cursor += r.get("count") or 100
    sys.stderr.write("\r" + " " * 50 + "\r")
    return alla


def analysera():
    users = hamta_users()
    med, utan, seen, dubbletter = [], 0, set(), 0
    for u in users:
        e = mejl(u)
        if not e:
            utan += 1
            continue
        low = e.lower()
        if low in seen:
            dubbletter += 1
            continue
        seen.add(low)
        med.append({
            "name": namn(u) or e,
            "email": e,
            "company": u.get("Company") or "",
            "role": u.get("User_role") or u.get("user_role") or "",
        })
    med.sort(key=lambda x: x["email"].lower())

    # Filter (galler rakna/lista/importera lika, sa siffran du ser ar den som gar ut)
    if "--utan-carotte" in sys.argv:
        med = [m for m in med if not m["email"].lower().endswith(("@carotte.se", "@mira-fm.com"))]
    if "--utan" in sys.argv:
        bort = {e.strip().lower() for e in sys.argv[sys.argv.index("--utan") + 1].split(",") if e.strip()}
        med = [m for m in med if m["email"].lower() not in bort]
    return users, med, utan, dubbletter


def cmd_rakna():
    users, med, utan, dubbletter = analysera()
    print("User-rader totalt        : %d" % len(users))
    print("  med mejladress         : %d" % (len(med) + dubbletter))
    print("  unika mejladresser     : %d   <-- sa manga brev gar ut" % len(med))
    if "--utan-carotte" in sys.argv or "--utan" in sys.argv:
        print("    (efter filter - kor utan flaggor for att se hela listan)")
    print("  dubblettadresser       : %d" % dubbletter)
    print("  utan mejladress        : %d  (hoppas over)" % utan)
    if CAROTTE_ID:
        egna = sum(1 for m in med if str(m["company"]) == CAROTTE_ID)
        print("\n  varav egen personal    : %d  (Company == CAROTTE_COMPANY_ID)" % egna)
        print("  varav kundanvandare    : %d" % (len(med) - egna))
    else:
        utan_bolag = sum(1 for m in med if not m["company"])
        print("\n  (satt CAROTTE_COMPANY_ID for att skilja egen personal fran kunder)")
        print("  utan Company satt      : %d" % utan_bolag)


def cmd_lista():
    _, med, _, _ = analysera()
    for m in med:
        print("%-42s %s" % (m["email"], m["name"]))
    print("\n%d unika mottagare." % len(med))


def cmd_importera(inv_id):
    if not HOST or not KEY:
        raise SystemExit("Saknar HOST/KEY for importen. Kor `bash kolla_nycklar.sh`.")
    _, med, _, _ = analysera()
    print("%d unika mottagare hittade." % len(med))
    if input("Importera dem som mottagare pa utskick %s? [ja/nej] " % inv_id).strip().lower() not in ("ja", "j"):
        return print("Avbrutet. Inget skapat.")
    skapade = hoppade = 0
    for i in range(0, len(med), 100):
        parti = [{"name": m["name"], "email": m["email"]} for m in med[i:i + 100]]
        req = urllib.request.Request(
            "%s/admin/invite/%s/guests/import" % (HOST, inv_id),
            data=json.dumps({"rows": parti, "first": i == 0}).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-api-key": KEY}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                res = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise SystemExit("HTTP %s vid import\n%s" % (e.code, e.read().decode("utf-8", "replace")[:500]))
        skapade += res.get("created") or 0
        hoppade += res.get("skipped") or 0
        print("  %d/%d ..." % (min(i + 100, len(med)), len(med)))
    print("\n%d tillagda, %d fanns redan (t.ex. din testadress)." % (skapade, hoppade))
    print("Nasta: python3 nyhetsbrev/skicka.py status %s   och sedan `skicka`." % inv_id)


KOMMANDON = {"rakna": (cmd_rakna, 0), "lista": (cmd_lista, 0), "importera": (cmd_importera, 1)}

# Plocka bort flaggor (och --utan:s varde) innan argumenten raknas
args, hoppa = [], False
for a in sys.argv[1:]:
    if hoppa:
        hoppa = False
        continue
    if a == "--utan":
        hoppa = True
        continue
    if a.startswith("--"):
        continue
    args.append(a)

if not args or args[0] not in KOMMANDON:
    raise SystemExit(__doc__)
fn, n = KOMMANDON[args[0]]
if len(args) - 1 != n:
    raise SystemExit("Fel antal argument till `%s`.\n%s" % (args[0], __doc__))
fn(*args[1:])
