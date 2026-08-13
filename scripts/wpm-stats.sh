#!/usr/bin/env bash
# Calculate WPM statistics from voice-to-text logs using DuckDB.
# Usage: ./wpm-stats.sh [entries] [bins]
#   entries: Number of recent transcriptions to analyze (default: 100)
#   bins: Number of histogram bins (default: 15)

set -euo pipefail

ENTRIES="${1:-100}"
BINS="${2:-15}"

# Extract WPM values to temp CSV
TMP_CSV=$(mktemp /tmp/wpm-XXXXXX.csv)
trap 'rm -f "$TMP_CSV"' EXIT

echo "wpm" > "$TMP_CSV"
journalctl --user -u com.happytomatoe.VoiceToText.user.service --no-pager -n 10000 2>/dev/null \
  | grep "Transcription completed:" \
  | tail -n "$ENTRIES" \
  | grep -oP '\d+ words, \K[\d.]+(?= WPM)' \
  | head -n "$ENTRIES" \
  >> "$TMP_CSV"

# Check if we have data
LINE_COUNT=$(wc -l < "$TMP_CSV")
if [ "$LINE_COUNT" -le 1 ]; then
  echo "No transcription data found."
  exit 0
fi

# Run DuckDB
duckdb :memory: <<EOF
-- Create table from CSV
CREATE TABLE wpm AS SELECT CAST(wpm AS DOUBLE) AS value FROM read_csv_auto('${TMP_CSV}');

-- Stats
SELECT 
    COUNT(*) AS count,
    MEDIAN(value) AS median_wpm,
    MIN(value) AS min_wpm,
    MAX(value) AS max_wpm,
    SUM(value) AS total_words
FROM wpm;

-- Histogram using built-in function
SELECT * FROM histogram(wpm, value, bin_count := ${BINS});
EOF
