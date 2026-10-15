# TargetEval · 靶点结构解析可行性评估平台

从 [pdb-tracker-web-v5](https://github.com/Jing0715-fer/pdb-tracker-web-v5) 拆分出的**蛋白靶点评估**独立 Web 应用：输入 UniProt ID、氨基酸序列或 Word 评估表，自动完成多数据库数据收集与可行性评分，生成含 LLM 分析的 HTML 评估报告。

> **v1.6 公网加固**：多用户数据隔离（按来源 IP）+ 并发/配额限制 + **分块上传与后台异步解析**（突破网关 ~30s 请求超时，修复公网 502），详见[公网部署](#公网部署)。

## 功能特性

### 三种输入方式
- **UniProt ID**：如 `P00533`（EGFR）、`P04637`（p53）；可附**可选伴随序列**（构建序列）— 与 UniProt 同靶点时自动**合并为一次评估**并分析构建边界
- **氨基酸序列**：FASTA 或裸序列（自动尝试识别对应 UniProt 条目，失败则由 BLAST 兜底回填）
- **Word 评估表**（.docx，≤20MB）：自动解析出
  - UniProt ID / 基因名 / 蛋白序列
  - **AI 智能解析要点**（LLM 提取）：客户目标、待解决的科学问题、实验数据要点、构建/序列说明、同源信息与风险关注点
  - **SDS-PAGE 胶图 / SEC 分子筛色谱图**等实验图片，上传即分类展示并随报告嵌入：
    - **全格式支持**：PNG / JPG / GIF / WebP / BMP / TIFF / **EMF / WMF**（Word 粘贴矢量图自动转 PNG，LibreOffice headless；超大图自动降采样到长边 ≤1600px，sharp）
    - **AI 视觉识别**（VLM）：逐图判定 gel / sec / other 类型并提取关键读数（泳道数与条带单一性、主峰位置与对称性等），与图注上下文关键词分类交叉兜底；识别结果带 `AI` 角标
    - 无法提取的图片（损坏/超限）计入 `skippedImages` 并在前端明确提示
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

### 轻量化与内存优化（4GB 沙箱 / 小型云主机可流畅运行）
- 评估作业**全局串行执行**，任意时刻最多 1 个作业占用资源；**全局排队上限 8**、**每 IP 同时活跃（排队+运行）≤ 2**、**每 IP 24h 创建 ≤ 30 次评估**，超限 429 + 中文提示（带 Retry-After）
- docx 解析（mammoth + sharp + VLM）**全局并发信号量 ≤ 2**（等待队列 ≤ 4，超限 429）— 上传解析是内存峰值主源，必须有界
- 上传限流：**每 IP 24h ≤ 20 份文档**（滑动窗口）；单文件 ≤ 20MB
- 作业注册表 **LRU ≤ 20**，终态作业超限即逐出（历史从 SQLite 重建）
- **终态作业 TTL 自动清理**（默认 7 天，每至多 1h 惰性触发一次，DB 行 + 磁盘报告目录一并回收）；上传目录 TTL 24h
- 外部 API 响应 **LRU 缓存（≤100 条 / ≤5MB）**
- PDB 详情分批拉取（并发 5，默认上限 150 条）；图片资产：原始单张 ≤6MB → 处理后每张有界（长边 ≤1600px、>800KB 再压 JPEG），每报告 ≤12 张、报告内嵌 ≤8 张 / 总预算 ≤6MB
- 图片处理有界：EMF/WMF 转换 soffice 单次批量（≤45s 超时）；VLM 逐图识别限前 6 张、小并发 2、单图 ≤25s（失败回退关键词分类）
- 上传目录 TTL 回收（24h 后台清理），删除评估作业**不**级联删除上传目录（共享资产，防止解析结果 404 / 丢图）
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

## 公网部署（v1.6 加固）

面向公网多用户场景的安全与稳定性设计：

### 网关超时对策（v1.6，修复公网 502）

云平台/ALB 类网关通常对**单个 HTTP 请求有 ~30s 硬超时**（含请求体上传与服务端处理）。评估表直传单请求内同步完成「上传+解析」（多图 VLM 识别预算 90s，慢速上传 20MB 可达分钟级）必然被掐断返回 502。

v1.6 起前端改走**分块上传 + 后台异步解析**，所有请求均为短请求：

```
init（毫秒级，建会话+配额检查）
 → chunk ×N（2MB/块，原始二进制 PUT，逐块重试）
 → complete（毫秒级，后台队列解析）
 → status 每 1.5s 轮询（uploading/queued/parsing/done/error）
```

- 单块 2MB 在 100KB/s 慢速网络下约 20s，仍低于网关超时；失败自动重试 3 次
- 解析在后台队列执行（与直传路由共享全局解析信号量，并发恒 ≤2，内存有界），
  多图 VLM 识别耗时不再影响 HTTP 响应时长
- 未完成会话 30min 自动回收；insights 智能解析 25s 墙钟兜底（超时回退规则提取，可重试）
- 前端上传面板展示分块进度条与「后台解析中」提示
- 旧直传接口 `POST /api/evaluate/upload` 保留（内网/快网络小文件兼容）

### 数据隔离（按来源 IP）
- **归属键**：请求来源 IP 的 SHA-256 前 24 位（DB 不落明文 IP；仅存掩码如 `203.0.113.*` 供排障）
- 作用范围：**作业列表**只返回本人记录；**作业详情 / 取消删除 / HTML 报告 / 评估表图片 / 智能解析 / docx 评估引用**均需归属匹配，他人访问一律 404/403（不暴露资源存在性）
- 上传目录写入 `owner.json`（IP 哈希）标记归属；实验图片（胶图/SEC）属涉密数据，跨用户访问一律拒绝
- 前端「历史评估 / 最近评估」标题处展示「仅自己可见」标识；页脚标注隔离与保留策略

### 并发与配额（防 OOM / 防滥用）

| 限制项 | 默认值 | 环境变量 | 超限行为 |
|---|---|---|---|
| 全局排队中作业上限 | 8 | `EVAL_MAX_QUEUE` | 429 服务器繁忙 |
| 每 IP 同时活跃（排队+运行）作业 | 2 | `EVAL_MAX_ACTIVE_PER_IP` | 429 提示等待 |
| 每 IP 24h 创建评估数 | 30 | `EVAL_MAX_JOBS_PER_DAY` | 429 明日再试 |
| 每 IP 24h 上传文档数 | 20 | `EVAL_MAX_UPLOADS_PER_DAY` | 429 明日再试 |
| docx 解析全局并发 | 2 | `EVAL_PARSE_CONCURRENCY` | 排队；等待超限 429 |
| 解析等待队列上限 | 4 | `EVAL_PARSE_WAIT_LIMIT` | 429 解析繁忙 |
| 终态作业保留天数 | 7 | `EVAL_JOB_TTL_DAYS` | 自动清理（DB+磁盘） |

### 部署检查清单
1. **置于反向代理之后**（Caddy/Nginx/云网关）并传递真实 IP：
   ```caddy
   example.com {
     reverse_proxy localhost:3000 {
       header_up X-Forwarded-For {remote_host}
       header_up X-Real-IP {remote_host}
     }
   }
   ```
   > 未接代理时所有直连请求同属 `direct` 归属组（本地开发联机调试够用；公网必须接代理隔离用户）
2. **确认网关超时配置**：若自建网关超时 < 60s，无需担心 —— 分块上传/后台解析流程下所有请求均为短请求；若仍使用旧直传接口需保证 ≥120s
3. **EMF/WMF 矢量图依赖 LibreOffice**：服务器需安装 `soffice`（Debian/Ubuntu: `apt-get install libreoffice-core`；镜像部署见 Docker 示例），未安装时矢量图自动跳过（前端提示张数），不影响其余功能
4. `db/custom.db` 与 `db/reports/` 均含用户数据，注意宿主磁盘权限与备份策略；终态记录 7 天自动清理
5. 外部 LLM API Key 明文存本地 SQLite，公网开放给不可信人群前建议改用内置引擎或为配置面板加访问控制
6. 操作系统层建议配套：内存限制（systemd `MemoryMax` / 容器 memory limit）、磁盘告警（报告与上传产物占空间）

## API 一览

> 所有涉及用户数据的接口均按来源 IP 隔离（仅创建者可访问自己的资源）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/evaluate` | 创建评估作业（mode: uniprot / sequence / docx；uniprot 模式可附 sequence 伴随序列）；配额超限 429 |
| POST | `/api/evaluate/upload` | 直传解析（multipart `file`，单请求同步解析；内网/快网络用，公网请走下方分块流程） |
| POST | `/api/evaluate/upload/init` | 分块上传①：创建会话（配额检查 + 归属标记）→ `{uploadId, chunkSize}` |
| PUT | `/api/evaluate/upload/chunk?uploadId&offset` | 分块上传②：追加原始二进制块（2MB/块，顺序上传，逐块重试） |
| POST | `/api/evaluate/upload/complete` | 分块上传③：校验完整性并触发**后台异步解析**（毫秒级返回） |
| GET | `/api/evaluate/upload/status?uploadId` | 分块上传④：轮询解析状态（done 时返回与直传同构的 parsed 载荷） |
| POST | `/api/evaluate/insights` | 评估表 LLM 智能解析（目标/科学问题/实验要点，结果缓存；仅上传者；25s 墙钟兜底） |
| GET | `/api/jobs` | 本人最近作业列表（按 IP 归属过滤） |
| GET | `/api/jobs/{id}` | 作业详情 / 进度轮询（2s；pending 附 queuePosition） |
| DELETE | `/api/jobs/{id}` | 取消 / 删除作业（含磁盘产物；仅创建者） |
| GET | `/api/jobs/{id}/report` | HTML 报告（`?download=1` 触发下载；仅创建者） |
| GET | `/api/assets/{id}` | 评估表图片流（仅归属者） |
| GET | `/api` | 健康检查 + 服务器负载状态（队列/解析占用，无用户数据） |
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
    docx.ts                   # Word 评估表解析（文本 + 图片提取/归一化/分类落盘）
    image-process.ts          # 图片处理管线（EMF/WMF→PNG · 大图降采样 · VLM 类型识别）
    docx-llm.ts               # 评估表 LLM 智能解析（目标/科学问题/实验要点提取）
    seq-compare.ts            # 轻量序列比对（同靶点判定 + 构建边界估计）
    llm-provider.ts           # 多供应商统一调用（zai/openai/anthropic/google）+ 配置 + 模型列表
    request-guard.ts          # 公网隔离：来源 IP 解析 + 归属键（SHA-256）+ 掩码 + 访问判定
    gatekeeper.ts             # 并发/配额守卫：队列与日配额 + 解析信号量 + 作业 TTL 清理
    upload-owner.ts           # 上传目录归属标记（owner.json）与校验
    pipeline.ts               # 8 阶段评估管线（含合并评估/构建比对/insights 集成）
    job-manager.ts            # 串行队列 + 作业注册表 + 进度
    llm.ts / report.ts        # LLM 调用封装 + 三段式 LLM 报告编排
    report-html.ts            # 独立 HTML 报告渲染
prisma/schema.prisma          # EvaluationJob（含 ownerKey/ownerMask）+ ReportAsset + LlmConfig
tests/make_test_docx.py       # 无图评估表测试文档生成脚本（真实 EGFR 激酶域序列）
```

## 说明
- LLM 生成的「评估分析」章节基于检索数据上下文，可能存在解读偏差；关键决策请以原始数据库与文献为准
- 仅支持 .docx（旧版 .doc 请先另存为 .docx）；BLAST 依赖 NCBI 队列，高峰期可能需要 1-5 分钟或超时跳过（不影响其余阶段）
- 外部 LLM 的 API Key 明文存于本地 SQLite（`db/custom.db`），面向内网/单机沙箱场景设计；公网部署建议见[公网部署检查清单](#公网部署v15-加固)
- 数据隔离基于来源 IP（无账号体系），同一出口 IP（公司/NAT）下的用户共享同一归属组；升级前创建的历史记录（ownerKey 为 null）不再出现在列表中，但仍可通过原链接访问
