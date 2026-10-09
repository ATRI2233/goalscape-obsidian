// 两份文本导出（Markdown 大纲 / CSV）里笔记与 links 的表现。
// 笔记正文不在 JSON 里，导出层吃的是 NoteStore 交进来的 NoteIndex。
// 只测纯字符串部分：PNG/SVG 那半边要真实 DOM，归实机回归。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createGoalNode } from "../../data/types";
import type { GoalScape, NoteIndex } from "../../data/types";
import { exportCsv, exportMarkdownOutline } from "../exporters";

const RUN_NOTE = "Goalscapes/x.notes/Run.md";

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
          links: ["c1", "ghost"],
        }),
        createGoalNode({ id: "c1", title: "Ship", importance: 50 }),
      ],
    }),
  };
}

/** 摘要里用全角逗号：CSV 的分隔符是半角，混进去就得走引号转义，测的就不是列序了 */
const NOTES: NoteIndex = new Map([
  ["h1", { path: RUN_NOTE, text: "本周 5 公里，见 [[跑步日志]]\n细节另说", links: [] }],
]);

describe("Markdown 大纲：笔记与 links", () => {
  it("摘要行与链接行排在所属条目下面，缩进比条目深一级", () => {
    const out = exportMarkdownOutline(makeScape(), NOTES).split("\n");
    const i = out.findIndex((l) => l.includes("**Run**"));
    assert.deepEqual(out.slice(i, i + 3), [
      "  - **Run** (40%) [w:50]",
      `    [[Goalscapes/x.notes/Run|本周 5 公里，见 跑步日志]]`,
      "    → 链接：Ship",
    ]);
  });

  it("导出的大纲能在 Obsidian 里点回笔记：wikilink 指路径、摘要当别名", () => {
    const out = exportMarkdownOutline(makeScape(), NOTES);
    assert.match(out, /\[\[Goalscapes\/x\.notes\/Run\|本周/);
    assert.ok(!out.includes(".md|"), "链接目标不带扩展名，否则 Obsidian 认不出来");
  });

  it("没有笔记 / links 的节点不多占一行", () => {
    // root + Run + 摘要 + 链接 + Ship = 5：Ship 自己那两样都没有，所以只占一行
    assert.equal(exportMarkdownOutline(makeScape(), NOTES).split("\n").length, 5);
  });

  it("链接显示成标题而不是内部 id；树里没这个 id 就当没这回事", () => {
    const out = exportMarkdownOutline(makeScape(), NOTES);
    assert.ok(!out.includes("c1"), "内部 id 不该出现在给人看的大纲里");
    assert.ok(!out.includes("ghost"));
  });
});

describe("CSV：Notes / NoteFile / Links 三列", () => {
  const row = (csv: string, title: string): string[] =>
    csv
      .split("\n")
      .find((l) => l.startsWith(`${title},`))!
      .split(",");

  it("表头按既有列序追加三列", () => {
    const header = exportCsv(makeScape(), undefined, NOTES).split("\n")[0].split(",");
    assert.deepEqual(header.slice(-3), ["Notes", "NoteFile", "Links"]);
  });

  it("摘要进 Notes、笔记路径进 NoteFile、链接标题进 Links", () => {
    const r = row(exportCsv(makeScape(), undefined, NOTES), "Run");
    assert.deepEqual([r.at(-3), r.at(-2), r.at(-1)], ["本周 5 公里，见 跑步日志", RUN_NOTE, "Ship"]);
  });

  it("没笔记 / 空 links 是空串，不是 undefined 或 null", () => {
    const r = row(exportCsv(makeScape(), undefined, NOTES), "Ship");
    assert.deepEqual([r.at(-3), r.at(-2), r.at(-1)], ["", "", ""]);
  });

  it("不传索引也能导出：只是那两列空着，不该炸", () => {
    const r = row(exportCsv(makeScape()), "Run");
    assert.deepEqual([r.at(-3), r.at(-2), r.at(-1)], ["", "", "Ship"]);
  });

  it("BOM 仍在：Excel 少了它会把中文按本地代码页解成乱码", () => {
    assert.equal(exportCsv(makeScape(), undefined, NOTES).charCodeAt(0), 0xfeff);
  });
});
