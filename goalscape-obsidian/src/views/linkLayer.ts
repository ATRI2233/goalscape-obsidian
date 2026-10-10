// src/views/linkLayer.ts
// 选中态的弦线装饰层：往当前 svg 里加一层 g，未选中时图面与没有这层功能时完全一致（零噪音）。
// 点亮对端扇区、点了跳过去都由视图侧给回调（lightSector / reveal），本模块不碰 ItemView 生命周期。
// 关系只从笔记互引里来（notes.outgoingRefs / incomingRefs），手填的块间链接已经删掉了。

import { GoalScape, NoteIndex, findNode } from "../data/types";
import { incomingRefs, outgoingRefs } from "../data/notes";
import { CX, CY, SVG_NS, SectorShape } from "../geometry/radialGeometry";

export interface LinkLayerSurface {
  svg: SVGSVGElement;
  defs: SVGDefsElement;
  scape: GoalScape;
  /** 分支底色：弦线的两端各取自己那块的颜色做渐变 */
  fills: Map<string, string>;
  selectedId: string | null;
  nodePositions: Map<string, SectorShape>;
  noteIndex: NoteIndex;
  /** 渐变 id 必须带视图前缀并逐条自增，否则分屏两张 svg 抢同一个 defs */
  nextGradientId: () => string;
  lightSector: (id: string, on: boolean) => void;
  /** 沿祖先链展开后选中 —— 折叠分支里的端点也要点得动 */
  reveal: (id: string) => void;
}

/** 扇区弧中点（环带半径中值）：弦线端点的锚 */
function sectorMid(shape: SectorShape): { x: number; y: number } {
  const mid = (shape.startAngle + shape.endAngle) / 2;
  const r = (shape.rInner + shape.rOuter) / 2;
  return { x: CX + Math.cos(mid) * r, y: CY + Math.sin(mid) * r };
}

/**
 * 出向与入向都画 —— 只画出向的话，被引用那块选中时看不见自己被人引着，
 * 和信息面板的 Referenced by 同语义。目标在折叠分支里没被画出来就跳过，
 * 为一个看不见的端点改动别处的折叠状态不值得。
 * 弦线：三次 bezier、两控制点钉在图心（弧线向圆心下垂），描边渐变取两端各自的底色。
 */
export function drawLinkDecorations(surface: LinkLayerSurface): void {
  if (!surface.selectedId) return;
  const found = findNode(surface.scape.mainGoal, surface.selectedId);
  const mine = found ? surface.nodePositions.get(found.node.id) : undefined;
  if (!found || !mine) return;

  const p1 = sectorMid(mine);
  const partners = Array.from(
    new Set([
      ...outgoingRefs(surface.noteIndex, found.node.id).map((r) => r.goalId as string),
      ...incomingRefs(surface.noteIndex, found.node.id).map((x) => x.fromId),
    ])
  ).filter((id) => id !== found.node.id);

  const layer = document.createElementNS(SVG_NS, "g");
  layer.addClass("goalscape-chord-layer");
  surface.svg.appendChild(layer);

  for (const otherId of partners) {
    const shape = surface.nodePositions.get(otherId);
    if (!shape) continue;
    const p2 = sectorMid(shape);
    const c1 = surface.fills.get(found.node.id) ?? "#94a3b8";
    const c2 = surface.fills.get(otherId) ?? "#94a3b8";

    const gid = surface.nextGradientId();
    const grad = document.createElementNS(SVG_NS, "linearGradient");
    grad.id = gid;
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.setAttribute("x1", String(p1.x));
    grad.setAttribute("y1", String(p1.y));
    grad.setAttribute("x2", String(p2.x));
    grad.setAttribute("y2", String(p2.y));
    for (const [offset, color] of [["0", c1], ["1", c2]] as const) {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      grad.appendChild(stop);
    }
    surface.defs.appendChild(grad);

    const chord = document.createElementNS(SVG_NS, "path");
    chord.setAttribute("d", `M ${p1.x} ${p1.y} C ${CX} ${CY} ${CX} ${CY} ${p2.x} ${p2.y}`);
    chord.setAttribute("stroke", `url(#${gid})`);
    chord.setAttribute("data-chord", otherId);
    chord.addClass("goalscape-chord");
    chord.addEventListener("pointerenter", () => {
      chord.addClass("goalscape-chord-hot");
      surface.lightSector(otherId, true);
    });
    chord.addEventListener("pointerleave", () => {
      chord.removeClass("goalscape-chord-hot");
      surface.lightSector(otherId, false);
    });
    chord.addEventListener("click", (e) => {
      e.stopPropagation();
      surface.reveal(otherId);
    });
    layer.appendChild(chord);

    for (const [p, color] of [[p1, c1], [p2, c2]] as const) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", String(p.x));
      dot.setAttribute("cy", String(p.y));
      dot.setAttribute("r", "4");
      dot.setAttribute("fill", color);
      dot.addClass("goalscape-chord-dot");
      layer.appendChild(dot);
    }
  }
}
