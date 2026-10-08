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
  const found = findNode(scape.mainGoal, refId);
  if (!found) return createGoalNode({ title }).id;
  const { node: ref, parent } = found;
  const host = position === "child" || !parent ? ref : parent;
  const node = createGoalNode({ title, importance: defaultImportance(host.children) });
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

/**
 * importance = 该节点占**父扇区角度**的百分比，兄弟之间不互相补偿：改一个不碰别人。
 * （旧语义是"同级权重等比缩放、和恒为 100"，那正是子级永远铺满父级一整圈的原因。）
 * 中心目标没有父级，恒为 100（整圆）。
 */
export function adjustImportance(
  scape: GoalScape,
  id: string,
  newImportance: number
): void {
  const found = findNode(scape.mainGoal, id);
  if (!found || !found.parent) return;
  found.node.importance = Math.max(0, Math.min(100, newImportance));
}

/**
 * 新节点默认占父级"还剩多少角度"，上限 50、下限 5。
 * 固定给 50 的话，连点三次 Add subgoal 就是 150%，全被渲染层的溢出缩回放平，
 * 用户看不出"这块地盘其实已经分完了"。
 */
function defaultImportance(siblings: GoalNode[]): number {
  const free = 100 - siblings.reduce((s, c) => s + c.importance, 0);
  return Math.max(5, Math.min(50, Math.round(free)));
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
  // 移动后不重新归一化：importance 是"占父级多少"，带着原值去新父下即可，
  // 两端兄弟和因此可能不等于 100 —— 留白由渲染层照实画，溢出由渲染层整体缩回。
  return true;
}

/** 深拷贝子树并生成全新 id */
function cloneSubtree(node: GoalNode): GoalNode {
  return createGoalNode({
    title: node.title,
    importance: node.importance,
    bandScale: node.bandScale,
    progress: node.progress,
    due: node.due,
    start: node.start,
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
 * 否则 Copy 之后再编辑原节点，剪贴板内容会跟着变（临时单测复现过）。
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
