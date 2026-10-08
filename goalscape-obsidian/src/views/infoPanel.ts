// src/views/infoPanel.ts
// 右侧信息面板：编辑 Title / Importance / Progress / Due / Start /
// Tags / 色系（中心盘与二级节点）或明度（更深层级）/ Notes / 自定义字段。
// 所有改动统一走 store.mutate。

import { Setting, Notice, setTooltip } from "obsidian";
import type GoalscapePlugin from "../main";
import { DEFAULT_BRANCH_COLOR, GoalNode, GoalScape, findNode } from "../data/types";
import { paletteSwatches } from "../data/palette";
import { renameGoal, adjustImportance } from "../data/crud";
import { BAND_DEFAULT_INDEX, BAND_STEPS } from "./radialGeometry";
import { promptInput } from "./promptModal";

/** 与 BAND_STEPS 一一对应，只用于 tooltip / aria-label */
const BAND_LABELS = ["Extra thin ring", "Thin ring", "Standard ring", "Thick ring"];

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 归一化成 #rrggbb，非色值返回 null。
 * 放射图的 hexToHsl / luminance 都只解析 6 位，放行 #f0a 会让这条分支
 * 静默退回默认色相，并按"亮度 0"误选字色；带 alpha 的 8 位同样不被解析。
 */
function normalizeHex(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "";
  const long = /^#?([0-9a-f]{6})$/i.exec(v);
  if (long) return `#${long[1].toLowerCase()}`;
  const short = /^#?([0-9a-f]{3})$/i.exec(v);
  if (!short) return null;
  const t = short[1].toLowerCase();
  return `#${[...t].map((c) => c + c).join("")}`;
}

export class InfoPanel {
  private nodeId: string | null = null;
  /** 拖动滑杆时跳过外部触发的整面板重建，避免滑杆在拖拽中被重新创建而丢失指针 */
  private interacting = false;

  constructor(private container: HTMLElement, private plugin: GoalscapePlugin) {}

  /** 切换选中节点：始终强制重建 */
  show(nodeId: string | null): void {
    this.nodeId = nodeId;
    this.render(true);
  }

  /** 数据变更后的被动刷新：拖拽中跳过，避免打断正在交互的控件 */
  refresh(): void {
    this.render(false);
  }

  private render(force: boolean): void {
    if (this.interacting && !force) return;
    this.container.empty();
    const scape = this.plugin.store.scape;
    if (!this.nodeId || !scape) {
      this.container.createDiv({
        cls: "goalscape-panel-empty",
        text: "Select a goal to edit its details.",
      });
      return;
    }
    const found = findNode(scape.mainGoal, this.nodeId);
    if (!found) {
      this.container.createDiv({ cls: "goalscape-panel-empty", text: "Goal not found." });
      return;
    }
    const node = found.node;
    const isMain = !found.parent;
    // 能选色系的层级：中心盘只管自己，二级节点（中心盘外那一圈）管整条分支
    const ownsHue = isMain || found.parent!.id === scape.mainGoal.id;
    const isLeaf = node.children.length === 0;

    this.container.createEl("h3", { text: node.title, cls: "goalscape-panel-title" });

    new Setting(this.container).setName("Title").addText((text) => {
      text.setValue(node.title);
      text.inputEl.addEventListener("blur", () => {
        const v = text.getValue().trim();
        if (v && v !== node.title) this.mutate((s) => renameGoal(s, node.id, v));
      });
    });

    if (!isMain) {
      const importance = new Setting(this.container)
        .setName("Importance")
        .setDesc(`${Math.round(node.importance)}% of parent arc`)
        .addSlider((slider) => {
          slider.setLimits(0, 100, 1);
          slider.setValue(Math.round(node.importance));
          slider.setDynamicTooltip();
          this.trackInteraction(slider.sliderEl);
          slider.onChange((v) => {
            this.mutate((s) => adjustImportance(s, node.id, v));
          });
        });
      this.addBandControl(importance, node);
    } else {
      // 中心盘没有 Importance 行，但它的厚度就是 hub 半径，同样要能调
      this.addBandControl(
        new Setting(this.container).setName("Hub size").setDesc("Center disc thickness"),
        node
      );
    }

    if (isLeaf) {
      new Setting(this.container)
        .setName("Progress")
        .setDesc(`${node.progress ?? 0}%`)
        .addSlider((slider) => {
          slider.setLimits(0, 100, 1);
          slider.setValue(node.progress ?? 0);
          slider.setDynamicTooltip();
          this.trackInteraction(slider.sliderEl);
          slider.onChange((v) => {
            this.mutate((s) => this.patch(s, node.id, (n) => (n.progress = v)));
          });
        });
    } else {
      new Setting(this.container)
        .setName("Progress (auto-rollup)")
        .setDesc(`${node.progress ?? 0}%`);
    }

    new Setting(this.container).setName("Due date").addText((text) => {
      text.inputEl.type = "date";
      text.setValue(node.due ?? "");
      text.inputEl.addEventListener("change", () => {
        const v = text.getValue();
        this.mutate((s) => this.patch(s, node.id, (n) => (n.due = v || undefined)));
      });
    });

    new Setting(this.container).setName("Start date").addText((text) => {
      text.inputEl.type = "date";
      text.setValue(node.start ?? "");
      text.inputEl.addEventListener("change", () => {
        const v = text.getValue();
        this.mutate((s) => this.patch(s, node.id, (n) => (n.start = v || undefined)));
      });
    });

    new Setting(this.container)
      .setName("Tags")
      .setDesc("Comma separated, e.g. Now, Next")
      .addText((text) => {
        text.setValue(node.tags.join(", "));
        text.inputEl.addEventListener("blur", () => {
          const list = splitCsv(text.getValue());
          this.mutate((s) => this.patch(s, node.id, (n) => (n.tags = list)));
        });
      });

    if (ownsHue) this.addHueControls(node, isMain);
    else this.addBrightnessControl(node);

    this.container.createEl("div", { cls: "goalscape-panel-label", text: "Notes" });
    const notesArea = this.container.createEl("textarea", { cls: "goalscape-panel-notes" });
    notesArea.value = node.notes ?? "";
    notesArea.addEventListener("blur", () => {
      const v = notesArea.value;
      this.mutate((s) => this.patch(s, node.id, (n) => (n.notes = v || undefined)));
    });

    this.container.createEl("h4", { text: "Custom fields" });
    const fieldsContainer = this.container.createDiv({ cls: "goalscape-panel-fields" });
    const fields = node.fields ?? {};
    for (const [key, value] of Object.entries(fields)) {
      new Setting(fieldsContainer)
        .setName(key)
        .addText((text) => {
          text.setValue(value);
          text.inputEl.addEventListener("blur", () => {
            const v = text.getValue();
            this.mutate((s) =>
              this.patch(s, node.id, (n) => {
                n.fields = { ...(n.fields ?? {}), [key]: v };
              })
            );
          });
        })
        .addExtraButton((btn) =>
          btn
            .setIcon("trash-2")
            .setTooltip("Remove field")
            .onClick(() => {
              this.mutate((s) =>
                this.patch(s, node.id, (n) => {
                  if (!n.fields) return;
                  const rest = { ...n.fields };
                  delete rest[key];
                  n.fields = rest;
                })
              );
            })
        );
    }
    new Setting(fieldsContainer).addButton((btn) =>
      btn.setButtonText("Add custom field").onClick(async () => {
        const key = await promptInput(this.plugin.app, "New field name", "");
        if (!key || !key.trim()) return;
        this.mutate((s) =>
          this.patch(s, node.id, (n) => {
            n.fields = { ...(n.fields ?? {}), [key.trim()]: "" };
          })
        );
      })
    );
  }

  /**
   * 环带厚度四档，挂在 Importance 行的右边（中心盘没有 Importance 行，给它独立的 Hub size）。
   * 档位是**每个节点自己的**，所以不同分支可以长到不同半径、层与层互不对齐；
   * "标准"档不落字段（bandScale 未设即默认），免得整份 JSON 被一堆 1 淹没。
   */
  private addBandControl(setting: Setting, node: GoalNode): void {
    const group = setting.controlEl.createDiv({ cls: "goalscape-band" });
    group.setAttr("role", "group");
    group.setAttr("aria-label", "Ring thickness");

    BAND_STEPS.forEach((step, i) => {
      const btn = group.createEl("button", { cls: "goalscape-band-btn" });
      const isCurrent = node.bandScale === undefined
        ? i === BAND_DEFAULT_INDEX
        : Math.abs(node.bandScale - step) < 0.001;
      if (isCurrent) {
        btn.addClass("is-active");
        btn.setAttr("aria-pressed", "true");
      }
      btn.setAttr("aria-label", BAND_LABELS[i]);
      setTooltip(btn, BAND_LABELS[i], { placement: "top" });
      // 小横条的高度按档位比例算，免得改了 BAND_STEPS 忘了改这里
      btn.createEl("i").style.height = `${Math.max(3, Math.round(8 * step))}px`;
      btn.addEventListener("click", () => {
        this.mutate((s) => {
          const found = findNode(s.mainGoal, node.id);
          if (!found) return;
          if (i === BAND_DEFAULT_INDEX) delete found.node.bandScale;
          else found.node.bandScale = step;
        });
      });
    });
  }

  /**
   * 色系选择只出现在持有 color 的两层：中心盘只管自己，二级节点那一份就是整条分支的颜色、
   * 后代一律沿父链继承 —— 所以没有"父改了子没改"这种状态，也不需要"应用到子目标"按钮。
   */
  private addHueControls(node: GoalNode, isHub: boolean): void {
    new Setting(this.container)
      .setName(isHub ? "Hub color" : "Branch color")
      .setDesc(isHub
        ? "Center disc only · Subgoals keep their own hue"
        : "Applies to this whole branch · Empty = default green")
      .addText((text) => {
        text.inputEl.placeholder = "#4ade80";
        text.setValue(node.color ?? "");
        text.inputEl.addEventListener("blur", () => {
          const norm = normalizeHex(text.getValue());
          if (norm === null) {
            new Notice("Color must be empty or a hex value like #4ade80");
            text.setValue(node.color ?? "");
            return;
          }
          this.setColor(node, norm || undefined);
        });
      });

    const swatches = this.container.createDiv({ cls: "goalscape-color-swatches" });

    const picker = swatches.createEl("input", { cls: "goalscape-color-picker" });
    picker.type = "color";
    picker.title = "Custom color";
    picker.value = node.color ?? DEFAULT_BRANCH_COLOR;
    // 只接 change：系统取色面板的 input 事件会随拖动连发，每帧都落盘并重建整个面板
    picker.addEventListener("change", () => {
      this.setColor(node, normalizeHex(picker.value) || undefined);
    });

    const auto = swatches.createEl("button", {
      cls: "goalscape-swatch goalscape-swatch-auto",
      text: "Auto",
    });
    auto.title = "Default hue; progress shows on the sector rim";
    if (!node.color) auto.addClass("goalscape-swatch-active");
    auto.addEventListener("click", () => this.setColor(node, undefined));

    // 色盘跟着设置页那根"浓艳度"滑杆一起变，所以色块上看到的就是图上会有的颜色
    for (const hex of paletteSwatches(this.plugin.tone)) {
      const swatch = swatches.createEl("button", { cls: "goalscape-swatch" });
      swatch.style.backgroundColor = hex;
      swatch.title = hex;
      if (node.color === hex) swatch.addClass("goalscape-swatch-active");
      swatch.addEventListener("click", () => this.setColor(node, hex));
    }
  }

  /** 三级往内不能选色系，这里换成明度偏移：0 即所属分支的默认色 */
  private addBrightnessControl(node: GoalNode): void {
    new Setting(this.container)
      .setName("Brightness")
      .setDesc("Hue comes from its branch · 0 = default, -20 darker, +20 lighter")
      .addSlider((slider) => {
        slider.setLimits(-20, 20, 1);
        slider.setValue(node.brightness ?? 0);
        slider.setDynamicTooltip();
        this.trackInteraction(slider.sliderEl);
        slider.onChange((v) => {
          this.mutate((s) =>
            this.patch(s, node.id, (n) => {
              if (v === 0) delete n.brightness;
              else n.brightness = v;
            })
          );
        });
      });
  }

  /** 拖拽期间屏蔽外部 refresh() 触发的重建，释放后立即补一次完整渲染同步最终状态 */
  private trackInteraction(el: HTMLElement): void {
    // window 上的 pointerup 监听必须随拖拽建立、随释放拆除。
    // 早先每次 render 都无条件挂一个常驻监听：面板每改一次值就重建一次，
    // 监听越积越多，之后在应用里点任何地方都会重建整个面板（滚动位置被弹回顶部）。
    el.addEventListener("pointerdown", () => {
      this.interacting = true;
      const end = () => {
        this.interacting = false;
        window.removeEventListener("pointerup", end);
        this.render(true);
      };
      window.addEventListener("pointerup", end);
    });
  }

  private mutate(fn: (s: GoalScape) => void): void {
    this.plugin.store.mutate(fn);
  }

  private setColor(node: GoalNode, color: string | undefined): void {
    if (color === node.color) return;
    this.mutate((s) => this.patch(s, node.id, (n) => (n.color = color)));
  }

  private patch(scape: GoalScape, id: string, fn: (n: GoalNode) => void): void {
    const found = findNode(scape.mainGoal, id);
    if (found) fn(found.node);
  }
}
