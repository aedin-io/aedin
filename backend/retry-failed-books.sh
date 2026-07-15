#!/usr/bin/env bash
# Retry the 8 books that hit chunk-level JSON parse failures in Pass 3.
# Now with chunk-level error tolerance + --max-chunks=8 for deeper body coverage.
set -u
cd "$(dirname "$0")"

LOG="phase3-retry-$(date +%Y%m%d-%H%M%S).log"
PARALLEL=4

# Books that ended up with [FAIL] in Pass 3 log:
JOBS=(
  "../literature/books/agroecology_general/medicinal_agroecology.pdf"
  "../literature/books/crop_ecology_horticulture/rubatzky_yamaguchi_world_vegetables_2nd_1995.pdf"
  "../literature/books/entomology_ipm/andow_biocontrol_1997.pdf"
  "../literature/books/entomology_ipm/dent_insect_pest_management_2nd.pdf"
  "../literature/books/entomology_ipm/omkar_insect_predators_2023.pdf"
  "../literature/books/entomology_ipm/omkar_parasitoids_2023.pdf"
  "../literature/books/plant_pathology/agrios_plant_pathology_5th.pdf"
  "../literature/books/plant_pathology/perry_moens_plant_nematology_3rd_2024.pdf"
)

ingest_one() {
  local file="$1"
  echo "[start] $(basename "$file")" >> "$LOG"
  node extract-source-cli.js --source-type=book --max-chunks=8 "$file" >> "$LOG" 2>&1
  echo "[end]   $(basename "$file") rc=$?" >> "$LOG"
}

echo "=== retry plan: ${#JOBS[@]} books, parallelism=$PARALLEL, max-chunks=8 ===" | tee -a "$LOG"

running=0
for f in "${JOBS[@]}"; do
  ingest_one "$f" &
  running=$((running+1))
  if [ "$running" -ge "$PARALLEL" ]; then
    wait -n
    running=$((running-1))
  fi
done
wait
echo "=== retry done at $(date) ===" | tee -a "$LOG"
