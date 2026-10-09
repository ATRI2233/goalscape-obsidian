// src/main.ts
// Goalscape Obsidian 插件入口。负责初始化数据层、注册视图与命令。

import { App, Plugin, TFile, TFolder, WorkspaceLeaf, Notice, Modal, Setting } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH, GOALSCAPE_FOLDER, GOALSCAPE_SUFFIX } from "./data/goalTree";
import { RadialGoalMapView } from "./views/radialView";
import { GoalListView } from "./views/listView";
import { GanttView } from "./views/ganttView";
import { VIEW_RADIAL, VIEW_LIST, VIEW_GANTT, VIEW_CANVAS } from "./views/viewTypes";
import { TEMPLATES } from "./data/templates";
import { DEFAULT_SLIDERS, Tone, toneFromSliders } from "./data/palette";
import { GoalscapeSettingTab } from "./settingsTab";
import { promptInput } from "./views/promptModal";
import { SubtreeClipboard } from "./views/radialMenu";
import {
  canvasToJson,
  refreshCanvas,
  parseCanvasJson,
  trustedSnapshot,
  type JsonCanvas,
} from "./export/canvasSync";
import { exportSvg, exportPng, exportCsv, exportMarkdownOutline, downloadBlob, downloadText } from "./export/exporters";

/** 树变了之后攒多久再写白板：拖滑杆是一次改动几十下 notify，不攒就会把 vault 写成抖动源 */
const CANVAS_DEBOUNCE_MS = 800;
/** 摘掉白板标签页之后 Obsidian 还会把内存那份补写一次，等它落地再重试 */
const CANVAS_WRITE_RETRY = 3;
const CANVAS_WRITE_SETTLE_MS = 150;
/** 欠着更新时回头看标签页关了没 —— layout-change 不一定赶在 detach 之后发 */
const CANVAS_SETTLE_MS = 1000;

export default class GoalscapePlugin extends Plugin {
  store!: GoalTreeStore;
  /** 子树剪贴板随插件存活，放射图标签页之间共享 */
  readonly clipboard = new SubtreeClipboard();
  /** 设置页那两根滑杆的原始值（0..100），换算见 palette.toneFromSliders */
  toneSettings = { ...DEFAULT_SLIDERS };
  /** 白板自动镜像开关。关掉只剩手点命令 */
  canvasAuto = true;
  /** 白板标签页开着、这次没写进去的路径 —— 工具栏那个小点就按它亮 */
  canvasPending: string | null = null;
  private canvasTimer: number | null = null;
  /** 欠着一次更新时回头看标签页关没关的轮询 */
  private canvasSettleTimer: number | null = null;
  private canvasWriting = false;

  /** 视图与导出统一从这里取当前基调，别各自读 settings 再各自换算一遍 */
  get tone(): Tone {
    return toneFromSliders(this.toneSettings.intensity, this.toneSettings.contrast);
  }

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as
      | {
          currentPath?: string;
          tone?: Partial<{ intensity: number; contrast: number }>;
          canvasAuto?: boolean;
        }
      | null;
    this.toneSettings = { ...this.toneSettings, ...(saved?.tone ?? {}) };
    this.canvasAuto = saved?.canvasAuto ?? true;
    this.store = new GoalTreeStore(this, saved?.currentPath || DEFAULT_GOALSCAPE_PATH);

    this.registerView(VIEW_RADIAL, (leaf) => new RadialGoalMapView(leaf, this));
    this.registerView(VIEW_LIST, (leaf) => new GoalListView(leaf, this));
    this.registerView(VIEW_GANTT, (leaf) => new GanttView(leaf, this));
    this.addSettingTab(new GoalscapeSettingTab(this.app, this));

    this.addRibbonIcon("target", "Open Goalscape radial map", () => {
      this.openView(VIEW_RADIAL);
    });

    this.addCommand({ id: "new-goalscape", name: "New goalscape", callback: () => void this.promptNewGoalscape() });
    this.addCommand({ id: "open-radial-goalscape", name: "Open radial goal map", callback: () => this.openView(VIEW_RADIAL) });
    this.addCommand({ id: "open-list-goalscape", name: "Open goal list view", callback: () => this.openView(VIEW_LIST) });
    this.addCommand({ id: "open-gantt-goalscape", name: "Open Gantt view", callback: () => this.openView(VIEW_GANTT) });
    this.addCommand({ id: "open-goalscape-source", name: "Open source JSON file", callback: () => this.openSourceFile() });

    this.addCommand({ id: "export-canvas", name: "Refresh .canvas from goals", callback: () => this.exportCanvas() });
    this.addCommand({ id: "export-png", name: "Export radial map as PNG", callback: () => this.exportPng() });
    this.addCommand({ id: "export-svg", name: "Export radial map as SVG", callback: () => this.exportSvg() });
    this.addCommand({ id: "export-csv", name: "Export goals as CSV", callback: () => this.exportCsv() });
    this.addCommand({ id: "export-markdown", name: "Export goals as Markdown outline", callback: () => this.exportMarkdown() });

    this.addCommand({ id: "apply-template", name: "Apply template (replace current goals)", callback: () => this.showTemplateModal() });

    // 目录栏右键（右键空白处拿到的是根目录）新建图，取代原工具栏上的 "New map" 按钮。
    // 只挂在文件夹上：Obsidian 自己的 "Add new note" 也只在文件夹/空白处出现。
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item.setTitle("New goalscape")
            .setIcon("target")
            .onClick(() => void this.promptNewGoalscape())
        );
      })
    );

    // 读档放在视图/命令注册之后：数据出问题只影响图的内容，
    // 不该连带让视图注册不上、整个标签页退化成"插件不再活动"占位页
    await this.store.load();
    this.watchCanvas();

    if (this.app.workspace.layoutReady) {
      await this.openView(VIEW_RADIAL);
    } else {
      this.app.workspace.onLayoutReady(() => void this.openView(VIEW_RADIAL));
    }
  }

  onunload(): void {
    for (const t of [this.canvasTimer, this.canvasSettleTimer]) if (t !== null) window.clearTimeout(t);
    this.canvasTimer = null;
    this.canvasSettleTimer = null;
  }

  async openView(type: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(type);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
    }
    await leaf.setViewState({ type, active: true });
    workspace.revealLeaf(leaf);
  }

  async openSourceFile(): Promise<void> {
    const file = this.store.file;
    if (!file) { new Notice("Goalscape source file not found"); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  // ──────────────────────────── 多 goalscape 管理 ────────────────────────────

  listGoalscapes(): string[] {
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(`${GOALSCAPE_FOLDER}/`) && f.path.endsWith(GOALSCAPE_SUFFIX))
      .map((f) => f.path)
      .sort();
  }

  async switchGoalscape(path: string): Promise<void> {
    if (path === this.store.path) return;
    await this.store.switchTo(path);
    await this.persistData();
    this.refreshMapSelectors();
  }

  /** data.json 只有一个写入方：这里。任何要落盘的字段都得经这条路，否则互相覆盖 */
  async persistData(): Promise<void> {
    await this.saveData({ currentPath: this.store.path, tone: this.toneSettings, canvasAuto: this.canvasAuto });
  }

  async createGoalscape(name: string): Promise<void> {
    const safe = name.replace(/[\\/:*?"<>|]/g, "").trim() || "Goalscape";
    const path = `${GOALSCAPE_FOLDER}/${safe}${GOALSCAPE_SUFFIX}`;
    if (await this.app.vault.adapter.exists(path)) {
      new Notice(`已存在同名 goalscape：${safe}`);
      await this.switchGoalscape(path);
      return;
    }
    // 新路径不存在时，store.load() 会自动用默认树建档（走 adapter，避免 vault.create 竞态），
    // 并由它提示"Goalscape: created <path>"；这里不能再提示一次，否则一次新建弹两条通知。
    await this.switchGoalscape(path);
  }

  private async promptNewGoalscape(): Promise<void> {
    const name = await promptInput(this.app, "New goalscape name", "My Goalscape");
    if (!name || !name.trim()) return;
    await this.createGoalscape(name.trim());
    // 入口在目录栏右键，用户当时可能正看着笔记：新建完得把图打开，否则只剩一条 Notice
    await this.openView(VIEW_RADIAL);
  }

  private refreshMapSelectors(): void {
    for (const view of this.radialViews()) {
      // 选中态存的是节点 id，换图后那是上一张图的节点，信息面板会显示 "Goal not found."
      view.clearSelection();
      view.refreshMapButton();
    }
  }

  /** 已注册的放射图视图；用 instanceof 收窄而不是 any，避免伸手进视图私有成员 */
  radialViews(): RadialGoalMapView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_RADIAL)
      .map((leaf) => leaf.view)
      .filter((v): v is RadialGoalMapView => v instanceof RadialGoalMapView);
  }

  /** 设置页改基调后重画。不走 store.mutate：那会把数据标记成"已修改"并落盘，而这里什么都没改 */
  redrawViews(): void {
    for (const v of this.radialViews()) v.repaint();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_GANTT)) {
      if (leaf.view instanceof GanttView) leaf.view.repaint();
    }
  }

  // ──────────────────────────── 导出 ────────────────────────────

  /**
   * 白板与图文件一一对应，用图文件名派生，不用根目标标题：
   * 标题随时可改（改了就会把白板落在旧文件里），且每张新图的默认根标题都是 "Main Goal"，
   * 多张图会抢同一个 .canvas。文件名规则只在这一处写，命令导出与切换器共用。
   */
  private canvasPathFor(): string {
    const folder = this.store.path.split("/").slice(0, -1).join("/");
    const base = this.store.path.split("/").pop()!.replace(/\.goalscape\.json$/, "");
    return `${folder}/${base}.canvas`;
  }

  /** 当前这张图的白板有没有"还没写进去的改动" */
  get canvasStale(): boolean {
    return !!this.canvasPending && this.canvasPending === this.canvasPathFor();
  }

  /**
   * 树 → 白板的自动镜像。三条约束都来自实测，不是洁癖：
   * - 白板文件不存在时**绝不自动创建**，凭空往 vault 扔文件是另一种丢数据；
   * - 白板标签页开着时不写盘：Obsidian 的 canvas 视图内存领先磁盘几十秒，
   *   它任何一次补写都会盖在我们后面 —— 用户今天的布局就是这么没的；
   * - 内容一样不写：插件启动也会 notify 一次，不该白白改一次文件。
   */
  private watchCanvas(): void {
    this.register(this.store.subscribe(() => this.queueCanvasRefresh()));
    // 关白板标签页正是补写的时机（视图关闭时自己会先把内存那份落盘）
    this.registerEvent(this.app.workspace.on("layout-change", () => this.settlePendingCanvas()));
    this.paintCanvasBadges();
  }

  private queueCanvasRefresh(): void {
    if (!this.canvasAuto || !this.store.scape) return;
    if (this.canvasTimer !== null) window.clearTimeout(this.canvasTimer);
    this.canvasTimer = window.setTimeout(() => {
      this.canvasTimer = null;
      void this.refreshCanvasFile(false);
    }, CANVAS_DEBOUNCE_MS);
  }

  private settlePendingCanvas(): void {
    if (!this.canvasAuto || !this.canvasPending) return;
    // 换图之后上一张的待更新状态不该继续顶着这个点
    if (this.canvasPending !== this.canvasPathFor()) {
      this.canvasPending = null;
      this.paintCanvasBadges();
      return;
    }
    if (this.canvasOpenLeaves(this.canvasPending).length) {
      this.armCanvasSettle();
      return;
    }
    void this.refreshCanvasFile(false);
  }

  private armCanvasSettle(): void {
    if (this.canvasSettleTimer !== null) return;
    this.canvasSettleTimer = window.setTimeout(() => {
      this.canvasSettleTimer = null;
      this.settlePendingCanvas();
    }, CANVAS_SETTLE_MS);
  }

  /** 设置页那个开关。关掉之后不该留一颗永远不会消失的小点，打开则欠着的马上补一次 */
  setCanvasAuto(v: boolean): void {
    this.canvasAuto = v;
    void this.persistData();
    if (v) {
      this.queueCanvasRefresh();
      return;
    }
    this.canvasPending = null;
    this.paintCanvasBadges();
  }

  /**
   * Obsidian 没有公开"这块白板有没有未保存的改动"，而它任何一次补写都会盖在我们后面
   * （实测内存领先磁盘几十秒，关标签页时还会再落一次），所以规则只能是一条：**有人开着就不写**。
   */
  private canvasOpenLeaves(canvasPath: string): WorkspaceLeaf[] {
    return this.app.workspace
      .getLeavesOfType("canvas")
      .filter((l) => (l.view as { file?: TFile }).file?.path === canvasPath);
  }

  private liveCanvasDoc(leaf: WorkspaceLeaf | undefined): JsonCanvas | null {
    const canvas = (leaf?.view as { canvas?: { getData?: () => unknown } } | undefined)?.canvas;
    if (typeof canvas?.getData !== "function") return null;
    try {
      return parseCanvasJson(JSON.stringify(canvas.getData()));
    } catch {
      return null;
    }
  }

  /** 白板快照：内存优先（实测它领先磁盘几十秒），但只有真加载出卡片才算可信，否则退回磁盘 */
  private async canvasSnapshot(canvasPath: string): Promise<JsonCanvas | null> {
    const leaf = this.canvasOpenLeaves(canvasPath)[0];
    const disk =
      this.app.vault.getAbstractFileByPath(canvasPath) instanceof TFile
        ? parseCanvasJson(await this.app.vault.adapter.read(canvasPath).catch(() => ""))
        : null;
    return trustedSnapshot(this.liveCanvasDoc(leaf), disk);
  }

  /**
   * 单向镜像落盘。explicit = 用户手点的命令：可以创建文件、可以摘标签页、要给反馈。
   * 自动路径只在"文件已存在 && 没人开着这块白板"时写。
   */
  private async refreshCanvasFile(explicit: boolean): Promise<void> {
    const scape = this.store.scape;
    if (!scape || this.canvasWriting) return;
    const path = this.canvasPathFor();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) && !explicit) return;

    const open = this.canvasOpenLeaves(path);
    if (!explicit && open.length) {
      this.canvasPending = path;
      this.paintCanvasBadges();
      return;
    }

    const json = canvasToJson(refreshCanvas(scape, await this.canvasSnapshot(path)));
    if (file instanceof TFile) {
      const disk = (await this.app.vault.adapter.read(path).catch(() => "")).trim();
      if (disk === json.trim()) {
        this.canvasPending = null;
        this.paintCanvasBadges();
        if (explicit) {
          new Notice(`白板已是最新：${path}`);
          await this.openCanvasFile(path);
        }
        return;
      }
    }

    this.canvasWriting = true;
    let written = false;
    try {
      // 先摘标签页、后写盘：canvas 视图关闭时会把内存里那份补写一次，顺序反了刚写的就被盖掉
      for (const l of open) l.detach();
      await new Promise((r) => window.setTimeout(r, CANVAS_WRITE_SETTLE_MS));
      written = await this.writeCanvasDoc(path, json);
      this.canvasPending = written ? null : path;
    } finally {
      this.canvasWriting = false;
    }
    this.paintCanvasBadges();
    if (!explicit) return;
    new Notice(written ? `白板已更新：${path}` : `白板写入失败：${path}`);
    await this.openCanvasFile(path);
  }

  /**
   * 写完读回来确认落盘的是我们这份 —— 刚摘掉的 canvas 视图会把内存里那份补写一次，
   * 实测就发生在我们的 modify 之后。重试几次比假装没这回事便宜。
   */
  private async writeCanvasDoc(path: string, json: string): Promise<boolean> {
    for (let i = 0; i < CANVAS_WRITE_RETRY; i++) {
      const f = this.app.vault.getAbstractFileByPath(path);
      try {
        if (f instanceof TFile) await this.app.vault.modify(f, json);
        else await this.app.vault.create(path, json);
      } catch {
        return false;
      }
      const back = (await this.app.vault.adapter.read(path).catch(() => "")).trim();
      if (back === json.trim()) return true;
      await new Promise((r) => window.setTimeout(r, CANVAS_WRITE_SETTLE_MS));
    }
    return false;
  }

  /** 工具栏 Canvas 段上的小点：这块白板有还没写进去的改动 */
  private paintCanvasBadges(): void {
    const stale = this.canvasStale;
    for (const type of [VIEW_RADIAL, VIEW_LIST, VIEW_GANTT]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const seg = leaf.view.containerEl.querySelector<HTMLElement>(
          `.goalscape-view-seg[data-view='${VIEW_CANVAS}']`
        );
        seg?.toggleClass("is-stale", stale);
      }
    }
  }

  private async exportCanvas(): Promise<void> {
    await this.refreshCanvasFile(true);
  }

  /**
   * 切换器里的 Canvas 项。三种情况分开走，因为"正在看的白板"盖不得：
   * 文件不存在 → 生成第一版；存在且没开着 → 先刷成最新的再打开（点它就是来看最新图）；
   * 已经开着 → 只切过去不写盘，待更新的小点继续亮着，等标签页关掉再补。
   */
  async openCanvas(): Promise<void> {
    const canvasPath = this.canvasPathFor();
    const exists = this.app.vault.getAbstractFileByPath(canvasPath) instanceof TFile;
    if (exists) {
      const open = this.canvasOpenLeaves(canvasPath);
      if (open.length) {
        this.app.workspace.revealLeaf(open[0]);
        return;
      }
      await this.refreshCanvasFile(false);
      await this.openCanvasFile(canvasPath);
      return;
    }
    await this.refreshCanvasFile(true);
  }

  private async openCanvasFile(canvasPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(canvasPath);
    if (!(file instanceof TFile)) {
      new Notice(`Canvas file not found: ${canvasPath}`);
      return;
    }
    const opened = this.app.workspace
      .getLeavesOfType("canvas")
      .find((leaf) => (leaf.view as { file?: TFile }).file?.path === canvasPath);
    if (opened) {
      this.app.workspace.revealLeaf(opened);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  private getRadialSvg(): SVGSVGElement | null {
    const view = this.radialViews()[0];
    if (!view) {
      new Notice("Open the radial view first");
      return null;
    }
    return view.getSvg();
  }

  private async exportPng(): Promise<void> {
    const svg = this.getRadialSvg();
    if (!svg) return;
    const blob = await exportPng(svg);
    downloadBlob(blob, "goalscape.png");
    new Notice("PNG exported");
  }

  private exportSvg(): void {
    const svg = this.getRadialSvg();
    if (!svg) return;
    const str = exportSvg(svg);
    downloadText(str, "goalscape.svg", "image/svg+xml");
    new Notice("SVG exported");
  }

  private exportCsv(): void {
    const scape = this.store.scape;
    if (!scape) return;
    const csv = exportCsv(scape, this.tone);
    downloadText(csv, "goalscape.csv", "text/csv");
    new Notice("CSV exported");
  }

  private exportMarkdown(): void {
    const scape = this.store.scape;
    if (!scape) return;
    const md = exportMarkdownOutline(scape);
    downloadText(md, "goalscape-outline.md", "text/markdown");
    new Notice("Markdown outline exported");
  }

  // ──────────────────────────── 模板 ────────────────────────────

  private showTemplateModal(): void {
    new TemplateModal(this.app, this).open();
  }
}

class TemplateModal extends Modal {
  constructor(app: App, private plugin: GoalscapePlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Choose a template" });
    contentEl.createEl("p", { text: "This will replace your current goal tree. This cannot be undone.", cls: "goalscape-template-warning" });

    for (const t of TEMPLATES) {
      new Setting(contentEl)
        .setName(t.name)
        .setDesc(t.description)
        .addButton((btn) =>
          btn.setButtonText("Apply").onClick(() => {
            this.plugin.store.mutate((s) => {
              const template = t.build();
              s.mainGoal = template.mainGoal;
              s.colorMeanings = template.colorMeanings;
            });
            // 模板替换后原选中节点 id 失效，清空各放射图视图的选中，避免信息面板显示 "Goal not found."
            for (const view of this.plugin.radialViews()) {
              view.clearSelection();
            }
            this.close();
            new Notice(`Template "${t.name}" applied`);
          })
        );
    }

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => this.close())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
