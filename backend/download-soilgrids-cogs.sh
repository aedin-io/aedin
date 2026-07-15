#!/usr/bin/env bash
#
# download-soilgrids-cogs.sh
#
# Downloads SoilGrids v2.0 pre-aggregated 5 km global rasters from
# files.isric.org and reprojects each from Interrupted Goode Homolosine
# to WGS84 lat/lon using a local gdalwarp pass.
#
# Output: backend/data/soilgrids/<property>_<depth>.tif  (one global file each)
#
# Why 5 km and not native 250 m:
#   The climate_grid sampling points are on a 0.25° (~28 km) grid, so 5 km
#   rasters still give ~6 samples per grid cell. A 5 km global file is ~4 MB
#   on disk — the full 33-file download is ~140 MB and completes in minutes.
#   Native 250 m would be ~50 GB of range requests through a VRT; that's
#   what the previous version of this script was wedged on.
#
# License: SoilGrids is ISRIC CC-BY 4.0 — commercial use permitted with
# attribution. Cite as:
#   Poggio, L. et al. (2021) "SoilGrids 2.0: producing soil information for
#   the globe with quantified spatial uncertainty", SOIL, 7, 217-240.
#
# Requirements: curl, gdalwarp (apt install gdal-bin).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/data/soilgrids"
RAW_DIR="${OUT_DIR}/raw"
mkdir -p "$OUT_DIR" "$RAW_DIR"

# Properties we need (matches backfill-climate.js fetchSoilData).
PROPERTIES=(phh2o clay sand silt soc cec nitrogen bdod cfvo wv0033 wv1500)

# Top three depth layers — averaging these gives the 0-30 cm "surface"
# value the climate_grid columns represent.
DEPTHS=("0-5cm" "5-15cm" "15-30cm")

BASE_URL="https://files.isric.org/soilgrids/latest/data_aggregated/5000m"

TOTAL=$(( ${#PROPERTIES[@]} * ${#DEPTHS[@]} ))
I=0
FAILED=()

echo "Downloading $TOTAL SoilGrids 5km rasters to $OUT_DIR"
echo

for PROP in "${PROPERTIES[@]}"; do
  for DEPTH in "${DEPTHS[@]}"; do
    I=$((I + 1))
    NAME="${PROP}_${DEPTH}"
    URL="${BASE_URL}/${PROP}/${PROP}_${DEPTH}_mean_5000.tif"
    RAW="${RAW_DIR}/${NAME}_raw.tif"
    OUT="${OUT_DIR}/${NAME}.tif"

    if [ -f "$OUT" ] && [ -s "$OUT" ]; then
      echo "[$I/$TOTAL] skip (exists): ${NAME}.tif"
      continue
    fi

    echo "[$I/$TOTAL] $NAME"
    START=$(date +%s)

    # 1. Direct curl download (single HTTP stream — fast).
    if ! curl -fL --max-time 300 --retry 3 --retry-delay 2 \
         -o "$RAW" "$URL"
    then
      echo "  FAILED download: $NAME"
      FAILED+=("$NAME")
      rm -f "$RAW"
      continue
    fi

    DL_SIZE=$(du -h "$RAW" | awk '{print $1}')
    DL_ELAPSED=$(( $(date +%s) - START ))

    # 2. Reproject Homolosine → WGS84 locally.
    #    -r bilinear produces slightly smoother soil fields than nearest.
    #    Target resolution 0.05° ≈ 5.5 km at equator, matching source scale.
    if ! gdalwarp \
        -t_srs EPSG:4326 \
        -tr 0.05 0.05 \
        -r bilinear \
        -of GTiff \
        -co COMPRESS=DEFLATE \
        -co PREDICTOR=2 \
        -co TILED=YES \
        -overwrite \
        -q \
        "$RAW" "$OUT"
    then
      echo "  FAILED warp: $NAME"
      FAILED+=("$NAME")
      rm -f "$RAW" "$OUT"
      continue
    fi

    OUT_SIZE=$(du -h "$OUT" | awk '{print $1}')
    TOTAL_ELAPSED=$(( $(date +%s) - START ))
    echo "  download ${DL_SIZE} in ${DL_ELAPSED}s → warp → ${OUT_SIZE} (total ${TOTAL_ELAPSED}s)"

    rm -f "$RAW"
  done
done

rmdir "$RAW_DIR" 2>/dev/null || true

echo
echo "Wrote $((TOTAL - ${#FAILED[@]}))/$TOTAL files to $OUT_DIR"
du -sh "$OUT_DIR"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "WARNING: ${#FAILED[@]} file(s) failed:"
  printf "  %s\n" "${FAILED[@]}"
  echo "Re-run this script to retry — successful files will be skipped."
  exit 1
fi
