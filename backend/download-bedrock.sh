#!/usr/bin/env bash
# download-bedrock.sh
#
# Fetches the OpenLandMap "Absolute depth to bedrock" 1 km global GeoTIFF
# and stores it as data/openlandmap/bdticm.tif for sample-bedrock-depth.js.
#
# Source: ISRIC SoilGrids v1 "former" archive — Shangguan et al. 2017, CC-BY 4.0.
# Variable: BDTICM_M = absolute depth to bedrock (cm).
# files.isric.org is the same host we use for the 5 km aggregated SoilGrids rasters.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/data/openlandmap"
mkdir -p "$DIR"
OUT="$DIR/bdticm.tif"

if [ -f "$OUT" ]; then
  echo "Already have $OUT ($(du -h "$OUT" | cut -f1)). Delete to re-download."
  exit 0
fi

URL="https://files.isric.org/soilgrids/former/2017-03-10/aggregated/5km/BDTICM_M_5km_ll.tif"
echo "Downloading $URL"
curl -L --fail --retry 3 --max-time 1800 -o "$OUT.part" "$URL"
mv "$OUT.part" "$OUT"

echo ""
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "Next: node sample-bedrock-depth.js"
