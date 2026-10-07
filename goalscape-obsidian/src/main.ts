// src/main.ts
// Goalscape Obsidian 插件入口。负责初始化数据层、注册视图与命令。

import { Plugin, WorkspaceLeaf, Notice, Modal, Setting } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH } from "./data/goalTree";
import { RadialGoalMapView, VIEW_RADIAL } from "./views/radialView";
import { GoalListView, VIEW_LIST } from "./views/listView";
import { GanttView, VIEW_GANTT } from "./views/ganttView";
import { TEMPLATES } from "./data/templates";
import { toCanvas, canvasToJson } from "./export/canvasSync";
import { exportSvg, exportPng, exportCsv, exportMarkdownOutline, downloadBlob, downloadText } from "./export/exporters";

export default class GoalscapePlugin extends Plugin {
  store!: GoalTreeStore;

  async onload(): Promise<void> {
    this.store = new GoalTreeStore(this, DEFAULT_GOALSCAPE_PATH);
    await this.store.load();

    this.registerView(VIEW_RADIAL, (leaf) => new RadialGoalMapView(leaf, this));
    this.registerView(VIEW_LIST, (leaf) => new GoalListView(leaf, this));
    this.registerView(VIEW_GANTT, (leaf) => new GanttView(leaf, this));

    this.addRibbonIcon("target", "Open Goalscape radial map", () => {
      this.openView(VIEW_RADIAL);
    });

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

  // ──────────────────────────── 导出 ────────────────────────────

  private async exportCanvas(): Promise<void> {
    const scape = this.store.scape;
    if (!scape) return;
    const canvas = toCanvas(scape);
    const json = canvasToJson(canvas);
    const folder = this.store.path.split("/").slice(0, -1).join("/");
    const canvasPath = `${folder}/${scape.mainGoal.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")}.canvas`;
    const existing = this.app.vault.getAbstractFileByPath(canvasPath);
    if (existing) {
      await this.app.vault.modify(existing as any, json);
    } else {
      await this.app.vault.create(canvasPath, json);
    }
    new Notice(`Canvas exported: ${canvasPath}`);
    const leaf = this.app.workspace.getLeaf("tab");
    const file = this.app.vault.getAbstractFileByPath(canvasPath);
    if (file) await leaf.openFile(file as any);
  }

  private getRadialSvg(): SVGSVGElement | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_RADIAL);
    if (!leaves.length) { new Notice("Open the radial view first"); return null; }
    const containerEl = (leaves[0].view as any).contentEl as HTMLElement;
    return containerEl.querySelector("svg.goalscape-radial-svg");
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
