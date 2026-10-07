// src/views/radialView.ts
// Goalscape 放射图视图（Phase 1 + 2 基础：渲染 + Collapse/Expand + 选中高亮 + CRUD 右键菜单）。
// 纯 SVG 自研扇区布局：权重决定扇区角度，进度决定颜色深浅，深度决定环半径。

import { ItemView, WorkspaceLeaf, Menu, Modal, Setting, Notice } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode } from "../data/types";
import {
  addGoal,
  deleteGoal,
  renameGoal,
  adjustImportance,
  extractSubtree,
  pasteSubtree,
} from "../data/crud";

export const VIEW_RADIAL = "goalscape-radial-view";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_SIZE = 1000; // viewBox 逻辑尺寸，实际随容器缩放
const CX = VIEW_SIZE / 2;
const CY = VIEW_SIZE / 2;
const MAX_R = VIEW_SIZE / 2 - 20;

/** 进度 → 色阶（红→橙→黄→绿） */
const PROGRESS_STOPS = ["#f87171", "#fb923c", "#fbbf24", "#4ade80"];

/** 跨视图的剪贴板（深拷贝后的子树） */
let clipboardSubtree: GoalNode | null = null;
let clipboardMode: "copy" | "cut" | null = null;

export class RadialGoalMapView extends ItemView {
  private unsubscribe?: () => void;
  private selectedId: string | null = null;
  private rootEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: GoalscapePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_RADIAL;
  }
  getDisplayText(): string {
    return "Goalscape Radial";
  }
  getIcon(): string {
    return "target";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("goalscape-container");
    this.rootEl = this.contentEl.createDiv({ cls: "goalscape-radial-root" });
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  // ──────────────────────────── 渲染 ────────────────────────────

  private render(): void {
    const scape = this.plugin.store.scape;
    this.rootEl.empty();
    if (!scape) return;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`);
    svg.addClass("goalscape-radial-svg");
    this.rootEl.appendChild(svg);

    // 可见最大深度（折叠的节点不计其子层），用于把半径均匀分配到可见层
    const maxDepth = this.visibleDepth(scape.mainGoal, 0);
    const ringCount = Math.max(1, maxDepth);
    const ringW = MAX_R / ringCount;

    const drawNode = (
      node: GoalNode,
      depth: number,
      startAngle: number,
      endAngle: number
    ) => {
      const span = endAngle - startAngle;
      if (span <= 0.0005) return; // 权重过小的扇区跳过，避免病态路径
      const rInner = depth * ringW;
      const rOuter = (depth + 1) * ringW;

      // ① 扇环路径
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", arcPath(CX, CY, rInner, rOuter, startAngle, endAngle));
      path.setAttribute("fill", this.colorFor(node));
      path.setAttribute("stroke", "var(--background-primary)");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("data-id", node.id);
      if (node.id === this.selectedId) path.addClass("goalscape-selected");
      if (node.collapsed && node.children.length) path.addClass("goalscape-collapsed");
      path.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectedId = node.id;
        this.render();
      });
      path.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectedId = node.id;
        this.showContextMenu(e as MouseEvent, node);
      });
      svg.appendChild(path);

      // ② 中点标签（扇区太窄时不渲染文字）
      if (span > 0.08 && ringW > 30) {
        const midAngle = (startAngle + endAngle) / 2;
        const rMid = (rInner + rOuter) / 2;
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(CX + Math.cos(midAngle) * rMid));
        label.setAttribute("y", String(CY + Math.sin(midAngle) * rMid));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "middle");
        label.addClass("goalscape-label");
        const deg = (midAngle * 180) / Math.PI;
        if (depth > 0 && (deg > 90 && deg < 270)) {
          label.setAttribute(
            "transform",
            `rotate(${deg + 180} ${CX + Math.cos(midAngle) * rMid} ${
              CY + Math.sin(midAngle) * rMid
            })`
          );
        } else if (depth > 0) {
          label.setAttribute(
            "transform",
            `rotate(${deg} ${CX + Math.cos(midAngle) * rMid} ${
              CY + Math.sin(midAngle) * rMid
            })`
          );
        }
        label.textContent = `${node.title} ${node.progress ?? 0}%`;
        svg.appendChild(label);
      }

      // ③ 递归：子节点按权重切分父扇区角度；collapsed 时不渲染子层
      if (node.collapsed) return;
      const total = node.children.reduce((s, c) => s + c.importance, 0);
      if (total <= 0) return;
      let cursor = startAngle;
      for (const c of node.children) {
        const cSpan = (c.importance / total) * span;
        drawNode(c, depth + 1, cursor, cursor + cSpan);
        cursor += cSpan;
      }
    };

    drawNode(scape.mainGoal, 0, -Math.PI / 2, Math.PI * 1.5);

    // 点击空白处取消选中
    svg.addEventListener("click", () => {
      if (this.selectedId) {
        this.selectedId = null;
        this.render();
      }
    });
  }

  /** 可见深度：collapsed 节点算作当前层的末端 */
  private visibleDepth(node: GoalNode, depth: number): number {
    if (!node.children.length || node.collapsed) return depth;
    return Math.max(...node.children.map((c) => this.visibleDepth(c, depth + 1)));
  }

  private colorFor(node: GoalNode): string {
    if (node.color) return node.color;
    const p = node.progress ?? 0;
    const idx = Math.min(PROGRESS_STOPS.length - 1, Math.floor(p / 25));
    return PROGRESS_STOPS[idx];
  }

  // ──────────────────────────── 交互 ────────────────────────────

  private showContextMenu(event: MouseEvent, node: GoalNode): void {
    const menu = new Menu();
    const isMain = node.id === this.plugin.store.scape.mainGoal.id;

    // 折叠/展开
    if (node.children.length) {
      menu.addItem((item) =>
        item
          .setTitle(node.collapsed ? "Expand" : "Collapse")
          .setIcon(node.collapsed ? "unfold-vertical" : "fold-vertical")
          .onClick(() => {
            this.plugin.store.mutate((s) => {
              const target = this.findInScape(s, node.id);
              if (target) target.collapsed = !target.collapsed;
            });
          })
      );
    }

    menu.addSeparator();

    // 新增
    menu.addItem((item) =>
      item
        .setTitle("Add subgoal")
        .setIcon("plus")
        .onClick(async () => {
          const title = await promptInput(this.app, "New subgoal", "New Goal");
          if (title === null) return;
          this.plugin.store.mutate((s) => addGoal(s, node.id, "child", title));
        })
    );
    if (!isMain) {
      menu.addItem((item) =>
        item
          .setTitle("Add sibling")
          .setIcon("plus-circle")
          .onClick(async () => {
            const title = await promptInput(this.app, "New sibling goal", "New Goal");
            if (title === null) return;
            this.plugin.store.mutate((s) => addGoal(s, node.id, "sibling", title));
          })
      );
    }

    // 编辑
    menu.addItem((item) =>
      item
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(async () => {
          const title = await promptInput(this.app, "Rename goal", node.title);
          if (title === null || title === node.title) return;
          this.plugin.store.mutate((s) => renameGoal(s, node.id, title));
        })
    );

    if (!node.children.length) {
      menu.addItem((item) =>
        item
          .setTitle("Set progress")
          .setIcon("gauge")
          .onClick(async () => {
            const raw = await promptInput(
              this.app,
              "Progress (0-100)",
              String(node.progress ?? 0)
            );
            if (raw === null) return;
            const progress = Math.max(0, Math.min(100, Math.round(Number(raw))));
            if (Number.isNaN(progress)) return;
            this.plugin.store.mutate((s) => {
              const target = this.findInScape(s, node.id);
              if (target) target.progress = progress;
            });
          })
      );
    }

    menu.addSeparator();

    // 剪切/复制/粘贴
    if (!isMain) {
      menu.addItem((item) =>
        item
          .setTitle("Cut")
          .setIcon("scissors")
          .onClick(() => {
            const extracted = extractSubtree(this.plugin.store.scape, node.id);
            if (extracted) {
              clipboardSubtree = extracted;
              clipboardMode = "cut";
              this.plugin.store.mutate((s) => deleteGoal(s, node.id));
              new Notice("Goal cut to clipboard");
            }
          })
      );
      menu.addItem((item) =>
        item
          .setTitle("Copy")
          .setIcon("copy")
          .onClick(() => {
            const extracted = extractSubtree(this.plugin.store.scape, node.id);
            if (extracted) {
              clipboardSubtree = extracted;
              clipboardMode = "copy";
              new Notice("Goal copied to clipboard");
            }
          })
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("Paste as child")
        .setIcon("clipboard")
        .setDisabled(!clipboardSubtree)
        .onClick(() => {
          if (!clipboardSubtree) return;
          this.plugin.store.mutate((s) =>
            pasteSubtree(s, node.id, "child", clipboardSubtree!)
          );
          if (clipboardMode === "cut") {
            clipboardSubtree = null;
            clipboardMode = null;
          }
        })
    );

    menu.addSeparator();

    // 删除
    if (!isMain) {
      menu.addItem((item) =>
        item
          .setTitle("Delete")
          .setIcon("trash-2")
          .onClick(() => {
            this.plugin.store.mutate((s) => deleteGoal(s, node.id));
            if (this.selectedId === node.id) this.selectedId = null;
          })
      );
    }

    menu.addItem((item) =>
      item
        .setTitle("Center on this goal (coming in Phase 3)")
        .setIcon("locate-fixed")
        .setDisabled(true)
    );

    menu.showAtMouseEvent(event);
  }

  private findInScape(scape: { mainGoal: GoalNode }, id: string): GoalNode | null {
    const stack: GoalNode[] = [scape.mainGoal];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      stack.push(...n.children);
    }
    return null;
  }
}

/** 轻量输入弹窗：返回用户输入字符串，取消/关闭返回 null */
function promptInput(app: any, title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new PromptModal(app, title, initial, resolve);
    modal.open();
  });
}

class PromptModal extends Modal {
  private value = "";

  constructor(
    app: any,
    private titleText: string,
    private initial: string,
    private onSubmit: (value: string | null) => void
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.titleText });

    new Setting(contentEl)
      .setName("Value")
      .addText((text) => {
        text.setValue(this.initial);
        text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.close();
            this.onSubmit(this.value);
          }
        });
        text.onChange((v) => (this.value = v));
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Confirm").onClick(() => {
          this.close();
          this.onSubmit(this.value);
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
          this.onSubmit(null);
        })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 生成扇环 SVG path。depth 0 时为整圆。 */
export function arcPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startAngle: number,
  endAngle: number
): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  if (rInner <= 0) {
    // 整圆/扇形：外弧 + 回到圆心
    return [
      `M ${cx} ${cy}`,
      `L ${p(rOuter, startAngle)}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p(rOuter, endAngle)}`,
      "Z",
    ].join(" ");
  }
  return [
    `M ${p(rOuter, startAngle)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p(rOuter, endAngle)}`,
    `L ${p(rInner, endAngle)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p(rInner, startAngle)}`,
    "Z",
  ].join(" ");
}
