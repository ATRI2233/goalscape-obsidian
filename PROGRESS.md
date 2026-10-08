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

### 真实 bug：信息面板每次重建都泄漏一个 window 监听（已修，实测）
- `trackInteraction()` 原先无条件 `window.addEventListener("pointerup", end)` —— 监听不是随拖拽建立、
  随释放拆除，而是**每 render 一次就常驻一个**。面板每改一个值就 mutate → notify → 重建，于是监听单调增长，
  之后在应用里点**任何地方**都会触发 N 次"重建整个面板"，表现就是滚动位置被弹回顶部、输入焦点丢失。
- 修法：`pointerdown` 里才挂 `pointerup`，`end` 里先 `removeEventListener` 再重绘。
- 实测（`D:/tmp/panel.mjs`，用 CDP 调 `DOMDebugger.getEventListeners` 数 window 上的 pointerup）：
  基线 0 个 / 强制重建 15 次后仍 0 个 / 拖完滑杆释放后 0 个；滑杆 40→70 正常落盘（`stored:70`）。

### 真实缺陷：Color 字段不校验，非法色值让扇区"看不见"（已修，守卫实测通过）
- 面板可以填任意字符串，`node.color` 直接进 `colorFor()`；`shadeColor` 解析失败就原样返回，
  于是 `red`、`#12345` 之类会作为非法 SVG paint 值传给 `fill`，扇区退回默认渲染（暗色主题下几乎不可见），
  而用户完全不知道是哪一步坏的。
- 修法（`infoPanel.ts`）：新增纯函数 `normalizeHex()` + blur 时校验；非法则 Notice 并把输入框回滚成
  该节点当前真实色，**不落 store**。
- **自我踩坑**：第一版正则写成放行 `{3}|{6}|{8}` 位，看着更宽容，其实 3 位缩写会让 shadeColor 原样返回
  （整棵子树失去环层提亮），且 `luminance()` 解析失败返回 0 → `labelInk` 误选白字，
  实测 `#f0a` 上白字对比度只有约 3.2:1（深字本可达 6.6:1）；8 位带 alpha 同样不被解析。
  现在统一**归一化成 `#rrggbb` 再落盘**（`#f0a→#ff00aa`、`abc→#aabbcc`、允许省 `#`、大小写归一），
  3/6 位之外的值一律拒绝；并加 `if (v === node.color) return;` 避免等价输入也触发落盘+全量重绘。
- 实测：
  - 真值表（`D:/tmp/hexcheck.mjs`，纯函数离线穷举）：`""`/`"   "`→清空、`#4ade80`/`#ABC123`/`4ade80`→`#4ade80`/`#abc123`、
    `#f0a`/`#F0A`/`abc`→`#ff00aa`/`#ff00aa`/`#aabbcc`，`#4ade801`/`#4ade80ff`/`green`/`#12345`/`#1234567`/`rgb(1,2,3)`→全部 null。
  - 应用内（`D:/tmp/color.mjs`、`D:/tmp/color2.mjs`，临时图 ZZ_C / ZZ_D）：非法值 → store 保持上一个合法色、
    输入框回滚成 `#f0a`、Notice 文案正确；合法值 → 静默生效、扇区 computed fill 变为该色经环层提亮后的
    `rgb(90,225,139)`；清空 → `color` 变 undefined、回到按进度着色。两张临时图已删，
    `life.goalscape.json` 前后都是 732 字节。
    注意坑：Obsidian Notice 默认存活约 4 秒，连续断言时必须先 `document.querySelectorAll('.notice').forEach(n=>n.remove())`，
    否则上一条的残留会被读成"合法值也报错"。
- ~~**待办（重要）**：应用内那次实测跑的是**归一化之前**的 main.js~~ 已结（2026-10-08 收口）：radialView 拆分
  已验收，`npm run build` → 部署 → 重载 → 真实面板重跑，`#f0a` 落盘 `#ff00aa` 且扇区仍按环层提亮。
  见"收口实测"一节。

### 数据层复核：`goalTree.ts` 无需改动
- 逐条读过：`writeScape()` 的双空值拦截、`readFromPath()` 拒空文件、`adapter` 按路径读写绕开索引竞态、
  `writing` 标记 500ms 后释放（`adapter.write` 触发的 modify 是异步的）、`switchTo()` 清理挂起 reload 计时器 —— 都对。
- 唯一瑕疵是解析失败时 Notice 文案写 "keeping in-memory copy"，而首次加载失败时内存里并没有副本；
  这是**故意保守**的：`scape` 保持旧值/undefined 时 `mutate()` 会直接 no-op，不会用空数据覆盖磁盘，
  所以只属于措辞不够精确，不改行为。

### 测试基建（`src/data/__tests__/`，已入库）
- 零新依赖：`npm test` → `test/run-tests.mjs` 用仓库里已有的 esbuild 把 `src/data/__tests__/*.test.ts`
  打包成 ESM，交给 Node 内置的 `node:test` 跑（`--test-reporter=spec`，inline sourcemap 指回 .ts 行）。
  产物在 `node_modules/.goalscape-tests/`，不入库。`npm test crud` 只跑单个文件。
- `test/mocks/obsidian.ts`：obsidian 包只有 .d.ts 没有运行时，esbuild `alias` 把 `"obsidian"` 换成它
  （TFile/TFolder/Notice + `window.setTimeout` polyfill）；`Notice.messages` 用来断言用户提示。
- `test/helpers/fake-vault.ts`：内存版 vault/adapter，刻意复刻真实坑而不是绕开它——`createFolder`
  撞已存在目录会抛 `Folder already exists.`、`adapter.write` 会派生 modify、`staleIndex` 能模拟
  启动早期索引未就绪导致 `getAbstractFileByPath` 误报 null 的竞态。
- 76 条断言锁住的都是本文档上面付过代价的回归点：深拷贝剪贴板、跨父级移动两端权重归一化、
  rollup 加权（含权重和为 0 的退化分支）、mutate 先汇总再落盘、空文件/坏 version 拒绝解析、
  写盘永不写空、自我写盘不重载、watch 只注册一次、switchTo 清挂起 reload。
- 抽查过断言不是摆设：临时把 `extractSubtree` 改回返回活引用（1 条失败）、rollup 丢掉权重（7 条失败）、
  去掉 mutate 的 `recalcTree`/`save`（1/3 条失败）、去掉 `renormalizeSiblings(target...)`（2 条失败）、
  去掉写盘 self-silencing（1 条失败），改完即还原。两个等价变异体没被抓到，因为它们本身被更外层的护栏
  挡住了（`writeScape` 的 `!content` 与 `!scape` 双保险；空文件即使不显式拒绝也会在 `JSON.parse` 抛错）。
- 只覆盖数据层。视图/导出层（radialView/listView/ganttView/exporters/canvasSync/focusFilter）仍然只有
  CDP 手工实测，没进这套基建 —— 它们依赖 Obsidian 运行时，Node 里跑不了。
- 注：这套测试是照着 `responsible` 字段被废弃**之后**的模型写的（normalize 会把旧 JSON 里的
  `responsible` 直接删掉，已有一条断言锁住）。`src/data/crud.ts` 注释里"测试脚本未入库"的措辞已过期。

### 用户反馈：删掉 Responsible、右侧 Color 加色盘（已实现并在真实 Obsidian 实测）
1. **Responsible 全链路删除**（用户不用这个字段）：`types.ts` 去掉字段与 `createGoalNode` 默认值；
   `goalTree.normalize()` 改为**读档时 `delete` 掉旧键**（用交叉类型 `LegacyNode` 表达"历史字段"，不污染 `GoalNode`），
   这样 vault 里历史 JSON 的 `"responsible": [...]` 会在下一次落盘时自然消失，而不是永远残留在文件里；
   `crud.cloneSubtree` 不再拷、`exportCsv` 少一列、信息面板去掉 Responsible 设置项、
   Focus Filter 去掉 Responsible 输入框与 `FilterCriteria.responsible`。
2. **顶部那一排的语义（用户问"颜色栏和 Clear 是什么"）**：它是 Focus Filter，不是编辑工具。色块是
   `input[type="color"]`，作用是**按颜色筛选**，而且 `matchesCriteria` 用 `node.color !== c.color` 严格比较 ——
   只有手动设过颜色的节点才可能命中，按进度着色的节点永远筛不出来；控件一挂载就自带 `#4ade80` 默认值、
   没有"未启用"的视觉态，只能靠 Clear 退出，所以极易被读成"给图上色"。Clear = 清空全部筛选条件。
   **未改**：加 `Color` 文字标签/tooltip，或改成下拉列出"本图已用颜色"（顺带消掉严格相等的坑）——等用户点头。
3. **右侧 Color 有盘了**（`infoPanel.ts`）：hex 文本框 + "Apply to subgoals" 那行下面加一排
   `.goalscape-color-swatches`：原生取色器（**只监听 `change`**，取色面板里的 `input` 会随拖动连发，
   每帧都落盘 + 重建整个面板）、10 个预设色块（`COLOR_PALETTE` 全取 6 位小写，好和 `normalizeHex`
   的归一化结果对上）、"Auto" 块把 `color` 置回 undefined 即按进度着色。当前色对应块加
   `.goalscape-swatch-active`。样式写在 `styles.css` "右侧信息面板"段末（Obsidian 自动加载插件目录的
   styles.css，`install-plugin.bat` 已 copy 它，无需 `loadCss`）。
- 验证状态（2026-10-08 收口）：`npm run build` 干净、`npm test` 76 项全过，已部署到 vault 并在真实 Obsidian
  里用 CDP 实测，详见下一节"收口实测"。

### 收口实测（2026-10-08，构建 + 部署 + 真实 Obsidian CDP 全量回归）
产物：`npm run build`（tsc -noEmit + esbuild production）→ 复制 main.js/manifest.json/styles.css 到
vault 插件目录（与 `install-plugin.bat` 同样的三个文件，绕开它的 `pause`）→ CDP `disablePlugin`/`enablePlugin` 重载。
临时图 ZZ_UI / ZZ_W3 / ZZ_SHOT / ZZ_W4 / ZZ_P / ZZ_DRAG 全部删除，`Goalscapes/` 只剩 life，
列表/甘特标签已 detach，主题与选中态还原，`data.json` 的 currentPath 回到 life。
- **色盘**：点色块 → store `#38bdf8`、扇区 fill `#4ac3f9`（环层提亮仍生效）、当前块 accent 描边高亮；
  连点同一块不重复落盘；Auto → `color` 变 undefined、扇区回进度色 `#f97e7e`；原生取色器 change 落 `#f87171`；
  hex 框输 `#f0a` → 落盘 `#ff00aa` 且无 Notice（**补上了本文档欠了很久的"normalizeHex 未在真实面板跑过"**）。
  亮/暗两主题截图正常：`D:/tmp/wrap_dark_panel.png`、`D:/tmp/L_panel_full.png`。
- **新色盘对比度穷举**：10 色 × 5 环层 × 3 同级序号 = 150 组合，用真实 `radialGeometry.nodeColor/labelInk`
  离线跑（`D:/tmp/palette_contrast.mjs`）：最低 4.24:1，低于 3:1 的 0 个。
- **responsible**：筛选栏实测为 `Filter: [Tag][Min%][Max%][色块][Clear]`，面板字段里也没有 Responsible；
  CSV 表头 `Title,Importance,Progress,Due,Start,Tags,Color,Depth,ParentTitle`（18 行 = 17 节点 + 表头）。
- **radialView 拆分回归**：单击外环扇区能选中（pointerdown+pointerup，非 click）并弹权重手柄；手柄拖拽
  importance 21→30→43 随指针角度单调跟随、同级仍归一化 100；重挂载 hover Career/Relationships 命中各自父级；
  右键菜单 8 项齐全；工具栏 4 按钮 + 地图下拉；Life Balance 模板 → 17 扇区 / 18 标签，`getBBox` 25..975
  不溢出 viewBox(1000)；筛选无匹配 17/17 降饱和、Clear 归零、按颜色筛选只命中手动设色的那 1 个；
  面板滑杆 40→70 落盘、window `pointerup` 监听基线 0 / 重建 15 次后 0 / 拖完 0（`D:/tmp/panel.mjs`）；
  SVG 无 `var(`、无 `<style>`、首元素是主题底色 rect、18 个 text 全带 font-size、17 个 path 全带 stroke；
  PNG 478KB 魔数正确；Canvas 导出 `My_Life.canvas`（测后已删）。
- **顺带修掉**：新建地图弹两条通知（`store.load()` 的 "Goalscape: created <path>" + `createGoalscape()` 的
  "Created goalscape: X"）→ 删掉后者，实测只剩 1 条。
- **用户真实数据**：`Goalscapes/life.goalscape.json` 的 4 个历史 `responsible` 键已按"读档即清 + 落盘"去掉，
  732B → 628B；逐字段比对确认**除 responsible 外与备份完全等价**（备份 `D:/tmp/bk20261008/`，含旧 main.js）。
- **CDP 自动化新坑（照做别重探）**：
  1. `Page.captureScreenshot` **带 clip 会拿到旧帧**——切主题后 clip 截图仍是暗色，整页截图才对。
  2. 切主题用 `app.changeTheme('moonstone'|'obsidian')`；`app.setTheme()` 在此版本是空操作，`app.vault.setTheme` 不存在。
  3. `app.plugins.failedPlugins` 在此版本是 undefined（`.size`/`.length` 都会抛）。
  4. 外环扇区的选中来自 pointerdown+pointerup，只发 `click` 选不中，会误判成"权重手柄没出现"。
  5. 脚本读盘要重试：`adapter.write` 先截断再写，`fs.statSync` 可能正好撞上 0 字节（实测随后就是完整 656B，
     不是数据丢失；但也说明**落盘不是原子的**，进程在写中途被杀有留空文件的风险，读侧已有"拒空文件 + 保留内存副本"兜底）。

### 新增：上栏的"呈现方式切换器"（已构建部署 + CDP 实测）
- 需求：把三种已有呈现方式的切换放进上栏，放在图文件选择器右边；随后又要求把 `.canvas` 也放进去。
- 实现：
  - `src/views/viewTypes.ts` —— 三个 `VIEW_*` 常量与 `VIEW_OPTIONS` 挪到这个中立模块。原先常量各自
    export 在视图文件里，切换器要列全三种就得 import `radialView`，而 `radialView` 又 import 切换器 →
    循环依赖，esbuild 打包后 `radialView` 还没初始化完就被读常量，拿到的是 undefined。
  - `src/views/viewSwitcher.ts` —— `createViewSwitcher(container, plugin, leaf, currentType)`，共 4 项：
    Radial map / Goal list / Gantt / Canvas (白板)。
  - **前三项走 `leaf.setViewState({type, active:true})` 在原标签页内换视图**，故意不走 `plugin.openView()`：
    后者每种视图各占一个标签，来回切几轮工作区就堆出三个 Goalscape 标签（和命令面板的"打开某视图"语义不同）。
  - Canvas 不是本插件的视图而是 vault 里的 `.canvas` 文件 → 走 `plugin.openCanvas()`，并把下拉选中项
    退回当前视图（否则选中项会停在本标签页并不存在的模式上）；白板标签页由 Obsidian 自己接管。
  - 放射图：切换器插在 `mapSelect` 之后、`New map` 之前。列表/甘特原本连顶栏都没有，各加一条
    `.goalscape-view-bar`（只放切换器，内边距与下边框对齐放射图工具栏）。
- **白板是单向导出**（回答"在白板里改了会不会回数据库"）：`toCanvas()`  scape→canvas 单向，
  `canvasToJson()` 只是 `JSON.stringify`，**没有任何反向解析**；`GoalNode` 里也没有 x/y 字段，
  位置在数据层无处可存。所以白板里改文字、挪位置、加连线都不会回到 `*.goalscape.json`。
  据此把切换器的 Canvas 项做成**文件已存在就原样打开、只在缺失时生成**，避免一点就把手工布局冲掉；
  要重算布局仍用命令面板的 "Export to .canvas"（它 `vault.modify` 整文件覆盖）。
- **白板文件名改为按图文件名派生**（`canvasPathFor()`，命令与切换器共用一处规则）：原实现用
  `scape.mainGoal.title` 清洗后当文件名，而每张新图默认根标题都是 "Main Goal" → 多张图抢同一个
  `Main_Goal.canvas`；且根标题一改（实测用户把 life 的根改成 "Main"）白板就"落"在旧文件里。
- 实测（`D:/tmp/wrap6.mjs`、`D:/tmp/wrap7.mjs`，共 18 项断言全过）：控件顺序
  `select:map → select:view → New map → +Subgoal → +Sibling → Delete`；下拉 4 项；
  前三项连切 5 轮全程恰好 1 个 Goalscape 标签、选中项始终等于当前视图、内容各自正常；
  Canvas：无文件时生成 `Goalscapes/<图名>.canvas`（4 节点 / 3 连线，与树一致）并开白板标签、原视图标签不动、
  下拉回退；手工把某节点改成 x=9999/y=-8888/文本改字后再点 Canvas → **值原样保留**（未重算）、复用同一白板标签；
  跑 "Export to .canvas" → 坐标回到 75/521、文本恢复（证明只有命令导出会覆盖）；
  两张 `.goalscape.json` 的 size+mtime 全程未变。测试生成的 canvas 已删除。
- 未做：列表/甘特的顶栏里没有图文件选择器（换图仍要去放射图或命令面板）。要补的话，把 `mapSelect` 连同
  `refreshMapList` 抽成共享组件，三个视图共用一条顶栏。
  （**本节的两处下拉已被下一节的单行工具栏整体取代**，这条"未做"里的组件抽取仍然成立，名字换成
  `.goalscape-map-btn` + `refreshMapButton`。）

### 工具栏瘦身：单行、只留切换与筛选（已构建部署 + CDP 实测）
- 需求（用户 2026-10-08）：`+ Subgoal` / `+ Sibling` / `Delete` 右键菜单里都有，`New map` 也该走
  目录栏右键（Obsidian 在那里本来就提供"新建笔记/白板"），工具栏**只做切换与筛选**、收成一行别撑宽；
  "点下拉切换"这个交互太原始。三个开放点用 AskUserQuestion 拍板：分段图标按钮 + 图文件原生菜单、
  筛选全部收进漏斗浮层、新建仍固定落 `Goalscapes/`。
- 实现：
  - `viewSwitcher.ts`：`<select>` → 一排图标按钮（`.goalscape-view-switch` / `.goalscape-view-seg`），
    当前项 `.is-active` 高亮、单击即切。切换仍走 `leaf.setViewState`（同一标签页内换视图），
    Canvas 仍走 `plugin.openCanvas()` 且**高亮段不动**（本标签页没换视图）。`viewTypes.ts` 的
    `ViewOption` 因此多了 `icon` 字段。
  - `radialView.ts`：`mapSelect` → `.goalscape-map-btn`，只显示当前图文件名（长名省略号截断，不撑宽），
    点开是 Obsidian 原生 `Menu`，当前项 `setChecked(true)`（DOM 上是 `.menu-item.mod-checked`）。
  - `focusFilter.ts`：常驻第二行 → 漏斗按钮 + 绝对定位浮层。浮层是 `.goalscape-toolbar` 的子元素，
    所以工具栏要 `position:relative` **且不能设 overflow**，否则浮层被裁。筛选生效时漏斗右上角亮小圆点。
    控件语义一个没动（Tag/Min/Max/Color/Clear 原样，**没有**借这次改版加 `Color` 文字标签——那件事仍等点头）。
    构造函数不再收 `plugin`（原本就没用到）。
  - 点浮层外关闭 + Escape：监听挂在视图的 `registerDomEvent(document, 'click', …, true)`（捕获阶段），
    随视图销毁自动解绑；不手写 `addEventListener`，避免重演信息面板那次监听泄漏。
  - 删掉 `New map` / `+ Subgoal` / `+ Sibling` / `Delete` 四按钮和 `newMap`/`addViaToolbar`/`deleteSelected`，
    `radialView` 的 `addGoal`/`deleteGoal`/`findNode`/`promptInput`/`Notice`/`confirmDeleteGoal` import 一并去掉
    （`confirmDeleteGoal` 现在只有 `radialMenu` 内部用）。
  - `main.ts`：`workspace.on('file-menu')` 里**只对 `TFolder`** 加 "New goalscape"（目录栏空白处右键拿到的
    就是根目录，所以也有）；`promptNewGoalscape` 建完 `openView(VIEW_RADIAL)` —— 入口挪到目录栏后用户
    可能正看着笔记，不打开就只剩一条 Notice 什么都没有。
  - **连带修复**：`refreshMapSelectors` 现在同时 `clearSelection()`。原 `New map` 按钮里有这句清理，
    入口搬走后必须挪到这里，否则从命令面板/目录栏新建换图后，信息面板会显示上一张图的 "Goal not found."；
    `refreshMapList()` 随之改名 `refreshMapButton()`。
- 实测（`D:/tmp/tb_a.mjs`、`D:/tmp/tb_b.mjs`）：工具栏正好 4 个子元素、高 40px、无 New map/Subgoal/Sibling/Delete
  文案、无旧 `select`/`filter-wrap` 残留；4 段图标都被解析（target=3 circle、list=6 line、calendar=4、
  layout-grid=4 rect，宽度齐 26px）；连切 5 轮全程恰好 1 个 Goalscape 标签、高亮段始终等于当前视图；
  图名菜单列出 2 张图且当前项 `mod-checked`、点选后标签与扇区同步；选中 Health 后换图 → 面板回到
  "Select a goal…"；浮层默认收起、点漏斗展开在工具栏下方（233px）、Tag 输无匹配串 → 4/4 降饱和 + 圆点亮、
  点图区关面板但筛选仍生效、再点漏斗"先开后关"没被抢关、Clear 归零且面板保持展开；
  `Goalscapes` 文件夹右键 15 项含 New goalscape、目录栏空白处右键 6 项也含；点它 → 弹窗输 `ZZ_tbtest` →
  Confirm → `Goalscapes/ZZ_tbtest.goalscape.json` 建出、自动切到放射图、标签变 `ZZ_tbtest`。暗/亮两主题截图。
- 顺手修：`main.ts` 里 `canvasPathFor`/`openCanvas` 两段中文注释被前人写成了 `\u767d\u677f` 这样的转义序列
  （在注释里就是字面乱码），已解码回可读中文。
- 现场：`ZZ_tbtest` 已删，`store.path` 与 `data.json` 回到本次开始时的 `Goalscapes/My Goalscape.goalscape.json`，
  活动标签切回 `Untitled.md`。`life.goalscape.json` 在 12:31 被**用户本人**改动（三段 importance 归一成
  45.34/39.66/15、Relationships 下新增 "New Goal"、根 color `#57cb82`）——不是测试残留，**未回滚**。

### UI 回归脚本收编：`test/ui-regression.mjs`（`npm run test:ui`，28 项 / 约 10s）
- 把散在 `D:/tmp` 的 `tb_a|tb_b|tb_c.mjs` 合并成仓库里的一份常驻脚本，`npm test` 仍只管数据层
  （UI 回归需要活着的 Obsidian + CDP，不能混进去当单测跑）。零新依赖，只用 Node 内置 `WebSocket`。
  用法：`npm run test:ui`，或 `node test/ui-regression.mjs toolbar map` 按步骤名筛。
- 三条改造要点（就是上一轮"哪一步最耗时"的答案落成的代码）：
  - **断言按结构写、不按界面文案写**：类名后缀、`svg > *` 元素个数、`input[type]` 计数、
    `/checked/.test(className)`。上一版 4 个"FAIL"全是期望写错（打勾类名是 `mod-checked`、
    lucide 图标是 circle/line/rect 不是 path、控件是 4 个不是 3 个、刚建的文件 `TFile.size` 还没就绪）。
  - **等待统一走 `waitFor` 轮询**（150ms 一次），替掉满地的 `setTimeout(…, 1400)`；整轮从"三个脚本手跑"
    压到 10s 级。`ev()` 把页面异常和 CDP 超时都**抛出去**，避免静默拿到 `undefined` 再断言成假绿。
  - **现场还原进 `finally`**：起始 `store.path`/主题/活动标签/`Goalscapes` 目录清单先快照，
    无论中途怎么失败都删临时图（`ZZ_GS_UI_REGRESSION` + 它的 `.canvas` + 它开出的白板标签页）、
    切回原图（顺带把 `data.json` 写回）、还原活动标签与主题，最后比对目录清单。
    用户自己的图只读：mtime 变了只报 INFO 不回滚（多半是本人正在应用里改）。
- **实测中澄清的一件事**：白板文件点开后的**字节数一定会变**（1231→953），但不是重导出——
  `canvasToJson()` 用 `JSON.stringify(x, null, 2)` 带缩进，而 Obsidian 的白板视图打开后会用
  自己的紧凑序列化器回写一次。所以"有没有被重算布局"必须按**节点数据**判：脚本改成
  "手工把 node[0] 挪到 x=9999/y=-8888/改名 `ZZ-MARKER` → 再点 Canvas → 断言这三个值与节点数仍在"，
  通过。之前按字节相等断言是错的断言，不是产品缺陷。
- 覆盖：工具栏单行与旧类名无残留、分段按钮图标/单击切换/同标签页不堆标签、图名按钮 + 原生菜单打勾 +
  切图 + 换图清选中、漏斗浮层开合/降饱和/圆点/Clear/点外面与 Esc 关闭、目录栏右键新建全链路、
  Canvas 段原样打开、暗亮两主题截图（落在 `node_modules/.goalscape-ui/`）。
- 前提写进文件头：Obsidian 带 `--remote-debugging-port=9333` 启动、**窗口在最前台**、
  且脚本会 disable→enable 插件一次（别在手编辑正忙时跑）。


### 放射图改成"森林"几何：importance 语义变更 + 每节点环厚（分支 `radial-forest-geometry`）
- 需求（用户 2026-10-08）：① 每圈宽度可调、三档按钮放右侧面板 Importance 右边；② 新建子层级不要
  把父级那一圈占满（只有一个子节点时也占满整圈是错的）；③ 子任务随便加、同级之间不要求首尾相接；
  ④ 接受"树与树层数不齐、层间有缺口"的样子。
- **破坏性语义变更（B 方案，用户拍板）**：`importance` 从"同级归一化权重（和恒为 100）"改成
  **"占父扇区角度的百分比"**。兄弟和 <100 → 父扇区留白；>100 → 渲染时按同一比例整体缩回
  （**只缩渲染，不改数据**，所以不丢节点、不越出父扇区）。
  - 为什么不能沿用旧语义：`adjustImportance`/`renormalizeSiblings` 保证兄弟和恒为 100，
    那样"子级占父级多少"永远是 100%，**留白在数学上不可能出现**。
  - **对用户数据的影响**：`life` 图根层是 40+35+25=100 → 根层仍然满圆；要看到留白得把数值调到 100 以下。
    认知 下的 New Goal（importance 50）现在只占认知的一半弧长，截图里已经能看出来。
  - `adjustImportance` 不再等比缩放兄弟；`renormalizeSiblings` 整个删掉，`moveGoal` 两端都不再归一化；
    `addGoal` 新节点默认给"父级剩余角度"（`min(50, 100-已用)`，下限 5），避免连点三次 Add subgoal 就 150% 全被缩回。
  - `rollup.computeProgress` 不受影响（父进度 = Σ(权重×进度)/Σ权重，本来就和"和是否为 100"无关）。
- **几何改成逐节点递推**（`radialGeometry.ts` 重写）：
  - `bandScale`（新字段，**0.3 / 0.6 / 1 / 1.3** 四档，**标准档不落字段**）→ 每个节点自己的环厚；
    标准档刻意等于旧版等宽环的厚度，所以没调过的图看起来和以前一致。
  - `radialUnit` **只跟层数挂钩**（`MAX_R / (visibleDepth+1)`），只有"照层数算会画到 MAX_R 之外"时
    才整体缩回。**踩过的坑**：第一版按"累计最厚那条链"归一 unit，结果用户改任意一个块的厚度
    就会重算 unit，父块和所有别的块跟着一起变宽窄 —— 局部调整被做成了全局缩放（用户实测报出）。
    现在回归里有一条专门盯这个：调厚度前后逐个扇区比对 `[rInner, rOuter]`，
    只允许"它自己 + 它的后代"三项变化（`n-B1,n-B2,n-Over`）。
  - `childShares(node)` 取代 `(c.importance / Σ兄弟)`；`sectorEdges(SectorShape)` 取代
    `(depth, start, end, ring)`；`hitTestSector` 改成拿点半径比对**每个扇区自己的** `[rInner, rOuter]`
    （旧的 `Math.floor(r / ringW)` 反推层级在逐节点环厚下直接失效）。
  - 标签可见性从**角度**阈值（`span > 0.14`）改成**弧长像素**阈值（`fitLabel`）：同样 0.14 弧度
    在内圈约 34px、外圈约 56px，按角度判会同时造成"内圈糊、外圈空"。放不下截断成省略号，
    弧长 <26px 干脆不画字。
  - `<title>` 全名挂到 **path** 上而不是文字上：`.goalscape-label` 是 `pointer-events:none`，
    挂在文字上永远不会触发悬停（上一版就白挂了）。现在没画字的窄格也能悬停看出是谁。
- `canvasSync.toCanvas` 改用同一套 `childShares`/`bandScaleOf` 递推半径与角度，白板布局才和图对得上；
  节点文案从"权重 X"改成"占父级 X%"。
- 面板：`Importance` 行右边四档按钮（`.goalscape-band-btn`，按钮里小横条的高度按 `BAND_STEPS` 比例算，
  不用读字也能选；改档位值不会再和按钮图形脱节），中心盘没有 Importance 行，给它独立的 `Hub size` 行。
  CSS 用 `.setting-item-control:has(.goalscape-band) .slider-container` 让滑杆让位，
  不然 320px 面板里按钮会被顶出去。
  （档位是两轮反馈定下来的：先 0.6/1/1.6 三档 → 用户说最宽那档用不上 → 1.3 → 再要四档，
  最终 **0.3/0.6/1/1.3**，标准档仍是第 3 个、也是 `bandScale` 未设时的默认。）
- 测试：数据层 78 项（+2，`adjustImportance`/`moveGoal` 的"归一化到 100"断言全部按新语义重写，
  删掉不再使用的 `assertClose`）；`test/ui-regression.mjs` 新增 **forest 步骤**（往临时图里灌一棵
  刻意不对称的合成树：厚档分支 / 薄档 5 层深链 / 兄弟和 180% 溢出 / importance 0 / 长标题窄格），
  12 项断言覆盖留白角度、逐节点环厚、层不对齐、`getBBox` 不越界、截断省略号、`<title>`、
  深链扇区命中选中、面板四档写值与回默认删字段、**调厚度只动自己和后代**。
  全套 **41 项 / 13.6s** 通过，暗亮两主题 + 森林截图。
- 未做：① 模板数值仍是"和=100"，在新语义下会铺满整圆，要不要出留白版模板待用户点头；
  ② 深图钻取（超过 4 层只展开到第 K 层）没做；③ 四档之外的"任意环厚微调"没做。

### 架构健康度复查 + 干净度清理（2026-10-08，构建/tsc/单测全过，零行为变化）
- 复查数据：`src` 里**没有超过 500 行的文件**（最大 `radialView.ts` 334、`infoPanel.ts` 332、`main.ts` 299），
  唯一的长文件是 `test/ui-regression.mjs` 593 行——回归脚本，不参与打包。
  `npm run build`（`tsc -noEmit -skipLibCheck` + esbuild production）干净，`npm test` 78/78。
  **`main.js` 与 `src` 同步**：build 之后 `git status` 对 main.js 无 diff，说明 HEAD 里的包确实是从 HEAD 的源码构建的
  （此前发现过它落后于源码，这次核对已对齐）。
- 四处小清理（都是"去掉不存在的依赖面"，不碰逻辑）：
  1. `TemplateModal` 构造参数 `app: any` → `App`。至此 `src`（排除测试）里 `as any` 与 `: any` **全为 0**。
  2. 取消 5 个"只在自己文件里用"的 `export`：`radialGeometry` 的 `PROGRESS_STOPS` / `visibleDepth` /
     `depthWeight` / `estimateTextWidth`，`radialMenu` 的 `confirmDeleteGoal`。
     判据是跨文件 grep 零命中——留着等于对外承诺了一组没人用的入口，以后改签名会被误当作公共 API。
  3. `"Goalscapes/"` 与 `".goalscape.json"` 原散在 `main.ts` 三处 + `goalTree.ts` 的默认路径里，
     抽成 `GOALSCAPE_FOLDER` / `GOALSCAPE_SUFFIX`，`DEFAULT_GOALSCAPE_PATH` 由两者拼出。
     `ensureFolder()` 本来就是从 `this.path` 反推目录、没有字面量，所以只有这一处真源。
  4. 确认三个视图各自的 `store.subscribe(() => this.render())` 不算重复——没有共同的 `onClose`/根节点结构可抽，
     为三行相同代码造基类是本末倒置。
- **构建脚本的结论：不需要新增**。现有 `dev`（watch）/ `build`（tsc + 打包）/ `tsc`（只查类型）/
  `test`（数据层）/ `test:ui`（真实 Obsidian 回归）+ 仓库根 `install-plugin.bat`（GBK+CRLF）已经覆盖
  "改→查→打包→测→部署"全链，再叠一层脚本只会多一个会过期的入口。
  两个可选项，等点头再加：`check` = `build && test`（一条命令跑完离线校验）；`deploy` = `build` 后调 bat。
  **注意 bat 只替换 vault 里的 `main.js`，正在运行的 Obsidian 不会热加载**，必须 disable/enable 插件才生效。
- 已知偏差（记录，不返工）：`tech-plan.txt` §六 骨架里的 `README.md` 没有（文档职责由本文件承担）、
  `src/export/pngSvgCsv.ts` 实际叫 `exporters.ts`；`tsconfig.json` 的 `strict` 仍是关着的（只开 `strictNullChecks`），
  真开 strict 是一轮独立的类型修正，不属于"清理"。
- `D:/tmp` 里 67 个 CDP/穷举验证脚本仍在，本文件引用了其中几个（`color2.mjs`、`drag.mjs` 等）作证据，
  既没入库也没删。

### 配色两轮改造：进度→饱和度 + 一条分支一个色相（2026-10-08，构建/tsc/单测 81 项全过，`test:ui` 未跑）
- **第一轮（用户报的错）**：旧实现"没设色才按进度挑红/橙/黄/绿四档，设了色进度就不影响"，
  于是"进度和颜色的关系"只对默认那一条色带成立。现在 `nodeColor` 一律 **饱和度 = 进度**（`SATURATION_MIN 50 → 100`），
  `PROGRESS_STOPS`、`shadeColor` 全删。代价是环层/相邻扇区的区分只能压在**明度**上（`shadeColor` 那种混白/混黑
  会连带冲掉饱和度，等于自己盖住进度信号）。纯灰配色（色相无意义）借用默认绿 142°，否则灰底的进度没处显示。
- **第二轮（用户要的统一色）**：色相**只存在二级节点**（中心盘外那一圈，`HUE_OWNER_DEPTH = 1`），
  其余层级一律沿父链解析 —— 目的是让"父改色子没改""父子色系不一致"这两种状态**在数据里根本不存在**，
  而不是靠同步代码去追。落地的三件事：
  - `types.branchColors(root)` 成为唯一的颜色真源；`radialView` / `ganttView`（原来自己抄了一份进度四档 ramp，已删）/
    `exporters.exportCsv` / `focusFilter` 四个消费方全部改读它。
  - `applyColorToSubtree` 与面板上的 "Apply to subgoals" 按钮**删掉**：往子节点复制一份色值就是把双份状态又请回来。
  - `GoalTreeStore.normalize(node, depth)` 现在带层：`depth !== 1` 直接 `delete color`，`brightness` 夹进 ±20。
    读档跑一次（迁移旧数据），**落盘前再跑一次**（`writeScape`）—— 复制粘贴这类路径会把 color 带到深层，
    留着就是"文件里有值、图上不生效"的第三种状态。
- 面板：二级节点保留色系选择（改名 `Branch color`，取色器 + 预设色块 + Auto），**其它层级那一行换成 `Brightness` 滑杆**
  （-20..+20 相对默认明度，0 即删字段；自动的环层区分仍叠加在上面）。
- **对用户数据的影响（务必知会）**：`life` 图里深层/中心盘存过的 `color` 值会在第一次读档时消失，
  那些扇区改随所属分支的色相；只保留二级节点上配过的色。
- 测试：数据层 81 项（+4 `branchColors` 继承/换父级跟随、+2 读档与落盘的字段清理，-3 `applyColorToSubtree`）；
  `test/ui-regression.mjs` 新增 **color 步骤**（8 项：分支内各层同色相、隔壁分支不受牵连、进度只改饱和度、
  面板按层级切换控件、改二级一次整支同时变、明度只压暗本节点、挪分支后跟新色相、落盘 JSON 里 color 只在二级）。
- **未跑的部分**：本轮没 `npm run build`、没部署到 vault、没跑 `npm run test:ui`（同一 worktree 有并发会话在改，
  先问再动）→ **真实 app 里现在仍是改配色之前的 `main.js`**。上面 color 步骤的期望值是按代码算的，
  第一次跑要当"可能是脚本期望写错"看待（历史上 4 个 FAIL 全是这类）。
- 已知不一致（记录，未动）：`canvasSync.progressToPreset` 仍按进度映射红/橙/黄/绿 —— JSON Canvas 只有 6 个 preset 色、
  表达不了任意色相，改成"分支色相→最近 preset"会引入量化误差，等点头再动。
- 历史条目已过时：上文 Phase 2/3 里"颜色应用到子目标 `applyColorToSubtree`"与
  "InfoPanel 颜色选择器 + Apply to subgoals 按钮"两行描述的入口已删除。

## 剩余未实测

- PNG/SVG/CSV/Markdown 的**内容**已用 Blob 捕获法实测（见上）。仍未点过一次真实的系统保存框：
  `<a download>` 在 Electron 里会弹原生对话框，自动化会把它卡住。
- ~~没有自动化测试基建（无 vitest/jest），目前"单测"是临时 esbuild 转译 + 手写断言，没留在仓库里。~~
  已补，见上节"测试基建"。没有覆盖率统计，也没有 watch 模式（刻意不引第三方框架）。
- 模板应用后信息面板显示 "Goal not found." 那一类**跨层**问题（选中态与数据替换的耦合），
  单靠数据层单测抓不到，仍需在真实 Obsidian 里点。
- ~~放射图视觉重做只在暗色主题下截过图~~ 已补：亮色主题下标签、环间隙、导出底色均已复核（见上两节）。
- ~~亮色主题下 List 视图已截图复核（正常）；Gantt 只看到空态（life 图没有日期），有排期的甘特条在亮色下的配色未验证；右侧信息面板亮色也未截图复核。~~
  已补验，见"亮色主题复核"一节。
- ~~`normalizeHex`（3 位缩写归一化）未在真实面板里跑过~~ 已补：真实面板输 `#f0a` 落盘 `#ff00aa`、扇区仍按环层
  提亮，见"收口实测"一节。
- Focus Filter 色块的**可读性改造**没做（加 `Color` 文字标签，或换成"本图已用颜色"下拉以避开严格相等的坑）——
  已把语义讲清楚给用户，等点头再做。色相收归二级节点之后，这个入口的含义变成"按分支筛"，
  而严格相等比对的是分支存的那个十六进制串，仍没实测。
- 配色两轮改造整体**未在真实 Obsidian 里点过**（见上一节"未跑的部分"）：`test:ui` 的 color 步骤是纸面期望。
- 上一节那次清理**没跑 `npm run test:ui`**（不碰真实 Obsidian）：改动只有 `export` 关键字、一处类型标注、
  常量拼接，打包后 `main.js` 只差 3 行同义字面量，`tsc` + 78 条数据层断言足以覆盖。
  若要走完整收口，补一次 `test:ui` 即可。

## 后续计划（按优先级）

1. ~~端到端交互验证~~ 已完成（见上），放射图/三视图/CRUD/拖拽/导出/模板全部实测通过。
2. ~~用户反馈的 5 个 UX 问题~~ 已完成（见上），并顺带修掉启动失败与 0 字节截断两个真实 bug。
3. ~~**等 radialView 拆分验收后**：`npm run build` → 部署 → 重跑 `color2.mjs` 与 `panel.mjs`~~ 已完成
   （见"收口实测"）：`#f0a` 落盘 `#ff00aa`、扇区仍按环层提亮、window `pointerup` 监听仍为 0，
   并顺带把拖拽/筛选/模板/导出/亮色全量回归了一遍。
4. 可选：人工点一次 PNG/SVG/CSV/Markdown 下载，确认系统保存框行为（自动化会卡住，未测）。
5. ~~补正式测试文件基建（`src/data/__tests__/`），把已有的临时断言脚本固化。~~ 已完成：`npm test`
   （esbuild + Node 内置 `node:test`，零新依赖），76 条断言入库，见上节"测试基建"。
6. ~~建议：把 `onload` 里 `await this.store.load()` 移到视图/命令注册之后~~ 已做：读档放在
   视图/命令注册之后，数据出问题只影响图的内容，不再连带让标签页退化成"插件不再活动"占位页。
7. 可选打磨：~~右键菜单加"应用颜色到子目标"入口~~（不做：色相只存二级节点，整条分支本来就跟着变）、
   Focus Filter 加"高亮匹配项列表"侧栏、Gantt 依赖关系连线、Canvas 导出支持 group 节点分层。
8. ~~可选：亮色主题下补验 Gantt 条形与信息面板配色~~ 已完成（见"亮色主题复核"），顺带修掉 Gantt 父级条形的假进度。
