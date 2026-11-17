#!/bin/bash
# target-eval-web 开发服务器守护进程：被杀自动重启
# v2: 增加 upload 分片上传路由自愈（沙箱环境重置会反复删除该路由，
#     环境重置周期约 30 分钟，本守护 2 秒检测即可在重置后立即恢复）
cd /home/z/my-project
UPLOAD_ROUTE="src/app/api/evaluate/upload/route.ts"

restore_upload_route() {
  if [ ! -f "$UPLOAD_ROUTE" ]; then
    echo "[$(date)] upload route missing, restoring..." >> /tmp/target-eval-keepalive.log
    git checkout HEAD -- src/app/api/evaluate/upload/ 2>/dev/null \
      || git checkout origin/main -- src/app/api/evaluate/upload/ 2>/dev/null
    if [ -f "$UPLOAD_ROUTE" ]; then
      echo "[$(date)] upload route restored" >> /tmp/target-eval-keepalive.log
    else
      echo "[$(date)] WARN: restore failed, both HEAD and origin/main lack route" >> /tmp/target-eval-keepalive.log
    fi
  fi
}

while true; do
  if ! pgrep -f "next dev" > /dev/null 2>&1; then
    echo "[$(date)] Starting server..." >> /tmp/target-eval-keepalive.log
    restore_upload_route
    MALLOC_ARENA_MAX=2 NODE_OPTIONS="--max-old-space-size=1400" \
      node node_modules/.bin/next dev -p 3000 >> /home/z/my-project/dev.log 2>&1 &
    disown
    sleep 6
    # 预热首页（触发 Turbopack 首次编译）
    curl -s -o /dev/null --max-time 60 http://127.0.0.1:3000/ 2>/dev/null
    curl -s -o /dev/null --max-time 60 http://127.0.0.1:3000/ 2>/dev/null
  else
    # 服务器存活时仍需检测路由文件（环境重置可能只删文件不杀进程）
    restore_upload_route
  fi
  sleep 2
done
