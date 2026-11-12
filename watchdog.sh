#!/bin/bash
cd /home/z/my-project
while true; do
  if ! pgrep -f "next-server" > /dev/null; then
    echo "[$(date)] Restarting server..." >> /tmp/watchdog.log
    npx next dev -p 3000 > /home/z/my-project/dev.log 2>&1 &
    sleep 8
    # Pre-warm
    curl -s -o /dev/null http://127.0.0.1:3000/ 2>/dev/null
  fi
  sleep 3
done
