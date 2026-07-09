#!/bin/bash
# ─── jibbit.ch Backup Script ────────────────────────────────
# Nächtlicher PostgreSQL-Dump → GPG-verschlüsselt → S3 (Infomaniak)
#
# Cronjob (crontab -e):
#   0 2 * * * /opt/jibbit/scripts/backup.sh >> /var/log/jibbit-backup.log 2>&1
#
# Voraussetzungen:
#   - aws-cli (für S3-kompatiblen Speicher)
#   - gpg (mit importiertem Public Key)
#   - PostgreSQL Client Tools (pg_dump)

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────
BACKUP_DIR="/tmp/jibbit-backups"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-medusa}"
DB_USER="${DB_USER:-medusa}"
PGPASSWORD="${PGPASSWORD:?PGPASSWORD must be set}"
export PGPASSWORD

# S3-kompatibel (Infomaniak Swiss Backup / Object Storage)
S3_BUCKET="${S3_BUCKET:?S3_BUCKET must be set}"
S3_ENDPOINT="${S3_ENDPOINT:-https://s3.pub1.infomaniak.cloud}"
S3_PREFIX="jibbit-backups"

# GPG Encryption
GPG_RECIPIENT="${GPG_RECIPIENT:?GPG_RECIPIENT must be set}"

# Retention: 30 Tage lokal, unbegrenzt in S3
RETENTION_DAYS=30

# ─── Backup ─────────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="${BACKUP_DIR}/jibbit_${TIMESTAMP}.sql"
ENCRYPTED_FILE="${DUMP_FILE}.gpg"

mkdir -p "${BACKUP_DIR}"

echo "[$(date)] Starting backup..."

# SQL Dump (custom format für pg_restore Kompatibilität)
pg_dump \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  -Fc \
  --no-owner \
  --no-acl \
  -f "${DUMP_FILE}"

DUMP_SIZE=$(stat -c%s "${DUMP_FILE}" 2>/dev/null || stat -f%z "${DUMP_FILE}")
echo "[$(date)] Dump created: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# ─── Encrypt ────────────────────────────────────────────────
gpg --batch --yes --recipient "${GPG_RECIPIENT}" \
  --output "${ENCRYPTED_FILE}" \
  --encrypt "${DUMP_FILE}"

echo "[$(date)] Encrypted: ${ENCRYPTED_FILE}"

# Unverschlüsseltes Dump sofort löschen
rm -f "${DUMP_FILE}"

# ─── Upload to S3 ───────────────────────────────────────────
aws s3 cp "${ENCRYPTED_FILE}" \
  "s3://${S3_BUCKET}/${S3_PREFIX}/jibbit_${TIMESTAMP}.sql.gpg" \
  --endpoint-url "${S3_ENDPOINT}" \
  --storage-class STANDARD

echo "[$(date)] Uploaded to S3: s3://${S3_BUCKET}/${S3_PREFIX}/jibbit_${TIMESTAMP}.sql.gpg"

# ─── Cleanup: Alte lokale Backups ────────────────────────────
find "${BACKUP_DIR}" -name "jibbit_*.sql.gpg" -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Cleaned up backups older than ${RETENTION_DAYS} days"

echo "[$(date)] Backup complete."
