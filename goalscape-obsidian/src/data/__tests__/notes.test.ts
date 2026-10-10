// src/data/notes.ts 的契约：摘要的剥记号与截断、块间关系的现扫语义
// （关系只认笔记正文里的 wikilink，手工 id 数组已删）。
// 这些规则一旦被 views/export 层消费就改不动了，全部锁在这里。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { firstLine, incomingRefs, outgoingRefs } from "../notes";
import type { NoteIndex, NoteRef } from "../types";

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

function ref(path: string, goalId: string | null, anchor = ""): NoteRef {
  return { path, anchor, goalId };
}

/** 块 a / b / c 各有笔记；refs 由各测试自己给 */
function makeIndex(entries: Record<string, NoteRef[]>): NoteIndex {
  const index: NoteIndex = new Map();
  for (const [id, refs] of Object.entries(entries)) {
    index.set(id, { path: `G/${id}.md`, text: "", refs });
  }
  return index;
}

describe("outgoingRefs", () => {
  it("只返回指向别的块的引用，锚点原样带着", () => {
    const index = makeIndex({
      a: [],
      b: [ref("G/a.md", "a", "#计划"), ref("G/outside.md", null)],
    });
    assert.deepEqual(outgoingRefs(index, "b"), [ref("G/a.md", "a", "#计划")]);
  });

  it("同一目标不同小节算两条，同小节重复只留一条", () => {
    const index = makeIndex({
      a: [],
      b: [ref("G/a.md", "a", "#x"), ref("G/a.md", "a", "#x"), ref("G/a.md", "a", "#y")],
    });
    assert.deepEqual(
      outgoingRefs(index, "b").map((r) => r.anchor),
      ["#x", "#y"]
    );
  });

  it("自链不算关系（笔记引自己的另一节）", () => {
    const index = makeIndex({ a: [ref("G/a.md", "a", "#自己")] });
    assert.deepEqual(outgoingRefs(index, "a"), []);
  });

  it("没笔记 / 没出链就是空数组", () => {
    assert.deepEqual(outgoingRefs(makeIndex({}), "ghost"), []);
  });
});

describe("incomingRefs", () => {
  it("返回引用方与那条引用，按 Map 序", () => {
    const index = makeIndex({
      a: [],
      b: [ref("G/a.md", "a", "#计划")],
      c: [ref("G/a.md", "a")],
    });
    assert.deepEqual(incomingRefs(index, "a"), [
      { fromId: "b", ref: ref("G/a.md", "a", "#计划") },
      { fromId: "c", ref: ref("G/a.md", "a") },
    ]);
  });

  it("同一家引两次不同小节 → 两条（面板要各自能跳）", () => {
    const index = makeIndex({
      a: [],
      b: [ref("G/a.md", "a", "#x"), ref("G/a.md", "a", "#y")],
    });
    assert.deepEqual(
      incomingRefs(index, "a").map((x) => x.ref.anchor),
      ["#x", "#y"]
    );
  });

  it("这个块自己没有笔记文件 → 空数组（没文件就谈不上被引）", () => {
    const index = makeIndex({ b: [ref("G/a.md", "a")] });
    assert.deepEqual(incomingRefs(index, "a"), []);
  });
});
