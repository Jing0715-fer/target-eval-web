/**
 * v2.22 回归 — 高通量评估模式：
 *
 *  A. format.ts：parseGroupedUniprotIds 分组语义（; 组 / 组内 , 与空白 / 全角标点 /
 *     全局去重 / 无效 token / isoform；真实函数级测试 — 单文件 tsc 编译后 require）
 *  B. use-high-throughput-flow.ts：限流指纹 isRateLimitError / 自动暂停 pauseWithReason /
 *     断点续跑 resumeRun / 报告 LLM 全失败检测（reportLlmOk）/ 恢复时接上在跑作业（reattach）
 *  C. high-throughput-store.ts：localStorage te_ht_runs_v1 / 保留 5 份历史 / interrupted 标记
 *  D. input-panel.tsx：第 4 个「高通量」Tab（Zap）+ 分组载荷 onStartHighThroughput
 *  E. page.tsx：HT 视图优先渲染 + 历史入口守卫（running 不切换视图）+ InputPanel 新 props
 *  F. high-throughput-progress.tsx：复用 ProgressPanel（组内进度继承）+ 完成后日志回看
 *     （EvalLogConsole live=false）+ 暂停横幅「重新开始运行」
 *  G. use-evaluation-flow.ts：编排复用符号已导出（autoDownloadHtmlReport 等）
 *
 * 运行：node scripts/regress-v2.22.0.mjs
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)

const root = process.cwd()
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let fail = 0
function ok(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) fail++
}
function okIn(srcName, name, ...needles) {
  const src = read(srcName)
  ok(`${name} (${srcName})`, needles.every((n) => src.includes(n)))
}

// ── A. 分组解析（真实函数级：单文件编译后 require） ──────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-regress-'))
try {
  execFileSync(
    'npx',
    ['tsc', 'src/components/eval/format.ts', '--outDir', tmpDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' },
  )
  const { parseGroupedUniprotIds, MAX_HT_GROUPS, MAX_HT_TARGETS_TOTAL } = require(path.join(tmpDir, 'format.js'))

  const cases = [
    {
      name: '基本分组：; 分组、组内 , 分隔',
      input: 'P04637, P00533; Q9Y6K9',
      expect: [['P04637', 'P00533'], ['Q9Y6K9']],
    },
    {
      name: '全角标点「；」「，」与换行空白混合',
      input: 'P04637，P00533；\nQ9Y6K9',
      expect: [['P04637', 'P00533'], ['Q9Y6K9']],
    },
    {
      name: '单靶点组（独立评估语义）',
      input: 'P04637; P00533, Q9Y6K9; O14746',
      expect: [['P04637'], ['P00533', 'Q9Y6K9'], ['O14746']],
    },
    {
      name: '全局去重：后出现组剔除重复靶点',
      input: 'P04637; P04637, P00533',
      expect: [['P04637'], ['P00533']],
    },
    {
      name: '无效 token 进 invalid（p53 非法编号）',
      input: 'P04637; p53',
      expectInvalid: ['P53'],
    },
    {
      name: 'isoform 后缀合法（Q04206-2）',
      input: 'Q04206-2',
      expect: [['Q04206-2']],
    },
    {
      name: '空输入 → 零组',
      input: '',
      expect: [],
    },
    {
      name: '空组跳过（连续分号）',
      input: 'P04637;; P00533 ;',
      expect: [['P04637'], ['P00533']],
    },
  ]
  for (const c of cases) {
    const r = parseGroupedUniprotIds(c.input)
    const groupsOk = c.expect ? JSON.stringify(r.groups) === JSON.stringify(c.expect) : true
    const invalidOk = c.expectInvalid
      ? JSON.stringify(r.invalid) === JSON.stringify(c.expectInvalid)
      : true
    ok(`分组解析：${c.name}`, groupsOk && invalidOk)
  }
  ok('分组去重提示：重复 token 列入 duplicates', JSON.stringify(parseGroupedUniprotIds('P04637; P04637').duplicates) === JSON.stringify(['P04637']))
  ok('高通量上限常量：组 12 / 靶点总数 30（与服务端日配额对齐）', MAX_HT_GROUPS === 12 && MAX_HT_TARGETS_TOTAL === 30)
} catch (e) {
  ok('分组解析函数可编译加载', false)
  console.error(String(e).slice(0, 400))
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// ── B. 编排 hook ────────────────────────────────────────────────────────────
const flowSrc = 'src/components/eval/use-high-throughput-flow.ts'
ok(`${flowSrc} 存在`, fs.existsSync(flowSrc))
okIn(flowSrc, '限流指纹（429/rate limit/限流/配额/每日上限）', 'isRateLimitError', 'too many requests', '每日上限')
okIn(flowSrc, '限流自动暂停（记原因 + 断点持久化 + toast）', 'pauseWithReason', '高通量评估已自动暂停', 'pausedReason')
okIn(flowSrc, '配额恢复后手动重新开始（断点续跑）', 'resumeRun', 'resumedCount', '重新开始')
okIn(flowSrc, '报告 LLM 全失败 = 限流暂停信号（reportLlmOk）', 'reportLlmOk !== true', 'LLM 全章节未产出')
okIn(flowSrc, '恢复时接上服务器侧仍在跑的作业（不重复创建）', 'reattachOne', 'waitForJobTerminal')
okIn(flowSrc, '组间串行 + 组内 2 并发窗口', 'HT_WINDOW = 2', 'for (let gi = 0')
okIn(flowSrc, '组内复用复合物批量链路（关系判断 + 合并报告）', 'judgeTargetRelation', 'generateBatchReport', 'deferred')
okIn(flowSrc, '挂载时 interrupted 标记（页面刷新断点保护）', 'markInterruptedOnLoad', '未完成的高通量运行')

// ── C. 持久层 ──────────────────────────────────────────────────────────────
const storeSrc = 'src/components/eval/high-throughput-store.ts'
ok(`${storeSrc} 存在`, fs.existsSync(storeSrc))
okIn(storeSrc, 'localStorage key te_ht_runs_v1 + 保留 5 份运行历史', 'te_ht_runs_v1', 'MAX_STORED_RUNS = 5')
okIn(storeSrc, '合并报告本体不入 localStorage（只存 id 按需拉取）', '不入 localStorage', '只存 mergedReportId')

// ── D. 输入面板 ────────────────────────────────────────────────────────────
const inputSrc = 'src/components/eval/input-panel.tsx'
okIn(inputSrc, '第 4 个「高通量」Tab（Zap 图标）', "value: 'highthroughput'", '高通量', 'Zap')
okIn(inputSrc, '分组载荷交给独立编排 hook', 'onStartHighThroughput', 'HTStartPayload')
okIn(inputSrc, 'TabMode 扩展而不动后端契约（mode=uniprot 提交）', "type TabMode = InputMode | 'highthroughput'")
okIn(inputSrc, '高通量上限提示（组/每组/总数）', 'MAX_HT_GROUPS', 'MAX_HT_TARGETS_TOTAL', '超出高通量上限')

// ── E. 页面接线 ────────────────────────────────────────────────────────────
const pageSrc = 'src/app/page.tsx'
okIn(pageSrc, 'HT 视图优先渲染 + 独立 flow', 'useHighThroughputFlow', 'HighThroughputView', 'htActive')
okIn(pageSrc, '历史入口守卫：running 不切换视图（toast 提示）', '高通量评估进行中', 'exitToIdle()')
okIn(pageSrc, 'InputPanel 新 props（启动/最近运行/恢复/删除）', 'onStartHighThroughput={ht.startRun}', 'onResumeHTRun', 'onDeleteHTRun')
okIn(pageSrc, 'HT 完成刷新最近评估列表', "ht.phase === 'done'", 'setHistoryKey((k) => k + 1)')

// ── F. 运行视图 ────────────────────────────────────────────────────────────
const viewSrc = 'src/components/eval/high-throughput-progress.tsx'
ok(`${viewSrc} 存在`, fs.existsSync(viewSrc))
okIn(viewSrc, '当前组详情复用 ProgressPanel（阶段时间线/日志继承）', 'ProgressPanel', 'buildBatchForPanel')
okIn(viewSrc, '暂停横幅 + 重新开始运行按钮', '重新开始运行', 'resumeRun')
okIn(viewSrc, '完成后日志回看（拉取组内作业 logs + EvalLogConsole 静态）', 'openGroupLogs', "live={false}", '/api/jobs/')
okIn(viewSrc, '组矩阵 + 每组报告入口（合并/单靶点）', '打开合并报告', '查看报告', 'onOpenBatchReport')

// ── G. 复用符号导出 ─────────────────────────────────────────────────────────
const uefSrc = 'src/components/eval/use-evaluation-flow.ts'
okIn(uefSrc, 'autoDownloadHtmlReport / buildBatchNote / fallbackIndependentJudgment 已导出（高通量复用）', 'export function autoDownloadHtmlReport', 'export function buildBatchNote', 'export function fallbackIndependentJudgment')

// ── H. 类型契约 ─────────────────────────────────────────────────────────────
const typesSrc = 'src/components/eval/types.ts'
okIn(typesSrc, 'HT 类型族（HTRunState / HTGroupState / HTStartPayload）', 'export interface HTRunState', 'export interface HTGroupState', 'export interface HTStartPayload')

// ── I. 兼容性：既有单次/批量链路未被破坏 ────────────────────────────────────
ok('普通 flow 的 startEvaluation 签名未变（回归保护）', read(uefSrc).includes('const startEvaluation = async (\n    requests: EvaluateRequest[],\n    opts?: { docxSequences?: string[] },\n  ): Promise<StartResult> =>'))
ok('input-panel 既有三 Tab 保留（uniprot/sequence/docx）', ["value: 'uniprot'", "value: 'sequence'", "value: 'docx'"].every((n) => read(inputSrc).includes(n)))

console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项失败 ❌`)
process.exit(fail === 0 ? 0 : 1)
