// src/views/radialGeometry.ts
// 放射图的纯几何与配色：每节点的环带厚度、子级在父扇区里切走多少角度、扇区路径、
// 标签对比度与截断、极坐标命中测试。render() 与拖拽命中测试共用这一套换算，
// 避免"角度/半径"公式在两处各写一遍而漂移。
//
// 与旧版（同心等宽环 + 子级按同级归一化铺满父级）的三点区别：
// 1. importance 是"占父扇区角度的绝对百分比"，兄弟之和可以小于 100（留白）；
//    超过 100 时按同一比例整体缩回，只影响渲染、不改数据。
// 2. 每层环带厚度由节点自己的 bandScale 决定，所以各分支的半径互不对齐，
//    整图按"最深一条链的累计厚度"归一到 MAX_R（这才是需要的智能缩放）。
// 3. 标签可见性按**弧长像素**判，不再按角度阈值 —— 同样 0.14 弧度在内圈约 34px、
//    在外圈约 56px，按角度判会同时造成内圈糊、外圈空。

import { GoalNode } from "../data/types";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const VIEW_SIZE = 1000;
export const CX = VIEW_SIZE / 2;
export const CY = VIEW_SIZE / 2;
export const MAX_R = VIEW_SIZE / 2 - 20;

export const PROGRESS_STOPS = ["#f87171", "#fb923c", "#fbbf24", "#4ade80"];

/** 扇区之间的留白按"弧长"而非固定角度：外环半径大，同样角度会裂出很宽的缝 */
const SECTOR_GAP_ARC = 7;

/** 环带厚度的三档（面板上的 薄/标准/厚）；未设 bandScale 的节点用第 2 档 */
export const BAND_STEPS = [0.6, 1, 1.6];
export const BAND_DEFAULT_INDEX = 1;

const INK_LIGHT = "#ffffff";
const INK_DARK = "#0f172a";

/** 标签字号与 .goalscape-label 的 font-size 对齐；改 CSS 要同步这里，否则截断宽度会算偏 */
const LABEL_FONT = 14;
/** 字宽估算：CJK 按整宽，其余按 0.58em */
const CJK = /[\u2e80-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** 标签左右各留一点呼吸空间 */
const LABEL_PADDING = 10;
/** 弧长小于这个值就干脆不写字（写了也只会糊成一片），交给 <title> 悬停看全名 */
const MIN_LABEL_ARC = 26;

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

/** 从根到该节点（含自身）的累计厚度档数，用于把整图缩放到 viewBox 内 */
export function depthWeight(node: GoalNode): number {
  let deepest = 0;
  for (const c of node.children) deepest = Math.max(deepest, depthWeight(c));
  return bandScaleOf(node) + deepest;
}

/** 一档厚度对应多少用户单位：让最深的那条链恰好铺到 MAX_R */
export function radialUnit(root: GoalNode): number {
  const total = depthWeight(root);
  return total > 0 ? MAX_R / total : MAX_R;
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

export function estimateTextWidth(text: string, fontSize = LABEL_FONT): number {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? fontSize : fontSize * 0.58;
  return w;
}

/**
 * 按弧长决定标签怎么显示：
 * 全名放得下就全名，放不下就截断加省略号，弧长太短干脆不画（悬停仍有 <title>）。
 * 返回 null 表示这一格不该出现文字。
 */
export function fitLabel(
  title: string,
  arc: number,
  band: number,
  progressText?: string
): string | null {
  if (band < 18 || arc < MIN_LABEL_ARC) return null;
  const suffix = progressText ? ` ${progressText}` : "";
  const budget = arc - LABEL_PADDING;
  if (estimateTextWidth(title + suffix) <= budget) return title + suffix;
  if (estimateTextWidth(title) <= budget) return title;

  let out = "";
  let used = 0;
  for (const ch of title) {
    const w = CJK.test(ch) ? LABEL_FONT : LABEL_FONT * 0.58;
    if (used + w + estimateTextWidth("…") > budget) break;
    out += ch;
    used += w;
  }
  return out.length >= 2 ? `${out}…` : null;
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

/**
 * 中心盘压暗、外环逐层提亮，再按同级序号微调明度：
 * 进度全相同（如整树 0%）时也能分辨环层与相邻扇区
 */
export function nodeColor(node: GoalNode, depth: number, siblingIndex = 0): string {
  const base = node.color || PROGRESS_STOPS[Math.min(PROGRESS_STOPS.length - 1, Math.floor((node.progress ?? 0) / 25))];
  if (depth === 0) return shadeColor(base, -22);
  return shadeColor(base, Math.min(depth, 4) * 9 + (siblingIndex % 3) * 6);
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
