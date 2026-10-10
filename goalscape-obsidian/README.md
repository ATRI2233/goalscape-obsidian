# Goalscape

放射状目标图插件：一棵目标树，进度按权重自动汇总。

- 每张图是 vault 里的一个 `Goalscapes/<图名>.goalscape.json`，可以在外部编辑，插件会自动刷新。
- 四种呈现：放射图 / 列表 / 甘特 / `.canvas` 白板。导出 PNG / SVG / CSV / Markdown 大纲。
- 要求 Obsidian 1.5.0+。manifest 没限制桌面（`isDesktopOnly: false`），但移动端未实测。

## 放射图怎么读

| 图形 | 含义 |
| --- | --- |
| 扇区角度 | `importance` —— **占父扇区角度的绝对百分比**。兄弟之和不到 100 就留白，超过 100 只在渲染时整体缩回，不改数据 |
| 环带厚度 | 每个节点独立，右侧面板 `Importance` 行右边四档：0.3 / 0.6 / 1 / 1.3（标准档不写字段）。各分支半径因此互不对齐 |
| 外缘细弧 | 该节点的进度，只画走完的那一段 |
| 颜色 | 色相只在中心盘与二级节点上设，整条分支跟着走；更深层级只调明度 |

叶子手填进度，父级 = Σ(权重 × 进度) / Σ权重。

## 操作

| 想做的事 | 入口 |
| --- | --- |
| 选中扇区 | 单击 |
| 增删改、剪贴、折叠 | 右键扇区：Add subgoal / Add sibling / Rename / Set progress / Cut / Copy / Paste as child / Delete |
| 换父级 | 把扇区拖到目标扇区上松手 |
| 调权重 | 选中后拖扇区外缘的圆点 |
| 新建图 | 在左侧目录栏对 `Goalscapes` 文件夹（或空白处）右键 → New goalscape |
| 换图 | 工具栏的图名按钮 |
| 筛选 | 工具栏漏斗浮层：Tag / Min% / Max% / Color，生效时漏斗亮圆点 |

命令面板另有 11 条：三个视图各一条打开命令、新建图、打开源 JSON、五条导出（含 `.canvas`）、应用模板。

## 开发

```bash
cd goalscape-obsidian
npm run dev        # esbuild watch
npm run build      # tsc 类型检查 + production 打包
npm test           # 数据层单测（Node 内置 node:test，零新依赖）
npm run test:ui    # 真实 Obsidian 界面回归
```

两个脚本都要知道你的 vault 在哪，路径不写死在仓库里，由环境变量给。Windows 设一次即可（重开终端生效）：

```bash
setx GS_VAULT "D:/path/to/your-vault"
```

`test:ui` 的前提：`GS_VAULT` 已设、Obsidian 以 `--remote-debugging-port=9333` 启动、窗口在最前台，脚本会把插件
disable/enable 一次，别在手正编辑时跑。它自带现场快照与还原，只往 vault 写 `ZZ_*` 临时图。
`npm run check` 在没设 `GS_VAULT` 时把部署那一步记为 SKIP，构建与单测照样给结论。

部署：仓库根的 `install-plugin.bat` 把 `main.js` / `manifest.json` / `styles.css` 复制进 `%GS_VAULT%` 的
`.obsidian/plugins/goalscape-obsidian/`。**正在运行的 Obsidian 不会热加载**，要 disable/enable 插件才生效。

## 已知边界

- 白板是**单向导出**：在 `.canvas` 里改文字、挪位置不会回流到 goalscape 数据。
- 导出仍没点过一次真实的系统保存框（`<a download>` 在 Electron 里弹原生对话框，自动化会卡住）。
- 模板数值仍是"兄弟和 = 100"，在森林几何下会铺满整圆，留白版模板待做。

开发纪要与踩过的坑见 [`PROGRESS.md`](../PROGRESS.md)。
