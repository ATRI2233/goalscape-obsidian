// src/views/listView.ts
// Goal List 视图：缩进列表，可勾选完成、inline 编辑标题、更新进度。

import { ItemView, WorkspaceLeaf } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode } from "../data/types";
import { renameGoal } from "../data/crud";
import { VIEW_LIST } from "./viewTypes";
import { createViewSwitcher } from "./viewSwitcher";

export class GoalListView extends ItemView {
  private unsubscribe?: () => void;
  private rootEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: GoalscapePlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_LIST; }
  getDisplayText(): string { return "Goalscape List"; }
  getIcon(): string { return "list"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("goalscape-container");
    const bar = this.contentEl.createDiv({ cls: "goalscape-view-bar" });
    createViewSwitcher(bar, this.plugin, this.leaf, VIEW_LIST);
    this.rootEl = this.contentEl.createDiv({ cls: "goalscape-list-root" });
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private render(): void {
    this.rootEl.empty();
    const scape = this.plugin.store.scape;
    if (!scape) return;
    this.renderNode(scape.mainGoal, 0);
  }

  private renderNode(node: GoalNode, depth: number): void {
    const row = this.rootEl.createDiv({ cls: "goalscape-list-row" });
    row.style.paddingLeft = `${depth * 20 + 8}px`;

    const toggle = row.createSpan({ cls: "goalscape-list-toggle" });
    if (node.children.length) {
      toggle.textContent = node.collapsed ? "▶" : "▼";
      toggle.addEventListener("click", () => {
        this.plugin.store.mutate((s) => {
          const found = this.findInScape(s.mainGoal, node.id);
          if (found) found.collapsed = !found.collapsed;
        });
      });
    } else {
      toggle.textContent = "·";
      toggle.addClass("goalscape-list-leaf-dot");
    }

    const checkbox = row.createEl("input", { cls: "goalscape-list-checkbox" });
    checkbox.type = "checkbox";
    checkbox.checked = (node.progress ?? 0) >= 100;
    checkbox.addEventListener("change", () => {
      if (!node.children.length) {
        this.plugin.store.mutate((s) => {
          const found = this.findInScape(s.mainGoal, node.id);
          if (found) found.progress = checkbox.checked ? 100 : 0;
        });
      }
    });
    if (node.children.length) checkbox.disabled = true;

    const titleEl = row.createSpan({ cls: "goalscape-list-title" });
    titleEl.textContent = node.title;
    titleEl.addEventListener("dblclick", () => {
      const input = row.createEl("input", { cls: "goalscape-list-edit" });
      input.value = node.title;
      titleEl.style.display = "none";
      input.focus();
      input.select();
      const commit = () => {
        const v = input.value.trim();
        input.remove();
        titleEl.style.display = "";
        if (v && v !== node.title) {
          this.plugin.store.mutate((s) => renameGoal(s, node.id, v));
        }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { input.remove(); titleEl.style.display = ""; }
      });
    });

    const progressEl = row.createSpan({ cls: "goalscape-list-progress" });
    progressEl.textContent = `${node.progress ?? 0}%`;

    if (!node.children.length) {
      const slider = row.createEl("input", { cls: "goalscape-list-slider" });
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.value = String(node.progress ?? 0);
      slider.addEventListener("input", () => {
        progressEl.textContent = `${slider.value}%`;
      });
      slider.addEventListener("change", () => {
        this.plugin.store.mutate((s) => {
          const found = this.findInScape(s.mainGoal, node.id);
          if (found) found.progress = Number(slider.value);
        });
      });
    }

    if (node.collapsed) return;
    for (const child of node.children) {
      this.renderNode(child, depth + 1);
    }
  }

  private findInScape(root: GoalNode, id: string): GoalNode | null {
    const stack: GoalNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      stack.push(...n.children);
    }
    return null;
  }
}
