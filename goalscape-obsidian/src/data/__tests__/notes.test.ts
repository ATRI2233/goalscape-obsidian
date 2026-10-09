// src/data/notes.ts 的契约：markdown 里"什么算链接/tag"的边界、摘要的剥记号与截断、
// 反链的现扫语义、links 清洗（去重/自链/死目标/空数组删键）。
// 这些规则一旦被 views/export 层消费就改不动了，全部锁在这里。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  backlinks,
  effectiveTags,
  firstLine,
  parseTags,
  parseWikiTargets,
  pruneLinks,
} from "../notes";
import { createGoalNode, findNode } from "../types";
import type { GoalNode, GoalScape } from "../types";

describe("parseWikiTargets", () => {
  it("取目标、去别名、去小节后缀", () => {
    assert.deepEqual(parseWikiTargets("看 [[某笔记]]、[[Another|显示名]]、[[Third#小节]]"), [
      "某笔记",
      "Another",
      "Third",
    ]);
  });

  it("![[嵌入]] 不算链接目标", () => {
    assert.deepEqual(parseWikiTargets("![[img.png]] 配图，另见 [[真链接]]"), ["真链接"]);
  });

  it("围栏代码块整体跳过", () => {
    const md = "前 [[a]]\n```\n[[不该收]] #tag\n```\n~~~\n[[也不该收]]\n~~~\n后 [[b]]";
    assert.deepEqual(parseWikiTargets(md), ["a", "b"]);
  });

  it("重复去重、保序", () => {
    assert.deepEqual(parseWikiTargets("[[b]] 和 [[a]] 和 [[b]]"), ["b", "a"]);
  });

  it("空输入与无链接输入", () => {
    assert.deepEqual(parseWikiTargets(""), []);
    assert.deepEqual(parseWikiTargets("纯文本，没有链接"), []);
  });
});

describe("parseTags", () => {
  it("取 #tag，行内要有前导边界（foo#bar 不算）", () => {
    assert.deepEqual(parseTags("#now 做这个，见 bar#nope，还有 (later)"), ["now"]);
  });

  it("纯数字不是 tag；`# 标题` 不是 tag", () => {
    assert.deepEqual(parseTags("#123\n# 一级标题 #real"), ["real"]);
  });

  it("允许 / - _，跳过代码块，去重保序", () => {
    const md = "#a/b #c-d #a/b\n```\n#fence\n```\n#e";
    assert.deepEqual(parseTags(md), ["a/b", "c-d", "e"]);
  });
});

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

describe("effectiveTags", () => {
  it("字段在前、正文在后；大小写不敏感去重、保留首次出现的写法", () => {
    const n = createGoalNode({ id: "x", title: "x", tags: ["Now"], notes: "见 #now 和 #Next" });
    assert.deepEqual(effectiveTags(n), ["Now", "Next"]);
  });

  it("显式传正文可覆盖 notes（白板用文件外内容时）", () => {
    const n = createGoalNode({ id: "x", title: "x", tags: [], notes: "#from-notes" });
    assert.deepEqual(effectiveTags(n, "#from-file"), ["from-file"]);
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
