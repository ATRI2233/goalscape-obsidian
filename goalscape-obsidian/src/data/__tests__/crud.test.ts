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

let scape: GoalScape;
beforeEach(() => {
  scape = makeScape();
});

describe("addGoal", () => {
  it("child：追加到末尾并返回可查到的新 id", () => {
    const id = addGoal(scape, "health", "child", "New");
    assert.equal(last(node(scape, "health").children)?.id, id);
    assert.equal(node(scape, id).title, "New");
    assert.equal(node(scape, id).importance, 5, "父级已分满时只给最小一档 5");
  });

  it("child：父级余量充足时封顶 50", () => {
    node(scape, "c1").importance = 10;
    node(scape, "c2").importance = 10; // career 下合计 20，剩 80
    const id = addGoal(scape, "career", "child", "Roomy");
    assert.equal(node(scape, id).importance, 50, "剩 80 → 只给上限 50");
  });

  it("child：余量不足 50 时照实给余量", () => {
    node(scape, "c1").importance = 20; // career 下合计 70，剩 30
    const id = addGoal(scape, "career", "child", "Tight");
    assert.equal(node(scape, id).importance, 30);
  });

  it("child：父级已分满时给最小一档 5", () => {
    const id = addGoal(scape, "career", "child", "Full");
    assert.equal(node(scape, id).importance, 5);
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
  it("只改自己，兄弟一动不动（importance 是占父级的比例，不再互相补偿）", () => {
    adjustImportance(scape, "health", 40);
    assert.deepEqual(
      node(scape, "root").children.map((c) => c.importance),
      [40, 30, 10],
      "career / rel 不受影响"
    );
    assert.equal(sum(node(scape, "root").children), 80, "兄弟和小于 100，剩下的是留白");
  });

  it("上限钳到 100、下限钳到 0，都不牵动兄弟", () => {
    adjustImportance(scape, "health", 150);
    assert.equal(node(scape, "health").importance, 100);
    adjustImportance(scape, "health", -20);
    assert.equal(node(scape, "health").importance, 0);
    assert.deepEqual(
      node(scape, "root").children.map((c) => c.importance),
      [0, 30, 10]
    );
  });

  it("兄弟和超过 100 也照实存着（溢出交给渲染层整体缩回）", () => {
    adjustImportance(scape, "health", 90);
    adjustImportance(scape, "career", 80);
    assert.equal(sum(node(scape, "root").children), 180);
  });

  it("中心目标没有父级，调用后仍是 100", () => {
    adjustImportance(scape, "root", 33);
    assert.equal(node(scape, "root").importance, 100);
  });
});

describe("moveGoal", () => {
  it("跨父级移动：原占比原样带过去，两端都不再被归一化", () => {
    assert.equal(moveGoal(scape, "h1", "career"), true);
    assert.equal(parentOf(scape, "h1")?.id, "career");
    assert.deepEqual(
      node(scape, "career").children.map((c) => c.id),
      ["c1", "c2", "h1"]
    );
    assert.equal(node(scape, "h1").importance, 60, "带着原占比去新父");
    assert.equal(sum(node(scape, "career").children), 160, "新父溢出 160%，由渲染层缩回");
    assert.deepEqual(
      node(scape, "health").children.map((c) => c.importance),
      [40],
      "旧父剩下的不被放大补满"
    );
    assert.equal(node(scape, "h1").children[0].id, "h1a", "子树跟着走");
  });

  it("移动到兄弟位置也不碰任何人的权重", () => {
    assert.equal(moveGoal(scape, "h2", "h1"), true);
    assert.deepEqual(
      node(scape, "h1").children.map((c) => [c.id, c.importance]),
      [["h1a", 100], ["h2", 40]]
    );
    assert.equal(node(scape, "health").children.length, 1);
    assert.equal(node(scape, "health").children[0].importance, 60, "h1 没有被补成 100");
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
