#!/usr/bin/env bash
# download-ecocrop.sh
#
# Fetches and converts the FAO ECOCROP parameter table into
# data/ecocrop/ecocrop.csv for sync-ecocrop.js.
#
# Source: Recocrop R package by R. Hijmans, hosted on CRAN's GitHub mirror.
#   https://github.com/cran/Recocrop/blob/master/inst/parameters/ecocrop.rds
# The data is shipped as an R-serialized .rds file (~76 KB). Converting it
# to CSV requires either R or Python's pyreadr package on the host.
#
# The script:
#   1. Downloads the .rds file
#   2. Attempts conversion using whichever of R / Rscript / python3+pyreadr
#      is available
#   3. Writes data/ecocrop/ecocrop.csv on success
#
# If none of the converters is available, the .rds file is left in place and
# the script prints installation hints. You can also drop a pre-converted
# CSV at data/ecocrop/ecocrop.csv manually — sync-ecocrop.js only needs
# the CSV, not the rds.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/data/ecocrop"
mkdir -p "$DIR"
RDS="$DIR/ecocrop.rds"
CSV="$DIR/ecocrop.csv"

if [ -f "$CSV" ]; then
  rows=$(($(wc -l < "$CSV") - 1))
  echo "Already have $CSV ($rows rows). Delete to re-convert."
  exit 0
fi

URL="https://raw.githubusercontent.com/cran/Recocrop/master/inst/parameters/ecocrop.rds"

if [ ! -f "$RDS" ]; then
  echo "Downloading $URL"
  curl -L --fail --retry 3 --max-time 300 -o "$RDS.part" "$URL"
  mv "$RDS.part" "$RDS"
  echo "Wrote $RDS ($(du -h "$RDS" | cut -f1))"
fi

echo ""
echo "Converting .rds → .csv ..."

if command -v Rscript >/dev/null 2>&1; then
  Rscript -e "d <- readRDS('$RDS'); write.csv(d, '$CSV', row.names=FALSE, na='')"
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import pyreadr' 2>/dev/null; then
  python3 - <<PY
import pyreadr, csv
r = pyreadr.read_r("$RDS")
key = list(r.keys())[0]
df = r[key]
df.to_csv("$CSV", index=False)
PY
else
  cat <<EOF

No converter available (neither \`Rscript\` nor \`python3 -c 'import pyreadr'\` works).

Install one of:
  - R:        apt install r-base  (or equivalent)
  - pyreadr:  pip install pyreadr  (needs pip — try: apt install python3-pip)

After installing, re-run this script — it will pick up the already-downloaded
$RDS and do the conversion.

Alternatively, drop a pre-converted CSV at $CSV manually. Expected columns:
  SCIENTNAME, COMNAME, FAMNAME,
  TOPMN, TOPMX, TMIN, TMAX,
  ROPMN, ROPMX, RMIN, RMAX,
  PHOPMN, PHOPMX, PHMIN, PHMAX,
  TEXT, DEP, FER, SAL, DRA, LIEX, PHOT,
  GMIN, GMAX, LATOPMN, LATOPMX, ALTMX

EOF
  exit 1
fi

rows=$(($(wc -l < "$CSV") - 1))
echo ""
echo "Wrote $CSV ($rows rows)."
echo "Next: node sync-ecocrop.js"
