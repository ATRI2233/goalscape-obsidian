// src/export/canvasMirror.ts
// 树 → .canvas 的单向自动镜像子系统：防抖、"有人开着就不写"、快照可信度、写入重试、待写状态。
// 它是持久化适配器（读写 vault 里的 .canvas、摘 workspace 标签页），与 data/goalTree、
// data/noteFiles 同一性质，因此进 obsidian 白名单；纯内容映射留在 canvasSync.ts（那边不碰框架）。
// 工具栏那颗小点不在这里涂：镜像不认识按钮，只把"欠着写"这件事告诉组合根。

import { App, EventRef, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { GoalTreeStore } from "../data/goalTree";
import type { NoteIndex } from "../data/types";
import { canvasToJson, parseCanvasJson, refreshCanvas, trustedSnapshot, type JsonCanvas } from "./canvasSync";

/** 树变了之后攒多久再写白板：拖滑杆是一次改动几十下 notify，不攒就会把 vault 写成抖动源 */
const DEBOUNCE_MS = 800;
/** 摘掉白板标签页之后 Obsidian 还会把内存那份补写一次，等它落地再重试 */
const WRITE_RETRY = 3;
const WRITE_SETTLE_MS = 150;
/** 欠着更新时回头看标签页关了没 —— layout-change 不一定赶在 detach 之后发 */
const SETTLE_MS = 1000;

export interface CanvasMirrorHost {
  app: App;
  store: GoalTreeStore;
  /** 笔记索引：白板卡片上的摘要与互引边都从这儿来 */
  noteIndex: () => NoteIndex;
  /** data.json 只有一个写入方（main.persistData），镜像改了什么都得走那条路 */
  persist: () => void;
  /** 把"这块白板欠着一次写入"涂到界面开关上 */
  paintBadges: () => void;
  /** 事件挂到 Plugin 生命周期，卸载时由 Obsidian 负责摘 */
  registerEvent: (ref: EventRef) => void;
}

export class CanvasMirror {
  /** 自动镜像开关。关掉只剩手点命令 */
  auto = true;
  /** 白板标签页开着、这次没写进去的路径 —— 工具栏那个小点就按它亮 */
  private pending: string | null = null;
  private timer: number | null = null;
  private settleTimer: number | null = null;
  private writing = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private host: CanvasMirrorHost) {}

  /** 当前这张图的白板有没有"还没写进去的改动" */
  get stale(): boolean {
    return !!this.pending && this.pending === this.pathFor();
  }

  /**
   * 白板与图文件一一对应，用图文件名派生，不用根目标标题：
   * 标题随时可改（改了就会把白板落在旧文件里），且每张新图的默认根标题都是 "Main Goal"，
   * 多张图会抢同一个 .canvas。文件名规则只在这一处写，命令导出与切换器共用。
   */
  private pathFor(): string {
    const folder = this.host.store.path.split("/").slice(0, -1).join("/");
    const base = this.host.store.path.split("/").pop()!.replace(/\.goalscape\.json$/, "");
    return `${folder}/${base}.canvas`;
  }

  /**
   * 三条约束都来自实测，不是洁癖：
   * - 白板文件不存在时**绝不自动创建**，凭空往 vault 扔文件是另一种丢数据；
   * - 白板标签页开着时不写盘：Obsidian 的 canvas 视图内存领先磁盘几十秒，
   *   它任何一次补写都会盖在我们后面 —— 用户今天的布局就是这么没的；
   * - 内容一样不写：插件启动也会 notify 一次，不该白白改一次文件。
   */
  watch(): void {
    this.unsubscribe = this.host.store.subscribe(() => this.queueRefresh());
    // 关白板标签页正是补写的时机（视图关闭时自己会先把内存那份落盘）
    this.host.registerEvent(this.host.app.workspace.on("layout-change", () => this.settlePending()));
    this.host.paintBadges();
  }

  unload(): void {
    for (const t of [this.timer, this.settleTimer]) if (t !== null) window.clearTimeout(t);
    this.timer = null;
    this.settleTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 设置页那个开关。关掉之后不该留一颗永远不会消失的小点，打开则欠着的马上补一次 */
  setAuto(v: boolean): void {
    this.auto = v;
    this.host.persist();
    if (v) {
      this.queueRefresh();
      return;
    }
    this.pending = null;
    this.host.paintBadges();
  }

  /**
   * 切换器里的 Canvas 项。三种情况分开走，因为"正在看的白板"盖不得：
   * 文件不存在 → 生成第一版；存在且没开着 → 先刷成最新的再打开（点它就是来看最新图）；
   * 已经开着 → 只切过去不写盘，待更新的小点继续亮着，等标签页关掉再补。
   */
  async open(): Promise<void> {
    const canvasPath = this.pathFor();
    const exists = this.host.app.vault.getAbstractFileByPath(canvasPath) instanceof TFile;
    if (exists) {
      const open = this.openLeaves(canvasPath);
      if (open.length) {
        this.host.app.workspace.revealLeaf(open[0]);
        return;
      }
      await this.refresh(false);
      await this.openFile(canvasPath);
      return;
    }
    await this.refresh(true);
  }

  /** 手点命令的入口 */
  async refreshExplicit(): Promise<void> {
    await this.refresh(true);
  }

  private queueRefresh(): void {
    if (!this.auto || !this.host.store.scape) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh(false);
    }, DEBOUNCE_MS);
  }

  private settlePending(): void {
    if (!this.auto || !this.pending) return;
    // 换图之后上一张的待更新状态不该继续顶着这个点
    if (this.pending !== this.pathFor()) {
      this.pending = null;
      this.host.paintBadges();
      return;
    }
    if (this.openLeaves(this.pending).length) {
      this.armSettle();
      return;
    }
    void this.refresh(false);
  }

  private armSettle(): void {
    if (this.settleTimer !== null) return;
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.settlePending();
    }, SETTLE_MS);
  }

  /**
   * Obsidian 没有公开"这块白板有没有未保存的改动"，而它任何一次补写都会盖在我们后面
   * （实测内存领先磁盘几十秒，关标签页时还会再落一次），所以规则只能是一条：**有人开着就不写**。
   */
  private openLeaves(canvasPath: string): WorkspaceLeaf[] {
    return this.host.app.workspace
      .getLeavesOfType("canvas")
      .filter((l) => (l.view as { file?: TFile }).file?.path === canvasPath);
  }

  private liveDoc(leaf: WorkspaceLeaf | undefined): JsonCanvas | null {
    const canvas = (leaf?.view as { canvas?: { getData?: () => unknown } } | undefined)?.canvas;
    if (typeof canvas?.getData !== "function") return null;
    try {
      return parseCanvasJson(JSON.stringify(canvas.getData()));
    } catch {
      return null;
    }
  }

  /** 白板快照：内存优先（实测它领先磁盘几十秒），但只有真加载出卡片才算可信，否则退回磁盘 */
  private async snapshot(canvasPath: string): Promise<JsonCanvas | null> {
    const leaf = this.openLeaves(canvasPath)[0];
    const disk =
      this.host.app.vault.getAbstractFileByPath(canvasPath) instanceof TFile
        ? parseCanvasJson(await this.host.app.vault.adapter.read(canvasPath).catch(() => ""))
        : null;
    return trustedSnapshot(this.liveDoc(leaf), disk);
  }

  /**
   * 单向镜像落盘。explicit = 用户手点的命令：可以创建文件、可以摘标签页、要给反馈。
   * 自动路径只在"文件已存在 && 没人开着这块白板"时写。
   */
  private async refresh(explicit: boolean): Promise<void> {
    const scape = this.host.store.scape;
    if (!scape || this.writing) return;
    const path = this.pathFor();
    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) && !explicit) return;

    const open = this.openLeaves(path);
    if (!explicit && open.length) {
      this.pending = path;
      this.host.paintBadges();
      return;
    }

    const json = canvasToJson(refreshCanvas(scape, await this.snapshot(path), this.host.noteIndex()));
    if (file instanceof TFile) {
      const disk = (await this.host.app.vault.adapter.read(path).catch(() => "")).trim();
      if (disk === json.trim()) {
        this.pending = null;
        this.host.paintBadges();
        if (explicit) {
          new Notice(`白板已是最新：${path}`);
          await this.openFile(path);
        }
        return;
      }
    }

    // 入口那道"文件不存在就不自动写"查到真正落盘之间隔着快照读取、摘标签页与 150ms 静置：
    // 这期间用户可能正好把这块白板删了，那时再 create 等于替他把刚删的文件建回来
    if (!explicit && !(this.host.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
      this.pending = null;
      this.host.paintBadges();
      return;
    }

    this.writing = true;
    let written = false;
    try {
      // 先摘标签页、后写盘：canvas 视图关闭时会把内存里那份补写一次，顺序反了刚写的就被盖掉
      for (const l of open) l.detach();
      await new Promise((r) => window.setTimeout(r, WRITE_SETTLE_MS));
      written = await this.writeDoc(path, json);
      this.pending = written ? null : path;
    } finally {
      this.writing = false;
    }
    this.host.paintBadges();
    if (!explicit) return;
    new Notice(written ? `白板已更新：${path}` : `白板写入失败：${path}`);
    await this.openFile(path);
  }

  /**
   * 写完读回来确认落盘的是我们这份 —— 刚摘掉的 canvas 视图会把内存里那份补写一次，
   * 实测就发生在我们的 modify 之后。重试几次比假装没这回事便宜。
   */
  private async writeDoc(path: string, json: string): Promise<boolean> {
    for (let i = 0; i < WRITE_RETRY; i++) {
      const f = this.host.app.vault.getAbstractFileByPath(path);
      try {
        if (f instanceof TFile) await this.host.app.vault.modify(f, json);
        else await this.host.app.vault.create(path, json);
      } catch {
        return false;
      }
      const back = (await this.host.app.vault.adapter.read(path).catch(() => "")).trim();
      if (back === json.trim()) return true;
      await new Promise((r) => window.setTimeout(r, WRITE_SETTLE_MS));
    }
    return false;
  }

  /**
   * 三种情况分开走，因为"正在看的白板"盖不得：
   * 文件不存在 → 生成第一版；存在且没开着 → 先刷成最新的再打开（点它就是来看最新图）；
   * 已经开着 → 只切过去不写盘，待更新的小点继续亮着，等标签页关掉再补。
   */
  private async openFile(canvasPath: string): Promise<void> {
    const file = this.host.app.vault.getAbstractFileByPath(canvasPath);
    if (!(file instanceof TFile)) {
      new Notice(`Canvas file not found: ${canvasPath}`);
      return;
    }
    const opened = this.host.app.workspace
      .getLeavesOfType("canvas")
      .find((leaf) => (leaf.view as { file?: TFile }).file?.path === canvasPath);
    if (opened) {
      this.host.app.workspace.revealLeaf(opened);
      return;
    }
    const leaf = this.host.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.host.app.workspace.revealLeaf(leaf);
  }
}
