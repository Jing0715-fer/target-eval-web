# TargetEval · 靶点结构解析可行性评估平台

从 [pdb-tracker-web-v5](https://github.com/Jing0715-fer/pdb-tracker-web-v5) 拆分出的**蛋白靶点评估**独立 Web 应用：输入 UniProt ID、氨基酸序列或 Word 评估表，自动完成多数据库数据收集与可行性评分，生成含 LLM 分析的 HTML 评估报告。

## 功能特性

### 三种输入方式
- **UniProt ID**：如 `P00533`（EGFR）、`P04637`（p53）
- **氨基酸序列**：FASTA 或裸序列（自动尝试识别对应 UniProt 条目，失败则由 BLAST 兜底回填）
- **Word 评估表**（.docx，≤20MB）：自动解析出
  - UniProt ID / 基因名 / 蛋白序列
  - 客户目标与项目需求语句
  - **SDS-PAGE 胶图 / SEC 分子筛色谱图**等实验图片（按图注上下文自动分类，随报告展示）

### 数据源集成
| 数据源 | 用途 |
|---|---|
| UniProt REST | 蛋白元数据、序列、结构域/跨膜/信号肽等 features、功能注释 |
| RCSB PDB | 关联结构检索、entry 详情（方法/分辨率/配体/期刊/PMID）、GraphQL 批量配体 |
| PDBe (EBI) | best_structures 覆盖率计算、覆盖区间/空白区分析 |
| NCBI BLAST | blastp vs pdbaa 同源结构检索（覆盖不足时自动触发，含 UniProt 回填增强路径） |
| PubMed eutils | 靶点结构生物学文献检索（标题/期刊/DOI/摘要） |

### 可行性评分（1-10）
基于序列长度、跨膜特征、已有结构先例（方法学 + 分辨率）、结构覆盖率与 BLAST 同源 identity，对 **X-ray / Cryo-EM / NMR** 三种方法独立评分并给出评分依据。

### HTML 评估报告（相对原项目的格式优化）
- **期刊版式**：学术风封面头（双线刊头 + 元数据栅格 + 目录）、衽线标题、等宽数据表格、结构化评分卡；单文件高度独立、还原学术期刊质感
- **PDB ↔ 文献关联**：PDB 主引文（结构解析论文）自动并入文献列表并置前标记「结构解析文献」；每篇文献下方展示其对应的**关联结构 PDB chips**（链接 RCSB）；PDB 表中 PMID 悬停显示对应文献标题
- **长列表折叠**：报告内 PDB 清单（前 20 直出）与文献列表（前 10 直出）超出部分以 `details` 折叠，打印时自动展开；前端结果页同样支持展开/收起
- **结论先行**：执行摘要直接给总体结论与推荐方法
- **客户目标可行性**（强化）：可行性分级（高/中/低）+ 关键依据 + 主要风险 + 达成建议
- **已有结构研究全景**（强化）：研究历程时间线、方法学分布、代表性结构点名、构象状态与配体覆盖、覆盖空白区及研究机会
- **实验数据评估**（新增）：客户评估表胶图/SEC 的样品质量判读（纯度、单分散性、是否达到结构解析级别）与待补充信息清单
- **确定性数据区块**（防 LLM 幻觉）：PDB 完整清单、BLAST 同源表、文献列表（PMID 链接）、评分条、实验图片画廊均由模板直接渲染
- 报告为**单文件 HTML**（内联 CSS、图片 base64 内嵌、打印友好），可离线打开或另存分发

### 界面（学术工具风）
- 衬线展示字体标题 + 等宽眉题标签 + 发丝线边框的「学术期刊 × 科学仪器」设计语言，支持深色模式与移动端单列布局
- 结果页规格格栅（Spec Grid）一屏呈现关键指标；编号章节导航
- 顶栏字标随时可点返回首页，结果页顶部/底部均有「新建评估」入口，长流程不迷路

### 轻量化与内存优化（4GB 沙箱可流畅运行）
- 评估作业**全局串行执行**，任意时刻最多 1 个作业占用资源
- 作业注册表 **LRU ≤ 20**，终态作业超限即逐出（历史从 SQLite 重建）
- 外部 API 响应 **LRU 缓存（≤100 条 / ≤5MB）**
- PDB 详情分批拉取（并发 5，默认上限 150 条）；图片资产单张 ≤2MB、每报告 ≤12 张、报告内嵌 ≤8 张 / 总预算 ≤6MB
- LLM 报告**三段式生成**（每段输入输出体积受限），避免单次超长调用
- 报告 HTML 落盘、SQLite 仅存摘要 JSON；前端 2s 轮询而非长连接
- dev 脚本默认 `MALLOC_ARENA_MAX=2` + `--max-old-space-size=1400` 堆上限

## 技术栈
Next.js 16（App Router）· TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma + SQLite · z-ai-web-dev-sdk（GLM，仅后端）· mammoth（docx 解析）

## 快速开始

```bash
bun install
cp .env.example .env          # 配置 DATABASE_URL
bun run db:push               # 初始化 SQLite schema
bun run dev                   # http://localhost:3000
```

生产构建：`bun run build && bun start`

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/evaluate` | 创建评估作业（mode: uniprot / sequence / docx） |
| POST | `/api/evaluate/upload` | 上传 Word 评估表（multipart `file`） |
| GET | `/api/jobs` | 最近作业列表 |
| GET | `/api/jobs/{id}` | 作业详情 / 进度轮询（2s） |
| DELETE | `/api/jobs/{id}` | 取消 / 删除作业（含磁盘产物） |
| GET | `/api/jobs/{id}/report` | HTML 报告（`?download=1` 触发下载） |
| GET | `/api/assets/{id}` | 评估表图片流 |

## 项目结构

```
src/
  app/
    page.tsx                  # 单页应用（输入 → 进度 → 结果 三态视图）
    api/                      # evaluate / jobs / assets 路由
  components/eval/            # 输入面板、进度面板、结果视图、历史对话框等
  lib/eval/
    types.ts                  # 共享类型 + 阶段定义
    cache.ts                  # LRU 响应缓存
    uniprot.ts / rcsb.ts / pdbe.ts / blast.ts / pubmed.ts   # 数据源访问层
    score.ts                  # 三方法可行性评分
    docx.ts                   # Word 评估表解析（文本 + 图片分类提取）
    pipeline.ts               # 8 阶段评估管线
    job-manager.ts            # 串行队列 + 作业注册表 + 进度
    llm.ts / report.ts        # z-ai SDK 封装 + 三段式 LLM 报告编排
    report-html.ts            # 独立 HTML 报告渲染
prisma/schema.prisma          # EvaluationJob + ReportAsset
```

## 说明
- LLM 生成的「评估分析」章节基于检索数据上下文，可能存在解读偏差；关键决策请以原始数据库与文献为准
- 仅支持 .docx（旧版 .doc 请先另存为 .docx）；BLAST 依赖 NCBI 队列，高峰期可能需要 1-5 分钟或超时跳过（不影响其余阶段）
