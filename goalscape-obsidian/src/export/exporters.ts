// src/export/exporters.ts
// 导出功能：PNG（SVG→Canvas→Blob）、SVG（序列化）、CSV（扁平化节点数据）。

import { GoalNode, GoalScape } from "../data/types";
import { DEFAULT_TONE, Tone, branchFills } from "../data/palette";

/**
 * 序列化后的 SVG 脱离了文档：CSS 规则与 var() 变量都不再存在，
 * 所以必须把渲染依赖的样式按计算值内联成属性，否则标签会退回黑色 16px 默认值、描边消失。
 */
const INLINED_PROPS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linejoin",
  "paint-order",
  "font-size",
  "font-weight",
  "font-family",
  "text-anchor",
  "dominant-baseline",
  "opacity",
  "filter",
];

function inlineComputedStyles(svgEl: SVGSVGElement): SVGSVGElement {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const src = svgEl.querySelectorAll<Element>("*");
  const dst = clone.querySelectorAll<Element>("*");
  for (let i = 0; i < src.length; i++) {
    const cs = getComputedStyle(src[i]);
    for (const prop of INLINED_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value) dst[i].setAttribute(prop, value);
    }
  }
  return clone;
}

/**
 * 导出图的底色。Obsidian 的主题变量挂在 body 上而非 documentElement，
 * 所以从 svg 往上找第一个真正被绘制的背景，取当前主题的实际颜色，不能写死暗色。
 */
function themeBackground(svgEl: SVGSVGElement): string {
  for (let el: Element | null = svgEl; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && !bg.startsWith("rgba(0, 0, 0, 0")) return bg;
  }
  return "#ffffff";
}

/** 导出文件必须自带底色矩形：脱离应用后 SVG 常在白底查看器里打开，
 *  而标签是按深色主题绘制的白字，没有背景时中心盘文字会完全看不见。 */
function withBackground(clone: SVGSVGElement, color: string): SVGSVGElement {
  const vb = (clone.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", String(vb.length === 4 ? vb[0] : 0));
  rect.setAttribute("y", String(vb.length === 4 ? vb[1] : 0));
  rect.setAttribute("width", String(vb.length === 4 ? vb[2] : 1000));
  rect.setAttribute("height", String(vb.length === 4 ? vb[3] : 1000));
  rect.setAttribute("fill", color);
  clone.insertBefore(rect, clone.firstChild);
  return clone;
}

export function exportSvg(svgEl: SVGSVGElement): string {
  const clone = withBackground(inlineComputedStyles(svgEl), themeBackground(svgEl));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", "1000");
  clone.setAttribute("height", "1000");
  return new XMLSerializer().serializeToString(clone);
}

export async function exportPng(svgEl: SVGSVGElement, scale = 2): Promise<Blob> {
  const svgStr = exportSvg(svgEl);
  const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 1000 * scale;
  canvas.height = 1000 * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = themeBackground(svgEl);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

export function exportCsv(scape: GoalScape, tone: Tone = DEFAULT_TONE): string {
  const rows: string[][] = [["Title", "Importance", "Progress", "Due", "Start", "Tags", "Color", "Depth", "ParentTitle"]];
  // 导出的是节点在图上实际呈现的那个颜色，而不是"存了这个字段"——
  // 深层节点不存色、浓淡也不由存值决定，但图上确实有颜色
  const fills = branchFills(scape.mainGoal, tone);
  const walk = (node: GoalNode, depth: number, parentTitle: string) => {
    rows.push([
      node.title,
      String(node.importance),
      String(node.progress ?? 0),
      node.due ?? "",
      node.start ?? "",
      node.tags.join("; "),
      fills.get(node.id) ?? "",
      String(depth),
      parentTitle,
    ]);
    for (const c of node.children) walk(c, depth + 1, node.title);
  };
  walk(scape.mainGoal, 0, "");
  // BOM：Excel 没有它就按本地代码页解 UTF-8，中文标题会变成乱码
  return String.fromCharCode(0xfeff) + rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function exportMarkdownOutline(scape: GoalScape): string {
  const lines: string[] = [];
  const walk = (node: GoalNode, depth: number) => {
    const indent = "  ".repeat(depth);
    const prog = node.children.length ? `(auto: ${node.progress ?? 0}%)` : `(${node.progress ?? 0}%)`;
    lines.push(`${indent}- **${node.title}** ${prog} [w:${node.importance}]`);
    // 不按 collapsed 过滤：折叠只是放射图的视图状态，导出大纲时据此跳过会静默丢失整棵子树
    for (const c of node.children) walk(c, depth + 1);
  };
  walk(scape.mainGoal, 0);
  return lines.join("\n");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string, mime = "text/plain"): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}
