/**
 * v2.21 回归 — 「评估进行中」UI 重构 + 完成后日志回看：
 *
 *  A. 日志控制台 log-console.tsx（新组件）能力面：
 *     智能跟随（上翻暂停/回底恢复）、级别过滤、关键字搜索、复制、
 *     下载 .txt、展开/收起、行号、>1500 行渲染截断护栏、break-words 词边界换行
 *  B. progress-panel.tsx 重构面：
 *     · 兜底阶段列表对齐后端 STAGE_DEFS（旧 fallback 硬编码漂移已删）
 *     · 排队态阶段一律 pending（防御异常快照）
 *     · 元数据条（已用时/阶段/批量）+ 逐靶点批量 chips
 *     · 使用 EvalLogConsole；旧 LogCard 已移除
 *  C. result-view.tsx：完成后「运行日志」回看章节（含 warning/error 计数）
 *  D. error-panel.tsx：失败日志同样换用 EvalLogConsole（live=false）
 *
 * 纯静态源断言（无需 dev server）；结构性回归与 tsc 增量互为补充。
 * 运行：node scripts/regress-progress-ui.mjs
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

let fail = 0
function ok(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) fail++
}
function okIn(srcName, name, ...needles) {
  const src = read(srcName)
  ok(`${name} (${srcName})`, needles.every((n) => src.includes(n)))
}

// ── A. 日志控制台 ────────────────────────────────────────────────────────────
const consoleSrc = 'src/components/eval/log-console.tsx'
ok(`${consoleSrc} 存在`, fs.existsSync(consoleSrc))
okIn(consoleSrc, '智能跟随：滚动暂停 + 回底恢复（followRef/paused/resumeFollow）', 'followRef', 'setPaused', 'resumeFollow')
okIn(consoleSrc, '级别过滤（全部/警告与错误）', "'issues'", '警告/错误')
okIn(consoleSrc, '关键字搜索 + 清除', 'aria-label="日志关键字筛选"', "setQuery('')")
okIn(consoleSrc, '复制全部（剪贴板 + execCommand 降级）', 'navigator.clipboard', 'execCommand')
okIn(consoleSrc, '下载 .txt', 'TargetEval_log_', 'text/plain;charset=utf-8')
okIn(consoleSrc, '展开/收起高度切换', 'setExpanded', 'max-h-[70vh]')
okIn(consoleSrc, '行号（与复制/下载全文一致）', 'r.no')
okIn(consoleSrc, '超长渲染护栏（仅最近 MAX_RENDER 行）', 'MAX_RENDER', '未在视口渲染')
okIn(consoleSrc, '词边界换行（不再 break-all 拆单词）', 'break-words')
okIn(consoleSrc, 'live/static 双模式（结果页回看不自动滚）', 'live?: boolean', 'live = true')
okIn(consoleSrc, 'lin-terminal 级别配色体系', 'lin-terminal-line', 'data-level={r.level}')

// ── B. 进度面板重构 ─────────────────────────────────────────────────────────
const panelSrc = 'src/components/eval/progress-panel.tsx'
const panel = read(panelSrc)
okIn(panelSrc, '兜底阶段列表对齐后端 STAGE_DEFS（消除硬编码漂移）', "import { STAGE_DEFS } from '@/lib/eval/types'", 'STAGE_DEFS.map')
ok('旧 fallback 硬编码漂移已清除（无「PDBe 映射」等旧文案）', !panel.includes('PDBe 映射') && !panel.includes('（可选）'))
ok('排队态阶段一律 pending（防御异常快照）', panel.includes("isQueued") && /isQueued\s*\?\s*rawStages\.map/.test(panel))
okIn(panelSrc, '元数据条：已用时 / 阶段进度 / 批量进度', '已用时', '阶段', '批量')
okIn(panelSrc, '状态徽标（排队/评估中/关系判断/合并报告）', '排队中', '评估中', '关系判断中')
okIn(panelSrc, '逐靶点批量状态 chips', 'batch.items.map', 'BatchItemIcon')
okIn(panelSrc, '阶段时间线：编号 + 连接线 + 激活高亮', 'String(i + 1).padStart(2', 'self-stretch', 'bg-primary/[0.05]')
okIn(panelSrc, '使用新日志控制台（live 模式）', 'EvalLogConsole', '<EvalLogConsole logs={job?.logs ?? []} live />')
ok(`旧 LogCard 已从 ${panelSrc} 移除`, !panel.includes('export function LogCard'))
okIn(panelSrc, 'GOAL 摘要卡（两行截断 + title 全文）', 'line-clamp-2', 'title={job.goal}')

// ── C. 结果页日志回看 ──────────────────────────────────────────────────────
const resultSrc = 'src/components/eval/result-view.tsx'
const result = read(resultSrc)
okIn(resultSrc, '运行日志章节（完成后回看）', 'title="运行日志"', 'en="Run Logs"', '<EvalLogConsole logs={logLines} live={false} />')
okIn(resultSrc, '章节按存在性编号 + 行/警告/错误计数', 'const logNo = logLines.length > 0 ? nextNo() : null', 'logWarn', 'logErr')
ok('摘要缺失兜底分支也提供日志回看', result.includes('(job.logs ?? []).length > 0 && <EvalLogConsole logs={job.logs ?? []} live={false} />'))

// ── D. 失败视图 ────────────────────────────────────────────────────────────
okIn('src/components/eval/error-panel.tsx', '失败日志换用日志控制台（静态回看）', "from './log-console'", 'live={false}')
const errPanel = read('src/components/eval/error-panel.tsx')
ok(`error-panel 不再引用已删除的 LogCard`, !errPanel.includes('LogCard'))

// ── E. 契约完整性：types 双向一致 ──────────────────────────────────────────
const libTypes = read('src/lib/eval/types.ts')
const keys = ['input', 'uniprot', 'rcsb', 'pdbe', 'pubmed', 'blast', 'score', 'report']
ok(
  'STAGE_DEFS 顺序 = 真实管线（文献检索先于 BLAST）',
  keys.every((k) => libTypes.includes(`key: '${k}'`)) &&
    libTypes.indexOf("key: 'pubmed'") < libTypes.indexOf("key: 'blast'"),
)

console.log(fail === 0 ? '\nv2.21 回归全部通过' : `\n回归失败（${fail} 项）`)
process.exit(fail === 0 ? 0 : 1)
