// src/main.ts
// Goalscape Obsidian 插件入口。负责初始化数据层、注册视图与命令。

import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH } from "./data/goalTree";
import { RadialGoalMapView, VIEW_RADIAL } from "./views/radialView";

export default class GoalscapePlugin extends Plugin {
  store!: GoalTreeStore;

  async onload(): Promise<void> {
    this.store = new GoalTreeStore(this, DEFAULT_GOALSCAPE_PATH);
    await this.store.load();

    this.registerView(VIEW_RADIAL, (leaf) => new RadialGoalMapView(leaf, this));

    this.addRibbonIcon("target", "Open Goalscape radial map", () => {
      this.openView(VIEW_RADIAL);
    });

    this.addCommand({
      id: "open-radial-goalscape",
      name: "Open radial goal map",
      callback: () => this.openView(VIEW_RADIAL),
    });

    this.addCommand({
      id: "focus-default-goalscape",
      name: "Focus default Goalscape file",
      callback: () => {
        this.openView(VIEW_RADIAL);
        new Notice(`Goalscape: using ${this.store.file?.path ?? DEFAULT_GOALSCAPE_PATH}`);
      },
    });

    this.addCommand({
      id: "open-goalscape-source",
      name: "Open source JSON file",
      callback: () => this.openSourceFile(),
    });

    // 插件加载后自动打开一次视图，方便用户感知
    if (this.app.workspace.layoutReady) {
      await this.openView(VIEW_RADIAL);
    } else {
      this.app.workspace.onLayoutReady(() => void this.openView(VIEW_RADIAL));
    }
  }

  onunload(): void {
    // GoalTreeStore 的订阅在视图关闭时自动释放，无需额外清理
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
    if (!file) {
      new Notice("Goalscape source file not found");
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }
}
