// src/data/__tests__/palette.test.ts
// branchFills 的契约是"用户只挑色相，浓淡由系统按层分配"，
// 所以这里断言的全是**结构不变量**（同层同色、逐层变亮、撞色被推开、灰保持灰、
// 色盘幂等），而不是某个具体 hex —— 调基调不会连带把断言改一遍。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createGoalNode, flattenTree } from "../types";
import type { GoalNode } from "../types";
import { PALETTE_SWATCHES, branchFills } from "../palette";

/** WCAG 相对亮度：只用来判"外层比内层亮"这种大小关系，不比绝对值 */
function brightnessOf(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => ((n >> s) & 255) / 255;
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}
const channels = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const closeHex = (a: string, b: string) =>
  channels(a).every((v, i) => Math.abs(v - channels(b)[i]) <= 2);

function fixture(): GoalNode {
  return createGoalNode({
    id: "root",
    title: "Main",
    color: "#f85755",
    children: [
      createGoalNode({
        id: "red",
        title: "Red",
        color: "#f85755",
        children: [
          createGoalNode({ id: "r-a", title: "A", children: [createGoalNode({ id: "r-a-1", title: "A1" })] }),
          createGoalNode({ id: "r-b", title: "B", children: [createGoalNode({ id: "r-b-1", title: "B1" })] }),
        ],
      }),
      createGoalNode({
        id: "blue",
        title: "Blue",
        color: "#4e73f5",
        children: [
          createGoalNode({ id: "b-done", title: "Done", progress: 100 }),
          createGoalNode({ id: "b-zero", title: "Zero", progress: 0 }),
        ],
      }),
      // 和 red 挑了同一个色相：协调完必须被推开，否则两块长得一模一样
      createGoalNode({ id: "clash", title: "Clash", color: "#f85755" }),
      createGoalNode({ id: "gray", title: "Gray", color: "#8a8a8a", children: [createGoalNode({ id: "gray-1", title: "G1" })] }),
    ],
  });
}

describe("branchFills", () => {
  const f = branchFills(fixture());

  it("同一条分支、同一层的兄弟拿到完全相同的底色（没有随机抖动）", () => {
    assert.equal(f.get("r-a"), f.get("r-b"));
    assert.equal(f.get("r-a-1"), f.get("r-b-1"));
  });

  it("往外逐层变亮：层级不读标签也能看出来", () => {
    // 只比同一条分支（同色相）的层间关系：色相自带明度校正，跨色相比亮度量的不是层级
    assert.ok(brightnessOf(f.get("red")!) < brightnessOf(f.get("r-a")!));
    assert.ok(brightnessOf(f.get("r-a")!) < brightnessOf(f.get("r-a-1")!));
  });

  it("两支撞同一个色相时，后入场的那条被推开", () => {
    assert.notEqual(f.get("clash"), f.get("red"));
  });

  it("进度不参与底色：同层 0% 与 100% 是同一个颜色", () => {
    assert.equal(f.get("b-done"), f.get("b-zero"));
  });

  it("挑了灰就保持灰，不被强行上色（灰也要有层级）", () => {
    for (const id of ["gray", "gray-1"]) {
      const [r, g, b] = channels(f.get(id)!);
      assert.ok(r === g && g === b, `${id} 不是中性灰：${f.get(id)}`);
    }
    assert.ok(brightnessOf(f.get("gray")!) < brightnessOf(f.get("gray-1")!));
  });

  it("Brightness 滑杆只压暗本节点，不牵连同层兄弟", () => {
    const t = fixture();
    t.children[0].children[0].brightness = -20;
    const dim = branchFills(t);
    assert.ok(brightnessOf(dim.get("r-a")!) < brightnessOf(dim.get("r-b")!));
    assert.equal(dim.get("r-b"), f.get("r-b"), "没调的那个兄弟原样");
  });

  it("整图每个节点都拿到底色，不存在的 id 不会被漏掉", () => {
    assert.equal(f.size, flattenTree(fixture()).length);
    for (const hex of f.values()) assert.match(hex, /^#[0-9a-f]{6}$/);
  });
});

describe("PALETTE_SWATCHES", () => {
  it("色盘互不相同、都是 6 位小写，最后一格是中性灰", () => {
    assert.equal(new Set(PALETTE_SWATCHES).size, PALETTE_SWATCHES.length);
    for (const hex of PALETTE_SWATCHES) assert.match(hex, /^#[0-9a-f]{6}$/);
    const [r, g, b] = channels(PALETTE_SWATCHES[PALETTE_SWATCHES.length - 1]);
    assert.ok(r === g && g === b);
  });

  it("色盘上看到的 = 图上会有的：每个预设当分支色再过一遍 branchFills 是原样", () => {
    for (const hex of PALETTE_SWATCHES) {
      const t = createGoalNode({
        id: "root",
        title: "Root",
        // 中心盘用灰：它不进色相队列，不会把下面这支推开，幂等才测得干净
        color: "#8a8a8a",
        children: [createGoalNode({ id: "b", title: "B", color: hex })],
      });
      assert.ok(closeHex(branchFills(t).get("b")!, hex), `${hex} 不是不动点`);
    }
  });
});
