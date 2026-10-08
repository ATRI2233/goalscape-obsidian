// src/data/types.ts
// 目标树核心数据模型。视图层只读这份类型，不反向依赖任何视图。

export interface GoalNode {
  id: string; // uuid
  title: string;
  importance: number; // 占父扇区角度的百分比 0-100；兄弟之和可 <100（留白）或 >100（渲染时整体缩回）
  bandScale?: number; // 本节点环带厚度倍数，未设即默认档；每棵树各层独立，所以层与层可以不对齐
  progress?: number; // 0-100，仅叶子节点手工填写；父级由引擎计算
  due?: string; // ISO date
  start?: string; // Gantt 用
  tags: string[]; // 含 "Now"/"Next" 等
  color?: string; // 用户手动色，未设则按进度渲染
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
    progress: partial.progress,
    due: partial.due,
    start: partial.start,
    tags: partial.tags ?? [],
    color: partial.color,
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
