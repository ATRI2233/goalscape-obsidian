// src/settingsTab.ts
// 插件设置页。目前只有"颜色基调"两根滑杆 —— 浓淡本来就不该让用户自己挑，
// 但要给他们一个不用改代码就能整体调的出口：嫌太艳往左拖，想层次更分明往右拖。
// 拖动即时生效：存盘 + 让所有已打开的视图重画。

import { App, PluginSettingTab, Setting } from "obsidian";
import type GoalscapePlugin from "./main";

export class GoalscapeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GoalscapePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Goalscape 颜色基调" });

    new Setting(containerEl)
      .setName("Colour intensity")
      .setDesc("柔和 ←→ 浓艳。整张图所有颜色的饱和度一起缩放，选的颜色本身不变。")
      .addSlider((s) =>
        s
          .setLimits(0, 100, 1)
          .setValue(this.plugin.toneSettings.intensity)
          .setDynamicTooltip()
          .onChange((v) => this.apply({ intensity: v }))
      );

    new Setting(containerEl)
      .setName("Level contrast")
      .setDesc("层次平缓 ←→ 层次分明。控制往外一圈比内圈亮多少，跟颜色本身无关。")
      .addSlider((s) =>
        s
          .setLimits(0, 100, 1)
          .setValue(this.plugin.toneSettings.contrast)
          .setDynamicTooltip()
          .onChange((v) => this.apply({ contrast: v }))
      );
  }

  private apply(patch: Partial<{ intensity: number; contrast: number }>): void {
    this.plugin.toneSettings = { ...this.plugin.toneSettings, ...patch };
    void this.plugin.persistData();
    this.plugin.redrawViews();
  }
}
