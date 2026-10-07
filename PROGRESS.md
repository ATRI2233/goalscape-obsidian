# Goalscape Obsidian 插件 — 开发纪要（持续更新）

> 给后来者 agent 的话：请对以下"已完成"的内容保持审视态度——用之前先读代码、能验证就验证（单测/构建/实际点一遍），
> 不要默认它是对的。但不要吹毛求疵：对已验证正确、只是写法不够优雅的代码不必返工；只在发现真实的正确性/
> 可用性问题，或与 tech-plan.txt 验收标准冲突时才动手改。每次做分析/发现问题/定计划，都更新本文件，不要只放在对话里。

## 已完成并验证

- Phase 1 数据层：`types.ts` / `rollup.ts`（进度自动汇总，已用 Node 单测验证权重加权平均正确）。
- Phase 1 放射图渲染：权重→扇区角度、进度→颜色、折叠展开、JSON 文件外部编辑自动刷新。
- Phase 2：右键菜单 CRUD（增/删/重命名/设进度）、剪切/复制/粘贴、信息面板（Title/Importance/
  Progress/Due/Start/Responsible/Tags/Color/Notes/自定义字段，`src/views/infoPanel.ts`）、
  权重拖拽手柄（选中扇区外沿圆点，拖动调用 `adjustImportance`，`radialView.ts` 的
  `startWeightDrag`/`onWeightDragMove`）、颜色应用到子目标（`applyColorToSubtree`，接在面板按钮上）。
- 已修复并用单测复现验证的 3 个真实 bug + 1 个风险项（详见 git log commit `bfe75b1` 的描述）：
  1. `extractSubtree` 原来返回活引用而非深拷贝 → Copy 后编辑原节点会污染剪贴板。已改为 `cloneSubtree`。
  2. 中心扇区（root，跨度恰好 2π）绘制依赖浮点误差让起止点"恰好不完全重合"，SVG spec 对完全重合的弧是未定义/退化行为。已改为显式 `FULL_CIRCLE_EPSILON` 钳制跨度，不再依赖运气。
  3. `moveGoal`（拖拽重挂载用，还没接 UI）移动节点后不会重新归一化两端父级权重，导致"总和=100"假设在之后的权重滑杆上失真。已加 `renormalizeSiblings`。
  4.（风险项，未在真实 Obsidian 复现，只是代码审查认为有竞态风险）首次建档用 `adapter.write` 直写、随后立刻 `getAbstractFileByPath` 可能因 Vault 索引异步而拿到 null。已改为首次用 `vault.create()`。

## 正在做 / 下一步

- Phase 2 的信息面板 + 权重拖拽手柄已经接入并通过 `npm run build`，**但还没在真实 Obsidian 里点过一次**，
  下面这几点是代码审查时能想到、但没法在当前环境验证的疑点，交给下一个接手的人或者有真实 vault 的时候优先确认：
  - 权重拖拽手柄的角度→坐标换算（`toLogicalPoint` 用 `getScreenCTM().inverse()`）在 Obsidian 的 Electron
    渲染环境里是否跟预期一致；SVG 被 CSS `width:100%;height:100%` 缩放时 CTM 换算容易出偏差。
  - InfoPanel 滑杆拖拽期间屏蔽 `refresh()` 的逻辑（`interacting` 标记）要确认松手后那次强制 `render(true)`
    确实把最终值同步上了，没有漏拍。
  - 日期输入用的是原生 `<input type="date">`，在 Obsidian 不同平台（Windows/macOS/移动端）渲染风格可能不一致，
    目前没有做任何平台适配。
- 右键菜单里还没加"应用颜色到子目标"的入口（目前只有信息面板按钮能触发），非必须，可选补齐。
- Focus Filter、Goal List 视图、Gantt、导出 PNG/SVG/CSV、模板库 —— 均未开始（对应 tech-plan.txt 的 Phase 3/4/5）。
- `moveGoal`（拖拽重挂载）函数本身已经写好并修过权重归一化 bug，但完全没有 UI 入口（Phase 3 的"拖拽重挂载"验收项目前不可达）。
- 没有做任何自动化测试基建（没有 vitest/jest），目前的"单测"是临时用 esbuild 在 Node 里转译 + 手写断言脚本跑的，
  没有留在仓库里成为可重复运行的测试文件。如果后续要长期维护，值得补一套真正的测试文件（可以放 `src/data/__tests__/`），
  而不是每次临时写。

## 未验证 / 最大盲区

- **全程没有在真实 Obsidian 窗口里打开过这个插件**。所有验证都是：`npm run build`（tsc + esbuild）通过 + 对纯数据函数
  （`rollup.ts`/`crud.ts`）用 Node 做隔离单测。UI 渲染、拖拽手感、信息面板交互是否真的符合预期，都没有端到端验证过，
  这是当前最大的未知项，优先级高于继续堆新功能。

## 后续计划（按顺序）

1. 找机会做一次真实 Obsidian 端到端验证（当前最大盲区），重点看权重拖拽手柄和信息面板滑杆的手感。
2. 根据端到端验证结果，判断"正在做 / 下一步"里列的几个疑点是否要改。
3. 评估是否要补正式的测试文件基建，而不是一次性脚本。
4. 再往后才是 Phase 3（拖拽重挂载 UI、Focus Filter、颜色主题）。
