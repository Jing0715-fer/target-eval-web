'use client'

/**
 * 高通量运行报告 zip 导入（v2.38 → v2.42 严格匹配重设计）— 把「已完成的靶点报告」
 * 导入新运行或既有运行，匹配到的靶点直接跳过（不重复评估、不浪费配额）。
 *
 * v2.42 严格化（用户反馈「除了已有报告的 G01-16 外还有很多靶点被跳过」—
 * 旧版序列靶点文件名兜底用「归一化标签双向包含」，短标签如「原PDB」「序列1」
 * 归一化后变成 pdb / 1 这类短串，几乎任何报告文件名都包含它 → 大量误跳过）：
 *  - 只有 kind='job' 的单靶点报告参与匹配（merged 按组生成跨运行组结构不同，
 *    dashboard 是汇总件 — 都不能证明某个具体靶点已有报告）；
 *  - 序列靶点：①清单 seqSha 双侧精确等值（主通道）；②无 SHA 旧 zip 兜底改为
 *    「归一化标签严格相等 + 长度双方已知且相等」，并加歧义守卫：多个不同序列
 *    共享同一标签+长度时无法区分报告属于谁 → 一个都不跳（宁重跑不误跳）；
 *  - UniProt 靶点：accession + 区间严格相等（原有语义不变）；
 *  - 双向包含匹配彻底移除。
 *
 * v2.45（用户反馈「导入单文件匹配不到，文件名中 G73 之类的数字应该就能匹配」）：
 *  - 新增**组号通道**：HT 自动下载的报告文件名携带运行目录段（TargetEval_HT_日期_74g
 *    G74_组名.html — 浏览器把目录分隔符扁平化后 G{NN} 仍留在文件名里）。合并报告
 *    按组号 + 靶点数一致 + 总组数对齐 → 整组跳过；单靶点报告按组号只在运行侧
 *    该组恰好 1 个靶点时直接归属；
 *  - 新增**机器可读标记通道**（v2.45 起生成的报告内嵌 <meta name="targeteval:target(s)">
 *    携带 uniprot/range/seqSha/header/label）— 序列靶点单文件导入可走 SHA 精确匹配，
 *    不再依赖 h1/题目文本启发式；
 *  - 序列靶点旧报告的题目尾标签是身份识别名（非运行侧标签）— 严格标签通道对不上
 *    属预期，由组号通道/标记通道兜底。
 *
 * v2.45.1（用户实测 G73 单靶点报告仍匹配不上 — 源组 2 条链，报告是其中一条）：
 *  - **多靶点组内消歧**：单靶点报告携带组号且该组多靶点时，组号已把候选限定在
 *    本组 — 组内证据只需唯一定位：①SHA 精确（meta/清单）；②全同比对跨度
 *    （归属报告题目「残基 X-Y」无同源度后缀 — 跨度 = 提交序列长度，例：O89342
 *    残基 25-483 → 459aa 链）；③非归属报告的序列长度（提交长度）。组内唯一命中
 *    才跳（同长度多靶点无法区分则不跳 — 宁重跑不误跳）。
 *
 * v2.49（用户实测导入匹配仍不稳 — 文件名携带的组号在 Firefox/Safari 按 W3C 规范
 *  丢弃 download 属性目录段、Chrome 建目录后从文件夹里选文件 file.name 无 G 前缀，
 *  组号通道天然依赖文件名形态）：
 *  - **运行标记通道**：autoDownloadHtmlReport 下载时把 targeteval:run meta
 *    （组号 + 总组数）注入 HTML blob — 信息随内容走，改名/换浏览器/从文件夹
 *    选文件均免疫；parseHtReportFile 优先读 meta（文件名解析降级为兜底）；
 *  - **逐文件诊断**：diagnoseArchiveImport 对每个未命中文件给出人话原因
 *    （总组数不一致 / 组内同长不可区分 / 序列指纹不一致 / 无证据…），
 *    导入 toast 直接展示 — 用户不再只能看到「未命中」三个字。
 *
 * 匹配计划由 planArchiveSkips 统一计算（新建运行与既有运行导入同一套规则）。
 *
 * v2.69（用户诉求「导入的报告内容并未整合到表格中，报告也没有内嵌到汇总报告中」）：
 *  导入时解析报告统计快照 + 上传原文服务端留存 —
 *  - extractImportedStatsSections：按 h1.rpt-title 切区段（合并报告多靶点各成区段，
 *    封面无评分自然跳过），解析评分卡（glance 总分 + X-ray/Cryo-EM/NMR 行）、
 *    刊头 meta-grid（蛋白名称/物种/序列长度/结构证据计数）、速览 tile（方法计数/
 *    最佳分辨率/覆盖率）→ ImportedReportStats（客户端解析，随运行记录持久化）；
 *  - pickImportedStats：多区段合并报告内按 UniProt+区间 / 比对跨度唯一定位子页
 *    （与导入匹配同口径 — 歧义不解析，宁降级不误配）；
 *  - enrichImportedReports：匹配后读源文件 → 解析统计 + 上传原文
 *    （POST /api/evaluate/ht-imported-report → reportId；同一源文件只传一次）；
 *    任一失败独立降级，不影响导入匹配本身。
 *
 * v2.72：统计解析抽出为前后端共享模块 lib/eval/imported-stats.ts（服务端汇总
 *  生成链路补解析回填用同一解析器），并增强定位链（提交序列 SHA 精确 /
 *  meta 提交长度 / 容差 ±3 aa / 标签消歧 — 修复已识别序列靶点在合并报告内
 *  因刊头长度为 UniProt 全长而定位失败 → 降级行评分列为空）。此处 re-export
 *  维持旧导出签名不变（调用方无感）。
 */
import JSZip from 'jszip'
import type { ImportedReportStats } from '@/lib/eval/types'
import {
  extractImportedStatsSections as extractImportedStatsSectionsShared,
  pickImportedStats as pickImportedStatsShared,
  toCleanImportedStats,
  type ImportedStatsSection,
} from '@/lib/eval/imported-stats'
import { uploadImportedReport, verifyImportedReports } from './api'
import { saveImportedSource, getImportedSource } from './ht-import-cache'

/** 导入的 zip/文件内一份可匹配的报告 */
export interface HtArchiveReport {
  kind: 'job' | 'merged' | 'dashboard'
  /** zip 内相对路径（提示用） */
  path: string
  /** v2.69：所属源文件序号（parseHtImportFiles 内部指派 — readSource/sourceKey
   *  定位源文件用；单文件导入的多条 h1 条目共享同一序号） */
  srcIdx?: number
  /** UniProt accession（清单 / 文件名 / 题目解析） */
  uniprot?: string
  /** 评估区间（清单 / 题目「残基 X-Y」解析） */
  range?: [number, number]
  /** 序列靶点：提交序列 SHA-256 前 16 hex（仅清单通道） */
  seqSha?: string
  /** 序列靶点：长度 aa（清单 / 文件名「· Naa」解析） */
  seqLength?: number
  /** 序列靶点：构建标签头（仅清单通道） */
  sequenceHeader?: string
  /** 文件名去扩展名（旧 zip 标签匹配用） */
  stem: string
  /** v2.45：源运行组号（1-based — 文件名 G{NN} 段 / zip 路径 G{NN}/ 前缀 / 清单 group 字段） */
  group?: number
  /** v2.45：源运行总组数（文件名 TargetEval_HT_日期_Ng 段 — 组号对齐校验） */
  totalGroups?: number
  /** v2.45：合并报告覆盖的靶点数（靶点数 K 个 / 清单同组 job 条目数 / 题目尾标签数） */
  targetCount?: number
  /** v2.68：报告对应的原评估作业 id（zip 清单 / 报告内嵌 targeteval:job meta）—
   *  导入匹配后随靶点留存：汇总报告生成时发回服务端，DB 仍在保留期内则恢复
   *  完整统计行（评分/结构/结论），过期则该靶点以「载入」降级行呈现 */
  jobId?: string
  /** v2.45.1：全同比对区间跨度（题目「残基 X-Y」且无同源度后缀 — 跨度 = 提交序列
   *  长度；多靶点组内按长度唯一定位靶点用。例：O89342 残基 25-483 → 跨度 459 =
   *  提交的 459aa 构建链） */
  alignedSpan?: number
}

/** 匹配的目标描述（新运行解析结果或既有运行的 item） */
export interface HtMatchTarget {
  /** 目标唯一键（计划结果的 Set 元素 — 调用方自定：`g:${i}:${j}` / item.key） */
  key: string
  /** UniProt accession（UniProt 靶点；序列靶点缺省） */
  acc?: string
  /** 评估区间（UniProt 残基编号；无则缺省） */
  range?: [number, number]
  /** 序列靶点：构建标签头 */
  header?: string
  /** 序列靶点：展示标签（可能含「…」截断与「· Naa」） */
  label?: string
  /** 序列靶点：长度 aa */
  length?: number
  /** 序列靶点：提交序列 SHA-256 前 16 hex（精确匹配通道） */
  seqSha?: string
  /** v2.42：提交序列本体（歧义守卫 — 同标签同长度但不同序列时识别无法区分） */
  seq?: string
  /** v2.45：运行侧组序（0-based，UniProt 组在前序列组在后 — 与 G{NN} 组号对齐） */
  groupIndex?: number
}

/** zip 内文件数上限（对齐高通量 MAX_HT_TARGETS_TOTAL + 冗余） */
const MAX_ZIP_FILES = 800
/** 单文件读取上限（题目解析只需头部片段 — 防超大文件拖垮内存） */
const MAX_HTML_HEAD_CHARS = 20_000

/** UniProt accession 语法（与 construct-range.ts 同源副本 — 避免循环依赖） */
const UNIPROT_ACC_RE = /(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?/

/** 序列 SHA-256 前 16 hex（WebCrypto；https 环境与 localhost 可用） */
export async function sha256Hex16(seq: string): Promise<string | undefined> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return undefined
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seq))
    return Array.from(new Uint8Array(buf.slice(0, 8)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return undefined
  }
}

/** 标签归一化：小写 + 去非字母数字（吸收 safeName 空格折叠 / 「…」截断 / 「·」分隔） */
function normLabel(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** v2.42 报告侧匹配键：去 zip 组目录前缀（G05_/）与去重尾缀（_2）后的归一化标签
 *  （长度尾巴单独比 —「· Naa」在双方标签里都存在时会自然吸收进等值比较） */
function reportLabelKey(stem: string): string {
  return normLabel(
    stem
      .replace(/^G\d{1,3}[_\s-]*/i, '')   // 组目录前缀（文件名含 G05_ 前缀）
      .replace(/_\d{1,3}$/, ''),            // 同名去重尾缀（_2/_3…）
  )
}

/** v2.42 目标侧匹配键（label / header 同口径归一化；截断标签「头22…尾7」在
 *  双方用同一截断函数生成时归一化结果一致） */
function targetLabelKey(t: HtMatchTarget): string {
  const cands = [t.label, t.header].filter(Boolean).map((x) => normLabel(String(x)))
  return cands[0] ?? ''
}

/** planArchiveSkips 可选项 */
export interface PlanArchiveSkipsOptions {
  /** v2.45：运行侧总组数（组号通道对齐校验 — 与报告侧 totalGroups 不一致时组号不可信） */
  totalGroups?: number
}

/** v2.42 统一匹配计划：返回可安全跳过的目标键集合。
 *  规则（见文件头）：
 *  - 只有单靶点 job 报告参与严格通道；
 *  - UniProt：acc + 区间严格相等；
 *  - 序列：SHA 精确等值；无 SHA 时「标签键严格相等 + 长度双方已知且相等」
 *    且无歧义（同标签键同长度的不同序列只计 1 个时才可判定归属）；
 *  - v2.45 组号通道：合并报告（组号 + 靶点数一致 + 总组数对齐）→ 整组跳过；
 *    单靶点报告组号仅在运行侧该组恰 1 个靶点时跳过；
 *  - 任一证据缺失 → 不跳（宁重跑不误跳 — 用户明确要求只跳过真正有报告的靶点）。 */
export function planArchiveSkips(reports: HtArchiveReport[], targets: HtMatchTarget[], opts?: PlanArchiveSkipsOptions): Set<string> {
  const jobReports = reports.filter((r) => r.kind === 'job')
  // v2.45：合并报告（组号通道）无 job 条目也要继续（如旧合并报告 h1 无全角括号时
  //  严格通道拿不到任何条目 — 组号通道是唯一可匹配路径）
  const mergedWithGroup = reports.filter((r) => r.kind === 'merged' && r.group != null)
  if ((jobReports.length === 0 && mergedWithGroup.length === 0) || targets.length === 0) return new Set()

  const skipped = new Set<string>()

  // ── UniProt 靶点：acc + 区间严格相等（无歧义 — accession+区间即身份）──
  const uniTargets = targets.filter((t) => t.acc)
  for (const t of uniTargets) {
    const hit = jobReports.some((rep) => {
      if (!rep.uniprot || rep.uniprot.toUpperCase() !== t.acc!.toUpperCase()) return false
      if (rep.range && t.range) return rep.range[0] === t.range[0] && rep.range[1] === t.range[1]
      return !rep.range && !t.range
    })
    if (hit) skipped.add(t.key)
  }

  // ── 序列靶点：①SHA 精确通道 ②严格标签+长度兜底（带歧义守卫）──
  const seqTargets = targets.filter((t) => !t.acc)

  // ① SHA 精确：报告有 seqSha 且目标有 seqSha → 等值即跳（同序列多行都算已有报告）
  const shaReports = jobReports.filter((r) => r.seqSha)
  for (const t of seqTargets) {
    if (!t.seqSha) continue
    if (shaReports.some((r) => r.seqSha === t.seqSha)) skipped.add(t.key)
  }

  // ② 无 SHA 兜底：标签键严格相等 + 长度双方已知且相等；
  //    歧义守卫：同（标签键，长度）下存在多个不同序列（SHA 或 seq 本体可区分）→ 全部不跳
  const fallbackReports = jobReports.filter((r) => !r.seqSha)
  if (fallbackReports.length > 0) {
    // 报告侧候选键：标签键 → 长度集合
    const repKeys = new Map<string, Set<number>>()
    for (const rep of fallbackReports) {
      const k = reportLabelKey(rep.stem)
      if (!k) continue
      if (rep.seqLength == null) continue // 报告侧长度未知 → 无法安全匹配
      if (!repKeys.has(k)) repKeys.set(k, new Set())
      repKeys.get(k)!.add(rep.seqLength)
    }
    // 目标侧分组：（标签键，长度）→ 不同序列数
    const ambiguous = new Set<string>()
    const groupSeqs = new Map<string, Set<string>>()
    for (const t of seqTargets) {
      const k = targetLabelKey(t)
      if (!k || t.length == null) continue
      const gk = `${k}|${t.length}`
      const identity = t.seqSha ?? t.seq ?? ''
      if (!identity) continue // 无法区分身份 → 保守不跳（不入组）
      if (!groupSeqs.has(gk)) groupSeqs.set(gk, new Set())
      groupSeqs.get(gk)!.add(identity)
    }
    for (const [gk, ids] of groupSeqs) {
      if (ids.size > 1) ambiguous.add(gk) // 同标签同长度不同序列 → 无法判定报告归属
    }
    for (const t of seqTargets) {
      if (skipped.has(t.key)) continue // SHA 通道已命中
      const k = targetLabelKey(t)
      if (!k || t.length == null) continue
      const gk = `${k}|${t.length}`
      if (ambiguous.has(gk)) continue
      const lens = repKeys.get(k)
      if (lens && lens.has(t.length)) skipped.add(t.key)
    }
  }

  // ── v2.45 组号通道：文件名/zip 路径/清单中的 G{NN}（用户诉求 — 报告文件名即携带组号）──
  //  对齐条件：①总组数双方已知且相等（清单可能被增删改过时组号已漂移，不可信）；
  //  ②合并报告的靶点数与运行侧该组靶点数一致；③单靶点报告：该组恰 1 个靶点时
  //  直接归属；多靶点时组内消歧（v2.45.1）— SHA 精确 / 全同跨度 / 提交长度，
  //  组内唯一命中才跳（同长度多靶点无法区分则不跳 — 宁重跑不误跳）。
  const groupTargets = new Map<number, HtMatchTarget[]>()
  for (const t of targets) {
    if (t.groupIndex == null || t.groupIndex < 0) continue
    const arr = groupTargets.get(t.groupIndex)
    if (arr) arr.push(t)
    else groupTargets.set(t.groupIndex, [t])
  }
  if (groupTargets.size > 0) {
    const totalAligned = (rep: HtArchiveReport) =>
      rep.totalGroups == null || opts?.totalGroups == null || rep.totalGroups === opts.totalGroups
    // v2.49 文件级指纹证据表：同文件（path 的 :: 前缀）+ 同组存在权威 seqSha 条目时，
    // 该文件该组的无指纹条目（h1/题目兜底证据）不再做「唯一靶点归属/长度消歧」—
    // 指纹命中时 SHA 通道已归属（长度兜底只会引入错误目标），指纹不一致时文件
    // 根本不属于该组（防换序列后长度巧合误跳 — 同文件新旧证据混存场景）
    const fileShaEvidence = new Set<string>()
    for (const rep of reports) {
      if (rep.kind !== 'job' || rep.seqSha == null || rep.group == null || rep.group < 1) continue
      if (!totalAligned(rep)) continue
      fileShaEvidence.add(`${rep.path.split('::')[0]}|${rep.group}`)
    }
    for (const rep of reports) {
      if (rep.group == null || rep.group < 1) continue
      const gt = groupTargets.get(rep.group - 1)
      if (!gt || gt.length === 0) continue
      if (!totalAligned(rep)) continue
      const shaEvidence = fileShaEvidence.has(`${rep.path.split('::')[0]}|${rep.group}`)
      if (rep.kind === 'merged') {
        // 合并报告覆盖整组：靶点数未知或与运行侧不一致 → 不可整组跳（宁重跑不误跳）
        if (rep.targetCount == null || rep.targetCount !== gt.length) continue
        for (const t of gt) skipped.add(t.key)
      } else if (rep.kind === 'job') {
        // v2.49 序列一致性守卫（「该组恰 1 靶点即归属」前提的加固 — 用户在两次运行
        //  间换过序列/换过靶点类型时组数不变，纯结构对齐会误跳新靶点）：
        //  a. 序列报告落在 UniProt 靶点上（清单结构已变 — 源运行该组是序列靶点）；
        //  b. 序列指纹与唯一靶点明确不一致（清单已换序列）；
        //  c. 旧报告（无指纹）提交长度与唯一靶点长度不等（清单已换序列）。
        //  命中任一 → 报告不属于当前清单的该靶点，不跳（宁重跑不误跳）。
        //  归属报告（rep.uniprot）的 seqLength 是 UniProt 全长（非提交口径）不参与 c。
        const t0 = gt[0]!
        const repIsSeq = rep.uniprot == null
        if (gt.length === 1) {
          // v2.49 UniProt 一致性守卫：报告与唯一靶点均为 UniProt 形态时，必须严格
          // 相等（accession + 区间口径同严格通道）— 否则清单已换靶点/换区间，
          // 报告不属于它（宁重跑不误跳；归属序列报告的靶点是序列形态不触发）
          const accGuard = rep.uniprot != null && t0.acc != null && !(
            rep.uniprot.toUpperCase() === t0.acc.toUpperCase() && (
              rep.range && t0.range
                ? rep.range[0] === t0.range[0] && rep.range[1] === t0.range[1]
                : !rep.range && !t0.range
            )
          )
          const seqGuard = shaEvidence || (repIsSeq && !t0.acc && (
            (rep.seqSha != null && t0.seqSha != null && rep.seqSha !== t0.seqSha)
            || (rep.seqSha == null && rep.seqLength != null && t0.length != null && rep.seqLength !== t0.length)
          ))
          const kindGuard = repIsSeq && !!t0.acc
          if (!accGuard && !seqGuard && !kindGuard) skipped.add(t0.key)
          continue
        }
        // v2.45.1 多靶点组内消歧（组号已把候选限定在本组 — 组内证据只需唯一定位）：
        //  a. SHA 精确（v2.45+ 报告 meta / zip 清单 seqSha）
        //  b. 全同比对跨度（归属报告题目「残基 X-Y」且无同源度后缀 — 跨度 = 提交长度；
        //     例：O89342 残基 25-483 → 459 = 该组 459aa 链）
        //  c. 非归属报告的序列长度（「NAME（序列靶点…）」形态 — h1 题目无 accession，
        //     序列长度即提交长度）
        //  归属报告的 seqLength 是 UniProt 全长（非提交长度）→ 不参与 c。
        const seqTs = gt.filter((t) => !t.acc)
        if (rep.seqSha) {
          const shaHits = seqTs.filter((t) => t.seqSha === rep.seqSha)
          if (shaHits.length > 0) {
            for (const t of shaHits) skipped.add(t.key)
            continue
          }
          // v2.49：指纹明确不一致（组内至少一个清单靶点指纹可知）→ 报告不属于本组，
          // 长度巧合不再兜底（避免换序列后同长误跳）
          if (seqTs.some((t) => t.seqSha != null)) continue
        } else if (shaEvidence) {
          // v2.49：同文件存在权威指纹条目（命中或否）→ 本条目的长度兜底一并失效
          continue
        }
        const spanOrLen = rep.alignedSpan ?? (rep.uniprot ? undefined : rep.seqLength)
        if (spanOrLen != null) {
          const hits = seqTs.filter((t) => t.length === spanOrLen)
          if (hits.length === 1) skipped.add(hits[0]!.key)
        }
      }
    }
  }

  return skipped
}

/** v2.42 保留的单报告↔单目标判定（供调试/单点调用；集合语义用 planArchiveSkips） */
export function matchReportToTarget(rep: HtArchiveReport, t: HtMatchTarget): boolean {
  return planArchiveSkips([rep], [t]).has(t.key)
}

// ── v2.49 导入诊断 ──────────────────────────────────────────────────────────

/** 逐文件诊断结果（diagnoseArchiveImport 返回 — 导入 toast 展示用） */
export interface ArchiveFileDiagnosis {
  /** 文件短名（去路径/扩展名，超长截断） */
  file: string
  /** 任一证据命中可匹配目标（该文件无需提示原因） */
  matched: boolean
  /** 仅命中「已完成/进行中」靶点（既有运行导入场景 — 传入 doneHintTargets 时才有值；
   *  报告本身有效，只是对应靶点已在当前运行中完成，无需再导入） */
  doneOnly: boolean
  /** 未命中原因（matched 时为空串） */
  reason: string
}

/** 诊断用的目标侧索引（一次构建，逐文件复用） */
interface DiagContext {
  byGroup: Map<number, HtMatchTarget[]>
  runTotal: number | undefined
  /** 与当前清单同 acc 的目标（区间诊断用） */
  byAcc: Map<string, HtMatchTarget[]>
}

function buildDiagContext(targets: HtMatchTarget[], opts?: PlanArchiveSkipsOptions): DiagContext {
  const byGroup = new Map<number, HtMatchTarget[]>()
  const byAcc = new Map<string, HtMatchTarget[]>()
  for (const t of targets) {
    if (t.groupIndex != null && t.groupIndex >= 0) {
      const arr = byGroup.get(t.groupIndex)
      if (arr) arr.push(t)
      else byGroup.set(t.groupIndex, [t])
    }
    if (t.acc) {
      const k = t.acc.toUpperCase()
      const arr = byAcc.get(k)
      if (arr) arr.push(t)
      else byAcc.set(k, [t])
    }
  }
  return { byGroup, byAcc, runTotal: opts?.totalGroups }
}

function fmtRange(r?: [number, number]): string {
  return r ? `${r[0]}-${r[1]}` : '无区间'
}

/** 总组数不一致原因（组号通道共用 — 报告来自的运行与当前清单组数不同） */
function totalMismatchReason(rep: HtArchiveReport, ctx: DiagContext): string | null {
  if (rep.totalGroups != null && ctx.runTotal != null && rep.totalGroups !== ctx.runTotal) {
    return `报告来自 ${rep.totalGroups} 组的运行，当前清单 ${ctx.runTotal} 组 — 分组结构不一致，组号 G${rep.group} 无法对齐`
  }
  return null
}

/** 合并报告未命中原因（只走组号通道） */
function mergedMissReason(rep: HtArchiveReport, ctx: DiagContext): string {
  if (rep.group == null) {
    return '合并报告未携带组号（文件名无 G{NN} 且报告为旧版无运行标记）— 无法整组对齐；可从「批量下载全部」的 zip 导入（含精确清单），或重命名文件加上 G 组号'
  }
  const tm = totalMismatchReason(rep, ctx)
  if (tm) return tm
  const tg = ctx.byGroup.get(rep.group - 1)
  if (!tg || tg.length === 0) return `当前清单没有组 G${rep.group}（分组结构与报告来源运行不同）`
  if (rep.targetCount == null) return `组 G${rep.group}：报告内未识别到靶点数，无法校验整组覆盖（可改用 zip 导入）`
  if (rep.targetCount !== tg.length) {
    return `组 G${rep.group}：报告覆盖 ${rep.targetCount} 个靶点，当前清单该组 ${tg.length} 个 — 组内结构不一致`
  }
  return `组 G${rep.group} 校验应通过但未命中（未预期 — 请反馈）`
}

/** 单靶点报告未命中原因 */
function jobMissReason(rep: HtArchiveReport, ctx: DiagContext): string {
  // ⓪ v2.49 序列指纹明确不一致（单/多靶点、归属/非归属报告通用 — 优先于
  //    「UniProt 不在清单」：归属报告本质是序列靶点，序列变了才是根因）
  if (rep.group != null && rep.seqSha != null) {
    const tg = ctx.byGroup.get(rep.group - 1)
    if (tg && tg.length > 0) {
      const seqTs = tg.filter((t) => !t.acc)
      if (seqTs.some((t) => t.seqSha != null) && !seqTs.some((t) => t.seqSha === rep.seqSha)) {
        return `组 G${rep.group}：报告序列指纹与该组清单序列均不一致（提交序列已变更）`
      }
    }
  }
  // ① UniProt 严格通道（主通道）
  if (rep.uniprot) {
    const same = ctx.byAcc.get(rep.uniprot.toUpperCase()) ?? []
    if (same.length === 0) return `报告靶点 UniProt ${rep.uniprot} 不在当前清单`
    return `UniProt ${rep.uniprot} 区间不一致（报告 ${fmtRange(rep.range)}，清单 ${same.map((t) => fmtRange(t.range)).join('/')}）`
  }
  // ② 组号通道（序列靶点兜底主通道；到这里的报告均无 accession）
  if (rep.group != null) {
    const tm = totalMismatchReason(rep, ctx)
    if (tm) return tm
    const tg = ctx.byGroup.get(rep.group - 1)
    if (!tg || tg.length === 0) return `当前清单没有组 G${rep.group}（分组结构与报告来源运行不同）`
    if (tg.length === 1) {
      // v2.49 守卫原因（与 planArchiveSkips 单靶点守卫对齐；rep.uniprot 非空的
      // 报告已在 ① 返回 — 到这里的报告均无 accession）
      const t0 = tg[0]!
      if (t0.acc) return `组 G${rep.group} 当前是 UniProt 靶点（${t0.acc}），报告为序列靶点 — 清单结构已变更`
      if (rep.seqSha == null && rep.seqLength != null && t0.length != null && rep.seqLength !== t0.length) {
        return `组 G${rep.group}：报告提交长度 ${rep.seqLength}aa 与该组唯一靶点 ${t0.length}aa 不一致（清单已换序列）`
      }
      if (rep.seqSha != null && t0.seqSha == null) {
        return `组 G${rep.group} 的清单靶点无法计算序列指纹（SHA）— 无法精确定位（可改用 zip 导入）`
      }
      return `组 G${rep.group} 校验应通过但未命中（未预期 — 请反馈）`
    }
    if (rep.seqSha) {
      // 指纹不匹配已在 ⓪ 返回 — 到这里只剩清单侧无法计算指纹
      return `组 G${rep.group} 的清单靶点无法计算序列指纹（SHA）— 无法精确定位`
    }
    const span = rep.alignedSpan ?? rep.seqLength
    if (span == null) {
      return `组 G${rep.group} 有 ${tg.length} 个靶点，报告无序列标记/长度证据可区分 — 旧版报告建议用「批量下载全部」zip 导入（清单含精确指纹）`
    }
    const hits = tg.filter((t) => !t.acc && t.length === span)
    if (hits.length === 0) return `组 G${rep.group}：报告序列长度 ${span}aa 与该组清单靶点均不一致`
    return `组 G${rep.group} 有 ${tg.length} 个靶点、其中 ${hits.length} 个同为 ${span}aa — 无法区分报告属于谁（宁重跑不误跳，可改用 zip 导入）`
  }
  // ③ 无组号 — 序列证据直配
  if (rep.seqSha) return '报告序列指纹与当前清单序列均不一致（提交序列不同）'
  if (rep.seqLength != null) {
    return `旧版报告无组号/序列标记 — 标签与清单靶点标签不一致且无其他证据（可改用 zip 导入或新版报告）`
  }
  return '报告无可用匹配证据（无 UniProt / 序列标记 / 组号）— 可能是旧版报告或文件被改动'
}

/**
 * v2.49：逐文件诊断导入匹配结果 — 每个未命中文件一条人话原因。
 * 背景用户诉求：导入匹配不上时 toast 只说「未命中」，用户无从自查；本函数把
 * planArchiveSkips 的判定依据翻译成可行动的原因（改用 zip / 检查清单结构 /
 * 旧版报告升级等）。
 * @param doneHintTargets 可选：含已完成/进行中靶点的全量目标（既有运行导入场景 —
 *        文件只命中这些目标时标 doneOnly 而非报「不在清单」）
 */
export function diagnoseArchiveImport(
  reports: HtArchiveReport[],
  targets: HtMatchTarget[],
  opts?: PlanArchiveSkipsOptions,
  doneHintTargets?: HtMatchTarget[],
): ArchiveFileDiagnosis[] {
  const ctx = buildDiagContext(targets, opts)
  // 文件级聚合：path 的 :: 前是文件名；同文件多条证据任一命中即整文件命中
  const files = new Map<string, HtArchiveReport[]>()
  for (const rep of reports) {
    if (rep.kind === 'dashboard') continue
    const fk = rep.path.split('::')[0] ?? rep.path
    const arr = files.get(fk)
    if (arr) arr.push(rep)
    else files.set(fk, [rep])
  }
  const out: ArchiveFileDiagnosis[] = []
  for (const [file, entries] of files) {
    const base = (file.split('/').pop() ?? file).replace(/\.html?$/i, '')
    const shortName = base.length > 30 ? `${base.slice(0, 28)}…` : base
    if (entries.some((e) => planArchiveSkips([e], targets, opts).size > 0)) {
      out.push({ file: shortName, matched: true, doneOnly: false, reason: '' })
      continue
    }
    if (doneHintTargets && entries.some((e) => planArchiveSkips([e], doneHintTargets, opts).size > 0)) {
      out.push({ file: shortName, matched: false, doneOnly: true, reason: '' })
      continue
    }
    const merged = entries.find((e) => e.kind === 'merged')
    const reason = merged
      ? mergedMissReason(merged, ctx)
      : jobMissReason(entries.find((e) => e.kind === 'job') ?? entries[0]!, ctx)
    out.push({ file: shortName, matched: false, doneOnly: false, reason })
  }
  return out
}

/** 清单 JSON 条目（与服务端 ht-archive 写入口径一致） */
interface ManifestEntry {
  kind: 'job' | 'merged' | 'dashboard'
  path: string
  jobId?: string
  mergedId?: string
  group?: number
  label?: string
  uniprot?: string
  range?: [number, number]
  seqSha?: string
  seqLength?: number
  sequenceHeader?: string
}

// ── v2.45 文件名组号/总组数解析 ────────────────────────────────────────────

/** 文件名中的组号段：独立 G+数字 token（G74_ / G74 空格 / 目录残留 G74/）。
 *  要求 G 前是行首/空白/斜杠（EGFR_G12C 这类基因名中部 G 不会误中）且后随
 *  分隔符/结尾（G12C 的 C 会被拒）。取首个命中（目录段在标题前）。 */
const FILE_GROUP_RE = /(?:^|[\s\/])G(\d{1,3})(?=[\s\/_]|$)/
/** 文件名中的总组数段：TargetEval_HT_日期_Ng（数字后紧跟 g 结束 token） */
const FILE_TOTAL_GROUPS_RE = /(?:^|[\s_])(\d{1,3})g(?![a-z0-9])/

/** v2.49：从运行目录串（TargetEval_HT_日期_Ng/G{NN}）解析组号与总组数。
 *  下载注入（use-evaluation-flow）与导入解析（本文件）同源 — 目录格式变化只改一处。 */
export function parseRunFolderMeta(dir: string): { group?: number; totalGroups?: number } {
  const out: { group?: number; totalGroups?: number } = {}
  const tM = FILE_TOTAL_GROUPS_RE.exec(dir)
  if (tM) {
    const n = Number(tM[1])
    if (n >= 1 && n <= 999) out.totalGroups = n
  }
  const gM = FILE_GROUP_RE.exec(dir)
  if (gM) {
    const n = Number(gM[1])
    if (n >= 1 && n <= 999 && (out.totalGroups == null || n <= out.totalGroups)) out.group = n
  }
  return out
}

/** HTML 属性转义（unescapeAttr 的逆 — run meta 注入用） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;')
}

/** v2.49：构造运行标记 meta 标签（autoDownloadHtmlReport 注入 HTML blob —
 *  parseHtReportFile 经 parseMetaJson 读回，与 targeteval:target(s) 同一解析器） */
export function buildRunMetaTag(group: number | undefined, totalGroups: number | undefined): string {
  const content = escapeAttr(JSON.stringify({ group: group ?? null, totalGroups: totalGroups ?? null }))
  return `<meta name="targeteval:run" content="${content}">`
}

/** HTML 属性反转义（esc 的逆 — meta 标记通道用） */
function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** v2.45 报告内嵌机器可读靶点标记条目（服务端生成 — 权威证据） */
interface TargetMetaEntry {
  uniprot?: string
  range?: [number, number]
  seqLength?: number
  seqSha?: string
  header?: string
  label?: string
}

/** 解析 <meta name="..." content="..."> 的 JSON（损坏返回 null） */
function parseMetaJson<T>(html: string, name: string): T | null {
  const m = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i').exec(html)
  if (!m) return null
  try {
    const parsed = JSON.parse(unescapeAttr(m[1]!)) as T
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** meta 条目消毒（畸形字段丢弃 — 服务端可信但防御性解析） */
function sanitizeMetaEntry(e: Partial<TargetMetaEntry>): Partial<TargetMetaEntry> | null {
  if (!e || typeof e !== 'object') return null
  const out: Partial<TargetMetaEntry> = {}
  if (typeof e.uniprot === 'string' && UNIPROT_ACC_RE.test(e.uniprot)) out.uniprot = e.uniprot.toUpperCase()
  if (Array.isArray(e.range) && e.range.length === 2 && Number(e.range[0]) >= 1 && Number(e.range[1]) >= Number(e.range[0])) {
    out.range = [Number(e.range[0]), Number(e.range[1])]
  }
  if (typeof e.seqLength === 'number' && e.seqLength >= 10 && e.seqLength <= 100000) out.seqLength = Math.round(e.seqLength)
  if (typeof e.seqSha === 'string' && /^[0-9a-f]{16}$/i.test(e.seqSha)) out.seqSha = e.seqSha.toLowerCase()
  if (typeof e.header === 'string' && e.header.trim()) out.header = e.header.trim().slice(0, 80)
  if (typeof e.label === 'string' && e.label.trim()) out.label = e.label.trim().slice(0, 90)
  return Object.keys(out).length > 0 ? out : null
}

/**
 * v2.44→v2.45：解析一份**单独的报告 HTML 文件**（单靶点报告 / 组合并报告 / 统计看板）。
 *
 * 用户诉求：除 zip 归档外，支持导入单个报告文件（如浏览器下载的
 * 「TargetEval_HT_2026-11-19_74g G74_TSLP受体轴三靶点独立评估.html」），
 * 且可多选批量导入。v2.45：文件名中的组号（G74）与总组数（74g）也参与匹配。
 *
 * 提取通道（无 manifest — 全部从 HTML 内容 + 文件名解析）：
 *  - 统计看板：题目含「高通量评估汇总报告」→ 单条 dashboard（不参与匹配，仅计数）；
 *  - v2.45 ⓪ 机器可读标记：<meta name="targeteval:targets">（合并）/ targeteval:target
 *    （单靶点）— v2.45 起生成的报告内嵌（uniprot/range/seqSha/header/label 权威字段）；
 *  - 合并报告（v2.13+ 各靶点内嵌完整单独评估页）：
 *    ① 题目尾部靶点标签清单「标题 · P123 + P456」（accession 形态直接可匹配）；
 *    ② 逐内嵌页扫描：<h1 class="rpt-title">NAME（P12345 · 残基 X-Y）</h1> 与就近
 *       「序列长度 N aa」配对 → 每靶点一条可匹配条目（accession / 区间 / 长度齐全）；
 *    ③ 「靶点数 K 个」meta 行 → 合并报告的组内靶点数（组号通道校验用）；
 *  - 单靶点报告：同一套 h1 + 序列长度扫描（自身即唯一内嵌页）。
 *
 * v2.45 文件级元数据：组号（G{NN} 段）+ 总组数（_Ng 段）从文件名解析，附着到
 * 各条目（合并报告另发一条 kind='merged' 的文件级条目 — 组号通道入口）。
 *
 * 序列靶点条目的 stem 按靶点标签格式「header · Naa」构造（normLabel 归一后与
 * 运行侧标签键严格相等 — planArchiveSkips 兜底通道）；证据不足时不产出
 * （宁重跑不误跳，与 v2.42 严格匹配口径一致）。
 */
export async function parseHtReportFile(file: File): Promise<HtArchiveReport[]> {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new Error(`无法读取文件 ${file.name}`)
  }
  // 防御上限（合并报告内嵌 3D 模型/图片可达十余 MB — 配对只需 h1 与序列长度行）
  const capped = text.length > 26_000_000 ? text.slice(0, 26_000_000) : text
  const stem = file.name.replace(/\.html?$/i, '')
  const title = /<title>([^<]*)<\/title>/i.exec(capped)?.[1] ?? ''

  // ① 统计看板（汇总件 — 不参与靶点匹配）
  if (title.includes('高通量评估汇总报告') || /^00_统计看板/.test(stem)) {
    return [{ kind: 'dashboard', path: file.name, stem }]
  }

  // ── v2.45 文件名组号/总组数（HT 自动下载目录段扁平化后残留在文件名里）──
  let group: number | undefined
  let totalGroups: number | undefined
  {
    const gM = FILE_GROUP_RE.exec(stem)
    const tM = FILE_TOTAL_GROUPS_RE.exec(stem)
    if (tM) {
      const n = Number(tM[1])
      if (n >= 1 && n <= 999) totalGroups = n
    }
    if (gM) {
      const n = Number(gM[1])
      // 组号越界（> 总组数）视为误判（标题里的 G token 等）丢弃
      if (n >= 1 && n <= 999 && (totalGroups == null || n <= totalGroups)) group = n
    }
  }

  // ── v2.68 原作业标记（targeteval:job meta — v2.68 起单独报告内嵌；单文件导入时
  //    汇总报告据此从服务端恢复完整统计行；旧报告无此标记 → 降级「载入」行）──
  const jobMeta = parseMetaJson<{ jobId?: string | null }>(capped, 'targeteval:job')
  const metaJobId = jobMeta && typeof jobMeta.jobId === 'string' && /^[a-z0-9]{20,40}$/i.test(jobMeta.jobId)
    ? jobMeta.jobId
    : undefined

  // ── v2.49 运行标记（targeteval:run meta — 下载时注入的组号/总组数，优先于文件名）。
  //    文件名证据天然脆弱：Firefox/Safari 按 W3C 规范丢弃 download 目录段、Chrome 建
  //    目录后从文件夹选文件 file.name 无 G 前缀、手工重命名 — 内容里的标记不受影响 ──
  {
    const runMeta = parseMetaJson<{ group?: number | null; totalGroups?: number | null }>(capped, 'targeteval:run')
    if (runMeta) {
      if (typeof runMeta.totalGroups === 'number' && runMeta.totalGroups >= 1 && runMeta.totalGroups <= 999) {
        totalGroups = runMeta.totalGroups
      }
      if (typeof runMeta.group === 'number' && runMeta.group >= 1 && runMeta.group <= 999
        && (totalGroups == null || runMeta.group <= totalGroups)) {
        group = runMeta.group
      }
    }
  }

  const out: HtArchiveReport[] = []
  const seenEvidence = new Set<string>()

  // ⓪ v2.45 机器可读标记（服务端生成的权威字段 — 优先于文本启发式）
  const metaArr = parseMetaJson<Partial<TargetMetaEntry>[]>(capped, 'targeteval:targets')
  const metaOne = parseMetaJson<Partial<TargetMetaEntry>>(capped, 'targeteval:target')
  const metaEntries = metaArr && Array.isArray(metaArr)
    ? metaArr.slice(0, 60).map(sanitizeMetaEntry).filter((x): x is Partial<TargetMetaEntry> => x != null)
    : metaOne ? [sanitizeMetaEntry(metaOne)].filter((x): x is Partial<TargetMetaEntry> => x != null)
      : []

  // ② 合并报告题目尾部的靶点标签清单（「reportTitle · A + B + C」— label = accession
  //    或蛋白名；accession 形态可直接匹配 UniProt 靶点）
  const mergedTitleM = /^(.*) · (.+ \+ .+)$/.exec(title)
  // v2.45 合并报告的组内靶点数（组号通道校验）：靶点数行 > meta 条目数 > 题目尾标签数
  const cntM = /<b>靶点数<\/b>\s*(\d{1,3})\s*个/.exec(capped)
  const isMerged = metaArr != null || cntM != null || mergedTitleM != null
  let mergedTargetCount: number | undefined
  if (cntM) mergedTargetCount = Number(cntM[1])
  else if (metaEntries.length > 0 && metaArr != null) mergedTargetCount = metaEntries.length
  else if (mergedTitleM) mergedTargetCount = mergedTitleM[2].split(' + ').filter((s) => s.trim()).length

  // 合并文件级条目（组号通道入口 — kind='merged' 不参与严格通道，只按组号整组判定）
  if (isMerged) {
    out.push({
      kind: 'merged',
      path: file.name,
      stem,
      group,
      totalGroups,
      targetCount: mergedTargetCount,
    })
  }

  // ⓪ meta 条目 → 严格通道条目（seqSha/header 为服务端权威值 — SHA/标签精确匹配）
  //    合并文件不发（其 meta 面向整组，由组号通道处理 + h1/题目通道兜底单靶点形态）
  if (!isMerged) {
    for (const e of metaEntries) {
      const evidence = `meta:${e.uniprot ?? ''}|${e.seqSha ?? ''}|${e.header ?? ''}|${e.seqLength ?? ''}`
      if (seenEvidence.has(evidence)) continue
      seenEvidence.add(evidence)
      out.push({
        kind: 'job',
        path: `${file.name}::${e.label ?? e.uniprot ?? ''}`,
        uniprot: e.uniprot,
        range: e.range,
        seqSha: e.seqSha,
        seqLength: e.seqLength,
        sequenceHeader: e.header,
        stem: e.label ?? e.uniprot ?? stem,
        group,
        totalGroups,
        jobId: metaJobId,
      })
    }
  }

  if (mergedTitleM) {
    for (const rawLabel of mergedTitleM[2].split(' + ')) {
      const label = rawLabel.trim()
      if (!label) continue
      const accM = UNIPROT_ACC_RE.exec(label)
      const lenM = /(\d{2,5})\s*aa$/i.exec(label)
      const evidence = `title:${label}`
      if (seenEvidence.has(evidence)) continue
      seenEvidence.add(evidence)
      out.push({
        kind: 'job',
        path: `${file.name}::${label}`,
        uniprot: accM ? accM[0].toUpperCase() : undefined,
        seqLength: lenM ? Number(lenM[1]) : undefined,
        stem: label,
        jobId: metaJobId,
        // v2.45：非合并文件（题目尾形态不成立时不会进本分支 — 防御性保留）
      })
    }
  }

  // ③ 内嵌/独立单靶点报告页：h1 题目（NAME（P12345 · 残基 X-Y）/ NAME（序列靶点 · …））
  //    与其后、下一 h1 前的「序列长度 N aa」配对 → 每靶点一条可匹配条目
  const h1Re = /<h1 class="rpt-title"[^>]*>([^<]+)<\/h1>/g
  const lenRe = /序列长度<\/b>\s*(\d{2,5})\s*aa/g
  const h1s: Array<{ title: string; at: number }> = []
  let m: RegExpExecArray | null
  while ((m = h1Re.exec(capped))) h1s.push({ title: m[1].trim(), at: m.index })
  const lens: Array<{ len: number; at: number }> = []
  while ((m = lenRe.exec(capped))) lens.push({ len: Number(m[1]), at: m.index })

  for (let i = 0; i < h1s.length; i++) {
    const h = h1s[i]!
    // 单靶点页题目形态：「NAME（内层）」；合并报告首页/章节标题（无全角括号对）跳过
    const shape = /^([^（]+)（([^）]*)）$/.exec(h.title)
    if (!shape) continue
    const name = shape[1].trim()
    const inner = shape[2]
    const accM = UNIPROT_ACC_RE.exec(inner)
    const rangeM = /残基\s*(\d{1,5})\s*[-–]\s*(\d{1,5})/.exec(inner)
    const range: [number, number] | undefined = rangeM && Number(rangeM[1]) >= 1 && Number(rangeM[2]) >= Number(rangeM[1])
      ? [Number(rangeM[1]), Number(rangeM[2])]
      : undefined
    const nextH1 = h1s[i + 1]
    const lenHit = lens.find((x) => x.at > h.at && (nextH1 == null || x.at < nextH1.at))
    const seqLength = lenHit?.len
    // v2.45.1：同源度后缀（「UniProt 匹配 N%」/「nr 识别 N%」）— 有后缀时比对可能
    // 含缺口，区间跨度 ≠ 提交长度 → 不做组内长度定位（宁重跑不误跳）
    const hasIdentitySuffix = /(?:UniProt 匹配|nr 识别)\s*\d+(?:\.\d+)?\s*%/.test(inner)
    // 防误判：非 accession 页须是序列靶点形态（合并报告 LLM 标题可能恰好含全角括号）
    const seqShape = inner.includes('序列靶点') || inner.includes('同源') || inner.includes('nr 识别') || inner.includes('UniProt 匹配')
    const evidence = `h1:${name}|${accM?.[0] ?? ''}|${range?.join('-') ?? ''}|${seqLength ?? ''}`
    if (seenEvidence.has(evidence)) continue

    if (accM) {
      seenEvidence.add(evidence)
      out.push({
        kind: 'job',
        path: `${file.name}::${name}`,
        uniprot: accM[0].toUpperCase(),
        range,
        seqLength,
        // v2.45.1：全同比对（无同源度后缀）时的区间跨度 = 提交序列长度
        alignedSpan: range && !hasIdentitySuffix ? range[1] - range[0] + 1 : undefined,
        stem: name,
        // v2.68：文件级作业标记（单靶点报告 = 该靶点的作业；合并文件不携带）
        ...(isMerged ? {} : { jobId: metaJobId, group, totalGroups }),
      })
    } else if (seqShape) {
      seenEvidence.add(evidence)
      // stem 模拟运行侧序列靶点标签格式（header · Naa — 归一化后与标签键严格相等）
      out.push({
        kind: 'job',
        path: `${file.name}::${name}`,
        range,
        seqLength,
        stem: seqLength != null ? `${name} · ${seqLength}aa` : name,
        ...(isMerged ? {} : { jobId: metaJobId, group, totalGroups }),
      })
    }
  }
  return out
}

/**
 * v2.44：混合导入解析 — zip 归档与单独 HTML 报告统一入口（可多选批量）。
 * 非报告文件（扩展名不识别）跳过；全部不可识别时返回空数组（调用方提示）。
 * v2.69：除报告条目外另携带 readSource（读取条目所属源文件的完整 HTML —
 *  匹配后解析统计快照 + 上传原文用）与 sourceKey（同一源文件的条目同键 —
 *  上传去重）。旧调用方只消费 .reports 即可，行为不变。
 */
export interface HtImportParseResult {
  reports: HtArchiveReport[]
  /** 读取条目所属源文件的完整 HTML 文本（单文件 = 整个文件；zip = 该 zip 内该路径
   *  的成员文件；路径已被删改/文件丢失时 null）。内部有缓存，可重复调用。 */
  readSource: (rep: HtArchiveReport) => Promise<string | null>
  /** 条目所属源文件的稳定键（同一源文件的全部条目同键 — 上传去重用） */
  sourceKey: (rep: HtArchiveReport) => string
}

/** 单份导入源文件读取体积上限（解析前缀用 — 超大文件切片保留头部，统计解析
 *  仍可用；上传按服务端 32MB 上限独立门控，见 IMPORTED_UPLOAD_MAX_CHARS） */
const IMPORT_SOURCE_MAX_CHARS = 33_000_000
/** v2.70：上传体积上限（与服务端 ht-imported-report MAX_HTML_CHARS 同口径 —
 *  超大文件不再上传原文，但统计解析照常（修复：v2.69 里读取超限直接置 null，
 *  大报告（多结构/3D 内嵌）的靶点全部降级为无评分 bare 行） */
const IMPORTED_UPLOAD_MAX_CHARS = 32_000_000

export async function parseHtImportFiles(files: File[]): Promise<HtImportParseResult> {
  const out: HtArchiveReport[] = []
  /** 源文件句柄（srcIdx → 单文件 File 或已解开的 zip 实例） */
  const sources: Array<
    | { zip: JSZip; isZip: true; cache: Map<string, string | null> }
    | { file: File; isZip: false; cache: Map<string, string | null> }
  > = []
  for (const f of files.slice(0, MAX_ZIP_FILES)) {
    const srcIdx = sources.length
    if (/\.zip$/i.test(f.name)) {
      try {
        const zip = await JSZip.loadAsync(f)
        const reps = await parseHtArchiveEntries(zip)
        for (const r of reps) r.srcIdx = srcIdx
        out.push(...reps)
        sources.push({ zip, isZip: true, cache: new Map() })
      } catch {
        // 非 zip / 损坏 → 跳过该文件（与旧版 parseHtArchive 抛错不同：混合批量时不阻断其余文件）
      }
    } else if (/\.html?$/i.test(f.name)) {
      const reps = await parseHtReportFile(f)
      for (const r of reps) r.srcIdx = srcIdx
      out.push(...reps)
      sources.push({ file: f, isZip: false, cache: new Map() })
    }
  }
  const readSource = async (rep: HtArchiveReport): Promise<string | null> => {
    const src = rep.srcIdx != null ? sources[rep.srcIdx] : undefined
    if (!src) return null
    const cacheKey = src.isZip ? rep.path : ''
    if (src.cache.has(cacheKey)) return src.cache.get(cacheKey) ?? null
    let text: string | null = null
    try {
      if (src.isZip) {
        text = (await src.zip.file(rep.path)?.async('text')) ?? null
      } else {
        text = await src.file.text()
      }
    } catch {
      text = null
    }
    // v2.70：超大文件切片保留头部（不再置 null）— 统计证据（h1/glance/评分卡）
    //  都在报告头部，切片后照常解析；上传制 32MB 上限由 enrichImportedReports
    //  按长度独立门控（切片文本不会作为原文上传）
    if (text != null && text.length > IMPORT_SOURCE_MAX_CHARS) {
      text = text.slice(0, IMPORT_SOURCE_MAX_CHARS)
    }
    src.cache.set(cacheKey, text)
    return text
  }
  const sourceKey = (rep: HtArchiveReport): string => {
    const src = rep.srcIdx != null ? sources[rep.srcIdx] : undefined
    if (!src) return `none:${rep.path}`
    // 单文件导入：一份文件只上传一次（多靶点合并报告内嵌全部子页）。
    // zip：逐成员文件上传（rep.path = zip 内路径，各成员独立成报告）
    return src.isZip ? `z:${rep.srcIdx}:${rep.path}` : `f:${rep.srcIdx}`
  }
  return { reports: out, readSource, sourceKey }
}

// ── v2.69 导入报告统计快照解析（v2.72 起实现在前后端共享模块 lib/eval/imported-stats.ts
//    —— 此处薄包装维持旧导出签名，见共享模块头部注释）──

/** v2.69→v2.72：解析一份报告 HTML 内全部靶点区段的统计快照（含 meta 标记对齐）。 */
export function extractImportedStatsSections(html: string): ImportedReportStats[] {
  return extractImportedStatsSectionsShared(html)
}

/** v2.69→v2.72：区段 → 靶点定位（增强定位链见共享模块；单区段直接命中）。 */
export function pickImportedStats(
  sections: ImportedReportStats[],
  t: { acc?: string; range?: [number, number]; length?: number; seqSha?: string; label?: string },
): ImportedReportStats | undefined {
  const hit = pickImportedStatsShared(sections as ImportedStatsSection[], t)
  return hit ? toCleanImportedStats(hit) : undefined
}

/** v2.69：导入 enrich 单项（匹配到的靶点 + 胜出的报告条目；v2.72 增 seqSha/label
 *  —— 提交序列 SHA 精确定位 + 同长歧义时标签消歧） */
export interface ImportEnrichItem {
  acc?: string
  range?: [number, number]
  length?: number
  /** v2.72：提交序列 SHA-256 前 16 hex（调用方已算好 — 靶点循环里 sha256Hex16 复用） */
  seqSha?: string
  /** v2.72：运行侧标签（同长歧义时的标签消歧通道） */
  label?: string
  rep?: HtArchiveReport
}

/** v2.69：为匹配到的导入靶点解析统计快照并上传报告原文 — 返回逐项结果
 *  （stats 缺失 = 降级行；reportId 缺失 = 弹出页无原文可内嵌；两者独立降级）。
 *  任一步骤失败都不阻塞导入（导入匹配本身不受影响）。上传按源文件去重
 *  （同一文件只传一次 — 合并报告整组共享）。
 *  v2.81：源文件 HTML 一部落入浏览器本地留存（ht-import-cache — 内容哈希
 *  sourceSha 随条目返回）。导入时上传失败/事后服务端留存丢失时，汇总报告
 *  生成前可按 sha 取回缓存重新上传自愈（ensureImportedRetention）— 弹出页
 *  原文内嵌不再取决于导入那一瞬间的上传成败。 */
export async function enrichImportedReports(
  items: ImportEnrichItem[],
  parsed: HtImportParseResult,
): Promise<Array<{ stats?: ImportedReportStats; reportId?: string; sourceSha?: string }>> {
  const out: Array<{ stats?: ImportedReportStats; reportId?: string; sourceSha?: string }> = items.map(() => ({}))
  if (items.length === 0) return out
  // 源文件分组：同一源文件只读一次 / 只上传一次（loaded = 已尝试读取，读到 0 个区段也不重试）
  const bySource = new Map<string, { rep: HtArchiveReport; sections: ImportedStatsSection[]; reportId?: string; sourceSha?: string; loaded?: boolean }>()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    const rep = it.rep
    if (!rep || rep.kind === 'dashboard') continue
    const key = parsed.sourceKey(rep)
    let entry = bySource.get(key)
    if (!entry) {
      entry = { rep, sections: [] }
      bySource.set(key, entry)
    }
    // 逐项解析区段（同一源文件的多个靶点各自定位自己的子页）
    if (entry.sections.length === 0 && !entry.loaded) {
      entry.loaded = true
      const text = await parsed.readSource(rep)
      if (text) {
        entry.sections = extractImportedStatsSectionsShared(text)
        // v2.70：上传按 32MB 上限独立门控（超大文件统计照常解析，仅不内嵌原文 —
        //  readSource 的 33M 切片不会作为原文上传，此处长度检查双重保险）
        if (text.length <= IMPORTED_UPLOAD_MAX_CHARS) {
          const base = (rep.path.split('::')[0] ?? rep.path).split('/').pop() ?? ''
          const fileName = base.replace(/\.html?$/i, '').slice(0, 100) || '导入报告'
          // v2.81：浏览器本地留存（与上传并行 — 上传失败/事后丢失均可凭 sha 自愈重传）
          entry.sourceSha = await saveImportedSource(`${fileName}.html`, text).catch(() => undefined)
          entry.reportId = await uploadImportedReport(`${fileName}.html`, text)
        }
      }
    }
    const stats = pickImportedStatsShared(entry.sections, it)
    if (stats) out[i]!.stats = toCleanImportedStats(stats)
    if (entry.reportId) out[i]!.reportId = entry.reportId
    if (entry.sourceSha) out[i]!.sourceSha = entry.sourceSha
  }
  return out
}

/** v2.81：留存自愈的单项输入（导入靶点 — reportId 与内容哈希至少有其一） */
export interface RetentionCheckItem {
  reportId?: string
  sha?: string
}

/**
 * v2.81：汇总报告生成前的导入留存校验 + 自愈重传（「报告没有内嵌」根治）。
 *
 * 流程：① 收集全部 reportId → GET 批量校验服务端留存（记录在 + 归属匹配 +
 * 文件在）；② 缺失/无 reportId 但有 sha 的源文件 → 从浏览器本地留存
 * （ht-import-cache）取回 HTML 重新上传，拿新的 reportId；③ 返回
 * sha → 新 reportId 映射（调用方回写运行记录，持久化自愈结果）。
 *
 * 设计边界：
 *  - 校验端点不可达 → 返回空映射（视同全部存活 — 服务端不可用时生成本就
 *    无法进行，不盲目触发上百 MB 重传）；
 *  - 本地缓存也没有（旧版运行记录无 sha / IndexedDB 被清）→ 该源文件保持
 *    现状（服务端留存若仍在则照常用；确实丢失则弹出页降级 — 与 v2.80 行为
 *    一致，不劣化）；
 *  - 单份重传失败 → 跳过继续（尽力而为，不阻塞汇总生成）。
 *
 * 返回：{ fixed: sha→新 reportId, reuploaded: 重传成功数, stillMissing: 仍无
 * 可用留存的源文件数 }。
 */
export async function ensureImportedRetention(
  items: RetentionCheckItem[],
  opts: { onProgress?: (msg: string) => void; uploadConcurrency?: number } = {},
): Promise<{ fixed: Map<string, string>; reuploaded: number; stillMissing: number }> {
  const { onProgress, uploadConcurrency = 3 } = opts
  const fixed = new Map<string, string>()
  const uniqueIds = [...new Set(items.map(i => i.reportId).filter((x): x is string => Boolean(x)))]
  if (uniqueIds.length === 0 && items.every(i => !i.sha)) return { fixed, reuploaded: 0, stillMissing: 0 }
  // ① 批量校验（60 id/请求 — 端点上限同口径）
  const missingIds = new Set<string>()
  if (uniqueIds.length > 0) {
    onProgress?.(`校验 ${uniqueIds.length} 份导入报告的服务端留存…`)
    for (let i = 0; i < uniqueIds.length; i += 60) {
      const chunk = uniqueIds.slice(i, i + 60)
      const r = await verifyImportedReports(chunk)
      if (!r) {
        // 端点不可达 — 视同全部存活（不盲目重传）
        onProgress?.('留存校验暂不可用 — 沿用既有服务端留存')
        return { fixed, reuploaded: 0, stillMissing: 0 }
      }
      for (const m of r.missing) missingIds.add(m)
    }
  }
  // ② 需自愈的源文件（reportId 缺失/死亡 且有 sha）— 按 sha 去重
  const brokenShas = new Set<string>()
  for (const it of items) {
    if (!it.sha) continue
    if (!it.reportId || missingIds.has(it.reportId)) brokenShas.add(it.sha)
  }
  if (brokenShas.size === 0) return { fixed, reuploaded: 0, stillMissing: missingIds.size }
  // ③ 从本地留存取回并重传（限并发 — 百份 × MB 级不能全量齐发）
  let reuploaded = 0
  let stillMissing = 0
  const queue = [...brokenShas]
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(uploadConcurrency, queue.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= queue.length) return
      const sha = queue[i]!
      const src = await getImportedSource(sha)
      if (!src) { stillMissing++; continue }
      const newId = await uploadImportedReport(src.fileName, src.html)
      if (newId) {
        fixed.set(sha, newId)
        reuploaded++
        onProgress?.(`重新上传导入报告原文 ${reuploaded}/${queue.length}（${src.fileName.slice(0, 40)}）…`)
      } else {
        stillMissing++
      }
    }
  })
  await Promise.all(workers)
  return { fixed, reuploaded, stillMissing }
}

/**
 * 解析一份报告 zip → 可匹配报告列表。
 * 失败（非 zip / 损坏 / 空）抛错（调用方 toast）。
 */
export async function parseHtArchive(file: File): Promise<HtArchiveReport[]> {
  const zip = await JSZip.loadAsync(file).catch(() => {
    throw new Error('无法读取该 zip 文件（可能不是有效的 zip 归档）')
  })
  return parseHtArchiveEntries(zip)
}

/** zip 实例 → 可匹配报告条目（v2.69 抽出 — parseHtImportFiles 复用已解开的实例） */
async function parseHtArchiveEntries(zip: JSZip): Promise<HtArchiveReport[]> {
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]?.dir).slice(0, MAX_ZIP_FILES)

  // ── ① 清单通道 ──
  const manifestFile = zip.file('_TargetEval_manifest.json')
  if (manifestFile) {
    try {
      const raw = JSON.parse(await manifestFile.async('text')) as { version?: number; entries?: ManifestEntry[] }
      if (Array.isArray(raw.entries)) {
        const entries = raw.entries.filter((e) => e && e.kind && e.path)
        // v2.45：合并报告的组内靶点数 = 清单中同组的 job 条目数（组号通道校验用）
        const jobCountByGroup = new Map<number, number>()
        for (const e of entries) {
          if (e.kind === 'job' && e.group != null && e.group >= 1) {
            jobCountByGroup.set(e.group, (jobCountByGroup.get(e.group) ?? 0) + 1)
          }
        }
        return entries.map((e) => ({
          kind: e.kind,
          path: e.path,
          jobId: e.kind === 'job' && e.jobId && /^[a-z0-9]{20,40}$/i.test(e.jobId) ? e.jobId : undefined,
          uniprot: e.uniprot,
          range: Array.isArray(e.range) && e.range.length === 2 ? [Number(e.range[0]), Number(e.range[1])] : undefined,
          seqSha: e.seqSha,
          seqLength: e.seqLength,
          sequenceHeader: e.sequenceHeader,
          stem: (e.path.split('/').pop() ?? e.path).replace(/\.html?$/i, ''),
          group: e.group != null && e.group >= 1 ? e.group : undefined,
          targetCount: e.kind === 'merged' && e.group != null ? jobCountByGroup.get(e.group) : undefined,
        }))
      }
    } catch {
      // 清单损坏 → 走旧 zip 兜底
    }
  }

  // ── ② 旧 zip 兜底：文件名 + <title> 解析 ──
  const out: HtArchiveReport[] = []
  for (const name of names) {
    if (!/\.html?$/i.test(name)) continue
    const base = name.split('/').pop() ?? name
    if (base.startsWith('00_统计看板') || base.startsWith('_README')) continue
    const stem = base.replace(/\.html?$/i, '')
    const rep: HtArchiveReport = { kind: 'job', path: name, stem }
    // v2.45：zip 路径中的组目录前缀（G05/xxx.html）
    const dirGroupM = /^G(\d{1,3})\//.exec(name)
    if (dirGroupM) rep.group = Number(dirGroupM[1])
    // 文件名中的 accession（UniProt 靶点的文件名 = label = accession）
    const accM = UNIPROT_ACC_RE.exec(stem)
    if (accM) rep.uniprot = accM[0].toUpperCase()
    // 文件名中的长度段（序列靶点「· 305aa」）
    const lenM = /(\d{2,5})\s*aa$/i.exec(stem)
    if (lenM) rep.seqLength = Number(lenM[1])
    // 题目补充（「蛋白名（P0DTC2 · 残基 16-1273）」— 区间证据；文件名无 acc 时兜底）
    try {
      const head = (await zip.files[name].async('text')).slice(0, MAX_HTML_HEAD_CHARS)
      // v2.68：报告内嵌的作业标记（新报告 — 汇总生成时恢复服务端统计）
      const jm = /<meta\s+name="targeteval:job"\s+content="([^"]*)"/i.exec(head)
      if (jm) {
        try {
          const j = JSON.parse(unescapeAttr(jm[1]!)) as { jobId?: unknown }
          if (j && typeof j.jobId === 'string' && /^[a-z0-9]{20,40}$/i.test(j.jobId)) rep.jobId = j.jobId
        } catch { /* 损坏标记忽略 */ }
      }
      const titleM = /<title>([^<]*)<\/title>/i.exec(head)
      const title = titleM?.[1] ?? ''
      // v2.45：题目尾标签清单「标题 · A + B + C」→ 合并报告（kind 修正 + 靶点数）
      const mergedTailM = /^(.*) · (.+ \+ .+)$/.exec(title)
      if (mergedTailM) {
        rep.kind = 'merged'
        rep.targetCount = mergedTailM[2].split(' + ').filter((s) => s.trim()).length
      }
      if (!rep.uniprot) {
        const tAcc = UNIPROT_ACC_RE.exec(title)
        if (tAcc) rep.uniprot = tAcc[0].toUpperCase()
      }
      const rangeM = /残基\s*(\d{1,5})\s*[-–]\s*(\d{1,5})/.exec(title)
      if (rangeM) {
        const s = Number(rangeM[1])
        const e = Number(rangeM[2])
        if (s >= 1 && e >= s) rep.range = [s, e]
      }
      if (!rep.seqLength) {
        const tLen = /(\d{2,5})\s*(?:个氨基酸残基|aa)/i.exec(title)
        if (tLen) rep.seqLength = Number(tLen[1])
      }
    } catch {
      // 单文件读取失败 → 保留文件名证据继续
    }
    out.push(rep)
  }
  return out
}
