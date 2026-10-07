// src/views/focusFilter.ts
// Focus Filter 工具栏：按 Tag / Progress / Responsible / Color / Due 过滤，
// 匹配项正常渲染，非匹配项降饱和度。

import type GoalscapePlugin from "../main";

export interface FilterCriteria {
  tag?: string;
  responsible?: string;
  minProgress?: number;
  maxProgress?: number;
  color?: string;
  dueBefore?: string;
  dueAfter?: string;
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

    const respInput = row.createEl("input", { cls: "goalscape-filter-input" });
    respInput.placeholder = "Responsible";
    respInput.value = this.criteria.responsible ?? "";
    respInput.addEventListener("change", () => {
      this.criteria.responsible = respInput.value.trim() || undefined;
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
