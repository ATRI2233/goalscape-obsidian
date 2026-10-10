// src/views/infoPanel.ts
// 右侧信息面板：编辑 Title / Importance / Progress / Due / Start /
// Tags / 色系（中心盘与二级节点）或明度（更深层级）/ Notes（渲染预览 + 一键交给原生编辑器）/
// References / Referenced by（都从笔记互引现扫，面板只读）。
// 所有改动统一走 store.mutate。

import { Component, MarkdownRenderer, Setting, Notice, TFile, setTooltip } from "obsidian";
import type { GoalscapeHost } from "./host";
import { DEFAULT_BRANCH_COLOR, GoalNode, GoalScape, NoteRef, findNode } from "../data/types";
import { incomingRefs, outgoingRefs } from "../data/notes";
import { paletteSwatches } from "../data/palette";
import { renameGoal, adjustImportance, setBrightness } from "../data/crud";
import { BAND_DEFAULT_INDEX, BAND_STEPS } from "../geometry/radialGeometry";

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
  /** 这次按住的过程中改过数据没有：只有改过才需要在松手后补一次渲染 */
  private dirtyWhileInteracting = false;
  /**
   * 渲染态下挂进 MarkdownRenderer 的宿主组件。
   * 每次重建预览前先旧建新，Obsidian 靠它管理嵌入子组件的生命周期。
   */
  private notesHost: Component | null = null;

  constructor(
    private container: HTMLElement,
    private plugin: GoalscapeHost,
    /** 点链接 chip 时跳选目标块（由视图注入：含"展开折叠祖先"的完整跳选） */
    private onSelectNode?: (id: string) => void
  ) {}

  /** 视图销毁时调用：预览的嵌入子组件要跟着 unload，不然每开一次面板挂一组孤儿 */
  destroy(): void {
    this.notesHost?.unload();
    this.notesHost = null;
  }

  /** 切换选中节点：始终强制重建，并把 notes 打回渲染态 */
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
    // 每次重建先卸掉上一份预览的宿主：嵌入子组件（Mermaid 之类）挂在它身上，
    // 不卸就是每点一次扇区泄漏一组
    this.notesHost?.unload();
    this.notesHost = null;
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

    this.renderTitle(node);
    this.renderWeight(node, isMain);
    this.renderProgress(node, isLeaf);
    this.renderSchedule(node);

    if (ownsHue) this.addHueControls(node, isMain);
    else this.addBrightnessControl(node);

    this.renderNotes(node);
    this.renderLinks(node);
  }

  private renderTitle(node: GoalNode): void {
    new Setting(this.container).setName("Title").addText((text) => {
      text.setValue(node.title);
      text.inputEl.addEventListener("blur", () => {
        const v = text.getValue().trim();
        if (v && v !== node.title) this.mutate((s) => renameGoal(s, node.id, v));
      });
    });
  }

  /** 占比与环带厚度：中心盘没有 Importance 行，但它的厚度就是 hub 半径，同样要能调 */
  private renderWeight(node: GoalNode, isMain: boolean): void {
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
      return;
    }
    this.addBandControl(
      new Setting(this.container).setName("Hub size").setDesc("Center disc thickness"),
      node
    );
  }

  /** 叶子节点手填进度；中间节点只显示，值由 rollup 算出来 */
  private renderProgress(node: GoalNode, isLeaf: boolean): void {
    if (!isLeaf) {
      new Setting(this.container)
        .setName("Progress (auto-rollup)")
        .setDesc(`${node.progress ?? 0}%`);
      return;
    }
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
  }

  /** 起止日期与标签：三个字段各写各的，都不参与几何 */
  private renderSchedule(node: GoalNode): void {
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
          this.mutate((s) => setBrightness(s, node.id, v));
        });
      });
  }

  /** 拖拽期间屏蔽外部 refresh() 触发的重建，释放后只在真的改过数据时补一次渲染 */
  private trackInteraction(el: HTMLElement): void {
    // window 上的 pointerup 监听必须随拖拽建立、随释放拆除。
    // 早先每次 render 都无条件挂一个常驻监听：面板每改一次值就重建一次，
    // 监听越积越多，之后在应用里点任何地方都会重建整个面板（滚动位置被弹回顶部）。
    el.addEventListener("pointerdown", () => {
      this.interacting = true;
      this.dirtyWhileInteracting = false;
      const end = () => {
        this.interacting = false;
        window.removeEventListener("pointerup", end);
        // 两个条件都是被真鼠标点出来的：
        // 1) 只有拖拽期间真改过数据才需要补渲染。滑杆要，按钮不要 —— 按钮的 click
        //    处理器自己会渲染。
        // 2) 补渲染必须推迟一个宏任务。click 在 pointerup 之后才派发，同步重建会把
        //    用户正点着的那个元素拆掉，按下/抬起目标不一致 Chrome 就不再派发 click，
        //    按钮看着"点不动"（Edit / Add link / chip 跳转全中过这个招）。
        if (this.dirtyWhileInteracting) setTimeout(() => this.render(true), 0);
      };
      window.addEventListener("pointerup", end);
    });
  }

  /**
   * Notes 区：正文只活在这个块的 .md 文件里，面板不再自己造编辑器 ——
   * 渲染态用原生 MarkdownRenderer（`[[链接]]` 可点、`![[嵌入]]` 能渲染、悬浮 preview 白拿），
   * 撰写一键交给 Obsidian 自己的编辑器，于是补全、反链面板、全局搜索、关系图谱全是白拿的，
   * 插件不必去追编辑器那一大套功能。sourcePath 传笔记自己的路径，相对链接才按笔记所在位置解析。
   */
  private renderNotes(node: GoalNode): void {
    const note = this.plugin.notes.get(node.id);
    const head = this.container.createDiv({ cls: "goalscape-panel-label goalscape-notes-head" });
    head.createSpan({ text: "Notes" });
    const btn = head.createEl("button", {
      cls: "goalscape-notes-toggle",
      text: note ? "Open note" : "New note",
    });
    if (note) btn.title = note.path;
    this.trackInteraction(btn);
    btn.addEventListener("click", () => void this.openNote(node));

    const body = this.container.createDiv({ cls: "goalscape-notes-render" });
    if (!note) {
      body.createDiv({ cls: "goalscape-panel-empty", text: "No note file yet." });
      return;
    }
    if (!note.text.trim()) {
      body.createDiv({ cls: "goalscape-panel-empty", text: "Note is empty." });
      return;
    }
    const host = new Component();
    this.notesHost = host;
    void MarkdownRenderer.render(this.plugin.app, note.text, body, note.path, host);
  }

  /**
   * 打开这个块的笔记；还没有文件就先建一个再打开。
   * 建文件只发生在这里（用户点了这一下）和迁移旧数据时 —— 插件绝不主动往 vault 里扔空笔记。
   */
  private async openNote(node: GoalNode): Promise<void> {
    const app = this.plugin.app;
    let path = this.plugin.notes.get(node.id)?.path ?? node.note;
    if (!path) {
      try {
        path = await this.plugin.notes.createFor(node);
      } catch (err) {
        new Notice(`Goalscape: 建笔记失败 ${(err as Error).message}`);
        return;
      }
      const created = path;
      this.mutate((s) => this.patch(s, node.id, (n) => (n.note = created)));
      await this.plugin.notes.rebuild();
      this.plugin.store.bump();
    }
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Goalscape: 找不到笔记文件 ${path}`);
  }

  /**
   * 块间关系只从笔记互引里长出来：本块笔记 `[[` 了别的块的笔记 = 出向，反过来 = 入向。
   * 出向 chip 点主体 = 打开对端笔记并落到锚点那一节；入向 chip 点主体 = 跳选引用方那块。
   * 关系住在正文里，所以这里**没有断链也没有添加** —— 要改就去笔记里改那条 wikilink。
   */
  private renderLinks(node: GoalNode): void {
    const scape = this.plugin.store.scape;
    if (!scape) return;
    const index = this.plugin.notes.notes;
    const titleOf = (id: string) => findNode(scape.mainGoal, id)?.node.title;

    const out = outgoingRefs(index, node.id)
      .map((ref) => ({ ref, title: ref.goalId ? titleOf(ref.goalId) : undefined }))
      .filter((x): x is { ref: NoteRef; title: string } => Boolean(x.title));
    if (out.length) {
      this.container.createEl("h4", { text: "References" });
      const row = this.container.createDiv({ cls: "goalscape-chips" });
      for (const { ref, title } of out) {
        this.createChip(row, title, ref.anchor, () => this.openNoteAt(ref));
      }
    }

    const inc = incomingRefs(index, node.id).filter((x) => titleOf(x.fromId));
    if (inc.length) {
      this.container.createEl("h4", { text: "Referenced by" });
      const row = this.container.createDiv({ cls: "goalscape-chips" });
      for (const { fromId, ref } of inc) {
        this.createChip(row, titleOf(fromId)!, ref.anchor, () => this.onSelectNode?.(fromId));
      }
    }
  }

  /** 打开对端笔记并落到锚点那一节：`#小节` / `#^块` 这套语法 Obsidian 自己认 */
  private openNoteAt(ref: NoteRef): void {
    void this.plugin.app.workspace.openLinkText(`${ref.path}${ref.anchor}`, ref.path, true);
  }

  /** 一个 chip：主体按钮走 onClick，锚点作为淡色后缀（没有锚点就不占地方） */
  private createChip(row: HTMLElement, title: string, anchor: string, onClick: () => void): void {
    const chip = row.createDiv({ cls: "goalscape-chip" });
    const label = chip.createEl("button", { cls: "goalscape-chip-main" });
    label.createSpan({ text: title });
    if (anchor) label.createSpan({ cls: "goalscape-chip-anchor", text: anchor });
    this.trackInteraction(label);
    label.addEventListener("click", onClick);
  }

  private mutate(fn: (s: GoalScape) => void): void {
    if (this.interacting) this.dirtyWhileInteracting = true;
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
