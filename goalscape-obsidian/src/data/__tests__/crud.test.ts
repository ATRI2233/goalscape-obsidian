// src/data/crud.ts 的契约。这里锁住的都是 PROGRESS.md 记录过的真实回归点：
// 剪贴板必须是深拷贝、跨父级移动后权重要重新归一化、禁止将节点挂进自己的后代。

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  addGoal,
  adjustImportance,
  applyColorToSubtree,
  deleteGoal,
  extractSubtree,
  moveGoal,
  pasteSubtree,
  renameGoal,
} from "../crud";
import { createGoalNode, findNode, flattenTree } from "../types";
import type { GoalNode, GoalScape } from "../types";

/**
 * root(100)
 * ├─ health(60): h1(60) → h1a(100), h2(40)
 * ├─ career(30): c1(50), c2(50)
 * └─ rel(10)
 * 每层同级权重总和都是 100，方便断言归一化结果。
 */
function makeScape(): GoalScape {
  return {
    version: 1,
    mainGoal: createGoalNode({
      id: "root",
      title: "Main Goal",
      importance: 100,
      children: [
        createGoalNode({
          id: "health",
          title: "Health",
          importance: 60,
          children: [
            createGoalNode({
              id: "h1",
              title: "H1",
              importance: 60,
              children: [
                createGoalNode({
                  id: "h1a",
                  title: "H1a",
                  importance: 100,
                  tags: ["Now"],
                  fields: { kpi: "v" },
                  notes: "note",
                  color: "#123456",
                }),
              ],
            }),
            createGoalNode({ id: "h2", title: "H2", importance: 40 }),
          ],
        }),
        createGoalNode({
          id: "career",
          title: "Career",
          importance: 30,
          children: [
            createGoalNode({ id: "c1", title: "C1", importance: 50 }),
            createGoalNode({ id: "c2", title: "C2", importance: 50 }),
          ],
        }),
        createGoalNode({ id: "rel", title: "Relationships", importance: 10 }),
      ],
    }),
  };
}

function node(scape: GoalScape, id: string): GoalNode {
  const found = findNode(scape.mainGoal, id);
  assert.ok(found, `节点 ${id} 应存在`);
  return found.node;
}

function parentOf(scape: GoalScape, id: string): GoalNode | null {
  return findNode(scape.mainGoal, id)?.parent ?? null;
}

function ids(scape: GoalScape): string[] {
  return flattenTree(scape.mainGoal).map((n) => n.id);
}

function sum(nodes: GoalNode[]): number {
  return nodes.reduce((s, n) => s + n.importance, 0);
}

function last(nodes: GoalNode[]): GoalNode | undefined {
  return nodes[nodes.length - 1];
}

function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}（实际 ${actual}）`);
}

let scape: GoalScape;
beforeEach(() => {
  scape = makeScape();
});

describe("addGoal", () => {
  it("child：追加到末尾并返回可查到的新 id", () => {
    const id = addGoal(scape, "health", "child", "New");
    assert.equal(last(node(scape, "health").children)?.id, id);
    assert.equal(node(scape, id).title, "New");
    assert.equal(node(scape, id).importance, 50, "新节点走 createGoalNode 默认权重");
  });

  it("sibling：插在参照节点的下一个位置", () => {
    const id = addGoal(scape, "career", "sibling");
    assert.deepEqual(
      node(scape, "root").children.map((c) => c.id),
      ["health", "career", id, "rel"]
    );
  });

  it("参照 id 不存在：返回 id 但不碰树", () => {
    const before = ids(scape).length;
    const id = addGoal(scape, "ghost", "child");
    assert.ok(id);
    assert.equal(ids(scape).length, before);
  });

  it("默认标题是 New Goal", () => {
    const id = addGoal(scape, "rel", "child");
    assert.equal(node(scape, id).title, "New Goal");
  });
});

describe("deleteGoal", () => {
  it("中心目标删不掉", () => {
    assert.equal(deleteGoal(scape, "root"), false);
    assert.equal(node(scape, "root").children.length, 3);
  });

  it("带后代的节点整支移除", () => {
    assert.equal(deleteGoal(scape, "h1"), true);
    assert.equal(ids(scape).includes("h1"), false);
    assert.equal(ids(scape).includes("h1a"), false);
    assert.deepEqual(
      node(scape, "health").children.map((c) => c.id),
      ["h2"]
    );
  });

  it("不存在的 id 返回 false", () => {
    assert.equal(deleteGoal(scape, "ghost"), false);
  });
});

describe("renameGoal", () => {
  it("改标题", () => {
    renameGoal(scape, "h2", "Sleep");
    assert.equal(node(scape, "h2").title, "Sleep");
  });

  it("不存在的 id 不抛错", () => {
    assert.doesNotThrow(() => renameGoal(scape, "ghost", "x"));
  });
});

describe("adjustImportance", () => {
  it("改自己，同级等比缩放，总和仍是 100", () => {
    adjustImportance(scape, "health", 40);
    const siblings = node(scape, "root").children;
    assert.deepEqual(siblings.map((c) => c.importance), [40, 45, 15]);
    assert.equal(sum(siblings), 100);
  });

  it("上限钳到 100，同级被缩到 0", () => {
    adjustImportance(scape, "health", 150);
    assert.equal(node(scape, "health").importance, 100);
    assert.deepEqual(
      node(scape, "root").children.map((c) => c.importance),
      [100, 0, 0]
    );
  });

  it("下限钳到 0，同级补足总和 100", () => {
    adjustImportance(scape, "health", -20);
    assert.equal(node(scape, "health").importance, 0);
    assertClose(sum(node(scape, "root").children), 100, "同级权重总和");
  });

  it("同级权重和为 0 时不做缩放，也不会出现 NaN", () => {
    const tiny: GoalScape = {
      version: 1,
      mainGoal: createGoalNode({
        id: "r",
        title: "r",
        children: [
          createGoalNode({ id: "a", title: "a", importance: 100 }),
          createGoalNode({ id: "b", title: "b", importance: 0 }),
        ],
      }),
    };
    adjustImportance(tiny, "a", 20);
    assert.equal(node(tiny, "a").importance, 20);
    assert.equal(node(tiny, "b").importance, 0);
    assertClose(sum(node(tiny, "r").children), 20, "同级和为 0 时不做缩放");
  });

  it("中心目标没有同级，调用后不变", () => {
    adjustImportance(scape, "root", 33);
    assert.equal(node(scape, "root").importance, 100);
  });
});

describe("moveGoal", () => {
  it("跨父级移动后两端同级都重新归一化到 100", () => {
    assert.equal(moveGoal(scape, "h1", "career"), true);
    assert.equal(parentOf(scape, "h1")?.id, "career");
    assert.deepEqual(
      node(scape, "career").children.map((c) => c.id),
      ["c1", "c2", "h1"]
    );
    assertClose(sum(node(scape, "career").children), 100, "新父级同级权重总和");
    assertClose(sum(node(scape, "health").children), 100, "只剩 h2，补成整支权重");
    assert.equal(node(scape, "h1").children[0].id, "h1a", "子树跟着走");
  });

  it("移动到兄弟位置也对两端归一化", () => {
    assert.equal(moveGoal(scape, "h2", "h1"), true);
    assertClose(sum(node(scape, "h1").children), 100, "新父级同级权重总和");
    assert.equal(node(scape, "health").children.length, 1);
    assert.equal(node(scape, "health").children[0].importance, 100);
  });

  it("禁止挂到自己或自己的后代下，且树保持原样", () => {
    const before = JSON.stringify(scape);
    assert.equal(moveGoal(scape, "h1", "h1"), false);
    assert.equal(moveGoal(scape, "h1", "h1a"), false, "后代");
    assert.equal(moveGoal(scape, "root", "career"), false, "中心目标不参与");
    assert.equal(moveGoal(scape, "h1", "ghost"), false, "目标不存在");
    assert.equal(JSON.stringify(scape), before);
  });

  it("环检测在摘除节点之前，失败移动不会留下空洞", () => {
    assert.equal(moveGoal(scape, "h1", "h1a"), false);
    assert.equal(node(scape, "health").children.length, 2);
    assert.equal(parentOf(scape, "h1")?.id, "health");
  });
});

describe("extractSubtree / pasteSubtree", () => {
  it("extract 返回深拷贝快照，之后编辑原节点不会串改剪贴板", () => {
    const clip = extractSubtree(scape, "health");
    assert.ok(clip);
    assert.notEqual(clip.id, "health", "id 必须重生成");
    assert.deepEqual(
      flattenTree(clip).map((n) => n.title),
      ["Health", "H1", "H1a", "H2"],
      "结构完整，但全是新对象"
    );
    const liveIds = new Set(ids(scape));
    assert.ok(
      flattenTree(clip).every((n) => !liveIds.has(n.id)),
      "快照里每个节点都必须是全新 id"
    );

    renameGoal(scape, "h1", "MUTATED");
    node(scape, "h1a").tags.push("Later");
    node(scape, "h1a").fields!.kpi = "changed";

    assert.equal(node(scape, "h1").title, "MUTATED");
    assert.equal(clip.children[0].title, "H1", "快照不能是活引用");
    assert.deepEqual(clip.children[0].children[0].tags, ["Now"]);
    assert.deepEqual(clip.children[0].children[0].fields, { kpi: "v" });
    assert.notEqual(clip.children[0].children[0].tags, node(scape, "h1a").tags);
  });

  it("extract 不存在的 id 返回 null", () => {
    assert.equal(extractSubtree(scape, "ghost"), null);
  });

  it("作为 child 粘到末尾", () => {
    const clip = extractSubtree(scape, "health")!;
    const id = pasteSubtree(scape, "rel", "child", clip);
    assert.equal(last(node(scape, "rel").children)?.id, id);
    assert.notEqual(id, clip.id, "两次粘贴各自生成 id");
  });

  it("作为 sibling 插在参照节点后面", () => {
    const clip = extractSubtree(scape, "health")!;
    const id = pasteSubtree(scape, "career", "sibling", clip);
    assert.deepEqual(
      node(scape, "root").children.map((c) => c.id),
      ["health", "career", id, "rel"]
    );
  });

  it("同一份剪贴板粘两次得到两棵独立的树", () => {
    const clip = extractSubtree(scape, "h1")!;
    const first = pasteSubtree(scape, "rel", "child", clip);
    const second = pasteSubtree(scape, "rel", "child", clip);
    assert.notEqual(first, second);
    const a = node(scape, first);
    const b = node(scape, second);
    assert.notEqual(a, b);
    assert.notEqual(a.children[0].children, b.children[0].children);
    renameGoal(scape, a.children[0].id, "only-a");
    assert.equal(b.children[0].title, "H1a");
  });

  it("剪贴板里的原树节点被改，已粘贴的副本不受影响", () => {
    const clip = extractSubtree(scape, "h1")!;
    const pasted = pasteSubtree(scape, "rel", "child", clip);
    renameGoal(scape, "h1a", "MUTATED");
    assert.equal(node(scape, pasted).children[0].title, "H1a");
  });

  it("参照 id 不存在：返回原 id 且不碰树", () => {
    const clip = extractSubtree(scape, "h1")!;
    const before = ids(scape).length;
    assert.equal(pasteSubtree(scape, "ghost", "child", clip), clip.id);
    assert.equal(ids(scape).length, before);
  });
});

describe("applyColorToSubtree", () => {
  it("只影响后代，不动自己和旁支", () => {
    node(scape, "health").color = "#ff0000";
    applyColorToSubtree(scape, "health");
    assert.equal(node(scape, "health").color, "#ff0000", "自身保持原值");
    assert.equal(node(scape, "h1").color, "#ff0000");
    assert.equal(node(scape, "h1a").color, "#ff0000");
    assert.equal(node(scape, "h2").color, "#ff0000");
    assert.equal(node(scape, "c1").color, undefined);
  });

  it("自身没设色时等于清空整支手配色", () => {
    applyColorToSubtree(scape, "health");
    assert.equal(node(scape, "h1a").color, undefined);
    assert.equal(node(scape, "h1").color, undefined);
  });

  it("不存在的 id 不抛错", () => {
    assert.doesNotThrow(() => applyColorToSubtree(scape, "ghost"));
  });
});
