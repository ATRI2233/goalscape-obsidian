// src/data/types.ts
// 目标树核心数据模型。视图层只读这份类型，不反向依赖任何视图。

export interface GoalNode {
  id: string; // uuid
  title: string;
  importance: number; // 占父扇区角度的百分比 0-100；兄弟之和可 <100（留白）或 >100（渲染时整体缩回）
  bandScale?: number; // 本节点环带厚度倍数，未设即默认档；每棵树各层独立，所以层与层可以不对齐
  /**
   * 本节点自己的色相：**只有中心盘（根）和二级节点（根的直接子节点）持有**。
   * 更深层一律不存这个字段（读档时清掉），颜色一律由 branchColors 沿父链解析 ——
   * 存两份就会有"父改了子没改"和"父子色系不一致"，不存就没有这两个状态。
   */
  color?: string;
  brightness?: number; // 明度偏移 -20..20，未设即 0（默认）；任何节点都能调，自动的环层区分仍叠加在上面
  progress?: number; // 0-100，仅叶子节点手工填写；父级由引擎计算
  due?: string; // ISO date
  start?: string; // Gantt 用
  tags: string[]; // 含 "Now"/"Next" 等
  notes?: string; // Markdown
  fields?: Record<string, string>; // 自定义字段
  collapsed?: boolean;
  children: GoalNode[];
}

export interface GoalScape {
  version: 1;
  mainGoal: GoalNode;
  colorMeanings?: Record<string, string>; // 颜色 → 含义标签
}

export function createGoalNode(partial: Partial<GoalNode> & { title: string }): GoalNode {
  return {
    id: partial.id ?? generateId(),
    title: partial.title,
    importance: partial.importance ?? 50,
    bandScale: partial.bandScale,
    color: partial.color,
    brightness: partial.brightness,
    progress: partial.progress,
    due: partial.due,
    start: partial.start,
    tags: partial.tags ?? [],
    notes: partial.notes,
    fields: partial.fields,
    collapsed: partial.collapsed,
    children: partial.children ?? [],
  };
}

let idCounter = 0;
export function generateId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** 树遍历工具：DFS 查找节点及其父节点 */
export function findNode(
  root: GoalNode,
  id: string
): { node: GoalNode; parent: GoalNode | null } | null {
  if (root.id === id) return { node: root, parent: null };
  const stack: Array<{ node: GoalNode; parent: GoalNode }> = root.children.map((c) => ({
    node: c,
    parent: root,
  }));
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (node.id === id) return { node, parent };
    for (const c of node.children) stack.push({ node: c, parent: node });
  }
  return null;
}

/** 收集整棵树所有节点 */
export function flattenTree(root: GoalNode): GoalNode[] {
  const out: GoalNode[] = [];
  const walk = (n: GoalNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** 没设色相时的默认底色（插件的进度绿），中心盘与没配色的分支都用它 */
export const DEFAULT_BRANCH_COLOR = "#4ade80";
/** 持有 color 的最深层：中心盘（0）管自己，二级节点（1）管整条分支，更深层一律继承 */
export const HUE_OWNER_DEPTH = 1;

/**
 * 沿父链解析每个节点实际使用的色相，一次遍历出全图。
 * 放射图 / Gantt / CSV / Focus Filter 都从这里取 —— 颜色只有一个来源，
 * 所以"父改色子没改""父子色系不一致"这两个状态在数据里根本不存在。
 * 中心盘自己一个色（不往下传，各分支照旧认自己那一级的值）；
 * 深层节点继承所属的二级分支；把节点拖到别的分支下，颜色自动跟着新分支走。
 */
export function branchColors(root: GoalNode): Map<string, string> {
  const out = new Map<string, string>();
  const rec = (n: GoalNode, inherited: string, depth: number) => {
    const color = depth <= HUE_OWNER_DEPTH ? n.color || DEFAULT_BRANCH_COLOR : inherited;
    out.set(n.id, color);
    for (const c of n.children) rec(c, color, depth + 1);
  };
  rec(root, DEFAULT_BRANCH_COLOR, 0);
  return out;
}
