// src/data/__tests__/palette.test.ts
// branchFills 的契约是"用户只挑色相，浓淡由系统按层分配"，
// 所以这里断言的全是**结构不变量**（同层同色、逐层变亮、撞色被推开、灰保持灰、
// 色盘幂等），而不是某个具体 hex —— 调基调不会连带把断言改一遍。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createGoalNode, flattenTree } from "../types";
import type { GoalNode } from "../types";
import { DEFAULT_TONE, Tone, branchFills, paletteSwatches, shadeOf, toneFromSliders } from "../palette";

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

describe("paletteSwatches", () => {
  const SW = paletteSwatches();

  it("色盘互不相同、都是 6 位小写，最后一格是中性灰", () => {
    assert.equal(new Set(SW).size, SW.length);
    for (const hex of SW) assert.match(hex, /^#[0-9a-f]{6}$/);
    const [r, g, b] = channels(SW[SW.length - 1]);
    assert.ok(r === g && g === b);
  });

  it("色盘上看到的 = 图上会有的：每个预设当分支色再过一遍 branchFills 是原样", () => {
    for (const hex of SW) {
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

  it("滑杆拖到哪一档，色盘就跟着变到哪一档（不会图上变了、色盘还是旧颜色）", () => {
    assert.notEqual(paletteSwatches(toneFromSliders(0, 50))[0], SW[0]);
    assert.notEqual(paletteSwatches(toneFromSliders(100, 50))[0], SW[0]);
  });
});

describe("shadeOf", () => {
  it("块内明暗的两端只改明度：色相与'哪个通道主导'都不能翻", () => {
    const base = "#3b9743";
    const dark = shadeOf(base, -0.05);
    const light = shadeOf(base, 0.05);
    assert.ok(brightnessOf(dark) < brightnessOf(base));
    assert.ok(brightnessOf(base) < brightnessOf(light));
    // 绿色系：g 必须始终是主导通道，否则"内深外浅"会变成"内蓝外黄"
    for (const hex of [dark, base, light]) {
      const [r, g, b] = channels(hex);
      assert.ok(g > r && g > b, `${hex} 已经不在绿色系里`);
    }
  });

  it("推到极端也不会溢出成非法值", () => {
    for (const hex of [shadeOf("#000000", -0.5), shadeOf("#ffffff", 0.5), shadeOf("#3b9743", 9)]) {
      assert.match(hex, /^#[0-9a-f]{6}$/);
    }
  });
});

describe("设置页那两根滑杆", () => {
  /** 一支红到底的三层链：两根滑杆的效果都只在这条链上看 */
  const chain = (tone: Tone) => branchFills(
    createGoalNode({
      id: "root", title: "R", color: "#8a8a8a",
      children: [
        createGoalNode({
          id: "b", title: "B", color: "#f85755",
          children: [
            createGoalNode({
              id: "c", title: "C",
              children: [createGoalNode({ id: "d", title: "D" })],
            }),
          ],
        }),
      ],
    }), tone);
  const satSpread = (hex: string) => { const [r, g, b] = channels(hex); return Math.max(r, g, b) - Math.min(r, g, b); };

  it("浓艳度：往右拖更艳、往左拖更灰，色相不变", () => {
    const soft = chain(toneFromSliders(0, 50)).get("b")!;
    const loud = chain(toneFromSliders(100, 50)).get("b")!;
    assert.ok(satSpread(soft) < satSpread(loud), `${soft} 不该比 ${loud} 艳`);
    // 同一支红，两端都必须还是"红主导"（g/b 谁高谁低不能翻）
    for (const hex of [soft, loud]) {
      const [r, g, b] = channels(hex);
      assert.ok(r > g && r > b, `${hex} 已经不是红色系了`);
    }
  });

  it("层次分明度：往右拖，内圈和外圈的亮度差被拉大", () => {
    const flat = chain(toneFromSliders(84, 0));
    const steep = chain(toneFromSliders(84, 100));
    const gap = (m: Map<string, string>) => brightnessOf(m.get("d")!) - brightnessOf(m.get("b")!);
    assert.ok(gap(flat) < gap(steep), `平缓档差 ${gap(flat)}，分明档差 ${gap(steep)}`);
    assert.ok(gap(flat) >= 0 && gap(steep) > 0, "外层必须始终比内层亮，滑杆不许把它反过来");
  });

  it("出厂滑杆位置就是当前基调（谁动默认值都会被这条抓到）", () => {
    assert.ok(Math.abs(DEFAULT_TONE.chroma - 0.92) < 0.001, `chroma=${DEFAULT_TONE.chroma}`);
    assert.ok(Math.abs(DEFAULT_TONE.step - 0.035) < 0.0001, `step=${DEFAULT_TONE.step}`);
  });
});
