/** 应用版本（单一来源）。
 *
 * v2.79：此前页脚硬编码 'v2.60.0' 从未随版本推进更新 — 用户回报错误时无法辨别
 *  其实际部署的代码版本（「统计看板生成超时」在 v2.77 与 v2.78 文案完全相同，
 *  但 v2.78 才有服务端僵死检测 — 拿不到版本就无法定位是哪一版的行为）。现在：
 *  - 页脚展示（app-footer.tsx）
 *  - 看板 POST/GET 响应附带 v 字段（服务端版本 — 前端据以自标注）
 *  - 前端轮询错误文案尾部自标注「前端 X · 服务端 Y」（api.ts verTag）—
 *    用户回报错误文本即可定位两端部署版本（浏览器缓存旧包/服务未重启立现）。
 *
 * v2.80：统计看板「更稳妥的打包」（用户实测 v2.79 重试后仍失败 — 重试新记录被
 *  同一环境因素再次杀死，「检测 + 重试」无法根治进程死亡）。根治思路 = 把交付
 *  从「AI 完成才有产物」改为「确定性产物先交付，AI 只是增强」：
 *  - 基础版先行落盘：统计 + 每靶点规则结论 + 内嵌报告原文（不依赖任何 AI 调用）
 *    先渲染落盘并写 DB 检查点；AI 成功后再原子重写增强版，失败/超时则基础版即
 *    最终版 — 生成临界路径从「分钟级 LLM + 全量落盘」缩短为确定性阶段；
 *  - 原子写入：tmp + rename — 任意时刻磁盘上的 report.html 必为完整文件；
 *  - 僵死检测改「恢复优先」：running 停滞 >90s 时先查磁盘 — 基础版在 → 直接
 *    标记 done 交付（附降级提示），而非报错重试；只有死于早期阶段（无文件）
 *    才走「生成中断 + 自动重试」；
 *  - zip 批量下载：entries 改 POST JSON body（解除 URL 长度限制）+ 前端 300s
 *    超时 + 瞬态重试 3×5s（旧版无超时无重试，服务重启时永远转圈）。
 *
 * v2.81：汇总报告两大内容缺口（用户实测 117 靶点汇总：①「117 个的原文未能
 *  内嵌弹出页（超出体积预算或留存失败）」；②28 个序列靶点没有回填出 UniProt ID）：
 *  - 导入报告原文内嵌自愈：源文件 HTML 导入时同时落浏览器本地留存
 *    （ht-import-cache — 内容哈希键，内存 + IndexedDB 跨会话）；汇总生成前
 *    GET 批量校验服务端留存（记录在/归属匹配/文件在），缺失或丢失（导入时
 *    上传失败 / DB 重置 / 实例回收）→ 从本地留存取回重新上传自愈，reportId
 *    回写运行记录 — 弹出页原文内嵌不再取决于导入那一瞬间的上传成败；
 *  - 导入靶点 UniProt 序列识别回填：载入且无 UniProt 且带提交序列（≥30 aa）
 *    的行（原运行为旧版本/当时检索患病 → 快照里没有 uniprotId），在基础版
 *    落盘后、AI 增强前经 EBI BLAST 直查 UniProtKB 补做身份识别（与管线 v2.44
 *    通道同一服务，覆盖度加权最佳 + 85%/40% 阈值同口径），回填 ID + 蛋白名/
 *    种属，行内徽标标注「UniProt 序列匹配 N%」；有界（6 分钟总预算 / 单靶点
 *    150s / 并发 4，识别结论进程内缓存 — 重生成秒回填），EBI 不可达时静默
 *    跳过不阻塞生成；
 *  - 服务端留存规划诊断日志（缺在哪一环：无记录/归属不匹配/文件丢失/超预算
 *    — dev 控制台一眼定位）。
 *
 * v2.82：用户实测四大反馈（①「查看完整报告还是不是重新上传的完整报告 —
 *  需要把上传的报告原封不动嵌入」；②「LLM 部分好像也没有生成」；③「增加一
 *  个规则：上传的报告没有回填出 UniProt ID 时，可以多一个选项不选中这些报告、
 *  重新运行这些评估」；④「搜索了 nr 库的话报告中还是看不到 BLAST 搜 nr 库的
 *  结果」）：
 *  - ① 导入报告原文原封不动嵌入：原作业仍在服务器的载入行（importedJobId 命中
 *    DB）弹出页此前内嵌的是**服务器旧作业的报告文件**（或其回收后的重建页），
 *    用户重新上传的报告被静默忽略 — 现上传留存为全部载入靶点先行规划（预算
 *    优先），DB 恢复行弹出页改挂上传件（原作业自身报告文件不再规划，同靶点
 *    不双份占 192MB 预算）；「载入」说明横幅如实标注内嵌来源；
 *  - ② AI 增强与 UniProt 识别回填**并发**（v2.81 串行 = 回填 6 分钟 + AI 数
 *    分钟，进程不稳环境 AI 永远等不到执行窗口）：总时长从相加缩短为取大；AI
 *    先完成即立即原子写增强版（此后进程死亡磁盘上已是含 AI 报告的版本）；
 *    回填有产出而 AI 失败时也写终版（基础版 + 回填 UniProt 列 — 补上 v2.81
 *    承认的缺口）；AI 行摘要附 UniProt ID（回填结论进 AI 上下文）；
 *  - ③ 未回填 UniProt 的载入靶点可一键不载入、重新评估：启动面板导入后琥珀
 *    提示（N 份匹配的报告未回填 UniProt ID）+「不载入这些报告 · 改为重新
 *    评估」按钮（恢复勾选）；运行视图（暂停/停止/完成态）批量按钮「不载入
 *    未回填 UniProt 的报告 · 重新评估（N）」（批量脱离载入 → 自动继续运行，
 *    当前身份级联重识别）；
 *  - ④ EBI UniProt 库序列匹配命中展示（身份级联 v2.44 通道 — NCBI 患病时
 *    的主力识别路径，此前命中只用于身份处理从不展示）：存档 summary
 *    .uniprotBlastHits（≤20 条），报告 BLAST 章节独立面板「UniProt 库序列
 *    匹配」（与 nr 面板同款表格 — Identity/E-value/覆盖范围/库 chips，排序
 *    + CSV 导出，始终可见不参与 PDB/nr 切换），章节头计数与结果页/合并报告
 *    视图同步展示 — 检索过就可见，身份回填证据链完整。
 *
 * v2.83：用户实测「上传的报告还是没有原封嵌入汇总报告」（117 份导入 → 汇总
 *  弹出页全部降级 — 两份不同时间生成的汇总均为 117/117 未内嵌）。本环境全链
 *  复现定位到双重根因，均已根治：
 *  - 根因A（浏览器 OOM — 进程级死亡）：导入 enrich 旧版把全部源文件文本永久
 *    缓存（readSource 无界 src.cache + ht-import-cache 无界 memCache），叠加
 *    IndexedDB 淘汰检查每写一份就 getAll 整读全库（117×1.1MB 的留存 = 每次扫
 *    128MB、共扫 117 次）— 渲染进程 JS 堆 678MB / 总 RSS 2.4GB，被内核 OOM
 *    杀死（dmesg 实证 chrome anon-rss 2.1-2.4GB，两次复现）；页面崩溃自动
 *    重载 = 全部 React 状态清零（勾选/导入条目/输入清单），上传循环死在中途
 *    → 汇总弹出页全降级。修复：enrich 三阶段重构（逐源读→解析→留存→立即
 *    释放，峰值内存 = 单份）；src.cache/memCache 有界 LRU（2/8 条）；IDB 淘
 *    汰改游标流式扫描 + 内存计数器（未超 150MB 阈值零扫描）— 实测同规模导入
 *    JS 堰 678→154MB、RSS 2.4GB→995MB，全程零崩溃；
 *  - 根因B（留存链接脆断）：弹出页原文此前只认「导入那一瞬间拿到的 reportId
 *    单链接」— 上传失败/DB 重置/记录回收/状态丢失任一环节断链即全降级。修复
 *    （内容寻址留存）：ImportedReport 新增 contentSha 列（sha256 前 32 hex，
 *    与前端 ht-import-cache sourceSha 同口径）— ① POST 同内容去重回既有 id
 *    （重新导入零重传）；② GET ?shas= 批量校验返回 sha→存活 id 映射；③ 汇总
 *    生成侧 loadImportedReportHtml 按 reportId 直查 → 内容哈希兜底（同内容任
 *    何存活留存即内嵌，重新导入/历史批次同样命中 — 多键映射 sha:{sourceSha}；
 *    预算按磁盘路径去重，重复记录不重复占 192MB）；④ 生成前自愈改「sha 采纳
 *    优先」（服务端有同内容 → 零重传秒愈；确实缺失才从 IDB 重传）；
 *  - E2E 实测（117 份 × 1.1MB 真实规模）：导入全程零崩溃、页面状态零丢失、
 *    117/117 勾选载入、重新导入零重传、汇总报告 137MB 单文件 — 117/117 原文
 *    原封内嵌（SYNTHETIC-ORIG 标记逐份校验）+ AI 整体可行性报告完整 + 「载入
 *    说明」如实标注内嵌来源，零「原文未能内嵌」降级。
 *
 * v2.84：用户实测「重新上传的报告还是没有完整嵌入，并且和之前相比多了很多
 *  UniProt ID 和评分也没有识别出来的条目（上传的报告都是一样的）」— 对同一
 *  批 83 份报告两代汇总报告逐行 diff 定位到 v2.83 引入的两处根因（11-24 报告
 *  114 有评分/3 降级/28 缺 UniProt → 11-25 报告 90/27/52，新增 24 个降级行
 *  全部是合并报告的次链 ·链2/链3/链4）：
 *  - 根因A（enrich 组装 rep 引用回归 — 24 靶点丢 stats/UniProt/sourceSha）：
 *    v2.83 三阶段重构把「逐项组装」从按 sourceKey 查源条目改成按 rep 对象引用
 *    查 Map — 同一合并报告文件的多靶点各自匹配到**不同的**报告条目对象（链1
 *    走 h1 条目、链2 走 meta 条目/组号条目），只有首个靶点的 rep 恰好是分组时
 *    记录的 entry.rep，其余靶点 lookup 全部落空 → 静默丢失统计快照（评分列
 *    「—」、UniProt 空）+ 本地留存键 sourceSha + 服务端 reportId（自愈死链）。
 *    修复：组装改回按 sourceKey 查找（v2.82 语义 — 任何同源条目都取到已解析
 *    的 sections）；
 *  - 根因B（留存校验把「零留存」误判「端点不可达」— 117/117 原文未内嵌）：
 *    ensureImportedRetention 收到 GET ?shas= 的 {retained:{}, missing:全量}
 *    （实例回收/DB 重置后服务端的**正常应答**）时，liveSha 为空被当成「端点
 *    不可达」→ 提前返回跳过自愈重传 + 横幅误报「沿用既有服务端留存」→ 弹出
 *    页全降级。且真不可达时「视同全部存活」同样脆弱（GET 失败但 POST 可用的
 *    网关场景）。修复：① verifyReached 显式区分应答成功与不可达；② 应答成功
 *    但无留存 → 走重传路径（不再短路）；③ 端点不可达 → 也尽力重传（POST 幂等
 *    — 服务端内容寻址去重，同内容已有留存直接回既有 id 不重复落盘；服务端真
 *    不可用时逐份快速失败不阻塞）；
 *  - healRefs 组内标签优先匹配（旧版仅按 label 全局 find — 跨组同名标签（如
 *    两组各有一条「model·链1」）会错配到别组的 bare 载荷条目）。
 *  - 验证：合成双链合并报告（链1 走 h1 条目/链2 走 meta 条目 — 精确复现根因A
 *    场景）双靶点全部拿到 stats+sourceSha；真实 G02 报告（用户 24 个回归靶点
 *    之一）全链路 E2E — 解析 overall=8/Q8I246 → 上传留存（幂等去重同 id）→
 *    看板生成 → 主表完整统计行（非 bare）+ 原文原封内嵌（1182KB 看板含真实
 *    h1）+ 零「未能内嵌」降级；零留存场景 ensureImportedRetention 重传自愈 +
 *    二次生成零重传采纳（11+12 断言全过）。
 *
 * v2.85：用户实测「显示了原报告的上传进度，但最终合成汇总报告时原报告还是
 *  没有嵌入进去」— 四轮全链路复现（API 单源/多源 + 真实 UI 全流程 + DB 清空
 *  自愈重传）证明 v2.84 代码本身嵌入链路全部正常（24/24 原文内嵌），用户看到
 *  的失败产物是 v2.83 前端 enrich 回归期生成的历史看板 / 旧版浏览器 JS 会话
 *  （dev 热更新后浏览器未刷新，仍在跑 v2.83 组装代码 — 载荷缺 sourceSha 时
 *  服务端 loadImportedReportHtml 静默返回空 Map，114 行齐降级且无任何信号）。
 *  本版把「嵌入成败」从黑盒变成三处可见 + 一处防御：
 *  - ① 服务端完成日志带真实嵌入计数（writeHtDashboardHtmlFile 新增 onEmbedded
 *    回调 — 写盘时逐行读盘的真实成功数，完成日志「弹出页原文内嵌 N/M 份」）；
 *  - ② 生成完成 toast 明示嵌入状态（有留存键 N/M + 无键靶点数 + 自愈不可达
 *    源文件数 + 恢复指引「重新导入报告文件并重新生成可恢复原文」）；
 *  - ③ 看板头部新增「报告原文内嵌 N/M」徽标（前端读真实载荷行数动态填充 —
 *    打开看板一眼确认，不依赖任何生成端提示）；
 *  - ④ finalizeHtDashboard 统计无留存键靶点（v2.83 回归期旧运行记录的次链
 *    靶点）— 这些靶点弹出页必降级且无法自动自愈（浏览器本地也凭 sha 才能
 *    取回），完成 toast 明示数量与恢复方式，不再静默。
 *
 * v2.86：UI 全面升级（用户指令：参考 pdb-tracker-web-v5 的设计语言升级，
 *  色调维持品牌薰衣草紫）— 在 v2.85 的「Refined Studio」分层阴影/微交互基
 *  础上，整体迁移到参考项目的 Claude 式设计语言（紫调版）：
 *  - 设计令牌：画布从纯白改紫调暖白 #faf9fc（暗色从近纯黑改紫调暖黑
 *    #17171e/#1e1e28 — 有色温的深浅底更柔和）；圆角 8→10px（0.625rem）；
 *    新增语义色 fg/bg 配对令牌 --xray/--xray-bg、--cryoem/--cryoem-bg、
 *    --nmr/--nmr-bg（与参考项目 claude-* 色系同源：紫/青/琥珀）；微字号
 *    体系 text-2xs/3xs/4xs（11/10/9px）；阴影改大半径低透明度柔光分层；
 *  - 头部（app-shell）：Claude 三件套 — header-gradient-border 底边主色渐
 *    变描边 + header-enhanced-bg 对角微染背景 + header-text-gradient 渐变
 *    字标 + header-icon-wrap 渐变品牌图标（20s 缓慢旋转 / hover 光晕缩放）；
 *    页脚同款渐变描边呼应；
 *  - 滑动胶囊分段控件（segmented-tabs.tsx 新组件，参考项目标志性交互）：
 *    输入方式切换（UniProt/序列/评估表/高通量）改 rounded-full 胶囊容器 +
 *    白色指示 pill 随选中项滑动（DOM 测量 offsetLeft/Width + ResizeObserver，
 *    纯展示组件不介入业务状态）；
 *  - 评估管线导引：四步骤改参考项目 welcome-stat-badge 模式（语义色图标
 *    色块 + hover 110% 缩放）；MethodBadge 改语义色配对令牌（X-ray 紫/
 *    Cryo-EM 青/NMR 琥珀，明暗主题同源令牌自动切换）；
 *  - 移植参考项目动效体系：stat-card-hover 弹性抬升、number-pulse-glow
 *    关键数字呼吸光晕、tab-underline-hover 下划线滑入、skeleton-row-
 *    staggered 骨架屏错峰入场、prefers-reduced-motion 全量关闭装饰动画；
 *  - Hero 首屏：渐变强调字 + 能力 chips + 环境光晕/点阵网格保留（紫调重
 *    染）；CTA 渐变按钮/卡片分层阴影等 v2.85 升级全部经令牌层自动继承新
 *    色调（studio-card/btn-brand 等工具类挂接语义变量 — 一处改令牌全站生效）。
 *  E2E 验证：明/暗双主题 + 桌面/移动双断点 + 滑动胶囊切换 + 对话框开合
 *  零报错；VLM 视觉评审 8/10（渐变字标/胶囊控件/紫调画布三要素确认）。
 *
 * v2.87：结果导出 PDF + 主页排版修复（用户指令：「结果除了 html 外，增加导出
 *  pdf 的选项，（主页）分页不要扰乱排版」）：
 *  - ① PDF 导出（服务端 Chromium print-to-PDF）：新增 report-pdf.ts（Playwright
 *    chromium 单例 + 毒丸清理 + 串行队列把内存峰值封在单份 + 160MB 体积护栏
 *    超限给出浏览器打印指引）；与 HTML 下载同一份文件、同一套 @media print
 *    A4 分页规则 — 所见即所得；页脚居中「N / M」页码（Noto Sans SC 回退）；
 *    等待策略 load → 全图片解码（data URI 为主 best-effort）→ fonts.ready →
 *    300ms 落定；实测 1.5MB 报告 2.1s / 12MB 看板 3.1s 出稿；
 *  - ② 三路由接入 ?format=pdf：单靶点 /api/jobs/{id}/report、合并报告
 *    /api/evaluate/batch-report、统计看板 /api/evaluate/ht-dashboard（看板
 *    先注入专用打印分页 CSS — 看板模板原生无 @page 规则；弹出页载荷为
 *    script 数据不参与打印，PDF 即统计+总表+AI 分析紧凑版）；
 *  - ③ 前端「下载报告 ▾」下拉（新组件 report-download-menu）：HTML（即时
 *    下载）/ PDF（fetch blob 另存 + 全程反馈：生成中 toast → 完成含保存位置
 *    → 失败给出浏览器打印降级指引）双选项；本地缓存副本/无状态内联报告无
 *    服务端文件时自动退化为单按钮（不出现死选项）；单靶点结果页工具条 +
 *    报告卡、合并报告工具条 + 预览降级路径、高通量看板横幅五处统一接入；
 *    RFC 5987 filename* 解析 — 中文报告题目完整保留为 PDF 文件名；
 *  - ④ 分页避让强化（打印标记 rpt-pr-v1 → v2，历史报告经 applyUxUpgrade
 *    幂等补增量块）：表格行不腰斩（tr avoid）、图片不跨页、一切标题不孤行
 *    尾（h1-h5 break-after avoid）、网格卡片整卡避让（glance/fig/lig/meta
 *    网格 + tgt-card/rel-box/qa-ans/note）— VLM 逐页核验 24 靶点看板 PDF
 *    六页零切断零溢出；合并报告视图全展开 + 每靶点新起一页（既有力为 print
 *    CSS，Chromium print-to-PDF 原生应用）；
 *  - ⑤ 主页排版修复：lg 档（1024-1280px）「最近评估」卡 max-h-400 与左栏
 *    拉伸高度不匹配 → 卡底到栏底 ~100px 空洞（xl 才放开）；高度上限放开从
 *    xl 提前到 lg（lg:max-h-none lg:flex-1）— 实测卡底与左栏底部像素级齐平；
 *  - ⑥ 两处 v2.86 回归修复（均为主页排版扰乱）：a) 顶栏吸顶失效 —
 *    .header-gradient-border 的 position:relative（无层自定义样式）在级联中
 *    压过 Tailwind @layer utilities 的 .sticky → 滚页后头部跟内容一起滚走；
 *    删除该行（sticky 本身即定位值，::after 描边锚定不变），页脚描边锚定
 *    改由元素 relative 类承担 + 描边落位顶边（v2.86 设计意图，此前 bottom:0
 *    游离在页底）；b) 移动端横向溢出 — Hero 环境层 studio-grid/ambient 的
 *    -inset-x-8 出血把 390px 视口文档撑到 406px；根容器加 overflow-x-clip
 *    （clip 不创建滚动容器，不影响 sticky）。
 *
 * v2.88：汇总报告导入原文嵌入根治层 — **生成时原文直传**（用户实测「上传的
 *  报告还是没有嵌入到汇总报告中」跨 v2.69–v2.86 多版复现，沙盒全链路复现
 *  正常 → 判定为用户环境在「导入时上传/留存」环节持续失败且无感知）：
 *  - 客户端：enrich 解析源文件时顺手登记**会话源注册表**（内存 Map，96MB 上
 *    限 — IndexedDB 不可用（隐私模式）时仍可用）；汇总生成（finalizeHtDashboard）
 *    把「留存未确认可用」的源文件（heal 未采纳/未重传成功的 + 无键条目按
 *    fileName 反查的）从会话源/IndexedDB 取出，**随生成请求直接携带**
 *    （importedSources：≤128 份 · 单份 ≤8M · 总量 ≤32M 字符 — 与服务端同口径）；
 *  - 服务端（ht-dashboard POST）：直传原文在**同一请求上下文**内落库（内容
 *    寻址去重 — 新建共享模块 imported-report-store，上传路由同步复用），生成器
 *    随后的 loadImportedReportHtml 即读到 → 弹出页内嵌。写入与读取**同端点、
 *    同 owner、同时刻** — 导入时上传失败 / 留存丢失 / 归属键漂移 / 自愈重传
 *    失败等全部历史故障环节被结构性收敛掉；
 *  - sha 口径校正：http 环境浏览器 crypto.subtle 不可用时前端 FNV 兜底哈希与
 *    服务端 sha256 不一致 — 服务端以重算值回写载荷条目 sourceSha（直传落库
 *    后必有原文可比对），sha 键兜底通道在该环境同样可用；
 *  - 无键条目（v2.83 回归期旧运行记录）按 fileName 反查会话源补回 sha 键并
 *    回写运行记录 — 重新生成走标准键通道；
 *  - 完成 toast 并入直传统计（ptStored 服务端实测 + ptError 首个失败原因 —
 *    环境问题如实呈现定位）；上传路由瞬态重试一次（3s — 服务重启窗口）；
 *  - E2E：v2.86 汇总件导入 15/15 回归 + 浏览器 UI 全链路（多文件导入 → 运行
 *    → 汇总）sk 池字节级内嵌确认 + 直传链路专项验证（屏蔽上传端点模拟用户
 *    故障 — 直传同请求落库内嵌如常）。
 *
 * v2.89：PDF 导出改连续长页（用户指令：「pdf 能完全不分页吗？格式尽量和 html
 *  保持一致」— v2.87 的 A4 分页版实测反馈）：
 *  - 单页连续：renderReportPdf 纸张尺寸 = 内容实测尺寸（宽 = .page 版心 1224px
 *    桌面基准、高 = 全文高度 + 8px 裕量），pageRanges '1' 兜底 — 整份报告一页
 *    装下，零页断点、零页码；版式=网页版（page.emulateMedia('screen') 按
 *    **屏幕媒体**渲染 — @media print 的 A4 压缩规则 12px 正文/9.5px 表格全部
 *    不参与，与浏览器打开 HTML 的观感一致）；
 *  - 版心冻结：.page 宽度/四向内边距 + body 字号在页内 getComputedStyle 实测后
 *    以 !important 钉死 — 印刷重排宽度（=纸张宽 1224）与测量视口（1440）命中
 *    的媒体查询档位不同（920 版心会落入 max-width:1024 档收紧 padding），钉死
 *    后版式不漂移；
 *  - 静态化注入（与打印口径同源）：合并报告 .rpt-view 视图全展开（首页 + 各
 *    靶点报告页连续呈现）；BLAST PDB/nr 两库面板全展开（CDP print 不派发
 *    beforeprint — 页内等价移除 [data-libpanel] 的 hidden）；表格 3 行截断
 *    （.t-clamp）恢复全文；交互控件（复制/放大/回顶/工具条/库切换钮）隐藏；
 *    AF 交互 3D 回退静态 poster；懒加载图转立即加载（打印管线强制加载全部图，
 *    屏幕媒体不会 — 折叠视口外的 loading=lazy 图必须显式取数否则长页下方图片
 *    缺失）；数据表防截断（横滚容器溢出改可见 + 看板宽表自动布局换行）；
 *  - 物理极限兜底：Chromium/PDF 单页 ≤ ~200in（96dpi ≈ 19200px）— 内容更高
 *    时退化为「最少分页」：页高 19008px 连续长条（24 靶点看板 ~5 万 px → 3
 *    条长页而非 24+ 页 A4），断点注入避让（行/图不腰斩、标题不孤行尾）；
 *  - 前端文案同步：下载菜单 PDF 项「连续长页 · 不分页 · 版式同网页版」、
 *    生成中/完成 toast、合并报告 pdfNote「全部靶点视图展开」；HTML 下载后的
 *    浏览器 Ctrl/Cmd+P 仍为 A4 分页版（打印归档场景由它承担）。
 * v2.90：PDF 导出可靠性加固（v2.89 连续长页版实测：统计看板 PDF 偶发一次失败后，
 *  **所有**导出永久 187ms 秒败「browser has been closed」直到重启服务）：
 *  - 浏览器单例自愈：Chromium 进程死亡（沙箱 3.9GB 内存 OOM 击杀/崩溃）后，旧
 *    单例把指向死浏览器的 promise 永久缓存 — 现监听 disconnected 事件清空单例，
 *    下次调用自动重拉新浏览器（与「服务进程反复死亡」同类根源的根治）；
 *  - 透明重试：渲染中浏览器死亡的错误形态统一识别 → 清死单例 → 新浏览器重试
 *    一次（用户无感）；两次都死才报错，报错前再清一次保证服务后续可用；
 *  - load 事件 best-effort：Google Fonts 等外部子资源偶发悬挂时 load 不触发，
 *    旧版 setContent 90s 硬失败 — 现 best-effort 继续（readyState 10s 显式确认
 *    解析完成度）；字体就绪改 15s 竞速（网络悬挂时 fonts.ready 永不 resolve，
 *    旧版 evaluate 无超时会永久卡死串行队列 — 超时回退系统 CJK 字体出稿）；
 *  - 内存预检：大 HTML（≥4MB，实测 10MB 看板 Chromium 峰值 2.4GB RSS）渲染前
 *    检查系统余量，<1.2GB 快速失败并给出「稍后重试 / 下载 HTML 浏览器打印」
 *    指引，不让渲染跑 90s 后被 OOM 击杀连带浏览器死亡。
 *
 * v2.91：汇总报告生成「请求体不是合法 JSON」根治 + 输入方式切换 pill 修复：
 *  - ① 根因（框架层请求体上限截断）：v2.88 导入原文直传把源文件 HTML 随汇总
 *    报告生成请求携带，多份报告合计 >10MiB 时 — Next 16 dev 代理默认
 *    proxyClientMaxBodySize = 10,485,760 字节，超限的请求体被框架层**静默截断**
 *    → route 内 req.json() 必抛 → 400「请求体不是合法 JSON」→ 看板整单失败
 *    （用户实测：汇总报告生成失败，且与「导入报告未嵌入」同根 — 生成请求
 *    本身就没送达）。沙盒实测二分定位：10.4MB 正常 / 10.5MB+ 必现；修复：
 *    next.config.ts experimental.proxyClientMaxBodySize 提至 200MiB（覆盖直传
 *    最坏口径 + 归档快照 + 余量）；
 *  - ② 预算口径统一改字节（客户端 TextEncoder / 服务端 Buffer.byteLength）：
 *    旧字符口径（32M 字符）在 CJK 报告下 UTF-8 体积可达 3 倍（96MB）— 与传输
 *    层字节约束错位是本次事故的放大器；现两端同口径 ≤128 份 · 单份 ≤16MB
 *    字节 · 总量 ≤64MB 字节，与请求体上限严格对齐；
 *  - ③ 服务端 req.json() 失败精确归因：Content-Length >16MB 且解析失败 ≈ 框架
 *    截断（报错附载荷体积与调参指引）；否则附解析异常原文 — 不再让「请求体
 *    不是合法 JSON」黑盒；
 *  - ④ 输入方式滑动胶囊 pill 不随切换移动（用户实测 UI 问题）：Radix 切换只
 *    改 trigger 的 data-state 属性，segmented-tabs 组件不消费 Tabs 上下文不
 *    re-render、容器尺寸不变 → measure 无触发时机，pill 停在初始位置。修复：
 *    MutationObserver 监听 data-state 变化重测（attributeFilter 限定，微任务
 *    先于绘制 — 无闪烁）；
 *  - 回归：scripts/test-v291-large-passthrough.ts（12MiB 直传全链路 6/6 —
 *    POST 落库 ptStored=1 → 生成 done → 字节级内嵌）+ v2.86 汇总件导入 15/15。
 *
 * v2.92：汇总报告导入原文内嵌 — 真实根因修复（用户实测「v2.91 已拉取、UI 显示
 *  2.91、重新生成的汇总报告依然 117 靶点零内嵌」— 排查发现历版「沙盒全链路
 *  验证通过」与用户环境失败的分叉点从未被覆盖）：
 *  - 根因定位（三层叠加，任何一层单测都「绿」、叠加才复现用户形态）：
 *    ① 产物时间口径：看板 g 字段为 UTC（toISOString），用户按本地时间读
 *    「07:30」误判产物新旧 — 本轮曾据此误判「旧文件」，用户指正后修正；
 *    ② http 非安全上下文（IP/域名直访，非 localhost）浏览器 crypto.subtle
 *    不可用 → 前端 sourceSha 走 FNV 兜底（x 前缀），服务端留存按 sha256
 *    内容寻址 — **两口径永远对不上**，sha 兜底通道在该环境形同虚设；
 *    ③ IndexedDB 本地留存 150MB 上限：百份级批次（117 份 × ~1.1MB ≈ 128MB）
 *    多轮导入累计超限 → 按写入时间淘汰最旧 → 上一轮运行的源被清光 →
 *    生成前 heal（无源可重传）与 v2.88 直传（无源可取）双双落空；
 *    ②+③ 叠加 = reportId 无（heal 失败未回填）+ sha 查库 miss（口径错位）
 *    → loadImportedReportHtml 空 Map → 117 行全部降级 — 与用户产物完全同构
 *    （沙盒实测：crypto.subtle 罩蔽模拟 ② 单独不复现 — heal 重传通道把它
 *    吸收；②+③ 叠加的 fileName 兜底回归见 scripts/test-v292-filename-
 *    fallback.ts）。
 *  - 修复三件套：
 *    ① 服务端 fileName 兜底通道（根治层）：loadImportedReportHtml 与
 *      resolveImportedReportPath 新增第三键 `fn:{fileName}` — reportId 与 sha
 *      双 miss 时按（归属匹配的）导入文件名反查本人留存（服务端留存在 —
 *      导入/重传落过库，只是键口径对不上找不到）；fileName 是人读口径，
 *      稳定不变，不受浏览器安全上下文影响；命中后同步回登记 reportId/
 *      sha 键（下次直查）；诊断日志加 fileName 兜底找回计数；
 *    ② IndexedDB 上限 150MB → 600MB：多轮百份级批次不再淘汰旧运行源；
 *    ③ 看板产物版本自标注：HTML meta targeteval:version + 头部「报告版本」
 *      徽标 + ht-rpt-data 载荷 v 字段 + 弹出重建页徽标 + 完成 toast 尾注
 *      「本报告由 vX 生成」— 产物自带版本，回报排查不再依赖口头描述
 *      （本轮「07:30 旧文件」误判的痛点根治）。
 *  - 用户恢复指引（存量受损运行）：打开历史运行 → 重新导入 117 份报告文件
 *    （刷新浏览器本地留存 + 服务端留存）→ 重新生成汇总报告 → 原文内嵌恢复。
 *
 * v2.93：PDF 导出「格式不对」根治 — 内容压缩成大页正中的一条 A4 窄条（用户
 *  实测 TargetEval_P00533_2026-11-25.pdf：单页 918×9042pt，全部内容挤在中段
 *  954px 窄条、前后大片空白、底部硬截断）：
 *  - 根因（逐点实证定位）：报告模板内嵌 @page{size:A4;margin:12mm 10mm 14mm}
 *    （单靶点 PRINT_PAGE_CSS / 看板 DASHBOARD_PRINT_CSS — 浏览器 Ctrl+P 归档
 *    场景）。Chromium m143（Playwright 1.57）起 printToPDF 的**版面几何**改由
 *    文档 @page 主导：page.pdf() API 传的 width/height 只决定输出纸面，排版
 *    页框仍取 @page 尺寸并**居中放置**在纸面上 — 1224×12056px 大纸上出现一块
 *    居中的 A4 内容区，内容按 A4 高度分页 + pageRanges '1' 只留首页 → 整份
 *    报告被压成纸面正中的一条 A4 窄条。像素级复核：用户坏件墨迹范围
 *    x 189-727 / y 4163-4878pt 与「A4 页框居中 + @page 边距」预测（x 190-728 /
 *    y 4168-4217 内界）误差 ≤1pt。旧 Chromium preferCSSPageSize:false 令 API
 *    尺寸完全获胜，v2.90 实测曾通过；环境升级 Chromium 后行为变化、导出代码
 *    零改动 —「代码没变但坏了」的根源（教训：@page 与 printToPDF 参数的胜负
 *    规则跨版本不契约化，必须显式钉死）；
 *  - 修复（renderReportPdf 中央根治 — 单页/长条两路径同护，三条路由全收敛）：
 *    测得内容尺寸后注入同尺寸 @page{size:<w>px<h>px;margin:0}（级联后于模板
 *    规则取胜），版面几何与纸面严格一致；两值与 page.pdf 的 width/height 完全
 *    相同 — 旧版（API 获胜）/新版（@page 获胜）Chromium 结果一致，前向兼容；
 *  - 验证：媒体探针复现（PROBE-MEDIA-SCREEN/MQ-BASE/VH-900 三探针定位版面
 *    分歧）→ 生产函数复测（重建 EGFR 1224×10160px 报告 2.6s 出稿、内容铺满
 *    全页）→ 看板路径（applyDashboardPrintCss + @page A4 同命中，54KB 看板
 *    修复后内容 45-1663pt/1730pt 铺满）→ agent-browser 全链路 E2E（真实
 *    P00533 评估 66.6s → 结果页「下载报告 → PDF 报告」→ 4.6s 出稿 4.1MB，
 *    服务端日志 @page 钉死 1224×11036，PDF 1 页 918×8277pt、内容 45-8246pt
 *    铺满、执行摘要/PDB 清单/BLAST/关键文献全章节完整、VLM 视觉复核排版
 *    正常、0 控制台错误）；诊断脚本保留：scripts/repro-pdf-layout.ts（复现
 *    + 媒体探针）/ verify-pdf-v293.ts / verify-dash-v293.ts。
 * v2.94：BLAST nr 识别超时根治（用户实测序列靶点作业 cmwwwnzi6：NCBI 队列
 *  患病日 BLAST nr 识别两轮尝试共耗 2.3h 双双以「The operation was aborted
 *  due to timeout」失败，而同目的的 EBI UniProtKB 直查 12s 完成 — 总作业时长
 *  8302s 里 99% 耗在等 NCBI）：
 *  - 身份识别级联反转（pipeline.ts）：EBI UniProtKB（Swiss-Prot，秒级）从
 *    「nr 失败后的兜底」升为**先行快通道** — 已归属（≥85% 一致性 + 40% 覆盖）
 *    即跳过 NCBI nr 慢通道（常态省 1-10 分钟，拥堵日省 90s-2.3h）；EBI 未决
 *    （无命中/未达阈值/服务失败）时 nr 仍接着跑（TrEMBL 未审校条目近似命中是
 *    nr 的独有价值）。命名优先级不变（评估表 > nr ≈ UniProt 匹配 > PDB 同源）；
 *    检查点状态字段（nrBlast 系 / upBlast 系）独立自洽，跨版本续跑安全；
 *  - submitBlastPut 提交硬超时（blast.ts，pdbaa/nr 共用）：旧版 `signal ??
 *    timeout(30s)` 在异步作业路径（signal=作业信号无段截止）下**无任何请求级
 *    超时** — NCBI 接受连接不响应时提交 fetch 永久悬挂。现恒定 45s 硬超时经
 *    AbortSignal.any 与外部信号组合（取消/段截止仍即时报出）；外部中止一律
 *    原样上抛（旧版仅匹配 name==='AbortError'，段截止的 TimeoutError 形态被
 *    误入重试链后以空泛 'aborted' 逃逸，难定位）；
 *  - collectBlastNr 墙钟全路径约束（blast.ts）：墙钟检查移至循环顶 — 旧版仅
 *    在「HTTP 200 + 未出结果」路径检查，连续网络失败（30 次 fetch 超时 ≈ 18
 *    分钟 > 10 分钟墙钟）与非 200 响应（429/5xx）两条路径可无限越预算循环；
 *    轮询 fetch 组合外部信号（取消即时报出，不再等 30s 请求超时）。
 * v2.95：BLAST nr 拥堵日超时兜底（用户实测作业 cmwx4vqdg：NCBI 队列拥堵 pdbaa
 *  排队 242s 触发 RCSB 兜底 → nr 慢通道按「患病日」仅 90s 短预算必超时，「BLAST
 *  nr 已提交 2 分钟仍无结果（NCBI 队列异常）」后身份识别通道全失灵 — 而同时段
 *  EBI Swiss-Prot 直查秒级完成）：
 *  - EBI UniProtKB 全库兜底（pipeline.ts b2 块 + uniprot-blast.ts 参数化）：
 *    NCBI nr 失败（90s 短预算/10 分钟墙钟/FAILED/RID 过期/网络不可达）且无命中
 *    时，自动改经 EBI ncbiblast 检索 uniprotkb 全库（含 TrEMBL ~2.5 亿条 — nr
 *    的蛋白主体即 UniProtKB，身份识别等效且条目质量更高）；EBI 队列与 NCBI
 *    相互独立，患病日依然健康。全库常态 1-4 分钟（实测 265s/50 命中），6 分钟
 *    墙钟 + 段预算续跑承接；命中复用 BlastNrHit 形态喂入 nrHits — 下游身份处
 *    理（85%/40% 阈值回填 + 近似身份）与报告 BLAST 章节零改造；NCBI nr 成功
 *    （含 0 命中「确无同源」）时跳过 — nr ⊇ UniProtKB 无重复检索必要；
 *  - 通道如实标注（nrEbiSourced → blastNrProvider='ebi'）：报告 BLAST 面板
 *    标题/说明、库切换按钮、章节头计数、SOURCES 页脚、结果页/合并报告
 *    BlastNrTable 表头均标「EBI UniProtKB 全库（NCBI 拥堵日兜底）」，不再笼统
 *    误标 NCBI nr；身份处理日志/note 同步标注（source 仍 blast-nr 保持契约）；
 *    检查点新字段（nrEbiBlast/nrEbiDone/nrEbiSourced）消毒校验，跨版本续跑
 *    安全（旧检查点缺省 = 未执行兜底，语义正确）；
 *  - uniprot-blast.ts 参数化（database/alignments/maxWallMs/maxHits/label）：
 *    快通道（Swiss-Prot，秒级）默认行为不变；全库兜底 50 命中与 NCBI nr
 *    HITLIST 同口径。验证：scripts/test-ebi-nr-fallback.ts（全库实测 264.9s
 *    50 命中、TrEMBL 分类/一致性/覆盖全字段正常）+ test-ebi-provider-render.ts
 *    （报告标注 8 断言全过）。
 * v2.96：身份识别两条新规则（用户指令 2026-11-26：「不可回补的无论同源性多少，
 *  取一个最高的进行回填；非 100% 的话在报告中加一个序列比对的展示，悬停显示
 *  氨基酸号」— 永久并入管线，此后所有评估按新规则运行）：
 *  - 规则 A · 最高同源回填（pipeline.ts 级联末端 best-effort 步骤）：身份级联
 *    （评估表 → PDB 同源 → EBI Swiss-Prot → NCBI nr / EBI UniProtKB 全库 →
 *    Peptide Search）全部走完仍未归属时，不再留空 — 取覆盖度加权最佳命中
 *    （identity × 查询覆盖率，与各通道同口径）无条件回填 UniProt 元数据，
 *    targetIdentity.bestEffort 标记（报告题目「最高同源 N%」、刊头/比对面板/
 *    结果页/合并报告「远缘参考，需人工复核」琥珀标注）。候选池两级：池A =
 *    UniProt 通道命中（T2/T3 直接携带 accession）；池B = UniProt 通道全空
 *    （EBI/NCBI 双患病日 — T2 提交超时且 T3 全库超时，端到端实测场景）时以
 *    PDB 同源检索（RCSB 兜底/pdbaa）最佳命中经「PDB 实体→UniProt 映射 /
 *    pdbaa 描述 sp|ACC| 提取」定位 accession 回填（实测 RCSB 命中 9XQN 84.9%
 *    ×99.7% — 距阈值 0.1% 的证据不再丢失）。置于级联最末端，不抢占任何先行
 *    通道；刻意不重建结构数据/不设 blastRange（远缘条目结构是同源参考，结构
 *    证据保持同源检索诚实口径）；检查点新字段 beBackfillDone/idAlignment
 *    消毒校验，跨版本续跑安全；
 *  - 规则 B · 序列比对可视化（identity-align.ts + 报告「序列比对」面板）：非
 *    100% 一致性的归属（BLAST 归属 85-99.9% 与最高同源回填）展示「提交序列 ↔
 *    UniProt 条目」局部比对 — 新模块 identity-align.ts 本地 Smith-Waterman +
 *    Gotoh 仿射缺口（BLOSUM62，缺口 11+1 — 与 BLASTp 同参数；精确子串快路径
 *    零 DP 直铺；>6M 格的超大条目 8-mer 种子对角线投票裁窗比对，纯 CPU 无网调）。
 *    面板三行版式（提交序列/中线/条目）60 列分块、块首尾双侧残基号、逐残基悬停
 *    浮层显示「提交序列 第 N 位 · {acc} 第 M 位 · 残基（全同/正替代/错配/缺口）」
 *    + 同列三行联动高亮、顶部游程合并 SVG 一致性概览条（悬停显示区间）、统计
 *    chips（一致率/正替代/缺口/比对列数/双侧区间）、窄屏横滚 + 打印放开；
 *    ALIGN_TIP_JS 页级脚本随单靶点报告与合并报告注入；bestEffort 时附琥珀
 *    callout 说明回填口径。数据随 summary.identityAlignment 持久化（历史作业
 *    缺省 = 无面板），合并报告/单独评估页经 MergedTargetData 贯通同款渲染；
 *  - 附带修复：sanitizeCheckpoint targetIdentity.source 白名单漏 uniprot-blast/
 *    uniprot-exact（v2.44/v2.58 起新增来源 — 带该来源的检查点续跑时被误拒，
 *    作业被迫从头重跑）；JobSummary/前端 types 贯通 bestEffort/coverage/
 *    identityAlignment 字段。
 *  验证：①本地比对 vs EBI BLAST HSP 26 靶点全对（一致率/坐标/缺口逐一核对，
 *  0-15ms/靶点）+ 超大条目窗口裁剪/精确子串/无同源/未知残基/短序列边界用例；
 *  ②agent-browser + VLM 视觉评审两轮（7 → 9/10，零 P0：悬停浮层改屏幕底部
 *  状态条永不遮挡 + 替代对 Q→K + 对比度/要点化修正，逐列像素对齐程序核实）；
 *  ③真实评估端到端（imp-100 GPR75 突变序列，NCBI 拥堵日）：级联全走完后
 *  按最高同源回填 Q6X632（60.7% × 99.7%）+ 392 列比对面板落盘，报告题目/
 *  刊头/面板/悬停交互全链路核验，零控制台报错。
 * v2.97：比对面板块宽随页面自适应（用户反馈 2026-11-26：「序列比对的部分要充分
 *  利用页面宽度，不要空太多空间，并且也可以随页面宽度动态调整」— v2.96 固定
 *  60 列分块在宽屏（1360px 版心）仅占卡片 20-38% 宽，右侧大片空白）：
 *  - ALIGN_LAYOUT_JS 页级脚本（单靶点/合并报告外壳注入）：SSR 60 列块仅为无 JS
 *    兜底与打印基准，屏幕媒体下按 `.aln-scroll` 实测内宽 ÷ 等宽字符实测宽求
 *    满列数重排 — 每行残基数随页面宽度动态增减（宽屏满宽 ~88 列/行，窄屏自动
 *    降列免横滚，MIN_COLS=20 以下保滚动）；数据从 v2.96 固定的面板 DOM 直接
 *    采集（字符/状态类/data-qp/data-hp/行标签），新旧报告同一代码路径零迁移；
 *  - 触发面：ResizeObserver（视口缩放、合并报告视图切换、应用内 iframe 宽变）
 *    + window.resize 兜底 + document.fonts.ready（1ch 随字体加载校正）；floor +
 *    2px 安全边防「重排→滚动条→宽度收缩→再重排」反馈环；隐藏面板（clientWidth
 *    =0）跳过、可见时观察器自动补排；
 *  - 打印语义：beforeprint 且 matchMedia('print')（真打印）重排 60 列经典
 *    BLAST 版式（A4 稳定容纳），afterprint 还原屏幕满宽；PDF 导出走 screen
 *    媒体（report-pdf emulateMedia）不受打印分支影响，按 PDF 页宽满排；
 *  - applyAlignLayoutUpgrade 幂等升级（jobs/report、batch-report inline+下载、
 *    ht-archive 两类内嵌路径全接入）— v2.96 落盘的历史报告无需重跑即获得
 *    自适应块宽（含 GPR75 → Q6X632 392 列实盘面板）。
 * v2.98：比对一致率改非缺口列口径（用户规则 2026-11-26：「同源度低的问题是
 *  序列中存在很多 gap，gap 应该不降低同源度，应该用非 gap 区的对比来计算
 *  同源度」— 实测 GPR75 突变构建：82 缺口列把一致率从 76.5% 稀释到 60.5%）：
 *  - identity-align.ts：一致率/正替代率分母从「对齐列数（含缺口）」改为
 *    「非缺口对齐列 = 对齐列 - 缺口列」— 构建型序列删除环区/标签段产生的
 *    缺口列不再稀释一致率；缺口仍按 BLAST 同参数（存在 -11/延伸 -1）参与
 *    比对寻优，只改展示口径不改比对几何；全缺口防御性放弃面板；
 *  - 面板口径双轨标注（report-html.ts）：「一致率/正替代」chips 明示「非缺口」
 *    口径 + 分母公式 title；「缺口 N 列」「比对 N 列（非缺口 M）」chips 补齐
 *    计数；「命中一致性」chip 明示「BLAST 口径」（BLAST 以含缺口列的对齐长度
 *    为分母 — 外部证据保持原口径不改写）；说明段/最高同源回填 callout 同步
 *    标注两口径数值，题图「最高同源 N%」仍为 BLAST 归属口径；
 *  - 旧报告零重跑升级（ALIGN_LAYOUT_JS v1→v2，applyAlignLayoutUpgrade 摘
 *    aln-fit-v1 旧脚本注入 v2）：逐列数据从 v2.96 固定的面板 DOM 采集重算，
 *    chips/说明段直接改写为非缺口口径 — v2.96 落盘历史报告（含 GPR75 →
 *    Q6X632 392 列实盘：60.5% → 76.5%）无需重新评估即显示新口径；新报告
 *    服务端已按新口径渲染，重算幂等无变化；
 *  - pipeline 日志/types 注释同步（identity/positives 语义 = 非缺口列口径）。
 * v2.99：上传报告自动升级（用户规则：上传报告后，旧版生成的报告更新成最新版，
 *  补全后续版本加入的内容 — 新建 report-upgrade.ts 统一升级管线）：
 *  - 展示层补丁链 applyReportPatchChain：响应式版心/灯箱/打印 UX/表格筛选/
 *    比对面板自适应五函数与报告服务路由同序串接（幂等 — 新版报告零改动）；
 *  - 比对面板内容回填 backfillAlignmentPanel：v2.96 前生成的报告无「序列比对」
 *    面板，比对双序列不在报告 HTML 里 — 从作业 llm-ctx.json 快照（v2.51+ 落盘）
 *    按管线 v2.96 收尾同口径（已归属 + 非 100% 一致性）现算 Smith-Waterman
 *    （纯 CPU 无网络），注入面板 HTML + ALIGN_PANEL_CSS（自 SINGLE_REPORT_CSS
 *    抽出同源）+ 悬停脚本（aln-tip-v1 标记幂等）+ 块宽自适应脚本；快照缺失/
 *    规则不满足/截断文档（ht-archive 2MB 前缀件）→ 静默跳过零回归；
 *  - 接入面：storeImportedReportHtml（上传留存 — 新写入全量升级 + 去重命中
 *    旧记录就地治愈 tmp+rename 原子重写；contentSha 锚定原文口径 — 客户端
 *    sourceSha/sha 自愈通道零感知）、ht-dashboard 载荷内嵌逐份升级（覆盖本版
 *    前已落盘的旧留存）、jobs/[id]/report（在线查看/下载/PDF）、ht-archive
 *    （zip 内作业报告）、loadMergedTargets（旧合并报告重渲染的单独评估页经
 *    alignmentForLegacyJob 回填 identityAlignment）；
 *  - 报告 head 新增 targeteval:version meta（生成器版本自标识 — 诊断与后续
 *    版本门控用）；上传响应/留存日志附 upgraded 标记（诊断字段）。
 * v2.100：汇总报告表格四项优化（用户反馈 2026-11-26：「如果是 GPCR 类项目，
 *  可能是存在受体和 G 蛋白复合物的情况，G 蛋白的结构数不应该统计在表格中，
 *  复制序列单独放一列，最后一列查看报告和下载按钮样式做成一样用不同颜色
 *  并排放，要节省空间不要留太多空白」）：
 *  - G 蛋白（受体复合物组分）行不计入统计（ht-dashboard.ts isGProteinRow）：
 *    三重识别（UniProt 标准名「Guanine nucleotide-binding protein」（排除
 *    nucleolar/-like 的 GNL 家族）/ G蛋白·G·蛋白·Gα·Gβ·Gγ 命名（排除
 *    「G protein-coupled receptor」）/ GN 前缀亚基基因符号 GNAS·GNAI1·
 *    GNAQ·GNB1·GNG2 等）— 识别到的行主表呈现（评分/报告完整保留 +
 *    「G蛋白」徽标）但结构列显示「—」且不计入批次统计（分布/均分/结构/
 *    结论全口径，HtDashboardStats 新增 gProteinCount/statTargets 分母），
 *    筛选器新增「G蛋白（复合组分）」选项 + 头部说明横幅；
 *  - 序列列独立：复制序列按钮从原表文本内嵌标记（v2.68 ⧉ 行内按钮）移至
 *    独立「序列」列（excelSeqs 多条全列；无 seqs 回退提交序列；旧快照
 *    保留纯文本标记），原表行文本序列标记移除省空间；
 *  - 报告列「查看报告」（青绿 #0f766e）/「下载」（琥珀 #b45309）同尺寸
 *    同字重不同色横向单行并排（原纵向两行），离线/在线链接内联随行；
 *  - 紧凑化：th/td 纵向 padding 8px→6/5px、原表内容块/结论行收紧、
 *    表下长注解精简。
 * v2.101：汇总表两处精简（用户反馈 2026-11-26 截图标注「红框部分移除；
 *  蓝框徽章后不留空白直接从同一行开始显示建议内容」）：
 *  - 靶点列移除「原表行快照」展示行（tg-excel）— 序列列独立（v2.100）后
 *    剩余内容多为本地文件路径，无评估参考价值且占行高；原表行文本仍入
 *    搜索索引（data-search），按原表内容筛选仍可命中；renderExcelCell
 *    一并移除（唯一调用点消失）；
 *  - 结论列徽章与建议文字同一行内联展开（vd-line 由块级 div 改内联 span，
 *    margin-top:3px→margin-left:6px）— 徽章后不留空行，文字紧跟徽章起排、
 *    超长自然换行。
 * v2.102：高通量两项行为修正（用户反馈 2026-11-26）：
 *  - 作业日配额 EVAL_MAX_JOBS_PER_DAY 默认 150 → 1000（gatekeeper.ts）— 用户实测
 *    「近 24 小时内已创建 150 次评估」限流：高通量一场大清单（102 行 ≈ 100+
 *    作业）+ 失败重跑/续跑（重跑即新建作业再计一次）单日即触顶自动暂停跨日
 *    才能跑完；150 改 1000，真正节流仍由并发上限（≤8 活跃 + 队列 16）与 LLM
 *    限流自动暂停承担，日配额仅防脚本滥用；
 *  - 复合物合并报告补生成修复（use-high-throughput-flow.ts touchGroupForRerun）：
 *    多靶点组判定为关联复合物但仅 1 个评估成功（或合并生成失败）时设置的
 *    mergedError 此前从无清除路径 — runGroup ③ 的 `!g.mergedError` 守卫使
 *    「重跑失败靶点凑齐 ≥2 成功」后合并报告也永远不再生成（复合物关系评估
 *    报告永久缺失）。现重跑（retryItem/retryGroupFailures/retryFailed 共同
 *    经 touchGroupForRerun）即清除过时原因，组重走链路：凑齐自动补生成，
 *    仍不齐则重设准确新文案（文案同步指向组内重跑而非「普通模式单独重试」）；
 *    mergedReportId 保留 — 已生成的有效报告不重复生成（既有语义）。
 * v2.103：「配额检查失败」误判限流整场暂停修复（用户实测 2026-11-27：
 *  高通量提交序列靶点 TI_CM006_17_B3 · 245aa 时被暂停，文案「评估作业被限流：
 *  配额检查失败，请稍后重试」）：
 *  - 根因链：checkJobQuota 的 3 个 evaluationJob.count（DB 读）在 SQLite 默认
 *    DELETE 日志模式下被并发写事务（作业状态更新 / TTL 清理删除；服务重启窗口
 *    新旧实例短暂并存操作同一 db 文件 — dev.log 实证 EADDRINUSE 瞬间）锁阻塞
 *    抛非 QuotaError 异常 → evaluate 路由 500 兜底文案「配额检查失败，请稍后
 *    重试」→ 前端 isRateLimitError 按「配额」关键词误判为限流 → pauseWithReason
 *    整场暂停（瞬时 DB 错误只应标该靶点 error，不应暂停整场）；
 *  - 三层修复：① db.ts 模块加载时幂等 PRAGMA journal_mode=WAL（持久属性，
 *    读不阻塞写/写不阻塞读，跨进程并发安全；已对当前库立即执行生效）；②
 *    evaluate 路由 500 兜底文案改「服务暂时不可用，请稍后重试」且 catch 落
 *    console.error（本次事故 dev.log 零痕迹）；③ isRateLimitError 删除
 *    「配额|quota」关键词（真实 429 文案均不含该词，唯一含的是 500 兜底 —
 *    误判源），补「近 24 小时内已上传/服务器繁忙」覆盖上传配额文案。
 */
export const APP_VERSION = 'v2.103.0'
