#!/bin/bash
# Script to clear common Puppeteer lock files and zombie processes
echo "Cleaning up WhatsApp/Chromium session locks..."

# Kill any existing chromium processes
pkill -f chromium 2>/dev/null
pkill -f chrome 2>/dev/null

# Remove the specific lock file that causes the "browser is already running" error
LOCK_FILE="./auth_info/session/SingletonLock"
if [ -f "$LOCK_FILE" ]; then
    rm "$LOCK_FILE"
    echo "✅ Removed stale lock: $LOCK_FILE"
else
    echo "ℹ️ No lock file found at $LOCK_FILE"
fi

echo "Done. You can now run: npm run dev"
