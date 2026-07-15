#!/usr/bin/env bash
# backup-globi-to-nas.sh
#
# Nightly backup of backend/globi.sqlite to a Synology NAS (or any host
# reachable over SSH). Uses SQLite's .backup command to produce a
# consistent snapshot even while the database is open.
#
# Configure once by either:
#   (a) Editing the variables below, OR
#   (b) Creating ~/.agroeco-backup.conf with overrides (the script
#       sources it if present, keeping NAS credentials out of git).
#
# Schedule via cron:
#   crontab -e
#   0 3 * * * /home/beef/projects/agroeco/backend/scripts/backup-globi-to-nas.sh >> /home/beef/.local/share/agroeco-backup.log 2>&1

set -euo pipefail

# ─── Defaults (override in ~/.agroeco-backup.conf) ───────────────────────
SOURCE_DB="/home/beef/projects/agroeco/backend/globi.sqlite"
NAS_HOST="REPLACE_WITH_NAS_HOSTNAME_OR_IP"   # e.g. 192.168.1.100 or yournas.local
NAS_USER="REPLACE_WITH_NAS_USERNAME"          # your Synology DSM user
NAS_PATH="/volume1/backups/agroeco"           # path on the NAS
SSH_PORT="22"                                 # Synology default; change if you moved it
KEEP_DAYS=30                                  # how many nightly snapshots to retain on the NAS
TEMP_DIR="${TMPDIR:-/tmp}"

# Load user-local overrides if present (NOT tracked by git)
USER_CONFIG="${HOME}/.agroeco-backup.conf"
if [[ -f "$USER_CONFIG" ]]; then
  # shellcheck source=/dev/null
  source "$USER_CONFIG"
fi

# ─── Sanity checks ───────────────────────────────────────────────────────
if [[ ! -f "$SOURCE_DB" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: source DB not found at $SOURCE_DB"
  exit 1
fi

if [[ "$NAS_HOST" == "REPLACE_WITH_"* ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: configure NAS_HOST in ~/.agroeco-backup.conf or edit this script"
  exit 1
fi

# ─── Take a consistent SQLite snapshot ───────────────────────────────────
TIMESTAMP="$(date +%Y%m%d-%H%M)"
BACKUP_NAME="globi.sqlite.${TIMESTAMP}"
TEMP_BACKUP="${TEMP_DIR}/${BACKUP_NAME}"

# Ensure the local temp snapshot is cleaned up even if the transfer fails.
# Without this trap, a failed scp/rsync leaves a multi-GB file in /tmp every
# time the script errors out — fills the disk surprisingly fast on retries.
trap 'rm -f "$TEMP_BACKUP"' EXIT

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Creating SQLite snapshot at ${TEMP_BACKUP}..."
sqlite3 "$SOURCE_DB" ".backup '${TEMP_BACKUP}'"

ORIGINAL_SIZE=$(stat -c '%s' "$SOURCE_DB" 2>/dev/null || stat -f '%z' "$SOURCE_DB")
BACKUP_SIZE=$(stat -c '%s' "$TEMP_BACKUP" 2>/dev/null || stat -f '%z' "$TEMP_BACKUP")
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Snapshot complete. Source: ${ORIGINAL_SIZE} bytes, snapshot: ${BACKUP_SIZE} bytes."

# ─── Push to NAS over SSH (rsync, not scp) ───────────────────────────────
# rsync uses ssh transport but does NOT require the SFTP subsystem on the
# remote — which Synology disables by default. rsync also resumes partial
# transfers if the network drops mid-push, which matters for multi-GB DBs.
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pushing to ${NAS_USER}@${NAS_HOST}:${NAS_PATH}/..."
ssh -p "$SSH_PORT" "${NAS_USER}@${NAS_HOST}" "mkdir -p '${NAS_PATH}'"
rsync -av --partial --progress -e "ssh -p ${SSH_PORT}" \
  "$TEMP_BACKUP" "${NAS_USER}@${NAS_HOST}:${NAS_PATH}/"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Push complete."

# ─── Prune old backups on the NAS (keep last $KEEP_DAYS) ─────────────────
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pruning NAS backups older than ${KEEP_DAYS} days..."
ssh -p "$SSH_PORT" "${NAS_USER}@${NAS_HOST}" "
  cd '${NAS_PATH}' || exit 0
  ls -t globi.sqlite.* 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | xargs -r rm -f
  echo '  Retained:'; ls -t globi.sqlite.* 2>/dev/null | head -5
  echo '  ...'
  echo '  Total snapshots on NAS:' \$(ls globi.sqlite.* 2>/dev/null | wc -l)
"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup run complete."
