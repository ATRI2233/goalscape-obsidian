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

## 剩余未实测

- PNG/SVG/CSV/Markdown 导出走浏览器下载（`<a download>`），Electron 里会弹系统保存框，为避免卡住 Obsidian 未自动触发；
  CSV/Markdown 文本生成逻辑可用 Node 单测覆盖，端到端下载动作留待人工点一次确认。
- 没有自动化测试基建（无 vitest/jest），目前"单测"是临时 esbuild 转译 + 手写断言，没留在仓库里。
- 放射图视觉重做只在暗色主题下截过图；亮色主题下 hub 的 `-22%` 压暗与标签黑色描边效果未复核。

## 后续计划（按优先级）

1. ~~端到端交互验证~~ 已完成（见上），放射图/三视图/CRUD/拖拽/导出/模板全部实测通过。
2. ~~用户反馈的 5 个 UX 问题~~ 已完成（见上），并顺带修掉启动失败与 0 字节截断两个真实 bug。
3. 可选：人工点一次 PNG/SVG/CSV/Markdown 下载，确认系统保存框行为（自动化会卡住，未测）。
4. 补正式测试文件基建（`src/data/__tests__/`），把已有的临时断言脚本固化。
5. 建议：把 `onload` 里 `await this.store.load()` 移到视图/命令注册之后，让数据加载失败只降级为 Notice
   （当前靠 `ensureFolder` 的 try/catch 堵住了已知的那条抛错路径，但顺序本身仍是单点故障）。
6. 可选打磨：右键菜单加"应用颜色到子目标"入口、Focus Filter 加"高亮匹配项列表"侧栏、
   Gantt 依赖关系连线、Canvas 导出支持 group 节点分层。
