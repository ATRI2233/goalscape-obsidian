// src/views/__tests__/label.test.ts
// fitLabel 的契约是"标签落在自己那块扇区里，并且尽量多写字"。这里不复述实现里那两条
// room 公式（复述公式的测试会跟着 bug 一起错），而是把文字还原成一个旋转矩形，
// 四个角逐个判还在不在楔形内 —— 上一版就是栽在"预算拿弧长算、字却沿半径写"，
// 光看公式两边都自洽，量一下矩形才发现整条尾巴捅在扇区外。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { LabelFit } from "../radialGeometry";
import { fitLabel } from "../radialGeometry";

const CJK = /[\u2e80-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const widthOf = (t: string, f: number) =>
  [...t].reduce((s, c) => s + (CJK.test(c) ? f : f * 0.58), 0);

interface Edge { rInner: number; rOuter: number; a0: number; a1: number }

/** 以 mid 为中心、张开 span 的一格环带 */
const wedge = (rInner: number, band: number, span: number, mid = -Math.PI / 2): Edge => ({
  rInner, rOuter: rInner + band, a0: mid - span / 2, a1: mid + span / 2,
});

/** 越出所属扇区的角数（光晕外扩 1.5px 算在字里，边界只容 0.5px 的取整误差） */
function cornersOutside(fit: LabelFit, edge: Edge): number {
  const CX = 500;
  const rMid = (edge.rInner + edge.rOuter) / 2;
  const mid = (edge.a0 + edge.a1) / 2;
  const cx = CX + Math.cos(mid) * rMid;
  const cy = CX + Math.sin(mid) * rMid;
  const hw = widthOf(fit.text, fit.fontSize) / 2;
  const hh = fit.fontSize / 2 + 1.5;
  const rad = (fit.angle * Math.PI) / 180;
  const span = edge.a1 - edge.a0;
  let bad = 0;
  for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
    const x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    const y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    const r = Math.hypot(x - CX, y - CX);
    if (r < edge.rInner - 0.5 || r > edge.rOuter + 0.5) bad++;
    // 整圆那一圈没有"边"可言，只判半径
    else if (span < Math.PI * 2 - 1e-6) {
      let d = Math.atan2(y - CX, x - CX) - mid;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) > span / 2 + 0.005) bad++;
    }
  }
  return bad;
}

const SHORT = "考研";
const MID = "赚钱与技能";
const LONG = "说话和办事的分寸感到底怎么练";

describe("fitLabel 选向：哪边写得下更多字就走哪边", () => {
  it("宽扇区 + 薄环：顺环写，写出来的长度超过环带厚度（沿半径不可能做到）", () => {
    const edge = wedge(160, 87, 2.6);
    const fit = fitLabel(MID, edge, "0%")!;
    assert.ok(fit, "这一格该有字");
    assert.equal(fit.mode, "tangential");
    assert.ok(
      widthOf(fit.text, fit.fontSize) > edge.rOuter - edge.rInner - 10,
      `${fit.text} 只有 ${widthOf(fit.text, fit.fontSize).toFixed(0)}px，没比环带宽`
    );
    assert.equal(fit.text, `${MID} 0%`);
  });

  it("窄扇区 + 厚环：沿半径写", () => {
    const edge = wedge(160, 220, 0.22);
    const fit = fitLabel(SHORT, edge)!;
    assert.equal(fit.mode, "radial");
    assert.equal(fit.text, SHORT);
  });

  it("同一格能写的字，顺环比沿半径多得多（这就是这次改的动机）", () => {
    const edge = wedge(160, 87, 2.6);
    const tangential = fitLabel(LONG, edge)!;
    // 把同一格压成"只能沿半径"的窄扇区，看它掉到几个字
    const radial = fitLabel(LONG, wedge(160, 87, 0.3))!;
    assert.ok(tangential.text.length > radial.text.length + 4,
      `顺环「${tangential.text}」 vs 沿半径「${radial.text}」`);
  });

  it("先降字号保住全名，百分比最后才让位，降到底写不下才截断", () => {
    const noPct = fitLabel(LONG, wedge(160, 220, 0.22), "0%")!;
    assert.equal(noPct.text, LONG, "全名优先，百分比该让位");
    assert.equal(noPct.fontSize, 14);
    const small = fitLabel(LONG, wedge(160, 180, 0.22), "0%")!;
    assert.equal(small.text, LONG, "降字号就是为了不截断");
    assert.ok(small.fontSize < 14, `该降字号，实际 ${small.fontSize}`);
    const cut = fitLabel(LONG, wedge(160, 44, 0.9), "0%")!;
    assert.ok(cut.text.endsWith("…") && cut.fontSize <= 12, JSON.stringify(cut));
    assert.ok(cut.text.length >= 3, "截断后至少留两个字");
  });

  it("环带薄到连 11px 都放不下 → 整格不写字（悬停还有 <title>）", () => {
    assert.equal(fitLabel(MID, wedge(160, 14, 2.6)), null);
  });
});

describe("fitLabel 落笔：字必须在自己的扇区里", () => {
  const bands = [14, 22, 30, 44, 60, 87, 130, 220];
  const spans = [0.06, 0.12, 0.22, 0.4, 0.8, 1.6, 2.6, 4.5, Math.PI * 2];
  const titles = [SHORT, MID, LONG, "A"];

  it("环厚 × 扇区角 × 标题长度全组合：四个角都不越出所属扇区", () => {
    const bad: string[] = [];
    for (const band of bands) {
      for (const span of spans) {
        for (const title of titles) {
          const edge = wedge(150, band, span);
          const fit = fitLabel(title, edge, "35%");
          if (fit && cornersOutside(fit, edge)) {
            bad.push(`band=${band} span=${span} 「${fit.text}」${fit.fontSize}px ${fit.mode} → ${cornersOutside(fit, edge)} 个角在外`);
          }
        }
      }
    }
    assert.deepEqual(bad, [], bad.slice(0, 6).join("\n"));
  });

  it("绕一圈每个朝向都不出现倒着读的字（angle 恒在 [-90, 90)）", () => {
    for (let i = 0; i < 24; i++) {
      const edge = wedge(150, 87, 1.2, (i / 24) * Math.PI * 2);
      const fit = fitLabel(MID, edge, "0%")!;
      assert.ok(fit.angle >= -90 && fit.angle < 90, `mid=${i}/24 圈 angle=${fit.angle}`);
      assert.equal(cornersOutside(fit, edge), 0, `mid=${i}/24 圈越界：${fit.mode} ${fit.angle}`);
    }
  });

  it("整圆那一圈（独子铺满 360°）按半径判、不按角度判", () => {
    const edge = wedge(150, 87, Math.PI * 2, 0);
    const fit = fitLabel(MID, edge, "0%")!;
    assert.equal(cornersOutside(fit, edge), 0);
  });
});
