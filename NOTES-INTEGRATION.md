# Notes 融入 Obsidian：操作书

写给后续接手实施的模型/人。目标：让每个块的 notes 从"存在 JSON 里的死字符串"变成
Obsidian 网络里的一等公民 —— 面板里能渲染能点、放射图上看得见跨块连接、白板上连得出文件卡片。

三条原则贯穿全部阶段：
- **实用**：写 notes 的体验对齐 Obsidian 本体（渲染、可点链接、反链、补全）；
- **可视**：链接关系在放射图和白板上都看得见，但只在需要时出现；
- **美观**：放射图常态**零噪音** —— 不加任何角标/badge，所有链接可视化只在选中时出现，
  弦线用 `branchFills` 底色渐变 + 低透明度，克制到"不选中就完全不知道有链接"。

## 0. 已核对的代码事实（2026-10-08）

- `infoPanel.ts:163-169`：notes 是纯 `textarea`，blur 落盘，无渲染、无预览。
- `InfoPanel` 构造只收 `(container, plugin)`（`radialView.ts:73`），没有 Component；
  `MarkdownRenderer.render(app, md, el, sourcePath, component)` 需要一个生命周期宿主。
- `GoalNode`（`data/types.ts:4-24`）**没有块间链接字段**；tags 是独立数组，与 notes 内容无关。
- `canvasSync.toCanvas()`：节点 text 只有 `**标题**\n占父级 X% · 进度 Y%`，edge 只有父子树边，
  id 形如 `e-<childId>`；`exportCanvas()` 整文件覆盖（`CANVAS-WRITEBACK.md` Stage B 的合并导出**未做**）。
- **JSON Canvas 的 edge 不支持虚线样式**，只有 `color`（6 preset）和 `label` ——
  白板链接边用"有色边 + label"与树边区分。
- JSON Canvas 支持 `type: "file"` 节点（直接引用 vault 里的 md 文件）。
- `radialView.ts:33` 有 `selectedId`，`:280` 已有"仅选中时绘制"的装饰先例（权重拖拽手柄）；
  `collapsed` 是节点字段，跳选折叠分支内的节点前必须沿祖先链展开，否则跳过去看不见。
- `branchFills(root, tone)` 是底色唯一真源（弦线渐变取色用它，不用 `branchColors`）。
- `exporters.ts` 的 Markdown 大纲与 CSV 目前**完全不带 notes/links**。
- 分层守卫（`layering.test.ts`）：`data/`、`geometry/` 不得 import obsidian；纯逻辑必须放得进内层。

## 1. 设计决策（已定，不再讨论）

1. **vault 笔记链接走原生 Markdown**：用户在 notes 里写 `[[某笔记]]`、`![[嵌入]]`、`#tag`，
   面板预览用 `MarkdownRenderer` 渲染，点击、悬浮 page preview、反链全部白拿，不发明任何语法。
2. **块间链接不走 Markdown，走显式字段** `GoalNode.links?: string[]`（存目标节点 id）。
   理由：goal 不是 vault 文件，`[[标题]]` 撞名歧义无法判定；显式 id 列表可单测、可校验、
   删除节点时可清理。编辑入口是信息面板的 picker 按钮（复用 `promptModal` 模式），显示为 chips。
3. **反链必须做**：A 链了 B，选中 B 时面板显示「被 N 个目标引用」chips，点击跳选 A。
   没有反链的双链只完成了一半。数据层是全树扫 `links` 的纯函数。
4. **notes 里的 `#tag` 只读合流、不落盘**：新增纯函数 `effectiveTags(node, notes)`，
   把 notes 里的 tag 并进 `node.tags` 供 focusFilter / Canvas text 消费；`node.tags` 字段本身不动，
   避免"删了 notes 里一行字，tags 字段悄悄变了"这种不可逆写盘。
5. **链接解析是领域逻辑**：放 `src/data/notes.ts`（解析 wikilink 目标、抽 tag、取首行摘要），
   零 obsidian import，进 `npm test`。链接**是否真的存在于 vault** 由视图层拿
   `app.metadataCache` 判定，data 层不管。
6. **放射图可视化只在选中时出现**，包含三件：
   块间弦线（bezier 过图心、两端底色渐变、opacity ≈0.35）、
   vault 笔记小文件卡片（扇区外缘径向外排、点击开笔记）、tooltip 追加 notes 首行摘要。
   弦线可交互：hover 两端扇区同时高亮，点击跳选对端（**先展开对端的折叠祖先链**）。

## 2. 分阶段执行

| 阶段 | 内容 | 主轴 | 工作量 | 可独立发布 |
|---|---|---|---|---|
| 1 面板 Markdown 化 | 编辑/预览切换 + `MarkdownRenderer` + `links` 字段与 picker + 反链 chips + `data/notes.ts` | 实用 | 1d | ✅ |
| 2 放射图链接可视化 | 选中弦线（可交互）+ vault 文件卡片 + tooltip 摘要 | 可视 + 美观 | 0.75d | ✅ |
| 3 白板连接性 | 链接边（有色 + label）、file 节点、text 追加摘要与 tags | 可视 | 0.75d | ✅ |
| 4 收尾一致性 | Markdown 大纲 / CSV 带 notes 摘要与链接标题 | 实用 | 0.25d | ✅ |
| 5（可选）`[[` 补全 | textarea 监听 `[[`，浮层列 vault 文件名 + 本图节点标题 | 实用 | 0.5d | ✅ |

合计 2.75d，全收 3.25d。**顺序不可换**：2、3、4 都消费阶段 1 落下的 `links` 字段与 `data/notes.ts`。

### 阶段 1 — 信息面板 Markdown 化 + links 字段 + 反链

- `InfoPanel` 构造加第三参 `component: Component`（传 view 本身即可，`RadialGoalMapView extends ItemView`
  就是 Component）；调用点只有 `radialView.ts:73` 一处。
- notes 区双态：默认**预览**（`MarkdownRenderer.render(app, notes, el, scapePath, component)`，
  sourcePath 传当前 `.goalscape.json` 路径），点"Edit"切回 textarea，blur 落盘并回预览。
  落盘时机不变（blur），不引入自动保存。
- `GoalNode.links?: string[]`：
  - `normalize()`（`goalTree.ts`）读档时去重、剔除自链、剔除树里不存在的 id；
  - `crud.ts` 删除节点时，全树扫一遍把指向被删子树的 id 清掉；
  - 面板 "Linked goals" 区块：chips（点击 = 跳选该节点，复用 `setSelectedId`，`radialView.ts:407`，
    跳选前展开折叠祖先）+ "Add link" 按钮弹 picker（列本图全部节点标题，排除自己与已链）。
- 反链区块 "Referenced by"：`backlinks(root, id)` 纯函数（`data/notes.ts`），chips 同交互。
- `src/data/notes.ts`：`parseWikiTargets(md)`、`parseTags(md)`、`firstLine(md, max)`、`backlinks(root, id)`。
  正则要跳过代码块与 `![[`（嵌入不算链接目标）。单测进 `data/__tests__`。
- 验收：预览里 `[[笔记]]` 能点开、`#tag` 能点；links 增删落盘后重开仍在；反链双向一致；
  删除被链接的节点后死 id 消失；`npm test` 全绿。

### 阶段 2 — 放射图链接可视化（选中时）

- 选中且 `links` 非空时追加装饰层：每条链接一条三次 bezier，控制点过图心
  （两端点取各自扇区弧中点、半径取环带中值），`stroke` 用 `linearGradient`
  （两端 = 两节点 `branchFills` 底色），opacity ≈0.35、宽 2px、两端 4px 圆点。
  装饰层不挂 data-id（第五轮配色的既有规矩）。
- 弦线交互：hover 提亮该弦并高亮两端扇区；点击 = 跳选对端（先展开折叠祖先）。
- vault 文件卡片：选中节点 notes 里每个**可解析**的 wikilink（`metadataCache.getFirstLinkPathDest`
  命中）在扇区外缘径向外 24px 处排 16px 文件图标 + 文件名（截 12 字），横向错开防重叠，
  点击 `workspace.openLinkText`。未解析链接不画（避免幽灵噪音）。
- tooltip：扇区 `<title>`（`radialView.ts:236`）追加 `\n摘要`（`firstLine` 截 60 字，无则不加）。
- 验收：选中无链接节点 → 零新增元素；弦线数 = links 数；跨分支弦线两端颜色各自正确；
  点击弦线跳选且折叠分支自动展开；`test:ui` 按结构断言。

### 阶段 3 — 白板连接性

- `toCanvas()` 三处增强：
  1. 节点 text 追加 tags 行（`effectiveTags`，形如 `#a #b`）+ notes 摘要行（截 60 字）；
  2. 链接边：`{id: "x-<fromId>-<toId>", fromNode, toNode, label: "🔗", color: 按源节点进度 preset}` ——
     id 前缀 `x-` 与树边 `e-` 严格区分，**未来 `parseCanvas()` 见到 `x-` 一律忽略**
     （写进 CANVAS-WRITEBACK.md 的 Stage C 注意事项）；
  3. vault 笔记 file 节点：`{id: "f-<goalId>-<hash>", type: "file", file, ...}` + `n-` 前缀边，
     位置在源节点径向外侧 300px，多个链接横向排开。
- 生成的东西全部带确定性 id（`x-`/`f-`/`n-`），Stage B 合并导出实施时按 id 复用；
  发布说明提醒：手工改过白板的用户先别重复导出（`exportCanvas()` 仍是整覆盖）。
- `toCanvas` 需要 vault 解析结果 → 签名改成 `toCanvas(scape, resolvedLinks)`，
  解析在调用方（main.ts）做，canvasSync 保持零 obsidian import（分层守卫会抓）。
- 验收：链接边有 label、file 节点可直接点开笔记；重复导出幂等；data 层单测覆盖新分支。

### 阶段 4 — 导出一致性

- Markdown 大纲：每节标题下追加 notes 摘要行与 `→ 链接：标题A、标题B` 行（无则不加）。
- CSV：加 `Notes`（摘要）与 `Links`（链接目标标题，分号分隔）两列，沿用既有 BOM 规矩。

### 阶段 5（可选）— `[[` 自动补全

- textarea 监听 `[[` 输入，弹轻量浮层：vault 文件名（`metadataCache` 取）+ 本图节点标题两组，
  键盘上下 + Enter 插入，Esc 关闭。复用 `promptModal` 的浮层经验与"点外面关闭"的捕获阶段监听。
- 不引第三方库。若排期紧可砍，裸 textarea 不影响其余阶段。

## 3. 明确不做

- 每个 goal 拆独立 md 文件（frontmatter + Dataview）：数据模型迁移，与白板回写强耦合，
  排在 CANVAS-WRITEBACK Stage B/C 之后另立操作书。
- notes 自动保存 / 实时渲染（保持 blur 落盘）。
- 放射图常态链接角标、全图弦线常显、未解析链接的幽灵节点（违背零噪音原则）。
- Focus Filter 加"有 notes/有链接"维度（筛选器语义是"哪一家分支"，不混内容维度）。
- `[[标题]]` 模糊匹配块间链接（歧义不可判定，见决策 2）。

## 4. 测试与收尾

每阶段收尾走既有流程：`npm run check`（类型 → 打包 → 部署 → 单测 → 9333 实机回归），
新增纯逻辑进 `src/data/__tests__/notes.test.ts`，UI 断言进 `test/ui-regression.mjs`，零新依赖。
完成后按惯例更新 PROGRESS.md 并各自独立 commit。
