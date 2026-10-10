// src/export/exporters.ts
// 文本类导出（CSV / Markdown 大纲）：只吃 GoalScape + NoteIndex 产出字符串，
// 不碰 document，所以在 node 里能全量单测。
// 要真实 DOM 的那半边在 svgExport.ts（PNG/SVG）和 download.ts（存盘动作）。

import { GoalNode, GoalScape, NoteIndex, NoteRef, flattenTree } from "../data/types";
import { DEFAULT_TONE, Tone, branchFills } from "../data/palette";
import { firstLine, outgoingRefs } from "../data/notes";

export function exportCsv(
  scape: GoalScape,
  tone: Tone = DEFAULT_TONE,
  notes?: NoteIndex
): string {
  const rows: string[][] = [
    ["Title", "Importance", "Progress", "Due", "Start", "Tags", "Color", "Depth", "ParentTitle", "Notes", "NoteFile", "References"],
  ];
  // 导出的是节点在图上实际呈现的那个颜色，而不是"存了这个字段"——
  // 深层节点不存色、浓淡也不由存值决定，但图上确实有颜色
  const fills = branchFills(scape.mainGoal, tone);
  const titles = titleIndex(scape);
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
      firstLine(notes?.get(node.id)?.text ?? ""),
      notes?.get(node.id)?.path ?? "",
      outgoingRefs(notes ?? NO_NOTES, node.id)
        .map((r) => `${refLabel(r, titles)}${r.anchor}`)
        .join("; "),
    ]);
    for (const c of node.children) walk(c, depth + 1, node.title);
  };
  walk(scape.mainGoal, 0, "");
  // BOM：Excel 没有它就按本地代码页解 UTF-8，中文标题会变成乱码
  return String.fromCharCode(0xfeff) + rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}

/** 目标 id → 标题：链接在两份导出里都得显示成人看得懂的名字，而不是内部 id */
function titleIndex(scape: GoalScape): Map<string, string> {
  return new Map(flattenTree(scape.mainGoal).map((n) => [n.id, n.title]));
}

/** 导出时"没笔记"和"没传索引"是同一件事，别让下游到处判空 */
const NO_NOTES: NoteIndex = new Map();

/** 关系在导出里的显示名：对方块的标题；标题查不到（对方已被删）就退回文件名。锚点跟着 */
function refLabel(r: NoteRef, titles: Map<string, string>): string {
  return (r.goalId && titles.get(r.goalId)) || (r.path.split("/").pop() ?? r.path).replace(/\.md$/i, "");
}

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function exportMarkdownOutline(scape: GoalScape, notes?: NoteIndex): string {
  const lines: string[] = [];
  const titles = titleIndex(scape);
  const walk = (node: GoalNode, depth: number) => {
    const indent = "  ".repeat(depth);
    const prog = node.children.length ? `(auto: ${node.progress ?? 0}%)` : `(${node.progress ?? 0}%)`;
    lines.push(`${indent}- **${node.title}** ${prog} [w:${node.importance}]`);
    const note = notes?.get(node.id);
    const summary = firstLine(note?.text ?? "");
    // 导出的大纲是拿去 Obsidian 里看的：有笔记文件就写成 wikilink，摘要当别名，点了能跳过去
    if (note) lines.push(`${indent}  [[${note.path.replace(/\.md$/, "")}|${summary || "笔记"}]]`);
    else if (summary) lines.push(`${indent}  ${summary}`);
    // 块间关系逐条写成带锚点的 wikilink：在 Obsidian 里点了直接跳到对方笔记的那一节
    for (const r of outgoingRefs(notes ?? NO_NOTES, node.id)) {
      lines.push(`${indent}  → [[${r.path.replace(/\.md$/, "")}${r.anchor}|${refLabel(r, titles)}]]`);
    }
    // 不按 collapsed 过滤：折叠只是放射图的视图状态，导出大纲时据此跳过会静默丢失整棵子树
    for (const c of node.children) walk(c, depth + 1);
  };
  walk(scape.mainGoal, 0);
  return lines.join("\n");
}
