// 内存版 vault / DataAdapter，给 GoalTreeStore 单测用。
// 刻意对齐 Obsidian 的真实行为（而不是写得"更方便"），因为被测的几个回归点就发生在这上面：
// - createFolder 撞已存在目录会抛 "Folder already exists."
// - adapter.write 会派生一次 modify 事件
// - 启动早期 vault 索引未就绪时 getAbstractFileByPath 会误报 null（用 staleIndex 模拟）

import { Notice, TFile, TFolder } from "../mocks/obsidian";
import type { Plugin } from "obsidian";
import { GoalTreeStore, DEFAULT_GOALSCAPE_PATH } from "../../src/data/goalTree";

type Handler = (file: TFile) => void;

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

  private emit(name: string, file: TFile): void {
    (this.handlers.get(name) ?? []).slice().forEach((cb) => cb(file));
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
    app: { vault },
    registerEvent: (ref: unknown) => registeredEvents.push(ref),
  } as unknown as Plugin;
  return { vault, store: new GoalTreeStore(plugin, path), registeredEvents };
}

/** mutate() 里的 save() 是 fire-and-forget，断言落盘前先让微任务跑完 */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 外部修改的去抖窗口是 300ms */
export async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
