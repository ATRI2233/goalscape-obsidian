// src/views/radialDrag.ts
// 放射图的两类指针拖拽：权重手柄（角度 → importance）与扇区重挂载（命中新父级）。
// 共同前提：store.mutate 会触发 render() 重建整个 svg，所以每次 move 都必须重新取文档里
// 那个 svg —— 拖拽开始时捕获的引用会立刻变成游离节点，getScreenCTM() 返回 null 使换算全部失效。

import { Notice } from "obsidian";
import { adjustImportance, moveGoal } from "../data/crud";
import type { GoalTreeStore } from "../data/goalTree";
import {
  CX,
  CY,
  RingGeometry,
  SectorAngles,
  hitTestSector,
  normalizeAngleInto,
  toLogicalPoint,
} from "./radialGeometry";

/** 拖拽控制器向视图借用的现场，每次 move/up 都重新查询 */
export interface DragSurface {
  liveSvg(): SVGSVGElement | null;
  positions(): Map<string, SectorAngles>;
  ring(): RingGeometry;
  titleOf(id: string): string;
  render(): void;
  /** 只改选中态不重建面板（拖拽开始时需要静默取消选中） */
  setSelectedId(id: string | null): void;
  select(id: string | null): void;
}

export class WeightDragController {
  private state: {
    nodeId: string;
    startAngle: number;
    parentStart: number;
    parentEnd: number;
    /** 上一次已应用的权重：指针沿半径方向移动时角度不变，避免每次 move 都全量落盘 */
    lastImportance: number | null;
  } | null = null;

  constructor(private store: GoalTreeStore, private surface: DragSurface) {}

  start(e: PointerEvent, nodeId: string, startAngle: number, parentStart: number, parentEnd: number): void {
    e.preventDefault();
    e.stopPropagation();
    this.surface.select(nodeId);
    this.state = { nodeId, startAngle, parentStart, parentEnd, lastImportance: null };

    const move = (ev: PointerEvent) => this.onMove(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.state = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private onMove(e: PointerEvent): void {
    const drag = this.state;
    const svg = this.surface.liveSvg();
    if (!drag || !svg) return;

    const point = toLogicalPoint(svg, e.clientX, e.clientY);
    const angle = normalizeAngleInto(Math.atan2(point.y - CY, point.x - CX), drag.parentStart);
    const parentSpan = drag.parentEnd - drag.parentStart;
    if (parentSpan <= 0) return;

    const span = Math.max(0, Math.min(parentSpan, angle - drag.startAngle));
    const target = Math.max(0, Math.min(100, Math.round((span / parentSpan) * 100)));
    if (target === drag.lastImportance) return;
    drag.lastImportance = target;
    this.store.mutate((s) => adjustImportance(s, drag.nodeId, target));
  }
}

export class ReparentDragController {
  /** 超过这个位移才认定为拖拽，否则视为点击选中 */
  private static readonly ACTIVATE_PX = 8;

  private state: {
    nodeId: string;
    startX: number;
    startY: number;
    active: boolean;
    ghostEl: HTMLElement | null;
  } | null = null;

  constructor(private store: GoalTreeStore, private surface: DragSurface) {}

  start(e: PointerEvent, nodeId: string): void {
    if (e.button !== 0) return;
    this.state = { nodeId, startX: e.clientX, startY: e.clientY, active: false, ghostEl: null };

    const move = (ev: PointerEvent) => {
      const drag = this.state;
      if (!drag) return;
      if (!drag.active) {
        if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) <= ReparentDragController.ACTIVATE_PX) return;
        drag.active = true;
        this.surface.setSelectedId(null);
        this.surface.render();
        drag.ghostEl = document.createElement("div");
        drag.ghostEl.addClass("goalscape-drag-ghost");
        drag.ghostEl.textContent = this.surface.titleOf(drag.nodeId);
        document.body.appendChild(drag.ghostEl);
      }
      if (drag.ghostEl) {
        drag.ghostEl.style.left = `${ev.clientX + 12}px`;
        drag.ghostEl.style.top = `${ev.clientY + 12}px`;
      }
      this.highlight(this.targetAt(ev.clientX, ev.clientY));
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const drag = this.state;
      this.state = null;
      this.highlight(null);
      if (!drag) return;
      if (drag.ghostEl) {
        drag.ghostEl.remove();
        drag.ghostEl = null;
      }
      if (!drag.active) {
        this.surface.select(drag.nodeId);
        return;
      }
      const targetId = this.targetAt(ev.clientX, ev.clientY);
      if (targetId && targetId !== drag.nodeId) {
        let ok = false;
        this.store.mutate((s) => {
          ok = moveGoal(s, drag.nodeId, targetId);
        });
        if (!ok) new Notice("Cannot move goal there (cycle or same parent)");
      }
      this.surface.render();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private targetAt(clientX: number, clientY: number): string | null {
    const svg = this.surface.liveSvg();
    if (!svg) return null;
    return hitTestSector(this.surface.positions(), this.surface.ring(), toLogicalPoint(svg, clientX, clientY));
  }

  private highlight(targetId: string | null): void {
    const svg = this.surface.liveSvg();
    if (!svg) return;
    svg.querySelectorAll(".goalscape-drop-target").forEach((el) => el.removeClass("goalscape-drop-target"));
    if (!targetId) return;
    const el = svg.querySelector(`[data-id="${targetId}"]`);
    if (el) el.addClass("goalscape-drop-target");
  }
}
