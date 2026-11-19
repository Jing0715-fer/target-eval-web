#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * production standalone 产物修补
 * 目的：让 .next/standalone 在任意机器/路径上都能找到 SQLite 数据库
 * 1. 复制 db/custom.db 到 standalone/db/（若存在）
 * 2. 在 server.js 开头注入 DATABASE_URL 解析（基于 server.js 所在目录），
 *    覆盖 .env 里的沙箱绝对路径
 */
const path = require('path')
const fs = require('fs')

const root = __dirname ? path.join(__dirname, '..') : process.cwd()
const standaloneDir = path.join(root, '.next', 'standalone')
const serverJs = path.join(standaloneDir, 'server.js')

if (!fs.existsSync(serverJs)) {
  console.error('patch-standalone: .next/standalone/server.js not found, skip')
  process.exit(0)
}

// 1. 数据库文件
const srcDb = path.join(root, 'db', 'custom.db')
const dstDbDir = path.join(standaloneDir, 'db')
if (fs.existsSync(srcDb)) {
  fs.mkdirSync(dstDbDir, { recursive: true })
  fs.copyFileSync(srcDb, path.join(dstDbDir, 'custom.db'))
  // 运行期缓存/报告目录
  for (const dir of ['cache', 'reports']) {
    const s = path.join(root, 'db', dir)
    const d = path.join(dstDbDir, dir)
    if (fs.existsSync(s)) {
      fs.cpSync(s, d, { recursive: true })
    }
  }
  console.log('patch-standalone: db/custom.db + cache/reports copied')
}

// 2. 注入 DATABASE_URL 解析（幂等）
const INJECT_MARK = '__PATCHED_DATABASE_URL__'
let code = fs.readFileSync(serverJs, 'utf8')
if (!code.includes(INJECT_MARK)) {
  const inject = `/* ${INJECT_MARK} */
const __path = require('path');
const __fs = require('fs');
const __db = __path.join(__dirname, 'db', 'custom.db');
if (__fs.existsSync(__db)) {
  process.env.DATABASE_URL = 'file:' + __db;
}
/* end ${INJECT_MARK} */
`
  code = inject + code
  fs.writeFileSync(serverJs, code)
  console.log('patch-standalone: server.js patched with dynamic DATABASE_URL')
} else {
  console.log('patch-standalone: server.js already patched')
}

// 3. standalone/.env 不再需要绝对路径（已被注入逻辑覆盖），保留其他变量
const envFile = path.join(standaloneDir, '.env')
if (fs.existsSync(envFile)) {
  const env = fs
    .readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('DATABASE_URL='))
    .join('\n')
  fs.writeFileSync(envFile, env)
  console.log('patch-standalone: standalone/.env DATABASE_URL removed (resolved at runtime)')
}

console.log('patch-standalone: done')
