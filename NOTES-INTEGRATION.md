# Notes 融入 Obsidian：操作书

写给后续接手实施的模型/人。目标：让每个块的 notes 成为**真正的 Obsidian Markdown** ——
面板里渲染、`[[链接]]` 能跳，块与块之间有显式双向链接，放射图与白板把这两层连接画出来。

> **2026-10-09 晚翻案（用户实机反馈后拍板，优先级高于下文所有旧决策）**：
> notes 的正文不再存 JSON，**每块一个真 .md 文件、文件是唯一真相**；面板删掉 textarea，
> 只渲染预览并把撰写交给原生编辑器；**不做双向同步**。详见 §5。
> 下文 §1/§2 里"textarea 编辑"、"`#tag` 合流"、"不拆笔记文件"三条已被推翻，其余（links 字段、
> 反链、选中才可视化、白板单向镜像）仍然有效。

三条原则贯穿全部阶段：
- **实用**：撰写交给原生编辑器，阅读在面板里渲染，链接可点可跳；
- **可视**：链接关系在放射图和白板上都看得见，但只在需要时出现；
- **美观**：放射图常态**零噪音**（用户已确认）—— 不加任何角标，所有链接可视化只在选中时出现，
  弦线用 `branchFills` 底色渐变 + 低透明度。

## 0. 已核对的代码事实（2026-10-09）

- `infoPanel.ts:163-169`：notes 是纯 `textarea`，blur 落盘，无渲染、无预览。
- `InfoPanel` 构造只收 `(container, plugin)`（`radialView.ts:73`），没有 Component；
  `MarkdownRenderer.render(app, md, el, sourcePath, component)` 需要一个生命周期宿主。
- `GoalNode`（`data/types.ts:4-24`）**没有块间链接字段**。
- **白板已收口成单向自动镜像**（2026-10-09，回写整块删除）：`canvasSync.refreshCanvas(树, 快照)`
  重画派生字段（text/color/`e-<子id>` 树边）、留住已有卡片的 x/y/w/h 与用户便签及其连线、
  删掉带 `gsId` 却认不出目标的鬼卡；机器字段走 `gs` 前缀（Obsidian 实测原样保留未知键）；
  自动镜像由 `store.subscribe` + 800ms 去抖驱动，有"开着白板不写盘"等三条红线。
- JSON Canvas 的 edge **不支持虚线**，只有 `color`（6 preset）和 `label`；支持 `type: "file"` 节点。
- `radialView.ts:33` 有 `selectedId`，`:280` 已有"仅选中时绘制"的装饰先例；
  `collapsed` 是节点字段，跳选折叠分支内的节点前必须沿祖先链展开。
- `branchFills(root, tone)` 是底色唯一真源（弦线渐变取色用它，不用 `branchColors`）。
- `exporters.ts` 的 Markdown 大纲与 CSV 目前**完全不带 notes/links**。
- 分层守卫（`layering.test.ts`）：`data/`、`geometry/`、`export/` 不得 import obsidian。
- 数据层**无 undo**；测试基建有假绿前科 —— 新加的断言必须故意改坏一行验证它真的在跑。

## 1. 设计决策（已定，不再讨论）

1. ~~**notes 留在 JSON、保持 textarea 编辑**~~ → **已翻案**：正文只存 .md 文件，面板只渲染不编辑（§5）。
2. **块间链接走显式字段** `GoalNode.links?: string[]`（存目标节点 id），不走 `[[标题]]` 模糊匹配
   （goal 不是文件，撞名歧义不可判定）。编辑入口是面板 picker（复用 `promptModal` 模式），显示为 chips，
   点击 chip = 跳选该节点（先展开折叠祖先）。
   **反链必须做**：A 链了 B，选中 B 时显示「被 N 个目标引用」chips。没有反链的双链只完成了一半。
3. ~~**notes 里的 `#tag` 只读合流、不落盘**~~ → **已翻案**：`effectiveTags` 与白板卡片的 `#tags` 行一起删除。
   笔记里的 tag 归 Obsidian 自己管，插件不再做第二套 tag 语义。
4. **链接解析走 Obsidian 自己的解析器**：`NoteStore.readInfo` 用 `metadataCache.getFileCache` 的
   `links`（天然不含 `![[嵌入]]`）+ `getFirstLinkpathDest`，解析不到的幽灵链接不进图。
   `data/notes.ts` 只留纯字符串部分（首行摘要、反链扫描、links 清洗），零 obsidian import。
5. **放射图可视化只在选中时出现**：块间弦线（bezier 过图心、两端底色渐变、opacity ≈0.35、可交互）、
   vault 笔记小文件卡片（扇区外缘、点击开笔记）、tooltip 追加摘要。常态图面与今天完全一致。
6. **白板生成物全部是"树派生"，跟着镜像走**：链接边、file 节点每轮 `refreshCanvas` 重画，
   用确定性 id + `gs` 前缀机器键标记，**位置尊重用户拖动**（同 goal 卡片的 LAYOUT_KEYS 规矩），
   链接删掉后对应的 file 卡片下轮镜像自动消失（同鬼卡清理逻辑）。

## 2. 分阶段执行

| 阶段 | 内容 | 主轴 | 工作量 | 可独立发布 |
|---|---|---|---|---|
| 1 面板 Markdown 化 | 渲染/编辑切换 + `links` 字段与 picker + 反链 + `data/notes.ts` | 实用 | 1d | ✅ |
| 2 放射图链接可视化 | 选中弦线（可交互）+ vault 文件卡片 + tooltip 摘要 | 可视 + 美观 | 0.75d | ✅ |
| 3 白板连接性 | 链接边（有色 + label）+ file 节点 + 卡片 text 追加摘要与 tags | 可视 | 0.75d | ✅ |
| 4 收尾一致性 | Markdown 大纲 / CSV 带摘要与链接 | 实用 | 0.25d | ✅ |

合计约 2.75 人日。**顺序不可换**：2、3、4 都消费阶段 1 落下的 `links` 字段与 `data/notes.ts`。

### 阶段 1 — 信息面板 Markdown 化 + links 字段 + 反链

- 数据层（全部进 `npm test`）：
  - `GoalNode.links?: string[]`；`normalize()` 读档清洗：去重、剔自链、剔树里不存在的 id；
  - `crud.ts` 删除节点时清全树指向被删子树的 link id；
  - `data/notes.ts`：`parseWikiTargets(md)`、`parseTags(md)`、`firstLine(md, max)`、`backlinks(root, id)`、
    `effectiveTags(node, notes)`。正则跳过代码块；`![[` 是嵌入不算链接目标。
- `InfoPanel` 构造加第三参 `component: Component`（传 view 本身，`RadialGoalMapView extends ItemView`
  就是 Component；调用点仅 `radialView.ts:73`）。
- notes 区双态：默认渲染（`MarkdownRenderer.render(app, notes, el, scapePath, component)`，
  sourcePath 传当前 `.goalscape.json` 路径），"Edit" 切回 textarea，blur 落盘回渲染态。
- "Linked goals" chips + "Add link" picker（列本图全部节点标题，排除自己与已链）；
  "Referenced by" 反链 chips；点击 chips = 跳选（`setSelectedId`，`radialView.ts:407`，先展开折叠祖先）。
- 验收：渲染态 `[[笔记]]` 能点开、page preview 弹出、`#tag` 能点；links 增删落盘重开仍在；
  反链双向一致；删除被链接节点后死 id 消失；`npm test` 全绿（新断言按"故意改坏验证在跑"的规矩过一遍）。

### 阶段 2 — 放射图链接可视化（选中时）

- 选中且 `links` 非空时追加装饰层：每条链接一条三次 bezier，控制点过图心
  （端点取各自扇区弧中点、半径取环带中值），`linearGradient` 描边（两端 = 两节点 `branchFills` 底色），
  opacity ≈0.35、宽 2px、端点 4px 圆点。装饰层不挂 data-id（第五轮配色既有规矩）。
- 弦线交互：hover 提亮并高亮两端扇区；点击 = 跳选对端（先展开折叠祖先）。
- vault 文件卡片：选中节点 notes 里**可解析**的 wikilink（`getFirstLinkPathDest` 命中才算）
  在扇区外缘径向外 24px 排 16px 文件图标 + 文件名（截 12 字），横向错开防重叠，
  点击 `openLinkText`。未解析链接不画（无幽灵噪音）。
- tooltip：扇区 `<title>`（`radialView.ts:236`）追加 `\n摘要`（`firstLine` 截 60 字，无则不加）。
- 验收：选中无链接节点 → 零新增元素；弦线数 = links 数；跨分支弦线两端颜色正确；
  点弦线跳选且折叠分支自动展开；`test:ui` 按结构断言。

### 阶段 3 — 白板连接性（适配单向镜像）

- `buildCanvas()` 增强（跟着 `refreshCanvas` 每轮重画）：
  1. goal 卡片 text 追加 tags 行（`effectiveTags`）+ 摘要行（截 60 字）——纯派生字段，镜像本来就重画 text；
  2. 链接边：`{id: "x-<fromId>-<toId>", fromNode, toNode, label: "🔗", color: 按源节点进度 preset}`，
     进 `fresh.edges`（镜像的 pair 去重会自动处理用户手画的重复线）；
  3. vault 笔记 file 节点：`{id: "f-<goalId>-<hash>", type: "file", file, gsFile: <path>, ...}`
     + `n-<goalId>-<hash>` 边；位置在源卡片径向外侧 300px。
- **file 节点不能带 goal 的 `gsId`**（会和 goal 卡片抢认领，触发镜像的"复制卡降级"分支）。
  用 `gsFile` 机器键标记为树派生：`refreshCanvas` 加一条规则 —— 带 `gsFile` 的旧卡片，
  id 在本轮 fresh 里就保留其 LAYOUT_KEYS（用户拖过位置就尊重），不在就删（链接没了卡片跟着消失）。
  这条规则进 `canvasSync.test.ts`。
- **边的所有权看 id 前缀**（实机补上的一条）：`e-`/`x-`/`n-` 的边只认本轮结果，本轮没再生成就删。
  只按"两端卡片还在"判孤儿，删掉的链接会在白板上留一条幽灵线 —— 两端都还活着，所以它永远删不掉。
- `buildCanvas` 需要 vault 解析结果 → 签名改成收第二个参数 `resolved`（wikilink → 真实路径的 Map），
  解析在调用方（main.ts 的镜像驱动处）做，canvasSync 保持零 obsidian import（分层守卫会抓）。
- 三条镜像红线不破：文件不存在不自动创建、开着白板不写盘、内容一致不碰文件。
- 验收：链接边有 label；file 节点点开即笔记；拖动 file 卡片后再镜像位置不回弹；
  删掉链接后下轮镜像 file 卡片消失；重复镜像幂等；`npm test` + 实机镜像四段全绿。

### 阶段 4 — 导出一致性

- Markdown 大纲：每节标题下追加摘要行与 `→ 链接：标题A、标题B`（无则不加）。
- CSV：加 `Notes`（摘要）与 `Links`（分号分隔标题）两列，沿用既有 BOM 规矩。

## 3. 明确不做

- ~~**每块挂独立笔记文件 / 原生编辑器撰写**~~ → **已翻案**：这正是现在的产品形状（§5）。
  仍然不做的是 `[[` 补全与面板内编辑——撰写只走原生编辑器。
- **双向同步**（面板可写 + 文件可写）：两份可写副本必然打架，而数据层没有 undo。文件是唯一真相。
- frontmatter 化目标属性供 Dataview 查询：与白板回写同级别的深水区，回写已删，此项一并搁置。
- 放射图常态角标、全图弦线常显、未解析链接幽灵节点（零噪音原则）。
- Focus Filter 加"有 notes/有链接"维度（筛选器语义是"哪一家分支"）。
- `[[标题]]` 模糊匹配块间链接（歧义不可判定，见决策 2）。
- Custom fields：只写不读的死洞，2026-10-09 晚连面板入口与 `fields` 字段一起删除。

## 4. 测试与收尾

每阶段收尾走既有流程：`npm run check`（类型 → 打包 → 部署 → 单测 → 9333 实机回归），
纯逻辑进 `src/data/__tests__/`（notes / noteFiles），白板规则进 `canvasSync.test.ts`，
UI 断言进 `test/ui-regression.mjs`（"按钮点得动吗"必须走 `realClick` 真鼠标），零新依赖。
完成后按惯例更新 PROGRESS.md 并各自独立 commit。

## 5. 翻案后的产品形状（2026-10-09 晚已发布）

- **存储**：`GoalNode.note?: string` 存笔记文件路径；旧字段 `notes?: string` 标 deprecated，
  只在一次性迁移里读。文件放在图文件同级的 `<图名>.notes/`，开头 frontmatter 记 `gsId: <块id>`。
- **唯一写文件的两处**：面板上点 "New note"；迁移旧 `notes`。红线是**绝不替用户建笔记文件**——
  没写过笔记的块在 vault 里一个 .md 都不多。用户在 Obsidian 里删掉笔记 = 这块没有笔记，不追着重建。
- **改名/挪走自愈**：`rebuild()` 发现路径失效就按 frontmatter 的 `gsId` 全库扫一遍，找到后把新路径写回树并落盘。
- **面板**：`MarkdownRenderer` 渲染预览（限高滚动、无框），右侧一个胶囊按钮 "Open note" / "New note"
  把撰写交给原生编辑器。没有 textarea、没有 Edit/Done 双态。
- **索引**：`NoteStore` 把文件系统压成纯数据 `NoteIndex = Map<goalId, {path, text, links}>`，
  视图与导出层同步读它；`watch()` 盯 vault 的 modify/create/delete/rename **加** metadataCache 的 changed
  （后者不受自写屏蔽：刚写完的文件缓存还没解析完，那一轮读到的 links 是空的）。
- **下游**：放射图 tooltip 摘要与扇区文件卡片、白板卡片摘要行与 file 节点、Markdown 大纲的
  `[[路径|摘要]]` 行、CSV 的 Notes/NoteFile/Links 三列，全部吃 `NoteIndex`。
- 白板卡片**不再有 `#tags` 行**：标题 + 两行数值 + 一行摘要，摘要取笔记第一行。
