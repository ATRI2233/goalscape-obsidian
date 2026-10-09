// src/data/notes.ts 的契约：摘要的剥记号与截断、反链的现扫语义、
// links 清洗（去重/自链/死目标/空数组删键）。
// 这些规则一旦被 views/export 层消费就改不动了，全部锁在这里。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { backlinks, firstLine, pruneLinks } from "../notes";
import { createGoalNode, findNode } from "../types";
import type { GoalNode, GoalScape } from "../types";

describe("firstLine", () => {
  it("跳过空行与标题行，取第一条正文", () => {
    assert.equal(firstLine("## 标题\n\n  正文第一句。"), "正文第一句。");
  });

  it("剥掉 markdown 记号：粗体/行内码/wikilink/外链接", () => {
    assert.equal(firstLine("见 **重点** 与 `code`，[[某笔记|别名]]，[官网](https://x)") ,
      "见 重点 与 code，某笔记，官网");
  });

  it("超长截断带省略号", () => {
    const s = firstLine("一二三四五六七八九十", 5);
    assert.equal(s, "一二三四…");
    assert.equal(s.length, 5);
  });

  it("全是标题/围栏/空白 → 空串", () => {
    assert.equal(firstLine("# a\n# b\n```\ncode\n```\n"), "");
    assert.equal(firstLine(""), "");
  });
});

/** root ├─ a └─ b(→a) … 各测试自己加 links */
function makeTree(): GoalScape {
  return {
    version: 1,
    mainGoal: createGoalNode({
      id: "root",
      title: "R",
      importance: 100,
      children: [
        createGoalNode({ id: "a", title: "A", importance: 50 }),
        createGoalNode({ id: "b", title: "B", importance: 50, links: ["a"] }),
      ],
    }),
  };
}

describe("backlinks", () => {
  it("返回引用方（DFS 序），不含自己", () => {
    const s = makeTree();
    findNode(s.mainGoal, "root")!.node.links = ["b"];
    assert.deepEqual(
      backlinks(s.mainGoal, "a").map((n) => n.id),
      ["b"]
    );
    assert.deepEqual(
      backlinks(s.mainGoal, "b").map((n) => n.id),
      ["root"]
    );
  });

  it("没人引用就是空数组", () => {
    assert.deepEqual(backlinks(makeTree().mainGoal, "root"), []);
  });
});

describe("pruneLinks", () => {
  it("去重、剔自链、剔死目标", () => {
    const s = makeTree();
    const a = findNode(s.mainGoal, "a")!.node;
    a.links = ["a", "ghost", "b", "b"];
    pruneLinks(s.mainGoal);
    assert.deepEqual(a.links, ["b"]);
  });

  it("清空后删键，不留空数组", () => {
    const s = makeTree();
    findNode(s.mainGoal, "b")!.node.links = ["ghost"];
    pruneLinks(s.mainGoal);
    const b = findNode(s.mainGoal, "b")!.node as GoalNode;
    assert.ok(!("links" in b), "空 links 应该整个删掉");
  });

  it("幂等", () => {
    const s = makeTree();
    pruneLinks(s.mainGoal);
    pruneLinks(s.mainGoal);
    assert.deepEqual(findNode(s.mainGoal, "b")!.node.links, ["a"]);
  });
});
