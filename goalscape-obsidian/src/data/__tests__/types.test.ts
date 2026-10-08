// src/data/types.ts 的契约：节点默认值、id 唯一性、树遍历工具、分支色相的唯一来源。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_BRANCH_COLOR, branchColors, createGoalNode, findNode, flattenTree, generateId } from "../types";
import type { GoalNode } from "../types";

describe("createGoalNode", () => {
  it("未给的字段落到约定默认值", () => {
    const node = createGoalNode({ title: "Health" });
    assert.equal(node.title, "Health");
    assert.equal(node.importance, 50);
    assert.deepEqual(node.tags, []);
    assert.deepEqual(node.children, []);
    assert.equal(node.progress, undefined);
    assert.equal(node.collapsed, undefined);
    assert.ok(node.id, "缺 id 时自动生成");
  });

  it("显式给的字段原样保留，包括传入的 id", () => {
    const node = createGoalNode({
      id: "fixed-id",
      title: "Career",
      importance: 80,
      progress: 25,
      tags: ["Now"],
      collapsed: true,
      fields: { kpi: "revenue" },
    });
    assert.equal(node.id, "fixed-id");
    assert.equal(node.importance, 80);
    assert.equal(node.progress, 25);
    assert.equal(node.collapsed, true);
    assert.deepEqual(node.fields, { kpi: "revenue" });
  });
});

describe("generateId", () => {
  it("同一毫秒内批量生成也不重复", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(generateId());
    assert.equal(ids.size, 2000);
  });
});

function tree(): GoalNode {
  return createGoalNode({
    id: "root",
    title: "Main Goal",
    children: [
      createGoalNode({
        id: "health",
        title: "Health",
        children: [createGoalNode({ id: "run", title: "Run 5k" })],
      }),
      createGoalNode({ id: "career", title: "Career" }),
    ],
  });
}

describe("findNode", () => {
  it("根节点 parent 为 null", () => {
    const found = findNode(tree(), "root");
    assert.ok(found);
    assert.equal(found.node.title, "Main Goal");
    assert.equal(found.parent, null);
  });

  it("深层节点带回它的父节点", () => {
    const found = findNode(tree(), "run");
    assert.ok(found);
    assert.equal(found.parent?.id, "health");
  });

  it("不存在的 id 返回 null", () => {
    assert.equal(findNode(tree(), "ghost"), null);
  });
});

describe("flattenTree", () => {
  it("前序遍历，含根", () => {
    assert.deepEqual(
      flattenTree(tree()).map((n) => n.id),
      ["root", "health", "run", "career"]
    );
  });

  it("折叠状态不影响遍历结果", () => {
    const t = tree();
    t.children[0].collapsed = true;
    assert.equal(flattenTree(t).length, 4);
  });
});

describe("branchColors", () => {
  /** root → health(#f87171) → run；career 未配色 */
  function colored(): GoalNode {
    return createGoalNode({
      id: "root",
      title: "Main Goal",
      color: "#0000ff",
      children: [
        createGoalNode({
          id: "health",
          title: "Health",
          color: "#f87171",
          children: [
            createGoalNode({
              id: "run",
              title: "Run 5k",
              color: "#00ff00",
              children: [createGoalNode({ id: "shoes", title: "Buy shoes" })],
            }),
          ],
        }),
        createGoalNode({ id: "career", title: "Career" }),
      ],
    });
  }

  it("只有二级节点的值生效，整条分支共用它", () => {
    const hues = branchColors(colored());
    assert.equal(hues.get("health"), "#f87171");
    assert.equal(hues.get("run"), "#f87171", "三级继承二级，即使自己存了别的颜色");
    assert.equal(hues.get("shoes"), "#f87171", "继承一直传到叶子");
  });

  it("中心盘自己一个色，且不往下传", () => {
    const hues = branchColors(colored());
    assert.equal(hues.get("root"), "#0000ff", "根持有的色相只归中心盘");
    assert.equal(hues.get("run"), "#f87171", "分支不跟着中心盘走，仍认自己那一级的值");
    assert.equal(hues.get("career"), DEFAULT_BRANCH_COLOR, "没配色的分支用默认色");
  });

  it("改二级节点即改整条分支，不存在父子不一致的状态", () => {
    const t = colored();
    const before = branchColors(t).get("shoes");
    t.children[0].color = "#38bdf8";
    assert.equal(branchColors(t).get("shoes"), "#38bdf8");
    assert.notEqual(before, "#38bdf8");
  });

  it("换父级后跟着新分支走", () => {
    const t = colored();
    const run = findNode(t, "run")!;
    run.parent!.children.splice(run.parent!.children.indexOf(run.node), 1);
    t.children[1].children.push(run.node);
    const hues = branchColors(t);
    assert.equal(hues.get("run"), DEFAULT_BRANCH_COLOR, "挪进未配色的分支后不再带旧色相");
    assert.equal(hues.get("shoes"), DEFAULT_BRANCH_COLOR);
  });
});
