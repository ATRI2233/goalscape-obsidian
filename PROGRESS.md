# Goalscape Obsidian 插件 — 开发纪要（持续更新）

> 给后来者 agent 的话：请对以下"已完成"的内容保持审视态度——用之前先读代码、能验证就验证（单测/构建/实际点一遍），
> 不要默认它是对的。但不要吹毛求疵：对已验证正确、只是写法不够优雅的代码不必返工；只在发现真实的正确性/
> 可用性问题，或与 tech-plan.txt 验收标准冲突时才动手改。每次做分析/发现问题/定计划，都更新本文件，不要只放在对话里。
>
> 2026-10-08：下面每条任务记录已压缩到 100 字以内（只留结论与踩过的坑，实现细节回代码里读）。
## 已完成并验证（构建通过 + 数据层单测通过）

### Phase 1 — 数据层 + 放射图只读渲染 + Collapse/Expand
`rollup` 按权重加权汇总进度；`radialView` 权重→角度、进度→颜色、折叠、外部编辑自动刷新。修 3 个真 bug：剪贴板要深拷贝、整圆角度退化要钳制、跨父级移动两端要归一化。

### Phase 2 — CRUD + 信息面板 + 权重拖拽 + 进度汇总
右键菜单增删改重命名 + 剪贴板；`infoPanel` 全字段编辑；选中扇区外沿圆点拖 `adjustImportance`。`applyColorToSubtree` 后来被删（见"配色两轮"）。

### Phase 3 — 拖拽重挂载 + Focus Filter + 颜色主题
pointer 把扇区拖到新父级（ghost 标签 + drop-target 高亮，`moveGoal` 含环检测）；`focusFilter` 按 Tag/进度区间/颜色过滤，非匹配项 grayscale 降饱和。

### Phase 4 — Goal List 视图 + Canvas 同步导出
`listView` 缩进树、折叠、叶子勾选、双击 inline 改标题；`canvasSync.toCanvas` 单向转 JSON Canvas（放射布局、进度→6 个 preset 色、父→子 edge）。

### Phase 5 — Gantt 视图 + 导出 PNG/SVG/CSV + 模板库
`ganttView` 月刻度 + 按 start/due 定位条形 + 拖手柄改叶子进度；`exporters` 出 PNG/SVG/CSV/Markdown 大纲；`templates` 四套预置模板。

### 注册与命令（main.ts）
三个视图各带独立打开命令，另有五条导出命令、应用模板命令，Ribbon 图标打开放射图。

### 真实 Obsidian 端到端验证（已打通通道）
Obsidian 带 9333 远程调试端口跑 CDP + 截图实测。两个必踩的坑：`Runtime.evaluate` 要 `awaitPromise`，换 main.js 后必须 disable/enable 插件才热加载。

### 端到端交互实测
在真实 app 里点遍选中、右键、新建子目标、两条滑杆、进度汇总、筛选、权重拖拽、重挂载、三视图、导出、模板，全过。

### 用户实测反馈的 5 个 UX 问题
缺新建图入口、根扇区接缝黑线、缺增同级/子级按钮、右侧栏横向挤压、整图丑。接缝改用两个半圆弧拼；后三条又被"工具栏瘦身"推翻。

### 放射图视觉重做
环间隙按**弧长**而非固定角度算（否则外环裂缝越宽），描边 1.5→1；中心盘压暗、外环逐层提亮；标签 14px + `paint-order: stroke` 描边光晕。`getBBox` 双重量过不溢出。

### 真实 bug：插件启动即失败（已修）
`onload` 里 `await store.load()` 排在 `registerView` 之前，启动早期索引未就绪 → `createFolder` 抛"已存在" → 插件不活动。教训：注册视图之前的 await 都是单点故障。

### 真实 bug：切图把文件截断成 0 字节（已修）
统一 `writeScape()` 双空值拦截、读写全走 `vault.adapter` 绕开索引竞态、拒解析空文件、`switchTo` 清挂起 reload，推翻 Phase 1 的 `vault.create`。

### CDP 实测重要坑：后台窗口的 renderer 会被冻结
不可见窗口的 renderer 被 Chromium 挂起，任何 CDP 命令都不回。判据：进程 4 秒 CPU 增量为 0 就不是忙循环。自动化前必须置顶且全程不失焦。

### 真实 bug：拖拽完全不跟手（已修）
`render()` 用 `rootEl.empty()` 重建 svg，拖拽捕获的节点当场变游离，`getScreenCTM()` 返回 null 被兜底成恒定角度。改成每次 move 重新查 svg。

### 真实缺陷：导出的 SVG/PNG 丢样式、底色写死（已修）
序列化前用 `inlineComputedStyles()` 把计算值内联；底色从 svg 往上找第一个真正被绘制的背景（主题变量挂在 body 上），否则独立 SVG 退回黑字 16px、白底查看器里白字直接消失。

### 真实缺陷：标签固定白字，外环对比度最低 1.3:1（已修）
穷举 4 进度色 × 5 层 × 3 同级 = 60 组合，54 种对白字低于 3:1。`labelInk()` 按 WCAG 相对亮度在白/深字里取高者、光晕反色、用内联 style 上色（类规则会盖掉同名属性）。最差 4.37:1。

### 真实缺陷：CSV 无 BOM、Markdown 静默丢子树（已修）
CSV 补 BOM 否则 Excel 按本地代码页解 UTF-8 全乱码；Markdown 不再按 `collapsed` 跳过递归——折叠只是视图状态。坑：Edit 会吃掉字面 BOM。

### 数据安全隐患：删除整棵子树零确认（已修）
只在**有后代**时弹确认（叶子删除不制造摩擦），文案带子目标数。坑：`Modal.close()` 会同步触发 `onClose()`，先 close 再回调等于把 Promise 定成取消，确认静默失效。

### 真实 bug：Gantt 拖父级条形留下"假进度"（已修）
父级进度是汇总值不能手填，`up` 里既不落盘也不重绘，条形就停在假位置、下次 render 才弹回。修法：父级分支在 `up` 里显式 `render()` 回弹。断言别拿 render 前的游离元素。

### 亮色主题复核
放射图/List/Gantt/面板亮色全部截图正常。坑：脚本反复 `getLeaf(false)` 会堆出空的重复标签页，"面板没刷新"其实是选中了那个空 leaf。

### 真实 bug：信息面板每次重建泄漏一个 window 监听（已修）
`trackInteraction` 原先每 render 无条件常驻一个 `window pointerup`，越积越多 → 点任何地方都重建面板（滚动弹顶、丢焦点）。改成 `pointerdown` 里挂、`end` 里先拆再重绘。

### 真实缺陷：Color 字段不校验，非法色值让扇区"看不见"（已修）
非法值会原样进 `fill` 退回默认渲染。`normalizeHex()` 只收 3/6 位并统一归一成 `#rrggbb` 再落盘，非法则 Notice + 回滚成真实色、不进 store；等价输入不落盘避免全量重绘。

### 数据层复核：`goalTree.ts` 无需改动
逐条读过：双空值拦截、拒空文件、adapter 按路径读写绕竞态、`writing` 标记 500ms 释放、`switchTo` 清挂起 reload 都对。唯一瑕疵是解析失败的 Notice 措辞，不改行为。

### 测试基建（`src/data/__tests__/`，已入库）
零新依赖：`npm test` 用现成 esbuild 打包交给 Node 内置 `node:test`；`fake-vault` 刻意复刻真实坑而不是绕开。断言逐个变异抽查过不是摆设。只覆盖数据层。

### 用户反馈：删掉 Responsible、右侧 Color 加色盘
Responsible 全链路删除，`normalize` 读档即 `delete` 旧键让历史 JSON 自然收敛。右侧 Color 加取色器（只监听 `change`）+ 10 预设块 + Auto。

### 收口实测（构建 + 部署 + 真实 Obsidian CDP 全量回归）
色盘、对比度穷举 150 组合、radialView 拆分、导出、监听数、模板、亮暗两主题一次跑完。用户 `life` 图只少了四个 responsible 历史键。CDP 新坑五条已并入记忆。

### 新增：上栏的"呈现方式切换器"
`VIEW_*` 常量挪进 `viewTypes.ts` 破循环依赖；前三项走 `leaf.setViewState` 同标签页换视图，Canvas 走 `openCanvas()` 且高亮不动。白板是单向导出，已存在就原样打开。

### 工具栏瘦身：单行、只留切换与筛选
`+Subgoal/+Sibling/Delete/New map` 全撤出（右键与目录栏 `file-menu` 已有），工具栏收成一行：图标分段按钮 + 图名原生菜单 + 漏斗浮层。点外面/Esc 用捕获阶段监听。

### UI 回归脚本收编：`test/ui-regression.mjs`（`npm run test:ui`）
把散在 `D:/tmp` 的探针合成仓库里常驻的一份。三条要点：断言按结构不按界面文案、等待统一 `waitFor`、现场还原进 `finally`。判"有没有重算布局"要看节点数据不看字节。

### 放射图改成"森林"几何（分支 `radial-forest-geometry`）
语义破坏性变更：`importance` 改成占父扇区的绝对百分比，兄弟和 <100 留白、>100 只缩渲染。`bandScale` 四档逐节点环厚，`radialUnit` 只跟层数挂钩（否则调一块全图变宽窄）。

### 架构健康度复查 + 干净度清理
`src` 无超 500 行文件、`main.js` 与 HEAD 源码同步。清掉 5 个无人用的 `export`、`any` 归零、路径常量抽真源。结论：现有脚本已覆盖改查打包测部署，不需要新增。

### 配色两轮改造：进度→饱和度 + 一条分支一个色相
第一轮把进度压进饱和度（**已被第三轮推翻**）；第二轮色相只存中心盘与二级节点，`branchColors` 成唯一真源，深层 `color` 读档与落盘各清一次——"父改色子没改"在数据里根本不存在。

### 配色第三轮：进度退出饱和度、改画外缘细条 + 整组光影
"丑"的根因不是配色，是上轮把五支选色的饱和度全提纯成 S50、明度又只差 +3/层。现在饱和度还给选色；进度改画外缘 dash 弧、不画轨道；整组一份投影 + 全图坐标系的光源渐变。不引玻璃拟态。

### 配色第四轮：浓淡也收归系统（`src/data/palette.ts`）
第三轮只还了饱和度，实测仍丑——因为**协调的类别色是"色相变、浓淡锁死"，而当时三个通道一起乱变**（五支色 S28~71、L60~75，且中心盘与一支分支同色相）。于是新建 `branchFills(root)` 作为最终底色的唯一真源：色相仍沿父链继承自 `branchColors`，但明度按层分配（中心盘最深、往外逐层提亮）、饱和度取"该色相在该明度下上限"的固定比例。必须用 **OKLCH**：HSL 的明度不是感知量，按 HSL 统一浓淡统一不了，黄色会被压成橄榄绿。附带三件事——两支撞色相时后入场的被推开 14°、灰（C<0.02）保持中性、`(siblingIndex%3)*2` 的无编码抖动删除。面板预设色盘由同一套数学生成，所以"色块上看到的"就是"图上会有的"（幂等，有单测锁）。消费方统一到 `branchFills`：放射图、甘特条、CSV 的 Color 列；`focusFilter` 仍读 `branchColors`，因为筛的是"哪一家"而不是"哪个像素"。光源渐变从全图坐标系改成 `objectBoundingBox`，即每个块自己一束（全图那一版压在同浓淡扇区上看不出来）。不变量单测 9 项（`palette.test.ts`，共 90 项），`test:ui` 54 项；color 步骤的断言从"对账具体色相数字"改成**关系断言**（同层同色、逐层变亮、跨分支不同色），基调再调也不用改断言。踩到的两个坑：跨色相比亮度量的不是层级（色相自带明度校正，绿色盘会比蓝色支亮）；同一 OKLCH 色相折算回 HSL 会随浓淡漂十几度，容差得放到 20。多窗口下 CDP 会把别的 vault 排在第一个 target，回归脚本现在按"有没有 Goalscapes 目录"甄别窗口。

### 配色第五轮：基调开放给用户 + 块内明暗与倒角（设置页两根滑杆）
用户反馈两条：① 有时嫌太艳、② "还是大色块通铺，没有质感"（投影和光源都看不见）。
- **基调不再写死**：`palette.ts` 的浓淡两个尺度提成 `Tone {chroma, step}`，`branchFills(root, tone)` / `paletteSwatches(tone)` 都收参数；
  新建 `src/settingsTab.ts` 放两根滑杆（`Colour intensity` 柔和↔浓艳、`Level contrast` 层次平缓↔分明），拖动即时存盘 + 重画。
  默认值 `DEFAULT_SLIDERS` 与 `DEFAULT_TONE` 同源（单测卡住具体数字，谁动默认值都会被抓）。
  `data.json` 收成一个写入方 `persistData()` —— 原先 `switchGoalscape` 直接 `saveData({currentPath})`，会把新加的 `tone` 顶掉。
  重画走新加的 `view.repaint()`，**不走 `store.mutate`**：那会把数据标成已修改并落盘，而这里什么都没改。
- **"每个块自己有明暗"才是解药**：之前那版光源是叠在扇区上的一层极淡白/黑，压在同浓淡的色上根本看不出。
  现在改成**逐扇区一个 `radialGradient`**，圆心在图心、半径取本块外径、深色那一端停在**本块内径**上 ——
  于是厚块薄块都是"整块走完这一档明度跨度"（`SECTOR_RAMP 0.1`，各偏一半），而不是薄块只蹭到全图渐变的一小条。
  代价是 `fill` 变成 `url(#…)`，所以扇区上另存 `data-color` 记录那个扁平中间色（调试和断言都要用）。
  `shadeOf(hex, ±dL)` 保证深浅两端只动明度、色相与主导通道都不翻（有单测锁）。
- **外缘倒角**：`bevelArc()` 贴着 rOuter 走一道 1.2px 的边，暗底用亮边、`.theme-light` 换成暗边。
- **投影要有落点**：黑色投影落在近黑的 `--background-primary` 上等于没画，所以给 `.goalscape-radial-root` 垫了一圈比页面亮的径向"台面"，投影同时加强到 `0 14px 30px / .5`。
- 旧的 `.goalscape-sheen` 叠层删除（被块内渐变取代），进度条与倒角都靠 DOM 顺序归属最近的 `data-id` 扇区，不给装饰层再挂 id。
- 测试：数据层 96 项（+6：`shadeOf` 两条、两根滑杆各一条、色盘跟随滑杆、出厂默认）；`test:ui` 58 项（+4：块内渐变必须内深外浅且中间值等于 `data-color`、倒角计数、台面 + 投影、设置页两根滑杆的全链路）。
  踩到的坑：设置模态框会把**之前看过的标签页**留在 DOM 里（只是 `display:none`），按 `.modal .setting-item` 取会捞到别人的行、
  拿到没有 `input[type=range]` 的那一行就抛错，而**抛错的步骤会把它自己开的模态框留给后面所有步骤**（file-menu 和 forest 因此连崩）——
  现在按 `offsetParent` 筛可见行，且每步跑完无条件 `app.setting.close()` + 清 `.notice/.menu/.tooltip`。
- 用户侧观察：`life` 图左上那块现在是蓝的，是用户自己把 `赚钱与技能` 改成了 `#adb2c2`，不是渲染问题。

### 标签摆放：从"一律沿半径"改成"哪边写得下字就走哪边"
用户反馈"放射图上的标题摆放容不下几个字"。根因不是截断阈值，是**摆法**：文字一律沿半径排，
能写多长就被环带厚度卡死（87px 的环只放得下 6 个汉字），而同一条分支顺环方向有 400px 以上可用。
- `fitLabel(title, edge, progressText)` 改成收**整个扇区** `{rInner,rOuter,a0,a1}`，不再收两个标量：
  上一版正是调用方把弧长当预算传了进来，而签名只收两个数时谁都看不出传反了。返回 `{text, fontSize, angle, mode}`。
- 两个方向各算一次可用长度再**取宽者**：顺环写是条直线、会往外凸，被"外径减半字高"和"扇区两条边"各卡一次；
  沿半径写受楔形 taper 约束 —— 最靠圆心的那一端得容得下字高。
- 字号 14→11 自适应，**全名优先于百分比**（塞得下才带 ` 0%`，进度本来就在外缘 dash 上）；
  降到底还写不下才截断，且至少留两个字，否则整格不写字（悬停 `<title>` 兜底）。
  `angle` 由几何侧归一到 `[-90, 90)`，视图只管 `rotate(angle)`，旧版那套 `deg>90 && deg<270` 的 flip 判断删掉。
- 测试：`fitLabel` 是纯函数，不该只活在 26 秒的实机回归里 → 新增 `src/views/__tests__/label.test.ts`（8 项），
  `run-tests.mjs` 的扫描范围从 `src/data/__tests__` 扩到 `src/{data,views}/__tests__`。
  断言**不复述实现里那两条 room 公式**（那样会跟着 bug 一起错），而是把文字还原成旋转矩形、
  四个角逐个判还在不在楔形内 —— 环厚 × 扇区角 × 标题长度全组合扫一遍。
  实机侧再加一条用浏览器真实 `getBBox()` + `getScreenCTM()` 的量法（字宽估算可能偏乐观），以及"两种方向都真的出现了"。
- 离线渲染对比（同一张 `life` 图，headless Chrome）：极薄档从"写出 26 字 + 2 格空白"变成"32 字 + 0 格空白"，
  长标题案例 68 → 71 字且不再出现省略号。

### 测试流程收敛：一条命令 + 去掉白等
- `npm run check`（新 `test/check.mjs`）：类型检查 → 打包 → 部署 `main.js/styles.css/manifest.json` 到 vault →
  纯逻辑单测 → 实机回归。9333 不通时最后一步记 **SKIP** 并打印启动方式，不算失败 —— 不用为了跑测试去开 Obsidian。
  `--no-ui` 全程 3.3 秒。Windows 上 `spawnSync` 不经 shell 起不了 `npm.cmd`（EINVAL），
  所以四步全用 `process.execPath` 直接拉本地 bin。
- 实机回归的等待按"能不能验"分三等：**能验就轮询谓词**（`waitFor` / 页内等 `pl.toneSettings[k]===v`、
  等 `data.json` 真的写进目标值）→ 只能等浏览器排版完就 `__gsSettle(上限)`（两帧 + 超时兜底）→
  只有 Obsidian 自己的异步才留固定 `setTimeout`（插件重载、换视图、开原生菜单、建文件，6 处）。
  依据是 `store.mutate → notify → render()` 在**同一个 JS 任务里同步跑完**，所以"等一下"其实只要等两帧；
  轮询谓词比等帧更准 —— 窗口被遮挡时 rAF 会整个停下来，两帧可能几分钟不来。
  36 处页内固定等待删掉 30 处，轮询间隔 150ms → 40ms。
- 实测结果（用户同意后带 `--remote-debugging-port=9333` 重启了 Obsidian）：**60/60 通过，8.8 秒**（改造前 26.0 秒），
  数据现场由脚本自己恢复（`path=Goalscapes/life.goalscape.json`、临时图和白板已删、目录清单回到起始）。
  新加的断言当场抓到两个真 bug：① 量标签溢出的那条把 `getScreenCTM()` 的矩阵乘序写反（`T·S⁻¹` 而不是 `S⁻¹·T`），
  于是 10 个标签被报成"捅出扇区"；② 设置页那步把快照压在实时基调上、却硬编码"拖回 84"来复原，
  再加上"等两帧"读不到滑杆的最新值 —— 现在两头都改成轮询 `pl.toneSettings`，复原值也从进页面时的 `orig` 取。

### 分层守卫：几何层搬出视图层（`src/geometry/radialGeometry.ts`）
拿用户给的 DDD 规范只量了"依赖只能指向内"这一条（其余七成是 Python Web 服务的形状，对本项目无意义），
当场抓到真反向依赖：`export/canvasSync → views/radialGeometry`——数据/导出层依赖界面层，代价不是难看，
是这段纯逻辑再也离不开 Obsidian 的 mock。根因是模块住错目录：它只 import `data/types`、被 data/export/views
三方共用，于是 `git mv` 到 `src/geometry/`，例外随之消失而不是留进白名单。
新增 `src/data/__tests__/layering.test.ts`（3 条断言、零新依赖、跑在 `npm test` 里）：内层不得指向 views；
`geometry/**` 与领域核心不得 import obsidian；全项目 obsidian 依赖点只能在白名单
（`main`/`settingsTab`/`goalTree`/`views`）。**`goalTree.ts` 是白名单里唯一的数据层成员**，它就是规范说的"领域对象携带 ORM"
那类违规（领域+vault IO+Notice 三合一），拆开的前提是引擎要脱开 Obsidian 复用，今天没这需求，所以记成有意例外。
守卫做过反向验证（临时探针同时 import `obsidian` 与 `../views/infoPanel`，两条断言精确报出来源）。
顺带去掉 `ganttView`/`listView` 各一份的 8 行私有 `findInScape`，4 个调用点改走 `data/types` 的 `findNode`。
`npm test` 107/107、`npm run build` 干净。踩到的坑：`git add` 里混进已被 `git mv` 挪走的旧路径会让**整条 add 因
pathspec 不匹配而失败**（只提交了 rename），以及并发会话正在写同一文件时被读到半截，会造成一次不可复现的偶发失败。

## 剩余未实测
- PNG/SVG/CSV/Markdown 的**内容**已用 Blob 捕获法实测。仍未点过一次真实的系统保存框：
  `<a download>` 在 Electron 里会弹原生对话框，自动化会把它卡住。
- 没有覆盖率统计，也没有 watch 模式（刻意不引第三方框架）。
- 模板应用后信息面板显示 "Goal not found." 那一类**跨层**问题（选中态与数据替换的耦合），
  单靠数据层单测抓不到，仍需在真实 Obsidian 里点。
- Focus Filter 色块的**可读性改造**没做（加 `Color` 文字标签，或换成"本图已用颜色"下拉以避开严格相等的坑）——
  已把语义讲清楚给用户，等点头再做。色相收归二级节点之后，这个入口的含义变成"按分支筛"，
  而严格相等比对的是分支存的那个十六进制串，仍没实测。
- 配色的层级明度阶梯（+3/层太弱）、`(siblingIndex % 3) * 2` 的无编码抖动、1px 背景色描边、
  色盘整体降饱和 —— 都提过，用户没点，未动。
- `canvasSync.progressToPreset` 仍按进度映射红/橙/黄/绿：JSON Canvas 只有 6 个 preset 色、表达不了任意色相，
  改成"分支色相→最近 preset"会引入量化误差，等点头再动。
- 分层守卫那次改动（`findInScape` → `findNode` 的 4 个写入点：list 折叠/勾选/进度滑杆、gantt 叶子进度拖拽）
  只过了 `tsc` + 单测，**没跑实机回归**——`npm run check` 会把 `main.js` 部署进 vault 并要求真实 Obsidian 在最前台。

## 后续计划（按优先级）

1. 人工点一次 PNG/SVG/CSV/Markdown 下载，确认系统保存框行为（自动化会卡住，未测）。
2. Focus Filter 加"高亮匹配项列表"侧栏、Gantt 依赖关系连线、Canvas 导出支持 group 节点分层。
3. 白板回写数据：方案已复审并改成分级（合并导出 → 手动结构同步 → 字段回写），
   执行手册见 `CANVAS-WRITEBACK.md`；开工前必须先做里面的 Stage A spike（自定义键是否被 Obsidian 保留、`.canvas` 写盘时机）。
3. 上面"剩余未实测"里等用户点头的几项：留白版模板、层级明度阶梯、色盘降饱和、Focus Filter 色块可读性。
