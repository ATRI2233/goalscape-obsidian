# Goalscape Obsidian 插件 — 开发纪要（持续更新）

> 给后来者 agent 的话：请对以下"已完成"的内容保持审视态度——用之前先读代码、能验证就验证（单测/构建/实际点一遍），
> 不要默认它是对的。但不要吹毛求疵：对已验证正确、只是写法不够优雅的代码不必返工；只在发现真实的正确性/
> 可用性问题，或与 tech-plan.txt 验收标准冲突时才动手改。每次做分析/发现问题/定计划，都更新本文件，不要只放在对话里。

## 已完成并验证

- Phase 1 数据层：`types.ts` / `rollup.ts`（进度自动汇总，已用 Node 单测验证权重加权平均正确）。
- Phase 1 放射图渲染：权重→扇区角度、进度→颜色、折叠展开、JSON 文件外部编辑自动刷新。
- Phase 2 一部分：右键菜单 CRUD（增/删/重命名/设进度）、剪切/复制/粘贴、权重调整函数 `adjustImportance`。
- 已修复并用单测复现验证的 3 个真实 bug（详见 git log，commit message 有描述）：
  1. `extractSubtree` 原来返回活引用而非深拷贝 → Copy 后编辑原节点会污染剪贴板。已改为 `cloneSubtree`。
  2. 中心扇区（root，跨度恰好 2π）绘制依赖浮点误差让起止点"恰好不完全重合"，SVG spec 对完全重合的弧是未定义/退化行为。已改为显式 `FULL_CIRCLE_EPSILON` 钳制跨度，不再依赖运气。
  3. `moveGoal`（拖拽重挂载用，还没接 UI）移动节点后不会重新归一化两端父级权重，导致"总和=100"假设在之后的权重滑杆上失真。已加 `renormalizeSiblings`。
  4.（风险项，未在真实 Obsidian 复现，只是代码审查认为有竞态风险）首次建档用 `adapter.write` 直写、随后立刻 `getAbstractFileByPath` 可能因 Vault 索引异步而拿到 null。已改为首次用 `vault.create()`。

## 正在做（Phase 2 收尾）

- `src/views/infoPanel.ts`：已写好右侧信息面板（Title/Importance/Progress/Due/Start/Responsible/Tags/Color/Notes/自定义字段），改动统一走 `store.mutate`。
  - 还没接入 `radialView.ts`：需要把 `goalscape-radial-root` 拆成「svg 区 + 面板区」布局，选中节点时调用 `InfoPanel.show(id)`，store 变更时调用 `InfoPanel.refresh()`。
  - 面板里滑杆拖拽期间会屏蔽外部 `refresh()`，避免控件被重建打断拖拽——这个设计点要留意，别在后续改造时误删。
- 权重拖拽手柄（在扇区外沿直接拖动调权重）：**还没做**。plan 里描述为"扇区外沿拖动手柄"，当前只有信息面板里的滑杆可调权重，没有图上直接拖拽的交互。
- 颜色应用到子目标：数据层函数 `applyColorToSubtree` 已写，已接入 InfoPanel 按钮；右键菜单里暂未加入口（可选，不是必须）。

## 未验证 / 风险 / 已知局限

- **全程没有在真实 Obsidian 窗口里打开过这个插件**。所有验证都是：`npm run build`（tsc + esbuild）通过 + 对纯数据函数（`rollup.ts`/`crud.ts`）用 Node 做隔离单测。UI 渲染是否真的符合预期、交互是否顺畸，都没有端到端验证过，这是当前最大的未知项。建议后续找机会往一个真实 vault 装一次、手动点一遍 Phase 1/2 的验收项。
- `moveGoal`（拖拽重挂载）函数本身已经写好并修过权重归一化 bug，但完全没有 UI 入口（Phase 3 的"拖拽重挂载"验收项目前不可达）。
- Focus Filter、Goal List 视图、Gantt、导出 PNG/SVG/CSV、模板库 —— 均未开始（对应 tech-plan.txt 的 Phase 3/4/5）。
- 没有做任何自动化测试基建（没有 vitest/jest），目前的"单测"是我临时用 esbuild 在 Node 里转译 + 手写断言脚本跑的，没有留在仓库里成为可重复运行的测试文件。如果后续要长期维护，值得补一套真正的测试文件（可以放 `src/data/__tests__/`），而不是每次临时写。

## 下一步计划（按顺序）

1. 把 `InfoPanel` 接入 `radialView.ts`（布局拆分 + 选中联动 + 样式）。
2. 权重拖拽手柄：在选中节点的扇区外沿加一个可拖动的把手，拖动时实时调用 `adjustImportance`。
3. `npm run build` 校验通过后 commit。
4. 找机会做一次真实 Obsidian 端到端验证（当前最大盲区）。
5. 之后再评估是否要补正式的测试文件基建，而不是一次性脚本。
