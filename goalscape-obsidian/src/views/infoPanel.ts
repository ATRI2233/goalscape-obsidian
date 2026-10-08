// src/views/infoPanel.ts
// 右侧信息面板：编辑 Title / Importance / Progress / Due / Start / Responsible /
// Tags / Color / Notes / 自定义字段。所有改动统一走 store.mutate。

import { Setting, Notice } from "obsidian";
import type GoalscapePlugin from "../main";
import { GoalNode, GoalScape, findNode } from "../data/types";
import { renameGoal, adjustImportance, applyColorToSubtree } from "../data/crud";
import { promptInput } from "./promptModal";

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 归一化成 #rrggbb，非色值返回 null。
 * 放射图的 shadeColor / luminance 都只解析 6 位，放行 #f0a 会让该子树
 * 静默失去环层提亮，并按"亮度 0"误选白字；带 alpha 的 8 位同样不被解析。
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
      new Setting(this.container)
        .setName("Importance")
        .setDesc(`${Math.round(node.importance)}`)
        .addSlider((slider) => {
          slider.setLimits(0, 100, 1);
          slider.setValue(Math.round(node.importance));
          slider.setDynamicTooltip();
          this.trackInteraction(slider.sliderEl);
          slider.onChange((v) => {
            this.mutate((s) => adjustImportance(s, node.id, v));
          });
        });
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
      .setName("Responsible")
      .setDesc("Comma separated")
      .addText((text) => {
        text.setValue(node.responsible.join(", "));
        text.inputEl.addEventListener("blur", () => {
          const list = splitCsv(text.getValue());
          this.mutate((s) => this.patch(s, node.id, (n) => (n.responsible = list)));
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

    new Setting(this.container)
      .setName("Color")
      .setDesc("Empty = color by progress")
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
          const v = norm || undefined;
          if (v === node.color) return;
          this.mutate((s) => this.patch(s, node.id, (n) => (n.color = v)));
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText("Apply to subgoals")
          .setDisabled(!node.children.length)
          .onClick(() => {
            this.mutate((s) => applyColorToSubtree(s, node.id));
          })
      );

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

  private patch(scape: GoalScape, id: string, fn: (n: GoalNode) => void): void {
    const found = findNode(scape.mainGoal, id);
    if (found) fn(found.node);
  }
}
