// src/views/radialMenu.ts
// 放射图右键菜单与子树剪贴板。菜单项只描述意图，实际改数据一律走 store.mutate，
// 由 store 负责汇总、落盘与通知。

import { App, Menu, Notice } from "obsidian";
import { GoalNode, findNode, flattenTree } from "../data/types";
import type { GoalTreeStore } from "../data/goalTree";
import { addGoal, deleteGoal, renameGoal, extractSubtree, pasteSubtree, toggleCollapsed } from "../data/crud";
import { promptInput, confirmAction } from "./promptModal";

export type ClipboardMode = "copy" | "cut";

/**
 * 子树剪贴板挂在 plugin 上而不是模块变量：模块级可变状态会被所有放射图标签页共享，
 * 关掉视图也清不掉，多开时互相覆盖。
 */
export class SubtreeClipboard {
  private subtree: GoalNode | null = null;
  private mode: ClipboardMode | null = null;

  get payload(): GoalNode | null {
    return this.subtree;
  }

  set(node: GoalNode, mode: ClipboardMode): void {
    this.subtree = node;
    this.mode = mode;
  }

  /** 剪切是一次性的（原节点已被删），复制则可反复粘贴 */
  consume(): void {
    if (this.mode === "cut") this.clear();
  }

  clear(): void {
    this.subtree = null;
    this.mode = null;
  }
}

/** 删除没有撤销，带后代的节点会一整支消失，所以这种情况必须先确认 */
async function confirmDeleteGoal(app: App, node: GoalNode): Promise<boolean> {
  const descendants = flattenTree(node).length - 1;
  if (!descendants) return true;
  return confirmAction(
    app,
    `Delete "${node.title}" together with its ${descendants} sub-goal${descendants > 1 ? "s" : ""}? This cannot be undone.`
  );
}

export interface GoalMenuDeps {
  app: App;
  store: GoalTreeStore;
  clipboard: SubtreeClipboard;
  node: GoalNode;
  isMain: boolean;
  /** 删除成功后通知视图清理选中态 */
  onDeleted: () => void;
}

export function buildGoalMenu(deps: GoalMenuDeps): Menu {
  const { app, store, clipboard, node, isMain, onDeleted } = deps;
  const menu = new Menu();

  if (node.children.length) {
    menu.addItem((item) =>
      item.setTitle(node.collapsed ? "Expand" : "Collapse")
        .setIcon(node.collapsed ? "unfold-vertical" : "fold-vertical")
        .onClick(() => {
          store.mutate((s) => toggleCollapsed(s, node.id));
        })
    );
  }

  menu.addSeparator();

  menu.addItem((item) =>
    item.setTitle("Add subgoal").setIcon("plus")
      .onClick(async () => {
        const title = await promptInput(app, "New subgoal", "New Goal");
        if (title === null) return;
        store.mutate((s) => addGoal(s, node.id, "child", title));
      })
  );
  if (!isMain) {
    menu.addItem((item) =>
      item.setTitle("Add sibling").setIcon("plus-circle")
        .onClick(async () => {
          const title = await promptInput(app, "New sibling goal", "New Goal");
          if (title === null) return;
          store.mutate((s) => addGoal(s, node.id, "sibling", title));
        })
    );
  }

  menu.addItem((item) =>
    item.setTitle("Rename").setIcon("pencil")
      .onClick(async () => {
        const title = await promptInput(app, "Rename goal", node.title);
        if (title === null || title === node.title) return;
        store.mutate((s) => renameGoal(s, node.id, title));
      })
  );

  if (!node.children.length) {
    menu.addItem((item) =>
      item.setTitle("Set progress").setIcon("gauge")
        .onClick(async () => {
          const raw = await promptInput(app, "Progress (0-100)", String(node.progress ?? 0));
          if (raw === null) return;
          const progress = Math.max(0, Math.min(100, Math.round(Number(raw))));
          if (Number.isNaN(progress)) return;
          store.mutate((s) => {
            const target = findNode(s.mainGoal, node.id);
            if (target) target.node.progress = progress;
          });
        })
    );
  }

  menu.addSeparator();

  if (!isMain) {
    menu.addItem((item) =>
      item.setTitle("Cut").setIcon("scissors")
        .onClick(() => {
          const extracted = store.scape && extractSubtree(store.scape, node.id);
          if (!extracted) return;
          clipboard.set(extracted, "cut");
          store.mutate((s) => deleteGoal(s, node.id));
          new Notice("Goal cut to clipboard");
        })
    );
    menu.addItem((item) =>
      item.setTitle("Copy").setIcon("copy")
        .onClick(() => {
          const extracted = store.scape && extractSubtree(store.scape, node.id);
          if (!extracted) return;
          clipboard.set(extracted, "copy");
          new Notice("Goal copied to clipboard");
        })
    );
  }

  menu.addItem((item) =>
    item.setTitle("Paste as child").setIcon("clipboard")
      .setDisabled(!clipboard.payload)
      .onClick(() => {
        const payload = clipboard.payload;
        if (!payload) return;
        store.mutate((s) => pasteSubtree(s, node.id, "child", payload));
        clipboard.consume();
      })
  );

  menu.addSeparator();

  if (!isMain) {
    menu.addItem((item) =>
      item.setTitle("Delete").setIcon("trash-2")
        .onClick(async () => {
          if (!(await confirmDeleteGoal(app, node))) return;
          store.mutate((s) => deleteGoal(s, node.id));
          onDeleted();
        })
    );
  }

  return menu;
}
