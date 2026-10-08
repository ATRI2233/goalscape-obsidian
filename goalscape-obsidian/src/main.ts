// src/main.ts
// Goalscape Obsidian 插件入口。负责初始化数据层、注册视图与命令。

import { App, Plugin, TFile, TFolder, WorkspaceLeaf, Notice, Modal, Setting } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH, GOALSCAPE_FOLDER, GOALSCAPE_SUFFIX } from "./data/goalTree";
import { RadialGoalMapView } from "./views/radialView";
import { GoalListView } from "./views/listView";
import { GanttView } from "./views/ganttView";
import { VIEW_RADIAL, VIEW_LIST, VIEW_GANTT } from "./views/viewTypes";
import { TEMPLATES } from "./data/templates";
import { promptInput } from "./views/promptModal";
import { SubtreeClipboard } from "./views/radialMenu";
import { toCanvas, canvasToJson } from "./export/canvasSync";
import { exportSvg, exportPng, exportCsv, exportMarkdownOutline, downloadBlob, downloadText } from "./export/exporters";

export default class GoalscapePlugin extends Plugin {
  store!: GoalTreeStore;
  /** 子树剪贴板随插件存活，放射图标签页之间共享 */
  readonly clipboard = new SubtreeClipboard();

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as { currentPath?: string } | null;
    this.store = new GoalTreeStore(this, saved?.currentPath || DEFAULT_GOALSCAPE_PATH);

    this.registerView(VIEW_RADIAL, (leaf) => new RadialGoalMapView(leaf, this));
    this.registerView(VIEW_LIST, (leaf) => new GoalListView(leaf, this));
    this.registerView(VIEW_GANTT, (leaf) => new GanttView(leaf, this));

    this.addRibbonIcon("target", "Open Goalscape radial map", () => {
      this.openView(VIEW_RADIAL);
    });

    this.addCommand({ id: "new-goalscape", name: "New goalscape", callback: () => void this.promptNewGoalscape() });
    this.addCommand({ id: "open-radial-goalscape", name: "Open radial goal map", callback: () => this.openView(VIEW_RADIAL) });
    this.addCommand({ id: "open-list-goalscape", name: "Open goal list view", callback: () => this.openView(VIEW_LIST) });
    this.addCommand({ id: "open-gantt-goalscape", name: "Open Gantt view", callback: () => this.openView(VIEW_GANTT) });
    this.addCommand({ id: "open-goalscape-source", name: "Open source JSON file", callback: () => this.openSourceFile() });

    this.addCommand({ id: "export-canvas", name: "Export to .canvas", callback: () => this.exportCanvas() });
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

    if (this.app.workspace.layoutReady) {
      await this.openView(VIEW_RADIAL);
    } else {
      this.app.workspace.onLayoutReady(() => void this.openView(VIEW_RADIAL));
    }
  }

  onunload(): void {}

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
    await this.saveData({ currentPath: path });
    this.refreshMapSelectors();
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

  private async exportCanvas(): Promise<void> {
    const scape = this.store.scape;
    if (!scape) return;
    const json = canvasToJson(toCanvas(scape));
    const canvasPath = this.canvasPathFor();
    const existing = this.app.vault.getAbstractFileByPath(canvasPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, json);
    } else {
      await this.app.vault.create(canvasPath, json);
    }
    new Notice(`Canvas exported: ${canvasPath}`);
    await this.openCanvasFile(canvasPath);
  }

  /**
   * 切换器里的 Canvas 项：文件已存在就**原样打开**，不重新生成。
   * 白板里手工摆的位置/连线经不起一次重导出 —— toCanvas() 是按放射布局重算坐标的单向转换，
   * 且 GoalNode 根本没有 x/y 字段，位置在 goalscape 数据里无处可存。
   * 只有文件还不存在时才生成第一版。
   */
  async openCanvas(): Promise<void> {
    const scape = this.store.scape;
    if (!scape) return;
    const canvasPath = this.canvasPathFor();
    if (!(this.app.vault.getAbstractFileByPath(canvasPath) instanceof TFile)) {
      await this.app.vault.create(canvasPath, canvasToJson(toCanvas(scape)));
      new Notice(`Created ${canvasPath}`);
    }
    await this.openCanvasFile(canvasPath);
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
    const csv = exportCsv(scape);
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
