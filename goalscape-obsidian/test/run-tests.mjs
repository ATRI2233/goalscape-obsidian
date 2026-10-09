// 纯逻辑单测入口：用仓库里已有的 esbuild 把 src/*\/__tests__/*.test.ts 打包成
// Node 能直接跑的 ESM，再交给内置的 node:test 执行。不引入第三方测试框架。
//
//   npm test            全部
//   npm test crud       只跑文件名含 crud 的
//
// 收的是"不需要真实界面就能算"的东西：数据层 + 放射图的几何/配色（radialGeometry 只依赖
// types，纯函数）。能在 3 秒里跑完的判据就别搬到 26 秒的实机回归里去。
// 产物落在 node_modules/.goalscape-tests/（已被 .gitignore 覆盖），带 inline sourcemap，
// 失败栈能直接指回 .ts 源码行。

import { existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDirs = ["data", "views", "export"].map((d) => join(root, "src", d, "__tests__"));
const outDir = join(root, "node_modules", ".goalscape-tests");

const all = testDirs
  .filter(existsSync)
  .flatMap((dir) =>
    readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => join(dir, f))
  )
  .sort();
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = filter.length ? all.filter((f) => filter.some((k) => basename(f).includes(k))) : all;

if (!files.length) {
  console.error(
    `没有匹配的测试文件（${all.length} 个：${all.map(basename).join(", ")}）`
  );
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: files,
  outdir: outDir,
  // esbuild 把"各入口相对 outbase 的路径"原样搬进 outdir，所以产物在
  // outDir/src/export/__tests__/x.mjs 而不是 outDir/x.mjs。（这里曾按文件名扁平拼路径，
  // 于是 node --test 跑的是一份永远不会被覆盖的旧产物：新写的断言根本没被执行。）
  outbase: root,
  outExtension: { ".js": ".mjs" },
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  logLevel: "warning",
  // obsidian 只有类型没有运行时实现，换成 test/mocks/obsidian.ts
  alias: { obsidian: join(root, "test", "mocks", "obsidian.ts") },
});

const outs = files.map((f) => join(outDir, relative(root, f).replace(/\.ts$/, ".mjs")));
for (const o of outs) {
  if (!existsSync(o)) {
    console.error(`打包产物缺失：${o}`);
    process.exit(1);
  }
}
const result = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=spec", ...outs],
  { stdio: "inherit", cwd: root }
);
process.exit(result.status ?? 1);
