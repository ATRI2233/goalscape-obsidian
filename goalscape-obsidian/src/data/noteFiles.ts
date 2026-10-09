// src/data/noteFiles.ts
// 块 ↔ 笔记文件的适配器：建目录、起不撞名的文件名、写 frontmatter、按 gsId 把被改名的文件找回来、
// 读正文与出链、盯 vault 事件。内层里第二个允许碰 obsidian 的文件（第一个是 goalTree，同样是持久化适配器）：
// 它把文件系统的形状压成纯数据 NoteIndex，导出层与几何层照旧一个 obsidian import 都没有。
//
// 一条红线：**绝不替用户建笔记文件**。只有两处会写文件 —— 用户在面板上点了"新建笔记"，
// 以及把旧版存在 JSON 里的正文搬出来（迁移）。块再多，没写过的块就是没有文件，
// vault 里不会平白多出四十个空笔记。

import { Plugin, TFile, TFolder, type CachedMetadata } from "obsidian";
import { GoalTreeStore, GOALSCAPE_SUFFIX } from "./goalTree";
import { GoalNode, NoteIndex, NoteInfo, findNode, flattenTree } from "./types";

/** Obsidian 文件名里不许出现的字符，加上会打断 [[链接]] 解析的 # ^ [ ] */
const BAD_CHARS = /[*"\\/<>:|?#^[\]]/g;
const NAME_MAX = 60;
/** vault 事件去抖：Obsidian 存一次盘会连发几个 modify */
const WATCH_DEBOUNCE_MS = 400;
/** 笔记 frontmatter 里记块 id 的键：文件被改名/挪走之后全靠它找回来 */
export const GS_ID_KEY = "gsId";

/** 文件名里不许出现、结尾也不许是点和空格（Windows 会吃掉） */
function safeName(title: string): string {
  const s = title
    .replace(BAD_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .replace(/[.\s]+$/, "");
  return s || "note";
}

function frontmatter(id: string): string {
  return `---\n${GS_ID_KEY}: ${id}\n---\n\n`;
}

export class NoteStore {
  private index: NoteIndex = new Map();
  private timer: number | null = null;
  private watching = false;
  /** 自己写文件时屏蔽 vault 事件，免得自己写的东西又触发一轮重读 */
  private writing = false;

  constructor(
    private plugin: Plugin,
    private store: GoalTreeStore
  ) {}

  private get app() {
    return this.plugin.app;
  }

  /** 当前索引（纯数据，视图与导出层直接读，同步的） */
  get notes(): NoteIndex {
    return this.index;
  }

  get(id: string): NoteInfo | undefined {
    return this.index.get(id);
  }

  /** 笔记目录跟图文件同级：<图名>.notes/。删图的时候它就在旁边，不会被忘掉 */
  folderFor(mapPath: string): string {
    const parts = mapPath.split("/");
    const base = (parts.pop() ?? "map").replace(new RegExp(`${escapeRe(GOALSCAPE_SUFFIX)}$`, "i"), "");
    const dir = parts.join("/");
    return `${dir ? `${dir}/` : ""}${base}.notes`;
  }

  /** 切图 / 启动后跑一次：先把旧版存在 JSON 里的正文搬进文件，再建索引 */
  async syncMap(): Promise<number> {
    const migrated = await this.migrate();
    await this.rebuild();
    return migrated;
  }

  /** 全量重建索引；顺带把"文件被改名或挪走"的新路径写回树 */
  async rebuild(): Promise<void> {
    const scape = this.store.scape;
    const next: NoteIndex = new Map();
    const moved: Array<{ id: string; path: string }> = [];
    if (scape) {
      for (const n of flattenTree(scape.mainGoal)) {
        if (!n.note) continue;
        let info = await this.readInfo(n.note);
        if (!info) {
          const found = this.findByGsId(n.id);
          // 文件真被删了就是没笔记，不追着重建 —— 用户在 Obsidian 里删掉一个笔记是有意的动作
          if (!found) continue;
          info = await this.readInfo(found);
          if (!info) continue;
          moved.push({ id: n.id, path: found });
        }
        next.set(n.id, info);
      }
    }
    this.index = next;
    if (moved.length) {
      this.store.mutate((s) => {
        for (const m of moved) {
          const found = findNode(s.mainGoal, m.id);
          if (found) found.node.note = m.path;
        }
      });
    }
  }

  /**
   * 给一个块建笔记文件，返回路径。**不改树** —— 建文件和记路径要一起落盘，
   * 由调用方走 store.mutate，免得出现"文件建了、JSON 没记住"的半成品状态。
   */
  async createFor(node: GoalNode): Promise<string> {
    const dir = this.folderFor(this.store.path);
    await this.ensureFolder(dir);
    const path = this.uniquePath(dir, safeName(node.title), this.takenPaths());
    await this.writeFile(path, frontmatter(node.id));
    return path;
  }

  /**
   * 旧版把 Markdown 正文存在 JSON 的 notes 字段里，一次性搬进 .md。
   * 顺序是"先把文件写成功、再改树"：中途炸了最多是这块还没搬，不会出现两头都没有。
   * 返回搬了几个（空正文只删字段、不建文件，不算）。
   */
  private async migrate(): Promise<number> {
    const scape = this.store.scape;
    if (!scape) return 0;
    const legacy = flattenTree(scape.mainGoal).filter((n) => typeof n.notes === "string");
    if (!legacy.length) return 0;

    const dir = this.folderFor(this.store.path);
    await this.ensureFolder(dir);
    const taken = this.takenPaths();
    const done: Array<{ id: string; path: string }> = [];
    let written = 0;
    for (const n of legacy) {
      const text = (n.notes ?? "").trim();
      if (!text) {
        done.push({ id: n.id, path: "" });
        continue;
      }
      const path = this.uniquePath(dir, safeName(n.title), taken);
      taken.add(path);
      await this.writeFile(path, `${frontmatter(n.id)}${text}\n`);
      done.push({ id: n.id, path });
      written++;
    }
    this.store.mutate((s) => {
      for (const d of done) {
        const found = findNode(s.mainGoal, d.id);
        if (!found) continue;
        delete found.node.notes;
        if (d.path) found.node.note = d.path;
      }
    });
    return written;
  }

  /** 笔记文件在 Obsidian 里被改 / 改名 / 删掉 → 去抖重建索引 → bump 让视图重画 */
  watch(): void {
    if (this.watching) return;
    this.watching = true;
    const vault = this.app.vault;
    this.plugin.registerEvent(vault.on("modify", (f) => f instanceof TFile && this.schedule(f)));
    this.plugin.registerEvent(vault.on("create", (f) => f instanceof TFile && this.schedule(f)));
    this.plugin.registerEvent(vault.on("delete", (f) => f instanceof TFile && this.schedule(f)));
    this.plugin.registerEvent(
      vault.on("rename", (f, oldPath) => f instanceof TFile && this.schedule(f, oldPath))
    );
    // 刚写出来的 .md，metadataCache 常常还没解析完 —— 那一刻读 links 是空的，
    // 扇区外缘的文件卡片就永远长不出来（实机跑十次能撞上一次）。
    // 所以这条不听 writing 的屏蔽：Obsidian 解析完再补一轮，索引自己会追上。
    this.plugin.registerEvent(
      this.app.metadataCache.on("changed", (f) => f instanceof TFile && this.schedule(f, undefined, true))
    );
  }

  private schedule(f: TFile, oldPath?: string, ignoreWriting = false): void {
    if (!ignoreWriting && this.writing) return;
    if (!this.cares(f, oldPath)) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.rebuild().then(() => this.store.bump());
    }, WATCH_DEBOUNCE_MS);
  }

  /** 只关心自己那些笔记：用户在别的笔记里打字不该让放射图重画一遍 */
  private cares(f: TFile, oldPath?: string): boolean {
    if (f.extension !== "md") return false;
    if (oldPath && this.indexHasPath(oldPath)) return true;
    if (this.indexHasPath(f.path)) return true;
    if (f.path.startsWith(`${this.folderFor(this.store.path)}/`)) return true;
    const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.[GS_ID_KEY];
    return typeof id === "string" && !!this.store.scape && !!findNode(this.store.scape.mainGoal, id);
  }

  private indexHasPath(path: string): boolean {
    for (const info of this.index.values()) if (info.path === path) return true;
    return false;
  }

  private takenPaths(): Set<string> {
    const scape = this.store.scape;
    const out = new Set<string>();
    if (scape) for (const n of flattenTree(scape.mainGoal)) if (n.note) out.add(n.note);
    return out;
  }

  /** 文件名撞车就加序号：两个块都叫 "Run" 也不能指到同一个文件上 */
  private uniquePath(dir: string, name: string, taken: Set<string>): string {
    for (let i = 1; ; i++) {
      const p = `${dir}/${i === 1 ? name : `${name} ${i}`}.md`;
      if (!taken.has(p) && !this.app.vault.getAbstractFileByPath(p)) return p;
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path || this.app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    // 启动早期索引没就绪时 getAbstractFileByPath 会误报 null，createFolder 抛"已存在"是正常路径
    try {
      await this.app.vault.createFolder(path);
    } catch {
      /* 已存在 */
    }
  }

  private async writeFile(path: string, text: string): Promise<void> {
    this.writing = true;
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.app.vault.modify(f, text);
      else await this.app.vault.create(path, text);
    } finally {
      // vault 事件是异步派发的，稍晚再解除标记
      window.setTimeout(() => (this.writing = false), 500);
    }
  }

  private async readInfo(path: string): Promise<NoteInfo | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile) || f.extension !== "md") return null;
    const raw = await this.app.vault.cachedRead(f).catch(() => null);
    if (raw === null) return null;
    const cache = this.app.metadataCache.getFileCache(f);
    return { path, text: stripFrontmatter(raw, cache), links: this.resolvedLinks(f, cache) };
  }

  /**
   * 正文里的 [[wikilink]] → 真实文件路径。走 metadataCache 而不是自己解析文本：
   * 解析得到才收，指不到的（幽灵链接）不进图 —— 点不动的卡片比没有卡片更糟。
   * cache.links 不含 ![[嵌入]]，正好符合"嵌入是内容不是关系"这条既有语义。
   */
  private resolvedLinks(file: TFile, cache: CachedMetadata | null): string[] {
    const out: string[] = [];
    for (const l of cache?.links ?? []) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(l.link, file.path);
      if (dest && dest.path !== file.path && !out.includes(dest.path)) out.push(dest.path);
    }
    return out;
  }

  /** 路径失效时按 frontmatter 里的 gsId 全库找一遍：在 Obsidian 里改名/挪走是常态 */
  private findByGsId(id: string): string | null {
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm && String(fm[GS_ID_KEY] ?? "") === id) return f.path;
    }
    return null;
  }
}

/** 剥掉开头的 frontmatter：不剥的话 `gsId: xxx` 会被当成笔记摘要的第一行 */
function stripFrontmatter(raw: string, cache: CachedMetadata | null): string {
  const pos = cache?.frontmatterPosition;
  if (pos && typeof pos.end?.offset === "number") {
    return raw.slice(pos.end.offset).replace(/^\r?\n/, "");
  }
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
