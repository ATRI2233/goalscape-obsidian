// src/views/sectorLayer.ts
// 放射图的扇区绘制层：递归走树，每块画出底色扇区、外缘装饰（倒角/进度弧）、文字与选中的权重手柄。
// 只做 DOM 拼装 —— 几何与配色数学在 radialGeometry.ts / palette.ts，交互后果（选中、菜单、拖拽）
// 由视图通过 SectorSurface 注入，本层不认识 Obsidian。

import { GoalNode, GoalScape } from "../data/types";
import { SECTOR_RAMP, shadeOf } from "../data/palette";
import {
  SVG_NS, CX, CY,
  arcPath, bandScaleOf, bevelArc, childShares, fitLabel, labelInk, progressRim, radialUnit, sectorEdges,
  SectorShape,
} from "../geometry/radialGeometry";

/** 一轮渲染内的临时量：把只在该轮有效的计数器关在这里，不污染视图字段 */
interface Ctx {
  surface: SectorSurface;
  /** 一档厚度对应多少半径：让"累计最厚的那条链"恰好铺到 MAX_R，
   *  于是各分支按自己的 bandScale 长到不同半径，谁也不越出 viewBox */
  unit: number;
  /** defs 里的渐变 id 逐块自增；前缀 g 与弦线的 c 不同，各自计数也不会撞 */
  nextGradientId: () => string;
}

export interface SectorSurface {
  /** 分屏会同时挂两个 svg，id 必须带上视图编号 */
  uid: string;
  svg: SVGSVGElement;
  defs: SVGDefsElement;
  /** 扇区所在的组：投影按整组轮廓打一次 */
  map: SVGGElement;
  scape: GoalScape;
  /** 节点 id → 底色（色相沿父链继承、浓淡由层级锁定） */
  fills: Map<string, string>;
  /** 筛选命中的 id；null = 没开筛选 */
  matchingIds: Set<string> | null;
  /** 出参：本轮画出来的每个扇区，弦线层与拖拽都要按它定位 */
  nodePositions: Map<string, SectorShape>;
  selectedId: string | null;
  /** 该块笔记的首行，用于 <title> 悬停提示；没有笔记给空串 */
  noteSummary: (id: string) => string;
  select: (id: string) => void;
  openMenu: (event: MouseEvent, node: GoalNode) => void;
  startReparent: (event: PointerEvent, id: string) => void;
  startWeight: (
    event: PointerEvent, node: GoalNode,
    self: { startAngle: number; endAngle: number },
    parent: { startAngle: number; endAngle: number }
  ) => void;
}

/** 用内联样式上色：类选择器优先级高于同名 CSS 属性，
 *  setAttribute("fill") 会被 .goalscape-label 的规则盖掉。
 */
function addText(
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
function addOverlay(
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
function sectorFill(ctx: Ctx, color: string, edge: { rInner: number; rOuter: number }): string {
  const { surface, nextGradientId } = ctx;
  const id = nextGradientId();
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
  surface.defs.appendChild(grad);
  return `url(#${id})`;
}

/** 扇区本体：底色路径 + 命中区域 + 悬停提示 */
function sectorBody(
  ctx: Ctx, node: GoalNode, depth: number, edge: ReturnType<typeof sectorEdges>,
  color: string, dim: boolean
): void {
  const { surface } = ctx;
  const d = arcPath(CX, CY, edge.rInner, edge.rOuter, edge.a0, edge.a1);

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", sectorFill(ctx, color, edge));
  // 扁平的那个中间色留在属性上：fill 是个 url(#…) 之后，调试和回归断言都得能一眼看出这块是谁家的色
  path.setAttribute("data-color", color);
  path.setAttribute("stroke", "var(--background-primary)");
  path.setAttribute("stroke-width", "1");
  path.setAttribute("data-id", node.id);
  if (node.id === surface.selectedId) path.addClass("goalscape-selected");
  if (node.collapsed && node.children.length) path.addClass("goalscape-collapsed");
  if (dim) path.addClass("goalscape-dimmed");

  path.addEventListener("click", (e) => {
    // 挡住冒泡，否则 svg 空白处的"点击清除选中"会把刚选中的节点又清掉。
    // 外环扇区的选中来自 reparent 的 pointerup；中心盘不参与拖拽，只能在这里选中。
    e.stopPropagation();
    if (depth === 0) surface.select(node.id);
  });
  path.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    surface.select(node.id);
    surface.openMenu(e as MouseEvent, node);
  });
  path.addEventListener("pointerdown", (e) => {
    if (depth === 0) return;
    surface.startReparent(e as PointerEvent, node.id);
  });
  // 原生 <title> 挂在扇区上：标签被截断、或者弧长太干脆没画字的格子，悬停也认得出是谁
  // （.goalscape-label 是 pointer-events:none，挂在文字上永远不会触发）
  const tip = document.createElementNS(SVG_NS, "title");
  const summary = surface.noteSummary(node.id);
  tip.textContent = summary
    ? `${node.title} · ${node.progress ?? 0}%\n${summary}`
    : `${node.title} · ${node.progress ?? 0}%`;
  path.appendChild(tip);
  surface.map.appendChild(path);
}

/** 外缘倒角 + 进度弧：都不参与命中测试，跟着扇区变淡 */
function sectorDecor(
  ctx: Ctx, node: GoalNode, edge: ReturnType<typeof sectorEdges>,
  ink: { fill: string; halo: string }, dim: boolean
): void {
  const { surface } = ctx;
  // 外缘倒角：一道极细的亮边把轮廓勾出来（颜色在 CSS 里，暗底用亮边、亮底用暗边）
  const bevel = bevelArc(edge);
  if (bevel) addOverlay(surface.map, bevel, dim, ["goalscape-bevel"]);

  // 进度画在外缘：只画"走完的那一段"，没走到的地方一律不留痕迹（画轨道会糊成一条黑边）
  const rim = progressRim(edge, node.progress ?? 0);
  if (rim) {
    addOverlay(surface.map, rim.d, dim, ["goalscape-rim"], {
      stroke: ink.fill, "stroke-dasharray": rim.dash,
    });
  }
}

/** 扇区上的文字：中心盘走水平标题，外环由 fitLabel 决定顺环还是沿半径 */
function sectorLabel(
  ctx: Ctx, node: GoalNode, depth: number, edge: ReturnType<typeof sectorEdges>,
  midAngle: number, ink: { fill: string; halo: string }
): void {
  const { surface } = ctx;
  if (depth === 0) {
    // 根节点：标题水平居中于 hub，下方显示整体进度
    const title = addText(surface.svg, CX, CY - 8, ink, ["goalscape-label", "goalscape-label-root"]);
    title.textContent = node.title;
    const pct = addText(surface.svg, CX, CY + 16, ink, ["goalscape-label", "goalscape-label-root-pct"]);
    pct.textContent = `${node.progress ?? 0}%`;
    return;
  }
  const rMid = (edge.rInner + edge.rOuter) / 2;
  // 顺环还是沿半径，由 fitLabel 按"哪边写得下更多字"定，这里只管落笔
  const fit = fitLabel(node.title, edge, `${node.progress ?? 0}%`);
  if (!fit) return;
  const lx = CX + Math.cos(midAngle) * rMid;
  const ly = CY + Math.sin(midAngle) * rMid;
  const label = addText(surface.svg, lx, ly, ink, ["goalscape-label"]);
  // 回归要拿"这条文字属于哪个扇区"对回环带半径，光看文案对不上（截断过的不一样）
  label.setAttribute("data-id", node.id);
  label.setAttribute("data-mode", fit.mode);
  // CSS 里那档 14px 是基准，压小的字号只能内联盖过它
  label.style.setProperty("font-size", `${fit.fontSize}px`);
  label.setAttribute("transform", `rotate(${fit.angle.toFixed(2)} ${lx} ${ly})`);
  label.textContent = fit.text;
}

/** 选中块外缘的权重手柄：拖动改的是本块在父扇区里的角度占比 */
function weightHandle(
  ctx: Ctx, node: GoalNode, edge: ReturnType<typeof sectorEdges>, midAngle: number,
  self: { startAngle: number; endAngle: number },
  parentAngles: { startAngle: number; endAngle: number } | null
): void {
  const { surface } = ctx;
  const handle = document.createElementNS(SVG_NS, "circle");
  handle.setAttribute("cx", String(CX + Math.cos(midAngle) * edge.rOuter));
  handle.setAttribute("cy", String(CY + Math.sin(midAngle) * edge.rOuter));
  handle.setAttribute("r", "9");
  handle.addClass("goalscape-weight-handle");
  handle.addEventListener("pointerdown", (e) => {
    const p = parentAngles ?? self;
    surface.startWeight(e as PointerEvent, node, self, p);
  });
  surface.svg.appendChild(handle);
}

/** 一个扇区：本体、装饰、文字、手柄，再加"折叠则不画子级"的递归 */
function drawNode(
  ctx: Ctx, node: GoalNode, depth: number, startAngle: number, endAngle: number,
  rInner: number, parentAngles: { startAngle: number; endAngle: number } | null
): void {
  const { surface } = ctx;
  const span = endAngle - startAngle;
  if (span <= 0.0005) return;
  const rOuter = rInner + bandScaleOf(node) * ctx.unit;
  const shape: SectorShape = { rInner, rOuter, startAngle, endAngle, depth };
  surface.nodePositions.set(node.id, shape);

  const edge = sectorEdges(shape);
  const color = surface.fills.get(node.id)!;
  const ink = labelInk(color);
  const dim = !!surface.matchingIds && !surface.matchingIds.has(node.id);

  sectorBody(ctx, node, depth, edge, color, dim);
  sectorDecor(ctx, node, edge, ink, dim);

  const midAngle = (startAngle + endAngle) / 2;
  sectorLabel(ctx, node, depth, edge, midAngle, ink);

  if (node.id === surface.selectedId && depth > 0) {
    weightHandle(ctx, node, edge, midAngle, { startAngle, endAngle }, parentAngles);
  }

  if (node.collapsed) return;
  const shares = childShares(node);
  let cursor = startAngle;
  node.children.forEach((c, i) => {
    // 子级只吃 shares[i] 这一份，父扇区剩下的角度就是留白
    const cSpan = shares[i] * span;
    drawNode(ctx, c, depth + 1, cursor, cursor + cSpan, rOuter, { startAngle, endAngle });
    cursor += cSpan;
  });
}

export function drawSectors(surface: SectorSurface): void {
  let seq = 0;
  drawNode(
    { surface, unit: radialUnit(surface.scape.mainGoal), nextGradientId: () => `${surface.uid}-g${++seq}` },
    surface.scape.mainGoal, 0, -Math.PI / 2, Math.PI * 1.5, 0, null
  );
}
