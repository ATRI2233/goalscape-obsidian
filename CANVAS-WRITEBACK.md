# 白板 → 数据 回写：方案复审 + 执行手册

写给后续接手实施的模型/人。目标不是"把功能写完"，而是**别把用户的目标树弄坏** ——
数据层没有 undo、没有历史，一次错误的自动回写就是不可恢复的丢失。

## 0. 一句话现状

`canvasSync.toCanvas()` 是单向导出。白板里改的位置、连线、文字，**不会**回到 `.goalscape.json`；
而 `exportCanvas()` 命令会整文件覆盖 `.canvas`，等于把用户手工摆的白板当场冲掉。
要动手，先做 Stage A 的两个未知量验证，**不要**直接开写解析器。

## 1. 已核对的代码事实（2026-10-08）

- `src/export/canvasSync.ts`：`node.id` = `goal.id`；`text` 是人读的 `**标题**\n占父级 X% · 进度 Y%`；
  `color` 只有 JSON Canvas 的 6 个 preset（按进度四档映射）；edge 为 `{id: "e-<childId>", fromNode: 父, toNode: 子}`；
  **节点上没有任何自定义字段**。`canvasToJson()` 只是 `JSON.stringify`，没有反向解析器。
- `src/main.ts:180-234`：`canvasPathFor()` 用**图文件名**派生白板路径（不是根标题，避免多图撞名）；
  `openCanvas()` 已存在就原样打开、只在缺失时生成；`exportCanvas()` 用 `vault.modify` 整覆盖。
- `GoalNode`（`src/data/types.ts:4-24`）**没有 x/y**。`color` 只属于根和二级节点，
  `normalize()`（`goalTree.ts:113-129`）会主动删掉深层节点上的 `color`。
- `store.mutate()`（`goalTree.ts:176-182`）是唯一写入口：改内存 → 汇总 → 落盘 → 通知视图。无 undo。
- `store` 只 watch `.goalscape.json`（`goalTree.ts:132-152`：300ms 去抖 + `writing` 自写标记），**完全没 watch `.canvas`**。
- `crud.moveGoal()`（`crud.ts:69`）自带环检测，返回 boolean。回写换父**必须**走它，别自己拼 `children`。
- 测试基线：`npm test`（node:test + esbuild，零第三方依赖）、`npm run check`（类型检查→打包→部署→单测→9333 实机回归）。

## 2. 对上一版"四层分级"的复审

1. **Tier 0（给 `GoalNode` 加 `canvasPos`）否决。** 位置是呈现，不是目标数据；塞进 `goalscape.json`
   之后放射图根本不读它（放射图按角度递推算坐标），唯一作用是"重导出不冲掉布局"，
   而这个目标用**合并导出**就能达到，布局留在 `.canvas` 文件里 —— 不污染数据模型，也不用做迁移。
2. **Tier 2（字段回写）建立在一个未验证假设上**：Obsidian 保存 `.canvas` 时是否保留节点上的自定义键。
   若不保留，字段只能从 `text` 里正则抠，容错成本翻倍。所以它前面必须插一个 spike。
3. **Tier 3（冲突策略）不是最后一层，而是结构回写的前置条件。** 没有环/孤儿/重复 id 的策略，
   结构回写第一次跑就可能改坏图，而数据层没法回退。
4. **上一版漏掉的最大成本项：实时 vs 手动触发。** 实时 watch `.canvas` 要处理拖拽期间的多次写盘、
   `adapter.write` 的 0 字节瞬时读（本项目已实测过）、以及 export↔import 乒乓。
   改成"手动一条命令 + 预演 diff"能砍掉近一半工作量，并消灭几乎全部数据风险。
5. **漏掉的语义空档：白板里没有 importance 这个量。** 连线只能给出父子关系与顺序，给不出权重。
   不要向用户承诺"白板能调权重"。

## 3. 修正后的分级

| 阶段 | 目标 | 工作量 | 可独立发布 |
|---|---|---|---|
| A spike | 验两个未知量：自定义键是否被保留 / `.canvas` 的写盘时机与事件 | 0.25d | 否 |
| B 合并导出 | `exportCanvas()` 不再冲掉白板：按 id 复用已有 `x/y/w/h` 与用户加的便签 | 0.5d | ✅ |
| C 结构回写（手动） | `parseCanvas()` + 同步命令：换父/顺序/改标题/新建，带预演 diff + 快照备份 | 1.5–2d | ✅ |
| D 字段回写 | 仅当 A 结论为"键会保留"：progress / due / tags | 0.5–1d | ✅ |
| E 守护硬化 | 重复 id 中止、孤儿忽略、外部改动重读、失败回滚 | 0.5–1d | 并入 C |

合计 3.5–5.5 人日。**第一个有意义的交付是 B + C ≈ 2–2.5 天**（B 让白板可用，C 让白板有意义）。

## 4. 各阶段验收标准与实现要点

### Stage A — 先做，两小时内要有结论

- 在 vault 里手工给一个 canvas 节点加 `"gsId": "xxx"`，在 Obsidian 中拖动**别的**节点、保存、关闭重开，
  看键还在不在。再试一次拖动**该节点本身**。
- 记录：拖动一个节点期间 `vault.on("modify")` 对 `.canvas` 触发几次、什么时机（每帧还是松手一次）；
  Obsidian 自己会不会往 edge 上补 `fromSide/toSide/label`、会不会把 `e-<id>` 换成它自己的随机 id；
  复制粘贴节点时新节点的 id 规则。
- 结论写进第 6 节。**A 没结论就不要开 C/D。**

### Stage B — 合并导出（低风险、立刻有用）

- 新增纯函数 `mergeCanvas(fresh: JsonCanvas, existing: JsonCanvas | null): JsonCanvas` 放 `canvasSync.ts`：
  - 节点集合以 `fresh` 为准（数据是真相）；id 命中 `existing` 的，保留 `existing` 的 `x/y/width/height` 和自定义键。
  - `text`/`color` 用 `fresh` 覆盖（它们由数据派生，白板改了也不该留住）。
  - `existing` 里 id 不在数据中的节点（用户自己加的便签/图片/分组）**原样保留** —— 别删用户的东西。
- `exportCanvas()` 改为：读现有文件 → parse → merge → write；读失败或 JSON 解析失败退化成整覆盖，并 Notice 说明原因。
- 测：`merge(toCanvas(s), toCanvas(s))` 与 `toCanvas(s)` 等价（幂等）；把 existing 的坐标挪走后合并结果保住新坐标；
  existing 里的外来节点数量不减。

### Stage C — 结构回写（核心，谨慎）

数据流严格单向、**手动触发**：

```
命令 goalscape:sync-from-canvas
  → adapter.read(.canvas)
  → parseCanvas(canvas, scape)  ⇒ 变更计划（不改数据）
  → Modal 列出 N 条变更 + problems + 风险
  → 用户确认
  → 备份当前 json 到 Goalscapes/.backup/<name>-<时间戳>.json
  → 一次 store.mutate() 应用全部变更
  → Notice 汇报（应用 x 条 / 忽略 y 条 / 备份路径）
```

- `parseCanvas(canvas, scape)` 返回计划而非直接改数据：
  `{moves: [{id, newParentId}], renames: [{id, title}], creates: [{parentId, title, index}], order: [{parentId, childIds[]}], problems: [{code, msg}]}`。
  **纯函数、不改入参**，node:test 才能全量覆盖。
- 应用规则：换父一律 `moveGoal()`（返回 false 记 problem）；顺序只重排 `children` 数组，**不动 importance**；
  新建节点走 `createGoalNode({title})` + `addGoal()`。
- **删除策略：白板里删节点不删数据**，只在报告里说"白板少了 K 个节点，已忽略"。这是底线。
- 标题来源：优先自定义键（A 通过时）；否则取 `text` 第一行剥 `**`。剥不出来记 problem，**不要猜**。
- 失败原子性：同一个 goalId 出现在两个 canvas 节点上（用户复制过节点）→ **整个同步中止**并报重复，
  不做部分应用。半应用的状态最难恢复。
- 测（新增 `src/export/__tests__/canvasSync.test.ts`）：换父成环被拒、孤儿被忽略、重复 id 中止、
  新建落到正确父与位置、畸形 `text` 不改数据、"导出→白板改→导入→再导出"两轮收敛。
- 实机（`test/ui-regression.mjs`）：脚本写一个改过的 `.canvas` → 触发命令 → 断言 `.goalscape.json` 落盘内容 →
  恢复现场（还原 json、删备份与临时白板）。老坑提醒：窗口必须前台、`adapter.write` 有 0 字节瞬时读、截图别用 clip。

### Stage D — 字段回写（有条件）

- 仅当 A 证明自定义键会保留。导出时给每个节点写机器字段（`data: {gsId, progress, due, tags}` 或扁平键，按 A 的结论选更稳的那个）；
  导入时逐字段比对，只回写白板侧**确实变了**的字段。
- **`color` 不回写**：6 个 preset 是有损量化，且插件里 color 只属于根和二级节点，
  从白板反推出来的值会被 `normalize()` 立刻清掉 —— 白做，还会让用户困惑。
- `progress` 回写要注意：父级进度由 rollup 引擎算，只有叶子能手工填（`types.ts:16`）。给父级写 progress 是无效操作，应记 problem。

### Stage E — 守护

- 同步前快照（C 已含）；`problems` 非空时默认不应用，除非用户点"忽略并继续"。
- 算计划用的 `scape` 必须是**当下重新读的**：若期间 `goalscape.json` 被外部改过（用户在别处编辑），
  重读后再算，避免用陈旧内存态覆盖。

## 5. 明确不要做的事

- 不要给 `GoalNode` 加 x/y。
- 不要做实时 watch `.canvas` 自动回写（除非用户明确要求，且 B/C 已稳定用过一段时间）。
- 不要从白板反推 `importance` / `brightness` / `bandScale` / `color`。
- 不要在回写路径里绕过 `store.mutate()`。
- 不要引入任何新的测试依赖。

## 6. 已验证事实（Stage A 的结论填这里）

- 待填：自定义键是否被 Obsidian 保留 —— 未知。
- 待填：`.canvas` 的 modify 事件频率与时机 —— 未知。
- 待填：Obsidian 对 edge 字段的补写行为 —— 未知。
