// src/main.ts
// Goalscape Obsidian 插件入口。负责初始化数据层、注册视图与命令。

import { Plugin, TFile, WorkspaceLeaf, Notice, Modal, Setting } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH } from "./data/goalTree";
import { RadialGoalMapView, VIEW_RADIAL } from "./views/radialView";
import { GoalListView, VIEW_LIST } from "./views/listView";
import { GanttView, VIEW_GANTT } from "./views/ganttView";
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
      .filter((f) => f.path.startsWith("Goalscapes/") && f.path.endsWith(".goalscape.json"))
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
    const path = `Goalscapes/${safe}.goalscape.json`;
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
    if (name && name.trim()) await this.createGoalscape(name.trim());
  }

  private refreshMapSelectors(): void {
    for (const view of this.radialViews()) {
      view.refreshMapList();
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

  private async exportCanvas(): Promise<void> {
    const scape = this.store.scape;
    if (!scape) return;
    const canvas = toCanvas(scape);
    const json = canvasToJson(canvas);
    const folder = this.store.path.split("/").slice(0, -1).join("/");
    const canvasPath = `${folder}/${scape.mainGoal.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")}.canvas`;
    const existing = this.app.vault.getAbstractFileByPath(canvasPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, json);
    } else {
      await this.app.vault.create(canvasPath, json);
    }
    new Notice(`Canvas exported: ${canvasPath}`);
    const leaf = this.app.workspace.getLeaf("tab");
    const file = this.app.vault.getAbstractFileByPath(canvasPath);
    if (file instanceof TFile) await leaf.openFile(file);
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
  constructor(app: any, private plugin: GoalscapePlugin) {
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
