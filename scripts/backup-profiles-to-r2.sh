#!/usr/bin/env bash
set -euo pipefail

DON_DIR="${HOME}/Library/Application Support/DON"
if [ ! -d "${DON_DIR}" ]; then
  echo "Error: DON directory not found at ${DON_DIR}" >&2
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TMP_BACKUP="/tmp/don-profiles-backup-${TIMESTAMP}.tar.gz"
WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../cloudflare-sync-worker" && pwd)"

echo "==> Creating compressed archive of DON profiles & configurations..."
tar -czf "${TMP_BACKUP}" -C "${DON_DIR}" \
  profiles proxies data settings extensions vpn

SIZE=$(du -h "${TMP_BACKUP}" | awk '{print $1}')
echo "==> Backup archive created: ${TMP_BACKUP} (${SIZE})"

echo "==> Uploading snapshot to Cloudflare R2 (don-sync-bucket)..."
cd "${WORKER_DIR}"
npx wrangler r2 object put "don-sync-bucket/backups/don-profiles-backup-${TIMESTAMP}.tar.gz" --file="${TMP_BACKUP}"
npx wrangler r2 object put "don-sync-bucket/backups/latest.tar.gz" --file="${TMP_BACKUP}"

rm -f "${TMP_BACKUP}"
echo "==> Backup successfully uploaded to Cloudflare R2!"
echo "==> Snapshot Key: backups/don-profiles-backup-${TIMESTAMP}.tar.gz"
echo "==> Latest Key: backups/latest.tar.gz"
