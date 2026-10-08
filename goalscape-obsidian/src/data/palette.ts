// src/data/palette.ts
// 扇区最终底色的唯一来源。types.branchColors 回答"这个节点属于哪一家的色相"，
// 这里回答"这一层该多浓、多淡"。分成两件事是因为**浓淡必须锁死在系统里**：
// 交给手挑就会出现"五支不同牌子的蜡笔" —— 色相、饱和度、明度三个通道一起乱变，
// 而色相恰恰是大面积区分里最弱的一个通道，于是整图糊成一片。
//
// 坐标系用 OKLCH 而不是 HSL：HSL 的"明度"不是感知量，同一个 L 下黄色比紫色亮一大截，
// 按 HSL 统一浓淡根本统一不了。

import { DEFAULT_BRANCH_COLOR, GoalNode } from "./types";

/** 中心盘最深（它是锚），往外每层提亮这么多 —— 层级不靠标签也能读出来 */
const HUB_L = 0.62;
const L_STEP = 0.035;
const MAX_L = 0.82;
/** 色相明度校正：黄色天生比蓝色亮，硬给同一个 L 会让蓝发闷、黄发脏，按余弦各抬/各压一点 */
const HUE_LIFT = 0.055;
const HUE_LIFT_PEAK = 95;
/** 饱和度取"该色相在该明度下的上限"的这个比例：等比不同值，才叫同一套牌 */
const C_RATIO = 0.92;
const MIN_C = 0.03;
/** 面板 Brightness 滑杆的 -20..20 映射到 OKLCH 明度 ±0.08 */
const BRIGHT_STEP = 0.004;
/** 饱和度低于这个值就当作"我就是要灰"，不强行给它上色 */
const MIN_CHROMA = 0.02;
/** 两支的色相挤在一起时把后入场的那条推开，否则协调完两块会长得一模一样 */
const MIN_HUE_GAP = 14;

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function toSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** #rrggbb → OKLCH 的色相与饱和度（L 丢掉：浓淡由层级决定，不由选色决定） */
function hexToHueC(hex: string): { h: number; c: number } {
  const n = /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : -1;
  if (n < 0) return { h: 0, c: 0 };
  const [r, g, b] = [16, 8, 0].map((s) => toLinear(((n >> s) & 255) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const k = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let h = (Math.atan2(k, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { h, c: Math.hypot(a, k) };
}

/** OKLCH → 线性 sRGB 三通道（未截断，所以能拿它判断"在不在色域里"） */
function okToLinear(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function okToHex(L: number, C: number, h: number): string {
  const rgb = okToLinear(L, C, h).map((v) => Math.round(255 * Math.max(0, Math.min(1, toSrgb(v)))));
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * 该色相在该明度下最多吃得下多少饱和度。必须算它，因为 sRGB 色域是歪的：
 * 黄色在偏暗的明度上根本没有饱和度可用，硬塞一个固定 C 只会溢出成橄榄绿。
 */
function maxChroma(L: number, h: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const [r, g, b] = okToLinear(L, mid, h);
    if (Math.min(r, g, b) > -0.0015 && Math.max(r, g, b) < 1.0015) lo = mid;
    else hi = mid;
  }
  return lo;
}

const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * 一个节点最终该涂成什么颜色：色相与"是否中性"来自所属分支，
 * 明度由层级给（含色相校正），饱和度取该色相上限的一个固定比例 ——
 * 于是"同一套牌"成立在感知上，而不是成立在某个数字上。
 */
function fillFor(depth: number, h: number, gray: boolean, brightness: number): string {
  const base = HUB_L + L_STEP * depth + brightness * BRIGHT_STEP;
  if (gray) return okToHex(Math.min(MAX_L, base), 0, 0);
  const L = Math.min(MAX_L, base + HUE_LIFT * Math.cos(((h - HUE_LIFT_PEAK) * Math.PI) / 180));
  return okToHex(L, Math.max(MIN_C, maxChroma(L, h) * C_RATIO), h);
}

/**
 * 一次遍历出全图每个节点的最终底色。
 * 色相仍只有中心盘和二级分支能定（更深层一律继承，见 types.branchColors），
 * 但浓淡一律由这里按层分配，所以"挑了个丑颜色"这个状态不存在 —— 挑的只是色相。
 */
export function branchFills(root: GoalNode): Map<string, string> {
  // 先按树序把"定色相的那两层"过一遍：撞色的往后推，谁先出现谁保持原色相
  const tones = new Map<string, { h: number; gray: boolean }>();
  const taken: number[] = [];
  const claim = (node: GoalNode): void => {
    const { h, c } = hexToHueC(node.color || DEFAULT_BRANCH_COLOR);
    if (c < MIN_CHROMA) {
      tones.set(node.id, { h: 0, gray: true });
      return;
    }
    let hue = h;
    while (taken.some((t) => hueGap(t, hue) < MIN_HUE_GAP)) hue = (hue + MIN_HUE_GAP) % 360;
    taken.push(hue);
    tones.set(node.id, { h: hue, gray: false });
  };
  claim(root);
  for (const b of root.children) claim(b);

  const out = new Map<string, string>();
  const rec = (n: GoalNode, depth: number, owner: string): void => {
    const tone = tones.get(depth <= 1 ? n.id : owner) ?? tones.get(root.id)!;
    out.set(n.id, fillFor(depth, tone.h, tone.gray, n.brightness ?? 0));
    n.children.forEach((c) => rec(c, depth + 1, depth === 0 ? c.id : owner));
  };
  rec(root, 0, root.id);
  return out;
}

/**
 * 面板预设色盘。全部按"二级分支"那一档的浓淡生成，所以色块上看到的就是图上会有的颜色，
 * 而且点下去存进数据的值再过一遍 branchFills 是原样（幂等），不会出现"面板一个色、图上一个色"。
 */
export const PALETTE_SWATCHES: string[] = [
  25, 55, 92, 145, 190, 230, 268, 313, 345,
].map((h) => fillFor(1, h, false, 0)).concat(fillFor(1, 0, true, 0));
