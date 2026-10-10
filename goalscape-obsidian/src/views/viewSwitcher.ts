// src/views/viewSwitcher.ts
// 呈现方式的分段图标按钮，放在工具栏最左边。
// 前三种走 leaf.setViewState 在**当前标签页内**换视图，而不是 plugin.openView：
// 后者会各开一个标签，来回切几轮工作区里就堆出三个 Goalscape 标签页。
// Canvas 是 vault 里的 .canvas 文件、不是本插件的视图，交给 plugin.openCanvas()，
// 高亮段保持不动 —— 本标签页仍是原来那个视图，点亮 Canvas 会指向一个并不存在的模式。

import { WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { GoalscapeHost } from "./host";
import { VIEW_CANVAS, VIEW_OPTIONS } from "./viewTypes";

export function createViewSwitcher(
  container: HTMLElement,
  plugin: GoalscapeHost,
  leaf: WorkspaceLeaf,
  currentType: string
): HTMLElement {
  const group = container.createDiv({ cls: "goalscape-view-switch" });
  group.setAttr("role", "group");
  group.setAttr("aria-label", "Presentation mode");

  for (const option of VIEW_OPTIONS) {
    const btn = group.createEl("button", { cls: "goalscape-view-seg" });
    btn.setAttr("aria-label", option.label);
    // main.ts 靠这个属性找到 Canvas 段来点亮"待更新"的小点
    btn.setAttr("data-view", option.type);
    if (option.type === currentType) {
      btn.addClass("is-active");
      btn.setAttr("aria-current", "true");
    }
    // 新开的标签页也得反映当前状态，否则小点要等到下一次改动才出现
    if (option.type === VIEW_CANVAS) btn.toggleClass("is-stale", plugin.canvasStale);
    setIcon(btn, option.icon);
    setTooltip(btn, option.hint ?? option.label, { placement: "bottom" });

    btn.addEventListener("click", () => {
      if (option.type === currentType) return;
      if (option.type === VIEW_CANVAS) {
        void plugin.openCanvas();
        return;
      }
      void leaf.setViewState({ type: option.type, active: true });
    });
  }
  return group;
}
