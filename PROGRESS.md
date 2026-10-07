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

## 未验证 / 最大盲区

- **全程没有在真实 Obsidian 窗口里端到端点过**。所有验证 = `npm run build`（tsc + esbuild）通过 + 纯数据函数 Node 单测。
  UI 渲染、拖拽手感、信息面板交互、Gantt 布局、导出下载是否真的正常，都没有实测。这是当前最大未知项。
- 具体疑点（代码审查层面能想到但没法验证的）：
  - 权重拖拽手柄 `toLogicalPoint` 用 `getScreenCTM().inverse()`，SVG 被 CSS 缩放时 CTM 换算容易出偏差。
  - InfoPanel 滑杆 `interacting` 标记：松手后强制 `render(true)` 是否确实同步了最终值。
  - 原生 `<input type="date">` 在 Obsidian Electron 里渲染风格可能跟系统不一致。
  - Gantt 视图 `container.clientWidth` 在首次渲染时可能为 0（flex 布局未 settle）。
  - 导出 PNG 依赖 `canvas.toBlob`，Electron 里通常没问题但没实测。
  - 拖拽重挂载的 `hitTestNode` 用角度+半径反查，跨 -π/π 边界的 unwrap 逻辑需要实测确认。
- 没有自动化测试基建（无 vitest/jest），目前"单测"是临时 esbuild 转译 + 手写断言，没留在仓库里。

## 后续计划（按优先级）

1. **真实 Obsidian 端到端验证**（最大盲区）：装进 vault、打开三个视图、拖拽权重/重挂载、Focus Filter、
   信息面板编辑、Gantt 拖动、导出 PNG/SVG/CSV/Canvas、模板替换。逐个确认。
2. 根据端到端结果修复发现的 UI/交互问题。
3. 补正式测试文件基建（`src/data/__tests__/`），把已有的临时断言脚本固化。
4. 可选打磨：右键菜单加"应用颜色到子目标"入口、Focus Filter 加"高亮匹配项列表"侧栏、
   Gantt 依赖关系连线、Canvas 导出支持 group 节点分层。
