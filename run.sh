#!/bin/bash
# run.sh — wrapper for cron execution
# Ensures the correct working directory and logs output with timestamps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/p4p-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

echo "" >> "$LOG_FILE"
echo "═══════════════════════════════════════════" >> "$LOG_FILE"
echo "▶  Started: $(date '+%Y-%m-%d %H:%M:%S')"   >> "$LOG_FILE"
echo "═══════════════════════════════════════════" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

# Run and log — stdout + stderr both captured
/usr/bin/node index.js >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "──────────────────────────────────────────" >> "$LOG_FILE"
echo "▶  Finished: $(date '+%Y-%m-%d %H:%M:%S') (exit $EXIT_CODE)" >> "$LOG_FILE"

exit $EXIT_CODE
