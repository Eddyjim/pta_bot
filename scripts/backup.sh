#!/usr/bin/env bash
# Nightly encrypted snapshot. Litestream would give seconds of RPO; for a class group
# losing a day is a non-event and the facts are re-derivable from the group scrollback.
# This composes cleanly with encryption, which Litestream does not.
set -euo pipefail

DATA_DIR="${DB_DIR:-/var/lib/pta-bot/data}"
AGE_RECIPIENT="${AGE_RECIPIENT:?set AGE_RECIPIENT to your age public key}"
REMOTE="${RCLONE_REMOTE:-r2:pta-bot-backups}"
DATE_TAG="$(date +%F)"

# If age or rclone fails partway through the per-file loop below, `set -e` aborts the
# script without cleaning up that file's plaintext VACUUM INTO staging copy -- this is
# unencrypted data (message bodies, children's names) that would otherwise linger in
# /tmp indefinitely (the filename is date-tagged, so a later successful run doesn't
# overwrite or clean it up). Glob matches snapshot_one()'s $stage pattern below.
trap 'rm -f /tmp/pta-*-${DATE_TAG}.db /tmp/pta-*-${DATE_TAG}.db.age' EXIT

snapshot_one() {
  local db_file="$1"
  local name
  name="$(basename "$db_file" .db)"
  local stage="/tmp/pta-${name}-${DATE_TAG}.db"

  # VACUUM INTO is consistent against a live WAL database; cp is not.
  sqlite3 "$db_file" "VACUUM INTO '$stage'"
  age -r "$AGE_RECIPIENT" -o "$stage.age" "$stage"
  rclone copy "$stage.age" "$REMOTE/daily/"
  shred -u "$stage" "$stage.age"
}

for db_file in "$DATA_DIR"/*.db; do
  [ -e "$db_file" ] || continue
  snapshot_one "$db_file"
done

# 14 dailies, 3 monthlies -- same retention as before, applied once, not per file,
# since every file's snapshot landed in the same daily/ prefix.
rclone delete "$REMOTE/daily/" --min-age 14d
if [ "$(date +%d)" = "01" ]; then
  rclone copy "$REMOTE/daily/" "$REMOTE/monthly/" --max-age 1d
  rclone delete "$REMOTE/monthly/" --min-age 93d
fi
