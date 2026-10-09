// src/views/radialView.ts
// Goalscape 放射图视图：单行工具栏（呈现方式 + 图文件 + 筛选）+ SVG 渲染 + 选中态 + 视野手势。
// 增删改一律走扇区右键菜单（radialMenu.ts），工具栏不重复提供入口。
// 几何/配色/视野数学在 radialGeometry.ts，两类数据拖拽在 radialDrag.ts，过滤谓词在 focusFilter.ts
// —— 本文件只负责把它们接到 Obsidian 的 ItemView 生命周期上。

import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode, GoalScape, findNode, flattenTree } from "../data/types";
import { backlinks, firstLine } from "../data/notes";
import { SECTOR_RAMP, branchFills, shadeOf } from "../data/palette";
import { InfoPanel } from "./infoPanel";
import { FocusFilter, FilterCriteria, collectMatchingIds } from "./focusFilter";
import {
  SVG_NS, CX, CY, VIEW_SIZE,
  arcPath, bandScaleOf, bevelArc, childShares, fitLabel, labelInk, progressRim, radialUnit, sectorEdges,
  FULL_VIEW, Viewport, panView, toLogicalPoint, viewBoxOf, zoomView,
  SectorShape,
} from "../geometry/radialGeometry";
import { DragSurface, ReparentDragController, WeightDragController } from "./radialDrag";
import { buildGoalMenu } from "./radialMenu";
import { VIEW_RADIAL } from "./viewTypes";
import { createViewSwitcher } from "./viewSwitcher";

/** Goalscapes/life.goalscape.json → life */
function scapeName(path: string): string {
  return path.split("/").pop()!.replace(/\.goalscape\.json$/, "");
}

/** 分屏会同时挂两个 svg，逐视图给 defs 里的 id 编号，避免后建的视图引用到先销毁的那个 */
let viewSeq = 0;

/** 位移超过这个值才认定是平移，否则按"点了空白处清除选中"处理（与 reparent 的阈值同一个道理） */
const PAN_ACTIVATE_PX = 5;

export class RadialGoalMapView extends ItemView {
  private unsubscribe?: () => void;
  private selectedId: string | null = null;
  private rootEl!: HTMLElement;
  private infoPanel!: InfoPanel;
  private filterBar!: FocusFilter;
  private filterCriteria: FilterCriteria = {};
  private nodePositions = new Map<string, SectorShape>();
  /** 当前视野（viewBox），跨 render 保持；分屏各自一份，互不影响 */
  private view: Viewport = FULL_VIEW;
  /** 平移收尾时浏览器补的那次 click 不该清掉选中态 */
  private panMoved = false;
  /** 分屏会同时挂两个 svg，id 撞了以后 url(#id) 只认文档里第一个 defs，所以逐视图编号 */
  private readonly uid = `goalscape-${++viewSeq}`;
  private gradSeq = 0;
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
    // 手势挂在 rootEl 而不是 svg 上：render() 每次都重建 svg，挂在 svg 上就得每帧重绑，
    // 而 registerDomEvent 的解绑只在视图销毁时跑一次。滚轮/平移都靠事件冒泡到这里。
    this.registerDomEvent(this.rootEl, "wheel", (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(this.rootEl, "pointerdown", (e) => this.onBackgroundPointerDown(e));
    // 双击空白处回到整图：视野最小档本来就等于全图，这只是给"滚十几格滚回去"一条捷径
    this.registerDomEvent(this.rootEl, "dblclick", (e) => {
      if (e.target instanceof SVGSVGElement) this.setView(FULL_VIEW);
    });
    const panelEl = mainRow.createDiv({ cls: "goalscape-panel" });
    this.infoPanel = new InfoPanel(panelEl, this.plugin, (id) => this.selectRevealing(id));
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
    this.infoPanel.destroy();
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

  /** 设置页改了颜色基调之后重画一次（不涉及数据，所以不走 store） */
  repaint(): void {
    this.render();
  }

  private render(): void {
    const scape = this.plugin.store.scape;
    this.rootEl.empty();
    this.nodePositions.clear();
    if (!scape) return;

    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", viewBoxOf(this.view));
    svg.addClass("goalscape-radial-svg");
    this.rootEl.appendChild(svg);

    // 扇区收进同一个组：投影只按整组的轮廓打一次，逐扇区打会变成一团糊死的灰。
    // 标签和手柄刻意留在组外 —— 它们要压在**所有**扇区之上（早先内圈标签会被后画的外圈扇区盖住），
    // 而且不该各自带上阴影。
    const defs = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(defs);

    const map = document.createElementNS(SVG_NS, "g");
    map.addClass("goalscape-map");
    svg.appendChild(map);

    // 一档厚度对应多少半径：让"累计最厚的那条链"恰好铺到 MAX_R，
    // 于是各分支按自己的 bandScale 长到不同半径，谁也不越出 viewBox
    const unit = radialUnit(scape.mainGoal);
    const matchingIds = collectMatchingIds(scape, this.filterCriteria);
    // 底色只有一个来源：色相沿父链继承、浓淡由层级锁定，整条分支天然同色，父节点改色子节点不需要跟着改
    this.gradSeq = 0;
    const fills = branchFills(scape.mainGoal, this.plugin.tone);

    const drawNode = (
      node: GoalNode,
      depth: number,
      startAngle: number,
      endAngle: number,
      rInner: number,
      parentAngles: { startAngle: number; endAngle: number } | null
    ) => {
      const span = endAngle - startAngle;
      if (span <= 0.0005) return;
      const rOuter = rInner + bandScaleOf(node) * unit;
      const shape: SectorShape = { rInner, rOuter, startAngle, endAngle, depth };
      this.nodePositions.set(node.id, shape);

      const edge = sectorEdges(shape);
      const color = fills.get(node.id)!;
      const ink = labelInk(color);
      const dim = !!matchingIds && !matchingIds.has(node.id);
      const d = arcPath(CX, CY, edge.rInner, edge.rOuter, edge.a0, edge.a1);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", this.sectorFill(defs, color, edge));
      // 扁平的那个中间色留在属性上：fill 是个 url(#…) 之后，调试和回归断言都得能一眼看出这块是谁家的色
      path.setAttribute("data-color", color);
      path.setAttribute("stroke", "var(--background-primary)");
      path.setAttribute("stroke-width", "1");
      path.setAttribute("data-id", node.id);
      if (node.id === this.selectedId) path.addClass("goalscape-selected");
      if (node.collapsed && node.children.length) path.addClass("goalscape-collapsed");
      if (dim) path.addClass("goalscape-dimmed");

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
      const summary = firstLine(this.plugin.notes.get(node.id)?.text ?? "");
      tip.textContent = summary
        ? `${node.title} · ${node.progress ?? 0}%\n${summary}`
        : `${node.title} · ${node.progress ?? 0}%`;
      path.appendChild(tip);
      map.appendChild(path);

      // 外缘倒角：一道极细的亮边把轮廓勾出来（颜色在 CSS 里，暗底用亮边、亮底用暗边）
      const bevel = bevelArc(edge);
      if (bevel) this.addOverlay(map, bevel, dim, ["goalscape-bevel"]);

      // 进度画在外缘：只画"走完的那一段"，没走到的地方一律不留痕迹（画轨道会糊成一条黑边）
      const rim = progressRim(edge, node.progress ?? 0);
      if (rim) {
        this.addOverlay(map, rim.d, dim, ["goalscape-rim"], {
          stroke: ink.fill, "stroke-dasharray": rim.dash,
        });
      }

      const midAngle = (startAngle + endAngle) / 2;
      if (depth === 0) {
        // 根节点：标题水平居中于 hub，下方显示整体进度
        const title = this.addText(svg, CX, CY - 8, ink, ["goalscape-label", "goalscape-label-root"]);
        title.textContent = node.title;
        const pct = this.addText(svg, CX, CY + 16, ink, ["goalscape-label", "goalscape-label-root-pct"]);
        pct.textContent = `${node.progress ?? 0}%`;
      } else {
        const rMid = (edge.rInner + edge.rOuter) / 2;
        // 顺环还是沿半径，由 fitLabel 按"哪边写得下更多字"定，这里只管落笔
        const fit = fitLabel(node.title, edge, `${node.progress ?? 0}%`);
        if (fit) {
          const lx = CX + Math.cos(midAngle) * rMid;
          const ly = CY + Math.sin(midAngle) * rMid;
          const label = this.addText(svg, lx, ly, ink, ["goalscape-label"]);
          // 回归要拿"这条文字属于哪个扇区"对回环带半径，光看文案对不上（截断过的不一样）
          label.setAttribute("data-id", node.id);
          label.setAttribute("data-mode", fit.mode);
          // CSS 里那档 14px 是基准，压小的字号只能内联盖过它
          label.style.setProperty("font-size", `${fit.fontSize}px`);
          label.setAttribute("transform", `rotate(${fit.angle.toFixed(2)} ${lx} ${ly})`);
          label.textContent = fit.text;
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
        drawNode(c, depth + 1, cursor, cursor + cSpan, rOuter, { startAngle, endAngle });
        cursor += cSpan;
      });
    };

    drawNode(scape.mainGoal, 0, -Math.PI / 2, Math.PI * 1.5, 0, null);

    // 链接装饰层：只有选中才存在，画在 map 之外（不跟扇区吃同一份投影）
    this.drawLinkDecorations(svg, defs, scape, fills);

    svg.addEventListener("click", () => {
      // 平移结束时浏览器还会补一次 click，它不该把选中态清掉；下一次真点击前把标记归零
      if (this.panMoved) {
        this.panMoved = false;
        return;
      }
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

  /**
   * 扇区之上的一条装饰路径（光源叠层 / 进度条）：不参与命中测试，
   * 筛选未命中时跟着所属扇区一起变淡。stroke 走属性、不走类，
   * 因为颜色逐扇区不同，而类规则会盖掉同名属性（见 addText）。
   */
  private addOverlay(
    map: SVGGElement, d: string, dim: boolean, classes: string[], attrs: Record<string, string> = {}
  ): void {
    const el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", d);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.addClass(...classes);
    if (dim) el.addClass("goalscape-dimmed");
    map.appendChild(el);
  }

  /**
   * 每个块自己"从内边缘到外边缘由深到浅"：同一个色相、同一个饱和度，只把明度各偏一半跨度。
   * 渐变按全图坐标算，但半径取**本块的外径**、深色那一端停在**本块的内径**上 ——
   * 于是厚块薄块都是"整块走完这一档跨度"，而不是薄块只蹭到全图渐变的一小条（那正是之前看不出质感的原因）。
   */
  private sectorFill(defs: SVGDefsElement, color: string, edge: { rInner: number; rOuter: number }): string {
    const id = `${this.uid}-g${++this.gradSeq}`;
    const grad = document.createElementNS(SVG_NS, "radialGradient") as SVGRadialGradientElement;
    grad.id = id;
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.setAttribute("cx", String(CX));
    grad.setAttribute("cy", String(CY));
    grad.setAttribute("r", String(edge.rOuter));
    const dark = shadeOf(color, -SECTOR_RAMP / 2);
    const light = shadeOf(color, SECTOR_RAMP / 2);
    const stop = (offset: string, c: string): void => {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", offset);
      s.setAttribute("stop-color", c);
      grad.appendChild(s);
    };
    // 0 到内径那一段用同一个深色垫着：中心盘之外没有像素会用到它，但缺了它内缘会被插值成中间色
    stop("0", dark);
    stop(String(Math.max(0, edge.rInner / edge.rOuter)), dark);
    stop("1", light);
    defs.appendChild(grad);
    return `url(#${id})`;
  }

  private select(id: string | null): void {
    this.selectedId = id;
    this.render();
    this.infoPanel.show(id);
  }

  /**
   * 跳选：先沿祖先链把 collapsed 展开（否则目标可能被藏在折叠分支里，渲染层根本不画它，
   * 选中态点了却没地方看），再走 select。折叠只是视图状态，展开它要落盘所以走 mutate。
   * 已是 selectRevealing 的目标若已选中，仍然重跑一次以补齐展开。
   */
  private selectRevealing(id: string): void {
    const scape = this.plugin.store.scape;
    if (!scape || !findNode(scape.mainGoal, id)) return;
    const collapsed: GoalNode[] = [];
    let parent = findNode(scape.mainGoal, id)?.parent ?? null;
    while (parent) {
      if (parent.collapsed) collapsed.push(parent);
      parent = findNode(scape.mainGoal, parent.id)?.parent ?? null;
    }
    // mutate 拿到的就是这棵树本身，攥着的节点引用直接可改；没人折叠就整个跳过落盘
    if (collapsed.length) this.plugin.store.mutate(() => collapsed.forEach((n) => delete n.collapsed));
    this.select(id);
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

  // ──────────────────────────── 链接装饰层（仅选中时） ────────────────────────────

  /** 扇区弧中点（环带半径中值）：弦线端点的锚 */
  private sectorMid(shape: SectorShape): { x: number; y: number } {
    const mid = (shape.startAngle + shape.endAngle) / 2;
    const r = (shape.rInner + shape.rOuter) / 2;
    return { x: CX + Math.cos(mid) * r, y: CY + Math.sin(mid) * r };
  }

  /** 把对端扇区"点亮"（弦线 hover 的联动高亮） */
  private litSector(id: string, on: boolean): void {
    const el = this.liveSvg()?.querySelector(`path[data-id="${id}"]`);
    if (!el) return;
    if (on) el.addClass("goalscape-lit");
    else el.removeClass("goalscape-lit");
  }

  /**
   * 零噪音规矩：不选中时图面和本功能出现之前完全一样。
   * 出链与反链都画 —— links 数据结构里对端选中时画不到自己，backlinks 补上"谁引用我"，
   * 和信息面板的 Referenced by 同语义。目标在折叠分支里没被画出来就跳过，
   * 为一个看不见的端点改动别处的折叠状态不值得。
   * 弦线：三次 bezier、两控制点钉在图心（弧线向圆心下垂），描边渐变取两端各自的底色。
   */
  private drawLinkDecorations(
    svg: SVGSVGElement,
    defs: SVGDefsElement,
    scape: GoalScape,
    fills: Map<string, string>
  ): void {
    if (!this.selectedId) return;
    const found = findNode(scape.mainGoal, this.selectedId);
    const mine = found ? this.nodePositions.get(found.node.id) : undefined;
    if (!found || !mine) return;

    const p1 = this.sectorMid(mine);
    const partners = Array.from(
      new Set([
        ...(found.node.links ?? []),
        ...backlinks(scape.mainGoal, found.node.id).map((n) => n.id),
      ])
    ).filter((id) => id !== found.node.id);

    const layer = document.createElementNS(SVG_NS, "g");
    layer.addClass("goalscape-chord-layer");
    svg.appendChild(layer);

    for (const otherId of partners) {
      const shape = this.nodePositions.get(otherId);
      if (!shape) continue;
      const p2 = this.sectorMid(shape);
      const c1 = fills.get(found.node.id) ?? "#94a3b8";
      const c2 = fills.get(otherId) ?? "#94a3b8";

      const gid = `${this.uid}-c${++this.gradSeq}`;
      const grad = document.createElementNS(SVG_NS, "linearGradient");
      grad.id = gid;
      grad.setAttribute("gradientUnits", "userSpaceOnUse");
      grad.setAttribute("x1", String(p1.x));
      grad.setAttribute("y1", String(p1.y));
      grad.setAttribute("x2", String(p2.x));
      grad.setAttribute("y2", String(p2.y));
      for (const [offset, color] of [["0", c1], ["1", c2]] as const) {
        const stop = document.createElementNS(SVG_NS, "stop");
        stop.setAttribute("offset", offset);
        stop.setAttribute("stop-color", color);
        grad.appendChild(stop);
      }
      defs.appendChild(grad);

      const chord = document.createElementNS(SVG_NS, "path");
      chord.setAttribute("d", `M ${p1.x} ${p1.y} C ${CX} ${CY} ${CX} ${CY} ${p2.x} ${p2.y}`);
      chord.setAttribute("stroke", `url(#${gid})`);
      chord.setAttribute("data-chord", otherId);
      chord.addClass("goalscape-chord");
      chord.addEventListener("pointerenter", () => {
        chord.addClass("goalscape-chord-hot");
        this.litSector(otherId, true);
      });
      chord.addEventListener("pointerleave", () => {
        chord.removeClass("goalscape-chord-hot");
        this.litSector(otherId, false);
      });
      chord.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectRevealing(otherId);
      });
      layer.appendChild(chord);

      for (const [p, color] of [[p1, c1], [p2, c2]] as const) {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(p.x));
        dot.setAttribute("cy", String(p.y));
        dot.setAttribute("r", "4");
        dot.setAttribute("fill", color);
        dot.addClass("goalscape-chord-dot");
        layer.appendChild(dot);
      }
    }

    // vault 文件卡片：笔记里解析得到真实文件的才画（未解析的不制造幽灵）。
    // 解析在 NoteStore 里做完了，这一层拿到的已经是 vault 路径。
    const hits = (this.plugin.notes.get(found.node.id)?.links ?? []).map((p) => ({
      path: p,
      name: (p.split("/").pop() ?? p).replace(/\.md$/i, ""),
    }));
    if (!hits.length) return;
    const mid = (mine.startAngle + mine.endAngle) / 2;
    // 顶格那一环的卡片可能被 viewBox 裁掉，半径钳在画布内、宁可贴着环缝
    const rCard = Math.min(mine.rOuter + 26, VIEW_SIZE / 2 - 16);
    const step = Math.min(0.4, 40 / rCard);
    hits.forEach((item, i) => {
      const ang = mid + (i - (hits.length - 1) / 2) * step;
      const x = CX + Math.cos(ang) * rCard;
      const y = CY + Math.sin(ang) * rCard;
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("transform", `translate(${x - 5} ${y - 7})`);
      g.addClass("goalscape-vfile");
      const icon = document.createElementNS(SVG_NS, "path");
      icon.setAttribute("d", "M0 0 H7 L10 3 V14 H0 Z M7 0 V3 H10");
      icon.addClass("goalscape-vfile-icon");
      g.appendChild(icon);
      const name = document.createElementNS(SVG_NS, "text");
      name.setAttribute("x", "5");
      name.setAttribute("y", "24");
      name.setAttribute("text-anchor", "middle");
      name.addClass("goalscape-vfile-name");
      name.textContent = item.name.length > 12 ? `${item.name.slice(0, 11)}…` : item.name;
      g.appendChild(name);
      const tip = document.createElementNS(SVG_NS, "title");
      tip.textContent = item.path;
      g.appendChild(tip);
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.app.workspace.openLinkText(item.path, item.path, true);
      });
      svg.appendChild(g);
    });
  }

  // ──────────────────────────── 视野（滚轮缩放 / 平移） ────────────────────────────

  /** 只改 viewBox：扇区、渐变、标签一概不重建，命中测试拿 getScreenCTM 反算，跟着视野自然对齐 */
  private setView(v: Viewport): void {
    this.view = v;
    const svg = this.liveSvg();
    if (svg) svg.setAttribute("viewBox", viewBoxOf(v));
  }

  /**
   * 滚轮以光标为锚缩放：放大外层环时若朝图中心收，正看着的那一块会被直接推出屏幕。
   * 一格滚轮折成约 100（行/页模式先换算到同一量纲），单次事件最多吃 3 格，快速甩也不至于一格到底。
   */
  private onWheel(e: WheelEvent): void {
    const svg = this.liveSvg();
    if (!svg) return;
    // 不拦下来这一下会被当成面板滚动，ctrl+滚轮还会连带改 Obsidian 的应用缩放
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 100;
    const notch = Math.max(-3, Math.min(3, -e.deltaY / unit));
    if (!notch) return;
    this.setView(zoomView(this.view, notch, toLogicalPoint(svg, e.clientX, e.clientY)));
  }

  /**
   * 平移只接手 svg 空白处：扇区上的 pointerdown 归 reparent 拖拽，两处都接同一个手势会互相抢。
   * 位移从"按下那一刻的视野"起算、不在上一次结果上累加，所以顶到边界再拖回来不会攒出漂移。
   */
  private onBackgroundPointerDown(e: PointerEvent): void {
    this.panMoved = false;
    const svg = e.target;
    if (!(svg instanceof SVGSVGElement) || e.button !== 0) return;
    const ctm = svg.getScreenCTM();
    // ctm.a = 逻辑单位→屏幕像素的倍率；平移期间不会缩放也不会重排，所以整段拖拽用同一个倍率
    if (!ctm?.a) return;
    const from = { x: e.clientX, y: e.clientY, view: this.view };
    let moved = false;

    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) <= PAN_ACTIVATE_PX) return;
      moved = true;
      this.setView(panView(from.view, (ev.clientX - from.x) / ctm.a, (ev.clientY - from.y) / ctm.a));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // 1× 时平移夹成空操作，这种"拖了但画面没动"仍按点击处理，别夺走清除选中
      this.panMoved = viewBoxOf(from.view) !== viewBoxOf(this.view);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
