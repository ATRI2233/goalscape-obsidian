// 两份文本导出（Markdown 大纲 / CSV）里笔记与块间关系的表现。
// 笔记正文不在 JSON 里，关系也不在 —— 导出层吃的是 NoteStore 交进来的 NoteIndex，
// 关系只认笔记正文里的 wikilink（带锚点）。
// 只测纯字符串部分：PNG/SVG 那半边要真实 DOM，归实机回归。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createGoalNode } from "../../data/types";
import type { GoalScape, NoteIndex } from "../../data/types";
import { exportCsv, exportMarkdownOutline } from "../exporters";

const RUN_NOTE = "Goalscapes/x.notes/Run.md";
const SHIP_NOTE = "Goalscapes/x.notes/Ship.md";

function makeScape(): GoalScape {
  return {
    version: 1,
    mainGoal: createGoalNode({
      id: "root",
      title: "Main",
      importance: 100,
      children: [
        createGoalNode({
          id: "h1",
          title: "Run",
          importance: 50,
          progress: 40,
          tags: ["Now"],
          note: RUN_NOTE,
        }),
        createGoalNode({ id: "c1", title: "Ship", importance: 50 }),
      ],
    }),
  };
}

/** 摘要里用全角逗号：CSV 的分隔符是半角，混进去就得走引号转义，测的就不是列序了 */
const NOTES: NoteIndex = new Map([
  [
    "h1",
    {
      path: RUN_NOTE,
      text: "本周 5 公里，见 [[跑步日志]]\n细节另说",
      refs: [
        { path: SHIP_NOTE, anchor: "#下一步", goalId: "c1" },
        // 普通 vault 笔记：是内容不是块间关系，不该混进 References
        { path: "跑步日志.md", anchor: "", goalId: null },
      ],
    },
  ],
]);

describe("Markdown 大纲：笔记与块间关系", () => {
  it("摘要行与关系行排在所属条目下面，缩进比条目深一级", () => {
    const out = exportMarkdownOutline(makeScape(), NOTES).split("\n");
    const i = out.findIndex((l) => l.includes("**Run**"));
    assert.deepEqual(out.slice(i, i + 3), [
      "  - **Run** (40%) [w:50]",
      `    [[Goalscapes/x.notes/Run|本周 5 公里，见 跑步日志]]`,
      "    → [[Goalscapes/x.notes/Ship#下一步|Ship]]",
    ]);
  });

  it("导出的大纲能在 Obsidian 里点回笔记：wikilink 指路径、摘要当别名", () => {
    const out = exportMarkdownOutline(makeScape(), NOTES);
    assert.match(out, /\[\[Goalscapes\/x\.notes\/Run\|本周/);
    assert.ok(!out.includes(".md|"), "链接目标不带扩展名，否则 Obsidian 认不出来");
  });

  it("关系行的锚点原样带着：点了要落到对方笔记的那一节，不是文件开头", () => {
    assert.match(exportMarkdownOutline(makeScape(), NOTES), /\[\[Goalscapes\/x\.notes\/Ship#下一步\|Ship\]\]/);
  });

  it("没有笔记 / 关系的节点不多占一行", () => {
    // root + Run + 摘要 + 关系 + Ship = 5：Ship 自己那两样都没有，所以只占一行
    assert.equal(exportMarkdownOutline(makeScape(), NOTES).split("\n").length, 5);
  });

  it("关系显示成标题而不是内部 id，也不显示成路径", () => {
    const out = exportMarkdownOutline(makeScape(), NOTES);
    assert.ok(!out.includes("c1"), "内部 id 不该出现在给人看的大纲里");
    assert.ok(!out.includes("ghost"));
  });

  it("链到普通笔记的不算关系，不进大纲（它在自己笔记正文里已经写着了）", () => {
    assert.ok(!/\[\[跑步日志\|/.test(exportMarkdownOutline(makeScape(), NOTES)));
  });
});

describe("CSV：Notes / NoteFile / References 三列", () => {
  const row = (csv: string, title: string): string[] =>
    csv
      .split("\n")
      .find((l) => l.startsWith(`${title},`))!
      .split(",");

  it("表头按既有列序追加三列", () => {
    const header = exportCsv(makeScape(), undefined, NOTES).split("\n")[0].split(",");
    assert.deepEqual(header.slice(-3), ["Notes", "NoteFile", "References"]);
  });

  it("摘要进 Notes、笔记路径进 NoteFile、关系（标题+锚点）进 References", () => {
    const r = row(exportCsv(makeScape(), undefined, NOTES), "Run");
    assert.deepEqual([r.at(-3), r.at(-2), r.at(-1)], ["本周 5 公里，见 跑步日志", RUN_NOTE, "Ship#下一步"]);
  });

  it("没笔记的块三列都是空串，不是 undefined 或 null", () => {
    const r = row(exportCsv(makeScape(), undefined, NOTES), "Ship");
    assert.deepEqual([r.at(-3), r.at(-2), r.at(-1)], ["", "", ""]);
  });

  it("不传索引也能导出：三列空着，不该炸", () => {
    const r = row(exportCsv(makeScape()), "Run");
    assert.deepEqual([r.at(-3), r.at(-2), r.at(-1)], ["", "", ""]);
  });

  it("BOM 仍在：Excel 少了它会把中文按本地代码页解成乱码", () => {
    assert.equal(exportCsv(makeScape(), undefined, NOTES).charCodeAt(0), 0xfeff);
  });
});
