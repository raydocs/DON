#!/usr/bin/env bash
set -euo pipefail

DON_DIR="${HOME}/Library/Application Support/DON"
WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../cloudflare-sync-worker" && pwd)"
BACKUP_KEY="${1:-backups/latest.tar.gz}"
TMP_RESTORE="/tmp/don-restore-$(date +%Y%m%d-%H%M%S).tar.gz"

echo "==> Downloading backup from Cloudflare R2 (${BACKUP_KEY})..."
cd "${WORKER_DIR}"
npx wrangler r2 object get "don-sync-bucket/${BACKUP_KEY}" --file="${TMP_RESTORE}"

echo "==> Restoring to ${DON_DIR}..."
mkdir -p "${DON_DIR}"
tar -xzf "${TMP_RESTORE}" -C "${DON_DIR}"

rm -f "${TMP_RESTORE}"
echo "==> Profiles & configurations successfully restored from Cloudflare R2!"
