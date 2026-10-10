// 内存版 vault / DataAdapter / metadataCache，给 GoalTreeStore 与 NoteStore 单测用。
// 刻意对齐 Obsidian 的真实行为（而不是写得"更方便"），因为被测的几个回归点就发生在这上面：
// - createFolder 撞已存在目录会抛 "Folder already exists."
// - adapter.write 会派生一次 modify 事件
// - 启动早期 vault 索引未就绪时 getAbstractFileByPath 会误报 null（用 staleIndex 模拟）
// - metadataCache 只解析真会用到的那点：开头的 --- frontmatter（单层标量）与正文里的 [[wikilink]]；
//   ![[嵌入]] 不算链接、指不到的目标解析不出来 —— 这两条正是被测代码依赖的语义

import { Notice, TFile, TFolder } from "../mocks/obsidian";
import type { Plugin } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH } from "../../src/data/goalTree";

type Handler = (file: TFile, oldPath?: string) => void;

/** 插件弹的用户提示（Notice），断言"该报的错报了、该静默的静默" */
export function notices(): string[] {
  return Notice.messages;
}

export class FakeVault {
  readonly contents = new Map<string, string>();
  readonly files = new Map<string, TFile>();
  readonly folders = new Set<string>();
  /** 插件落盘过的内容，按顺序，用于断言"从未写过空内容" */
  readonly writeLog: string[] = [];
  /** 列在这里的路径 getAbstractFileByPath 查不到，但目录实际已存在 */
  readonly staleIndex = new Set<string>();
  private handlers = new Map<string, Handler[]>();

  adapter = {
    exists: async (path: string): Promise<boolean> => this.contents.has(path),
    read: async (path: string): Promise<string> => {
      const content = this.contents.get(path);
      if (content === undefined) throw new Error(`ENOENT: no such file, '${path}'`);
      return content;
    },
    write: async (path: string, data: string): Promise<void> => {
      this.contents.set(path, data);
      if (!this.files.has(path)) this.files.set(path, new TFile(path));
      this.writeLog.push(data);
      // 真实 vault 落盘后也会发 modify，事件处理必须自己防抖/自我屏蔽
      this.emit("modify", this.files.get(path)!);
    },
  };

  /** 预先放好一个文件（不算插件写的，不发事件） */
  seed(path: string, content: string): void {
    this.contents.set(path, content);
    this.files.set(path, new TFile(path));
  }

  /** 用户在 Obsidian 外部改了这个文件 */
  externalEdit(path: string, content: string): void {
    this.contents.set(path, content);
    this.emit("modify", this.files.get(path) ?? new TFile(path));
  }

  /** 用户删掉了文件 */
  remove(path: string): void {
    const file = this.files.get(path);
    this.contents.delete(path);
    this.files.delete(path);
    if (file) this.emit("delete", file);
  }

  on(name: string, cb: Handler): { cleanup: () => void } {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { cleanup: () => this.handlers.set(name, list.filter((c) => c !== cb)) };
  }

  private emit(name: string, file: TFile, oldPath?: string): void {
    (this.handlers.get(name) ?? []).slice().forEach((cb) => cb(file, oldPath));
  }

  /** 插件建文件（NoteStore 建笔记走这条） */
  async create(path: string, text: string): Promise<TFile> {
    if (this.files.has(path)) throw new Error("File already exists.");
    const f = new TFile(path);
    this.files.set(path, f);
    this.contents.set(path, text);
    this.emit("create", f);
    return f;
  }

  async modify(f: TFile, text: string): Promise<void> {
    if (!this.files.has(f.path)) throw new Error("ENOENT");
    this.contents.set(f.path, text);
    this.emit("modify", f);
  }

  async delete(f: TFile): Promise<void> {
    this.remove(f.path);
  }

  async rename(f: TFile, newPath: string): Promise<void> {
    const old = f.path;
    const text = this.contents.get(old) ?? "";
    this.contents.delete(old);
    this.files.delete(old);
    const moved = new TFile(newPath);
    this.files.set(newPath, moved);
    this.contents.set(newPath, text);
    this.emit("rename", moved, old);
  }

  /** 读的是缓存那份，和真实 vault 一样：文件不在就抛 */
  async cachedRead(f: TFile): Promise<string> {
    const c = this.contents.get(f.path);
    if (c === undefined) throw new Error(`ENOENT: no such file, '${f.path}'`);
    return c;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((f) => f.extension === "md");
  }

  metadataCache = {
    getFileCache: (f: TFile) => {
      const c = parseCache(this.contents.get(f.path) ?? "");
      // 真实 Obsidian 里"文件已落盘、缓存还没解析完"是常态：那一刻 links 是空的
      if (this.coldCache.has(f.path)) c.links = [];
      return c;
    },
    getFirstLinkpathDest: (link: string) => this.resolveLink(link),
    on: (name: string, cb: Handler) => {
      const list = this.cacheHandlers.get(name) ?? [];
      list.push(cb);
      this.cacheHandlers.set(name, list);
      return { cleanup: () => this.cacheHandlers.set(name, list.filter((c) => c !== cb)) };
    },
  };

  /** 模拟冷缓存：列在这里的路径 getFileCache 只给 frontmatter、不给 links */
  readonly coldCache = new Set<string>();
  private cacheHandlers = new Map<string, Handler[]>();

  /** Obsidian 解析完一个文件后发的 metadataCache:changed */
  emitCacheChanged(path: string): void {
    const f = this.files.get(path);
    if (!f) return;
    (this.cacheHandlers.get("changed") ?? []).slice().forEach((cb) => cb(f));
  }

  /** 按整路径（带不带 .md 都认）或 basename 解析；解析不到就是幽灵链接，返回 null */
  private resolveLink(link: string): TFile | null {
    for (const f of this.files.values()) {
      if (f.path === link || f.path === `${link}.md`) return f;
    }
    for (const f of this.files.values()) if (f.basename === link) return f;
    return null;
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.staleIndex.has(path)) return null;
    return this.files.get(path) ?? (this.folders.has(path) ? new TFolder(path) : null);
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.folders.has(path)) throw new Error("Folder already exists.");
    this.folders.add(path);
    return new TFolder(path);
  }
}

export interface FakeEnvironment {
  vault: FakeVault;
  store: GoalTreeStore;
  /** 造 NoteStore 之类的下游部件时要用（它只认 plugin.app / plugin.registerEvent） */
  plugin: Plugin;
  /** 注册进 plugin.registerEvent 的引用条数，用于断言外部监听只注册一次 */
  registeredEvents: unknown[];
}

export function createEnvironment(
  seed: Record<string, string> = {},
  path = DEFAULT_GOALSCAPE_PATH
): FakeEnvironment {
  Notice.reset();
  const vault = new FakeVault();
  Object.entries(seed).forEach(([p, content]) => vault.seed(p, content));
  const registeredEvents: unknown[] = [];
  const plugin = {
    app: { vault, metadataCache: vault.metadataCache },
    registerEvent: (ref: unknown) => registeredEvents.push(ref),
  } as unknown as Plugin;
  return {
    vault,
    store: new GoalTreeStore(plugin, path),
    plugin,
    registeredEvents,
  };
}

/** mutate() 里的 save() 是 fire-and-forget，断言落盘前先让微任务跑完 */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 外部修改的去抖窗口是 300ms */
export async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeCache {
  frontmatter?: Record<string, string>;
  frontmatterPosition?: { end: { offset: number } };
  links: Array<{ link: string }>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;
// 真实 metadataCache 的 link 字段带子路径（`笔记#小节` / `笔记#^块`），别名被剥进 displayText：
// 锚点是"跳到对方笔记的某一节"的唯一载体，仿制时不能丢
const WIKILINK_RE = /(?<!!)\[\[([^\]|#]+)((?:#[^\]|]*)?)(?:\|[^\]]*)?\]\]/g;

function parseCache(raw: string): FakeCache {
  const out: FakeCache = { links: [] };
  let body = raw;
  const fm = FRONTMATTER_RE.exec(raw);
  if (fm) {
    out.frontmatter = {};
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) out.frontmatter[kv[1]] = kv[2].trim();
    }
    out.frontmatterPosition = { end: { offset: fm[0].length } };
    body = raw.slice(fm[0].length);
  }
  for (const m of body.matchAll(WIKILINK_RE)) {
    const t = m[1].trim();
    const link = `${t}${m[2]}`;
    if (t && !out.links.some((x) => x.link === link)) out.links.push({ link });
  }
  return out;
}
