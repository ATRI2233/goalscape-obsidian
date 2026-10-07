// src/export/canvasSync.ts
// 把 GoalScape 导出为 JSON Canvas (.canvas) 格式，可在 Obsidian 原生 Canvas 里打开编辑。

import { GoalNode, GoalScape } from "../data/types";

interface CanvasNode {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
}

interface JsonCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const PROGRESS_COLORS: Record<number, string> = {
  0: "1", // red
  1: "2", // orange
  2: "3", // yellow
  3: "4", // green
};

function progressToPreset(progress: number): string {
  const idx = Math.min(3, Math.floor(progress / 25));
  return PROGRESS_COLORS[idx] ?? "1";
}

export function toCanvas(scape: GoalScape): JsonCanvas {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const R = 600;
  const NODE_W = 220;
  const NODE_H = 100;

  function walk(
    node: GoalNode,
    depth: number,
    startAngle: number,
    endAngle: number,
    parentId?: string
  ): void {
    const mid = (startAngle + endAngle) / 2;
    const radius = depth === 0 ? 0 : depth * R;
    const x = Math.cos(mid) * radius;
    const y = Math.sin(mid) * radius;
    const id = node.id;

    nodes.push({
      id,
      type: "text",
      x: Math.round(x - NODE_W / 2),
      y: Math.round(y - NODE_H / 2),
      width: NODE_W,
      height: NODE_H,
      text: `**${node.title}**\n权重 ${node.importance} · 进度 ${node.progress ?? 0}%`,
      color: progressToPreset(node.progress ?? 0),
    });

    if (parentId) {
      edges.push({ id: `e-${id}`, fromNode: parentId, toNode: id });
    }

    if (!node.children.length) return;
    const total = node.children.reduce((s, c) => s + c.importance, 0);
    if (total <= 0) return;
    let acc = startAngle;
    const span = endAngle - startAngle;
    for (const c of node.children) {
      const cSpan = (c.importance / total) * span;
      walk(c, depth + 1, acc, acc + cSpan, id);
      acc += cSpan;
    }
  }

  walk(scape.mainGoal, 0, 0, Math.PI * 2);
  return { nodes, edges };
}

export function canvasToJson(canvas: JsonCanvas): string {
  return JSON.stringify(canvas, null, 2);
}
