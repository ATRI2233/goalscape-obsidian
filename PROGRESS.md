# Goalscape Obsidian 插件 — 开发纪要（持续更新）

> 给后来者 agent 的话：请对以下"已完成"的内容保持审视态度——用之前先读代码、能验证就验证（单测/构建/实际点一遍），
> 不要默认它是对的。但不要吹毛求疵：对已验证正确、只是写法不够优雅的代码不必返工；只在发现真实的正确性/
> 可用性问题，或与 tech-plan.txt 验收标准冲突时才动手改。每次做分析/发现问题/定计划，都更新本文件，不要只放在对话里。

## 已完成并验证（构建通过 + 数据层单测通过）

### Phase 1 — 数据层 + 放射图只读渲染 + Collapse/Expand
- `types.ts` / `rollup.ts`：进度自动汇总（权重加权平均），已用 Node 单测验证。
- `radialView.ts`：权重→扇区角度、进度→颜色、折叠展开、JSON 文件外部编辑自动刷新。
- 已修复 3 个真实 bug + 1 个风险项（commit `bfe75b1`）：
  1. `extractSubtree` 返回活引用 → 改为 `cloneSubtree` 深拷贝。
  2. 中心扇区整圆退化 → 显式 `FULL_CIRCLE_EPSILON` 钳制。
  3. `moveGoal` 跨父级权重不归一化 → 加 `renormalizeSiblings`。
  4. 首次建档 `adapter.write` 竞态风险 → 改用 `vault.create()`。

### Phase 2 — CRUD + 信息面板 + 权重拖拽 + 进度汇总
- 右键菜单 CRUD（增/删/重命名/设进度）、剪切/复制/粘贴。
- 信息面板 `infoPanel.ts`：Title/Importance/Progress/Due/Start/Responsible/Tags/Color/Notes/自定义字段。
- 权重拖拽手柄：选中扇区外沿圆点，拖动调用 `adjustImportance`。
- 颜色应用到子目标：`applyColorToSubtree`，接在面板按钮上。

### Phase 3 — 拖拽重挂载 + Focus Filter + 颜色主题
- 拖拽重挂载 UI：pointer drag 扇区到新父级，带 ghost 标签 + drop-target 高亮，调用 `moveGoal`（含环检测）。
- Focus Filter 工具栏 `focusFilter.ts`：按 Tag/Responsible/Progress 范围/Color/Due 过滤，非匹配项 grayscale 降饱和。
- 颜色主题：数据模型 `colorMeanings` 已就位；InfoPanel 颜色选择器 + "Apply to subgoals" 按钮已接入。

### Phase 4 — Goal List 视图 + Canvas 同步导出
- Goal List 视图 `listView.ts`（VIEW_LIST）：缩进树、折叠切换、叶子勾选完成、双击 inline 编辑标题、进度滑杆。
- Canvas 同步导出 `canvasSync.ts`：`toCanvas()` 把 GoalScape 转 JSON Canvas（放射布局、进度→preset 颜色、父→子 edge）。命令 "Export to .canvas" 写入并打开文件。

### Phase 5 — Gantt 视图 + 导出 PNG/SVG/CSV + 模板库
- Gantt 视图 `ganttView.ts`（VIEW_GANTT）：时间线月刻度、按 start/due 定位条形、进度填充叠加、拖动手柄直接改叶子进度。
- 导出 `exporters.ts`：PNG（SVG→Canvas→Blob 2x）、SVG（序列化）、CSV（扁平化含 depth/parent 列）、Markdown 大纲。
- 模板库 `templates.ts`：4 个预置（Life Balance / Business / Fitness / Learning），Modal 选择后替换当前树。

### 注册与命令（main.ts）
- 三个视图：`VIEW_RADIAL` / `VIEW_LIST` / `VIEW_GANTT`，各有独立打开命令。
- 导出命令：Export to .canvas / PNG / SVG / CSV / Markdown outline。
- 模板命令：Apply template。
- Ribbon icon 打开放射图。

### 真实 Obsidian 端到端验证（已打通通道）
- 验证通道：Obsidian 以 `--remote-debugging-port=9333` 启动，用 CDP（WebSocket + `Runtime.evaluate`，
  **必须带 `awaitPromise: true`**，否则 async 表达式会被序列化成 `{}`，之前因此误判过 store 为空）+
  `Page.captureScreenshot` 截图实测。测试 vault = `ob库--个人记录`。
- **重要坑（后来者注意）**：用 install-plugin.bat 替换 main.js 后，**正在运行的 Obsidian 不会热加载**，
  内存里仍是旧代码，会表现出"store 为空/不渲染"等假象。必须先 `app.plugins.disablePlugin` 再
  `enablePlugin`（或重启 Obsidian）才能让新 main.js 生效。之前"store.scape undefined"就是这个原因，不是代码 bug。
- 已实测修复 1 个真实渲染 bug：放射图环数 off-by-one。`visibleDepth` 返回最深 depth 索引，环数应为
  `maxDepth + 1`；原写 `Math.max(1, maxDepth)` 导致最外环画到 `MAX_R..2*MAX_R` 被 viewBox 裁切
  （截图表现为整块纯色溢出）。`radialView.ts` 的 render 与 `hitTestNode` 两处同改。修复后截图确认：
  中心 Main Goal + 外环 Health/Career/Relationships 三扇区、标签、Filter 工具栏、信息面板占位均正常。

### 端到端交互实测（已完成，全部通过）
在真实 Obsidian（v1.9.14，测试 vault）里用 CDP 派发真实 DOM 事件驱动 UI，读回 store/DOM 状态 + 截图复核。
测试前备份 `Goalscapes/life.goalscape.json`，测试后已还原，并删除测试产生的 `Goalscapes/Main_Goal.canvas`，vault 已复原。
- 点击选中：扇区 path 加 `.goalscape-selected`，信息面板标题同步。✅
- 右键菜单：完整项齐全（Add subgoal/Add sibling/Rename/Set progress/Cut/Copy/Paste as child/Delete + 有子节点时 Collapse/Expand）。✅
- Add subgoal：菜单 → prompt 弹窗输入 → Confirm → 子节点数 +1 且新扇区渲染。✅
- Importance 滑杆：设为 60，同级权重自动归一化，siblings 总和=100。✅
- 叶子 Progress：设为 80 → 父级 Health 汇总 80 → 根按加权平均汇总 48（60%*80）。rollup 引擎端到端正确。✅
- Focus Filter：输入无匹配 Tag → 4 个扇区全部 `.goalscape-dimmed`；清空后归 0。✅
- 权重拖拽手柄：pointerdown+move+up，Health 权重 60→25。**之前最担心的 `getScreenCTM().inverse()` 在 Electron 里换算正常**。✅
- 拖拽重挂载：子目标从 Health 拖到 Career，父级正确变更（hitTestNode + moveGoal 生效，跨环角度反查 OK）。✅
- List 视图：打开后渲染缩进树行。✅
- Gantt 视图：无日期时正确显示空态提示；给 Health 设 due 后渲染 bar/row/month tick，进度填充可见（`clientWidth` 首帧未为 0）。✅
- Canvas 导出：命令生成 `Goalscapes/Main_Goal.canvas`，含 group + nodes。✅
- 模板替换：Modal 列 4 个模板，应用 Life Balance → 根 "My Life" + 5 域 + 二级子目标，**3 环放射图正确铺满不溢出**（再次印证环数修复）。✅
- 唯一小瑕疵（非 bug，暂不返工）：应用模板后信息面板显示 "Goal not found."，因原选中节点 id 随模板替换消失。
  可在模板应用/外部重载时清空 `selectedId` 让面板回到占位，属可选打磨。

### 用户实测反馈的 5 个 UX 问题（已全部修复并截图复核）
1. **没有新建图的入口** → 工具栏加 `<select>` 地图切换器 + "New map" 按钮；命令面板加 `goalscape-obsidian:new-goalscape`。
   `main.ts` 新增 `listGoalscapes/switchGoalscape/createGoalscape/promptNewGoalscape/refreshMapSelectors`，
   当前路径持久化在 `data.json` 的 `currentPath`。
2. **主目标扇区多出一根黑线** → 根因：整圆用单条 `A r r 0 1 1` 回到起点，SVG 在起止接缝处画出一条缝。
   `arcPath` 改为整圆时用**两个半圆弧**拼外圈（有内径时再拼内圈反向两弧），接缝消失。
3. **顶部没有增同级/增子级按钮** → 工具栏加 `+ Subgoal` / `+ Sibling` / `Delete`。`+ Sibling` 需先选中节点，否则 Notice 提示。
4. **右侧栏排版混乱** → 面板内 Obsidian `Setting` 改为"标题在上、控件在下"纵向布局（`.goalscape-panel .setting-item{flex-direction:column}`），
   320px 宽度里不再横向挤压换行；宽度 300→320。
5. **整图丑、可视性差** → 见下节"放射图视觉重做"。

### 放射图视觉重做（问题 5）
- 环间隙与扇区裂缝大幅收窄：`RING_GAP` 由 `min(12, ringW*0.14)` 降到 `min(5, ringW*0.045)`；
  扇区留白从**固定角度** `min(span*0.16, 0.028)` 改为按**弧长** `min(span*0.1, SECTOR_GAP_ARC/rOuter)`——
  固定角度会让外环半径越大裂缝越宽，之前看起来像黑色裂纹。描边 1.5→1。
- `shadeColor(hex, percent)` 支持负值（向黑混合）；`colorFor(node, depth, siblingIndex)`：
  **中心盘压暗 -22%**、外环按 `depth*9 + (siblingIndex%3)*6` 逐层提亮，
  使"整树进度相同（全 0%）"这种最坏情况下环层与相邻扇区仍可分辨。`drawNode` 递归用 `forEach((c,i))` 传同级序号。
- 标签：13→14px，`paint-order: stroke` + `stroke: rgba(0,0,0,.5)` 3px 描边（原来的 text-shadow 在 SVG 里发糊）；
  根节点标题水平居中于 hub（`.goalscape-label-root` 20px）+ 下方整体进度，子节点仍沿半径旋转、左半球 flip。
- 已验证：2 环（用户真实 life 图）与 3 环（Life Balance 模板，17 path / 18 label）均无 viewBox 溢出，
  `getBBox` 与 `getBoundingClientRect` 双重量过。

### 真实 bug：插件启动即失败，界面显示"插件不再活动"（已修）
- 症状：冷启动后放射图标签页显示"插件不再活动"，`store.scape` 为 undefined，但 `data.json` 里插件是启用状态、
  `failedPlugins` 为空。手动 `enablePlugin` 则成功。
- 根因链：`onload` 第 20 行 `await this.store.load()` 在 `registerView` **之前**；
  `load()` → `ensureFolder()` → 启动早期 vault 索引尚未就绪，`getAbstractFileByPath("Goalscapes")` 误报 null →
  `vault.createFolder("Goalscapes")` 抛 **"Folder already exists."**（已用 CDP 实证该报错）→
  `onload` reject → 视图根本没注册 → 保存的 leaf 退化成占位页。
- 修复：`ensureFolder()` 用 try/catch 容忍"已存在"。修后冷启动自启成功，标题栏正确显示 "Goalscape Radial"。
- **教训**：`onload` 里任何在 `registerView` 之前的 await 都是单点故障。后续若再加启动逻辑，优先只注册视图/命令，
  数据加载失败应降级为 Notice 而不是让整个插件挂掉。

### 真实 bug：多图切换把 goalscape 文件截断成 0 字节（数据丢失，已修）
- 症状：切换测试中发现 `Goalscapes/life.goalscape.json` 变成 0 字节。已从备份恢复。
- 修复（`goalTree.ts`）：统一落盘入口 `writeScape()`，`if (!this.scape) return;` + `if (!content) return;`，
  空内容永不落盘；`load()`/`readFromPath()` 全部改走 `vault.adapter`（`adapter.exists` 对文件确实返回 true，已实证），
  并拒绝解析空文件；`switchTo()` 清理挂起的 reload 计时器；首次建档不再用 `vault.create`（对已存在文件会抛错）。
- **注意：这条推翻了 Phase 1 记录的第 4 项修复**（"首次建档改用 vault.create()"）——`vault.create` 在文件已存在时抛错，
  且启动早期索引不可靠，现在统一用 adapter 落盘 + 事后刷新 `file` 引用。
- 回归验证（`D:/tmp/trunc.mjs`，全程监视文件字节数）：新建 → 切回 → mutate → 往返 → 6 次快速连切，
  `life.goalscape.json` 全程 713B→732B（仅 rollup 补了根节点 `"progress": 0`，语义 diff 确认无字段丢失），
  无一次 0 字节；测试文件已删除、`data.json` 已还原。

### CDP 实测重要坑：窗口在后台时 renderer 会被冻结（不是死循环）
- 曾误判为"renderer 卡死/代码死循环"：`Runtime.evaluate('1+1')` 超时、`Page.captureScreenshot` 超时、
  连 `Debugger.pause` 都不回 `Debugger.paused`。
- 实测定位方法（下次直接照做，别浪费时间猜）：
  1. `Get-Process Obsidian` 取 4 秒 CPU 增量 → **全为 0** ⇒ 不是 JS 忙循环（忙循环会吃满一核）。
  2. `user32!IsIconic/IsWindowVisible` + GDI `CopyFromScreen` 截屏 → 看到真实界面（本例正是它暴露了"插件不再活动"）。
  3. 把 Obsidian 窗口**切到前台**后再连 CDP → `1+1` 立刻返回 2。
- 结论：Chromium/Electron 会把不可见窗口的 renderer 主线程挂起，此时**任何** CDP 命令都不响应、
  且 `Debugger.pause` 也拿不到栈。自动化验证前必须先把窗口带到前台（`D:/tmp/front.ps1`），
  且全程不要让 Obsidian 失去焦点。

### 真实 bug：拖拽完全不跟手（已修，实测）
- `render()` 用 `rootEl.empty()` 重建整个 svg，拖拽开始时捕获的 `drag.svg` 立刻变成**游离节点**，
  `getScreenCTM()` 返回 null，而 `toLogicalPoint` 的兜底 `return {x:CX,y:CY}` 把角度恒定成 0。
  权重拖拽"看起来能改值"纯属巧合：Health 的 startAngle 是 −π/2，恒定 0 角正好算出 25。
- 修法：新增 `liveSvg()`，每次 move 重新 `rootEl.querySelector("svg")`；重挂载拖拽同理
  （它的 move 里也调了 `render()`）。再加 `lastImportance` 去重，避免指针每动一次就全量落盘。
- 实测（`D:/tmp/drag.mjs`）：指针绕圆心 0 / 1.57 / 3.14 弧度 → importance 25 / 50 / 75；
  悬停 Career、Relationships 时 drop-target 分别解析为对应节点，不再恒等于根节点。

### 真实缺陷：导出的 SVG/PNG 丢样式、底色写死（已修，实测）
- `exportSvg` 原先直接序列化：扇区描边用的 `var(--background-primary)` 脱离文档后失效，
  `.goalscape-label` 的字号/字色/光晕全在文档 CSS 里 → 独立 SVG 里标签退回黑色 16px 默认值；
  `exportPng` 还把画布底色硬编码成 `#1e1e2e`。
- 修法：`inlineComputedStyles()` 按 `INLINED_PROPS` 把计算值内联成属性；
  `themeBackground(svgEl)` 从 svg 往上找第一个真正被绘制的背景（Obsidian 的主题变量挂在 body 上，
  读 `documentElement` 拿到空串）；`withBackground()` 给导出文件插入整幅底色矩形，
  否则白底查看器里白字标签直接消失。
- 实测（捕获 `URL.createObjectURL` 的 Blob，不触发保存框）：序列化结果 `var(` 计数 0、
  `<style>` 0 个、5/5 个 `<text>` 带具体 fill 与 font-size、4/4 个 path 带 stroke、
  首元素为 `rect fill=rgb(30, 30, 30)`；PNG 2000×2000、魔数正确、角像素 [30,30,30]（不再是硬编码的 30,30,46）。

### 真实缺陷：标签固定白字，外环对比度最低 1.3:1（已修，实测）
- 视觉重做把外环逐层提亮，与固定白字直接冲突：按 4 个进度色 × 5 层 × 3 个同级序号穷举，
  **60 种组合里 54 种对白字低于 3:1**，最差 `#fdde8d` 只有 1.31:1。且 `--text-on-accent` 在
  亮/暗主题下都是白色，所以两种主题都读不出。
- 修法：`labelInk(sectorColor)` 用 WCAG 相对亮度在 `#ffffff` / `#0f172a` 中取对比度更高者，
  光晕取反色；用**内联 style** 上色（类选择器优先级高于同名 CSS 属性，`setAttribute("fill")` 会被
  `.goalscape-label` 的规则盖掉），因此同步删掉 CSS 里的 `fill`/`stroke`。
- 实测：穷举后最差 4.37:1、低于 3:1 的 0 个；应用内 `isPointInFill` 配对实测
  根标签 4.37、`Health/Career` 7.07/7.47，暗色与亮色主题 min 都是 4.37、below3=0。
  截图 `D:/tmp/ink2_dark.png`、`D:/tmp/ink2_light.png`、`D:/tmp/ink_light_chart.png`（3 环模板）。

### 真实缺陷：CSV 无 BOM、Markdown 大纲按 collapsed 静默丢子树（已修，实测）
- CSV 无 BOM 时 Excel 按本地代码页解 UTF-8，中文标题全乱码；
  `exportMarkdownOutline` 原先 `if (!node.collapsed)` 才递归 —— 折叠只是放射图的视图状态，
  导出时据此跳过会**静默丢掉整棵子树**，用户不会察觉文件少了内容。
- 实测（17 节点 Life Balance 模板，折叠前两条分支、图上只剩 12 个 path）：
  CSV `bom:true`、18 行（表头+17）；Markdown 折叠前后都是 17 行。
- 注意：Edit 工具会把字符串字面量里的真实 BOM 字符吃掉（写成 `""` 变空串），
  必须用 `String.fromCharCode(0xfeff)`；esbuild 会把它压成 `fromCharCode(65279)`。

### 数据安全隐患：删除整棵子树零确认（已修，实测）
- 工具栏 Delete 与右键 Delete 都直接 `deleteGoal`，带后代的节点一点击就整支消失，且插件数据没有撤销。
- 修法：`promptModal.ts` 加 `confirmAction()`；`radialView.confirmDelete()` 只在**有后代**时弹确认
  （叶子节点删除很常见，不制造摩擦），文案带上子目标数量。
- 踩过的坑：`Modal.close()` 会**同步**触发 `onClose()`。第一版按钮先 `close()` 再 `onAnswer(true)`，
  于是 onClose 里的"取消"分支先把 Promise 定成 false，确认删除静默失效 —— 实测表现为
  点 Delete 确认后节点数纹丝不动（17→17）。改成先 `onAnswer` 后 `close`。
- 实测（临时图 ZZ_DEL + Life Balance 模板，17 节点）：选中 Health 点 Delete → 弹
  `Delete "Health" together with its 3 sub-goals? This cannot be undone.`；Cancel → 仍 17 节点；
  再次确认 → 13 节点（连带 3 个子目标）；选中叶子节点删除 → 不弹框、13→12。临时图已删，life 仍 732 字节。

### 真实 bug：Gantt 里拖动父级条形会留下"假进度"（已修，实测）
- `attachProgressDrag` 的 move 会即时改条形宽度与 fill，但 `up` 只在**叶子节点**上落盘；
  父级进度是汇总值不能手填，于是既不落盘也不重绘 —— 条形就停在用户拖到的假位置上，
  直到下一次别的操作触发 render 才突然弹回，数据与界面不一致。
- 修法：父级分支在 `up` 里显式 `this.render()` 回弹。
- 实测（临时图 ZZ_G，17 个带日期节点，亮色主题）：拖父级手柄到 80% → 松手后 DOM 读回 62%，
  与 `store.scape.mainGoal.progress` 的 62 一致（`revertedToData:true`）。
  第一版断言误报过"没修好"：拿的是 render 前那个已游离的 bar 元素，改成每次重新查 DOM 才对。

### 亮色主题复核（已完成）
- 放射图：见上文对比度一节，暗/亮两主题 min 4.37:1。
- List 视图：正常（`D:/tmp/light_list.png`）。Gantt 有排期条形：正常
  （`D:/tmp/light_gantt_bars.png`，17 行、月份刻度 2026-01..04、标签 rgb(34,34,34)）。
  信息面板：正常（`D:/tmp/light_panel.png` + 实测 320×722、9 个字段、输入框深字白底）。
- 踩过的坑：测试脚本反复 `getLeaf(false)` 会在用户工作区里堆出**空的重复标签**
  （实测出现过 4 个 radial leaf，其中一个是 `view.select` 都不存在的未初始化 leaf），
  于是"面板没刷新"其实是选中了那个空 leaf。收尾必须 detach 多余标签并清掉选中态。

## 剩余未实测

- PNG/SVG/CSV/Markdown 的**内容**已用 Blob 捕获法实测（见上）。仍未点过一次真实的系统保存框：
  `<a download>` 在 Electron 里会弹原生对话框，自动化会把它卡住。
- 没有自动化测试基建（无 vitest/jest），目前"单测"是临时 esbuild 转译 + 手写断言，没留在仓库里。
- ~~放射图视觉重做只在暗色主题下截过图~~ 已补：亮色主题下标签、环间隙、导出底色均已复核（见上两节）。
- ~~亮色主题下 List 视图已截图复核（正常）；Gantt 只看到空态（life 图没有日期），有排期的甘特条在亮色下的配色未验证；右侧信息面板亮色也未截图复核。~~
  已补验，见"亮色主题复核"一节。

## 后续计划（按优先级）

1. ~~端到端交互验证~~ 已完成（见上），放射图/三视图/CRUD/拖拽/导出/模板全部实测通过。
2. ~~用户反馈的 5 个 UX 问题~~ 已完成（见上），并顺带修掉启动失败与 0 字节截断两个真实 bug。
3. 可选：人工点一次 PNG/SVG/CSV/Markdown 下载，确认系统保存框行为（自动化会卡住，未测）。
4. 补正式测试文件基建（`src/data/__tests__/`），把已有的临时断言脚本固化。
5. ~~建议：把 `onload` 里 `await this.store.load()` 移到视图/命令注册之后~~ 已做：读档放在
   视图/命令注册之后，数据出问题只影响图的内容，不再连带让标签页退化成"插件不再活动"占位页。
6. 可选打磨：右键菜单加"应用颜色到子目标"入口、Focus Filter 加"高亮匹配项列表"侧栏、
   Gantt 依赖关系连线、Canvas 导出支持 group 节点分层。
7. ~~可选：亮色主题下补验 Gantt 条形与信息面板配色~~ 已完成（见"亮色主题复核"），顺带修掉 Gantt 父级条形的假进度。
