// 两份文本导出（Markdown 大纲 / CSV）里 notes 与 links 的表现。
// 只测纯字符串部分：PNG/SVG 那半边要真实 DOM，归实机回归。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createGoalNode } from "../../data/types";
import type { GoalScape } from "../../data/types";
import { exportCsv, exportMarkdownOutline } from "../exporters";

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
          notes: "本周 5 公里，见 [[跑步日志]]\n细节另说",
          links: ["c1", "ghost"],
        }),
        createGoalNode({ id: "c1", title: "Ship", importance: 50 }),
      ],
    }),
  };
}

describe("Markdown 大纲：notes 与 links", () => {
  it("摘要行与链接行排在所属条目下面，缩进比条目深一级", () => {
    const out = exportMarkdownOutline(makeScape()).split("\n");
    const i = out.findIndex((l) => l.includes("**Run**"));
    assert.deepEqual(out.slice(i, i + 3), [
      "  - **Run** (40%) [w:50]",
      "    本周 5 公里，见 跑步日志",
      "    → 链接：Ship",
    ]);
  });

  it("没有 notes / links 的节点不多占一行", () => {
    // root + Run + 摘要 + 链接 + Ship = 5：Ship 自己那两样都没有，所以只占一行
    assert.equal(exportMarkdownOutline(makeScape()).split("\n").length, 5);
  });

  it("链接显示成标题而不是内部 id；树里没这个 id 就当没这回事", () => {
    const out = exportMarkdownOutline(makeScape());
    assert.ok(!out.includes("c1"), "内部 id 不该出现在给人看的大纲里");
    assert.ok(!out.includes("ghost"));
  });
});

describe("CSV：Notes / Links 两列", () => {
  const row = (csv: string, title: string): string[] =>
    csv
      .split("\n")
      .find((l) => l.startsWith(`${title},`))!
      .split(",");

  it("表头按既有列序追加两列", () => {
    const header = exportCsv(makeScape()).split("\n")[0].split(",");
    assert.deepEqual(header.slice(-2), ["Notes", "Links"]);
  });

  it("摘要进 Notes、链接标题进 Links，分隔符沿用既有的分号", () => {
    const r = row(exportCsv(makeScape()), "Run");
    assert.equal(r.at(-2), "本周 5 公里，见 跑步日志");
    assert.equal(r.at(-1), "Ship");
  });

  it("空 notes / 空 links 是空串，不是 undefined 或 null", () => {
    const r = row(exportCsv(makeScape()), "Ship");
    assert.deepEqual([r.at(-2), r.at(-1)], ["", ""]);
  });

  it("BOM 仍在：Excel 少了它会把中文按本地代码页解成乱码", () => {
    assert.equal(exportCsv(makeScape()).charCodeAt(0), 0xfeff);
  });
});
