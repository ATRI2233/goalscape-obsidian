// src/views/focusFilter.ts
// Focus Filter：工具栏上的漏斗按钮 + 浮层面板，按 Tag / Progress / Color / Due 过滤，
// 匹配项正常渲染，非匹配项降饱和度。谓词与 FilterCriteria 同处一地，视图只负责取结果上色。
// 漏斗按钮上的小圆点表示"筛选正在生效"，条件本身都收在浮层里，工具栏只留一行。

import { setIcon, setTooltip } from "obsidian";
import { GoalNode, GoalScape, flattenTree } from "../data/types";

export interface FilterCriteria {
  tag?: string;
  minProgress?: number;
  maxProgress?: number;
  color?: string;
  dueBefore?: string;
  dueAfter?: string;
}

function isCriteriaEmpty(c: FilterCriteria): boolean {
  return !c.tag && c.minProgress === undefined && c.maxProgress === undefined
    && !c.color && !c.dueBefore && !c.dueAfter;
}

/** 返回匹配到的节点 id；未启用任何条件时返回 null，表示全图正常渲染 */
export function collectMatchingIds(scape: GoalScape, criteria: FilterCriteria): Set<string> | null {
  if (isCriteriaEmpty(criteria)) return null;
  const matching = new Set<string>();
  for (const node of flattenTree(scape.mainGoal)) {
    if (matchesCriteria(node, criteria)) matching.add(node.id);
  }
  return matching;
}

function matchesCriteria(node: GoalNode, c: FilterCriteria): boolean {
  if (c.tag && !node.tags.some((t) => t.toLowerCase().includes(c.tag!.toLowerCase()))) return false;
  if (c.minProgress !== undefined && (node.progress ?? 0) < c.minProgress) return false;
  if (c.maxProgress !== undefined && (node.progress ?? 0) > c.maxProgress) return false;
  if (c.color && node.color !== c.color) return false;
  if (c.dueBefore && node.due && node.due > c.dueBefore) return false;
  if (c.dueAfter && node.due && node.due < c.dueAfter) return false;
  return true;
}

export class FocusFilter {
  readonly buttonEl: HTMLButtonElement;
  readonly panelEl: HTMLElement;
  private criteria: FilterCriteria = {};
  private open = false;

  constructor(
    container: HTMLElement,
    private onChange: (criteria: FilterCriteria) => void
  ) {
    this.buttonEl = container.createEl("button", { cls: "goalscape-filter-btn" });
    this.buttonEl.setAttr("aria-label", "Focus filter");
    this.buttonEl.setAttr("aria-expanded", "false");
    setIcon(this.buttonEl, "list-filter");
    setTooltip(this.buttonEl, "Focus filter", { placement: "bottom" });

    this.panelEl = container.createDiv({ cls: "goalscape-filter-popover" });
    this.panelEl.hide();

    this.buttonEl.addEventListener("click", () => this.toggle());
    this.renderPanel();
  }

  get isOpen(): boolean {
    return this.open;
  }

  private toggle(): void {
    if (this.open) this.close();
    else this.showPanel();
  }

  private showPanel(): void {
    this.open = true;
    this.panelEl.show();
    this.buttonEl.setAttr("aria-expanded", "true");
  }

  close(): void {
    this.open = false;
    this.panelEl.hide();
    this.buttonEl.setAttr("aria-expanded", "false");
  }

  /** 视图负责注册 document 监听，用这个判断"点的是不是自己人"，避免两处各数一遍 DOM */
  containsTarget(target: EventTarget | null): boolean {
    const node = target as Node | null;
    return this.buttonEl.contains(node) || this.panelEl.contains(node);
  }

  private renderPanel(): void {
    this.panelEl.empty();

    const tagRow = this.panelEl.createDiv({ cls: "goalscape-filter-row" });
    const tagInput = tagRow.createEl("input", { cls: "goalscape-filter-input goalscape-filter-tag" });
    tagInput.placeholder = "Tag";
    tagInput.value = this.criteria.tag ?? "";
    tagInput.addEventListener("change", () => {
      this.criteria.tag = tagInput.value.trim() || undefined;
      this.emit();
    });

    const row = this.panelEl.createDiv({ cls: "goalscape-filter-row" });

    const minProg = row.createEl("input", { cls: "goalscape-filter-input goalscape-filter-narrow" });
    minProg.type = "number";
    minProg.placeholder = "Min%";
    minProg.min = "0";
    minProg.max = "100";
    minProg.value = this.criteria.minProgress !== undefined ? String(this.criteria.minProgress) : "";
    minProg.addEventListener("change", () => {
      const v = minProg.value.trim();
      this.criteria.minProgress = v ? Number(v) : undefined;
      this.emit();
    });

    const maxProg = row.createEl("input", { cls: "goalscape-filter-input goalscape-filter-narrow" });
    maxProg.type = "number";
    maxProg.placeholder = "Max%";
    maxProg.min = "0";
    maxProg.max = "100";
    maxProg.value = this.criteria.maxProgress !== undefined ? String(this.criteria.maxProgress) : "";
    maxProg.addEventListener("change", () => {
      const v = maxProg.value.trim();
      this.criteria.maxProgress = v ? Number(v) : undefined;
      this.emit();
    });

    const colorInput = row.createEl("input", { cls: "goalscape-filter-input goalscape-filter-narrow" });
    colorInput.type = "color";
    colorInput.title = "Filter by color";
    colorInput.value = this.criteria.color ?? "#4ade80";
    colorInput.addEventListener("change", () => {
      this.criteria.color = colorInput.value || undefined;
      this.emit();
    });

    const clearBtn = row.createEl("button", { cls: "goalscape-filter-clear" });
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      this.criteria = {};
      this.renderPanel();
      this.emit();
    });
  }

  private emit(): void {
    // 按钮上的圆点是"图上为什么变灰了"的唯一现场线索，状态必须跟着条件走
    this.buttonEl.toggleClass("is-active", !isCriteriaEmpty(this.criteria));
    this.onChange({ ...this.criteria });
  }
}
