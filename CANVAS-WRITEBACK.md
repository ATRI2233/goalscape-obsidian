# 白板 ⇄ 数据：回写方案已砍，现在是单向镜像

给后续接手的人。这份文档的前身是"白板 → 数据回写"的执行手册（Stage A–E）。
**B/C/E 实现过、验收过，然后在真实使用中整体删掉了**；下面第 3 节写清为什么，别把它当未完成的工作再捡起来。

## 0. 一句话现状

树 → `.canvas` 单向镜像：改目标树约 800ms 后白板自己更新，卡片位置/尺寸和用户自己的便签都留住；
白板里做的任何改动都不回写数据。工具栏 Canvas 段上的橙色小点 = 这块白板欠一次更新。

## 1. 用户实际提的两条要求

1. 能实时体现改动和变化；
2. 生成新白板时，原有的排列布局不会乱。

两条都不需要"白板 → 数据"这个方向。回写方向是方案复审时我自己加的目标，实现完在真实 vault 里
一跑就三连崩（换父被吃掉、改名被吃掉、布局整个按算法重画），用户据此判定"白板明显不兼容原有项目设计"。

## 2. 已核对的代码事实（仍然成立的部分）

- `GoalNode`（`src/data/types.ts`）**没有 x/y**，位置在数据模型里无处可存 —— 这是"放射图读白板位置"根本不成立的原因。
- `canvasPathFor()` 用**图文件名**派生白板路径（不是根标题：每张新图默认根标题都叫 Main Goal，多图会撞名）。
- `store.mutate()` 是唯一写入口（改内存 → 汇总 → 落盘 → 通知）；`store.subscribe()` 给镜像用；
  store 只 watch `.goalscape.json`，**不 watch `.canvas`**（现在也不需要）。
- JSON Canvas 的 `x/y` 是**卡片中心**，不是左上角。按左上角写会把整张图往左上偏半格。
- 测试基线：`npm test`（node:test + esbuild，零第三方依赖）、`npm run check`（类型检查→打包→部署→单测→9333 实机回归）。

## 3. 为什么把回写整体删掉（三条，每条都实测过）

1. **导出必然吃掉未同步的改动。** 一旦存在反向通道，导出就得保住白板上"还没同步"的编辑；
   而导出的语义是"按树重画"。两者不可能同时成立 —— 用户改完箭头、再触发一次自动镜像，改动就没了。
2. **兄弟顺序判不出来。** 第一版按 `.canvas` 的**节点数组顺序**定兄弟次序，实测那个顺序是 Obsidian 的创建/z 序，
   不是用户意图，于是每次同步都产出一串用户从没做过的"重排"。改成按几何角度推断更危险（用户只是为美观挪位置）。
3. **一次误判就是不可恢复的丢失。** 数据层没有 undo、没有历史；`diffCanvas` 的 problems 只能拦住成环/重复，
   拦不住"把用户没做的改动写进去"。

删掉的东西：`sync-from-canvas` 命令、`CanvasSyncModal` 预览、`.bak` 备份、`diffCanvas`/`applyCanvasPlan`/
`stampAdoptedCards`/`mergeCanvas`，以及"兄弟顺序"这一整个概念。

## 4. 现在的镜像契约（`src/export/canvasSync.ts`）

```
store.subscribe → 800ms 去抖 → refreshCanvasFile(false)
  快照 = trustedSnapshot(打开着的视图 getData(), 磁盘文件)   // 内存领先磁盘几十秒，但 0 张卡不可信
  合并 = refreshCanvas(scape, 快照)                          // 派生字段跟树，位置尺寸跟白板
  写盘 = 先摘标签页 → modify/create → 读回校验，最多 3 次
```

- **认卡片靠 `gsId`**，不靠节点 id、更不靠位置；旧白板（没有 `gsId`）退化成"节点 id 就是目标 id"，照样认得出。
- 留住：`x/y/width/height`、用户自己的便签/文件卡、以及它们牵的连线。
- 跟树走：`text`、`color`、生成边 `e-<子目标>`（白板里改箭头会在下一次镜像被树纠正回来）。
- 删掉：带 `gsId` 但树里已没这个目标的鬼卡，以及指向它的线。
- 新卡片落在父卡片附近，压到任何已有卡片就沿"父→子"射线让位（实测不会压、也不会跳到画布另一头）。

三条写盘红线（都来自实测，不是洁癖）：

1. **白板文件不存在时绝不自动创建** —— 凭空往 vault 扔文件是另一种丢数据；只有点 Canvas 段或命令才建第一版。
2. **有人开着这块白板就不写** —— canvas 视图内存领先磁盘几十秒，关页时还会补写一次，硬写必然被盖。
   欠着的状态用工具栏小点表示，关掉标签页（或 `layout-change`，或每秒一次的回头看）就补上。
   Obsidian 没有公开的"这块白板干不干净"标记，所以不做"干净就写"的优化。
3. **内容一致就不碰文件** —— 插件启动也会 notify 一次，不该白白重写一次白板。

## 5. 明确不要做的事

- 不要给 `GoalNode` 加 x/y。
- 不要把白板 → 数据的回写加回来（理由见第 3 节）。要改结构就在放射图/列表里改。
- 不要从白板反推 `importance` / `brightness` / `bandScale` / `color`；`color` 是 6 档有损量化，
  且插件里 color 只属于根和二级节点，反推回来会被 `normalize()` 立刻清掉。
- 不要在镜像路径里绕过 `store.mutate()` / `store.subscribe()` 自己造一条写路径。
- 不要引入新的测试依赖。

## 6. 已验证事实（Stage A 探针，Obsidian 1.9.14，2026-10-08）

探针只动临时文件，跑完删除。这几条是镜像实现的地基，回写砍掉了它们仍然有效：

1. **自定义键原样保留**：Obsidian 把不认识的键收进节点的 `unknownData`，`canvas.getData()` 序列化时再吐回文件
   （`gsId`/`gsDepth` 都活着）。所以机器字段**不要**用 `text/type/id/color/x/y/width/height` 这些已知键命名。
2. **edge 的 id 与自定义键保留**，但 Obsidian 会**补写 `fromSide`**（按几何算）—— 解析器不能假设 edge 字段集固定。
3. **视图内存领先磁盘几十秒**：节点在内存里已经移动，文件在 4–20 秒窗口内仍是旧坐标；
   直接改 `node.x` 或 `requestSave()` 都不落盘。
4. **刚打开的 canvas 视图 `getData()` 会返回 `nodes: 0`** —— 拿它当快照等于把整份文件按算法重画，
   用户布局和他自己的便签一起没。真实事故：一次镜像后 15 张卡里 14 张回到算法位。`trustedSnapshot` 就是为这条写的。
5. **`detach()` 时视图会把内存那份补写一次** —— 顺序必须"先摘页、后写盘"，且写完读回校验、验不到就重写。
6. 可用的视图侧入口：`leaf.view.canvas` 持有 `nodes`/`edges` 两个 Map，`getData()` 出序列化结果；节点对象上没有 `updatePosition`。

## 7. 落地状态（单向镜像，2026-10-09）

- 引擎：`toCanvas` / `refreshCanvas` / `trustedSnapshot` / `parseCanvasJson` / `canvasToJson` / `generatedEdgeId`。
- 接线：`watchCanvas`（subscribe + layout-change）、`refreshCanvasFile(explicit)`、`writeCanvasDoc`（写后读回 ≤3 次）、
  `paintCanvasBadges`、`setCanvasAuto`、`openCanvas` 三态。设置页第三个开关"自动更新白板"，存进 `data.json`。
- 数字：`npm test` 126/126（canvasSync 14 条）、`npm run check` 33.3s 全绿、实机 99 项 28.9s。
  实机新增三步：`canvas 段：开着只切过去、关掉标签页才补写`、`mirror 自动镜像`、`mirror 只往一个方向走`、
  `settings 自动更新白板开关`（四段共 26 项断言）。
- **一个测试基建的坑（比功能坑更贵）**：`test/run-tests.mjs` 按"文件名扁平"拼 esbuild 产物路径，
  而 esbuild 会把入口相对 `outbase` 的目录结构搬进 outdir。结果 `node --test` 跑的是
  `node_modules/.goalscape-tests/` 下一份**永远不会被覆盖的旧产物** —— 新写的断言一条都没执行过，
  而 `npm test` 照样报全绿。已改为 `outbase: root` + 按真实路径逐个 `existsSync` 校验，跑前清空 outDir。
  教训：加完测试要先确认它**被跑到了**（改坏一行看它红不红），否则计数毫无意义。
