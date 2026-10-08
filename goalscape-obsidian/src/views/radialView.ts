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

/** 把 #rrggbb 按 percent 混色：正值向白提亮、负值向黑压暗，用于拉开环层与同级扇区的对比 */
function shadeColor(hex: string, percent: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const t = Math.max(-100, Math.min(100, percent)) / 100;
  const target = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  const mix = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (target - c) * k);
  };
  const r = mix(16), g = mix(8), b = mix(0);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

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
    this.buildActions(toolbar);
    const filterWrap = toolbar.createDiv({ cls: "goalscape-filter-wrap" });
    this.filterBar = new FocusFilter(filterWrap, this.plugin, (criteria) => {
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

  private mapSelect!: HTMLSelectElement;

  private buildActions(toolbar: HTMLElement): void {
    const actions = toolbar.createDiv({ cls: "goalscape-actions" });

    this.mapSelect = actions.createEl("select", { cls: "goalscape-map-select" });
    this.mapSelect.addEventListener("change", () => {
      void this.plugin.switchGoalscape(this.mapSelect.value);
    });

    const mk = (text: string, cls: string, onClick: () => void) => {
      const b = actions.createEl("button", { cls: `goalscape-btn ${cls}`.trim(), text });
      b.addEventListener("click", onClick);
      return b;
    };

    mk("New map", "", () => void this.newMap());
    mk("+ Subgoal", "", () => void this.addViaToolbar("child"));
    mk("+ Sibling", "", () => void this.addViaToolbar("sibling"));
    mk("Delete", "goalscape-btn-danger", () => this.deleteSelected());

    this.refreshMapList();
  }

  refreshMapList(): void {
    if (!this.mapSelect) return;
    const current = this.plugin.store.path;
    const maps = this.plugin.listGoalscapes();
    this.mapSelect.empty();
    for (const p of maps) {
      const name = p.split("/").pop()!.replace(/\.goalscape\.json$/, "");
      const opt = this.mapSelect.createEl("option", { value: p, text: name });
      if (p === current) opt.selected = true;
    }
    if (!maps.includes(current)) {
      const opt = this.mapSelect.createEl("option", { value: current, text: current.split("/").pop()!.replace(/\.goalscape\.json$/, "") });
      opt.selected = true;
    }
  }

  private async newMap(): Promise<void> {
    const name = await promptInput(this.app, "New goalscape name", "My Goalscape");
    if (!name || !name.trim()) return;
    await this.plugin.createGoalscape(name.trim());
    this.select(null);
    this.refreshMapList();
  }

  private async addViaToolbar(position: "child" | "sibling"): Promise<void> {
    const scape = this.plugin.store.scape;
    if (!scape) return;
    if (position === "sibling" && !this.selectedId) {
      new Notice("Select a goal first");
      return;
    }
    const refId = this.selectedId ?? scape.mainGoal.id;
    const title = await promptInput(this.app, position === "child" ? "New subgoal" : "New sibling goal", "New Goal");
    if (title === null) return;
    this.plugin.store.mutate((s) => addGoal(s, refId, position, title));
  }

  private deleteSelected(): void {
    if (!this.selectedId) {
      new Notice("Select a goal first");
      return;
    }
    const id = this.selectedId;
    this.plugin.store.mutate((s) => deleteGoal(s, id));
    this.select(null);
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
    const RING_GAP = Math.min(5, ringW * 0.045);
    // 扇区之间的留白按"弧长"而非固定角度：外环半径大，同样角度会裂出很宽的缝
    const SECTOR_GAP_ARC = 7;

    const matchingIds = this.computeMatchingIds(scape);

    const drawNode = (
      node: GoalNode,
      depth: number,
      startAngle: number,
      endAngle: number,
      parentStart: number,
      parentEnd: number,
      siblingIndex = 0
    ) => {
      const span = endAngle - startAngle;
      if (span <= 0.0005) return;
      const rInnerRaw = depth * ringW;
      const rOuterRaw = (depth + 1) * ringW;

      this.nodePositions.set(node.id, { startAngle, endAngle, depth });

      const rInner = depth === 0 ? 0 : rInnerRaw + RING_GAP;
      const rOuter = rOuterRaw - RING_GAP;
      const pad = depth === 0 ? 0 : Math.min(span * 0.1, SECTOR_GAP_ARC / rOuter);
      const a0 = startAngle + pad;
      const a1 = endAngle - pad;

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", arcPath(CX, CY, rInner, rOuter, a0, a1));
      path.setAttribute("fill", this.colorFor(node, depth, siblingIndex));
      path.setAttribute("stroke", "var(--background-primary)");
      path.setAttribute("stroke-width", "1");
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

      const midAngle = (startAngle + endAngle) / 2;
      if (depth === 0) {
        // 根节点：标题水平居中于 hub，下方显示整体进度
        const title = document.createElementNS(SVG_NS, "text");
        title.setAttribute("x", String(CX));
        title.setAttribute("y", String(CY - 8));
        title.setAttribute("text-anchor", "middle");
        title.setAttribute("dominant-baseline", "middle");
        title.addClass("goalscape-label", "goalscape-label-root");
        title.textContent = node.title;
        svg.appendChild(title);
        const pct = document.createElementNS(SVG_NS, "text");
        pct.setAttribute("x", String(CX));
        pct.setAttribute("y", String(CY + 16));
        pct.setAttribute("text-anchor", "middle");
        pct.setAttribute("dominant-baseline", "middle");
        pct.addClass("goalscape-label", "goalscape-label-root-pct");
        pct.textContent = `${node.progress ?? 0}%`;
        svg.appendChild(pct);
      } else if (span > 0.14 && rOuter - rInner > 24) {
        const rMid = (rInner + rOuter) / 2;
        const lx = CX + Math.cos(midAngle) * rMid;
        const ly = CY + Math.sin(midAngle) * rMid;
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(lx));
        label.setAttribute("y", String(ly));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "middle");
        label.addClass("goalscape-label");
        const deg = (midAngle * 180) / Math.PI;
        const flip = deg > 90 && deg < 270;
        label.setAttribute("transform", `rotate(${flip ? deg + 180 : deg} ${lx} ${ly})`);
        label.textContent = span > 0.28 ? `${node.title} ${node.progress ?? 0}%` : node.title;
        svg.appendChild(label);
      }

      if (node.id === this.selectedId && depth > 0) {
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
      node.children.forEach((c, i) => {
        const cSpan = (c.importance / total) * span;
        drawNode(c, depth + 1, cursor, cursor + cSpan, startAngle, endAngle, i);
        cursor += cSpan;
      });
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

  private colorFor(node: GoalNode, depth: number, siblingIndex = 0): string {
    const base = node.color || PROGRESS_STOPS[Math.min(PROGRESS_STOPS.length - 1, Math.floor((node.progress ?? 0) / 25))];
    // 中心盘压暗、外环逐层提亮，再按同级序号微调明度：
    // 进度全相同（如整树 0%）时也能分辨环层与相邻扇区
    if (depth === 0) return shadeColor(base, -22);
    return shadeColor(base, Math.min(depth, 4) * 9 + (siblingIndex % 3) * 6);
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
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  // 整圆（根节点跨度恰为 2π）：用两段半圆弧闭合成圆/环，避免"中心→顶点→绕回→中心"
  // 的两条半径描边在起点处叠成一条可见黑线（此前根扇区的接缝 bug）。
  if (endAngle - startAngle >= Math.PI * 2 - FULL_CIRCLE_EPSILON) {
    const a0 = startAngle;
    const a1 = startAngle + Math.PI;
    const outer = [
      `M ${p(rOuter, a0)}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${p(rOuter, a1)}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${p(rOuter, a0)}`,
      "Z",
    ];
    if (rInner <= 0) return outer.join(" ");
    const inner = [
      `M ${p(rInner, a0)}`,
      `A ${rInner} ${rInner} 0 1 0 ${p(rInner, a1)}`,
      `A ${rInner} ${rInner} 0 1 0 ${p(rInner, a0)}`,
      "Z",
    ];
    return outer.join(" ") + " " + inner.join(" ");
  }
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
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
