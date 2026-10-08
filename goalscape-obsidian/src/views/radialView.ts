// src/views/radialView.ts
// Goalscape 放射图视图：单行工具栏（呈现方式 + 图文件 + 筛选）+ SVG 渲染 + 选中态。
// 增删改一律走扇区右键菜单（radialMenu.ts），工具栏不重复提供入口。
// 几何/配色在 radialGeometry.ts，两类拖拽在 radialDrag.ts，过滤谓词在 focusFilter.ts
// —— 本文件只负责把它们接到 Obsidian 的 ItemView 生命周期上。

import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode, DEFAULT_BRANCH_COLOR, branchColors, flattenTree } from "../data/types";
import { InfoPanel } from "./infoPanel";
import { FocusFilter, FilterCriteria, collectMatchingIds } from "./focusFilter";
import {
  SVG_NS, VIEW_SIZE, CX, CY,
  arcPath, bandScaleOf, childShares, fitLabel, labelInk, nodeColor, radialUnit, sectorEdges,
  SectorShape,
} from "./radialGeometry";
import { DragSurface, ReparentDragController, WeightDragController } from "./radialDrag";
import { buildGoalMenu } from "./radialMenu";
import { VIEW_RADIAL } from "./viewTypes";
import { createViewSwitcher } from "./viewSwitcher";

/** Goalscapes/life.goalscape.json → life */
function scapeName(path: string): string {
  return path.split("/").pop()!.replace(/\.goalscape\.json$/, "");
}

export class RadialGoalMapView extends ItemView {
  private unsubscribe?: () => void;
  private selectedId: string | null = null;
  private rootEl!: HTMLElement;
  private infoPanel!: InfoPanel;
  private filterBar!: FocusFilter;
  private filterCriteria: FilterCriteria = {};
  private nodePositions = new Map<string, SectorShape>();
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
    this.buildToolbar(toolbar);

    // 筛选浮层的关闭监听挂在视图上：registerDomEvent 会随视图销毁自动解绑，
    // 不像手写 document.addEventListener 那样需要在 onClose 里手动配对。
    // 用捕获阶段，才能在按钮自己的 click 处理之前判定"点的是浮层外面"。
    this.registerDomEvent(document, "click", (e) => {
      if (this.filterBar.isOpen && !this.filterBar.containsTarget(e.target)) this.filterBar.close();
    }, true);
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape") this.filterBar.close();
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

  private mapButton!: HTMLButtonElement;

  private buildToolbar(toolbar: HTMLElement): void {
    createViewSwitcher(toolbar, this.plugin, this.leaf, VIEW_RADIAL);

    this.mapButton = toolbar.createEl("button", { cls: "goalscape-map-btn" });
    this.mapButton.setAttr("aria-label", "Switch goalscape");
    this.mapButton.addEventListener("click", (e) => this.showMapMenu(e as MouseEvent));
    this.refreshMapButton();

    this.filterBar = new FocusFilter(toolbar, (criteria) => {
      this.filterCriteria = criteria;
      this.render();
    });
  }

  /**
   * 工具栏只放当前图的文件名，完整列表在点开后的原生菜单里 ——
   * 一排 `<select>` 会被长文件名撑宽，菜单则按内容自适应、还能给当前项打勾。
   * 供 main.ts 在换图/新建图后刷新标签。
   */
  refreshMapButton(): void {
    const current = this.plugin.store.path;
    this.mapButton.empty();
    this.mapButton.createSpan({ cls: "goalscape-map-name", text: scapeName(current) });
    const chevron = this.mapButton.createSpan({ cls: "goalscape-map-chevron" });
    setIcon(chevron, "chevron-down");
    this.mapButton.setAttr("title", current);
  }

  private showMapMenu(event: MouseEvent): void {
    const current = this.plugin.store.path;
    const paths = this.plugin.listGoalscapes();
    // 当前图可能在别的目录、或文件还没建出来：菜单里也得列出它，否则没有打勾项
    if (!paths.includes(current)) paths.unshift(current);

    const menu = new Menu();
    for (const p of paths) {
      menu.addItem((item) =>
        item.setTitle(scapeName(p))
          .setIcon("target")
          .setChecked(p === current)
          .onClick(() => void this.plugin.switchGoalscape(p))
      );
    }
    menu.showAtMouseEvent(event);
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

    // 一档厚度对应多少半径：让"累计最厚的那条链"恰好铺到 MAX_R，
    // 于是各分支按自己的 bandScale 长到不同半径，谁也不越出 viewBox
    const unit = radialUnit(scape.mainGoal);
    const matchingIds = collectMatchingIds(scape, this.filterCriteria);
    // 色相只有一个来源：沿父链解析一次，整条分支天然同色，父节点改色子节点不需要跟着改
    const hues = branchColors(scape.mainGoal);

    const drawNode = (
      node: GoalNode,
      depth: number,
      startAngle: number,
      endAngle: number,
      rInner: number,
      parentAngles: { startAngle: number; endAngle: number } | null,
      siblingIndex = 0
    ) => {
      const span = endAngle - startAngle;
      if (span <= 0.0005) return;
      const rOuter = rInner + bandScaleOf(node) * unit;
      const shape: SectorShape = { rInner, rOuter, startAngle, endAngle, depth };
      this.nodePositions.set(node.id, shape);

      const edge = sectorEdges(shape);
      const color = nodeColor(node, depth, hues.get(node.id) ?? DEFAULT_BRANCH_COLOR, siblingIndex);
      const ink = labelInk(color);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", arcPath(CX, CY, edge.rInner, edge.rOuter, edge.a0, edge.a1));
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
      // 原生 <title> 挂在扇区上：标签被截断、或者弧长太干脆没画字的格子，悬停也认得出是谁
      // （.goalscape-label 是 pointer-events:none，挂在文字上永远不会触发）
      const tip = document.createElementNS(SVG_NS, "title");
      tip.textContent = `${node.title} · ${node.progress ?? 0}%`;
      path.appendChild(tip);
      svg.appendChild(path);

      const midAngle = (startAngle + endAngle) / 2;
      if (depth === 0) {
        // 根节点：标题水平居中于 hub，下方显示整体进度
        const title = this.addText(svg, CX, CY - 8, ink, ["goalscape-label", "goalscape-label-root"]);
        title.textContent = node.title;
        const pct = this.addText(svg, CX, CY + 16, ink, ["goalscape-label", "goalscape-label-root-pct"]);
        pct.textContent = `${node.progress ?? 0}%`;
      } else {
        const rMid = (edge.rInner + edge.rOuter) / 2;
        // 判"弧长够不够"而不是"角度够不够"：同样 0.14 弧度在内圈约 34px、外圈约 56px
        const text = fitLabel(node.title, span * rMid, edge.rOuter - edge.rInner, `${node.progress ?? 0}%`);
        if (text) {
          const lx = CX + Math.cos(midAngle) * rMid;
          const ly = CY + Math.sin(midAngle) * rMid;
          const label = this.addText(svg, lx, ly, ink, ["goalscape-label"]);
          const deg = (midAngle * 180) / Math.PI;
          const flip = deg > 90 && deg < 270;
          label.setAttribute("transform", `rotate(${flip ? deg + 180 : deg} ${lx} ${ly})`);
          label.textContent = text;
        }
      }

      if (node.id === this.selectedId && depth > 0) {
        const handle = document.createElementNS(SVG_NS, "circle");
        handle.setAttribute("cx", String(CX + Math.cos(midAngle) * edge.rOuter));
        handle.setAttribute("cy", String(CY + Math.sin(midAngle) * edge.rOuter));
        handle.setAttribute("r", "9");
        handle.addClass("goalscape-weight-handle");
        handle.addEventListener("pointerdown", (e) => {
          const p = parentAngles ?? { startAngle, endAngle };
          this.weightDrag.start(e as PointerEvent, node.id, startAngle, p.startAngle, p.endAngle);
        });
        svg.appendChild(handle);
      }

      if (node.collapsed) return;
      const shares = childShares(node);
      let cursor = startAngle;
      node.children.forEach((c, i) => {
        // 子级只吃 shares[i] 这一份，父扇区剩下的角度就是留白
        const cSpan = shares[i] * span;
        drawNode(c, depth + 1, cursor, cursor + cSpan, rOuter, { startAngle, endAngle }, i);
        cursor += cSpan;
      });
    };

    drawNode(scape.mainGoal, 0, -Math.PI / 2, Math.PI * 1.5, 0, null);

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

  private titleOf(id: string): string {
    const scape = this.plugin.store.scape;
    if (!scape) return "";
    return flattenTree(scape.mainGoal).find((n) => n.id === id)?.title ?? "";
  }
}
