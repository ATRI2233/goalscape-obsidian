// src/views/radialView.ts
// Goalscape 放射图视图：工具栏 + SVG 渲染 + 选中态。
// 几何/配色在 radialGeometry.ts，两类拖拽在 radialDrag.ts，右键菜单在 radialMenu.ts，
// 过滤谓词在 focusFilter.ts —— 本文件只负责把它们接到 Obsidian 的 ItemView 生命周期上。

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode, flattenTree, findNode } from "../data/types";
import { addGoal, deleteGoal } from "../data/crud";
import { promptInput } from "./promptModal";
import { InfoPanel } from "./infoPanel";
import { FocusFilter, FilterCriteria, collectMatchingIds } from "./focusFilter";
import {
  SVG_NS, VIEW_SIZE, CX, CY,
  arcPath, labelInk, nodeColor, ringGeometry, sectorEdges, visibleDepth,
  RingGeometry, SectorAngles,
} from "./radialGeometry";
import { DragSurface, ReparentDragController, WeightDragController } from "./radialDrag";
import { buildGoalMenu, confirmDeleteGoal } from "./radialMenu";

export const VIEW_RADIAL = "goalscape-radial-view";

export class RadialGoalMapView extends ItemView {
  private unsubscribe?: () => void;
  private selectedId: string | null = null;
  private rootEl!: HTMLElement;
  private infoPanel!: InfoPanel;
  private filterBar!: FocusFilter;
  private filterCriteria: FilterCriteria = {};
  private nodePositions = new Map<string, SectorAngles>();
  private weightDrag!: WeightDragController;
  private reparentDrag!: ReparentDragController;

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

    this.weightDrag = new WeightDragController(this.plugin.store, this.dragSurface());
    this.reparentDrag = new ReparentDragController(this.plugin.store, this.dragSurface());

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

  // ──────────────────────────── 对外接口（供 main.ts 调用） ────────────────────────────

  /** 导出用：始终返回文档里当前那个 svg */
  getSvg(): SVGSVGElement | null {
    return this.liveSvg();
  }

  clearSelection(): void {
    this.select(null);
  }

  // ──────────────────────────── 工具栏 ────────────────────────────

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
    this.clearSelection();
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

  private async deleteSelected(): Promise<void> {
    if (!this.selectedId) {
      new Notice("Select a goal first");
      return;
    }
    const id = this.selectedId;
    const scape = this.plugin.store.scape;
    const found = scape ? findNode(scape.mainGoal, id) : null;
    if (!found || !(await confirmDeleteGoal(this.app, found.node))) return;
    this.plugin.store.mutate((s) => deleteGoal(s, id));
    this.clearSelection();
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

    const ring = ringGeometry(visibleDepth(scape.mainGoal));
    const matchingIds = collectMatchingIds(scape, this.filterCriteria);

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
      this.nodePositions.set(node.id, { startAngle, endAngle, depth });

      const { rInner, rOuter, a0, a1 } = sectorEdges(depth, startAngle, endAngle, ring);
      const color = nodeColor(node, depth, siblingIndex);
      const ink = labelInk(color);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", arcPath(CX, CY, rInner, rOuter, a0, a1));
      path.setAttribute("fill", color);
      path.setAttribute("stroke", "var(--background-primary)");
      path.setAttribute("stroke-width", "1");
      path.setAttribute("data-id", node.id);
      if (node.id === this.selectedId) path.addClass("goalscape-selected");
      if (node.collapsed && node.children.length) path.addClass("goalscape-collapsed");
      if (matchingIds && !matchingIds.has(node.id)) path.addClass("goalscape-dimmed");

      path.addEventListener("click", (e) => {
        // 挡住冒泡，否则 svg 空白处的"点击清除选中"会把刚选中的节点又清掉。
        // 外环扇区的选中来自 reparent 的 pointerup；中心盘不参与拖拽，只能在这里选中。
        e.stopPropagation();
        if (depth === 0) this.select(node.id);
      });
      path.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(node.id);
        this.showContextMenu(e as MouseEvent, node);
      });
      path.addEventListener("pointerdown", (e) => {
        if (depth === 0) return;
        this.reparentDrag.start(e as PointerEvent, node.id);
      });
      svg.appendChild(path);

      const midAngle = (startAngle + endAngle) / 2;
      if (depth === 0) {
        // 根节点：标题水平居中于 hub，下方显示整体进度
        const title = this.addText(svg, CX, CY - 8, ink, ["goalscape-label", "goalscape-label-root"]);
        title.textContent = node.title;
        const pct = this.addText(svg, CX, CY + 16, ink, ["goalscape-label", "goalscape-label-root-pct"]);
        pct.textContent = `${node.progress ?? 0}%`;
      } else if (span > 0.14 && rOuter - rInner > 24) {
        const rMid = (rInner + rOuter) / 2;
        const lx = CX + Math.cos(midAngle) * rMid;
        const ly = CY + Math.sin(midAngle) * rMid;
        const label = this.addText(svg, lx, ly, ink, ["goalscape-label"]);
        const deg = (midAngle * 180) / Math.PI;
        const flip = deg > 90 && deg < 270;
        label.setAttribute("transform", `rotate(${flip ? deg + 180 : deg} ${lx} ${ly})`);
        label.textContent = span > 0.28 ? `${node.title} ${node.progress ?? 0}%` : node.title;
      }

      if (node.id === this.selectedId && depth > 0) {
        const handle = document.createElementNS(SVG_NS, "circle");
        handle.setAttribute("cx", String(CX + Math.cos(midAngle) * rOuter));
        handle.setAttribute("cy", String(CY + Math.sin(midAngle) * rOuter));
        handle.setAttribute("r", "9");
        handle.addClass("goalscape-weight-handle");
        handle.addEventListener("pointerdown", (e) => {
          this.weightDrag.start(e as PointerEvent, node.id, startAngle, parentStart, parentEnd);
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
      if (this.selectedId) this.clearSelection();
    });
  }

  /**
   * 用内联样式上色：类选择器优先级高于同名 CSS 属性，
   * setAttribute("fill") 会被 .goalscape-label 的规则盖掉。
   */
  private addText(
    svg: SVGSVGElement, x: number, y: number,
    ink: { fill: string; halo: string }, classes: string[]
  ): SVGTextElement {
    const el = document.createElementNS(SVG_NS, "text");
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    el.setAttribute("text-anchor", "middle");
    el.setAttribute("dominant-baseline", "middle");
    el.addClass(...classes);
    el.style.setProperty("fill", ink.fill);
    el.style.setProperty("stroke", ink.halo);
    svg.appendChild(el);
    return el;
  }

  private select(id: string | null): void {
    this.selectedId = id;
    this.render();
    this.infoPanel.show(id);
  }

  private showContextMenu(event: MouseEvent, node: GoalNode): void {
    const scape = this.plugin.store.scape;
    if (!scape) return;
    const menu = buildGoalMenu({
      app: this.app,
      store: this.plugin.store,
      clipboard: this.plugin.clipboard,
      node,
      isMain: node.id === scape.mainGoal.id,
      onDeleted: () => {
        if (this.selectedId === node.id) this.clearSelection();
      },
    });
    menu.showAtMouseEvent(event);
  }

  // ──────────────────────────── 拖拽现场 ────────────────────────────

  /** 交给拖拽控制器的最小现场；视图内部状态其余保持私有 */
  private dragSurface(): DragSurface {
    return {
      liveSvg: () => this.liveSvg(),
      positions: () => this.nodePositions,
      ring: () => this.ringNow(),
      titleOf: (id) => this.titleOf(id),
      render: () => this.render(),
      setSelectedId: (id) => { this.selectedId = id; },
      select: (id) => this.select(id),
    };
  }

  /** render() 会 empty+重建 rootEl，任何早先捕获的引用都可能已游离，所以每次都要现查 */
  private liveSvg(): SVGSVGElement | null {
    return this.rootEl.querySelector("svg");
  }

  private ringNow(): RingGeometry {
    const scape = this.plugin.store.scape;
    return scape ? ringGeometry(visibleDepth(scape.mainGoal)) : ringGeometry(0);
  }

  private titleOf(id: string): string {
    const scape = this.plugin.store.scape;
    if (!scape) return "";
    return flattenTree(scape.mainGoal).find((n) => n.id === id)?.title ?? "";
  }
}
