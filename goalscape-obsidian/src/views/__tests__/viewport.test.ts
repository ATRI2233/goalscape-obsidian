// src/views/__tests__/viewport.test.ts
// 视野数学锁两条在界面上最容易被看出来的契约：
// 1. 滚轮缩放时"光标底下那个点"必须还在光标底下 —— 否则放大外层环时想看的那块会被推出屏幕；
// 2. 滚回最小档必然正好等于整张图 —— 否则平移过之后"缩回去"会留下一张歪在一角的图。
// 两条都只跟窗口矩形有关，不需要真实 DOM，所以在这儿判，不搬到实机回归里。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  FULL_VIEW,
  MAX_ZOOM,
  VIEW_SIZE,
  Viewport,
  panView,
  viewBoxOf,
  zoomView,
} from "../../geometry/radialGeometry";

/** 该点在窗口里的相对位置（0-1）：缩放前后必须一模一样 */
const frac = (v: Viewport, a: { x: number; y: number }) => ({
  fx: (a.x - v.x) / v.size,
  fy: (a.y - v.y) / v.size,
});

const same = (a: { fx: number; fy: number }, b: { fx: number; fy: number }) =>
  Math.abs(a.fx - b.fx) < 1e-9 && Math.abs(a.fy - b.fy) < 1e-9;

describe("放射图视野", () => {
  it("放大以光标为锚：那个点在窗口里的相对位置不动", () => {
    // 边角锚点最要紧：外层环就画在那里，朝图中心缩放会把它们第一个推出去
    for (const a of [{ x: 500, y: 500 }, { x: 940, y: 60 }, { x: 30, y: 700 }, { x: 980, y: 980 }]) {
      let v = FULL_VIEW;
      for (const notch of [1, 2, 0.5, 3, 0.2]) {
        const before = frac(v, a);
        const next = zoomView(v, notch, a);
        assert.ok(same(before, frac(next, a)), `锚点漂了：${JSON.stringify(a)} 放大 ${notch} 格`);
        v = next;
      }
    }
  });

  it("放大上限就是 MAX_ZOOM，缩到底正好回到整张图", () => {
    let v = zoomView(FULL_VIEW, 3, { x: 820, y: 180 });
    v = panView(v, -260, 180);
    for (let i = 0; i < 40; i++) v = zoomView(v, 1, { x: 820, y: 180 });
    assert.equal(v.size, VIEW_SIZE / MAX_ZOOM);
    for (let i = 0; i < 40; i++) v = zoomView(v, -1, { x: 60, y: 940 });
    assert.deepEqual(v, FULL_VIEW);
  });

  it("视野窗口永远留在画布内（拖不出丢图的视野）", () => {
    let v = zoomView(FULL_VIEW, 2, { x: 500, y: 500 });
    for (const [dx, dy] of [[-400, -400], [-400, 400], [1e6, -1e6], [0, 0]] as const) {
      v = panView(v, dx, dy);
      assert.ok(v.x >= 0 && v.y >= 0, `左上角越界：${JSON.stringify(v)}`);
      assert.ok(v.x + v.size <= VIEW_SIZE + 1e-9, `右下角越界：${JSON.stringify(v)}`);
      assert.ok(v.y + v.size <= VIEW_SIZE + 1e-9, `右下角越界：${JSON.stringify(v)}`);
    }
    // 满图那一档平移余量为零：怎么拖都还是整张图
    assert.deepEqual(panView(FULL_VIEW, 10000, -10000), FULL_VIEW);
  });

  it("滚轮一格是倍率而非加减，半格也接得住（触摸板细粒度）", () => {
    const one = zoomView(FULL_VIEW, 1, { x: 500, y: 500 });
    const twoHalves = zoomView(zoomView(FULL_VIEW, 0.5, { x: 500, y: 500 }), 0.5, { x: 500, y: 500 });
    assert.ok(Math.abs(one.size - twoHalves.size) < 1e-9, `${one.size} vs ${twoHalves.size}`);
    assert.ok(one.size < FULL_VIEW.size);
    // 反向一格还原
    assert.ok(Math.abs(zoomView(one, -1, { x: 500, y: 500 }).size - VIEW_SIZE) < 1e-9);
  });

  it("viewBox 字符串两位小数、正方形（宽高同源，不会拖成矩形）", () => {
    assert.equal(viewBoxOf(FULL_VIEW), "0.00 0.00 1000.00 1000.00");
    assert.equal(viewBoxOf({ x: 12.3456, y: 7, size: 125 }), "12.35 7.00 125.00 125.00");
  });
});
