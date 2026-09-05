#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# ENGANGSSKRIPT — rensar kundavtal och stora binarer ur HELA git-historiken.
#
#   Tar bort:  "Avtal fran Carotte/" (25 filer, dari signerade kundavtal)
#              Bilder/*.tif          (en fil pa 70 MB)
#              alla .DS_Store
#
#   SKRIVER OM HISTORIKEN. Alla commit-hashar andras. Efterat kravs
#   force-push, och varje befintlig klon maste kastas och klonas om.
#
#   GOR DETTA INNAN NAGON KOLLEGA KLONAR REPOT. Efterat ar det dyrare.
#
# Forutsatter git-filter-repo:
#   brew install git-filter-repo      (eller: pip3 install git-filter-repo)
#
# Kor: bash rensa_historik.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "git-filter-repo saknas. Installera med:  brew install git-filter-repo"
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Arbetstradet ar inte rent. Committa eller stasha forst."
  exit 1
fi

REMOTE="$(git remote get-url origin)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="../Mira-Exchange-backup-$STAMP.bundle"

echo "1/5  Sakerhetskopia -> $BACKUP"
git bundle create "$BACKUP" --all
echo "     Aterstall vid behov med:  git clone $BACKUP Mira-Exchange-aterstalld"

echo "2/5  Bygger listan over sokvagar som ska bort"
PATHS="$(mktemp)"
git ls-files | grep -E '^Avtal|/\.DS_Store$|^\.DS_Store$' > "$PATHS" || true
git log --all --name-only --pretty=format: \
  | grep -E '^Avtal|\.DS_Store$|^Bilder/.*\.[tT][iI][fF]$' \
  | sort -u >> "$PATHS"
sort -u "$PATHS" -o "$PATHS"
echo "     $(wc -l < "$PATHS") sokvagar:"
sed 's/^/       /' "$PATHS"

echo
read -r -p "Skriva om historiken? Detta gar inte att angra utan bundlen ovan. [ja/nej] " svar
[ "$svar" = "ja" ] || { echo "Avbrutet."; rm -f "$PATHS"; exit 0; }

echo "3/5  Skriver om historiken"
git filter-repo --invert-paths --paths-from-file "$PATHS" --force
rm -f "$PATHS"

echo "4/5  Aterstaller remote (filter-repo tar bort den med flit)"
git remote add origin "$REMOTE" 2>/dev/null || git remote set-url origin "$REMOTE"

echo "5/5  Klart lokalt. Kvar att gora, i tur och ordning:"
cat <<'NASTA'

  a) Kontrollera att allt ser rakt ut:
       git log --oneline -5
       du -sh .git
       ls "Avtal från Carotte" 2>/dev/null || echo "mappen finns kvar lokalt (bra) eller ar borta"

  b) Filerna finns kvar pa disk om de lag i arbetstradet — de ar nu ignorerade
     via .gitignore. Flytta dem till SharePoint och ta bort dem harifran.

  c) Force-push:
       git push --force --all origin
       git push --force --tags origin

  d) Kontrollera pa GitHub att repot ar PRIVAT
     (Settings -> General -> Danger Zone -> Change visibility).

  e) Har repot nagon gang varit publikt, eller finns forks/pull requests:
     GitHub behaller losa objekt. Kontakta GitHub Support och be dem kora
     garbage collection pa repot.

  f) Ta bort det har skriptet — det ar ett engangsverktyg:
       git rm rensa_historik.sh && git commit -m "stad: engangsskript borta"

NASTA
