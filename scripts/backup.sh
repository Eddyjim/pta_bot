#!/usr/bin/env bash
# Nightly encrypted snapshot. Litestream would give seconds of RPO; for a class group
# losing a day is a non-event and the facts are re-derivable from the group scrollback.
# This composes cleanly with encryption, which Litestream does not.
set -euo pipefail

DB="${DB_PATH:-/var/lib/pta-bot/pta.db}"
STAGE="/tmp/pta-$(date +%F).db"
AGE_RECIPIENT="${AGE_RECIPIENT:?set AGE_RECIPIENT to your age public key}"
REMOTE="${RCLONE_REMOTE:-r2:pta-bot-backups}"

# VACUUM INTO is consistent against a live WAL database; cp is not.
sqlite3 "$DB" "VACUUM INTO '$STAGE'"

age -r "$AGE_RECIPIENT" -o "$STAGE.age" "$STAGE"
rclone copy "$STAGE.age" "$REMOTE/daily/"
shred -u "$STAGE" "$STAGE.age"

# 14 dailies, 3 monthlies.
rclone delete "$REMOTE/daily/" --min-age 14d
if [ "$(date +%d)" = "01" ]; then
  rclone copy "$REMOTE/daily/" "$REMOTE/monthly/" --max-age 1d
  rclone delete "$REMOTE/monthly/" --min-age 93d
fi
