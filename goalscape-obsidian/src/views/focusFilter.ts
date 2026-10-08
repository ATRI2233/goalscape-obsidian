// src/views/focusFilter.ts
// Focus Filter 工具栏：按 Tag / Progress / Color / Due 过滤，
// 匹配项正常渲染，非匹配项降饱和度。谓词与 FilterCriteria 同处一地，视图只负责取结果上色。

import { GoalNode, GoalScape, flattenTree } from "../data/types";
import type GoalscapePlugin from "../main";

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
  private criteria: FilterCriteria = {};

  constructor(
    private container: HTMLElement,
    private plugin: GoalscapePlugin,
    private onChange: (criteria: FilterCriteria) => void
  ) {
    this.render();
  }

  private render(): void {
    this.container.empty();
    this.container.addClass("goalscape-filter-bar");

    const row = this.container.createDiv({ cls: "goalscape-filter-row" });

    row.createSpan({ cls: "goalscape-filter-label", text: "Filter:" });

    const tagInput = row.createEl("input", { cls: "goalscape-filter-input" });
    tagInput.placeholder = "Tag";
    tagInput.value = this.criteria.tag ?? "";
    tagInput.addEventListener("change", () => {
      this.criteria.tag = tagInput.value.trim() || undefined;
      this.emit();
    });

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
      this.render();
      this.emit();
    });
  }

  private emit(): void {
    this.onChange({ ...this.criteria });
  }
}
