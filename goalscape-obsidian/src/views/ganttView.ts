// src/views/ganttView.ts
// Gantt 时间线视图：按 start/due 日期渲染条形图，拖动条形右端更新进度。

import { ItemView, WorkspaceLeaf } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode, DEFAULT_BRANCH_COLOR, findNode, flattenTree } from "../data/types";
import { branchFills } from "../data/palette";
import { VIEW_GANTT } from "./viewTypes";
import { createViewSwitcher } from "./viewSwitcher";

const DAY_MS = 86400000;
const BAR_HEIGHT = 22;
const ROW_GAP = 4;
const LABEL_WIDTH = 180;

export class GanttView extends ItemView {
  private unsubscribe?: () => void;
  private rootEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: GoalscapePlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_GANTT; }
  getDisplayText(): string { return "Goalscape Gantt"; }
  getIcon(): string { return "calendar"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("goalscape-container");
    const bar = this.contentEl.createDiv({ cls: "goalscape-view-bar" });
    createViewSwitcher(bar, this.plugin, this.leaf, VIEW_GANTT);
    this.rootEl = this.contentEl.createDiv({ cls: "goalscape-gantt-root" });
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  /** 设置页改了颜色基调之后重画一次（不涉及数据，所以不走 store） */
  repaint(): void {
    this.render();
  }

  private render(): void {
    this.rootEl.empty();
    const scape = this.plugin.store.scape;
    if (!scape) return;

    const nodes = flattenTree(scape.mainGoal).filter((n) => n.start || n.due);
    if (!nodes.length) {
      this.rootEl.createDiv({ cls: "goalscape-gantt-empty", text: "No goals with dates. Set start/due dates in the info panel." });
      return;
    }

    const dates = nodes.flatMap((n) => {
      const d: number[] = [];
      if (n.start) d.push(new Date(n.start).getTime());
      if (n.due) d.push(new Date(n.due).getTime());
      return d;
    }).filter((t) => !isNaN(t));

    if (!dates.length) return;
    const minTime = Math.min(...dates) - DAY_MS * 2;
    const maxTime = Math.max(...dates) + DAY_MS * 2;
    const totalSpan = maxTime - minTime || DAY_MS;

    const container = this.rootEl.createDiv({ cls: "goalscape-gantt-container" });
    const width = container.clientWidth || 800;
    const chartWidth = width - LABEL_WIDTH;
    // 甘特条用放射图同一份最终底色（含设置页那两根滑杆），两边看到的颜色必须是一个东西
    const fills = branchFills(scape.mainGoal, this.plugin.tone);

    const header = container.createDiv({ cls: "goalscape-gantt-header" });
    header.style.paddingLeft = `${LABEL_WIDTH}px`;
    const months = this.getMonthTicks(minTime, maxTime);
    for (const m of months) {
      const tick = header.createSpan({ cls: "goalscape-gantt-tick" });
      tick.style.left = `${((m.time - minTime) / totalSpan) * chartWidth}px`;
      tick.textContent = m.label;
    }

    for (const node of nodes) {
      const row = container.createDiv({ cls: "goalscape-gantt-row" });
      row.style.height = `${BAR_HEIGHT + ROW_GAP}px`;

      const label = row.createSpan({ cls: "goalscape-gantt-label" });
      label.style.width = `${LABEL_WIDTH}px`;
      label.textContent = node.title;
      label.title = node.title;

      const track = row.createDiv({ cls: "goalscape-gantt-track" });
      track.style.width = `${chartWidth}px`;

      const start = node.start ? new Date(node.start).getTime() : (node.due ? new Date(node.due).getTime() - DAY_MS * 7 : minTime);
      const end = node.due ? new Date(node.due).getTime() : start + DAY_MS * 7;
      const clampedStart = Math.max(start, minTime);
      const clampedEnd = Math.min(end, maxTime);

      const left = ((clampedStart - minTime) / totalSpan) * chartWidth;
      const barWidth = Math.max(4, ((clampedEnd - clampedStart) / totalSpan) * chartWidth);

      const bar = track.createDiv({ cls: "goalscape-gantt-bar" });
      bar.style.left = `${left}px`;
      bar.style.width = `${barWidth}px`;
      bar.style.height = `${BAR_HEIGHT}px`;
      bar.style.backgroundColor = fills.get(node.id) ?? DEFAULT_BRANCH_COLOR;

      const fill = bar.createDiv({ cls: "goalscape-gantt-fill" });
      fill.style.width = `${node.progress ?? 0}%`;

      const handle = bar.createDiv({ cls: "goalscape-gantt-handle" });
      handle.style.left = `${node.progress ?? 0}%`;
      this.attachProgressDrag(handle, bar, node);
    }
  }

  private attachProgressDrag(handle: HTMLElement, bar: HTMLElement, node: GoalNode): void {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const barRect = () => bar.getBoundingClientRect();

      const move = (ev: PointerEvent) => {
        const rect = barRect();
        const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
        const pct = Math.round((x / rect.width) * 100);
        handle.style.left = `${pct}%`;
        const fill = bar.querySelector(".goalscape-gantt-fill") as HTMLElement;
        if (fill) fill.style.width = `${pct}%`;
      };

      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const rect = barRect();
        const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
        const pct = Math.round((x / rect.width) * 100);
        if (!node.children.length) {
          this.plugin.store.mutate((s) => {
            const found = findNode(s.mainGoal, node.id)?.node;
            if (found) found.progress = pct;
          });
        } else {
          // 父级进度是汇总值、不能手填：不重绘的话，拖拽时改过的条形会停在假位置上
          this.render();
        }
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private getMonthTicks(min: number, max: number): Array<{ time: number; label: string }> {
    const ticks: Array<{ time: number; label: string }> = [];
    const d = new Date(min);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= max) {
      if (d.getTime() >= min) {
        ticks.push({ time: d.getTime(), label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` });
      }
      d.setMonth(d.getMonth() + 1);
    }
    return ticks;
  }
}
