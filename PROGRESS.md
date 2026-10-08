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

## 剩余未实测

- PNG/SVG/CSV/Markdown 导出走浏览器下载（`<a download>`），Electron 里会弹系统保存框，为避免卡住 Obsidian 未自动触发；
  CSV/Markdown 文本生成逻辑可用 Node 单测覆盖，端到端下载动作留待人工点一次确认。
- 没有自动化测试基建（无 vitest/jest），目前"单测"是临时 esbuild 转译 + 手写断言，没留在仓库里。

## 后续计划（按优先级）

1. ~~端到端交互验证~~ 已完成（见上），放射图/三视图/CRUD/拖拽/导出/模板全部实测通过。
2. 可选：人工点一次 PNG/SVG/CSV/Markdown 下载，确认系统保存框行为（自动化会卡住，未测）。
3. 补正式测试文件基建（`src/data/__tests__/`），把已有的临时断言脚本固化。
4. 可选打磨：右键菜单加"应用颜色到子目标"入口、Focus Filter 加"高亮匹配项列表"侧栏、
   Gantt 依赖关系连线、Canvas 导出支持 group 节点分层。
