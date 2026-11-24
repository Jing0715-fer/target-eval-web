#!/bin/sh

set -e

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR"

# 存储所有子进程的 PID
pids=""

# 清理函数：优雅关闭所有服务
cleanup() {
    echo ""
    echo "🛑 正在关闭所有服务..."
    
    # 发送 SIGTERM 信号给所有子进程
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            service_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            echo "   关闭进程 $pid ($service_name)..."
            kill -TERM "$pid" 2>/dev/null
            # watchdog 子 shell 里的 bun 是其子进程，需一并终止
            pkill -TERM -P "$pid" 2>/dev/null || true
        fi
    done
    # 兜底：watchdog 重拉出的 Next 进程 PID 不在 pids 里，按命令行精确匹配
    pkill -TERM -f "next-service-dist/server.js" 2>/dev/null || true
    
    # 等待所有进程退出（最多等待 5 秒）
    sleep 1
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            # 如果还在运行，等待最多 4 秒
            timeout=4
            while [ $timeout -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
                sleep 1
                timeout=$((timeout - 1))
            done
            # 如果仍然在运行，强制关闭
            if kill -0 "$pid" 2>/dev/null; then
                echo "   强制关闭进程 $pid..."
                kill -KILL "$pid" 2>/dev/null
            fi
        fi
    done
    pkill -KILL -f "next-service-dist/server.js" 2>/dev/null || true
    
    echo "✅ 所有服务已关闭"
    exit 0
}

echo "🚀 开始启动所有服务..."
echo ""

# 切换到构建目录
cd "$BUILD_DIR" || exit 1

ls -lah

DEFAULT_PACKAGED_DB_PATH="/app/db/custom.db"
DEFAULT_PACKAGED_DATABASE_URL="file:$DEFAULT_PACKAGED_DB_PATH"

# Python 依赖在构建阶段安装进部署产物，不复用 Sandbox 的 /home/z/.venv。
# Next.js 及其启动的子进程都会继承这组路径。
if [ -d "/app/python-runtime/site-packages" ]; then
    export PYTHONPATH="/app/python-runtime/site-packages:/app/next-service-dist${PYTHONPATH:+:$PYTHONPATH}"
    export PATH="/app/python-runtime/site-packages/bin:$PATH"
    export PYTHONDONTWRITEBYTECODE=1
    export PYTHONUNBUFFERED=1
    echo "🐍 已启用部署包内 Python runtime: $(python --version 2>&1)"
fi

# 启动 Next.js 服务器
if [ -f "./next-service-dist/server.js" ]; then
    echo "🚀 启动 Next.js 服务器..."
    cd next-service-dist/ || exit 1
    
    # 设置环境变量
    export NODE_ENV=production
    export PORT="${PORT:-3000}"
    export HOSTNAME="${HOSTNAME:-0.0.0.0}"
    export DATABASE_URL="${DATABASE_URL:-$DEFAULT_PACKAGED_DATABASE_URL}"

    if [ "$DATABASE_URL" = "$DEFAULT_PACKAGED_DATABASE_URL" ]; then
        if [ ! -f "$DEFAULT_PACKAGED_DB_PATH" ]; then
            echo "❌ 未找到打包后的数据库文件 $DEFAULT_PACKAGED_DB_PATH"
            echo "   为避免生产环境启动到空数据库，启动已终止"
            exit 1
        fi

        echo "🗄️  当前使用打包数据库: $DEFAULT_PACKAGED_DB_PATH"
    else
        echo "🗄️  当前使用外部指定数据库: $DATABASE_URL"
    fi
    
    # 后台启动 Next.js（带崩溃自动重启 watchdog）
    # - 首次启动即失败：watchdog 直接退出（保持「启动失败」语义，
    #   交给平台健康检查暴露问题，不做无意义的重试）
    # - 运行期崩溃退出：2 秒后自动重拉，避免整实例失联只能重新部署
    # - bun --smol：JSC 省内存模式（更激进 GC、收紧缓存）。v2.71 流式
    #   链路堆峰值 26MB 远离实例上限；此为防御纵深——若未来出现内存
    #   泄漏，bun 高压回收而非吃光实例内存触发容器级 OOM-kill（连
    #   watchdog 一起灭掉、网关 502 持续，即 2026-11-24 线上「生成
    #   汇总报告崩溃」的形态——进程级 watchdog 对 cgroup 级 OOM 无
    #   能为力，根治靠 v2.71 内存修复，本防线降低复发烈度）
    (
        first_run=1
        while :; do
            bun --smol server.js
            code=$?
            if [ "$first_run" -eq 1 ] && [ "$code" -ne 0 ]; then
                echo "❌ Next.js 首次启动失败 (code=$code)，watchdog 退出"
                exit "$code"
            fi
            first_run=0
            echo "⚠️ Next.js 运行中退出 (code=$code)，2 秒后自动重启..."
            sleep 2
        done
    ) &
    NEXT_PID=$!
    pids="$NEXT_PID"
    
    # 等待一小段时间检查进程是否成功启动
    sleep 1
    if ! kill -0 "$NEXT_PID" 2>/dev/null; then
        echo "❌ Next.js 服务器启动失败"
        exit 1
    else
        echo "✅ Next.js 服务器已启动 (watchdog PID: $NEXT_PID, Port: $PORT)"
    fi
    
    cd ../
else
    echo "⚠️  未找到 Next.js 服务器文件: ./next-service-dist/server.js"
fi

# 启动 mini-services
if [ -f "./mini-services-start.sh" ]; then
    echo "🚀 启动 mini-services..."
    
    # 运行启动脚本（从根目录运行，脚本内部会处理 mini-services-dist 目录）
    sh ./mini-services-start.sh &
    MINI_PID=$!
    pids="$pids $MINI_PID"
    
    # 等待一小段时间检查进程是否成功启动
    sleep 1
    if ! kill -0 "$MINI_PID" 2>/dev/null; then
        echo "⚠️  mini-services 可能启动失败，但继续运行..."
    else
        echo "✅ mini-services 已启动 (PID: $MINI_PID)"
    fi
elif [ -d "./mini-services-dist" ]; then
    echo "⚠️  未找到 mini-services 启动脚本，但目录存在"
else
    echo "ℹ️  mini-services 目录不存在，跳过"
fi

# 启动 Caddy（如果存在 Caddyfile）
echo "🚀 启动 Caddy..."

# Caddy 作为前台进程运行（主进程）
echo "✅ Caddy 已启动（前台运行）"
echo ""
echo "🎉 所有服务已启动！"
echo ""
echo "💡 按 Ctrl+C 停止所有服务"
echo ""

# Caddy 作为主进程运行
exec caddy run --config Caddyfile --adapter caddyfile
