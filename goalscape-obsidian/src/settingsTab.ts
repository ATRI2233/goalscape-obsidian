// src/settingsTab.ts
// 插件设置页。两块：
// 1) 颜色基调两根滑杆 —— 浓淡本来不该让用户自己挑，但要给一个不改代码就能整体调的出口：
//    嫌太艳往左拖，想层次更分明往右拖。拖动即时生效：存盘 + 让所有已打开的视图重画。
// 2) 白板自动更新开关 —— 默认开；关掉就只剩手点命令，白板文件会一直停在上一次的样子。

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

    containerEl.createEl("h2", { text: "白板 (.canvas)" });
    new Setting(containerEl)
      .setName("自动更新白板")
      .setDesc(
        "改完目标就自动把同名 .canvas 刷新，不用手点导出。白板标签页开着时会先等待（这时硬写会把你在看的内容盖掉），" +
          "小圆点表示还欠一次更新，关掉标签页就补上。白板文件不存在时不会凭空创建。"
      )
      .addToggle((t) => t.setValue(this.plugin.canvasAuto).onChange((v) => this.plugin.setCanvasAuto(v)));
  }

  private apply(patch: Partial<{ intensity: number; contrast: number }>): void {
    this.plugin.toneSettings = { ...this.plugin.toneSettings, ...patch };
    void this.plugin.persistData();
    this.plugin.redrawViews();
  }
}
