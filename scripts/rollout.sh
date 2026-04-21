#!/bin/bash
# Sequential year-by-year import into Studio site. Handles the
# SinglePHPInstanceManager constraint by polling a cheap WP-CLI call
# between imports until the lock releases before firing the next one.
#
# Usage: bash scripts/rollout.sh <space-separated years>

set -euo pipefail

CONVERTER_DIR="/Users/edequalsawesome/Development/awesome-twitter-converter"
ARCHIVE="$CONVERTER_DIR/.archives/2026-04-16"
SKIP_IDS="$CONVERTER_DIR/.archives/skip-ids.txt"
SITE_DIR="$HOME/Studio/edequalsawesome"
SITE_URL="http://localhost:8884"
MEDIA_BASE="http://localhost:8884/wp-content/uploads/twitter-import/"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <year> [<year> ...]"
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

for YEAR in "$@"; do
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "YEAR: $YEAR"
  echo "════════════════════════════════════════════════════════════"

  WXR=".archives/$YEAR-rollout.xml"

  node index.js "$ARCHIVE" \
    --year "$YEAR" \
    --skip-ids "$SKIP_IDS" \
    --output "$WXR" \
    --site-url "$SITE_URL" \
    --author edequalsawesome \
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
