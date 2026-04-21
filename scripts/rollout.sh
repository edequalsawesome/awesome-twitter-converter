#!/bin/bash
# Sequential year-by-year import into a WordPress Studio site.
#
# Handles Studio's SinglePHPInstanceManager constraint by polling a cheap
# WP-CLI call between imports until the lock releases before firing the
# next one.
#
# Usage:
#   bash scripts/rollout.sh <year> [<year> ...]
#
# Configurable via env vars (all have reasonable defaults except SITE_DIR):
#
#   SITE_DIR         Studio site directory         (required; e.g. ~/Studio/mysite)
#   SITE_URL         Studio site URL               (default: http://localhost:8881)
#   CONVERTER_DIR    Path to this repo             (default: dir of this script's parent)
#   ARCHIVE          Path to the extracted archive (default: $CONVERTER_DIR/.archives/latest)
#   SKIP_IDS         File of tweet IDs to exclude  (default: $CONVERTER_DIR/.archives/skip-ids.txt)
#   AUTHOR           WP author login               (default: admin)
#   CATEGORY         WP category for posts         (default: Twitter)
#   MEDIA_BASE       Base URL for media in WXR     (default: $SITE_URL/wp-content/uploads/twitter-import/)
#
# Example:
#   SITE_DIR=~/Studio/mysite SITE_URL=http://localhost:8884 AUTHOR=myuser \
#     ARCHIVE=/path/to/extracted-archive \
#     bash scripts/rollout.sh 2019 2020 2021

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONVERTER_DIR="${CONVERTER_DIR:-$(dirname "$SCRIPT_DIR")}"
SITE_DIR="${SITE_DIR:?SITE_DIR env var is required (path to ~/Studio/<site>)}"
SITE_URL="${SITE_URL:-http://localhost:8881}"
ARCHIVE="${ARCHIVE:-$CONVERTER_DIR/.archives/latest}"
SKIP_IDS="${SKIP_IDS:-$CONVERTER_DIR/.archives/skip-ids.txt}"
AUTHOR="${AUTHOR:-admin}"
CATEGORY="${CATEGORY:-Twitter}"
MEDIA_BASE="${MEDIA_BASE:-$SITE_URL/wp-content/uploads/twitter-import/}"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <year> [<year> ...]"
  echo ""
  echo "Required env: SITE_DIR"
  echo "Optional env: SITE_URL, CONVERTER_DIR, ARCHIVE, SKIP_IDS, AUTHOR, CATEGORY, MEDIA_BASE"
  exit 1
fi

# Wait until studio wp is ready for a new command (PHP lock cleared)
wait_for_lock() {
  local tries=0
  while [ $tries -lt 60 ]; do
    if (cd "$SITE_DIR" && studio wp option get siteurl 2>&1 | grep -q "http"); then
      return 0
    fi
    tries=$((tries + 1))
    sleep 5
  done
  echo "⚠️  PHP lock still held after 5 min; proceeding anyway"
}

cd "$CONVERTER_DIR"

SKIP_ARGS=()
if [ -f "$SKIP_IDS" ]; then
  SKIP_ARGS=(--skip-ids "$SKIP_IDS")
fi

for YEAR in "$@"; do
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "YEAR: $YEAR"
  echo "════════════════════════════════════════════════════════════"

  WXR=".archives/$YEAR-rollout.xml"

  node index.js "$ARCHIVE" \
    --year "$YEAR" \
    "${SKIP_ARGS[@]}" \
    --output "$WXR" \
    --site-url "$SITE_URL" \
    --author "$AUTHOR" \
    --category "$CATEGORY" \
    --media-base-url "$MEDIA_BASE" \
    2>&1 | tail -12

  cp "$WXR" "$SITE_DIR/$YEAR-rollout.xml"

  echo ""
  echo "→ Waiting for PHP lock to clear before import..."
  wait_for_lock

  echo "→ Importing $YEAR..."
  (
    cd "$SITE_DIR"
    studio wp import "$YEAR-rollout.xml" --authors=create 2>&1 | tail -3
  ) || echo "⚠️  Import RPC timed out — server may still be processing"
done

echo ""
echo "════════════════════════════════════════════════════════════"
echo "All imports fired. Final counts (after a settle delay)..."
echo "════════════════════════════════════════════════════════════"
sleep 30
wait_for_lock
for YEAR in "$@"; do
  N=$(cd "$SITE_DIR" && studio wp post list \
    --post_type=post \
    --post_status=draft \
    --meta_key=_twitter_tweet_id \
    --year="$YEAR" \
    --format=count 2>&1 | tail -1 | tr -d '[:space:]')
  echo "  $YEAR: $N drafts"
  sleep 3
done
