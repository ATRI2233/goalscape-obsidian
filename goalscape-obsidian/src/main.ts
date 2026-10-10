// src/main.ts
// Goalscape Obsidian 插件入口。负责初始化数据层、注册视图与命令。

import { App, Plugin, TFile, TFolder, WorkspaceLeaf, Notice, Modal, Setting } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH, GOALSCAPE_FOLDER, GOALSCAPE_SUFFIX } from "./data/goalTree";
import { NoteStore } from "./data/noteFiles";
import { flattenTree } from "./data/types";
import { RadialGoalMapView } from "./views/radialView";
import { GoalListView } from "./views/listView";
import { GanttView } from "./views/ganttView";
import { VIEW_RADIAL, VIEW_LIST, VIEW_GANTT, VIEW_CANVAS } from "./views/viewTypes";
import type { GoalscapeHost } from "./views/host";
import { TEMPLATES } from "./data/templates";
import { DEFAULT_SLIDERS, Tone, toneFromSliders } from "./data/palette";
import { GoalscapeSettingTab } from "./settingsTab";
import { promptInput } from "./views/promptModal";
import { SubtreeClipboard } from "./views/radialMenu";
import { CanvasMirror } from "./export/canvasMirror";
import { exportCsv, exportMarkdownOutline } from "./export/exporters";
import { exportSvg, exportPng } from "./export/svgExport";
import { downloadBlob, downloadText } from "./export/download";

export default class GoalscapePlugin extends Plugin implements GoalscapeHost {
  store!: GoalTreeStore;
  /** 块 ↔ 笔记文件的适配器：视图与导出层要的正文/出链都从它的索引里同步取 */
  notes!: NoteStore;
  /** 子树剪贴板随插件存活，放射图标签页之间共享 */
  readonly clipboard = new SubtreeClipboard();
  /** 设置页那两根滑杆的原始值（0..100），换算见 palette.toneFromSliders */
  toneSettings = { ...DEFAULT_SLIDERS };
  /** 树 → .canvas 的自动镜像：待写状态、防抖与定时器都在它里面，本文件只剩门面 */
  private canvas?: CanvasMirror;

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
    this.store = new GoalTreeStore(this, saved?.currentPath || DEFAULT_GOALSCAPE_PATH);
    this.notes = new NoteStore(this, this.store);
    this.canvas = new CanvasMirror({
      app: this.app,
      store: this.store,
      noteIndex: () => this.notes.notes,
      persist: () => void this.persistData(),
      paintBadges: () => this.paintCanvasBadges(),
      registerEvent: (ref) => this.registerEvent(ref),
    });
    // 直接给字段而不是 setAuto()：后者会顺手 saveData 一次，启动路径不该写配置
    this.canvas.auto = saved?.canvasAuto ?? true;

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

    // 笔记 → 块：反链面板能回答"这篇笔记被谁引用"，回答不了"这篇笔记是谁的笔记"。
    // checkCallback 让它只在光标真停在某块笔记上时才出现在命令面板里
    this.addCommand({
      id: "reveal-owning-block",
      name: "Reveal the block this note belongs to",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") return false;
        const owner = this.notes.ownerOf(file);
        if (!owner) return false;
        if (!checking) void this.revealOwningBlock(owner);
        return true;
      },
    });

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
    // 先挂监听再建索引：迁移刚写出来的 .md，metadataCache 那一刻往往还没解析完，
    // 靠 changed 事件补一轮才拿得到链接（顺序反了就是"文件卡片时有时无"）
    this.notes.watch();
    // 笔记索引要在开视图之前建好：面板与放射图都是同步读它的
    await this.notes.syncMap();
    this.canvas.watch();

    if (this.app.workspace.layoutReady) {
      await this.openView(VIEW_RADIAL);
    } else {
      this.app.workspace.onLayoutReady(() => void this.openView(VIEW_RADIAL));
    }
  }

  onunload(): void {
    this.canvas?.unload();
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

  /**
   * 把用户脚下那篇笔记对应的块选中给他看。入口在编辑器里，所以这一步要主动把放射图带过来；
   * 笔记属于别的图就先切过去（`<图名>.notes/` 这个目录名就是归属），切之前确认文件还在 ——
   * 图被删掉而笔记还留着是可能的，这时只报一句，不该把人扔进一张空图。
   */
  private async revealOwningBlock(owner: { scapePath: string; goalId: string }): Promise<void> {
    if (owner.scapePath !== this.store.path) {
      if (!(await this.app.vault.adapter.exists(owner.scapePath))) {
        new Notice(`Goalscape 文件已不在：${owner.scapePath}`);
        return;
      }
      await this.switchGoalscape(owner.scapePath);
    }
    await this.openView(VIEW_RADIAL);
    if (!this.radialViews()[0]?.revealGoal(owner.goalId)) {
      new Notice(`这个块在 ${owner.scapePath} 里已经不在了`);
    }
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
    await this.notes.syncMap();
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
      view.clearPinnedNotes();
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

  // ──────────────────────────── 白板镜像门面 ────────────────────────────

  /** 自动镜像开关。关掉只剩手点命令 */
  get canvasAuto(): boolean {
    return this.canvas?.auto ?? true;
  }

  /** 当前这张图的白板有没有"还没写进去的改动" */
  get canvasStale(): boolean {
    return this.canvas?.stale ?? false;
  }

  /** 设置页那个开关：关掉不留一颗永远不会消失的小点，打开则欠着的马上补一次 */
  setCanvasAuto(v: boolean): void {
    this.canvas?.setAuto(v);
  }

  /** 视图切换器里的 Canvas 项 */
  openCanvas(): Promise<void> {
    return this.canvas?.open() ?? Promise.resolve();
  }

  /** 手点命令：把当前图刷进 .canvas */
  exportCanvas(): Promise<void> {
    return this.canvas?.refreshExplicit() ?? Promise.resolve();
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

  // ──────────────────────────── 导出 ────────────────────────────

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
    const csv = exportCsv(scape, this.tone, this.notes.notes);
    downloadText(csv, "goalscape.csv", "text/csv");
    new Notice("CSV exported");
  }

  private exportMarkdown(): void {
    const scape = this.store.scape;
    if (!scape) return;
    const md = exportMarkdownOutline(scape, this.notes.notes);
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
