# TargetEval · 靶点结构解析可行性评估平台

从 [pdb-tracker-web-v5](https://github.com/Jing0715-fer/pdb-tracker-web-v5) 拆分出的**蛋白靶点评估**独立 Web 应用：输入 UniProt ID、氨基酸序列或 Word 评估表，自动完成多数据库数据收集与可行性评分，生成含 LLM 分析的 HTML 评估报告。

## 功能特性

### 三种输入方式
- **UniProt ID**：如 `P00533`（EGFR）、`P04637`（p53）；可附**可选伴随序列**（构建序列）— 与 UniProt 同靶点时自动**合并为一次评估**并分析构建边界
- **氨基酸序列**：FASTA 或裸序列（自动尝试识别对应 UniProt 条目，失败则由 BLAST 兜底回填）
- **Word 评估表**（.docx，≤20MB）：自动解析出
  - UniProt ID / 基因名 / 蛋白序列
  - **AI 智能解析要点**（LLM 提取）：客户目标、待解决的科学问题、实验数据要点、构建/序列说明、同源信息与风险关注点
  - **SDS-PAGE 胶图 / SEC 分子筛色谱图**等实验图片（按图注上下文自动分类，随报告展示）
  - UniProt 与序列可**同时选择**：同靶点自动合并为单次评估（以 UniProt 为主，序列做构建边界分析），避免重复评估

### 同靶点去重与构建边界分析
当同一靶点的 UniProt ID 与序列同时提供时（评估表双选 / UniProt Tab 伴随序列），系统以**轻量序列比对**（精确子串 → 首/尾锚点定位 → 8-mer Jaccard 兜底）判定是否同一靶点：
- **同一靶点**（identity ≥85% 或完全子串）→ 合并为一次评估，估计构建对应全长区间（如 713–979 位），报告构建设计章节优先评估客户已有构建边界的合理性
- **疑似不同靶点** → 以 UniProt 为准评估并给出警告，杜绝重复评估
- 构建信息在结果页（客户构建 chip）与报告封面元数据中均有呈现

### LLM 引擎配置（多供应商）
顶栏⚙️入口打开配置面板，内置引擎开箱即用，也可切换至主流供应商或自定义端点：
- **内置**：Z.ai GLM-4.6（默认，无需任何配置）
- **OpenAI 兼容协议**：OpenAI / DeepSeek / 通义千问（DashScope）/ 智谱 GLM / Kimi（月之暗面）/ MiniMax / 豆包（火山方舟）/ xAI Grok / OpenRouter / Ollama 本地 / 自定义任意 OpenAI 兼容端点
- **原生协议**：Anthropic（Claude，Messages API）、Google（Gemini，generateContent）
- **自动获取模型列表**：一键从供应商 API 拉取模型（≤300 个，支持输入过滤），无需手动查文档
- **测试连接**：保存前极小 prompt 验证连通性与延迟
- API Key 仅存本地 SQLite 供服务端调用，前端始终脱敏显示；当前引擎在页脚与报告封面元数据中标注

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
- **期刊版式**：学术风封面头（双线刊头 + 元数据栅格 + 目录）、衬线标题、等宽数据表格、结构化评分卡；单文件高度独立、还原学术期刊质感
- **封面元数据**：UniProt / 基因 / 物种 / 覆盖率 / PDB 统计 / **客户构建** / **分析引擎** / 报告日期
- **PDB ↔ 文献关联**：PDB 主引文（结构解析论文）自动并入文献列表并置前标记「结构解析文献」；每篇文献下方展示其对应的**关联结构 PDB chips**（链接 RCSB）；PDB 表中 PMID 悬停显示对应文献标题
- **长列表折叠**：报告内 PDB 清单（前 20 直出）与文献列表（前 10 直出）超出部分以 `details` 折叠，打印时自动展开；前端结果页同样支持展开/收起
- **结论先行**：执行摘要直接给总体结论与推荐方法
- **客户目标与可行性结论**（强化）：可行性分级（高/中/低）+ 关键依据 + 主要风险 + 达成建议；评估表提取的**待解决科学问题逐条回应**
- **已有结构研究全景**（强化）：研究历程时间线、方法学分布、代表性结构点名、构象状态与配体覆盖、覆盖空白区及研究机会
- **实验数据评估**：有胶图/SEC 图时做样品质量判读（纯度、单分散性、是否达到结构解析级别）；**无图时**基于 LLM 从评估表文本提取的实验数据要点（表达/纯化/稳定性描述）评估样品信息完备度并给出待补质控清单
- **构建设计**（客户已提供构建序列时）：先评估客户构建边界与结构域边界/已有覆盖区间的匹配度，再给微调建议（禁止无视客户构建另起炉灶）
- **确定性数据区块**（防 LLM 幻觉）：PDB 完整清单、BLAST 同源表、文献列表（PMID 链接）、评分条、实验图片画廊均由模板直接渲染
- 报告为**单文件 HTML**（内联 CSS、图片 base64 内嵌、打印友好），可离线打开或另存分发

### 界面（学术工具风）
- 衬线展示字体标题 + 等宽眉题标签 + 发丝线边框的「学术期刊 × 科学仪器」设计语言，支持深色模式与移动端单列布局
- 结果页规格格栅（Spec Grid）一屏呈现关键指标；编号章节导航
- 顶栏字标随时可点返回首页，结果页顶部/底部均有「新建评估」入口，长流程不迷路
- 评估表上传后 **AI 智能解析要点**卡片即时展示（目标可点击回填、科学问题编号列表、实验要点折叠展开）

### 轻量化与内存优化（4GB 沙箱可流畅运行）
- 评估作业**全局串行执行**，任意时刻最多 1 个作业占用资源
- 作业注册表 **LRU ≤ 20**，终态作业超限即逐出（历史从 SQLite 重建）
- 外部 API 响应 **LRU 缓存（≤100 条 / ≤5MB）**
- PDB 详情分批拉取（并发 5，默认上限 150 条）；图片资产单张 ≤2MB、每报告 ≤12 张、报告内嵌 ≤8 张 / 总预算 ≤6MB
- LLM 调用分体控制：报告**三段式生成**（每段输入输出体积受限）、评估表智能解析输入 ≤14KB / 输出 ≤4KB、模型列表 ≤300 条
- 序列比对零依赖轻量实现（无 DP 矩阵：子串/锚点/k-mer），5000+ aa 毫秒级
- LLM 引擎配置全局单例缓存（TTL 30s + 变更即失效）
- 报告 HTML 落盘、SQLite 仅存摘要 JSON；前端 2s 轮询而非长连接
- dev 脚本默认 `MALLOC_ARENA_MAX=2` + `--max-old-space-size=1400` 堆上限

## 技术栈
Next.js 16（App Router）· TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma + SQLite · z-ai-web-dev-sdk（默认内置引擎，仅后端）· 可配置外部 LLM（OpenAI 兼容 / Anthropic / Gemini）· mammoth（docx 解析）

## 快速开始

```bash
bun install
cp .env.example .env          # 配置 DATABASE_URL
bun run db:push               # 初始化 SQLite schema
bun run dev                   # http://localhost:3000
```

生产构建：`bun run build && bun start`

> 首次启动即用内置 Z.ai 引擎，无需任何 Key；需要切换供应商时在页面右上角⚙️「LLM 分析引擎配置」中填入对应 API Key。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/evaluate` | 创建评估作业（mode: uniprot / sequence / docx；uniprot 模式可附 sequence 伴随序列） |
| POST | `/api/evaluate/upload` | 上传 Word 评估表（multipart `file`） |
| POST | `/api/evaluate/insights` | 评估表 LLM 智能解析（目标/科学问题/实验要点，结果缓存） |
| GET | `/api/jobs` | 最近作业列表 |
| GET | `/api/jobs/{id}` | 作业详情 / 进度轮询（2s） |
| DELETE | `/api/jobs/{id}` | 取消 / 删除作业（含磁盘产物） |
| GET | `/api/jobs/{id}/report` | HTML 报告（`?download=1` 触发下载） |
| GET | `/api/assets/{id}` | 评估表图片流 |
| GET/POST/DELETE | `/api/llm/config` | 读取 / 保存启用 / 重置 LLM 引擎配置（Key 脱敏返回） |
| POST | `/api/llm/models` | 拉取供应商模型列表（服务端代发，Key 不落前端） |
| POST | `/api/llm/test` | 测试引擎连通性（极小 prompt） |

## 项目结构

```
src/
  instrumentation.ts           # 服务器启动钩子（undici autoSelectFamily 尝试超时 5s，修沙箱出站 fetch）
  app/
    page.tsx                  # 单页应用（输入 → 进度 → 结果 三态视图）
    api/                      # evaluate / jobs / assets / llm 路由
  components/eval/            # 输入面板、进度面板、结果视图、LLM 配置面板、历史对话框等
  lib/eval/
    types.ts                  # 共享类型 + 阶段定义
    cache.ts                  # LRU 响应缓存
    uniprot.ts / rcsb.ts / pdbe.ts / blast.ts / pubmed.ts   # 数据源访问层
    score.ts                  # 三方法可行性评分
    docx.ts                   # Word 评估表解析（文本 + 图片分类提取）
    docx-llm.ts               # 评估表 LLM 智能解析（目标/科学问题/实验要点提取）
    seq-compare.ts            # 轻量序列比对（同靶点判定 + 构建边界估计）
    llm-provider.ts           # 多供应商统一调用（zai/openai/anthropic/google）+ 配置 + 模型列表
    pipeline.ts               # 8 阶段评估管线（含合并评估/构建比对/insights 集成）
    job-manager.ts            # 串行队列 + 作业注册表 + 进度
    llm.ts / report.ts        # LLM 调用封装 + 三段式 LLM 报告编排
    report-html.ts            # 独立 HTML 报告渲染
prisma/schema.prisma          # EvaluationJob + ReportAsset + LlmConfig
tests/make_test_docx.py       # 无图评估表测试文档生成脚本（真实 EGFR 激酶域序列）
```

## 说明
- LLM 生成的「评估分析」章节基于检索数据上下文，可能存在解读偏差；关键决策请以原始数据库与文献为准
- 仅支持 .docx（旧版 .doc 请先另存为 .docx）；BLAST 依赖 NCBI 队列，高峰期可能需要 1-5 分钟或超时跳过（不影响其余阶段）
- 外部 LLM 的 API Key 明文存于本地 SQLite（`db/custom.db`），面向内网/单机沙箱场景设计；如需公网部署请自行加密或改用环境变量
