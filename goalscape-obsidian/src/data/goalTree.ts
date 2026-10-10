// src/data/goalTree.ts
// GoalTreeStore：数据层单例。所有变更通过 mutate 一个入口，
// 确保自动汇总 + 持久化 + 通知所有订阅视图重渲染。

import { TFile, Plugin, Notice } from "obsidian";
import { GoalScape, GoalNode, createGoalNode, HUE_OWNER_DEPTH } from "./types";
import { recalcTree } from "./rollup";

/** vault 里存放 goalscape 文件的目录与扩展名，多处按它筛选/建档，只在这一处定义 */
export const GOALSCAPE_FOLDER = "Goalscapes";
export const GOALSCAPE_SUFFIX = ".goalscape.json";

export const DEFAULT_GOALSCAPE_PATH = `${GOALSCAPE_FOLDER}/life${GOALSCAPE_SUFFIX}`;

/** 已废弃字段：旧 JSON 里仍带着它，读档时清掉，落盘后自然消失 */
type LegacyNode = GoalNode & { responsible?: unknown; fields?: unknown };

/** Phase 1 默认结构：中心 Main Goal + 三段 L1 子目标 */
export function createDefaultScape(): GoalScape {
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
  /** 外部修改监听只注册一次（切换文件时 load() 会再次调用） */
  private watching = false;
  /** 写入落盘时的静默标记，避免 vault modify 事件把自己写的文件又读回来造成抖动 */
  private writing = false;
  /** 外部修改去抖计时器 */
  private reloadTimer: number | null = null;

  constructor(
    private plugin: Plugin,
    public path: string = DEFAULT_GOALSCAPE_PATH
  ) {}

  /** 切换到另一个 goalscape 文件：改路径 → 重新 load（watch 只注册一次） */
  async switchTo(newPath: string): Promise<void> {
    if (newPath === this.path && this.scape) return;
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.path = newPath;
    this.file = null;
    await this.load();
  }

  async load(): Promise<void> {
    await this.ensureFolder();
    const exists = await this.plugin.app.vault.adapter.exists(this.path);
    if (exists) {
      await this.readFromPath();
    } else {
      this.scape = createDefaultScape();
      await this.writeScape();
      this.file =
        this.plugin.app.vault.getAbstractFileByPath(this.path) instanceof TFile
          ? (this.plugin.app.vault.getAbstractFileByPath(this.path) as TFile)
          : null;
      new Notice(`Goalscape: created ${this.path}`);
    }
    this.registerExternalWatch();
    this.notify();
  }

  private async ensureFolder(): Promise<void> {
    const folder = this.path.split("/").slice(0, -1).join("/");
    if (!folder || this.plugin.app.vault.getAbstractFileByPath(folder)) return;
    // 启动早期 vault 索引尚未就绪，getAbstractFileByPath 会误报 null，
    // 此时 createFolder 抛 "Folder already exists." 会直接打断 plugin.onload，
    // 导致视图注册不上、整个插件显示"插件不再活动"。
    try {
      await this.plugin.app.vault.createFolder(folder);
    } catch {
      /* 目录已存在，忽略 */
    }
  }

  /** 用 adapter 按路径读取，避免 getAbstractFileByPath 因索引异步而拿到 null 的竞态 */
  private async readFromPath(): Promise<void> {
    try {
      const raw = await this.plugin.app.vault.adapter.read(this.path);
      if (!raw || !raw.trim()) throw new Error("empty file");
      const parsed = JSON.parse(raw) as GoalScape;
      if (!parsed || parsed.version !== 1 || !parsed.mainGoal) {
        throw new Error("invalid goalscape json");
      }
      this.normalize(parsed.mainGoal);
      this.scape = parsed;
      const f = this.plugin.app.vault.getAbstractFileByPath(this.path);
      this.file = f instanceof TFile ? f : null;
    } catch (err) {
      console.error("Goalscape: failed to parse", this.path, err);
      new Notice(`Goalscape: failed to parse ${this.path}, keeping in-memory copy`);
    }
  }

  /** 补齐缺省字段，兼容手写/外部编辑的 JSON；顺带把"色相只属于中心盘和二级节点"这条规则落到数据上 */
  private normalize(node: GoalNode, depth = 0): void {
    node.id ??= createGoalNode({ title: node.title ?? "Untitled" }).id;
    node.title ??= "Untitled";
    node.importance ??= 50;
    delete (node as LegacyNode).responsible;
    // Custom fields 是个只写不读的死洞（放射图/白板/导出全都不看它），字段随功能一起删掉
    delete (node as LegacyNode).fields;
    // 手工块间链接已翻案成"笔记互引"（关系有出处、能跳到原文那一节），旧字段读档即删
    delete (node as LegacyNode).links;
    // 旧数据里深层节点可能存过 color：读档时一律清掉（中心盘和二级节点各自持有）。
    // 留着就是"文件里有值、图上不生效"的第三种状态，也正是父子颜色不同步的来源
    if (depth > HUE_OWNER_DEPTH) delete node.color;
    if (node.brightness === undefined || !Number.isFinite(Number(node.brightness))) {
      delete node.brightness;
    } else {
      node.brightness = Math.max(-20, Math.min(20, Math.round(Number(node.brightness))));
    }
    node.tags ??= [];
    node.children ??= [];
    node.children.forEach((c) => this.normalize(c, depth + 1));
  }

  /** 监听外部（用户手动改 JSON / 同步冲突）修改，自动重载并刷新视图 */
  private registerExternalWatch(): void {
    if (this.watching) return;
    this.watching = true;
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (f) => {
        if (!(f instanceof TFile) || f.path !== this.path) return;
        if (this.writing) return;
        if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
        this.reloadTimer = window.setTimeout(async () => {
          this.reloadTimer = null;
          await this.readFromPath();
          this.notify();
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
    await this.writeScape();
  }

  /** 统一落盘入口：绝不写空内容，避免把 goalscape 文件截断成 0 字节造成数据丢失 */
  private async writeScape(): Promise<void> {
    if (!this.scape) return;
    // 落盘前再走一次规则：复制粘贴等路径可能把 color 带到深层节点上，
    // 那种值图上不生效、却会留在文件里，是"父子颜色不一致"的第三种状态
    this.normalize(this.scape.mainGoal);
    const content = JSON.stringify(this.scape, null, 2);
    if (!content) return;
    this.writing = true;
    try {
      await this.plugin.app.vault.adapter.write(this.path, content);
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

  /**
   * 树没变、只是树外面的东西变了（笔记文件被改/被建/被删）：
   * 不改数据、不落盘，只让视图重画一遍。跟 mutate 分开，免得白写一次 JSON。
   */
  bump(): void {
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}
