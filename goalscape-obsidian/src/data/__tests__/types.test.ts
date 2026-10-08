// src/data/types.ts 的契约：节点默认值、id 唯一性、树遍历工具。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createGoalNode, findNode, flattenTree, generateId } from "../types";
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
