// src/export/exporters.ts
// 导出功能：PNG（SVG→Canvas→Blob）、SVG（序列化）、CSV（扁平化节点数据）。

import { GoalNode, GoalScape, flattenTree } from "../data/types";

export function exportSvg(svgEl: SVGSVGElement): string {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
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
  ctx.fillStyle = "#1e1e2e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

export function exportCsv(scape: GoalScape): string {
  const rows: string[][] = [["Title", "Importance", "Progress", "Due", "Start", "Responsible", "Tags", "Color", "Depth", "ParentTitle"]];
  const walk = (node: GoalNode, depth: number, parentTitle: string) => {
    rows.push([
      node.title,
      String(node.importance),
      String(node.progress ?? 0),
      node.due ?? "",
      node.start ?? "",
      node.responsible.join("; "),
      node.tags.join("; "),
      node.color ?? "",
      String(depth),
      parentTitle,
    ]);
    for (const c of node.children) walk(c, depth + 1, node.title);
  };
  walk(scape.mainGoal, 0, "");
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
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
    if (!node.collapsed) {
      for (const c of node.children) walk(c, depth + 1);
    }
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
