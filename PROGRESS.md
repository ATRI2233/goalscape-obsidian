# Goalscape Obsidian 插件 — 开发纪要（持续更新）

> 给后来者 agent 的话：请对以下"已完成"的内容保持审视态度——用之前先读代码、能验证就验证（单测/构建/实际点一遍），
> 不要默认它是对的。但不要吹毛求疵：对已验证正确、只是写法不够优雅的代码不必返工；只在发现真实的正确性/
> 可用性问题，或与 tech-plan.txt 验收标准冲突时才动手改。每次做分析/发现问题/定计划，都更新本文件，不要只放在对话里。
>
> 2026-10-08：下面每条任务记录已压缩到 100 字以内（只留结论与踩过的坑，实现细节回代码里读）。
> 压缩前的全文备份在 `D:/tmp/PROGRESS.md.bak-163949`；CDP 验证通道的操作细节另见记忆 `cdp-verification-channel`。

## 已完成并验证（构建通过 + 数据层单测通过）

### Phase 1 — 数据层 + 放射图只读渲染 + Collapse/Expand
`rollup` 按权重加权汇总进度；`radialView` 权重→角度、进度→颜色、折叠、外部编辑自动刷新。修 3 个真 bug：剪贴板要深拷贝、整圆角度退化要钳制、跨父级移动两端要归一化。

### Phase 2 — CRUD + 信息面板 + 权重拖拽 + 进度汇总
右键菜单增删改重命名 + 剪贴板；`infoPanel` 全字段编辑；选中扇区外沿圆点拖 `adjustImportance`。`applyColorToSubtree` 后来被删（见"配色两轮"）。

### Phase 3 — 拖拽重挂载 + Focus Filter + 颜色主题
pointer 把扇区拖到新父级（ghost 标签 + drop-target 高亮，`moveGoal` 含环检测）；`focusFilter` 按 Tag/进度区间/颜色过滤，非匹配项 grayscale 降饱和。

### Phase 4 — Goal List 视图 + Canvas 同步导出
`listView` 缩进树、折叠、叶子勾选、双击 inline 改标题；`canvasSync.toCanvas` 单向转 JSON Canvas（放射布局、进度→6 个 preset 色、父→子 edge）。

### Phase 5 — Gantt 视图 + 导出 PNG/SVG/CSV + 模板库
`ganttView` 月刻度 + 按 start/due 定位条形 + 拖手柄改叶子进度；`exporters` 出 PNG/SVG/CSV/Markdown 大纲；`templates` 四套预置模板。

### 注册与命令（main.ts）
三个视图各带独立打开命令，另有五条导出命令、应用模板命令，Ribbon 图标打开放射图。

### 真实 Obsidian 端到端验证（已打通通道）
Obsidian 带 `--remote-debugging-port=9333` 跑 CDP + 截图实测。两个必踩的坑：`Runtime.evaluate` 要 `awaitPromise`，换 main.js 后必须 disable/enable 插件才热加载。顺带修了环数 off-by-one 导致外环被 viewBox 裁掉。

### 端到端交互实测
在真实 app 里点遍选中、右键、新建子目标、Importance/Progress 滑杆、汇总、筛选、权重拖拽、重挂载、三视图、导出、模板，全过。`getScreenCTM().inverse()` 在 Electron 里换算正常。

### 用户实测反馈的 5 个 UX 问题
缺新建图入口、根扇区接缝黑线、缺增同级/子级按钮、右侧栏横向挤压、整图丑。接缝改用两个半圆弧拼；后三条又被"工具栏瘦身"推翻。

### 放射图视觉重做
环间隙按**弧长**而非固定角度算（否则外环裂缝越宽），描边 1.5→1；中心盘压暗、外环逐层提亮；标签 14px + `paint-order: stroke` 描边光晕。`getBBox` 双重量过不溢出。

### 真实 bug：插件启动即失败（已修）
`onload` 里 `await store.load()` 排在 `registerView` 之前，启动早期索引未就绪 → `createFolder` 抛"已存在" → 整个插件不活动。修法：容忍已存在。教训：`registerView` 之前的任何 await 都是单点故障。

### 真实 bug：切图把文件截断成 0 字节（已修）
统一 `writeScape()` 双空值拦截、读写全走 `vault.adapter` 绕开索引竞态、拒解析空文件、`switchTo` 清挂起 reload。推翻了 Phase 1 的"首次建档用 `vault.create`"。快速连切六轮监视字节无一次归零。

### CDP 实测重要坑：后台窗口的 renderer 会被冻结
不可见窗口的 renderer 被 Chromium 挂起，**任何** CDP 命令都不回、`Debugger.pause` 也拿不到栈。判据：进程 4 秒 CPU 增量为 0 就不是忙循环。自动化前必须把窗口带到前台且全程不失焦。

### 真实 bug：拖拽完全不跟手（已修）
`render()` 用 `rootEl.empty()` 重建 svg，拖拽捕获的那个节点当场变游离，`getScreenCTM()` 返回 null 被兜底成恒定角度。改成每次 move 重新查 svg，再加 `lastImportance` 去重避免每帧落盘。

### 真实缺陷：导出的 SVG/PNG 丢样式、底色写死（已修）
序列化前用 `inlineComputedStyles()` 把计算值内联；底色从 svg 往上找第一个真正被绘制的背景（主题变量挂在 body 上），否则独立 SVG 退回黑字 16px、白底查看器里白字直接消失。

### 真实缺陷：标签固定白字，外环对比度最低 1.3:1（已修）
穷举 4 进度色 × 5 层 × 3 同级 = 60 组合，54 种对白字低于 3:1。`labelInk()` 按 WCAG 相对亮度在白/深字里取高者、光晕反色、用内联 style 上色（类规则会盖掉同名属性）。最差 4.37:1。

### 真实缺陷：CSV 无 BOM、Markdown 静默丢子树（已修）
CSV 补 BOM 否则 Excel 按本地代码页解 UTF-8 全乱码；Markdown 不再按 `collapsed` 跳过递归——折叠只是放射图的视图状态。坑：Edit 工具会吃掉字面 BOM，必须 `String.fromCharCode(0xFEFF)`。

### 数据安全隐患：删除整棵子树零确认（已修）
只在**有后代**时弹确认（叶子删除不制造摩擦），文案带子目标数。坑：`Modal.close()` 会同步触发 `onClose()`，先 close 再回调等于把 Promise 定成取消，确认静默失效。

### 真实 bug：Gantt 拖父级条形留下"假进度"（已修）
父级进度是汇总值不能手填，`up` 里既不落盘也不重绘，条形就停在假位置、下次 render 才弹回。修法：父级分支在 `up` 里显式 `render()` 回弹。断言别拿 render 前的游离元素。

### 亮色主题复核
放射图/List/Gantt/信息面板亮色全部截图复核正常。坑：测试脚本反复 `getLeaf(false)` 会在工作区堆出空的重复标签页，"面板没刷新"其实是选中了那个空 leaf，收尾必须 detach。

### 真实 bug：信息面板每次重建泄漏一个 window 监听（已修）
`trackInteraction` 原先每 render 无条件常驻一个 `window pointerup`，越积越多 → 之后点应用任何地方都重建整个面板（滚动弹回顶部、焦点丢失）。改成 `pointerdown` 里挂、`end` 里先拆再重绘。

### 真实缺陷：Color 字段不校验，非法色值让扇区"看不见"（已修）
非法值会原样进 `fill` 退回默认渲染。`normalizeHex()` 只收 3/6 位并统一归一成 `#rrggbb` 再落盘，非法则 Notice + 回滚成真实色、不进 store；等价输入不落盘避免全量重绘。

### 数据层复核：`goalTree.ts` 无需改动
逐条读过：双空值拦截、拒空文件、adapter 按路径读写绕竞态、`writing` 标记 500ms 释放、`switchTo` 清挂起 reload 都对。唯一瑕疵是解析失败的 Notice 文案不够精确，属保守设计，不改行为。

### 测试基建（`src/data/__tests__/`，已入库）
零新依赖：`npm test` 用仓库现成的 esbuild 打包，交给 Node 内置 `node:test`。`fake-vault` 刻意复刻真实坑而不是绕开。断言抽查过不是摆设（逐个变异看是否变红）。只覆盖数据层，视图层仍靠 CDP 实测。

### 用户反馈：删掉 Responsible、右侧 Color 加色盘
Responsible 全链路删除，`normalize` 读档即 `delete` 旧键让历史 JSON 自然收敛。右侧 Color 加原生取色器（只监听 `change`，别跟 `input` 连发落盘）+ 10 预设块 + Auto。

### 收口实测（构建 + 部署 + 真实 Obsidian CDP 全量回归）
色盘、新色盘对比度穷举 150 组合、radialView 拆分回归、导出、监听泄漏、模板、亮暗两主题一次跑完。用户 `life` 图 732B→628B 只少了 responsible 四个历史键。CDP 新坑五条已并入记忆。

### 新增：上栏的"呈现方式切换器"
`VIEW_*` 常量挪进中立的 `viewTypes.ts` 破循环依赖；前三项走 `leaf.setViewState` 在同一标签页内换视图，Canvas 走 `openCanvas()` 且高亮不动。白板是**单向导出**，文件已存在就原样打开、不重算布局。

### 工具栏瘦身：单行、只留切换与筛选
`+Subgoal/+Sibling/Delete/New map` 全部撤出（右键与目录栏 `file-menu` 已有），工具栏收成 40px 一行：图标分段按钮 + 图名原生 `Menu` + 漏斗浮层。点外面/Esc 用 `registerDomEvent` 捕获阶段，避免重演监听泄漏。

### UI 回归脚本收编：`test/ui-regression.mjs`（`npm run test:ui`）
把散在 `D:/tmp` 的探针合成仓库里常驻的一份。三条要点：断言按**结构**不按界面文案、等待统一走 `waitFor` 轮询、现场还原进 `finally`。白板字节数打开后必变不是重导出，要按节点数据判。

### 放射图改成"森林"几何（分支 `radial-forest-geometry`）
破坏性语义变更：`importance` 改成"占父扇区角度的绝对百分比"，兄弟和 <100 留白、>100 只缩渲染不改数据。`bandScale` 四档逐节点环厚，`radialUnit` 只跟层数挂钩（否则调一块全图变宽窄），标签按弧长判。

### 架构健康度复查 + 干净度清理
`src` 无超 500 行文件、`main.js` 与 HEAD 源码同步。清掉 5 个无人使用的 `export`、`any` 归零、`Goalscapes/` 路径常量抽成单一真源。结论：现有脚本已覆盖"改→查→打包→测→部署"，不需要新增。

### 配色两轮改造：进度→饱和度 + 一条分支一个色相
第一轮把进度压进饱和度（**已被第三轮推翻**）；第二轮色相只存中心盘与二级节点，`branchColors` 成唯一真源，深层 `color` 读档与落盘各清一次——"父改色子没改"在数据里根本不存在。

### 配色第三轮：进度退出饱和度、改画外缘细条 + 整组光影
"丑"的根因不是配色，是上轮把五支选色的饱和度全强行提纯成 S50、明度又只差 +3/层。现在饱和度还给选色，进度改画扇区外缘 dash 弧（**不画轨道**，否则每格一道黑线），整组一份 drop-shadow + `userSpaceOnUse` 光源渐变。不引玻璃拟态。

## 剩余未实测

- PNG/SVG/CSV/Markdown 的**内容**已用 Blob 捕获法实测。仍未点过一次真实的系统保存框：
  `<a download>` 在 Electron 里会弹原生对话框，自动化会把它卡住。
- 没有覆盖率统计，也没有 watch 模式（刻意不引第三方框架）。
- 模板应用后信息面板显示 "Goal not found." 那一类**跨层**问题（选中态与数据替换的耦合），
  单靠数据层单测抓不到，仍需在真实 Obsidian 里点。
- Focus Filter 色块的**可读性改造**没做（加 `Color` 文字标签，或换成"本图已用颜色"下拉以避开严格相等的坑）——
  已把语义讲清楚给用户，等点头再做。色相收归二级节点之后，这个入口的含义变成"按分支筛"，
  而严格相等比对的是分支存的那个十六进制串，仍没实测。
- 留白版模板没做（模板数值仍是"和=100"，在森林语义下会铺满整圆）；深图钻取（超过 4 层只展开到第 K 层）、
  四档之外的任意环厚微调同样没做。
- 配色的层级明度阶梯（+3/层太弱）、`(siblingIndex % 3) * 2` 的无编码抖动、1px 背景色描边、
  色盘整体降饱和 —— 都提过，用户没点，未动。
- `canvasSync.progressToPreset` 仍按进度映射红/橙/黄/绿：JSON Canvas 只有 6 个 preset 色、表达不了任意色相，
  改成"分支色相→最近 preset"会引入量化误差，等点头再动。

## 后续计划（按优先级）

1. 人工点一次 PNG/SVG/CSV/Markdown 下载，确认系统保存框行为（自动化会卡住，未测）。
2. Focus Filter 加"高亮匹配项列表"侧栏、Gantt 依赖关系连线、Canvas 导出支持 group 节点分层。
3. 上面"剩余未实测"里等用户点头的几项：留白版模板、层级明度阶梯、色盘降饱和、Focus Filter 色块可读性。
