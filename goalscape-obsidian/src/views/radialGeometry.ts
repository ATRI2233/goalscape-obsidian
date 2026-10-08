// src/views/radialGeometry.ts
// 放射图的纯几何与配色：环层划分、扇区路径、标签对比度、极坐标命中测试。
// render() 与拖拽命中测试共用这一套换算，避免环数公式在两处各写一遍而漂移。

import { GoalNode } from "../data/types";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const VIEW_SIZE = 1000;
export const CX = VIEW_SIZE / 2;
export const CY = VIEW_SIZE / 2;
export const MAX_R = VIEW_SIZE / 2 - 20;

export const PROGRESS_STOPS = ["#f87171", "#fb923c", "#fbbf24", "#4ade80"];

/** 扇区之间的留白按"弧长"而非固定角度：外环半径大，同样角度会裂出很宽的缝 */
const SECTOR_GAP_ARC = 7;

const INK_LIGHT = "#ffffff";
const INK_DARK = "#0f172a";

export interface SectorAngles {
  startAngle: number;
  endAngle: number;
  depth: number;
}

export interface RingGeometry {
  ringCount: number;
  ringW: number;
  ringGap: number;
}

export function ringGeometry(maxDepth: number): RingGeometry {
  // 环数 = 最深 depth 索引 + 1（depth 从 0 起）；写成 maxDepth 会让最外环画到 MAX_R 之外被裁切
  const ringCount = maxDepth + 1;
  return { ringCount, ringW: MAX_R / ringCount, ringGap: Math.min(5, (MAX_R / ringCount) * 0.045) };
}

export function visibleDepth(node: GoalNode, depth = 0): number {
  if (!node.children.length || node.collapsed) return depth;
  return Math.max(...node.children.map((c) => visibleDepth(c, depth + 1)));
}

/** 扇形的实际画布边界：环间隙 + 弧长留白，根盘无留白 */
export function sectorEdges(
  depth: number,
  startAngle: number,
  endAngle: number,
  ring: RingGeometry
): { rInner: number; rOuter: number; a0: number; a1: number } {
  const span = endAngle - startAngle;
  const rOuter = (depth + 1) * ring.ringW - ring.ringGap;
  const rInner = depth === 0 ? 0 : depth * ring.ringW + ring.ringGap;
  const pad = depth === 0 ? 0 : Math.min(span * 0.1, SECTOR_GAP_ARC / rOuter);
  return { rInner, rOuter, a0: startAngle + pad, a1: endAngle - pad };
}

/** 把角度归一到 [floor, floor + 2π)，用于把指针角度对回父扇区的取值域 */
export function normalizeAngleInto(angle: number, floor: number): number {
  let a = angle;
  while (a < floor) a += Math.PI * 2;
  while (a >= floor + Math.PI * 2) a -= Math.PI * 2;
  return a;
}

export function toLogicalPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: CX, y: CY };
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/** 命中测试：先按半径定环层，再在该层里找角度落在其扇区内的节点 */
export function hitTestSector(
  positions: Map<string, SectorAngles>,
  ring: RingGeometry,
  point: { x: number; y: number }
): string | null {
  const dx = point.x - CX;
  const dy = point.y - CY;
  const r = Math.hypot(dx, dy);
  if (r > MAX_R) return null;
  const angle = Math.atan2(dy, dx);
  const depth = Math.floor(r / ring.ringW);

  for (const [id, pos] of positions) {
    if (pos.depth !== depth) continue;
    const a = normalizeAngleInto(angle, pos.startAngle);
    if (a >= pos.startAngle && a <= pos.endAngle) return id;
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
