// 分层守卫：只查 import 边的形状，不查写法。
// 这四条是"数据层与几何层能脱开 Obsidian 界面单测"的前提（npm test 三秒跑完的那部分）。
// 一旦被反向依赖打断，测试就得开真实 Obsidian 才有结论 —— 那正是实机回归越来越肥的由来。
// 撞到规则时：真的需要框架就加进白名单并写清理由，否则把逻辑挪回内层。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// test/run-tests.mjs 以插件仓库根为 cwd 启动 node
const SRC = join(process.cwd(), "src");
if (!existsSync(SRC)) {
  throw new Error(`找不到 ${SRC}：分层测试必须经 npm test 运行（依赖 cwd 为仓库根）`);
}

/** 内层：领域数据 + 导出 + 放射图几何/配色。界面层 views/ 在外，内层不得回头依赖它 */
const INNER_DIRS = ["data/", "export/", "geometry/"];

/** 逐个点名的框架无关文件；geometry/ 整个目录都按同样要求 */
const PURE = ["data/types.ts", "data/rollup.ts", "data/crud.ts", "data/templates.ts", "data/palette.ts"];

/** 允许碰 obsidian 的位置：视图层、组合根，以及三个"替 vault 干活"的适配器 */
const FRAMEWORK_ALLOWED = [
  "main.ts",
  "settingsTab.ts",
  "data/goalTree.ts",
  "data/noteFiles.ts",
  // 白板镜像读写 .canvas 文件、摘 workspace 标签页，性质同 goalTree / noteFiles；
  // 纯内容映射（树 → JsonCanvas）留在 canvasSync.ts，那边仍然一行框架都不 import
  "export/canvasMirror.ts",
  "views/",
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(abs);
    return e.name.endsWith(".ts") ? [relative(SRC, abs).split(sep).join("/")] : [];
  });

/** 静态 import 与动态 import 的目标都算，type-only 也算（分层不看是否进运行时） */
const importsOf = (file: string): string[] => {
  const src = readFileSync(join(SRC, file), "utf8");
  return [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
};

const toViews = (spec: string) => /(^|\/)views\//.test(spec);
const toObsidian = (spec: string) => spec === "obsidian";
const toMain = (spec: string) => /(^|\/)main$/.test(spec);
const frameworkFree = (file: string) => file.startsWith("geometry/") || PURE.includes(file);

describe("依赖方向", () => {
  const files = sourceFiles(SRC);

  it("内层（data/export/geometry）不依赖界面层", () => {
    const offenders = files
      .filter((f) => INNER_DIRS.some((d) => f.startsWith(d)))
      .flatMap((f) => importsOf(f).filter(toViews).map((spec) => `${f} → ${spec}`));
    assert.deepEqual(offenders, [], "界面层被内层依赖，内层就再也无法脱开界面测试");
  });

  it("几何层与领域核心不 import obsidian", () => {
    const missing = PURE.filter((f) => !files.includes(f));
    assert.deepEqual(missing, [], "领域核心文件被改名或删除，请同步 PURE 清单");
    const offenders = files
      .filter(frameworkFree)
      .flatMap((f) => importsOf(f).filter(toObsidian).map((spec) => `${f} → ${spec}`));
    assert.deepEqual(offenders, [], "框架类型进入纯模块，单测就得 mock obsidian 才跑得起来");
  });

  it("import obsidian 的文件都在白名单内", () => {
    const offenders = files
      .filter((f) => !FRAMEWORK_ALLOWED.some((a) => f === a || f.startsWith(a)))
      .flatMap((f) => importsOf(f).filter(toObsidian).map((spec) => `${f} → ${spec}`));
    assert.deepEqual(offenders, [], "新增框架依赖点，请写清理由再加进 FRAMEWORK_ALLOWED");
  });

  it("视图层不直接依赖组合根", () => {
    const offenders = files
      .filter((f) => f.startsWith("views/"))
      .flatMap((f) => importsOf(f).filter(toMain).map((spec) => `${f} → ${spec}`));
    assert.deepEqual(
      offenders,
      [],
      "视图要的类型面在 views/host.ts 收窄，直接 import 组合根会让视图与 main 互相引用、谁都不能单独改"
    );
  });
});
