#!/bin/bash
# target-eval-web 开发服务器守护进程：被杀自动重启
cd /home/z/my-project
while true; do
  if ! pgrep -f "next dev" > /dev/null 2>&1; then
    echo "[$(date)] Starting server..." >> /tmp/target-eval-keepalive.log
    MALLOC_ARENA_MAX=2 NODE_OPTIONS="--max-old-space-size=1400" \
      node node_modules/.bin/next dev -p 3000 >> /home/z/my-project/dev.log 2>&1 &
    disown
    sleep 6
    # 预热首页（触发 Turbopack 首次编译）
    curl -s -o /dev/null --max-time 60 http://127.0.0.1:3000/ 2>/dev/null
    curl -s -o /dev/null --max-time 60 http://127.0.0.1:3000/ 2>/dev/null
  fi
  sleep 2
done
