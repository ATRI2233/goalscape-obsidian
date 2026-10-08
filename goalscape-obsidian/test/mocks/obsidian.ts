// obsidian 包只发布 .d.ts，没有运行时实现，Node 里 import "obsidian" 会直接失败。
// run-tests.mjs 用 esbuild 的 alias 把 "obsidian" 指到这里，只实现数据层用到的导出。

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };

  constructor(path = "") {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder {
  children: unknown[] = [];
  constructor(public path = "") {}
  isRoot(): boolean {
    return this.path === "";
  }
}

export class Notice {
  static messages: string[] = [];
  static reset(): void {
    Notice.messages = [];
  }
  constructor(message: string) {
    Notice.messages.push(message);
  }
  hide(): void {}
}

// goalTree.ts 调 window.setTimeout/ClearTimeout。放在这里而不是测试文件里：
// 本模块是被测代码的直接依赖，模块体一定早于任何 store 调用执行。
const g = globalThis as unknown as {
  window?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
};
if (!g.window) g.window = { setTimeout, clearTimeout };
