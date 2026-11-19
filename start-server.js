#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * dev server 存活启动器
 * - detached + unref：脱离 Bash 工具会话的进程树，避免会话结束被平台清理
 * - stdout/stderr 重定向到 dev.log：保留日志供诊断
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const projectDir = __dirname
const nextBin = path.join(projectDir, 'node_modules', '.bin', 'next')
const logFile = path.join(projectDir, 'dev.log')

fs.mkdirSync(path.dirname(logFile), { recursive: true })
const out = fs.openSync(logFile, 'a')
const err = fs.openSync(logFile, 'a')

const env = Object.assign({}, process.env, {
  MALLOC_ARENA_MAX: '2',
  NODE_OPTIONS: '--max-old-space-size=1400',
})

const child = spawn(nextBin, ['dev', '-p', '3000'], {
  cwd: projectDir,
  stdio: ['ignore', out, err],
  detached: true,
  env,
})

child.unref()
fs.writeSync(out, `\n[${new Date().toISOString()}] start-server.js launched next dev (PID ${child.pid})\n`)
console.log(`Next.js dev server started with PID: ${child.pid} (logs -> ${logFile})`)
