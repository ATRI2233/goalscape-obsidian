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
  /**
   * 这个块的笔记文件（vault 路径）。**正文只活在那个 .md 里，JSON 不存第二份** ——
   * 两份可写副本必然要同步，同步就会打架，而数据层没有 undo，输掉的那一份找不回来。
   * 编辑＝在 Obsidian 里打开这个文件，于是 `[[` 补全、嵌入、反链面板、全局搜索、
   * 关系图谱全都是白拿的，插件自己不必再造一个编辑器。
   * 文件 frontmatter 里带 gsId：用户在 Obsidian 里把它改名或挪走之后还能按 id 找回来。
   */
  note?: string;
  /** @deprecated 旧版把 Markdown 正文直接存在 JSON 里；读档后由 NoteStore 迁移成文件并删掉 */
  notes?: string;
  /**
   * 块间链接：**显式存目标节点 id**，不用 `[[标题]]` 模糊匹配 ——
   * goal 不是 vault 文件，标题撞名时歧义不可判定。
   * 有意的单向设计：A→B 不代表 B→A，反向由 backlinks() 现扫，不存两份。
   */
  links?: string[];
  collapsed?: boolean;
  children: GoalNode[];
}

export interface GoalScape {
  version: 1;
  mainGoal: GoalNode;
  colorMeanings?: Record<string, string>; // 颜色 → 含义标签
}

/**
 * 一个块的笔记在 vault 里的样子。由 NoteStore 读文件 + metadataCache 填好，
 * 内层（导出 / 几何 / 数据）只吃这份纯数据 —— 分层守卫不允许它们 import obsidian。
 */
export interface NoteInfo {
  path: string; // 笔记文件路径
  text: string; // 正文，已剥掉 frontmatter
  links: string[]; // 正文里解析成功的 [[wikilink]] 目标路径；嵌入不算，指不到的不算
}

/** goalId → 笔记。没有笔记文件的块不出现在里面 */
export type NoteIndex = Map<string, NoteInfo>;

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
    note: partial.note,
    links: partial.links,
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
