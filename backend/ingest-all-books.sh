#!/usr/bin/env bash
# Phase-3 Pass 3 — full literature/books/ corpus ingestion.
# Runs extract-source-cli.js in parallel batches with --max-chunks=5.
# Skips books with .epub or .xlsx extensions (pdf-parse can't read them)
# and skips already-ingested chalker_scott + magdoff.
set -u
cd "$(dirname "$0")"

LOG="phase3-ingest-$(date +%Y%m%d-%H%M%S).log"
PARALLEL=4
MAX_CHUNKS=5

# canonical source-type tag per directory
declare -A TYPE_BY_DIR=(
  [agroecology_general]=book
  [crop_ecology_horticulture]=book
  [entomology_ipm]=book
  [plant_pathology]=book
  [soil_science]=book
  [spatial_ecology]=book
)

declare -a JOBS=()

ingest_one() {
  local file="$1"
  local stype="$2"
  echo "[start] $(basename "$file")" >> "$LOG"
  node extract-source-cli.js --source-type="$stype" --max-chunks="$MAX_CHUNKS" "$file" \
    >> "$LOG" 2>&1
  echo "[end]   $(basename "$file") rc=$?" >> "$LOG"
}

cd_books="../literature/books"

# Build job list
for dir in "$cd_books"/*/; do
  cat=$(basename "$dir")
  stype="${TYPE_BY_DIR[$cat]:-book}"
  for file in "$dir"*.pdf; do
    [ -f "$file" ] || continue
    fname=$(basename "$file")
    # skip already ingested
    [[ "$fname" == "chalker_scott_companion_planting_myth.pdf" ]] && continue
    [[ "$fname" == "magdoff_van_es_building_soils_4th.pdf" ]] && continue
    JOBS+=("$file|$stype")
  done
done

echo "=== ingestion plan: ${#JOBS[@]} books, parallelism=$PARALLEL, max-chunks=$MAX_CHUNKS ===" | tee -a "$LOG"
for j in "${JOBS[@]}"; do echo "  $j" | tee -a "$LOG"; done

# Run with controlled parallelism
running=0
for j in "${JOBS[@]}"; do
  file="${j%|*}"; stype="${j#*|}"
  ingest_one "$file" "$stype" &
  running=$((running+1))
  if [ "$running" -ge "$PARALLEL" ]; then
    wait -n
    running=$((running-1))
  fi
done
wait

echo "=== all ingestion done at $(date) ===" | tee -a "$LOG"
