// src/views/radialView.ts
// Goalscape 放射图视图（Phase 1–3 完整：渲染 + Collapse/Expand + 选中高亮 + CRUD 右键菜单
// + 右侧信息面板 + 权重拖拽手柄 + 拖拽重挂载 + Focus Filter）。
// 纯 SVG 自研扇区布局：权重决定扇区角度，进度决定颜色深浅，深度决定环半径。

import { ItemView, WorkspaceLeaf, Menu, Notice } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode, flattenTree } from "../data/types";
import {
  addGoal,
  deleteGoal,
  renameGoal,
  adjustImportance,
  extractSubtree,
  pasteSubtree,
  moveGoal,
} from "../data/crud";
import { promptInput } from "./promptModal";
import { InfoPanel } from "./infoPanel";
import { FocusFilter, FilterCriteria } from "./focusFilter";

export const VIEW_RADIAL = "goalscape-radial-view";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_SIZE = 1000;
const CX = VIEW_SIZE / 2;
const CY = VIEW_SIZE / 2;
const MAX_R = VIEW_SIZE / 2 - 20;

const PROGRESS_STOPS = ["#f87171", "#fb923c", "#fbbf24", "#4ade80"];

let clipboardSubtree: GoalNode | null = null;
let clipboardMode: "copy" | "cut" | null = null;

interface WeightDragState {
  nodeId: string;
  startAngle: number;
  parentStart: number;
  parentEnd: number;
  svg: SVGSVGElement;
}

interface ReparentDragState {
  nodeId: string;
  svg: SVGSVGElement;
  startX: number;
  startY: number;
  active: boolean;
  ghostEl: HTMLElement | null;
}

export class RadialGoalMapView extends ItemView {
  private unsubscribe?: () => void;
  private selectedId: string | null = null;
  private rootEl!: HTMLElement;
  private infoPanel!: InfoPanel;
  private filterBar!: FocusFilter;
  private filterCriteria: FilterCriteria = {};
  private dragState: WeightDragState | null = null;
  private reparentDrag: ReparentDragState | null = null;
  private nodePositions = new Map<string, { startAngle: number; endAngle: number; depth: number }>();

  constructor(leaf: WorkspaceLeaf, private plugin: GoalscapePlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_RADIAL; }
  getDisplayText(): string { return "Goalscape Radial"; }
  getIcon(): string { return "target"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("goalscape-container");

    const toolbar = this.contentEl.createDiv({ cls: "goalscape-toolbar" });
    this.filterBar = new FocusFilter(toolbar, this.plugin, (criteria) => {
      this.filterCriteria = criteria;
      this.render();
    });

    const mainRow = this.contentEl.createDiv({ cls: "goalscape-main-row" });
    this.rootEl = mainRow.createDiv({ cls: "goalscape-radial-root" });
    const panelEl = mainRow.createDiv({ cls: "goalscape-panel" });
    this.infoPanel = new InfoPanel(panelEl, this.plugin);
    this.infoPanel.show(this.selectedId);

    this.unsubscribe = this.plugin.store.subscribe(() => {
      this.render();
      this.infoPanel.refresh();
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private select(id: string | null): void {
    this.selectedId = id;
    this.render();
    this.infoPanel.show(id);
  }

  // ──────────────────────────── 渲染 ────────────────────────────

  private render(): void {
    const scape = this.plugin.store.scape;
    this.rootEl.empty();
    this.nodePositions.clear();
    if (!scape) return;

    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`);
    svg.addClass("goalscape-radial-svg");
    this.rootEl.appendChild(svg);

    const maxDepth = this.visibleDepth(scape.mainGoal, 0);
    // 环数 = 最深 depth 索引 + 1（depth 从 0 起）；写成 maxDepth 会让最外环画到 MAX_R 之外被裁切
    const ringCount = maxDepth + 1;
    const ringW = MAX_R / ringCount;

    const matchingIds = this.computeMatchingIds(scape);

    const drawNode = (
      node: GoalNode,
      depth: number,
      startAngle: number,
      endAngle: number,
      parentStart: number,
      parentEnd: number
    ) => {
      const span = endAngle - startAngle;
      if (span <= 0.0005) return;
      const rInner = depth * ringW;
      const rOuter = (depth + 1) * ringW;

      this.nodePositions.set(node.id, { startAngle, endAngle, depth });

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", arcPath(CX, CY, rInner, rOuter, startAngle, endAngle));
      path.setAttribute("fill", this.colorFor(node));
      path.setAttribute("stroke", "var(--background-primary)");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("data-id", node.id);
      if (node.id === this.selectedId) path.addClass("goalscape-selected");
      if (node.collapsed && node.children.length) path.addClass("goalscape-collapsed");
      if (matchingIds && !matchingIds.has(node.id)) path.addClass("goalscape-dimmed");

      path.addEventListener("click", (e) => {
        e.stopPropagation();
        this.select(node.id);
      });
      path.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(node.id);
        this.showContextMenu(e as MouseEvent, node);
      });
      path.addEventListener("pointerdown", (e) => {
        if (depth === 0) return;
        this.startReparentDrag(e as PointerEvent, svg, node.id);
      });
      svg.appendChild(path);

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
        if (depth > 0 && deg > 90 && deg < 270) {
          label.setAttribute("transform",
            `rotate(${deg + 180} ${CX + Math.cos(midAngle) * rMid} ${CY + Math.sin(midAngle) * rMid})`);
        } else if (depth > 0) {
          label.setAttribute("transform",
            `rotate(${deg} ${CX + Math.cos(midAngle) * rMid} ${CY + Math.sin(midAngle) * rMid})`);
        }
        label.textContent = `${node.title} ${node.progress ?? 0}%`;
        svg.appendChild(label);
      }

      if (node.id === this.selectedId && depth > 0) {
        const midAngle = (startAngle + endAngle) / 2;
        const handle = document.createElementNS(SVG_NS, "circle");
        handle.setAttribute("cx", String(CX + Math.cos(midAngle) * rOuter));
        handle.setAttribute("cy", String(CY + Math.sin(midAngle) * rOuter));
        handle.setAttribute("r", "9");
        handle.addClass("goalscape-weight-handle");
        handle.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          this.startWeightDrag(e as PointerEvent, svg, node.id, startAngle, parentStart, parentEnd);
        });
        svg.appendChild(handle);
      }

      if (node.collapsed) return;
      const total = node.children.reduce((s, c) => s + c.importance, 0);
      if (total <= 0) return;
      let cursor = startAngle;
      for (const c of node.children) {
        const cSpan = (c.importance / total) * span;
        drawNode(c, depth + 1, cursor, cursor + cSpan, startAngle, endAngle);
        cursor += cSpan;
      }
    };

    drawNode(scape.mainGoal, 0, -Math.PI / 2, Math.PI * 1.5, -Math.PI / 2, Math.PI * 1.5);

    svg.addEventListener("click", () => {
      if (this.selectedId) this.select(null);
    });
  }

  private computeMatchingIds(scape: { mainGoal: GoalNode }): Set<string> | null {
    const c = this.filterCriteria;
    if (!c.tag && !c.responsible && c.minProgress === undefined && c.maxProgress === undefined && !c.color && !c.dueBefore && !c.dueAfter) {
      return null;
    }
    const all = flattenTree(scape.mainGoal);
    const matching = new Set<string>();
    for (const node of all) {
      let pass = true;
      if (c.tag && !node.tags.some((t) => t.toLowerCase().includes(c.tag!.toLowerCase()))) pass = false;
      if (c.responsible && !node.responsible.some((r) => r.toLowerCase().includes(c.responsible!.toLowerCase()))) pass = false;
      if (c.minProgress !== undefined && (node.progress ?? 0) < c.minProgress) pass = false;
      if (c.maxProgress !== undefined && (node.progress ?? 0) > c.maxProgress) pass = false;
      if (c.color && node.color !== c.color) pass = false;
      if (c.dueBefore && node.due && node.due > c.dueBefore) pass = false;
      if (c.dueAfter && node.due && node.due < c.dueAfter) pass = false;
      if (pass) matching.add(node.id);
    }
    return matching;
  }

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

  // ──────────────────────────── 权重拖拽 ────────────────────────────

  private startWeightDrag(
    e: PointerEvent, svg: SVGSVGElement, nodeId: string,
    startAngle: number, parentStart: number, parentEnd: number
  ): void {
    e.preventDefault();
    e.stopPropagation();
    this.select(nodeId);
    this.dragState = { nodeId, startAngle, parentStart, parentEnd, svg };
    const move = (ev: PointerEvent) => this.onWeightDragMove(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.dragState = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private onWeightDragMove(e: PointerEvent): void {
    const drag = this.dragState;
    if (!drag) return;
    const point = this.toLogicalPoint(drag.svg, e.clientX, e.clientY);
    let angle = Math.atan2(point.y - CY, point.x - CX);
    while (angle < drag.parentStart) angle += Math.PI * 2;
    while (angle >= drag.parentStart + Math.PI * 2) angle -= Math.PI * 2;
    const parentSpan = drag.parentEnd - drag.parentStart;
    if (parentSpan <= 0) return;
    const rawSpan = angle - drag.startAngle;
    const span = Math.max(0, Math.min(parentSpan, rawSpan));
    const fraction = span / parentSpan;
    const target = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    this.plugin.store.mutate((s) => adjustImportance(s, drag.nodeId, target));
  }

  // ──────────────────────────── 拖拽重挂载 ────────────────────────────

  private startReparentDrag(e: PointerEvent, svg: SVGSVGElement, nodeId: string): void {
    if (e.button !== 0) return;
    this.reparentDrag = { nodeId, svg, startX: e.clientX, startY: e.clientY, active: false, ghostEl: null };

    const move = (ev: PointerEvent) => {
      const drag = this.reparentDrag;
      if (!drag) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.active && Math.hypot(dx, dy) > 8) {
        drag.active = true;
        this.selectedId = null;
        this.render();
        drag.ghostEl = document.createElement("div");
        drag.ghostEl.addClass("goalscape-drag-ghost");
        drag.ghostEl.textContent = this.getNodeTitle(drag.nodeId);
        document.body.appendChild(drag.ghostEl);
      }
      if (drag.active && drag.ghostEl) {
        drag.ghostEl.style.left = `${ev.clientX + 12}px`;
        drag.ghostEl.style.top = `${ev.clientY + 12}px`;
        const targetId = this.hitTestNode(drag.svg, ev.clientX, ev.clientY);
        this.highlightDropTarget(targetId);
      }
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const drag = this.reparentDrag;
      this.reparentDrag = null;
      this.clearDropHighlight();
      if (!drag) return;
      if (drag.ghostEl) { drag.ghostEl.remove(); drag.ghostEl = null; }
      if (!drag.active) {
        this.select(drag.nodeId);
        return;
      }
      const targetId = this.hitTestNode(drag.svg, ev.clientX, ev.clientY);
      if (targetId && targetId !== drag.nodeId) {
        let ok = false;
        this.plugin.store.mutate((s) => { ok = moveGoal(s, drag.nodeId, targetId); });
        if (!ok) new Notice("Cannot move goal there (cycle or same parent)");
      }
      this.render();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private hitTestNode(svg: SVGSVGElement, clientX: number, clientY: number): string | null {
    const point = this.toLogicalPoint(svg, clientX, clientY);
    const dx = point.x - CX;
    const dy = point.y - CY;
    const r = Math.hypot(dx, dy);
    if (r > MAX_R) return null;
    let angle = Math.atan2(dy, dx);

    const scape = this.plugin.store.scape;
    if (!scape) return null;
    const maxDepth = this.visibleDepth(scape.mainGoal, 0);
    // 环数 = 最深 depth 索引 + 1（depth 从 0 起）；写成 maxDepth 会让最外环画到 MAX_R 之外被裁切
    const ringCount = maxDepth + 1;
    const ringW = MAX_R / ringCount;
    const depth = Math.floor(r / ringW);

    for (const [id, pos] of this.nodePositions) {
      if (pos.depth !== depth) continue;
      let a = angle;
      while (a < pos.startAngle) a += Math.PI * 2;
      if (a >= pos.startAngle && a <= pos.endAngle) return id;
    }
    return null;
  }

  private highlightDropTarget(targetId: string | null): void {
    const svg = this.rootEl.querySelector("svg");
    if (!svg) return;
    svg.querySelectorAll(".goalscape-drop-target").forEach((el) => el.removeClass("goalscape-drop-target"));
    if (targetId) {
      const el = svg.querySelector(`[data-id="${targetId}"]`);
      if (el) el.addClass("goalscape-drop-target");
    }
  }

  private clearDropHighlight(): void {
    const svg = this.rootEl.querySelector("svg");
    if (!svg) return;
    svg.querySelectorAll(".goalscape-drop-target").forEach((el) => el.removeClass("goalscape-drop-target"));
  }

  private getNodeTitle(id: string): string {
    const scape = this.plugin.store.scape;
    if (!scape) return "";
    const all = flattenTree(scape.mainGoal);
    return all.find((n) => n.id === id)?.title ?? "";
  }

  private toLogicalPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: CX, y: CY };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  // ──────────────────────────── 右键菜单 ────────────────────────────

  private showContextMenu(event: MouseEvent, node: GoalNode): void {
    const menu = new Menu();
    const isMain = node.id === this.plugin.store.scape.mainGoal.id;

    if (node.children.length) {
      menu.addItem((item) =>
        item.setTitle(node.collapsed ? "Expand" : "Collapse")
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

    menu.addItem((item) =>
      item.setTitle("Add subgoal").setIcon("plus")
        .onClick(async () => {
          const title = await promptInput(this.app, "New subgoal", "New Goal");
          if (title === null) return;
          this.plugin.store.mutate((s) => addGoal(s, node.id, "child", title));
        })
    );
    if (!isMain) {
      menu.addItem((item) =>
        item.setTitle("Add sibling").setIcon("plus-circle")
          .onClick(async () => {
            const title = await promptInput(this.app, "New sibling goal", "New Goal");
            if (title === null) return;
            this.plugin.store.mutate((s) => addGoal(s, node.id, "sibling", title));
          })
      );
    }

    menu.addItem((item) =>
      item.setTitle("Rename").setIcon("pencil")
        .onClick(async () => {
          const title = await promptInput(this.app, "Rename goal", node.title);
          if (title === null || title === node.title) return;
          this.plugin.store.mutate((s) => renameGoal(s, node.id, title));
        })
    );

    if (!node.children.length) {
      menu.addItem((item) =>
        item.setTitle("Set progress").setIcon("gauge")
          .onClick(async () => {
            const raw = await promptInput(this.app, "Progress (0-100)", String(node.progress ?? 0));
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

    if (!isMain) {
      menu.addItem((item) =>
        item.setTitle("Cut").setIcon("scissors")
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
        item.setTitle("Copy").setIcon("copy")
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
      item.setTitle("Paste as child").setIcon("clipboard")
        .setDisabled(!clipboardSubtree)
        .onClick(() => {
          if (!clipboardSubtree) return;
          this.plugin.store.mutate((s) => pasteSubtree(s, node.id, "child", clipboardSubtree!));
          if (clipboardMode === "cut") { clipboardSubtree = null; clipboardMode = null; }
        })
    );

    menu.addSeparator();

    if (!isMain) {
      menu.addItem((item) =>
        item.setTitle("Delete").setIcon("trash-2")
          .onClick(() => {
            this.plugin.store.mutate((s) => deleteGoal(s, node.id));
            if (this.selectedId === node.id) this.select(null);
          })
      );
    }

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

const FULL_CIRCLE_EPSILON = 1e-4;

export function arcPath(
  cx: number, cy: number, rInner: number, rOuter: number,
  startAngle: number, endAngle: number
): string {
  if (endAngle - startAngle >= Math.PI * 2 - FULL_CIRCLE_EPSILON) {
    endAngle = startAngle + Math.PI * 2 - FULL_CIRCLE_EPSILON;
  }
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  if (rInner <= 0) {
    return [`M ${cx} ${cy}`, `L ${p(rOuter, startAngle)}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p(rOuter, endAngle)}`, "Z"].join(" ");
  }
  return [
    `M ${p(rOuter, startAngle)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p(rOuter, endAngle)}`,
    `L ${p(rInner, endAngle)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p(rInner, startAngle)}`,
    "Z",
  ].join(" ");
}
