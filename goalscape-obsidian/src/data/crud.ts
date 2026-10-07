// src/data/crud.ts
// 子树级别的增删改 / 剪切复制粘贴 / 重挂载。全部走 store.mutate，
// 由 store 统一负责进度汇总、落盘与视图通知。

import { GoalScape, GoalNode, createGoalNode, findNode } from "./types";

export type AddPosition = "child" | "sibling";

export function addGoal(
  scape: GoalScape,
  refId: string,
  position: AddPosition,
  title = "New Goal"
): string {
  const node = createGoalNode({ title });
  const found = findNode(scape.mainGoal, refId);
  if (!found) return node.id;
  const { node: ref, parent } = found;
  if (position === "child" || !parent) {
    ref.children.push(node);
  } else {
    const idx = parent.children.findIndex((c) => c.id === refId);
    parent.children.splice(idx + 1, 0, node);
  }
  return node.id;
}

export function deleteGoal(scape: GoalScape, id: string): boolean {
  if (scape.mainGoal.id === id) return false; // 中心目标不可删除
  const found = findNode(scape.mainGoal, id);
  if (!found?.parent) return false;
  const idx = found.parent.children.findIndex((c) => c.id === id);
  if (idx >= 0) found.parent.children.splice(idx, 1);
  return true;
}

export function renameGoal(scape: GoalScape, id: string, title: string): void {
  const found = findNode(scape.mainGoal, id);
  if (found) found.node.title = title;
}

/** 权重调整：等比缩放 siblings 中除自身外的权重，保证总和恒定（邻居互斥） */
export function adjustImportance(
  scape: GoalScape,
  id: string,
  newImportance: number
): void {
  const found = findNode(scape.mainGoal, id);
  if (!found?.parent) return;
  const siblings = found.parent.children;
  const others = siblings.filter((c) => c.id !== id);
  const oldSelf = found.node.importance;
  const othersTotal = others.reduce((s, c) => s + c.importance, 0);
  const target = Math.max(0, Math.min(100, newImportance));
  found.node.importance = target;
  if (othersTotal > 0) {
    const scale = (100 - target) / othersTotal;
    for (const c of others) c.importance = Math.round(c.importance * scale * 100) / 100;
  }
  // 主目标是根，无 siblings，无需处理
  if (oldSelf === target) return;
}

/**
 * 把一组 siblings 的 importance 等比缩放到总和为 100。
 * adjustImportance 假设"同级权重总和恒为 100"，moveGoal 改变了两端父级的
 * 子节点集合，必须在这里重新归一化，否则该假设在跨父级移动后失真
 * （已通过单测复现：移动后剩余 siblings 总和会漂移到 100 以外）。
 */
function renormalizeSiblings(children: GoalNode[]): void {
  if (!children.length) return;
  const total = children.reduce((s, c) => s + c.importance, 0);
  if (total <= 0) {
    const even = Math.round((100 / children.length) * 100) / 100;
    for (const c of children) c.importance = even;
    return;
  }
  const scale = 100 / total;
  for (const c of children) c.importance = Math.round(c.importance * scale * 100) / 100;
}

/** 拖拽重挂载：把节点从旧父移到新父下。禁止移到自己或自己的后代下。 */
export function moveGoal(scape: GoalScape, id: string, newParentId: string): boolean {
  if (id === scape.mainGoal.id || id === newParentId) return false;
  const moving = findNode(scape.mainGoal, id);
  const target = findNode(scape.mainGoal, newParentId);
  if (!moving?.parent || !target) return false;
  // 禁止挂到自己的后代
  let p: GoalNode | null = target.node;
  while (p) {
    if (p.id === id) return false;
    const f = findNode(scape.mainGoal, p.id);
    p = f?.parent ?? null;
  }
  const idx = moving.parent.children.findIndex((c) => c.id === id);
  const [node] = moving.parent.children.splice(idx, 1);
  target.node.children.push(node);
  renormalizeSiblings(moving.parent.children);
  renormalizeSiblings(target.node.children);
  return true;
}

/** 深拷贝子树并生成全新 id */
function cloneSubtree(node: GoalNode): GoalNode {
  return createGoalNode({
    title: node.title,
    importance: node.importance,
    progress: node.progress,
    due: node.due,
    start: node.start,
    responsible: [...node.responsible],
    tags: [...node.tags],
    color: node.color,
    notes: node.notes,
    fields: node.fields ? { ...node.fields } : undefined,
    collapsed: node.collapsed,
    children: node.children.map(cloneSubtree),
  });
}

/** 粘贴子树到 ref 下（child = 作为最后一个子节点，sibling = 作为下一个兄弟） */
export function pasteSubtree(
  scape: GoalScape,
  refId: string,
  position: AddPosition,
  payload: GoalNode
): string {
  const found = findNode(scape.mainGoal, refId);
  if (!found) return payload.id;
  const clone = cloneSubtree(payload);
  if (position === "child" || !found.parent) {
    found.node.children.push(clone);
  } else {
    const idx = found.parent.children.findIndex((c) => c.id === refId);
    found.parent.children.splice(idx + 1, 0, clone);
  }
  return clone.id;
}

/**
 * 复制/剪切都从这里取数据：必须返回深拷贝的快照，而不是树里的活引用。
 * 否则 Copy 之后再编辑原节点，剪贴板内容会跟着变（已通过单测复现过）。
 */
export function extractSubtree(scape: GoalScape, id: string): GoalNode | null {
  const found = findNode(scape.mainGoal, id);
  return found ? cloneSubtree(found.node) : null;
}

/** 把节点当前的 color 应用到它的所有后代（含清空：color 未设时后代也会被清空）。 */
export function applyColorToSubtree(scape: GoalScape, id: string): void {
  const found = findNode(scape.mainGoal, id);
  if (!found) return;
  const color = found.node.color;
  const walk = (n: GoalNode) => {
    for (const c of n.children) {
      c.color = color;
      walk(c);
    }
  };
  walk(found.node);
}
