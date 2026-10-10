// src/views/radialView.ts
// Goalscape 放射图视图：单行工具栏（呈现方式 + 图文件 + 筛选）+ 渲染编排 + 选中态 + 视野手势。
// 增删改一律走扇区右键菜单（radialMenu.ts），工具栏不重复提供入口。
// 几何/配色/视野数学在 radialGeometry.ts，扇区画法在 sectorLayer.ts，选中态的弦线在 linkLayer.ts，
// 两类数据拖拽在 radialDrag.ts，过滤谓词在 focusFilter.ts —— 本文件只负责把它们接到 Obsidian 的 ItemView 生命周期上。

import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type { GoalscapeHost } from "./host";
import { GoalNode, GoalScape, NoteInfo, NoteRef, findNode, flattenTree } from "../data/types";
import { setCollapsed } from "../data/crud";
import { firstLine } from "../data/notes";
import { branchFills } from "../data/palette";
import { InfoPanel } from "./infoPanel";
import { FocusFilter, FilterCriteria, collectMatchingIds } from "./focusFilter";
import {
  SVG_NS,
  FULL_VIEW, Viewport, panView, toLogicalPoint, viewBoxOf, zoomView,
  SectorShape,
} from "../geometry/radialGeometry";
import { DragSurface, ReparentDragController, WeightDragController } from "./radialDrag";
import { buildGoalMenu } from "./radialMenu";
import { drawSectors } from "./sectorLayer";
import { drawLinkDecorations } from "./linkLayer";
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

// 选中态的笔记卡不画在 svg 里，而是钉在视图右缘的 HTML 浮层上（见 renderNoteDock）：
// 钉边才不挡图、才能同时开好几张，而文字换行/滚动/关闭按钮这些活 HTML 干起来是白拿的。

export class RadialGoalMapView extends ItemView {
  private unsubscribe?: () => void;
  private selectedId: string | null = null;
  private rootEl!: HTMLElement;
  /** 右缘笔记浮层的宿主（钉住的那一列） */
  private noteDock!: HTMLElement;
  /** 钉住的块 id，按打开顺序；× 关掉一张，换图全清 */
  private pinned: string[] = [];
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

  constructor(leaf: WorkspaceLeaf, private plugin: GoalscapeHost) {
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
    // 浮层要盖在图上、又不能跟着 svg 一起被 render() 重建，所以给它单独一层 wrapper；
    // rootEl 仍是 svg 的宿主，手势监听与 liveSvg() 的查找路径都不变
    const mapWrap = mainRow.createDiv({ cls: "goalscape-map-wrap" });
    this.rootEl = mapWrap.createDiv({ cls: "goalscape-radial-root" });
    this.noteDock = mapWrap.createDiv({ cls: "goalscape-note-dock" });
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

  /** "跳到所属块"用：展开祖先折叠后选中。返回 false = 这张树里没有这个块，调用方给反馈 */
  revealGoal(id: string): boolean {
    const scape = this.plugin.store.scape;
    if (!scape || !findNode(scape.mainGoal, id)) return false;
    this.selectRevealing(id);
    return true;
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
    // 浮层不在 svg 里，所以 rootEl.empty() 不会带走它 —— 每轮渲染自己重画一遍，
    // 于是块被删掉、笔记文件被删掉、正文被改，卡片都跟着这一轮更新
    this.renderNoteDock();
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

    // 底色只有一个来源：色相沿父链继承、浓淡由层级锁定，整条分支天然同色，父节点改色子节点不需要跟着改
    const fills = branchFills(scape.mainGoal, this.plugin.tone);
    this.gradSeq = 0;

    drawSectors({
      uid: this.uid,
      svg,
      defs,
      map,
      scape,
      fills,
      matchingIds: collectMatchingIds(scape, this.filterCriteria),
      nodePositions: this.nodePositions,
      selectedId: this.selectedId,
      noteSummary: (id) => firstLine(this.plugin.notes.get(id)?.text ?? ""),
      select: (id) => this.select(id),
      openMenu: (e, node) => this.showContextMenu(e, node),
      startReparent: (e, id) => this.reparentDrag.start(e, id),
      startWeight: (e, node, self, parent) =>
        this.weightDrag.start(e, node.id, self.startAngle, parent.startAngle, parent.endAngle),
    });

    // 链接装饰层：只有选中才存在，画在 map 之外（不跟扇区吃同一份投影）
    drawLinkDecorations({
      svg,
      defs,
      scape,
      fills,
      selectedId: this.selectedId,
      nodePositions: this.nodePositions,
      noteIndex: this.plugin.notes.notes,
      nextGradientId: () => `${this.uid}-c${++this.gradSeq}`,
      lightSector: (id, on) => this.litSector(id, on),
      reveal: (id) => this.selectRevealing(id),
    });

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

  private select(id: string | null): void {
    this.selectedId = id;
    // 点一次就把这块的笔记卡钉到右缘：之后换选中、点空白都不收回，只有 × 收回，
    // 于是可以同时对着读好几块的笔记（用户要的"点击一次保持打开"）
    if (id) this.pin(id);
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
    const collapsedIds: string[] = [];
    let parent = findNode(scape.mainGoal, id)?.parent ?? null;
    while (parent) {
      if (parent.collapsed) collapsedIds.push(parent.id);
      parent = findNode(scape.mainGoal, parent.id)?.parent ?? null;
    }
    // 没人折叠就整个跳过落盘（mutate 会写 JSON 并 notify）
    if (collapsedIds.length)
      this.plugin.store.mutate((s) => collapsedIds.forEach((cid) => setCollapsed(s, cid, false)));
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

  // ──────────────────────────── 扇区联动高亮 ────────────────────────────

  /** 把对端扇区"点亮"（弦线 hover 的联动高亮） */
  private litSector(id: string, on: boolean): void {
    const el = this.liveSvg()?.querySelector(`path[data-id="${id}"]`);
    if (!el) return;
    if (on) el.addClass("goalscape-lit");
    else el.removeClass("goalscape-lit");
  }

  // ──────────────────────────── 右缘笔记浮层（可钉多张） ────────────────────────────

  /** 钉一块。没笔记文件的块不钉 —— 卡片是笔记的镜子，不是装饰（红线同 noteFiles） */
  private pin(id: string): void {
    if (!this.plugin.notes.get(id) || this.pinned.includes(id)) return;
    this.pinned.push(id);
  }

  /** 供 main.ts 在换图/套模板后调用：那些 id 属于上一张图，留着就是隔空指认 */
  clearPinnedNotes(): void {
    this.pinned = [];
    this.renderNoteDock();
  }

  /**
   * 浮层重画。认不出的 id（块删了 / 笔记文件删了 / 换图）当场从 pinned 里掉出去，
   * 所以删除那几条路径不必再各自挂一遍清理。
   */
  private renderNoteDock(): void {
    const scape = this.plugin.store.scape;
    this.pinned = this.pinned.filter(
      (id) => !!scape && !!findNode(scape.mainGoal, id) && !!this.plugin.notes.get(id)
    );
    const dock = this.noteDock;
    dock.empty();
    // 有卡钉着就让图自己缩一格：浮层"贴边"的意义是不挡图，压在最宽的右半环上就成了挡图
    dock.parentElement?.toggleClass("has-note-dock", this.pinned.length > 0);
    for (const id of this.pinned) {
      const found = findNode(scape!.mainGoal, id)!;
      dock.appendChild(this.noteCardEl(found.node, this.plugin.notes.get(id)!, scape!));
    }
  }

  /**
   * 一张钉住的卡：块标题 + 正文摘要 + 它链出去的那些笔记（带锚点，逐行可点）+ 文件名。
   * 点卡片开自己的笔记，点某一行开对方那一节，× 只收这一张。
   */
  private noteCardEl(node: GoalNode, info: NoteInfo, scape: GoalScape): HTMLElement {
    const card = createDiv({ cls: "goalscape-note-card", attr: { "data-goal": node.id } });
    card.addEventListener("click", () => this.openNote(info.path, ""));
    card.addEventListener("pointerenter", () => this.litSector(node.id, true));
    card.addEventListener("pointerleave", () => this.litSector(node.id, false));

    const head = card.createDiv({ cls: "goalscape-note-card-head" });
    const icon = head.createDiv({ cls: "goalscape-note-card-icon" });
    setIcon(icon, "file-text");
    head.createDiv({ cls: "goalscape-note-card-title", text: node.title });
    const close = head.createEl("button", {
      cls: "goalscape-note-card-close",
      attr: { "aria-label": "Close this note card", title: "关闭" },
    });
    setIcon(close, "x");
    // × 不能被卡片自己的 click 一起接走，否则关一张顺带把编辑器弹出来
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pinned = this.pinned.filter((id) => id !== node.id);
      this.renderNoteDock();
    });

    const body = this.excerpt(info.text);
    card.createDiv({
      cls: `goalscape-note-card-body${body ? "" : " is-empty"}`,
      text: body || "（还没有正文）",
    });

    if (info.refs.length) {
      const list = card.createDiv({ cls: "goalscape-note-card-links" });
      for (const r of info.refs) {
        const row = list.createDiv({ cls: "goalscape-note-card-link" });
        row.createSpan({ cls: "goalscape-note-card-arrow", text: "→" });
        row.createSpan({ cls: "goalscape-note-card-link-title", text: this.refTitle(r, scape) });
        if (r.anchor) row.createSpan({ cls: "goalscape-note-card-anchor", text: r.anchor });
        row.setAttr("title", `${r.path}${r.anchor}`);
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openNote(r.path, r.anchor);
        });
      }
    }
    card.createDiv({ cls: "goalscape-note-card-file", text: info.path.split("/").pop() ?? info.path });
    return card;
  }

  /** 摘要只留字面意思：[[目标|别名]] 折成别名、标题行的井号去掉，多行截断交给 CSS */
  private excerpt(text: string): string {
    return text
      .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/^#{1,6} +/gm, "")
      .trim();
  }

  /** 对端是别的块就写那块标题（内部 id 不上图），普通笔记写文件名 */
  private refTitle(r: NoteRef, scape: GoalScape): string {
    return (r.goalId ? findNode(scape.mainGoal, r.goalId)?.node.title : undefined)
      ?? (r.path.split("/").pop() ?? r.path).replace(/\.md$/i, "");
  }

  /** 锚点交给 Obsidian 解析：跳到那一节/那一块靠的是它自己的 `#小节` / `#^块` 语法 */
  private openNote(path: string, anchor: string): void {
    void this.app.workspace.openLinkText(`${path}${anchor}`, path, true);
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
