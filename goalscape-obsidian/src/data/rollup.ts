// src/data/rollup.ts
// 进度自动汇总引擎：叶子节点手动填进度，父级 = Σ(子权重×子进度)/Σ权重，逐级向上滚到中心。

import { GoalNode } from "./types";

export function computeProgress(node: GoalNode): number {
  if (!node.children.length) return node.progress ?? 0;
  const totalWeight = node.children.reduce((s, c) => s + c.importance, 0);
  if (totalWeight === 0) {
    // 所有子节点权重为 0 时退化为简单平均，避免整支被显示为 0
    const avg = node.children.reduce((s, c) => s + computeProgress(c), 0);
    return Math.round(avg / node.children.length);
  }
  const weighted = node.children.reduce(
    (s, c) => s + c.importance * computeProgress(c),
    0
  );
  return Math.round(weighted / totalWeight);
}

/** 编辑器每次改叶子 progress，触发整棵树重算 */
export function recalcTree(root: GoalNode): void {
  const walk = (n: GoalNode) => {
    n.children.forEach(walk);
    if (n.children.length) n.progress = computeProgress(n);
  };
  walk(root);
}
