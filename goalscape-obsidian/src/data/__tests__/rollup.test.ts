// src/data/rollup.ts 的契约：叶子手填、父级按权重加权平均，逐级滚到中心。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { computeProgress, recalcTree } from "../rollup";
import { createGoalNode } from "../types";
import type { GoalNode } from "../types";

function leaf(progress: number | undefined, importance = 50): GoalNode {
  return createGoalNode({ title: "leaf", importance, progress });
}

describe("computeProgress", () => {
  it("叶子：填了就用，没填算 0", () => {
    assert.equal(computeProgress(leaf(80)), 80);
    assert.equal(computeProgress(leaf(undefined)), 0);
  });

  it("父级按同级权重加权平均", () => {
    const parent: GoalNode = {
      ...createGoalNode({ title: "parent" }),
      children: [leaf(80, 60), leaf(20, 40)],
    };
    // (60*80 + 40*20) / 100
    assert.equal(computeProgress(parent), 56);
  });

  it("真实回归：叶子 80 → Health 80 → 根 48", () => {
    const scape = {
      version: 1 as const,
      mainGoal: createGoalNode({
        title: "Main Goal",
        importance: 100,
        children: [
          createGoalNode({ title: "Health", importance: 60, children: [leaf(80, 100)] }),
          leaf(0, 40),
        ],
      }),
    };
    recalcTree(scape.mainGoal);
    assert.equal(scape.mainGoal.children[0].progress, 80);
    assert.equal(scape.mainGoal.progress, 48);
  });

  it("同级权重全为 0 时退化成简单平均，不是 0 也不是 NaN", () => {
    const parent: GoalNode = {
      ...createGoalNode({ title: "parent" }),
      children: [leaf(40, 0), leaf(10, 0)],
    };
    assert.equal(computeProgress(parent), 25);
  });

  it("结果四舍五入到整数", () => {
    const parent: GoalNode = {
      ...createGoalNode({ title: "parent" }),
      children: [leaf(100, 2), leaf(0, 1)],
    };
    // 200/3 = 66.67
    assert.equal(computeProgress(parent), 67);
  });
});

describe("recalcTree", () => {
  it("自底向上逐级滚动", () => {
    const root = createGoalNode({
      title: "root",
      children: [
        createGoalNode({ title: "A", importance: 50, children: [leaf(100, 60), leaf(0, 40)] }),
        createGoalNode({ title: "B", importance: 50, children: [leaf(30, 100)] }),
      ],
    });
    recalcTree(root);
    assert.equal(root.children[0].progress, 60);
    assert.equal(root.children[1].progress, 30);
    // (50*60 + 50*30) / 100
    assert.equal(root.progress, 45);
  });

  it("只覆盖父级，叶子手填的进度原样保留", () => {
    const l = leaf(73, 50);
    const root = createGoalNode({ title: "root", children: [l] });
    recalcTree(root);
    assert.equal(l.progress, 73);
    assert.equal(root.progress, 73);
  });

  it("整树全 0 时给根补出显式 0（落盘 JSON 会多出 progress 字段）", () => {
    const root = createGoalNode({ title: "root", children: [leaf(undefined, 50)] });
    recalcTree(root);
    assert.equal(root.progress, 0);
    assert.equal(root.children[0].progress, undefined);
  });

  it("改一个叶子后重算，整条祖先链都跟着变", () => {
    const deepLeaf = leaf(0, 50);
    const mid = createGoalNode({ title: "mid", importance: 50, children: [deepLeaf] });
    const root = createGoalNode({
      title: "root",
      children: [mid, leaf(0, 50)],
    });
    recalcTree(root);
    assert.equal(root.progress, 0);
    deepLeaf.progress = 100;
    recalcTree(root);
    assert.equal(mid.progress, 100);
    assert.equal(root.progress, 50);
  });
});
