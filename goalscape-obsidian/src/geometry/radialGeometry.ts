// src/geometry/radialGeometry.ts
// 放射图的纯几何与配色：每节点的环带厚度、子级在父扇区里切走多少角度、扇区路径、
// 标签对比度与截断、极坐标命中测试、视野（滚轮缩放/平移）的窗口数学。
// render() 与拖拽命中测试共用这一套换算，
// 避免"角度/半径"公式在两处各写一遍而漂移。
//
// 与旧版（同心等宽环 + 子级按同级归一化铺满父级）的三点区别：
// 1. importance 是"占父扇区角度的绝对百分比"，兄弟之和可以小于 100（留白）；
//    超过 100 时按同一比例整体缩回，只影响渲染、不改数据。
// 2. 每层环带厚度由节点自己的 bandScale 决定，所以各分支的半径互不对齐，
//    整图按"最深一条链的累计厚度"归一到 MAX_R（这才是需要的智能缩放）。
// 3. 标签按"哪个方向写得下更多字"选向：宽扇区顺环写、窄扇区沿半径写，字号再按实际
//    可用长度自适应；判据全是像素，不按角度阈值。

import { GoalNode } from "../data/types";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const VIEW_SIZE = 1000;
export const CX = VIEW_SIZE / 2;
export const CY = VIEW_SIZE / 2;
export const MAX_R = VIEW_SIZE / 2 - 20;

/** 扇区之间的留白按"弧长"而非固定角度：外环半径大，同样角度会裂出很宽的缝 */
const SECTOR_GAP_ARC = 7;

/** 环带厚度的四档（面板上从左到右：极薄/薄/标准/厚）；未设 bandScale 的节点用"标准"档。
 *  标准档刻意等于旧版"等宽环"的厚度，所以没调过的图看起来和以前一致；厚档只加 30%，
 *  再加就挤占可读面积、实际用不上 */
export const BAND_STEPS = [0.3, 0.6, 1, 1.3];
export const BAND_DEFAULT_INDEX = 2;

const INK_LIGHT = "#ffffff";
const INK_DARK = "#0f172a";

/** 基准字号，与 .goalscape-label 的 font-size 对齐；改 CSS 要同步这里，否则截断宽度会算偏 */
const LABEL_FONT = 14;
/** 薄环上宁可字小一点也要保住全名，所以先降字号、降到底还是写不下才截断 */
const LABEL_SIZES = [LABEL_FONT, 13, 12, 11];
/** 字宽估算：CJK 按整宽，其余按 0.58em */
const CJK = /[\u2e80-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** 标签沿半径方向的头尾各留一点呼吸空间 */
const LABEL_PADDING = 10;
/** 字高之外的余量：3px 光晕描边外扩 1.5，扇区边界还有 1px 描边 */
const LABEL_SIDE_GAP = 4;
/** 文字是条"带子"：顺环写时两端的外凸按外沿那一侧算，取最大字号的一半 + 光晕 */
const LABEL_HALF_HEIGHT = LABEL_FONT / 2 + 1.5;

export interface SectorShape {
  rInner: number;
  rOuter: number;
  startAngle: number;
  endAngle: number;
  depth: number;
}

/** bandScale 只接受正数：外部手改 JSON 写 0 会让整支从图上消失，且命中测试也摸不到 */
export function bandScaleOf(node: GoalNode): number {
  const s = node.bandScale;
  return s && Number.isFinite(s) && s > 0 ? s : BAND_STEPS[BAND_DEFAULT_INDEX];
}

/** 画得出来的层数（折叠的子树算一层），决定"标准档"下每层的厚度 */
function visibleDepth(node: GoalNode, depth = 0): number {
  if (!node.children.length || node.collapsed) return depth;
  return Math.max(...node.children.map((c) => visibleDepth(c, depth + 1)));
}

/** 从根到该节点（含自身）的累计档数，只用于判"会不会画到 MAX_R 之外" */
function depthWeight(node: GoalNode): number {
  let deepest = 0;
  for (const c of node.children) deepest = Math.max(deepest, depthWeight(c));
  return bandScaleOf(node) + deepest;
}

/**
 * 一档厚度对应多少用户单位：**只跟层数挂钩，不跟各节点的 bandScale 挂钩**。
 * 早先按"累计最厚那条链"归一，于是改任意一个块的厚度都会重算 unit，
 * 父块和所有别的块跟着一起变宽窄 —— 局部调整被做成了全局缩放。
 * 现在只有"照层数算会画到 MAX_R 之外"时才整体缩回，平时各块互不影响。
 */
export function radialUnit(root: GoalNode): number {
  const base = MAX_R / (visibleDepth(root) + 1);
  const needed = depthWeight(root) * base;
  return needed > MAX_R ? MAX_R / depthWeight(root) : base;
}

/**
 * 子级各占父扇区的比例（0-1，和 ≤ 1）。
 * importance 直接当占比用；Σ>100 时整体缩回，保证不重叠、不越出父扇区。
 */
export function childShares(node: GoalNode): number[] {
  const total = node.children.reduce((s, c) => s + Math.max(0, c.importance), 0);
  if (total <= 0) return node.children.map(() => 0);
  const scale = total > 100 ? 100 / total : 1;
  return node.children.map((c) => (Math.max(0, c.importance) / 100) * scale);
}

/** 把角度归一到 [floor, floor + 2π)，用于把指针角度对回父扇区的取值域 */
export function normalizeAngleInto(angle: number, floor: number): number {
  let a = angle;
  while (a < floor) a += Math.PI * 2;
  while (a >= floor + 2 * Math.PI) a -= Math.PI * 2;
  return a;
}

export function toLogicalPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: CX, y: CY };
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

// ──────────────────────────── 视野（缩放 / 平移） ────────────────────────────

/**
 * 视野就是 viewBox 那个正方形，边长 `size` 用逻辑单位记：size 越小 = 放得越大。
 * 只记窗口不记倍率，是为了让"滚回最小档"在数学上必然等于整张图 —— size 夹到 VIEW_SIZE 时
 * 平移余量随之归零，不用另存一个"默认视野"去还原。
 */
export interface Viewport {
  x: number;
  y: number;
  size: number;
}

/** 整图铺满那一档，也是新建视图的起点 */
export const FULL_VIEW: Viewport = { x: 0, y: 0, size: VIEW_SIZE };

/** 最大放大倍率：8× 时最厚的一档环带（约 130 逻辑单位）占满视野，再大就只是在数像素 */
export const MAX_ZOOM = 8;

/** 滚轮一格放大的倍率：1.15 → 从 1× 推到 8× 约 16 格，既不会一格看不清也不会点半天没反应 */
const ZOOM_PER_NOTCH = 1.15;

const clampNum = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 画布之外没有内容，所以视野窗口不许越出 [0, VIEW_SIZE]：永远看得见图，也丢不了 */
export function clampView(v: Viewport): Viewport {
  const size = clampNum(v.size, VIEW_SIZE / MAX_ZOOM, VIEW_SIZE);
  const max = VIEW_SIZE - size;
  return { x: clampNum(v.x, 0, max), y: clampNum(v.y, 0, max), size };
}

/**
 * 以光标为锚缩放：anchor 是滚轮下那个点的**逻辑坐标**，缩放前后必须还落在同一点上，
 * 否则放大外层环时正看着的那块会被推出屏幕。notch > 0 为放大，可带小数（一次滚半格）。
 */
export function zoomView(
  v: Viewport, notch: number, anchor: { x: number; y: number }
): Viewport {
  const next = clampView({ ...v, size: v.size / Math.pow(ZOOM_PER_NOTCH, notch) });
  const k = next.size / v.size;
  return clampView({
    x: anchor.x - (anchor.x - v.x) * k,
    y: anchor.y - (anchor.y - v.y) * k,
    size: next.size,
  });
}

/** 内容跟着指针走：指针在逻辑坐标下拖过 (dx, dy)，窗口就往反方向挪同样多远 */
export function panView(v: Viewport, dx: number, dy: number): Viewport {
  return clampView({ ...v, x: v.x - dx, y: v.y - dy });
}

/** 落到 DOM 上的写法：两位小数足够细（1 逻辑单位 ≈ 一个像素的几分之一），又不至于让 viewBox 字符串长到没法读 */
export function viewBoxOf(v: Viewport): string {
  const r = (n: number) => n.toFixed(2);
  return `${r(v.x)} ${r(v.y)} ${r(v.size)} ${r(v.size)}`;
}

/**
 * 命中测试：环带半径逐节点不同，所以只能拿点的半径比对每个扇区自己的
 * [rInner, rOuter]，不能再按"半径 ÷ 固定环宽"反推层级。
 */
export function hitTestSector(
  positions: Map<string, SectorShape>,
  point: { x: number; y: number }
): string | null {
  const dx = point.x - CX;
  const dy = point.y - CY;
  const r = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  for (const [id, s] of positions) {
    if (r < s.rInner || r > s.rOuter) continue;
    const a = normalizeAngleInto(angle, s.startAngle);
    if (a >= s.startAngle && a <= s.endAngle) return id;
  }
  return null;
}

/** 扇区的实际画布边界：环间隙 + 弧长留白，根盘无留白 */
export function sectorEdges(
  shape: SectorShape
): { rInner: number; rOuter: number; a0: number; a1: number } {
  const span = shape.endAngle - shape.startAngle;
  const gap = Math.min(5, (shape.rOuter - shape.rInner) * 0.045);
  const rInner = shape.depth === 0 ? 0 : shape.rInner + gap;
  const rOuter = Math.max(rInner + 1, shape.rOuter - gap);
  const pad = shape.depth === 0 ? 0 : Math.min(span * 0.1, SECTOR_GAP_ARC / rOuter);
  return { rInner, rOuter, a0: shape.startAngle + pad, a1: shape.endAngle - pad };
}

function estimateTextWidth(text: string, fontSize = LABEL_FONT): number {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? fontSize : fontSize * 0.58;
  return w;
}

export interface LabelFit {
  text: string;
  fontSize: number;
  /** 基线旋转角（度），已归一到 (-90, 90]，保证没有倒着读的字 */
  angle: number;
  /** radial = 沿半径往外读；tangential = 顺着环的方向读 */
  mode: "radial" | "tangential";
}

/** 归一到 [-90, 90)：垂直那一律取"由下往上"，避免同一个方向有两种写法 */
function upright(deg: number): number {
  let a = deg;
  while (a >= 90) a -= 180;
  while (a < -90) a += 180;
  return a;
}

/**
 * 标签可以沿半径写，也可以顺环写，**哪个方向写得下更多字就用哪个**。
 * 之前一律沿半径写，于是字数被环带厚度卡死：87px 的环只放得下 6 个字，
 * 而同一条分支顺环有 400px 以上可用（扇区角度是按 importance 分的，宽扇区很常见）。
 *
 * 顺环写是一条直线，会往外凸，所以被"外径"和"扇区两条边"各卡一次；
 * 沿半径写则受楔形 taper 约束 —— 靠圆心那一端最窄，那一端容得下字高才算放得下。
 * 两个方向都先在 14→11 里找能写全名的最大字号，都写不下才按最小字号截断。
 */
export function fitLabel(
  title: string,
  edge: { rInner: number; rOuter: number; a0: number; a1: number },
  progressText?: string
): LabelFit | null {
  const band = edge.rOuter - edge.rInner;
  const rMid = (edge.rInner + edge.rOuter) / 2;
  const mid = (edge.a0 + edge.a1) / 2;
  const half = (edge.a1 - edge.a0) / 2;
  const suffix = progressText ? ` ${progressText}` : "";
  const smallest = LABEL_SIZES[LABEL_SIZES.length - 1];
  const rOut = edge.rOuter - LABEL_HALF_HEIGHT;
  const tanRoom =
    2 * Math.min(
      // 直线顺环走会往外凸，端点得落在"外径减去半字高"那一圈之内
      Math.sqrt(Math.max(0, rOut * rOut - rMid * rMid)),
      // 半张角超过 ~74° 时早就是外径先卡住，tan 再往上只会变成负数
      (rMid - LABEL_HALF_HEIGHT) * Math.tan(Math.min(half, 1.3))
    ) - LABEL_PADDING;
  const radRoom = band - LABEL_PADDING;
  const modes: LabelFit["mode"][] = tanRoom >= radRoom
    ? ["tangential", "radial"] : ["radial", "tangential"];

  for (const mode of modes) {
    const room = mode === "tangential" ? tanRoom : radRoom;
    if (room < smallest) continue;
    const ok = (text: string, size: number) =>
      mode === "tangential"
        ? band >= size + LABEL_SIDE_GAP
        : half * 2 * (rMid - estimateTextWidth(text, size) / 2) >= size + LABEL_SIDE_GAP;
    const angle = upright((((mode === "tangential" ? mid + Math.PI / 2 : mid) * 180) / Math.PI));
    for (const size of LABEL_SIZES) {
      if (estimateTextWidth(title, size) > room) continue;
      const full = title + suffix;
      const text =
        suffix && estimateTextWidth(full, size) <= room && ok(full, size) ? full : title;
      if (ok(text, size)) return { text, fontSize: size, mode, angle };
    }
    let out = "";
    let used = 0;
    for (const ch of title) {
      const w = CJK.test(ch) ? smallest : smallest * 0.58;
      if (used + w + smallest * 0.58 > room) break;
      out += ch;
      used += w;
    }
    const text = `${out}…`;
    if (out.length >= 2 && ok(text, smallest)) {
      return { text, fontSize: smallest, mode, angle };
    }
  }
  return null;
}

/** 扇区自身的相对亮度，用来决定标签该用深色字还是浅色字 */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => {
    const v = ((n >> shift) & 255) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}

/**
 * 外环逐层提亮后，固定白字的对比度最低只有 1.3:1（浅色扇区基本读不出）。
 * 直接在两个候选字色里取对比度更高的那个，并把描边光晕换成反色，两种底色下都能看清。
 */
export function labelInk(sectorColor: string): { fill: string; halo: string } {
  const l = luminance(sectorColor);
  const ratio = (ink: string) => {
    const li = luminance(ink);
    return (Math.max(l, li) + 0.05) / (Math.min(l, li) + 0.05);
  };
  return ratio(INK_DARK) > ratio(INK_LIGHT)
    ? { fill: INK_DARK, halo: "rgba(255, 255, 255, 0.8)" }
    : { fill: INK_LIGHT, halo: "rgba(15, 23, 42, 0.55)" };
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

/** 只描一条弧线（不闭合）：外缘进度条用它 */
function arcLinePath(
  cx: number, cy: number, r: number, startAngle: number, endAngle: number
): string {
  const p = (a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  // 整圆时起止点重合，一条 A 弧会被渲染器判成零长度，所以拆成两段半弧
  if (endAngle - startAngle >= Math.PI * 2 - FULL_CIRCLE_EPSILON) {
    const mid = startAngle + Math.PI;
    return `M ${p(startAngle)} A ${r} ${r} 0 1 1 ${p(mid)} A ${r} ${r} 0 1 1 ${p(endAngle)}`;
  }
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${p(startAngle)} A ${r} ${r} 0 ${largeArc} 1 ${p(endAngle)}`;
}

/** 进度条线宽与内缩：和 .goalscape-rim 的 stroke-width 成对，改一处要改两处 */
const RIM_WIDTH = 3.5;
const RIM_INSET = 1.5;
/** 环带薄到装不下这条线就干脆不画，别让进度条反过来啃掉扇区本色 */
const RIM_MIN_BAND = 14;

/**
 * 外缘那道极细的亮边（倒角）：贴着扇区外缘走一条弧，把轮廓勾一下。
 * 颜色由 CSS 给，主题不同用不同的边（暗底用亮边、亮底用暗边）。
 */
export function bevelArc(edge: { rInner: number; rOuter: number; a0: number; a1: number }): string | null {
  if (edge.rOuter - edge.rInner < RIM_MIN_BAND) return null;
  const r = edge.rOuter - 0.6;
  if (r <= edge.rInner) return null;
  return arcLinePath(CX, CY, r, edge.a0, edge.a1);
}

/**
 * 扇区外缘的细进度条：贴着 rOuter 内侧走一条弧，用 stroke-dasharray 表示完成了多少。
 * 只画走完的那一段 —— 没走到的地方留一条淡轨道，看着就是每个格子外缘一道黑线。
 * 返回 null 表示这一格不该出现进度条（环带太薄装不下，或弧长为零）。
 */
export function progressRim(
  edge: { rInner: number; rOuter: number; a0: number; a1: number },
  progress: number
): { d: string; dash: string } | null {
  const band = edge.rOuter - edge.rInner;
  if (band < RIM_MIN_BAND) return null;
  const r = edge.rOuter - RIM_INSET - RIM_WIDTH / 2;
  if (r <= edge.rInner + RIM_WIDTH) return null;
  const len = r * (edge.a1 - edge.a0);
  if (len <= 0) return null;
  const p = Math.max(0, Math.min(100, progress || 0)) / 100;
  return {
    d: arcLinePath(CX, CY, r, edge.a0, edge.a1),
    dash: `${(len * p).toFixed(2)} ${(len + 1).toFixed(2)}`,
  };
}
