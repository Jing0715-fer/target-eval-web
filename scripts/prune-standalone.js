#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * 部署包瘦身（standalone 产物冗余剔除）— 修复线上部署失败
 *
 * 背景：next build 的 standalone 产物会把整份 node_modules 依赖图拷进
 * .next/standalone，其中包含大量部署运行时永远用不到的平台二进制/方言包：
 * 打包后 next-service-dist 未压缩约 186MB（压缩 69MB），线上 FC 部署
 * 「很抱歉,当前生成的代码在部署时遇到了一些问题」的直接嫌疑就是包体
 * 过大 / 冷启动过慢（FUSE 存储上健康检查 120s 超时）。
 *
 * 本脚本在 patch-standalone 之后运行，只做三类**保守**剔除：
 *   1. @prisma/client/runtime 下非 SQLite 方言的 wasm-base64 冗余
 *      （本项目 SQLite + 原生 library 引擎，cockroachdb/mysql/postgresql/
 *      sqlserver 四方言各 ~5.5MB 永不加载；sqlite 方言全部保留）
 *   2. @img（sharp 图像库）的非本平台二进制：musl 变体（运行时为 Debian
 *      glibc）、darwin / win32 / arm64 变体（运行时为 linux x64）
 *   3. Next 16 内嵌 sharp（next/node_modules/sharp）下的 musl 平台二进制
 *      （~19.5MB；嵌套 glibc 变体因与外层疑似版本不同，ABI 兼容考虑保留）
 *
 * 不碰其它任何文件（next 本体、.prisma/client 引擎、playwright-core 均为
 * 运行必需，原样保留）。
 *
 * 健壮性：幂等可重复运行；目标不存在静默跳过；**任何异常只告警、永不
 * 非零退出**（瘦身是优化项，绝不能反过来弄挂构建链）。
 * SKIP_PRUNE_STANDALONE=1 可整体跳过。
 */
const fs = require('fs')
const path = require('path')

if (process.env.SKIP_PRUNE_STANDALONE === '1') {
  console.log('prune-standalone: SKIP_PRUNE_STANDALONE=1, skip')
  process.exit(0)
}

const root = __dirname ? path.join(__dirname, '..') : process.cwd()
const standaloneDir = path.join(root, '.next', 'standalone')

if (!fs.existsSync(path.join(standaloneDir, 'server.js'))) {
  console.log('prune-standalone: .next/standalone/server.js not found, skip')
  process.exit(0)
}

const nm = (p) => path.join(standaloneDir, 'node_modules', p)

/** 递归统计目录字节数（异常吞掉按 0 计） */
function treeSize(p) {
  try {
    const st = fs.lstatSync(p)
    if (st.isFile()) return st.size
    if (st.isDirectory()) {
      let n = 0
      for (const e of fs.readdirSync(p)) n += treeSize(path.join(p, e))
      return n
    }
  } catch {
    /* ignore */
  }
  return 0
}

let files = 0
let saved = 0
const summary = []

/** 删除文件或整目录（幂等，失败仅告警） */
function rm(target, label) {
  try {
    if (!fs.existsSync(target)) return
    const bytes = treeSize(target)
    fs.rmSync(target, { recursive: true, force: true })
    files += 1
    saved += bytes
    summary.push(`  - ${label}: ${path.relative(standaloneDir, target)} (${(bytes / 1048576).toFixed(1)}MB)`)
  } catch (err) {
    console.warn(`prune-standalone: WARN skip ${target}: ${err.message}`)
  }
}

try {
  // ── 1. @prisma/client/runtime：非 SQLite 方言的 wasm-base64 与加载器 ──
  const prismaRuntime = nm('@prisma/client/runtime')
  if (fs.existsSync(prismaRuntime)) {
    const KEEP_DIALECT = 'sqlite'
    // query_compiler_bg.<dialect>.* / query_engine_bg.<dialect>.*
    const dialectRe = /^query_(?:compiler|engine)_bg\.([a-z]+)\./
    for (const f of fs.readdirSync(prismaRuntime)) {
      const m = f.match(dialectRe)
      if (m && m[1] !== KEEP_DIALECT) {
        rm(path.join(prismaRuntime, f), `prisma 非${KEEP_DIALECT}方言`)
      }
    }
  } else {
    console.log('prune-standalone: @prisma/client/runtime 不存在，跳过 prisma 段')
  }

  // ── 2. @img（sharp）：只保留 linux-x64 glibc 变体 ──
  const imgDir = nm('@img')
  if (fs.existsSync(imgDir)) {
    // 运行时平台：linux x64 glibc（沙箱与部署镜像同为 Debian x64）
    // 保留：linux-x64 glibc 变体 + colour（纯 JS）；删除：musl / darwin / win32 / arm64
    const KEEP = ['sharp-libvips-linux-x64', 'sharp-linux-x64', 'colour']
    for (const d of fs.readdirSync(imgDir)) {
      if (!KEEP.includes(d)) {
        rm(path.join(imgDir, d), 'sharp 非本平台二进制')
      }
    }
  } else {
    console.log('prune-standalone: @img 不存在，跳过 sharp 段')
  }

  // ── 3. Next 16 内嵌 sharp（next/node_modules/sharp）：musl 二进制 ──
  // Next 的 standalone 会把图片优化用的 sharp 以嵌套依赖完整拷进自己名下
  // （node_modules/next/node_modules/sharp/node_modules/@img），其平台二进制
  // 独立于外层 @img，同样携带 musl 变体（libvips-musl ~19MB + loader-musl）
  // —— glibc 运行环境永不加载。嵌套的 glibc 变体与外层疑似版本不同，
  // 为 ABI 兼容保守保留（Next require 解析优先命中的就是嵌套这份）。
  const nestedImg = nm('next/node_modules/sharp/node_modules/@img')
  if (fs.existsSync(nestedImg)) {
    for (const d of fs.readdirSync(nestedImg)) {
      if (d.includes('musl')) {
        rm(path.join(nestedImg, d), 'Next 内嵌 sharp 的 musl 二进制')
      }
    }
  } else {
    console.log('prune-standalone: Next 内嵌 sharp @img 不存在，跳过嵌套 sharp 段')
  }
} catch (err) {
  // 兜底：任何未预见异常都不允许弄挂构建
  console.warn(`prune-standalone: WARN 主流程异常（忽略，不影响构建）: ${err.message}`)
}

if (files === 0) {
  console.log('prune-standalone: 无可剔除项（可能已瘦身过），完成')
} else {
  console.log(`prune-standalone: 剔除 ${files} 项，释放 ${(saved / 1048576).toFixed(1)}MB`)
  for (const line of summary) console.log(line)
}
console.log('prune-standalone: done')
