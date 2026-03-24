# Cron Setup — P4P Gmail Processor
# Runs every 2 hours, logs to ./logs/p4p-YYYY-MM-DD.log

# ── Step 1: Make the wrapper executable ───────────────────────────────────
chmod +x /path/to/gmail-server/run.sh

# ── Step 2: Open your crontab ─────────────────────────────────────────────
crontab -e

# ── Step 3: Add this line ─────────────────────────────────────────────────
# Replace /path/to/gmail-server with the actual absolute path on your machine.

0 */2 * * * /path/to/gmail-server/run.sh

# ── Cron expression breakdown ─────────────────────────────────────────────
# 0      → at minute 0
# */2    → every 2 hours (00:00, 02:00, 04:00 … 22:00)
# * * *  → every day, every month, every day-of-week

# ── Verify it was saved ───────────────────────────────────────────────────
crontab -l

# ── Check logs ────────────────────────────────────────────────────────────
tail -f /path/to/gmail-server/logs/p4p-$(date +%Y-%m-%d).log

# ── Common cron troubleshooting ───────────────────────────────────────────
# Cron uses a minimal environment — node must be full path (/usr/bin/node).
# run.sh already handles this. If node is elsewhere, find it with:
#   which node
#
# If cron mails errors and you don't want email:
# 0 */2 * * * /path/to/gmail-server/run.sh > /dev/null 2>&1
# (Not recommended — use the log file instead so errors are visible)
#
# To stop the cron job: remove the line with  crontab -e
# To disable temporarily: comment it out with #

# ── Log rotation (optional, prevents logs growing forever) ────────────────
# Logs are already split by day (p4p-2026-03-23.log etc.).
# To delete logs older than 30 days, add a second cron entry:
# 0 3 * * * find /path/to/gmail-server/logs -name "p4p-*.log" -mtime +30 -delete