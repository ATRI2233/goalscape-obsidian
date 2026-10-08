// src/data/templates.ts：预置模板的结构不变量。
// 权重不变量是必须的：rollup 用"同级权重总和"做除数，模板里某一层全 0 会让进度汇总退化。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TEMPLATES, getTemplate } from "../templates";
import { flattenTree } from "../types";
import type { GoalNode } from "../types";

const EXPECTED_SIZE: Record<string, number> = {
  life: 17,
  business: 14,
  fitness: 10,
  learning: 8,
};

function parents(root: GoalNode): GoalNode[] {
  return flattenTree(root).filter((n) => n.children.length > 0);
}

describe("TEMPLATES", () => {
  it("四个预置模板，id 唯一且元信息齐全", () => {
    assert.equal(TEMPLATES.length, 4);
    assert.deepEqual(
      TEMPLATES.map((t) => t.id),
      ["life", "business", "fitness", "learning"]
    );
    for (const t of TEMPLATES) {
      assert.ok(t.name && t.description, `${t.id} 需要 name/description`);
    }
  });

  for (const t of TEMPLATES) {
    it(`${t.id}: 根权重 100、每层同级权重和为 100`, () => {
      const scape = t.build();
      assert.equal(scape.version, 1);
      assert.equal(scape.mainGoal.importance, 100);
      assert.equal(
        scape.mainGoal.children.reduce((s, c) => s + c.importance, 0),
        100
      );
      for (const p of parents(scape.mainGoal)) {
        assert.ok(
          p.children.reduce((s, c) => s + c.importance, 0) > 0,
          `${p.title} 的子级权重和应大于 0`
        );
      }
    });

    it(`${t.id}: 节点数固定，id 在树内唯一，标题非空`, () => {
      const nodes = flattenTree(t.build().mainGoal);
      assert.equal(nodes.length, EXPECTED_SIZE[t.id]);
      assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length);
      assert.ok(nodes.every((n) => n.title.length > 0));
    });

    it(`${t.id}: 每次 build 都产出独立的新树`, () => {
      const a = t.build();
      const b = t.build();
      assert.notEqual(a.mainGoal, b.mainGoal);
      a.mainGoal.children[0].title = "MUTATED";
      assert.notEqual(b.mainGoal.children[0].title, "MUTATED");
      const shared = flattenTree(a.mainGoal).filter((n, i) => n === flattenTree(b.mainGoal)[i]);
      assert.deepEqual(shared, [], "两棵树之间不能共享节点对象");
    });
  }
});

describe("getTemplate", () => {
  it("按 id 命中", () => {
    assert.equal(getTemplate("fitness")?.name, "Fitness Goals");
  });

  it("未知 id 返回 undefined", () => {
    assert.equal(getTemplate("nope"), undefined);
  });
});
