// src/data/goalTree.ts
// GoalTreeStore：数据层单例。所有变更通过 mutate 一个入口，
// 确保自动汇总 + 持久化 + 通知所有订阅视图重渲染。

import { TFile, Plugin, Notice } from "obsidian";
import { GoalScape, GoalNode, createGoalNode } from "./types";
import { recalcTree } from "./rollup";

export const DEFAULT_GOALSCAPE_PATH = "Goalscapes/life.goalscape.json";

/** Phase 1 默认结构：中心 Main Goal + 三段 L1 子目标 */
function createDefaultScape(): GoalScape {
  return {
    version: 1,
    mainGoal: createGoalNode({
      title: "Main Goal",
      importance: 100,
      children: [
        createGoalNode({ title: "Health", importance: 40, children: [] }),
        createGoalNode({ title: "Career", importance: 35, children: [] }),
        createGoalNode({ title: "Relationships", importance: 25, children: [] }),
      ],
    }),
  };
}

export class GoalTreeStore {
  private listeners = new Set<() => void>();
  scape!: GoalScape;
  file: TFile | null = null;
  /** 写入落盘时的静默标记，避免 vault modify 事件把自己写的文件又读回来造成抖动 */
  private writing = false;
  /** 外部修改去抖计时器 */
  private reloadTimer: number | null = null;

  constructor(
    private plugin: Plugin,
    public readonly path: string = DEFAULT_GOALSCAPE_PATH
  ) {}

  async load(): Promise<void> {
    await this.ensureFolder();
    const f = this.plugin.app.vault.getAbstractFileByPath(this.path);
    if (f instanceof TFile) {
      await this.readFromFile(f);
    } else {
      this.scape = createDefaultScape();
      // 首次建档用 vault.create 而非 adapter.write：adapter.write 绕过 Vault 索引，
      // 紧接着的 getAbstractFileByPath 有极小概率因索引异步刷新而拿到 null。
      this.writing = true;
      try {
        this.file = await this.plugin.app.vault.create(
          this.path,
          JSON.stringify(this.scape, null, 2)
        );
      } finally {
        window.setTimeout(() => (this.writing = false), 500);
      }
      new Notice(`Goalscape: created ${this.path}`);
    }
    this.registerExternalWatch();
    this.notify();
  }

  private async ensureFolder(): Promise<void> {
    const folder = this.path.split("/").slice(0, -1).join("/");
    if (folder && !this.plugin.app.vault.getAbstractFileByPath(folder)) {
      await this.plugin.app.vault.createFolder(folder);
    }
  }

  private async readFromFile(f: TFile): Promise<void> {
    try {
      const raw = await this.plugin.app.vault.read(f);
      const parsed = JSON.parse(raw) as GoalScape;
      if (!parsed || parsed.version !== 1 || !parsed.mainGoal) {
        throw new Error("invalid goalscape json");
      }
      this.normalize(parsed.mainGoal);
      this.scape = parsed;
      this.file = f;
    } catch (err) {
      console.error("Goalscape: failed to parse", this.path, err);
      new Notice(`Goalscape: failed to parse ${this.path}, keeping in-memory copy`);
    }
  }

  /** 补齐缺省字段，兼容手写/外部编辑的 JSON */
  private normalize(node: GoalNode): void {
    node.id ??= createGoalNode({ title: node.title ?? "Untitled" }).id;
    node.title ??= "Untitled";
    node.importance ??= 50;
    node.responsible ??= [];
    node.tags ??= [];
    node.children ??= [];
    node.children.forEach((c) => this.normalize(c));
  }

  /** 监听外部（用户手动改 JSON / 同步冲突）修改，自动重载并刷新视图 */
  private registerExternalWatch(): void {
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (f) => {
        if (!(f instanceof TFile) || f.path !== this.path) return;
        if (this.writing) return;
        if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
        this.reloadTimer = window.setTimeout(async () => {
          this.reloadTimer = null;
          if (this.file) {
            await this.readFromFile(this.file);
            this.notify();
          }
        }, 300);
      })
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (f) => {
        if (f instanceof TFile && f.path === this.path) this.file = null;
      })
    );
  }

  async save(): Promise<void> {
    this.writing = true;
    try {
      await this.plugin.app.vault.adapter.write(
        this.path,
        JSON.stringify(this.scape, null, 2)
      );
    } finally {
      // adapter.write 触发 modify 事件是异步的，稍晚再解除标记
      window.setTimeout(() => (this.writing = false), 500);
    }
  }

  /** 所有变更通过这一个入口：自动汇总 → 持久化 → 通知视图 */
  mutate(fn: (s: GoalScape) => void): void {
    if (!this.scape) return;
    fn(this.scape);
    recalcTree(this.scape.mainGoal);
    void this.save();
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}
